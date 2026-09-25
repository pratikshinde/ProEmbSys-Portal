/**
 * One panelized Gerber string -> one binary copper raster. The pure pipeline
 * the worker calls from its exposed `renderAoiRasters` — kept separate from
 * the worker file itself so it's independently testable (parse/plot only
 * need the tracespace packages, no Worker/Comlink/OffscreenCanvas runtime).
 *
 * Structured as the raster twin of `film/gerber-to-film.ts`, including its
 * contract: on ANY failure this returns `bitmap: null` with a warning
 * explaining why. Never a best-effort or partial raster — an inspection
 * reference that is quietly wrong fails good boards, which is worse than
 * having no reference at all.
 *
 * The canvas is injected rather than imported: the browser worker supplies
 * an `OffscreenCanvas` and the headless verification script supplies
 * `@napi-rs/canvas`, and this module stays free of either. Same
 * injected-dependency idiom as `gerber-exporter.ts`'s `FilmRenderer`.
 */
import { parse } from '@tracespace/parser'
import { plot } from '@tracespace/plotter'

import { normalizeGerberMacroPrimitives, normalizeFilmGerberZeroSuppression, scalePlotTreeToMm } from '../gerber-preprocess'
import type { PolarizedImageTree } from '../plot/plot-walker'
import {
  rasterizePlotTree,
  rasterizeDrillMask,
  punchDrillHoles,
  rasterDimensions,
  thresholdToBitmap,
  measureFinestFeature,
  type Canvas2DLike,
  type DrillHoleGroup,
  type DrillSlotGroup,
} from './plot-to-raster'
import { AOI_MAX_CANVAS_PX, AOI_MAX_DIM_PX, AOI_MIN_FEATURE_PX, type AoiSide } from './types'

/** Same allowance as the film pipeline's guard — real floating-point slop
 *  across mm<->native-unit conversions, NOT a tolerance for actual
 *  misdecoding (which is off by orders of magnitude, not fractions of a mm). */
const BOUNDS_EPSILON_MM = 0.5

/** A canvas the rasteriser can draw into, plus how to read it back and let
 *  it go. `dispose` matters: a 16 MP RGBA buffer is ~64 MB, and top and
 *  bottom must never be alive at once. */
export interface AoiCanvas {
  ctx: Canvas2DLike
  /** RGBA bytes, row-major, length widthPx*heightPx*4. */
  readPixels(): Uint8ClampedArray | Uint8Array
  dispose(): void
}

export type AoiCanvasFactory = (widthPx: number, heightPx: number) => AoiCanvas

export interface GerberToAoiOptions {
  /** The already-panelized Gerber text (e.g. from
   *  `generateMergedPanelizedGerber`) — NOT the raw customer upload. */
  content: string
  side: AoiSide
  pxPerMm: number
  panelWidthMm: number
  panelHeightMm: number
  /** Prefixes every warning this run produces, e.g. "Top_Copper". */
  layerLabel: string
  /** Copper = black instead of white — see `AoiConfig.invertOutput`. */
  invert?: boolean
  /** Panel-absolute drilled geometry (mm) to punch out of the copper raster
   *  AFTER it's rasterised, so a flashed pad/via renders as a real donut
   *  instead of a solid disc — see `punchDrillHoles`'s own docs for why this
   *  matters. Omit or leave empty for an unpunched raster (e.g. a caller
   *  that only wants the raw copper plot). */
  holeGroups?: DrillHoleGroup[]
  slotGroups?: DrillSlotGroup[]
  createCanvas: AoiCanvasFactory
}

export interface GerberToAoiResult {
  /** One byte per pixel, 0 = substrate / 1 = copper. `null` when the raster
   *  could not be safely produced — see `warnings`. */
  bitmap: Uint8Array | null
  widthPx: number
  heightPx: number
  warnings: string[]
}

export function checkRasterSize(
  panelWidthMm: number,
  panelHeightMm: number,
  pxPerMm: number
): { widthPx: number; heightPx: number; error: string | null } {
  const { widthPx, heightPx } = rasterDimensions(panelWidthMm, panelHeightMm, pxPerMm)
  const area = widthPx * heightPx
  if (widthPx <= 0 || heightPx <= 0) {
    return { widthPx, heightPx, error: 'Panel has no area to rasterise.' }
  }
  if (widthPx > AOI_MAX_DIM_PX || heightPx > AOI_MAX_DIM_PX) {
    return { widthPx, heightPx, error: `${widthPx}x${heightPx} px exceeds the ${AOI_MAX_DIM_PX} px per-side limit — lower the resolution.` }
  }
  if (area > AOI_MAX_CANVAS_PX) {
    return { widthPx, heightPx, error: `${widthPx}x${heightPx} px (${(area / 1e6).toFixed(1)} MP) exceeds the ${(AOI_MAX_CANVAS_PX / 1e6).toFixed(0)} MP limit — lower the resolution.` }
  }
  return { widthPx, heightPx, error: null }
}

export function gerberToAoiBitmap(opts: GerberToAoiOptions): GerberToAoiResult {
  const { content, side, pxPerMm, panelWidthMm, panelHeightMm, layerLabel, invert, holeGroups, slotGroups, createCanvas } = opts
  const warnings: string[] = []

  const sized = checkRasterSize(panelWidthMm, panelHeightMm, pxPerMm)
  if (sized.error) {
    warnings.push(`${layerLabel}: ${sized.error}`)
    return { bitmap: null, widthPx: sized.widthPx, heightPx: sized.heightPx, warnings }
  }
  const { widthPx, heightPx } = sized

  let tree
  try {
    const normalized = normalizeFilmGerberZeroSuppression(normalizeGerberMacroPrimitives(content))
    tree = parse(normalized)
  } catch (err) {
    warnings.push(`${layerLabel}: failed to parse for AOI generation (${errorMessage(err)}) — raster skipped.`)
    return { bitmap: null, widthPx, heightPx, warnings }
  }

  let image: PolarizedImageTree
  try {
    image = plot(tree) as unknown as PolarizedImageTree
  } catch (err) {
    warnings.push(`${layerLabel}: failed to plot for AOI generation (${errorMessage(err)}) — raster skipped.`)
    return { bitmap: null, widthPx, heightPx, warnings }
  }

  scalePlotTreeToMm(image)

  // Bounds guard — the highest-value check in this pipeline, same reasoning
  // as the film path's. If the plotted geometry doesn't land inside the
  // panel envelope, something upstream decoded coordinates wrong (zero
  // suppression, unit misdetection, coordinate truncation) and the reference
  // would be at the wrong scale — which for AOI means every board fails
  // inspection. Skip and say why.
  const size = image.size
  if (Array.isArray(size) && size.length === 4) {
    const [minX, minY, maxX, maxY] = size
    if (
      minX < -BOUNDS_EPSILON_MM ||
      minY < -BOUNDS_EPSILON_MM ||
      maxX > panelWidthMm + BOUNDS_EPSILON_MM ||
      maxY > panelHeightMm + BOUNDS_EPSILON_MM
    ) {
      warnings.push(
        `${layerLabel}: plotted geometry (${minX.toFixed(2)}, ${minY.toFixed(2)} to ${maxX.toFixed(2)}, ${maxY.toFixed(2)} mm) ` +
          `falls outside the panel (0, 0 to ${panelWidthMm.toFixed(2)}, ${panelHeightMm.toFixed(2)} mm) — ` +
          'raster skipped rather than risk shipping a wrong-scale inspection reference.'
      )
      return { bitmap: null, widthPx, heightPx, warnings }
    }
  }

  const canvas = createCanvas(widthPx, heightPx)
  try {
    const result = rasterizePlotTree(image, canvas.ctx, {
      pxPerMm,
      panelWidthMm,
      panelHeightMm,
      mirror: side === 'bottom',
      invert,
    })
    for (const w of result.warnings) warnings.push(`${layerLabel}: ${w}`)

    // Punch drilled holes out of the copper we just painted, on this SAME
    // canvas, so plated pads/vias render as real donuts — see
    // `punchDrillHoles`'s own docs for why a solid-disc reference is wrong.
    // Must reuse the IDENTICAL transform options `rasterizePlotTree` was
    // just called with (pxPerMm/panelWidthMm/panelHeightMm/mirror/invert),
    // or the holes land in the wrong place relative to the copper above.
    if ((holeGroups?.length ?? 0) > 0 || (slotGroups?.length ?? 0) > 0) {
      const punched = punchDrillHoles(holeGroups ?? [], slotGroups ?? [], canvas.ctx, {
        pxPerMm,
        panelWidthMm,
        panelHeightMm,
        mirror: side === 'bottom',
        invert,
      })
      for (const w of punched.warnings) warnings.push(`${layerLabel}: ${w}`)
    }

    const bitmap = thresholdToBitmap(canvas.readPixels(), widthPx, heightPx)

    // Same last-line-of-defence as the drill mask's — see `isUniform`. A
    // panelized copper layer always has geometry, so a uniform raster means
    // nothing painted, and shipping it would fail every board on inspection.
    if (isUniform(bitmap)) {
      warnings.push(
        `${layerLabel}: the rendered raster came out completely blank — skipped rather than shipped, since an empty ` +
          'copper reference fails every board it is compared against. If you are running a dev server, hard-reload the ' +
          'page first (a Web Worker is not hot-reloaded, so an open tab can keep running an older build) and try again.'
      )
      return { bitmap: null, widthPx, heightPx, warnings }
    }

    // Resolution adequacy, measured on what actually rasterised rather than
    // predicted from the source geometry — see `measureFinestFeature`.
    const { minCopperPx, minGapPx } = measureFinestFeature(bitmap, widthPx, heightPx)
    const finestPx = Math.min(minCopperPx || Infinity, minGapPx || Infinity)
    if (Number.isFinite(finestPx) && finestPx < AOI_MIN_FEATURE_PX) {
      const finestMm = finestPx / pxPerMm
      const neededPxPerMm = Math.ceil(AOI_MIN_FEATURE_PX / finestMm)
      warnings.push(
        `${layerLabel}: finest rasterised feature is ${finestPx}px (${finestMm.toFixed(3)}mm) at ${pxPerMm} px/mm — ` +
          `below the ${AOI_MIN_FEATURE_PX}px floor, so the thinnest traces/gaps may vanish and be reported as defects on a good board. ` +
          `Raise the resolution to at least ${neededPxPerMm} px/mm.`
      )
    }

    return { bitmap, widthPx, heightPx, warnings }
  } catch (err) {
    warnings.push(`${layerLabel}: failed to rasterise (${errorMessage(err)}) — raster skipped.`)
    return { bitmap: null, widthPx, heightPx, warnings }
  } finally {
    canvas.dispose()
  }
}

export interface DrillMaskOptions {
  holeGroups: DrillHoleGroup[]
  slotGroups: DrillSlotGroup[]
  side: AoiSide
  pxPerMm: number
  panelWidthMm: number
  panelHeightMm: number
  layerLabel: string
  invert?: boolean
  createCanvas: AoiCanvasFactory
}

/**
 * Standalone drill mask for one side — every hole white, everything else
 * ground. ⚠ NO LONGER the primary way holes reach the AOI reference: since
 * `gerberToAoiBitmap` now punches holes directly into the copper raster (see
 * `punchDrillHoles`), `Top_Copper.png`/`Bottom_Copper.png` already render
 * plated pads as real donuts and need no subtraction. This mask is kept as a
 * supplementary artifact — an exact, unambiguous "here is precisely where
 * every hole is" reference an inspection app can use for registration or to
 * classify a defect near a hole, without having to infer hole positions from
 * the copper raster's own geometry.
 *
 * Same contract as `gerberToAoiBitmap` — a failure yields `bitmap: null` plus
 * a warning, never a partial mask, since a mask that's missing holes is worse
 * than no mask at all.
 */
export function drillMaskBitmap(opts: DrillMaskOptions): GerberToAoiResult {
  const { holeGroups, slotGroups, side, pxPerMm, panelWidthMm, panelHeightMm, layerLabel, invert, createCanvas } = opts
  const warnings: string[] = []

  const sized = checkRasterSize(panelWidthMm, panelHeightMm, pxPerMm)
  if (sized.error) {
    warnings.push(`${layerLabel}: ${sized.error}`)
    return { bitmap: null, widthPx: sized.widthPx, heightPx: sized.heightPx, warnings }
  }
  const { widthPx, heightPx } = sized

  const canvas = createCanvas(widthPx, heightPx)
  try {
    const result = rasterizeDrillMask(holeGroups, slotGroups, canvas.ctx, {
      pxPerMm,
      panelWidthMm,
      panelHeightMm,
      mirror: side === 'bottom',
      invert,
    })
    for (const w of result.warnings) warnings.push(`${layerLabel}: ${w}`)

    const bitmap = thresholdToBitmap(canvas.readPixels(), widthPx, heightPx)
    const submitted =
      holeGroups.reduce((n, g) => n + g.holes.length, 0) +
      slotGroups.reduce((n, g) => n + g.slots.length, 0)
    if (submitted > 0 && isUniform(bitmap)) {
      // Report WHAT was submitted, not just that it failed. A blank mask from
      // non-empty input means the geometry never landed on the canvas, and the
      // extent below says immediately whether that's because the coordinates
      // are non-finite, in the wrong units, or outside the panel envelope —
      // without needing another round trip to reproduce it.
      warnings.push(
        `${layerLabel}: ${submitted} drilled features were submitted but the rendered mask came out completely blank — ` +
          `dropped rather than shipped, since a blank mask makes the inspection app read every drilled pad as missing copper. ` +
          `Submitted extent: ${describeExtent(holeGroups, slotGroups)}, against a ` +
          `${panelWidthMm.toFixed(1)} x ${panelHeightMm.toFixed(1)} mm panel at ${pxPerMm} px/mm.`
      )
      return { bitmap: null, widthPx, heightPx, warnings }
    }
    return { bitmap, widthPx, heightPx, warnings }
  } catch (err) {
    warnings.push(`${layerLabel}: failed to rasterise drill mask (${errorMessage(err)}) — mask skipped.`)
    return { bitmap: null, widthPx, heightPx, warnings }
  } finally {
    canvas.dispose()
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * True when every pixel carries the same value — i.e. the raster is entirely
 * blank, whichever polarity is in force.
 *
 * ⚠ This is the LAST line of defence, and it exists because the first one
 * wasn't enough. `rasterizeDrillMask` counts DRAW CALLS, so a mask whose holes
 * were all issued but none of which painted reports "9 holes drawn" and emits
 * no warning at all — which is exactly how a 100%-black `Top_Drill.png` once
 * shipped with `"warnings": []` in its own manifest. Checking the finished
 * bitmap can't be fooled that way: whatever the cause, if nothing landed, the
 * caller says so instead of shipping a reference that silently marks every
 * drilled pad as missing copper.
 *
 * Early-exits on the first differing pixel, so a normal raster costs O(1).
 */
/** Human-readable bounds of submitted drill geometry, for the blank-mask
 *  warning. Counts non-finite values separately — averaging them into a
 *  min/max would just print NaN and hide how many there were. */
function describeExtent(holeGroups: DrillHoleGroup[], slotGroups: DrillSlotGroup[]): string {
  const xs: number[] = []
  const ys: number[] = []
  let nonFinite = 0
  const add = (x: number, y: number) => {
    if (Number.isFinite(x) && Number.isFinite(y)) { xs.push(x); ys.push(y) } else nonFinite++
  }
  for (const g of holeGroups) for (const h of g.holes) add(h.x, h.y)
  for (const g of slotGroups) for (const s of g.slots) { add(s.start.x, s.start.y); add(s.end.x, s.end.y) }

  const parts: string[] = []
  if (xs.length > 0) {
    parts.push(
      `x ${Math.min(...xs).toFixed(2)}..${Math.max(...xs).toFixed(2)} mm, ` +
      `y ${Math.min(...ys).toFixed(2)}..${Math.max(...ys).toFixed(2)} mm`
    )
  }
  if (nonFinite > 0) parts.push(`${nonFinite} with non-finite coordinates`)
  return parts.length > 0 ? parts.join('; ') : 'no usable coordinates at all'
}

function isUniform(bitmap: Uint8Array): boolean {
  if (bitmap.length === 0) return true
  const first = bitmap[0]
  for (let i = 1; i < bitmap.length; i++) {
    if (bitmap[i] !== first) return false
  }
  return true
}
