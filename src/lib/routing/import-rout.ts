/**
 * Import support for incoming Excellon-2-style rout files (PentaLogix
 * ViewMaster / Allegro `.rou` exports — the same dialect this repo's own
 * `emit-excellon.ts` writes for outgoing routing plans, confirmed against a
 * real customer file pair).
 *
 * These are NOT Excellon drill data even though `isExcellonDrillFile` can
 * mistake them for it (real body content: `G90`/`M30`/bare tool selects) —
 * they are plain G-code: `T01` selects a tool, `G00X..Y..` rapids to a start
 * point, `G41`/`M15` begin a cut, a run of `G01X..Y..` traces the cut path,
 * and `M16` retracts. Feeding this text to `parseExcellonDrill` (which reads
 * any line containing "X" and "Y" as a hole position) turns every G01 cut
 * move into a spurious "drill hit" at the corner of the milled shape, with
 * no diameter — the bug this module fixes.
 *
 * A milling slot is the shape a router bit sweeps out along its path. This
 * repo's own routing engine already knows that convention (`geometry.ts`'s
 * `offsetRectOutward` etc.), but recovering it here would need the cutter
 * diameter — which this incoming file never declares (bare `T01`, no
 * `T01C<dia>`). Rather than guess a diameter, this module renders the path
 * verbatim as a closed polygon: confirmed against a real board's own
 * `SLOT HOLE REPORT.XLS` (exact `SLOT_SIZE_MAJOR/MINOR`/`SLOT_X/Y`), the raw
 * G01 coordinates already trace the finished slot boundary with no cutter
 * offset needed — so the honest, correct rendering doesn't require the
 * diameter at all.
 */

import type { GerberBounds } from '../gerber-parser'

/**
 * Detect the dialect: plunge/retract markers (M15/M16) and cutter
 * compensation (G41/G40) alongside a BARE tool select (`T01` with no `C<dia>`
 * — the real discriminator against genuine Excellon, whose tool selects are
 * always paired with a diameter declaration somewhere in the header).
 */
export function isRoutGcodeFile(content: string): boolean {
  const upper = content.toUpperCase()
  const hasPlungeRetract = /\bM15\b/.test(upper) && /\bM16\b/.test(upper)
  const hasCutterComp = /\bG41\b/.test(upper) || /\bG40\b/.test(upper)
  const hasBareToolSelect = /^\s*T\d{1,2}\s*$/m.test(content)
  const hasRealToolDiameter = /^\s*T\d{1,2}(?:[FSBH][\d.]+)*C[\d.]+/mi.test(content)
  return hasPlungeRetract && hasCutterComp && hasBareToolSelect && !hasRealToolDiameter
}

export interface RoutPolygon {
  toolCode: number
  points: { x: number; y: number }[]
}

export interface ParsedRoutFile {
  polygons: RoutPolygon[]
  bounds: GerberBounds | null
}

/**
 * Fixed-width coordinate decode for this dialect: like the companion drill
 * file's own "Holesize" header (see `gerber-parser.ts`'s
 * `formatGuessedFromContent` heuristic), these `.rou` files declare no
 * coordinate format anywhere. Confirmed on a real file: coordinates are
 * always 8 fixed digits with no suppression, decoding correctly as 3
 * integer + 5 decimal digits, millimetres. Widths this parser hasn't seen a
 * real example of are rejected rather than guessed at.
 */
function decodeRoutCoord(raw: string): number | null {
  const negative = raw.startsWith('-')
  const digits = raw.replace(/^[+-]/, '')
  if (digits.length !== 8 || !/^\d+$/.test(digits)) return null
  const value = parseFloat(`${digits.slice(0, 3)}.${digits.slice(3)}`)
  return negative ? -value : value
}

const COORD_RE = /X([+-]?\d+)Y([+-]?\d+)/i

/**
 * Parse the rout G-code into one closed polygon per plunge/retract
 * (`M15`...`M16`) block. `G00` supplies the rapid-to start point; `G01`
 * lines supply every subsequent point of the same cut.
 */
export function parseRoutSlots(content: string): ParsedRoutFile {
  const lines = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')

  const polygons: RoutPolygon[] = []
  let currentTool: number | null = null
  let current: RoutPolygon | null = null
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity

  const pushPoint = (x: number, y: number) => {
    if (!current) return
    current.points.push({ x, y })
    minX = Math.min(minX, x); maxX = Math.max(maxX, x)
    minY = Math.min(minY, y); maxY = Math.max(maxY, y)
  }

  for (const rawLine of lines) {
    const clean = rawLine.trim().replace(/\*$/, '')
    if (!clean) continue
    const upper = clean.toUpperCase()

    const toolMatch = /^T(\d{1,2})$/i.exec(clean)
    if (toolMatch) { currentTool = parseInt(toolMatch[1], 10); continue }

    if (upper === 'M15') continue // plunge — the shape already started at the preceding G00
    if (upper === 'M16') { // retract — close off the shape in progress, if any
      if (current && current.points.length > 1) polygons.push(current)
      current = null
      continue
    }

    const coordMatch = COORD_RE.exec(clean)
    if (!coordMatch) continue // G90/F1/G41/G40/M30 etc. carry no coordinate

    const x = decodeRoutCoord(coordMatch[1])
    const y = decodeRoutCoord(coordMatch[2])
    if (x === null || y === null) continue

    if (upper.startsWith('G00')) {
      // Rapid move — starts a new shape (the previous one, if any, should
      // already have been closed by an M16; this guards against a malformed
      // file that's missing one).
      current = { toolCode: currentTool ?? 1, points: [{ x, y }] }
      minX = Math.min(minX, x); maxX = Math.max(maxX, x)
      minY = Math.min(minY, y); maxY = Math.max(maxY, y)
    } else if (upper.startsWith('G01')) {
      pushPoint(x, y)
    }
  }

  const bounds: GerberBounds | null = polygons.length > 0
    ? { minX, minY, maxX, maxY }
    : null

  return { polygons, bounds }
}

/**
 * Render the parsed slot polygons as a standard RS-274X Gerber file — one
 * filled region (`G36`...`G37`) per polygon, dark polarity, explicit-decimal
 * coordinates (sidesteps this dialect's own format ambiguity entirely once
 * the values are already decoded numbers). A single hairline aperture is
 * selected for spec-compliance; region fills don't use its shape or size.
 */
export function routSlotsToGerber(polygons: RoutPolygon[]): string {
  const lines: string[] = []
  lines.push('%FSLAX34Y34*%')
  lines.push('%MOMM*%')
  lines.push('%ADD10C,0.01*%')
  lines.push('%LPD*%')
  lines.push('D10*')

  for (const poly of polygons) {
    if (poly.points.length < 2) continue
    lines.push('G36*')
    const [first, ...rest] = poly.points
    lines.push(`G01X${first.x.toFixed(4)}Y${first.y.toFixed(4)}D02*`)
    for (const p of rest) lines.push(`X${p.x.toFixed(4)}Y${p.y.toFixed(4)}D01*`)
    // Regions auto-close, but an explicit return to the start point matches
    // what every one of these real files already does and costs nothing.
    if (first.x !== rest[rest.length - 1]?.x || first.y !== rest[rest.length - 1]?.y) {
      lines.push(`X${first.x.toFixed(4)}Y${first.y.toFixed(4)}D01*`)
    }
    lines.push('G37*')
  }

  lines.push('M02*')
  return lines.join('\n')
}
