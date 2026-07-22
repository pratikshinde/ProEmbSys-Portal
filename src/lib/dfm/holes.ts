/**
 * Tier-B DFM measurements — everything that needs relationships between drill
 * hits and copper pads, but no polygon geometry.
 *
 * The enabling fact is the same one "Align Drill to Board Center" relies on:
 * a plated hole is concentric with its pad. So pairing a hole to its pad is a
 * nearest-centre lookup once both files share an origin, and the annular ring
 * falls out as (pad radius − hole radius).
 *
 * All values returned are mm. Inputs are normalised via measure.ts's `toMm`,
 * never read raw — layer units are not guaranteed mm (see measure.ts).
 */

import type { GerberAperture, GerberLayer } from "@/lib/gerber-parser"
import { recoverDrillOffset, resolvedFlashCenters, resolvedFlashes, type Point } from "@/lib/drill-alignment"
import type { DfmLayerInput } from "./types"
import { toMm } from "./measure"

/** How close a hole centre must be to a pad centre to count as that pad's
 *  hole. Matches drill-alignment's MATCH_TOL_MM — the pairing is near-exact by
 *  construction, so this only absorbs coordinate rounding between the two
 *  files. */
const CONCENTRIC_TOL_MM = 0.075

export interface PadRecord {
  center: Point
  /** Smallest radius of the pad, mm — the annular ring is thinnest here.
   *  Null for macro apertures, whose true extent we decline to guess. */
  minRadiusMm: number | null
  layerName: string
  side: string
}

export interface HoleRecord {
  center: Point
  radiusMm: number
  layerName: string
  /**
   * Whether this hole is plated. `false` for NPTH, `null` when the file
   * carries no plating attributes and we genuinely can't tell.
   *
   * This distinction is not cosmetic: a non-plated hole (a mounting hole, say)
   * has **no copper pad by design**, so treating it like a plated hole makes
   * the "unlanded hole" check fire on almost every real board.
   */
  plated: boolean | null
}

interface DrillPlating {
  /** Tool codes explicitly marked non-plated by a TA.AperFunction comment. */
  nonPlatedTools: Set<number>
  /** Tool codes explicitly marked plated. */
  platedTools: Set<number>
  /** Whole-file declaration from TF.FileFunction, when unambiguous. */
  fileLevel: "plated" | "nonplated" | null
}

/**
 * Recover per-hole plating from the Excellon attributes KiCad and friends emit
 * as `; #@!` comments:
 *   - `TF.FileFunction,Plated,…` / `,NonPlated,…`  — whole file
 *   - `TF.FileFunction,MixedPlating,…`            — decided per tool
 *   - `TA.AperFunction,NonPlated,NPTH,…`          — applies to the *next* tool
 * Files with none of these yield `null` plating, and callers must then decline
 * to judge rather than assume plated.
 */
function extractDrillPlating(rawContent: string): DrillPlating {
  const nonPlatedTools = new Set<number>()
  const platedTools = new Set<number>()
  let fileLevel: DrillPlating["fileLevel"] = null

  const fileFn = /TF\.FileFunction,\s*(Plated|NonPlated|MixedPlating)/i.exec(rawContent)
  if (fileFn) {
    const kind = fileFn[1].toLowerCase()
    if (kind === "plated") fileLevel = "plated"
    else if (kind === "nonplated") fileLevel = "nonplated"
    // MixedPlating intentionally leaves fileLevel null — per-tool decides.
  }

  // An AperFunction comment applies to the tool definition that follows it.
  let pending: "plated" | "nonplated" | null = null
  for (const rawLine of rawContent.split(/\r?\n/)) {
    const line = rawLine.trim()
    const aper = /TA\.AperFunction,\s*(NonPlated|Plated)\b/i.exec(line)
    if (aper) {
      pending = aper[1].toLowerCase() === "nonplated" ? "nonplated" : "plated"
      continue
    }
    const tool = /^T(\d+)/i.exec(line)
    if (tool) {
      const code = parseInt(tool[1], 10)
      if (pending === "nonplated") nonPlatedTools.add(code)
      else if (pending === "plated") platedTools.add(code)
      pending = null
    }
  }

  return { nonPlatedTools, platedTools, fileLevel }
}

function holePlating(plating: DrillPlating, toolCode: number | null): boolean | null {
  if (toolCode !== null) {
    if (plating.nonPlatedTools.has(toolCode)) return false
    if (plating.platedTools.has(toolCode)) return true
  }
  if (plating.fileLevel === "nonplated") return false
  if (plating.fileLevel === "plated") return true
  return null
}

/** Smallest radius of a pad aperture, mm. Circles use the diameter; rect and
 *  obround use the smaller side (the ring is tightest across the narrow axis).
 *  Macro apertures return null — evaluating their primitives to find a true
 *  extent is Phase 3 work, and guessing would produce confident false errors. */
function padMinRadiusMm(ap: GerberAperture | undefined, units: GerberLayer["units"]): number | null {
  if (!ap) return null
  if (ap.shape === "macro" || ap.shape === "polygon") return null
  const dims: number[] = []
  if (ap.width !== undefined && ap.width > 0) dims.push(ap.width)
  if (ap.shape !== "circle" && ap.height !== undefined && ap.height > 0) dims.push(ap.height)
  if (dims.length === 0) return null
  return toMm(Math.min(...dims), units) / 2
}

/** Every flash on the given copper layers, as pad records in mm. */
export function collectPads(copperLayers: DfmLayerInput[]): PadRecord[] {
  const pads: PadRecord[] = []
  for (const layer of copperLayers) {
    const { parsedLayer } = layer
    for (const flash of resolvedFlashes(parsedLayer.commands)) {
      const ap = flash.apertureCode !== null ? parsedLayer.apertures.get(flash.apertureCode) : undefined
      pads.push({
        center: [
          toMm(flash.center[0], parsedLayer.units),
          toMm(flash.center[1], parsedLayer.units),
        ],
        minRadiusMm: padMinRadiusMm(ap, parsedLayer.units),
        layerName: layer.fileName,
        side: layer.side,
      })
    }
  }
  return pads
}

/** Every drill hit across the drill layers, as hole records in mm. */
export function collectHoles(drillLayers: DfmLayerInput[]): HoleRecord[] {
  const holes: HoleRecord[] = []
  for (const layer of drillLayers) {
    const { parsedLayer } = layer
    // Plating comes from the pristine file text — the attributes live in
    // `; #@!` comments the geometry parser has no reason to retain.
    const plating = extractDrillPlating(parsedLayer.rawContent ?? "")
    for (const flash of resolvedFlashes(parsedLayer.commands)) {
      const ap = flash.apertureCode !== null ? parsedLayer.apertures.get(flash.apertureCode) : undefined
      const dia = ap?.width
      if (dia === undefined || dia <= 0) continue
      holes.push({
        center: [
          toMm(flash.center[0], parsedLayer.units),
          toMm(flash.center[1], parsedLayer.units),
        ],
        radiusMm: toMm(dia, parsedLayer.units) / 2,
        layerName: layer.fileName,
        plated: holePlating(plating, flash.apertureCode),
      })
    }
  }
  return holes
}

/**
 * Translation that brings the drill coordinates onto the copper. Returns
 * `[0,0]` when the two already share an origin (the common case), a recovered
 * offset when they don't, or null when no translation earns enough support —
 * in which case callers must report "not checked" rather than measure against
 * a mis-registered pad set and invent violations.
 */
export function drillToCopperOffset(holes: HoleRecord[], pads: PadRecord[]): Point | null {
  if (holes.length === 0 || pads.length === 0) return null

  const holePts = holes.map(h => h.center)
  const padPts = pads.map(p => p.center)

  // Already aligned? Check directly before paying for the vote — most files are.
  const aligned = countConcentric(holePts, padPts, [0, 0])
  if (aligned >= Math.max(3, holePts.length * 0.5)) return [0, 0]

  const recovered = recoverDrillOffset(holePts, padPts)
  return recovered ? [recovered.offsetX, recovered.offsetY] : null
}

function countConcentric(holes: readonly Point[], pads: readonly Point[], offset: Point): number {
  const tolSq = CONCENTRIC_TOL_MM * CONCENTRIC_TOL_MM
  let n = 0
  for (const h of holes) {
    const hx = h[0] + offset[0]
    const hy = h[1] + offset[1]
    for (const p of pads) {
      const dx = p[0] - hx
      const dy = p[1] - hy
      if (dx * dx + dy * dy <= tolSq) {
        n++
        break
      }
    }
  }
  return n
}

export interface AnnularRingResult {
  /** Thinnest ring found, mm. Null when nothing measurable was paired. */
  minRingMm: number | null
  /** Where the thinnest ring is, for the marker overlay. */
  worstAt: Point | null
  layerName: string | null
  /** Distinct holes with at least one measurable pad (not pad pairs — a
   *  through-hole normally lands on a pad on both sides). */
  measured: number
  /** Holes paired only to macro pads, deliberately not sized. */
  skippedMacroPads: number
  /** *Known-plated* holes with no pad at all. Non-plated and
   *  unknown-plating holes are excluded — see `plated` on HoleRecord. */
  unlanded: number
  unlandedAt: Point[]
  /** Holes skipped by the unlanded check because plating couldn't be
   *  determined from the file. */
  unknownPlating: number
}

/**
 * Annular ring per hole = (pad min radius − hole radius), taken over holes
 * paired to a concentric pad. Also counts holes that land on no pad at all,
 * which is a separate (and usually worse) problem: an unlanded plated hole has
 * no ring to measure.
 */
export function measureAnnularRings(
  holes: HoleRecord[],
  pads: PadRecord[],
  offset: Point
): AnnularRingResult {
  const tolSq = CONCENTRIC_TOL_MM * CONCENTRIC_TOL_MM
  let minRingMm: number | null = null
  let worstAt: Point | null = null
  let layerName: string | null = null
  let measured = 0
  let skippedMacroPads = 0
  let unlanded = 0
  let unknownPlating = 0
  const unlandedAt: Point[] = []

  for (const hole of holes) {
    // A non-plated hole has no pad by design — measuring a ring for it, or
    // calling it "unlanded", is meaningless.
    if (hole.plated === false) continue

    const hx = hole.center[0] + offset[0]
    const hy = hole.center[1] + offset[1]

    let landed = false
    let sawMacroPad = false
    let measuredThisHole = false
    for (const pad of pads) {
      const dx = pad.center[0] - hx
      const dy = pad.center[1] - hy
      if (dx * dx + dy * dy > tolSq) continue
      landed = true
      if (pad.minRadiusMm === null) {
        sawMacroPad = true
        continue
      }
      measuredThisHole = true
      const ring = pad.minRadiusMm - hole.radiusMm
      if (minRingMm === null || ring < minRingMm) {
        minRingMm = ring
        worstAt = [hx, hy]
        layerName = pad.layerName
      }
    }

    // Count holes, not hole↔pad pairs: a through-hole lands on a pad on both
    // sides, so counting pairs would roughly double the reported hole count.
    if (measuredThisHole) measured++

    if (!landed) {
      // Only accuse a hole of being unlanded when we know it's plated.
      if (hole.plated === true) {
        unlanded++
        if (unlandedAt.length < 50) unlandedAt.push([hx, hy])
      } else {
        unknownPlating++
      }
    } else if (sawMacroPad && !measuredThisHole) {
      skippedMacroPads++
    }
  }

  return {
    minRingMm,
    worstAt,
    layerName,
    measured,
    skippedMacroPads,
    unlanded,
    unlandedAt,
    unknownPlating,
  }
}

export interface HoleSpacingResult {
  minGapMm: number | null
  worstAt: Point | null
}

/**
 * Closest approach between two drill holes, edge to edge (centre distance
 * minus both radii). Too little web between holes breaks out during drilling.
 * Uses a uniform grid so a few thousand holes don't cost O(n²).
 */
export function measureHoleSpacing(holes: HoleRecord[]): HoleSpacingResult {
  if (holes.length < 2) return { minGapMm: null, worstAt: null }

  const maxR = holes.reduce((m, h) => Math.max(m, h.radiusMm), 0)
  // Cell sized so any pair closer than the current best must share or neighbour
  // a cell; 4×maxR is a safe, simple choice for realistic hole sizes.
  const cell = Math.max(maxR * 4, 1)
  const grid = new Map<string, number[]>()
  const key = (cx: number, cy: number) => `${cx},${cy}`
  holes.forEach((h, i) => {
    const cx = Math.floor(h.center[0] / cell)
    const cy = Math.floor(h.center[1] / cell)
    const k = key(cx, cy)
    const bucket = grid.get(k)
    if (bucket) bucket.push(i)
    else grid.set(k, [i])
  })

  let minGapMm: number | null = null
  let worstAt: Point | null = null

  holes.forEach((h, i) => {
    const cx = Math.floor(h.center[0] / cell)
    const cy = Math.floor(h.center[1] / cell)
    for (let ox = -1; ox <= 1; ox++) {
      for (let oy = -1; oy <= 1; oy++) {
        const bucket = grid.get(key(cx + ox, cy + oy))
        if (!bucket) continue
        for (const j of bucket) {
          if (j <= i) continue
          const o = holes[j]
          const dx = o.center[0] - h.center[0]
          const dy = o.center[1] - h.center[1]
          const gap = Math.hypot(dx, dy) - h.radiusMm - o.radiusMm
          if (minGapMm === null || gap < minGapMm) {
            minGapMm = gap
            worstAt = [(h.center[0] + o.center[0]) / 2, (h.center[1] + o.center[1]) / 2]
          }
        }
      }
    }
  })

  return { minGapMm, worstAt }
}

/**
 * Holes whose centre falls outside the board outline's bounding box. A
 * bounding box (rather than the true traced outline) is deliberate: it can
 * only under-report on a non-rectangular board, never invent a violation on a
 * rectangular one — the honest direction to err for an advisory check.
 */
export function holesOutsideOutline(
  holes: HoleRecord[],
  outline: DfmLayerInput | undefined,
  offset: Point
): { count: number; at: Point[] } {
  const b = outline?.parsedLayer.bounds
  if (!b) return { count: 0, at: [] }
  const u = outline!.parsedLayer.units
  const minX = toMm(b.minX, u)
  const minY = toMm(b.minY, u)
  const maxX = toMm(b.maxX, u)
  const maxY = toMm(b.maxY, u)
  // Tolerance so a hole exactly on the edge of the bounding box (common for
  // mounting holes drawn to the board edge) isn't flagged.
  const tol = 0.01

  let count = 0
  const at: Point[] = []
  for (const h of holes) {
    const x = h.center[0] + offset[0]
    const y = h.center[1] + offset[1]
    if (x < minX - tol || x > maxX + tol || y < minY - tol || y > maxY + tol) {
      count++
      if (at.length < 50) at.push([x, y])
    }
  }
  return { count, at }
}

export { resolvedFlashCenters }
