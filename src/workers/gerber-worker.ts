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
    tree = parse(content)
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
      const parseTree = parse(f.contents)

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

const api = { parseGerber, renderBoardView }
export type GerberWorkerApi = typeof api

Comlink.expose(api)
