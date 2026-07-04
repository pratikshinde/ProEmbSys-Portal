/**
 * Gerber SVG client module.
 *
 * Rendering happens entirely in the browser via a Web Worker (Comlink-wrapped)
 * that uses the tracespace toolchain. The `GerberSvgResult` shape matches what
 * the previous Python-backed API route produced, so callers don't need to
 * change.
 */

import * as Comlink from 'comlink'
import type { GerberWorkerApi } from '@/workers/gerber-worker'

export interface GerberSvgResult {
  /** SVG fragment string — to be embedded in a parent SVG */
  svgFragment: string
  /** Layer bounds in mm [x1, y1, x2, y2] (SVG-native coordinates) */
  bounds: number[]
  /** Original layer units before normalization */
  originalUnits: 'mm' | 'in'
  /** Bounding box in SVG-native (Y-down screen-space) coordinates */
  boundsObj: {
    minX: number
    minY: number
    maxX: number
    maxY: number
  } | null
  /** Original Gerber Y-up bounds (for coordinate display) */
  gerberBounds?: {
    minX: number
    minY: number
    maxX: number
    maxY: number
  } | null
  /** Whether this layer has actual geometry */
  isEmpty: boolean
  /** Error message if rendering failed */
  error?: string
  /** Layer type analysis from TF.FileFunction attribute (if present in file) */
  layerAnalysis?: {
    type: string
    side: string
    fileFunction: string
  }
  /** Extracted outline geometry — kept for type compatibility, not currently produced */
  outline?: {
    path: string
    segments: OutlineSegment[]
    segmentCount: number
    apertureWidth: number
    bounds: { minX: number; minY: number; maxX: number; maxY: number }
  }
}

/** A single outline segment — either a line or an arc */
export interface OutlineSegment {
  type: 'line' | 'arc'
  x1: number
  y1: number
  x2: number
  y2: number
  /** Arc center X (only for arcs) */
  cx?: number
  /** Arc center Y (only for arcs) */
  cy?: number
}

let workerInstance: Worker | null = null
let workerProxy: Comlink.Remote<GerberWorkerApi> | null = null

function getWorker(): Comlink.Remote<GerberWorkerApi> | null {
  if (typeof window === 'undefined') return null
  if (workerProxy) return workerProxy
  workerInstance = new Worker(
    new URL('../workers/gerber-worker.ts', import.meta.url),
    { type: 'module', name: 'gerber-worker' },
  )
  workerProxy = Comlink.wrap<GerberWorkerApi>(workerInstance)
  return workerProxy
}

/**
 * Parse a Gerber/Excellon file and render it to an SVG fragment in a worker.
 * All output is normalized to millimetres.
 */
export async function gerberToSvg(content: string): Promise<GerberSvgResult> {
  const worker = getWorker()
  if (!worker) {
    return {
      svgFragment: '<g></g>',
      bounds: [],
      originalUnits: 'mm',
      boundsObj: null,
      isEmpty: true,
      error: 'Worker unavailable (server-side render?)',
    }
  }
  try {
    const result = await worker.parseGerber(content)
    return result as GerberSvgResult
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.warn('gerberToSvg worker call failed:', message)
    return {
      svgFragment: '<g></g>',
      bounds: [],
      originalUnits: 'mm',
      boundsObj: null,
      isEmpty: true,
      error: message,
    }
  }
}

export interface BoardView {
  topFragment: string
  bottomFragment: string
  viewBox: { x: number; y: number; width: number; height: number }
  error?: string
}

/**
 * Render a polished PCB stack-up (via @tracespace/core renderBoard) for all
 * provided files. Runs directly on the main thread (no worker) to avoid
 * worker bundle caching issues.
 */
export async function gerberRenderBoardView(
  files: { filename: string; contents: string; type?: string; side?: string }[],
): Promise<BoardView> {
  const empty: BoardView = {
    topFragment: '',
    bottomFragment: '',
    viewBox: { x: 0, y: 0, width: 0, height: 0 },
  }

  if (!files || files.length === 0) return { ...empty, error: 'No files' }

  // Lazy-import tracespace to keep initial bundle small
  const [
    { parse },
    { plot: corePlot, renderLayers: coreRenderLayers, renderBoard: coreRenderBoard },
    { toHtml },
  ] = await Promise.all([
    import('@tracespace/parser'),
    import('@tracespace/core'),
    import('hast-util-to-html'),
  ])

  const tsTypeMap: Record<string, string> = {
    copper: 'copper', mask: 'soldermask', silk: 'silkscreen',
    paste: 'solderpaste', drill: 'drill', outline: 'outline',
  }
  const tsSideMap: Record<string, string> = {
    top: 'top', bottom: 'bottom', none: 'all',
  }

  // Filter out non-board layers
  const boardFiles = files.filter(f => f.type !== 'fab' && f.type !== 'other')
  if (boardFiles.length === 0) return { ...empty, error: 'No board layers' }

  try {
    console.log('[BoardView] Starting board render for files:', boardFiles.map(f => `${f.filename} (${f.type}/${f.side})`))
    let idCounter = 0
    const layers: Array<{ id: string; filename: string; type: string; side: string }> = []
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const parseTreesById: Record<string, any> = {}

    for (const f of boardFiles) {
      try {
        const id = `layer-${idCounter++}`
        console.log(`[BoardView] Parsing content for ${f.filename}...`)
        const parseTree = parse(f.contents)
        const tsType = f.type ? (tsTypeMap[f.type] ?? 'copper') : 'copper'
        const tsSide = f.side ? (tsSideMap[f.side] ?? 'all') : 'all'
        layers.push({ id, filename: f.filename, type: tsType, side: tsSide })
        parseTreesById[id] = parseTree
        console.log(`[BoardView] Successfully parsed ${f.filename} → ${tsType}/${tsSide}`)
      } catch (fileErr) {
        const errMsg = fileErr instanceof Error ? fileErr.message : String(fileErr)
        console.warn(`[BoardView] skipping layer ${f.filename} due to parse failure: ${errMsg}`)
      }
    }

    if (layers.length === 0) {
      console.warn('[BoardView] No layers could be parsed by tracespace')
      return { ...empty, error: 'No layers could be parsed by tracespace' }
    }

    console.log(`[BoardView] Running corePlot on ${layers.length} layers...`)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const readResult = { layers, parseTreesById } as any
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plotResult = corePlot(readResult) as any
    console.log('[BoardView] corePlot done. Running coreRenderLayers...')
    
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const renderLayersResult = coreRenderLayers(plotResult) as any
    console.log('[BoardView] coreRenderLayers done. Running coreRenderBoard...')
    
    const board = coreRenderBoard(renderLayersResult)
    console.log('[BoardView] coreRenderBoard done successfully!')

    console.log('[BoardView] boardShape:', plotResult.boardShape?.failureReason ?? 'ok')

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const serialize = (side: any): string =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (side.children as any[]).map((c: any) => toHtml(c, { space: 'svg' })).join('')

    const topFragment = serialize(board.top)
    const bottomFragment = serialize(board.bottom)

    console.log(`[BoardView] Stack-up output top=${topFragment.length} bottom=${bottomFragment.length}`)

    const viewBoxStr = String(board.top.properties?.viewBox ?? '0 0 0 0')
    const [x, y, width, height] = viewBoxStr.split(/\s+/).map(Number)

    return { topFragment, bottomFragment, viewBox: { x, y, width, height } }
  } catch (err) {
    console.error('[BoardView] Outer pipeline failed with error:', err)
    const message = err instanceof Error ? err.message : String(err)
    return { ...empty, error: `renderBoard failed: ${message}` }
  }
}

/**
 * Merge multiple layer bounds into a single combined bounding box (all in mm).
 * Returns the union of all bounds, or null if none have valid bounds.
 */
export function mergeLayerBounds(layers: GerberSvgResult[]): GerberSvgResult['boundsObj'] | null {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  let hasAny = false

  for (const layer of layers) {
    if (!layer.boundsObj || layer.isEmpty) continue
    hasAny = true
    minX = Math.min(minX, layer.boundsObj.minX)
    minY = Math.min(minY, layer.boundsObj.minY)
    maxX = Math.max(maxX, layer.boundsObj.maxX)
    maxY = Math.max(maxY, layer.boundsObj.maxY)
  }

  if (!hasAny) return null
  return { minX, minY, maxX, maxY }
}
