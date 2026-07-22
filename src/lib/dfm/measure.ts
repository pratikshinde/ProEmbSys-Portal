/**
 * Unit-normalised measurement helpers for the DFM engine.
 *
 * ⚠ THE ONE RULE: nothing outside this file may read a raw aperture/bounds
 * number. Layer units are NOT guaranteed to be mm:
 *   - the CAM store converts every layer to `targetUnit`, which the user can
 *     toggle to inches (store.ts `setTargetUnit`);
 *   - `analyzeGerberSet` (order flow) leaves layers in their native file units;
 *   - `parseExcellonDrill` always returns mm.
 * `convertLayerUnits` does keep `layer.units` truthful, so every measurement
 * here converts via that field. This project has already shipped two
 * mixed-unit bugs — don't reintroduce a third by assuming mm.
 */

import type { GerberAperture, GerberLayer, GerberUnit } from "@/lib/gerber-parser"
import type { DfmLayerInput } from "./types"

/** Convert a value expressed in `units` to mm. */
export function toMm(value: number, units: GerberUnit): number {
  return units === "inches" ? value * 25.4 : value
}

/** Command types that stroke an aperture along a path — i.e. draw a track.
 *  A stroked track's width IS its (circular) aperture diameter, which is what
 *  makes min-trace-width knowable without any geometry engine. */
const STROKE_COMMANDS = new Set(["interpolate", "arc_cw", "arc_ccw"])

/**
 * Smallest stroke width used on the given layers, in mm.
 *
 * Only circle apertures are considered: a track is stroked with a round tool in
 * practice, and a rect/macro aperture dragged along a path has no single
 * meaningful "width". Region fills (G36/G37) are excluded too — they're areas,
 * not tracks, and their `interpolate` commands carry no meaningful width.
 */
export function minStrokeWidthMm(layers: DfmLayerInput[]): { valueMm: number; layerName: string } | null {
  let best: { valueMm: number; layerName: string } | null = null

  for (const layer of layers) {
    const { parsedLayer } = layer
    const usedCodes = new Set<number>()
    for (const cmd of parsedLayer.commands) {
      if (cmd.regionMode) continue // region outline, not a track
      if (!STROKE_COMMANDS.has(cmd.type)) continue
      if (cmd.apertureCode !== null) usedCodes.add(cmd.apertureCode)
    }

    for (const code of usedCodes) {
      const ap = parsedLayer.apertures.get(code)
      if (!ap || ap.shape !== "circle" || ap.width === undefined || ap.width <= 0) continue
      const valueMm = toMm(ap.width, parsedLayer.units)
      if (!best || valueMm < best.valueMm) best = { valueMm, layerName: layer.fileName }
    }
  }

  return best
}

/**
 * Smallest drill tool diameter across drill layers, in mm.
 * `parseExcellonDrill` stores tools as circle apertures (and already converts
 * them to mm), but we still normalise via `units` so a hand-constructed or
 * future non-mm drill layer can't slip through.
 */
export function minDrillDiameterMm(layers: DfmLayerInput[]): { valueMm: number; layerName: string } | null {
  let best: { valueMm: number; layerName: string } | null = null

  for (const layer of layers) {
    if (layer.type !== "drill") continue
    for (const ap of Array.from(layer.parsedLayer.apertures.values())) {
      if (ap.width === undefined || ap.width <= 0) continue
      const valueMm = toMm(ap.width, layer.parsedLayer.units)
      if (!best || valueMm < best.valueMm) best = { valueMm, layerName: layer.fileName }
    }
  }

  return best
}

/** Smallest dimension of an aperture actually flashed (i.e. a pad) on the given
 *  layers, in mm.
 *
 *  Macro apertures are deliberately skipped: their true extent requires
 *  evaluating the macro's primitives (KiCad's `RoundRect` etc.), and guessing
 *  from raw parameters would produce confident-looking false failures. Reported
 *  as information only — we publish no minimum-pad-size spec to check against. */
export function minFlashedFeatureMm(layers: DfmLayerInput[]): { valueMm: number; layerName: string } | null {
  let best: { valueMm: number; layerName: string } | null = null

  for (const layer of layers) {
    const { parsedLayer } = layer
    const usedCodes = new Set<number>()
    for (const cmd of parsedLayer.commands) {
      if (cmd.type === "flash" && cmd.apertureCode !== null) usedCodes.add(cmd.apertureCode)
    }

    for (const code of usedCodes) {
      const ap = parsedLayer.apertures.get(code)
      if (!ap || ap.shape === "macro") continue
      const dim = smallestApertureDimension(ap)
      if (dim === null) continue
      const valueMm = toMm(dim, parsedLayer.units)
      if (!best || valueMm < best.valueMm) best = { valueMm, layerName: layer.fileName }
    }
  }

  return best
}

function smallestApertureDimension(ap: GerberAperture): number | null {
  const dims: number[] = []
  if (ap.width !== undefined && ap.width > 0) dims.push(ap.width)
  // For a circle the parser stores only `width` (the diameter); height is only
  // meaningful for rect/obround.
  if (ap.shape !== "circle" && ap.height !== undefined && ap.height > 0) dims.push(ap.height)
  return dims.length > 0 ? Math.min(...dims) : null
}

/**
 * Board outline size in mm. Mirrors the fallback `analyzeGerberSet` uses: an
 * explicit outline layer wins, otherwise the layer with the largest bounding
 * area (many exports use non-standard outline names, e.g. Eagle's
 * "profile.gbr"). Drill layers are never used — their extent is the hole
 * pattern, not the board.
 */
export function boardSizeMm(layers: DfmLayerInput[]): { widthMm: number; heightMm: number } | null {
  const candidates = layers.filter((l) => l.type !== "drill" && l.parsedLayer.bounds)
  if (candidates.length === 0) return null

  const outline = candidates.find((l) => l.type === "outline")
  const chosen =
    outline ??
    candidates.reduce((best, l) => (boundsAreaMm(l) > boundsAreaMm(best) ? l : best))

  const b = chosen.parsedLayer.bounds!
  const widthMm = toMm(b.maxX - b.minX, chosen.parsedLayer.units)
  const heightMm = toMm(b.maxY - b.minY, chosen.parsedLayer.units)
  if (!(widthMm > 0) || !(heightMm > 0)) return null
  return { widthMm, heightMm }
}

function boundsAreaMm(layer: DfmLayerInput): number {
  const b = layer.parsedLayer.bounds
  if (!b) return 0
  const u = layer.parsedLayer.units
  return toMm(b.maxX - b.minX, u) * toMm(b.maxY - b.minY, u)
}

/** Distinct copper sides present (0, 1 or 2). Inner layers of a 4/6/8-layer
 *  stack-up aren't detectable from an outer-layer export, which is why the
 *  layer-count check prefers the caller-supplied context value. */
export function copperSideCount(layers: DfmLayerInput[]): 0 | 1 | 2 {
  const sides = new Set(layers.filter((l) => l.type === "copper").map((l) => l.side))
  if (sides.size === 0) return 0
  return sides.has("top") && sides.has("bottom") ? 2 : 1
}

/** Total drill hits across all drill layers. */
export function holeCount(layers: DfmLayerInput[]): number {
  return layers
    .filter((l) => l.type === "drill")
    .reduce((sum, l) => sum + l.parsedLayer.commands.filter((c) => c.type === "flash").length, 0)
}

export type { GerberLayer }
