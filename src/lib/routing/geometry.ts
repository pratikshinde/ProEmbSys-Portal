/**
 * Routing geometry primitives.
 *
 * This is the ONLY place cutter-offset and edge-splitting conventions live —
 * the analogue of `src/lib/dfm/measure.ts`. Everything here is:
 *
 *   - millimetres, always. Never pre-convert to inches; `formatCoordinate` and
 *     `formatDrillCoordinate` do unit conversion themselves at emit time.
 *   - panel-absolute Gerber **Y-up** coordinates (the panelization engine's
 *     convention). The viewer negates Y when drawing; nothing here does.
 *
 * Pure functions only: no store, no React, no I/O.
 */

import type { Pt } from './types'

/** Coincidence tolerance in mm. Coordinates are quantised by the output format
 *  (4.6 → 1 nm), so exact float equality is too strict for "same line".
 *  Exported so `offset.ts` can use the identical tolerance — a different
 *  epsilon there would let ring dedup and segment dedup quietly disagree
 *  about what counts as coincident. */
export const COINCIDENT_TOL_MM = 1e-6

/**
 * Grow an axis-aligned rectangle outward by `r` on all four sides and return
 * its corner loop, counter-clockwise from the lower-left.
 *
 * This is the cutter compensation: pass the *finished board* rectangle and the
 * bit radius, and the result is the tool-CENTER path that leaves the board at
 * full size. Offsetting inward (or not at all) undersizes every board by the
 * bit diameter (or radius), which is the classic depaneling scrap cause.
 */
export function offsetRectOutward(
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
): Pt[] {
  return [
    { x: x - r, y: y - r },
    { x: x + w + r, y: y - r },
    { x: x + w + r, y: y + h + r },
    { x: x - r, y: y + h + r },
  ]
}

/**
 * Evenly spaced tab centres along an edge of length `L`, as distances from the
 * edge's start.
 *
 * `L·(i + 0.5)/n` — so n=1 gives the midpoint, n=2 gives L/4 and 3L/4. Always
 * symmetric about the edge centre, and never places a tab at a corner (where it
 * would collide with the perpendicular edge's route).
 */
export function evenTabCenters(L: number, n: number): number[] {
  if (n <= 0 || L <= 0) return []
  const out: number[] = []
  for (let i = 0; i < n; i++) out.push((L * (i + 0.5)) / n)
  return out
}

/** Parse the advanced `tabPositionsMm` CSV override into sorted, in-range distances. */
export function parseTabPositions(csv: string, edgeLength: number): number[] {
  if (!csv.trim()) return []
  return csv
    .split(',')
    .map(s => parseFloat(s.trim()))
    .filter(v => Number.isFinite(v) && v > 0 && v < edgeLength)
    .sort((a, b) => a - b)
}

export interface Span {
  start: number
  end: number
}

/**
 * Split the 1-D interval `[0, L]` by removing `interrupts`, returning the
 * surviving cut spans in order.
 *
 * Overlapping or out-of-range interrupts are merged/clamped first, so callers
 * don't have to pre-sanitise. An interrupt that swallows the whole edge yields
 * an empty result (the edge is entirely uncut).
 */
export function splitEdgeByTabs(L: number, interrupts: Span[]): Span[] {
  if (L <= 0) return []
  if (interrupts.length === 0) return [{ start: 0, end: L }]

  // Clamp to the edge and drop degenerate spans.
  const clamped = interrupts
    .map(s => ({ start: Math.max(0, Math.min(s.start, s.end)), end: Math.min(L, Math.max(s.start, s.end)) }))
    .filter(s => s.end > s.start)
    .sort((a, b) => a.start - b.start)

  if (clamped.length === 0) return [{ start: 0, end: L }]

  // Merge overlaps so the walk below can't emit negative-length spans.
  const merged: Span[] = [clamped[0]]
  for (let i = 1; i < clamped.length; i++) {
    const prev = merged[merged.length - 1]
    const cur = clamped[i]
    if (cur.start <= prev.end) prev.end = Math.max(prev.end, cur.end)
    else merged.push(cur)
  }

  const out: Span[] = []
  let cursor = 0
  for (const gap of merged) {
    if (gap.start > cursor) out.push({ start: cursor, end: gap.start })
    cursor = Math.max(cursor, gap.end)
  }
  if (cursor < L) out.push({ start: cursor, end: L })
  return out
}

/** Linear interpolation from `a` to `b` at distance `d` along the segment. */
export function pointAlong(a: Pt, b: Pt, d: number): Pt {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len = Math.hypot(dx, dy)
  if (len === 0) return { x: a.x, y: a.y }
  return { x: a.x + (dx / len) * d, y: a.y + (dy / len) * d }
}

export function segmentLength(a: Pt, b: Pt): number {
  return Math.hypot(b.x - a.x, b.y - a.y)
}

export function polylineLengthMm(points: Pt[]): number {
  let total = 0
  for (let i = 1; i < points.length; i++) total += segmentLength(points[i - 1], points[i])
  return total
}

/** A single cut segment: a straight tool-center move from `a` to `b`. */
export interface RouteSegment {
  a: Pt
  b: Pt
}

/** Exported so `plan-routing.ts` can use the identical tolerance when
 *  deciding whether two path endpoints are "the same point" for stitching
 *  purposes — a different epsilon there would let dedup and stitching
 *  quietly disagree about what counts as coincident. */
export function ptsClose(p: Pt, q: Pt): boolean {
  return Math.abs(p.x - q.x) < COINCIDENT_TOL_MM && Math.abs(p.y - q.y) < COINCIDENT_TOL_MM
}

/**
 * Drop segments that duplicate an earlier one, in either direction.
 *
 * Two adjacent PCBs each route their own perimeter, so when the gap between
 * them equals the bit diameter their facing passes land on the *same* line and
 * the router would cut it twice. Because tab configuration is global, those two
 * segment sets are geometrically identical in that case, making the comparison
 * exact rather than a fuzzy merge. When the gap differs, nothing matches and
 * nothing is dropped — safe by construction.
 *
 * ⚠ Spatial-hash version, NOT the naive O(n²) full scan — contour mode can
 * hand this ~32,000 segments on a 4x4 panel (~5x10⁸ comparisons naively).
 * Segments are indexed into a grid keyed at exactly `cellSize =
 * COINCIDENT_TOL_MM`, under BOTH endpoints' cells; a query then only needs
 * to look at the 3x3 neighbourhood around each of the candidate segment's
 * own two endpoints. This is a PROVABLE superset of the naive scan's
 * candidates: `ptsClose` is an open per-axis box test with half-width
 * `COINCIDENT_TOL_MM`, so any two points it would call "close" differ in
 * `floor(coord / cellSize)` by at most 1 on each axis — i.e. they always
 * land in the same or an adjacent cell. A future reader should not
 * "optimise" the 3x3 search away without re-deriving this bound if
 * `cellSize`'s definition ever changes (same argument `SegmentGrid` in
 * `offset.ts` makes for its own, independently-derived grid).
 *
 * Output is guaranteed element-for-element identical to the retained naive
 * version: segments are still processed in the same order, and a segment is
 * kept iff no EARLIER kept segment matches it (first-wins, same as `.some()`
 * over an array built in iteration order) — the grid only changes which
 * candidates get compared, never the comparison or the iteration order.
 */
export function dedupeCoincidentSegments(segments: RouteSegment[]): RouteSegment[] {
  const cellSize = COINCIDENT_TOL_MM
  const cellKey = (x: number, y: number): string => `${Math.floor(x / cellSize)},${Math.floor(y / cellSize)}`

  const cells = new Map<string, number[]>()
  const insert = (idx: number, p: Pt): void => {
    const key = cellKey(p.x, p.y)
    let arr = cells.get(key)
    if (!arr) { arr = []; cells.set(key, arr) }
    arr.push(idx)
  }
  const candidatesNear = (p: Pt, out: Set<number>): void => {
    const cx = Math.floor(p.x / cellSize)
    const cy = Math.floor(p.y / cellSize)
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const arr = cells.get(`${cx + dx},${cy + dy}`)
        if (arr) for (const idx of arr) out.add(idx)
      }
    }
  }

  const kept: RouteSegment[] = []
  for (const seg of segments) {
    const candidates = new Set<number>()
    candidatesNear(seg.a, candidates)
    candidatesNear(seg.b, candidates)

    let dup = false
    for (const idx of candidates) {
      const k = kept[idx]
      if ((ptsClose(k.a, seg.a) && ptsClose(k.b, seg.b)) || (ptsClose(k.a, seg.b) && ptsClose(k.b, seg.a))) {
        dup = true
        break
      }
    }
    if (!dup) {
      const idx = kept.length
      kept.push(seg)
      insert(idx, seg.a)
      insert(idx, seg.b)
    }
  }
  return kept
}

/**
 * Hole centres for one mouse-bite tab, laid along the tab's own edge line.
 *
 * Count is `floor((width − dia) / pitch) + 1`, clamped to at least 2 — a single
 * hole is not a perforation and would not help the board snap. Holes are
 * centred on the tab and stay a full radius inside its ends, so a bite never
 * eats into the routed slot on either side.
 *
 * Note these sit on the **board edge**, not the gap centreline: two PCBs facing
 * across a shared gap therefore get two hole rows `gap` apart, which is correct
 * — each board needs its own perforation to snap flush.
 */
export function mouseBiteHoleCenters(
  center: Pt,
  dir: Pt,
  widthMm: number,
  holeDiameterMm: number,
  pitchMm: number
): Pt[] {
  if (widthMm <= 0 || holeDiameterMm <= 0 || pitchMm <= 0) return []

  const usable = widthMm - holeDiameterMm
  let n = usable <= 0 ? 2 : Math.floor(usable / pitchMm) + 1
  if (n < 2) n = 2

  // Keep the row inside the tab: the outermost centres sit a hole radius in.
  const halfSpan = Math.min((n - 1) * pitchMm, Math.max(0, widthMm - holeDiameterMm)) / 2
  const step = n > 1 ? (halfSpan * 2) / (n - 1) : 0

  const len = Math.hypot(dir.x, dir.y) || 1
  const ux = dir.x / len
  const uy = dir.y / len

  const out: Pt[] = []
  for (let i = 0; i < n; i++) {
    const d = -halfSpan + i * step
    out.push({ x: center.x + ux * d, y: center.y + uy * d })
  }
  return out
}
