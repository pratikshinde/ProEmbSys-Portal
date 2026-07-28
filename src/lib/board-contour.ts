/**
 * Adapter: tracespace `BoardShape` -> this repo's own `BoardContour`
 * vocabulary (`src/lib/routing/types.ts`).
 *
 * This is the ONLY file that ever reads a tracespace `BoardShape`'s segment
 * format. `src/lib/routing/` (the offset engine, the planner) works purely in
 * `ContourRing`/`BoardContour` and imports nothing from tracespace — matching
 * the pattern `gerber-preprocess.ts` already set for `any`-typed tracespace
 * tree-walking (see its own eslint-disable no-explicit-any header, reused
 * here for the same reason: tracespace ships no runtime validation of its
 * own tree shapes, so the alternative is a large hand-typed duplicate of its
 * internal `BoardShape`/`PathSegment` types for no real safety gain).
 */

import { flattenArc, dedupeRingPoints, classifyRings, signedArea } from './routing/offset'
import type { BoardContour, ContourFailure, ContourRing, Pt } from './routing/types'

export interface ContourTraceOptions {
  toleranceMm: number
  /** Union of every OTHER imported layer's plotted bounds, for the
   *  >=50%-coverage trust gate (guards against a Protel Mechanical-1
   *  dimension-tick layer closing into a degenerate sliver). Pass the
   *  store's own parsedLayer bounds — no re-plot needed. */
  unionBoundsMm?: { minX: number; minY: number; maxX: number; maxY: number } | null
  sourceFileName: string | null
  /**
   * True when the outline file's own native units were inches. tracespace's
   * `maximumGap` gap-fill tolerance is a hardcoded 0.02 in the outline's OWN
   * native units (0.02mm for a metric file, 0.508mm for an inch file) —
   * `boardShapeToContour`'s synthetic-bridge heuristic must scale its
   * threshold to match, or it false-positives on ordinary short polyline
   * segments. A real regression: a polygonised Eagle circle has ~0.1mm
   * segments, comfortably above the correct 0.02mm mm-native threshold but
   * WELL BELOW the wrong 0.508mm inch-native one — using the wrong constant
   * flagged 96/96 and 64/64 segments of two real holes as "synthetic" on the
   * WIFI V6 fixture (caught by the Stage 0 verification harness, not by
   * inspection). If `scaleBoardShapeToMm` already ran on this boardShape
   * (i.e. the outline was inch-native), the coordinates — and thus any
   * gap-fill bridge segment's length — were scaled by 25.4 too, so the
   * comparison threshold must scale the same way.
   */
  outlineWasInches: boolean
}

// tracespace's own BoardShapeFailureReason string constants
// (@tracespace/core/lib/board-shape/index.d.ts) — duplicated as literals
// rather than imported so this file has zero tracespace type imports; they
// are stable public constants, not internal shape details.
const MISSING_OUTLINE_LAYER = 'missingOutlineLayer'
const NO_PATHS_IN_OUTLINE_LAYER = 'noPathsInOutlineLayer'
const NO_CLOSED_REGIONS_FOUND = 'noClosedRegionsFound'

const FAILURE_MAP: Record<string, ContourFailure> = {
  [MISSING_OUTLINE_LAYER]: 'no-outline-layer',
  [NO_PATHS_IN_OUTLINE_LAYER]: 'no-paths-in-outline',
  [NO_CLOSED_REGIONS_FOUND]: 'no-closed-regions',
}

/**
 * Shared coverage gate: a traced shape is only trustworthy when its bbox
 * covers >= 50% of the union of all layer bounds, in BOTH axes.
 * `gerber-svg.ts`'s own substrate-clip trust gate uses this exact predicate
 * (factored out here) so the two guards — one for on-screen clipping, one for
 * fabrication toolpaths — can never silently drift apart.
 */
export function boardShapeCoversContent(
  shapeSize: number[] | undefined,
  unionBoundsMm: { minX: number; minY: number; maxX: number; maxY: number } | null | undefined
): boolean {
  if (!Array.isArray(shapeSize) || shapeSize.length !== 4) return false
  if (!unionBoundsMm) return false
  const contentW = unionBoundsMm.maxX - unionBoundsMm.minX
  const contentH = unionBoundsMm.maxY - unionBoundsMm.minY
  if (!(contentW > 0) || !(contentH > 0)) return false
  const shapeW = shapeSize[2] - shapeSize[0]
  const shapeH = shapeSize[3] - shapeSize[1]
  return shapeW >= 0.5 * contentW && shapeH >= 0.5 * contentH
}

function emptyContour(opts: ContourTraceOptions, failureReason?: ContourFailure): BoardContour {
  return {
    rings: [],
    boundsMm: { minX: 0, minY: 0, maxX: 0, maxY: 0 },
    toleranceMm: opts.toleranceMm,
    openPathCount: 0,
    failureReason,
    sourceFileName: opts.sourceFileName,
  }
}

function ringBoundsOf(pts: Pt[]): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const p of pts) {
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y)
    maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y)
  }
  return { minX, minY, maxX, maxY }
}

function unionRingBounds(rings: ContourRing[]): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const r of rings) {
    minX = Math.min(minX, r.boundsMm.minX); minY = Math.min(minY, r.boundsMm.minY)
    maxX = Math.max(maxX, r.boundsMm.maxX); maxY = Math.max(maxY, r.boundsMm.maxY)
  }
  return { minX, minY, maxX, maxY }
}

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * tracespace `BoardShape` -> `BoardContour`. Pure, synchronous, no I/O.
 *
 * Each closed `ImageRegion` becomes one `ContourRing`: `line` segments append
 * their endpoint directly; `arc` segments are flattened via `flattenArc`
 * (direction-aware — see that function's own warning about why this must
 * NOT reuse `dfm/capsules.ts`'s direction-agnostic arc flattener). A segment
 * that fails to flatten (internally inconsistent center/radius/angles) marks
 * the whole ring as unusable rather than silently substituting a straight
 * line — never guess at fabrication geometry.
 */
export function boardShapeToContour(boardShape: any, opts: ContourTraceOptions): BoardContour {
  if (!boardShape) return emptyContour(opts, 'parse-failed')
  if (boardShape.failureReason) {
    return emptyContour(opts, FAILURE_MAP[boardShape.failureReason] ?? 'parse-failed')
  }

  const regionsRaw: any[] = Array.isArray(boardShape.regions) ? boardShape.regions : []
  if (regionsRaw.length === 0) return emptyContour(opts, 'no-closed-regions')

  if (!boardShapeCoversContent(boardShape.size, opts.unionBoundsMm)) {
    return emptyContour(opts, 'rejected-coverage')
  }

  const rings: ContourRing[] = []
  const gapFillThresholdMm = opts.outlineWasInches ? 0.02 * 25.4 : 0.02

  for (const region of regionsRaw) {
    const segments: any[] = Array.isArray(region.segments) ? region.segments : []
    if (segments.length === 0) continue

    const raw: Pt[] = []
    let arcCount = 0
    let syntheticCloseCount = 0
    let failed = false

    for (const seg of segments) {
      if (!seg) continue
      if (seg.type === 'arc') {
        arcCount++
        const start: Pt = { x: seg.start[0], y: seg.start[1] }
        const end: Pt = { x: seg.end[0], y: seg.end[1] }
        const center: Pt = { x: seg.center[0], y: seg.center[1] }
        const sweepRad: number = seg.end[2] - seg.start[2]
        if (raw.length === 0) raw.push(start)
        const flattened = flattenArc(start, end, center, seg.radius, sweepRad, opts.toleranceMm)
        if (!flattened) { failed = true; break }
        raw.push(...flattened)
      } else {
        // 'line'. tracespace's gap-fill (a hardcoded `maximumGap` in the
        // outline's OWN native units — 0.02mm for metric, ~0.508mm for an
        // inch-native file) invents exactly this kind of segment to bridge
        // an unclosed loop. A line shorter than the worst-case (inch) gap
        // tolerance is a PLAUSIBLE synthetic bridge, not a certain one — real
        // short board-edge segments exist too. Advisory only; see
        // ContourRing.syntheticCloseCount's own doc comment.
        const start: Pt = seg.start ? { x: seg.start[0], y: seg.start[1] } : raw[raw.length - 1]
        const end: Pt = { x: seg.end[0], y: seg.end[1] }
        if (raw.length === 0 && start) raw.push(start)
        if (start) {
          const len = Math.hypot(end.x - start.x, end.y - start.y)
          if (len > 0 && len <= gapFillThresholdMm) syntheticCloseCount++
        }
        raw.push(end)
      }
    }

    if (failed) continue

    const deduped = dedupeRingPoints(raw)
    if (deduped.length < 3) continue

    rings.push({
      points: deduped,
      signedAreaMm2: signedArea(deduped),
      isHole: false,
      depth: 0,
      arcCount,
      syntheticCloseCount,
      ambiguous: false,
      boundsMm: ringBoundsOf(deduped),
    })
  }

  if (rings.length === 0) return emptyContour(opts, 'degenerate')

  const classifications = classifyRings(rings)
  for (let i = 0; i < rings.length; i++) {
    rings[i].isHole = classifications[i].isHole
    rings[i].depth = classifications[i].depth
    rings[i].ambiguous = classifications[i].ambiguous
  }

  const openPathCount = Array.isArray(boardShape.openPaths) ? boardShape.openPaths.length : 0

  return {
    rings,
    boundsMm: unionRingBounds(rings),
    toleranceMm: opts.toleranceMm,
    openPathCount,
    sourceFileName: opts.sourceFileName,
  }
}

/**
 * Parse + plot ONE outline layer and adapt its traced shape. Roughly an
 * order of magnitude cheaper than `gerberRenderBoardView` (which plots and
 * composites every layer for the on-screen board render) — this only ever
 * needs `plot()`'s `boardShape` output, not `renderLayers`/`renderBoard`.
 *
 * Takes `ContourTraceOptions` MINUS `outlineWasInches` — unlike
 * `boardShapeToContour`'s caller (which already has a plot result and so
 * already knows the outline's native units), this function's whole job is
 * to determine that by plotting, so it isn't something the caller could
 * supply in advance.
 */
export async function traceBoardContour(
  outline: { fileName: string; contents: string },
  opts: Omit<ContourTraceOptions, 'outlineWasInches'>
): Promise<BoardContour> {
  try {
    // Lazy-import to match gerber-svg.ts's own bundle-size discipline.
    const [{ parse }, { plot: corePlot }, { normalizeGerberMacroPrimitives, scaleBoardShapeToMm }] =
      await Promise.all([
        import('@tracespace/parser'),
        import('@tracespace/core'),
        import('./gerber-preprocess'),
      ])

    const parseTree = parse(normalizeGerberMacroPrimitives(outline.contents))
    const layers = [{ id: 'outline', filename: outline.fileName, type: 'outline', side: 'all' }]
    const parseTreesById: Record<string, any> = { outline: parseTree }
    const plotResult = corePlot({ layers, parseTreesById } as any) as any

    const outlineWasInches = plotResult.plotTreesById?.outline?.units === 'in'
    if (outlineWasInches) scaleBoardShapeToMm(plotResult.boardShape)

    return boardShapeToContour(plotResult.boardShape, { ...opts, outlineWasInches })
  } catch (err) {
    console.warn('[board-contour] trace failed:', err)
    return {
      rings: [],
      boundsMm: { minX: 0, minY: 0, maxX: 0, maxY: 0 },
      toleranceMm: opts.toleranceMm,
      openPathCount: 0,
      failureReason: 'parse-failed',
      sourceFileName: opts.sourceFileName,
    }
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */
