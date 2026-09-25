/**
 * Gerber rendering Web Worker.
 *
 * Replaces the previous Python (pygerber) HTTP route. Runs entirely in the
 * browser via the tracespace toolchain:
 *   parse → plot → renderFragment → toHtml
 *
 * The worker keeps the same `GerberSvgResult` contract that the Python API
 * route used, so downstream code (store.ts, gerber-viewer.tsx) is unchanged.
 *
 * Coordinate convention (matches the previous pipeline):
 *  - Plotter coords are Y-up (Gerber convention).
 *  - The renderer negates Y when emitting SVG, so the fragment ends up in
 *    Y-down screen-space (screenY = -gerberY).
 *  - All bounds & content are normalized to millimetres.
 */

import * as Comlink from 'comlink'
import { parse } from '@tracespace/parser'
import { plot } from '@tracespace/plotter'
import { renderFragment } from '@tracespace/renderer'
import {
  plot as corePlot,
  renderLayers as coreRenderLayers,
  renderBoard as coreRenderBoard,
} from '@tracespace/core'
import { toHtml } from 'hast-util-to-html'
import { normalizeGerberMacroPrimitives, scalePlotTreeToMm } from '../lib/gerber-preprocess'
import { flattenPlotTree, computeSpacing } from '../lib/dfm/capsules'
import { extractPasteApertures } from '../lib/stencil-geometry'
import { gerberToFilmPdf } from '../lib/film/gerber-to-film'
import type { FilmPolarity } from '../lib/film/plot-to-pdf'
import { gerberToAoiBitmap, drillMaskBitmap, type AoiCanvas, type AoiCanvasFactory } from '../lib/aoi/gerber-to-aoi'
import { encodeBinaryPng } from '../lib/aoi/png-encode'
import type { Canvas2DLike, DrillHoleGroup, DrillSlotGroup } from '../lib/aoi/plot-to-raster'
import type { AoiSide, AoiImageKind } from '../lib/aoi/types'

export interface GerberWorkerResult {
  svgFragment: string
  bounds: number[]
  originalUnits: 'mm' | 'in'
  boundsObj: { minX: number; minY: number; maxX: number; maxY: number } | null
  gerberBounds: { minX: number; minY: number; maxX: number; maxY: number } | null
  isEmpty: boolean
  error?: string
  layerAnalysis?: { type: string; side: string; fileFunction: string }
}

const FILE_FUNCTION_RE = /%TF\.FileFunction,([^*]+)\*%/i

/**
 * Pull a {type, side, fileFunction} hint from the Gerber TF.FileFunction
 * attribute when present. Returns undefined when the attribute is missing or
 * unrecognised — store.ts then falls back to filename heuristics.
 */
function extractLayerAnalysis(content: string): GerberWorkerResult['layerAnalysis'] {
  const match = FILE_FUNCTION_RE.exec(content)
  if (!match) return undefined

  const fileFunction = match[1].trim()
  const parts = fileFunction.split(',').map(p => p.trim())
  const head = parts[0]?.toLowerCase() ?? ''
  const tail = parts[parts.length - 1]?.toLowerCase() ?? ''

  let type = 'other'
  if (head === 'copper') type = 'copper'
  else if (head === 'soldermask') type = 'mask'
  else if (head === 'legend') type = 'silk'
  else if (head === 'profile') type = 'outline'
  else if (head === 'paste') type = 'paste'
  else if (head === 'plated' || head === 'nonplated' || head === 'drill') type = 'drill'
  else if (head === 'component' || head === 'assemblydrawing' || head === 'fabricationdrawing') type = 'fab'

  let side: string = 'none'
  if (tail === 'top') side = 'top'
  else if (tail === 'bot' || tail === 'bottom') side = 'bottom'

  if (type === 'outline' || type === 'drill') side = 'none'

  return { type, side, fileFunction }
}

function emptyResult(error?: string): GerberWorkerResult {
  return {
    svgFragment: '<g></g>',
    bounds: [],
    originalUnits: 'mm',
    boundsObj: null,
    gerberBounds: null,
    isEmpty: true,
    error,
  }
}

function parseGerber(content: string): GerberWorkerResult {
  if (!content || content.trim().length === 0) {
    return emptyResult('Empty content')
  }

  let tree
  let image
  try {
    tree = parse(normalizeGerberMacroPrimitives(content))
    image = plot(tree)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return emptyResult(`Tracespace parse/plot failed: ${msg}`)
  }

  const size = image.size
  const isEmpty = !size || size.length === 0 || image.children.length === 0

  if (isEmpty || size.length === 0) {
    return {
      ...emptyResult('No geometry in file'),
      originalUnits: image.units === 'in' ? 'in' : 'mm',
    }
  }

  const [x1, y1, x2, y2] = size as [number, number, number, number]

  const isInches = image.units === 'in'
  const unitScale = isInches ? 25.4 : 1

  let fragment: string
  try {
    const elem = renderFragment(image)
    fragment = toHtml(elem as any, { space: 'svg' })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return emptyResult(`Tracespace render failed: ${msg}`)
  }

  // tracespace's renderFragment emits a bare <g> without the styling props the
  // full <svg> wrapper would normally set. Replicate them on a wrapping <g> so
  // shapes inherit fill/stroke from currentColor (driven by the viewer's
  // `style={{ color }}`). Critically, stroke-width="0" — SVG defaults to 1
  // user-unit, which would draw a 1 mm phantom border around every pad.
  // Trace paths emit their own stroke-width (the aperture's diameter), so this
  // default only applies to filled shapes.
  const styleAttrs =
    'fill="currentColor" stroke="currentColor" stroke-width="0" ' +
    'stroke-linecap="round" stroke-linejoin="round" ' +
    'fill-rule="evenodd" clip-rule="evenodd"'

  const inner = isInches
    ? `<g transform="scale(${unitScale})">${fragment}</g>`
    : fragment
  const svgFragment = `<g ${styleAttrs}>${inner}</g>`

  const gerberBounds = {
    minX: x1 * unitScale,
    minY: y1 * unitScale,
    maxX: x2 * unitScale,
    maxY: y2 * unitScale,
  }

  const boundsObj = {
    minX: x1 * unitScale,
    minY: -y2 * unitScale,
    maxX: x2 * unitScale,
    maxY: -y1 * unitScale,
  }

  return {
    svgFragment,
    bounds: [boundsObj.minX, boundsObj.minY, boundsObj.maxX, boundsObj.maxY],
    originalUnits: isInches ? 'in' : 'mm',
    boundsObj,
    gerberBounds,
    isEmpty: false,
    layerAnalysis: extractLayerAnalysis(content),
  }
}

export interface BoardViewInput {
  filename: string
  contents: string
  type?: string
  side?: string
}

export interface BoardViewResult {
  /** SVG inner content (defs + content groups) for the top side */
  topFragment: string
  /** SVG inner content for the bottom side (already mirrored by core) */
  bottomFragment: string
  /** ViewBox computed by tracespace/core, in the same Y-down screen-space the
      viewer uses (minY = -plotMaxY, maxY = -plotMinY). */
  viewBox: { x: number; y: number; width: number; height: number }
  error?: string
}


/**
 * Build a polished PCB stack-up render via @tracespace/core (matches the look
 * of tracespace.io/view): green soldermask coating with pad openings showing
 * copper, white silkscreen on top, drill holes masked out. Returns the inner
 * content of the top + bottom SVGs so the viewer can wrap it in its own SVG.
 */
async function renderBoardView(files: BoardViewInput[]): Promise<BoardViewResult> {
  const empty: BoardViewResult = {
    topFragment: '',
    bottomFragment: '',
    viewBox: { x: 0, y: 0, width: 0, height: 0 },
  }
  if (!files || files.length === 0) return { ...empty, error: 'No files' }

  // Filter out layer types that don't contribute to board compositing
  const boardFiles = files.filter(f => {
    if (!f.type) return true
    return f.type !== 'fab' && f.type !== 'other'
  })
  if (boardFiles.length === 0) return { ...empty, error: 'No board layers' }

  // Map our store layer types to tracespace's internal type constants
  const tracespaceTypeMap: Record<string, string> = {
    copper: 'copper',
    mask: 'soldermask',
    silk: 'silkscreen',
    paste: 'solderpaste',
    drill: 'drill',
    outline: 'outline',
  }
  const tracespaceSideMap: Record<string, string> = {
    top: 'top',
    bottom: 'bottom',
    none: 'all',
  }

  try {
    // Build the readResult structure manually, bypassing coreRead entirely.
    // coreRead uses identifyLayers (filename heuristics) which fails for
    // non-standard filenames. We already know the correct types from the store.
    let idCounter = 0
    const layers: Array<{ id: string; filename: string; type: string; side: string }> = []
    const parseTreesById: Record<string, ReturnType<typeof parse>> = {}

    for (const f of boardFiles) {
      const id = `layer-${idCounter++}`
      const parseTree = parse(normalizeGerberMacroPrimitives(f.contents))

      // Determine tracespace type: use store metadata, fall back to parser's filetype
      let tsType: string
      let tsSide: string

      if (f.type && tracespaceTypeMap[f.type]) {
        tsType = tracespaceTypeMap[f.type]
        tsSide = tracespaceSideMap[f.side ?? 'none'] ?? 'all'
      } else {
        // If the parser detected it as a drill file, mark it as drill
        const filetype = (parseTree as { filetype?: string }).filetype
        if (filetype === 'drill') {
          tsType = 'drill'
          tsSide = 'all'
        } else {
          tsType = 'copper'  // fallback
          tsSide = 'all'
        }
      }

      layers.push({ id, filename: f.filename, type: tsType, side: tsSide })
      parseTreesById[id] = parseTree

      console.log(`[BoardView] ${f.filename} → id=${id} type=${tsType} side=${tsSide}`)
    }

    // Feed our manually-constructed readResult through the tracespace pipeline
    const readResult = { layers, parseTreesById }
    const plotResult = corePlot(readResult as Parameters<typeof corePlot>[0])
    const renderLayersResult = coreRenderLayers(plotResult as Parameters<typeof coreRenderLayers>[0])
    const board = coreRenderBoard(renderLayersResult as Parameters<typeof coreRenderBoard>[0])

    const serializeSide = (svgElem: { children: unknown[]; properties?: Record<string, unknown> }) => {
      const inner = (svgElem.children as Parameters<typeof toHtml>[0][])
        .map(child => toHtml(child, { space: 'svg' }))
        .join('')
      return inner
    }

    const topFragment = serializeSide(board.top as never)
    const bottomFragment = serializeSide(board.bottom as never)

    console.log('[BoardView] top fragment length:', topFragment.length, 'bottom:', bottomFragment.length)

    const viewBoxStr = String(((board.top as never as { properties?: Record<string, unknown> }).properties)?.viewBox ?? '0 0 0 0')
    const [x, y, width, height] = viewBoxStr.split(/\s+/).map(Number)

    return {
      topFragment,
      bottomFragment,
      viewBox: { x, y, width, height },
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[BoardView] Error:', msg, err)
    return { ...empty, error: `renderBoard failed: ${msg}` }
  }
}

export interface CopperSpacingInput {
  layerName: string
  contents: string
  minSpacingMm: number
  /** Guard against pathological layers: past this many primitives we report
   *  `truncated` rather than spend unbounded time. */
  maxPrimitives?: number
}

export interface CopperSpacingOutput {
  layerName: string
  minClearanceMm: number | null
  violations: { x: number; y: number; clearanceMm: number }[]
  primitiveCount: number
  truncated: boolean
  error?: string
}

const DEFAULT_MAX_PRIMITIVES = 120_000

/**
 * Copper-to-copper clearance for one layer.
 *
 * Runs here rather than on the main thread for two reasons: it's the only
 * heavy computation in the DFM engine (a populated copper layer is tens of
 * thousands of primitives), and the plot tree it needs is produced right here
 * by plot() — the same tree parseGerber() already builds and discards.
 *
 * Returns findings only, never the primitive set: serialising tens of
 * thousands of capsules across the Comlink boundary would cost more than the
 * computation itself.
 */
function checkCopperSpacing(input: CopperSpacingInput): CopperSpacingOutput {
  const base: CopperSpacingOutput = {
    layerName: input.layerName,
    minClearanceMm: null,
    violations: [],
    primitiveCount: 0,
    truncated: false,
  }
  if (!input.contents || input.contents.trim().length === 0) {
    return { ...base, error: 'Empty content' }
  }

  let image
  try {
    image = plot(parse(normalizeGerberMacroPrimitives(input.contents)))
  } catch (err) {
    return { ...base, error: `parse/plot failed: ${err instanceof Error ? err.message : String(err)}` }
  }

  // Normalise to mm before measuring — an inch-native file would otherwise be
  // graded against millimetre thresholds and under-report by 25.4×.
  scalePlotTreeToMm(image)

  const budget = input.maxPrimitives ?? DEFAULT_MAX_PRIMITIVES
  const { capsules, regions, truncated } = flattenPlotTree(image, budget)
  if (truncated) {
    return { ...base, primitiveCount: capsules.length, truncated: true }
  }

  const result = computeSpacing(capsules, input.minSpacingMm, 200, regions)
  return {
    layerName: input.layerName,
    minClearanceMm: result.minClearanceMm,
    violations: result.violations,
    primitiveCount: result.primitiveCount,
    truncated: false,
  }
}

export interface StencilApertureInput {
  layerName: string
  /** rawContent of ONE paste Gerber layer. */
  contents: string
  /** 0 = exact match, no shrink. */
  reductionPct: number
  maxPrimitives?: number
}

export interface StencilApertureOutput {
  layerName: string
  /** One entry per resolved flash. `hull` is the actual cut geometry
   *  (reduced, if a reduction% was requested); `originalHull` is the same
   *  hull before reduction — kept for preview rendering, equal to `hull` by
   *  value when reductionPct is 0. */
  apertures: { hull: { x: number; y: number }[]; originalHull: { x: number; y: number }[] }[]
  skippedNonFlashCount: number
  truncated: boolean
  error?: string
}

/**
 * Paste-aperture outlines for one layer, for the stencil DXF export.
 *
 * Same parse/plot/normalise pipeline as checkCopperSpacing, for the same
 * reason: plot() has already resolved macro apertures (KiCad's RoundRect
 * included) into concrete primitives, which stencil-geometry.ts's convex
 * hull needs — this codebase's own parser never resolves macro geometry.
 * Paste layers are far sparser than copper (pad flashes only, no traces or
 * pours), so the same DEFAULT_MAX_PRIMITIVES budget is generous here.
 */
function extractStencilApertures(input: StencilApertureInput): StencilApertureOutput {
  const base: StencilApertureOutput = {
    layerName: input.layerName,
    apertures: [],
    skippedNonFlashCount: 0,
    truncated: false,
  }
  if (!input.contents || input.contents.trim().length === 0) {
    return { ...base, error: 'Empty content' }
  }

  let image
  try {
    image = plot(parse(normalizeGerberMacroPrimitives(input.contents)))
  } catch (err) {
    return { ...base, error: `parse/plot failed: ${err instanceof Error ? err.message : String(err)}` }
  }

  scalePlotTreeToMm(image)

  const budget = input.maxPrimitives ?? DEFAULT_MAX_PRIMITIVES
  const childCount = Array.isArray((image as { children?: unknown[] })?.children)
    ? (image as { children: unknown[] }).children.length
    : 0
  if (childCount > budget) {
    return { ...base, truncated: true }
  }

  const { apertures, skippedNonFlashCount } = extractPasteApertures(image, input.reductionPct)
  return {
    layerName: input.layerName,
    apertures: apertures.map((a) => ({ hull: a.hull, originalHull: a.originalHull })),
    skippedNonFlashCount,
    truncated: false,
  }
}

export interface FilmLayerSource {
  descriptiveName: string
  /** The already-panelized Gerber text for this layer — NOT the raw
   *  customer upload (see gerber-to-film.ts's own docs for why). */
  content: string
  polarity: FilmPolarity
}

export interface FilmRenderInput {
  layers: FilmLayerSource[]
  panelWidthMm: number
  panelHeightMm: number
  marginMm: number
}

export interface FilmRenderedFile {
  descriptiveName: string
  /** null when this specific film could not be safely generated — see
   *  `warnings` for why. A per-layer failure never blocks the rest of the
   *  batch. */
  bytes: Uint8Array | null
  warnings: string[]
}

export interface FilmRenderOutput {
  files: FilmRenderedFile[]
}

/**
 * Renders every requested layer's film PDF in one Comlink call, run
 * SEQUENTIALLY inside the worker rather than as N concurrent calls —
 * Comlink already serializes onto this single worker regardless, so
 * batching avoids N round-trip overheads and keeps a natural point to add
 * progress reporting later. Parse+plot of a panel-level copper Gerber is
 * the heaviest computation in this app (the same reason checkCopperSpacing
 * and extractStencilApertures live here rather than on the main thread).
 */
function renderFilmPdf(input: FilmRenderInput): FilmRenderOutput {
  const files: FilmRenderedFile[] = input.layers.map((layer) => {
    const result = gerberToFilmPdf({
      content: layer.content,
      polarity: layer.polarity,
      panelWidthMm: input.panelWidthMm,
      panelHeightMm: input.panelHeightMm,
      marginMm: input.marginMm,
      layerLabel: layer.descriptiveName,
    })
    return { descriptiveName: layer.descriptiveName, bytes: result.bytes, warnings: result.warnings }
  })
  return { files }
}

/** `AoiCanvasFactory` over `OffscreenCanvas` — a worker global, not a DOM
 *  import, so this keeps the worker's zero-DOM-dependency property intact.
 *  Satisfies `Canvas2DLike` structurally; the headless verification script
 *  (`scripts/verify-aoi-raster.mts`) supplies `@napi-rs/canvas` instead, so
 *  `rasterizePlotTree`/`CanvasSink` run completely unmodified in both.
 *
 * ⚠ `willReadFrequently: true` is load-bearing, not a micro-optimisation.
 * Every AOI raster is drawn once and immediately read back via
 * `getImageData` — the entire point of this canvas. Without this hint, the
 * browser is free to back the context with a GPU-composited surface tuned
 * for on-screen display, and `getImageData` is a documented source of
 * exactly the symptom reported live here: a canvas that visually painted
 * correctly reads back as blank/stale, because the GPU->CPU sync a readback
 * requires hadn't completed — a risk that's worse for a SHORT burst of
 * drawing (the drill mask's ~80 small strokes) than a LONG one (the copper
 * raster's hundreds of plot-tree primitives, which incidentally give the
 * GPU pipeline more time to flush before its own later readback), matching
 * the exact pattern reported — copper always fine, the drill mask
 * consistently blank. This hint forces a CPU-backed (software) surface,
 * which has no such sync gap; `getImageData` becomes a plain memory read. */
const offscreenCanvasFactory: AoiCanvasFactory = (widthPx: number, heightPx: number): AoiCanvas => {
  const canvas = new OffscreenCanvas(widthPx, heightPx)
  const ctx = canvas.getContext('2d', { willReadFrequently: true }) as unknown as Canvas2DLike
  return {
    ctx,
    readPixels: () => (ctx as unknown as OffscreenCanvasRenderingContext2D).getImageData(0, 0, widthPx, heightPx).data,
    dispose: () => {
      canvas.width = 0
      canvas.height = 0
    },
  }
}

export interface AoiLayerSource {
  side: AoiSide
  /** The already-panelized Gerber text for this side's copper layer — NOT
   *  the raw customer upload (see gerber-to-aoi.ts's own docs for why). */
  content: string
}

export interface AoiRenderInput {
  layers: AoiLayerSource[]
  panelWidthMm: number
  panelHeightMm: number
  pxPerMm: number
  invert: boolean
  /** Panel-absolute drilled geometry, shared by both sides (a through-hole
   *  exists on top and bottom alike — only the mirror transform differs).
   *  Used twice per side whenever non-empty: punched directly into the
   *  copper raster (so plated pads render as donuts, not discs) AND emitted
   *  as a supplementary standalone drill mask. */
  drillHoleGroups?: DrillHoleGroup[]
  drillSlotGroups?: DrillSlotGroup[]
}

export interface AoiRenderedFile {
  side: AoiSide
  kind: AoiImageKind
  /** PNG bytes, or null when this specific raster could not be safely
   *  generated — see `warnings` for why. A per-side failure never blocks
   *  the other side. */
  bytes: Uint8Array | null
  widthPx: number
  heightPx: number
  warnings: string[]
}

export interface AoiRenderOutput {
  files: AoiRenderedFile[]
}

/**
 * Renders every requested side's AOI reference PNG in one Comlink call, run
 * SEQUENTIALLY — same rationale as `renderFilmPdf`: Comlink already
 * serializes onto this one worker regardless, and top/bottom must never
 * both be alive as RGBA buffers at once (a 16 MP panel is ~64 MB per side).
 * Unlike `renderFilmPdf` this is `async`: PNG encoding goes through
 * `CompressionStream`, which has no synchronous form.
 */
async function renderAoiRasters(input: AoiRenderInput): Promise<AoiRenderOutput> {
  const files: AoiRenderedFile[] = []
  const holeGroups = input.drillHoleGroups ?? []
  const slotGroups = input.drillSlotGroups ?? []

  for (const layer of input.layers) {
    const sideLabel = layer.side === 'top' ? 'Top' : 'Bottom'

    const copper = gerberToAoiBitmap({
      content: layer.content,
      side: layer.side,
      pxPerMm: input.pxPerMm,
      panelWidthMm: input.panelWidthMm,
      panelHeightMm: input.panelHeightMm,
      layerLabel: `${sideLabel}_Copper`,
      invert: input.invert,
      // Punches every drilled hole out of the copper raster so plated pads
      // render as real donuts, not solid discs — see punchDrillHoles's docs.
      holeGroups,
      slotGroups,
      createCanvas: offscreenCanvasFactory,
    })
    files.push({
      side: layer.side,
      kind: 'copper',
      bytes: copper.bitmap ? await encodeBinaryPng(copper.bitmap, copper.widthPx, copper.heightPx) : null,
      widthPx: copper.widthPx,
      heightPx: copper.heightPx,
      warnings: copper.warnings,
    })

    // Supplementary standalone mask (§ drillMaskBitmap's own docs) — the
    // copper raster above already has these holes punched into it. Rides
    // with its own side rather than being emitted once: a through-hole is at
    // the same panel mm on both sides, but the bottom image is mirrored, so
    // the two masks are genuinely different rasters.
    const drill = drillMaskBitmap({
      holeGroups,
      slotGroups,
      side: layer.side,
      pxPerMm: input.pxPerMm,
      panelWidthMm: input.panelWidthMm,
      panelHeightMm: input.panelHeightMm,
      layerLabel: `${sideLabel}_Drill`,
      invert: input.invert,
      createCanvas: offscreenCanvasFactory,
    })
    files.push({
      side: layer.side,
      kind: 'drill',
      bytes: drill.bitmap ? await encodeBinaryPng(drill.bitmap, drill.widthPx, drill.heightPx) : null,
      widthPx: drill.widthPx,
      heightPx: drill.heightPx,
      warnings: drill.warnings,
    })
  }
  return { files }
}

const api = { parseGerber, renderBoardView, checkCopperSpacing, extractStencilApertures, renderFilmPdf, renderAoiRasters }
export type GerberWorkerApi = typeof api

Comlink.expose(api)
