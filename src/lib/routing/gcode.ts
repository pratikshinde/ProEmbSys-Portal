/**
 * G-code emitter for a LinuxCNC-based router/drill (confirmed against real
 * production files: `Siltech_SBTH_Routing_17-JUL-2026_*.NC`, one routing/
 * cutting file and six drilling files at different tool diameters).
 *
 * This machine is neither a CAM350-style Excellon post (no `M15`/`M16`
 * plunge/retract codes) nor a step-and-repeat mill program — it is plain
 * RS274NGC with explicit Z moves, LinuxCNC named parameters (`#<name>`), and
 * a "pressure pad" hold-down I/O (`M64`/`M65 P0`). Coordinates are always
 * explicit-decimal (no zero suppression at all), which sidesteps the entire
 * LZ/TZ inversion class of bug this codebase otherwise has to guard against
 * for Excellon output.
 *
 * There is only ONE real dialect to support, so this file is deliberately
 * concrete rather than a pluggable multi-dialect abstraction — building that
 * generality now would be speculative for a shop we've never seen a second
 * machine from. If a second dialect is ever needed, extract the shared parts
 * (sequencing, file-per-tool splitting) then, once there is a second real
 * example to generalise from.
 *
 * Two templates, deliberately NOT unified: the sample files' own two post-
 * processor paths (cutting vs drilling) disagree on where `G21` sits, whether
 * `G04`/dwell is repeated, and even on trailing whitespace — those are kept
 * byte-faithful per kind rather than forced into one shared template.
 */

import type { Pt, RoutingResult } from './types'
import { collectMouseBiteHoles } from './types'

export interface GcodeContext {
  /** Safety height for rapid travel between operations, mm. */
  safeZmm: number
  /** Height the tool retracts to between cuts/holes, mm. */
  retractZmm: number
  /** Cut/drill depth, mm — negative, below the work surface. Depends on board
   *  + backer thickness, which this tool doesn't track; defaults to the real
   *  sample's value as a starting point, not a computed "correct" answer. */
  cutDepthMm: number
  spindleRpm: number
  /** Dwell after the spindle start command, seconds (`G04 P<n>`). */
  dwellSeconds: number
  /** Path-blending tolerance, mm (`G64 P<n>`). */
  pathToleranceMm: number
  /** Whether to emit the M64/M65 P0 hold-down pad commands. */
  pressurePad: boolean
  /** Work coordinate system selector, e.g. 'G54'. */
  workOffset: string
  /** Feed rate for the Z plunge on a routing pass, mm/min. */
  routeZFeedMmPerMin: number
  /** Feed rate for XY cutting moves on a routing pass, mm/min. */
  routeXYFeedMmPerMin: number
  /**
   * Feed rate for drill plunges, mm/min. Only used directly when
   * `autoFeedByDiameter` is false — otherwise it's the fallback for a
   * diameter outside `DRILL_FEED_TABLE_MM_PER_MIN`'s range (clamped to the
   * table's own nearest endpoint instead, so this field only matters if the
   * table itself is ever cleared).
   */
  drillFeedMmPerMin: number
  /**
   * true (default): look up each tool's feed rate from
   * `DRILL_FEED_TABLE_MM_PER_MIN` (interpolated for diameters between real
   * data points) instead of using `drillFeedMmPerMin` uniformly. This
   * reverses an earlier, more conservative default — see that table's own
   * doc comment for why a flat rate across every diameter was the original
   * choice, and what changed.
   */
  autoFeedByDiameter: boolean
}

/**
 * Real (diameter mm, feed mm/min) pairs read directly from the shop's own
 * `Siltech_SBTH_Routing_17-JUL-2026_Drilling_*.NC` files — the same seven
 * production files `generateDrillGcode`'s own dialect was confirmed against.
 * Monotonically decreasing: smaller bits get a higher feed, larger bits a
 * lower one. NOT a fitted formula — a real per-diameter step-down was
 * visible once a seventh data point (2.15mm) joined the original six, but
 * the shape between points still isn't a clean curve (e.g. 0.95mm and
 * 1.00mm share the same 1600 mm/min), so `resolveDrillFeedMmPerMin`
 * interpolates piecewise-LINEARLY between these exact real points rather
 * than fitting or inventing a curve through them — an honest encoding of
 * the vendor's own measurements, not a fabricated "smart" formula.
 */
export const DRILL_FEED_TABLE_MM_PER_MIN: { diameterMm: number; feedMmPerMin: number }[] = [
  { diameterMm: 0.40, feedMmPerMin: 2000 },
  { diameterMm: 0.80, feedMmPerMin: 1800 },
  { diameterMm: 0.95, feedMmPerMin: 1600 },
  { diameterMm: 1.00, feedMmPerMin: 1600 },
  { diameterMm: 1.10, feedMmPerMin: 1500 },
  { diameterMm: 2.15, feedMmPerMin: 1000 },
  { diameterMm: 4.30, feedMmPerMin: 500 },
]

/**
 * Feed rate for one tool diameter, piecewise-linearly interpolated from
 * `DRILL_FEED_TABLE_MM_PER_MIN`. Diameters outside the table's range clamp
 * to the nearest endpoint's feed rather than extrapolating — a bit smaller
 * than 0.40mm or larger than 4.30mm has no real data point to extrapolate
 * from, and guessing beyond the measured range is exactly the "fabricated
 * smart default" this table exists to avoid.
 */
export function resolveDrillFeedMmPerMin(
  diameterMm: number,
  table: { diameterMm: number; feedMmPerMin: number }[] = DRILL_FEED_TABLE_MM_PER_MIN
): number {
  if (table.length === 0) return 0
  const sorted = [...table].sort((a, b) => a.diameterMm - b.diameterMm)
  if (diameterMm <= sorted[0].diameterMm) return sorted[0].feedMmPerMin
  if (diameterMm >= sorted[sorted.length - 1].diameterMm) return sorted[sorted.length - 1].feedMmPerMin
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i]
    const b = sorted[i + 1]
    if (diameterMm >= a.diameterMm && diameterMm <= b.diameterMm) {
      const span = b.diameterMm - a.diameterMm
      const t = span > 0 ? (diameterMm - a.diameterMm) / span : 0
      return a.feedMmPerMin + t * (b.feedMmPerMin - a.feedMmPerMin)
    }
  }
  return sorted[sorted.length - 1].feedMmPerMin
}

/** Values taken directly from the real sample files where they overlap with
 *  what this tool can determine (retract, tolerance, spindle, dwell, pressure
 *  pad); routing feed matches the real 2.0mm-bit cutting file exactly. */
export const DEFAULT_GCODE_CONTEXT: GcodeContext = {
  safeZmm: 20.0,
  retractZmm: 5.0,
  cutDepthMm: -2.0,
  spindleRpm: 40000,
  dwellSeconds: 3,
  pathToleranceMm: 0.01,
  pressurePad: true,
  workOffset: 'G54',
  routeZFeedMmPerMin: 400,
  routeXYFeedMmPerMin: 600,
  drillFeedMmPerMin: 1200,
  autoFeedByDiameter: true,
}

function fmtCoord(v: number): string {
  return v.toFixed(4)
}

function xy(p: Pt): string {
  return `X${fmtCoord(p.x)}Y${fmtCoord(p.y)}`
}

/** `4.3000` → `4-30`, matching the shop's own `Drilling_4-30_1.NC` naming
 *  (decimal point replaced with a dash, two decimal places). */
export function formatToolFileSuffix(diameterMm: number): string {
  return diameterMm.toFixed(2).replace('.', '-')
}

/**
 * G-code for every routed pass at one tool diameter.
 *
 * Sequencing reuses `RoutingResult.paths` exactly as planned — each `RoutePath`
 * already ends exactly where the real machine would retract (at a tab or a
 * dedup boundary) and runs continuously through everywhere it wouldn't (plain
 * corners), so no tab-specific logic is needed here at all: a path boundary
 * IS a lift, a point-to-point move WITHIN a path is a continuous cut. This
 * was confirmed against `Cutting1_2.NC`'s own corner-vs-tab pattern.
 */
export function generateRouteGcode(
  result: RoutingResult,
  toolDiameterMm: number,
  ctx: GcodeContext
): string {
  const paths = result.paths.filter(p => Math.abs(p.toolDiameterMm - toolDiameterMm) < 1e-6)

  const lines: string[] = []
  lines.push(`(TOOLDIA ${toolDiameterMm.toFixed(4)})`)
  lines.push('(GERBER FILE)')
  lines.push('(HEADER_BEGIN)')
  lines.push('')
  lines.push('G90 (Absolute)')
  lines.push(`G64 P${ctx.pathToleranceMm}`)
  lines.push(`${ctx.workOffset} (Work Co ordinate system)`)
  lines.push(`M3 S${ctx.spindleRpm} (Spindle On)`)
  lines.push(`G04 P${ctx.dwellSeconds}`)
  if (ctx.pressurePad) lines.push('M64 P0 (PRESSURE PAD DOWN)')
  lines.push('(HEADER_END)')
  lines.push('(=======================================)')
  lines.push(`#<Z_Retract> = ${ctx.retractZmm.toFixed(4)}`)
  lines.push(`#<Z_Depth> = ${ctx.cutDepthMm.toFixed(4)}`)
  lines.push(`#<Z_Feed> = ${Math.round(ctx.routeZFeedMmPerMin)}`)
  lines.push(`#<XY_Feed> = ${Math.round(ctx.routeXYFeedMmPerMin)}`)
  lines.push('(=======================================)')
  lines.push('G21')
  lines.push(`M3 S${ctx.spindleRpm}`)
  lines.push(`G00 Z${ctx.safeZmm.toFixed(3)}`)
  lines.push('G00 X0Y0')
  lines.push('G00 Z#<Z_Retract>')

  for (const path of paths) {
    if (path.points.length < 2) continue
    const [first, second, ...tail] = path.points
    lines.push(`G00 ${xy(first)}`)
    lines.push('G01 Z#<Z_Depth>F#<Z_Feed>')
    lines.push(`G01 ${xy(second)}F#<XY_Feed>`)
    for (const pt of tail) lines.push(xy(pt))
    lines.push('G00 Z#<Z_Retract>')
  }

  lines.push(`G00 Z${ctx.safeZmm.toFixed(2)}`)
  lines.push('(FOOTER_BEGIN)')
  if (ctx.pressurePad) lines.push('M65 P0 (PRESSURE PAD UP)')
  lines.push(`G00 Z${ctx.safeZmm.toFixed(2)}`)
  lines.push('(Move Spindle Initial position first)')
  lines.push('M5 (Spindle Off)')
  lines.push('G28 (If required move machine to parking position)')
  lines.push('M30( End of program)')
  lines.push('(FOOTER_END)')

  return lines.join('\n')
}

/**
 * G-code for one tool's worth of holes (one file per diameter, matching the
 * shop's own workflow — LinuxCNC's manual tool change means separate programs
 * per bit rather than mid-file T-code changes).
 *
 * Per-hole pattern matches the real drilling files exactly, including the
 * trailing space after the retract/plunge lines and the space before the F
 * code — a different convention from the cutting template above, and kept
 * that way deliberately (see the file header comment).
 */
export function generateDrillGcode(
  holes: Pt[],
  toolDiameterMm: number,
  ctx: GcodeContext
): string {
  const lines: string[] = []
  lines.push(`(TOOLDIA ${toolDiameterMm.toFixed(4)})`)
  lines.push('(EXCELLON DRILLING FILE)')
  lines.push('(HEADER_BEGIN)')
  lines.push('')
  lines.push('G90 (Absolute)')
  lines.push(`G64 P${ctx.pathToleranceMm}`)
  lines.push(`${ctx.workOffset} (Work Co ordinate system)`)
  lines.push(`M3 S${ctx.spindleRpm} (Spindle On)`)
  lines.push(`G04 P${ctx.dwellSeconds}`)
  if (ctx.pressurePad) lines.push('M64 P0 (PRESSURE PAD DOWN)')
  lines.push('(HEADER_END)')
  lines.push('G21')
  lines.push('(=================================)')
  const feedMmPerMin = ctx.autoFeedByDiameter ? resolveDrillFeedMmPerMin(toolDiameterMm) : ctx.drillFeedMmPerMin
  lines.push(`#<Z_Retract> = ${ctx.retractZmm.toFixed(4)}`)
  lines.push(`#<Z_Depth> = ${ctx.cutDepthMm.toFixed(4)}`)
  lines.push(`#<Z_Feed> = ${Math.round(feedMmPerMin)}`)
  lines.push('(=================================)')
  lines.push(`M3 S${ctx.spindleRpm}`)
  lines.push(`G04P${ctx.dwellSeconds}`)
  lines.push(`G00 Z${ctx.safeZmm.toFixed(3)}`)

  for (const h of holes) {
    lines.push(`G00 ${xy(h)}`)
    lines.push('G00 Z#<Z_Retract> ')
    lines.push('G01 Z#<Z_Depth> F#<Z_Feed> ')
    lines.push('G00 Z#<Z_Retract> ')
  }

  lines.push('(FOOTER_BEGIN)')
  if (ctx.pressurePad) lines.push('M65 P0 (PRESSURE PAD UP)')
  lines.push(`G00 Z${ctx.safeZmm.toFixed(2)}`)
  lines.push('(Move Spindle Initial position first)')
  lines.push('M5 (Spindle Off)')
  lines.push('G28 (If required move machine to parking position)')
  lines.push('M30( End of program)')
  lines.push('(FOOTER_END)')

  return lines.join('\n')
}

export interface GcodeFile {
  filename: string
  content: string
}

/**
 * The full set of G-code files for a routing plan: one cutting program per
 * router-bit diameter, and one drilling program per distinct hole diameter
 * across both mouse bites and the customer's own imported drill hits.
 *
 * `drillHoleGroups` is deliberately the caller's responsibility to collect
 * (via `collectPanelizedDrillHoles` in `gerber-exporter.ts`) rather than read
 * from the store here — this file stays pure, matching every other emitter.
 */
export function generateGcodeFiles(
  result: RoutingResult,
  drillHoleGroups: { diameterMm: number; holes: Pt[] }[],
  partNumber: string,
  ctx: GcodeContext
): GcodeFile[] {
  const files: GcodeFile[] = []

  const routerDiameters = [...new Set(result.paths.map(p => p.toolDiameterMm))].sort((a, b) => a - b)
  for (const dia of routerDiameters) {
    files.push({
      filename: `${partNumber}_Cutting_${formatToolFileSuffix(dia)}.NC`,
      content: generateRouteGcode(result, dia, ctx),
    })
  }

  // Mouse bites and real board holes that share a diameter go in one file.
  const combined = new Map<number, Pt[]>()
  for (const bite of collectMouseBiteHoles(result)) {
    if (!combined.has(bite.diameter)) combined.set(bite.diameter, [])
    combined.get(bite.diameter)!.push({ x: bite.x, y: bite.y })
  }
  for (const group of drillHoleGroups) {
    if (!combined.has(group.diameterMm)) combined.set(group.diameterMm, [])
    combined.get(group.diameterMm)!.push(...group.holes)
  }

  let idx = 1
  for (const [dia, holes] of [...combined.entries()].sort(([a], [b]) => a - b)) {
    files.push({
      filename: `${partNumber}_Drilling_${formatToolFileSuffix(dia)}_${idx}.NC`,
      content: generateDrillGcode(holes, dia, ctx),
    })
    idx++
  }

  return files
}
