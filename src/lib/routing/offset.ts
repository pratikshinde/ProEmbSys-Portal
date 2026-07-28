/**
 * Contour offsetting — the cutter compensation for a NON-rectangular board
 * profile. `geometry.ts` stays the rectangle-only conventions file (the panel
 * perimeter is always a true rectangle, so `offsetRectOutward` is untouched
 * and still used for it); this file is everything needed to offset an
 * arbitrary closed polygon by a bit radius and place tabs around it.
 *
 * No polygon-clipping dependency. A PCB profile is a small set of simple,
 * non-self-intersecting, non-touching closed rings — not the general
 * boolean-ops problem a library like Clipper solves. Precedent:
 * `src/lib/dfm/capsules.ts` hand-rolls segment distance, a spatial hash, and
 * union-find rather than pulling a geometry dependency, and documents why.
 *
 * Pure functions only: no store, no React, no I/O, no tracespace types (see
 * `src/lib/board-contour.ts` for the only file that touches those).
 *
 * Conventions, matching `geometry.ts`:
 *   - millimetres, always.
 *   - Gerber Y-up. The viewer negates Y when drawing; nothing here does.
 *
 * Orientation convention adopted here: the OUTER boundary ring is normalised
 * CCW, hole rings CW, and the offset is always taken to the RIGHT of travel
 * by the bit radius `r`. That makes the offset uniformly OUTWARD for the
 * boundary and INWARD for holes with no sign flag threaded through the code.
 * Right normal of a unit direction `(dx,dy)` is `(dy,-dx)` — checked on a CCW
 * unit square: the bottom edge travels `(1,0)`, right-normal `(0,-1)`, which
 * moves down = outward. This also matches `offsetRectOutward`'s own
 * CCW-from-lower-left corner order, so the two paths share one mental model.
 */

import type { Pt } from './types'
import { COINCIDENT_TOL_MM, splitEdgeByTabs, type Span } from './geometry'

// ============================================================================
// Arc flattening
// ============================================================================

/** Chord tolerance floor — finer than this is almost certainly a mistake
 *  (huge point counts for no real benefit). */
export const MIN_ARC_TOLERANCE_MM = 0.001
export const MAX_SEGMENTS_PER_ARC = 512

/**
 * Flatten one arc to a polyline, PRESERVING DIRECTION.
 *
 * ⚠ Deliberately does NOT do `while (a1 < a0) a1 += 2*Math.PI` the way
 * `dfm/capsules.ts` does for its arc-to-capsule flattening. That
 * normalisation is correct there (capsule distance doesn't care which way
 * the arc was drawn) and would be CATASTROPHIC here: a clockwise arc would
 * be flattened as its counter-clockwise complement, silently reversing which
 * side of the boundary is "outward" and cutting into the board.
 *
 * @param sweepRad SIGNED sweep, e.g. tracespace's `end[2] - start[2]`.
 *   Negative = clockwise.
 * @returns Points EXCLUDING `start`, INCLUDING `end` — so callers can
 *   concatenate consecutive segments without duplicating joints. `null` when
 *   the inputs are mutually inconsistent (the computed endpoint doesn't land
 *   on the declared `end` within tolerance) — callers must treat this as a
 *   hard failure, never silently substitute a straight line.
 */
export function flattenArc(
  start: Pt,
  end: Pt,
  center: Pt,
  radius: number,
  sweepRad: number,
  tolMm: number
): Pt[] | null {
  if (!(radius > 0) || sweepRad === 0) return [end]

  const tol = Math.max(tolMm, MIN_ARC_TOLERANCE_MM)
  const a0 = Math.atan2(start.y - center.y, start.x - center.x)

  // Segment count from the sagitta (chord-deviation) formula: the max chord
  // deviation for a full-circle n-gon of radius r is r*(1 - cos(pi/n)); solve
  // for the smallest n keeping that under `tol`.
  const absSweep = Math.abs(sweepRad)
  const maxAnglePerSeg = 2 * Math.acos(Math.max(-1, Math.min(1, 1 - tol / radius)))
  const n = Math.max(1, Math.min(MAX_SEGMENTS_PER_ARC, Math.ceil(absSweep / Math.max(maxAnglePerSeg, 1e-6))))

  const pts: Pt[] = []
  for (let i = 1; i <= n; i++) {
    const a = a0 + (sweepRad * i) / n
    pts.push({ x: center.x + radius * Math.cos(a), y: center.y + radius * Math.sin(a) })
  }

  // Self-check: the last flattened point must land on the declared end.
  const last = pts[pts.length - 1]
  const selfTol = Math.max(1e-6, tol / 10)
  if (Math.abs(last.x - end.x) > selfTol || Math.abs(last.y - end.y) > selfTol) return null

  // Snap the final point exactly to the declared end (removes the tiny
  // trig round-off so consecutive segments join exactly).
  pts[pts.length - 1] = { x: end.x, y: end.y }
  return pts
}

// ============================================================================
// Sanitise, orient, canonicalise
// ============================================================================

/** Drop consecutive duplicate points (including an explicit closing repeat
 *  of point 0 at the end, which some sources include and `ContourRing` never
 *  carries). */
export function dedupeRingPoints(pts: Pt[], tolMm: number = COINCIDENT_TOL_MM): Pt[] {
  if (pts.length === 0) return []
  const out: Pt[] = [pts[0]]
  for (let i = 1; i < pts.length; i++) {
    const prev = out[out.length - 1]
    const p = pts[i]
    if (Math.abs(p.x - prev.x) > tolMm || Math.abs(p.y - prev.y) > tolMm) out.push(p)
  }
  // Drop an explicit closing repeat of the first point.
  if (out.length > 1) {
    const first = out[0]
    const last = out[out.length - 1]
    if (Math.abs(first.x - last.x) <= tolMm && Math.abs(first.y - last.y) <= tolMm) out.pop()
  }
  return out
}

/** Shoelace signed area. Positive = counter-clockwise. */
export function signedArea(pts: Pt[]): number {
  let sum = 0
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]
    const b = pts[(i + 1) % pts.length]
    sum += a.x * b.y - b.x * a.y
  }
  return sum / 2
}

/** Reverse the ring in place (as a new array) if its winding doesn't match
 *  `wantCcw`. */
export function orientRing(pts: Pt[], wantCcw: boolean): Pt[] {
  const isCcw = signedArea(pts) > 0
  return isCcw === wantCcw ? pts.slice() : pts.slice().reverse()
}

/**
 * Rotate the ring so `points[0]` is the vertex with the lowest Y (ties broken
 * by lowest X), without changing point order otherwise.
 *
 * NOT cosmetic. tracespace's own ring-walking (`walkPaths`) starts wherever a
 * `Map`'s insertion order happens to put it, which is not a stable property
 * of the source file — re-importing the identical Gerber can produce a
 * differently-started ring. Tab positions are parameterised by arc length
 * FROM THIS SEAM (see `plan-routing.ts`'s contour tab placement), so without
 * this canonicalisation tabs would silently relocate between runs of the
 * exact same file.
 */
export function canonicaliseRingStart(pts: Pt[]): Pt[] {
  if (pts.length === 0) return pts
  let bestIdx = 0
  for (let i = 1; i < pts.length; i++) {
    const b = pts[bestIdx]
    const p = pts[i]
    if (p.y < b.y || (p.y === b.y && p.x < b.x)) bestIdx = i
  }
  if (bestIdx === 0) return pts.slice()
  return [...pts.slice(bestIdx), ...pts.slice(0, bestIdx)]
}

// ============================================================================
// Nesting / hole classification
// ============================================================================

/** Even-odd ray cast: is `p` inside the closed polygon `poly`?
 *  A third copy of this technique in the repo (`dfm/capsules.ts` works on a
 *  flat `number[]`; `region-font.ts` on `[x,y][]` and is module-private to
 *  the font code) — kept local rather than importing across the `dfm/` or
 *  font module boundary, matching this file's header commitment to staying
 *  dependency-light. */
function pointInPolygon(p: Pt, poly: Pt[]): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y
    const xj = poly[j].x, yj = poly[j].y
    const intersects = yi > p.y !== yj > p.y && p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi
    if (intersects) inside = !inside
  }
  return inside
}

function ringBounds(pts: Pt[]): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const p of pts) {
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y)
    maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y)
  }
  return { minX, minY, maxX, maxY }
}

function boundsContains(
  outer: { minX: number; minY: number; maxX: number; maxY: number },
  inner: { minX: number; minY: number; maxX: number; maxY: number }
): boolean {
  return outer.minX <= inner.minX && outer.minY <= inner.minY && outer.maxX >= inner.maxX && outer.maxY >= inner.maxY
}

/** Pick a robust interior probe point for a ring: the midpoint of its
 *  longest edge, nudged a small distance along the inward normal — avoids
 *  landing exactly on another ring's boundary when two rings share a vertex
 *  (which a plain `points[0]` probe can hit). */
function probePoint(pts: Pt[], nudgeMm: number): Pt {
  let bestLen = -1
  let bestA = pts[0], bestB = pts[1] ?? pts[0]
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]
    const b = pts[(i + 1) % pts.length]
    const len = Math.hypot(b.x - a.x, b.y - a.y)
    if (len > bestLen) { bestLen = len; bestA = a; bestB = b }
  }
  const mx = (bestA.x + bestB.x) / 2
  const my = (bestA.y + bestB.y) / 2
  const dx = bestB.x - bestA.x
  const dy = bestB.y - bestA.y
  const len = Math.hypot(dx, dy) || 1
  // Inward normal for a CCW ring is the LEFT normal (-dy, dx); the ring's own
  // orientation isn't known yet at classification time, so nudge both ways
  // and let the caller retry if this lands on a boundary.
  return { x: mx - (dy / len) * nudgeMm, y: my + (dx / len) * nudgeMm }
}

export interface RingClassification {
  depth: number
  isHole: boolean
  /** -1 when the ring could not be robustly classified (ambiguous nesting —
   *  e.g. a probe repeatedly landed on another ring's boundary). Callers
   *  must treat this as a hard error, not guess. */
  ambiguous: boolean
}

/**
 * Classify each ring's nesting depth by counting how many OTHER rings
 * contain it (even-odd: odd depth = hole). Same technique
 * `region-font.ts`'s `classifyContours` uses for glyph counters, hardened
 * for real-world Gerber input:
 *   - bbox pre-reject before each ray cast (O(R^2) instead of O(R^2 * N))
 *   - a probe robust to shared vertices, with up to 3 retries at different
 *     nudge distances before giving up and reporting ambiguity
 */
export function classifyRings(rings: { points: Pt[] }[]): RingClassification[] {
  const bounds = rings.map(r => ringBounds(r.points))
  const nudges = [1e-4, 1e-3, 1e-2]

  return rings.map((ring, i) => {
    for (const nudge of nudges) {
      const probe = probePoint(ring.points, nudge)
      let onBoundary = false
      let count = 0
      for (let j = 0; j < rings.length; j++) {
        if (j === i) continue
        if (!boundsContains(bounds[j], { minX: probe.x, minY: probe.y, maxX: probe.x, maxY: probe.y })) continue
        // Reject a probe suspiciously close to the candidate ring's own edges
        // — ambiguous, retry with a different nudge rather than trust it.
        if (isNearBoundary(probe, rings[j].points, 1e-6)) { onBoundary = true; break }
        if (pointInPolygon(probe, rings[j].points)) count++
      }
      if (!onBoundary) return { depth: count, isHole: count % 2 === 1, ambiguous: false }
    }
    return { depth: -1, isHole: false, ambiguous: true }
  })
}

function isNearBoundary(p: Pt, poly: Pt[], tolMm: number): boolean {
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    if (distancePointToSegment(p, poly[j], poly[i]) <= tolMm) return true
  }
  return false
}

/** Point-to-segment distance, clamped to the segment. Small and local rather
 *  than importing `dfm/capsules.ts`'s `closestPoints` (built for
 *  segment-segment, and this file commits to no `dfm/` dependency). */
function distancePointToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const lenSq = dx * dx + dy * dy
  if (lenSq === 0) return Math.hypot(p.x - a.x, p.y - a.y)
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq
  t = Math.max(0, Math.min(1, t))
  const cx = a.x + t * dx
  const cy = a.y + t * dy
  return Math.hypot(p.x - cx, p.y - cy)
}

// ============================================================================
// Offsetting proper: raw offset -> proximity prune -> reconnect
// ============================================================================

function unitDir(a: Pt, b: Pt): Pt {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len = Math.hypot(dx, dy) || 1
  return { x: dx / len, y: dy / len }
}

/** Right normal of a (unit) direction vector — see this file's header for
 *  why "always offset right" is uniformly outward-for-CCW-outer and
 *  inward-for-CW-hole with no sign flag threaded through the code. Exported
 *  so plan-routing.ts can compute a tab's board-edge centre (`pt -
 *  r*rightNormal(tangent)`, generalising the bbox path's `boardEdgePoint`)
 *  and classify which side of the board a tab sits on. */
export function rightNormalOf(dir: Pt): Pt {
  return { x: dir.y, y: -dir.x }
}

/** Signed turn angle from `prevDir` to `nextDir` (both unit vectors),
 *  positive = left turn. This is a LOCAL, winding-independent fact about the
 *  vertex — not "convex on a CCW ring" — which is exactly why the same
 *  turn-sign test below correctly produces round joins on an outward
 *  CCW-outer offset AND on an inward CW-hole offset without a separate
 *  branch: offsetting right of a left turn always opens a gap (needs an
 *  arc); offsetting right of a right turn always makes the offset edges
 *  converge (needs a miter). Verified against a CW unit square (see
 *  offset.ts's own header) before relying on this. */
function turnAngle(prevDir: Pt, nextDir: Pt): number {
  const cross = prevDir.x * nextDir.y - prevDir.y * nextDir.x
  const dot = prevDir.x * nextDir.x + prevDir.y * nextDir.y
  return Math.atan2(cross, dot)
}

/** Intersection of two infinite lines, each given as a point + unit
 *  direction. `null` when parallel (or numerically indistinguishable from
 *  it) — callers must not divide by a near-zero denominator and trust the
 *  result, since near-parallel offset lines amplify floating-point error
 *  into a wildly wrong point (see `NEAR_CUSP_RAD` below, the primary guard
 *  for this in practice). */
function lineLineIntersection(p1: Pt, d1: Pt, p2: Pt, d2: Pt): Pt | null {
  const denom = d1.x * d2.y - d1.y * d2.x
  if (Math.abs(denom) < 1e-12) return null
  const dx = p2.x - p1.x
  const dy = p2.y - p1.y
  const t = (dx * d2.y - dy * d2.x) / denom
  return { x: p1.x + t * d1.x, y: p1.y + t * d1.y }
}

/** Turn magnitude beyond which a concave vertex is treated as a cusp: the
 *  two offset lines are nearly parallel, so an analytic miter would be
 *  numerically unstable (or, in the exactly-parallel limit, undefined).
 *  Emit both raw endpoints instead and let `pruneByProximity` /
 *  `reconnectRuns` resolve it — never trust a near-degenerate intersection. */
const NEAR_CUSP_RAD = (179 * Math.PI) / 180

export interface RawOffsetPoint {
  pt: Pt
  /** Index of the SOURCE ring vertex this point is anchored to. */
  sourceIdx: number
}

/**
 * Offset every edge of a closed, already-oriented ring to the right by `r`,
 * joining consecutive offset edges at each source vertex with either a round
 * join (arc, radius `r`, centred on the source vertex — convex-from-the-
 * offset-side) or an analytic miter (concave-from-the-offset-side). Output is
 * NOT yet validated against the rest of the ring — see `pruneByProximity`.
 *
 * Every vertex contributes at least one point; a round join additionally
 * contributes its flattened arc interior. Consecutive vertices' contributions
 * concatenate directly into the raw offset polyline with no extra bookkeeping,
 * because a collinear/miter vertex's single point lies exactly on both
 * adjacent offset edges by construction.
 */
export function rawOffsetRing(pts: Pt[], r: number, tolMm: number): RawOffsetPoint[] {
  const n = pts.length
  if (n < 3 || !(r > 0)) return pts.map((p, i) => ({ pt: { x: p.x, y: p.y }, sourceIdx: i }))

  const dirs: Pt[] = []
  for (let i = 0; i < n; i++) dirs.push(unitDir(pts[i], pts[(i + 1) % n]))
  const normals = dirs.map(rightNormalOf)

  const out: RawOffsetPoint[] = []
  for (let i = 0; i < n; i++) {
    const prevI = (i - 1 + n) % n
    const prevDir = dirs[prevI]
    const nextDir = dirs[i]
    const prevN = normals[prevI]
    const nextN = normals[i]

    const aPrimeEnd: Pt = { x: pts[i].x + r * prevN.x, y: pts[i].y + r * prevN.y }
    const bPrimeStart: Pt = { x: pts[i].x + r * nextN.x, y: pts[i].y + r * nextN.y }
    const turn = turnAngle(prevDir, nextDir)

    if (Math.abs(turn) < 1e-9) {
      out.push({ pt: aPrimeEnd, sourceIdx: i })
    } else if (turn > 0) {
      const flattened = flattenArc(aPrimeEnd, bPrimeStart, pts[i], r, turn, tolMm)
      out.push({ pt: aPrimeEnd, sourceIdx: i })
      if (flattened) {
        for (const p of flattened) out.push({ pt: p, sourceIdx: i })
      } else {
        // Internally inconsistent — should not happen since aPrimeEnd/
        // bPrimeStart/pts[i] are constructed to be exactly self-consistent,
        // but never guess: fall back to the unbridged endpoints and let
        // proximity pruning judge them.
        out.push({ pt: bPrimeStart, sourceIdx: i })
      }
    } else if (Math.abs(turn) > NEAR_CUSP_RAD) {
      out.push({ pt: aPrimeEnd, sourceIdx: i })
      out.push({ pt: bPrimeStart, sourceIdx: i })
    } else {
      const miter = lineLineIntersection(aPrimeEnd, prevDir, bPrimeStart, nextDir)
      if (miter) {
        out.push({ pt: miter, sourceIdx: i })
      } else {
        out.push({ pt: aPrimeEnd, sourceIdx: i })
        out.push({ pt: bPrimeStart, sourceIdx: i })
      }
    }
  }
  return out
}

interface GridSegment {
  a: Pt
  b: Pt
}

/**
 * Local spatial hash over a fixed segment set, for "is any segment within
 * radius r of this point" queries. Re-implemented here (rather than reusing
 * `dfm/capsules.ts`'s `buildGrid`) so `routing/` keeps zero `dfm/`
 * dependency, matching this file's header commitment.
 *
 * `cellSize = max(r, 0.5)` and every query radius passed to
 * `minDistanceWithinRadius` in this file is `<= r`, so `cellRadius =
 * ceil(radius / cellSize)` is always exactly 1 — the search always covers a
 * 3x3 neighbourhood, a provable superset of every segment whose closest
 * point to the query could be within `radius` (that closest point lies on
 * the segment, hence within a cell the segment is indexed into, hence within
 * the searched neighbourhood). A future reader should not "optimise" this
 * into a fixed 3x3 without re-deriving the same bound if `cellSize`'s
 * definition ever changes.
 */
export class SegmentGrid {
  private cellSize: number
  private cells: Map<string, number[]> = new Map()
  private segments: GridSegment[]

  constructor(segments: GridSegment[], cellSize: number) {
    this.cellSize = cellSize
    this.segments = segments
    segments.forEach((seg, idx) => {
      const minX = Math.min(seg.a.x, seg.b.x)
      const maxX = Math.max(seg.a.x, seg.b.x)
      const minY = Math.min(seg.a.y, seg.b.y)
      const maxY = Math.max(seg.a.y, seg.b.y)
      const cx0 = Math.floor(minX / cellSize)
      const cx1 = Math.floor(maxX / cellSize)
      const cy0 = Math.floor(minY / cellSize)
      const cy1 = Math.floor(maxY / cellSize)
      for (let cx = cx0; cx <= cx1; cx++) {
        for (let cy = cy0; cy <= cy1; cy++) {
          const key = `${cx},${cy}`
          let arr = this.cells.get(key)
          if (!arr) { arr = []; this.cells.set(key, arr) }
          arr.push(idx)
        }
      }
    })
  }

  /** Distance from `p` to the nearest indexed segment, early-exiting the
   *  moment a segment closer than `radius` is found — callers here only ever
   *  need a threshold test, not the true global minimum. Returns a value
   *  `>= radius` (possibly `Infinity`) when nothing within `radius` exists. */
  minDistanceWithinRadius(p: Pt, radius: number): number {
    const cx = Math.floor(p.x / this.cellSize)
    const cy = Math.floor(p.y / this.cellSize)
    const cellRadius = Math.max(1, Math.ceil(radius / this.cellSize))
    let best = Infinity
    const seen = new Set<number>()
    for (let dx = -cellRadius; dx <= cellRadius; dx++) {
      for (let dy = -cellRadius; dy <= cellRadius; dy++) {
        const arr = this.cells.get(`${cx + dx},${cy + dy}`)
        if (!arr) continue
        for (const idx of arr) {
          if (seen.has(idx)) continue
          seen.add(idx)
          const seg = this.segments[idx]
          const d = distancePointToSegment(p, seg.a, seg.b)
          if (d < best) best = d
          if (best < radius) return best
        }
      }
    }
    return best
  }
}

function ringSegments(pts: Pt[]): GridSegment[] {
  const n = pts.length
  const segs: GridSegment[] = []
  for (let i = 0; i < n; i++) segs.push({ a: pts[i], b: pts[(i + 1) % n] })
  return segs
}

/** Epsilon subtracted from `r` for every proximity threshold in this file —
 *  a raw/reconnected point must clear `r - PROXIMITY_EPS_MM`, not exactly
 *  `r`, so legitimate points anchored to their OWN generating edge (which
 *  sit at distance exactly `r` from it, up to floating-point round-off)
 *  never self-reject. */
function proximityEps(tolMm: number): number {
  return Math.max(tolMm, COINCIDENT_TOL_MM * 100)
}

export interface PruneResult {
  survivors: RawOffsetPoint[]
  totalCount: number
  prunedCount: number
}

/**
 * Keep only raw offset points whose distance to EVERY segment of the source
 * ring is `>= r - eps`. A point closer than that to some OTHER part of the
 * boundary (not just the edge/vertex that generated it) means the bit
 * physically cannot reach that offset position without gouging the board —
 * this is the mechanism that later reports "feature lost" on a notch
 * narrower than the bit.
 */
export function pruneByProximity(
  raw: RawOffsetPoint[],
  sourcePts: Pt[],
  r: number,
  tolMm: number
): PruneResult {
  const grid = new SegmentGrid(ringSegments(sourcePts), Math.max(r, 0.5))
  const threshold = r - proximityEps(tolMm)
  const survivors: RawOffsetPoint[] = []
  for (const rp of raw) {
    const d = grid.minDistanceWithinRadius(rp.pt, Math.max(threshold, 0))
    if (d >= threshold) survivors.push(rp)
  }
  return { survivors, totalCount: raw.length, prunedCount: raw.length - survivors.length }
}

/**
 * Group survivors into maximal consecutive runs, respecting wraparound.
 *
 * ⚠ The scan MUST start at a genuine run boundary (a kept point immediately
 * preceded by a pruned one) — starting at `keep.findIndex(k => k)` (i.e.
 * always index 0 when raw[0] survives, regardless of whether it's a real
 * boundary) silently split one continuous wraparound run into two whenever
 * the array's start/end both happened to be survivors. That fabricated a
 * gap across the middle of the ring that didn't exist, and `bridgeGap` then
 * "reconnected" it with a real but bogus chord/miter cutting through the
 * board interior — caught by the narrow-notch verification test, not by
 * inspection (see scratch-stage1-offset-verify.ts in the routing plan's
 * history): a symmetric notch has raw[0] and raw[n-1] both survive, so the
 * true single run (wrapping from partway through the array back to its
 * start) was cut into two, and the two ends nearest the notch — not the
 * true gap at the notch itself — got spuriously bridged.
 */
function groupRuns(raw: RawOffsetPoint[], keep: boolean[]): RawOffsetPoint[][] {
  const n = raw.length
  let start = -1
  for (let i = 0; i < n; i++) {
    if (keep[i] && !keep[(i - 1 + n) % n]) { start = i; break }
  }
  if (start === -1) {
    // No pruned->kept boundary anywhere: either everything survived (one
    // run, the whole ring) or nothing did (caller already handles the
    // all-pruned case before this is reached).
    return keep.every(k => k) ? [raw.slice()] : []
  }
  const runs: RawOffsetPoint[][] = []
  let cur: RawOffsetPoint[] = []
  for (let step = 0; step < n; step++) {
    const idx = (start + step) % n
    if (keep[idx]) {
      cur.push(raw[idx])
    } else if (cur.length > 0) {
      runs.push(cur)
      cur = []
    }
  }
  if (cur.length > 0) runs.push(cur)
  return runs
}

interface BridgeResult {
  /** Points to insert BETWEEN the end of the first run and the start of the
   *  second — empty for a validated straight chord, since the two runs'
   *  own endpoints already imply that line. */
  points: Pt[]
  usedChord: boolean
}

/**
 * Bridge the gap between two adjacent surviving runs.
 *
 * First tries an analytic miter: extend the last edge of `runA` and the
 * first edge of `runB` (as infinite lines) and take their intersection,
 * accepted only if IT also clears the proximity threshold. When a run is too
 * short to imply a direction, or the miter fails the proximity test, falls
 * back to the straight chord between the two runs' endpoints — validated by
 * sampling along it, never assumed safe. If even the chord fails, the gap
 * cannot be closed without cutting the board: `null`, and the caller must
 * discard the whole ring.
 */
function bridgeGap(
  runA: RawOffsetPoint[],
  runB: RawOffsetPoint[],
  sourcePts: Pt[],
  r: number,
  tolMm: number
): BridgeResult | null {
  const aLast = runA[runA.length - 1].pt
  const aPrev = runA.length >= 2 ? runA[runA.length - 2].pt : null
  const bFirst = runB[0].pt
  const bNext = runB.length >= 2 ? runB[1].pt : null

  const grid = new SegmentGrid(ringSegments(sourcePts), Math.max(r, 0.5))
  const threshold = r - proximityEps(tolMm)

  if (aPrev && bNext) {
    const dirA = unitDir(aPrev, aLast)
    const dirB = unitDir(bFirst, bNext)
    const miter = lineLineIntersection(aLast, dirA, bFirst, dirB)
    if (miter) {
      const d = grid.minDistanceWithinRadius(miter, Math.max(threshold, 0))
      if (d >= threshold) return { points: [miter], usedChord: false }
    }
  }

  // Chord fallback: sample strictly between the endpoints (both endpoints
  // are already-validated survivors) and reject the whole bridge on the
  // first sample that comes too close to the board.
  const chordLen = Math.hypot(bFirst.x - aLast.x, bFirst.y - aLast.y)
  if (chordLen === 0) return { points: [], usedChord: true }
  const sampleCount = Math.max(4, Math.ceil(chordLen / Math.max(r, 0.1)))
  for (let s = 1; s < sampleCount; s++) {
    const t = s / sampleCount
    const sample: Pt = { x: aLast.x + (bFirst.x - aLast.x) * t, y: aLast.y + (bFirst.y - aLast.y) * t }
    const d = grid.minDistanceWithinRadius(sample, Math.max(threshold, 0))
    if (d < threshold) return null
  }
  return { points: [], usedChord: true }
}

/**
 * Reconnect a set of proximity-surviving runs (in ring order, wrapping) into
 * one closed polyline, bridging every gap. `null` points means at least one
 * gap had no safe bridge at all — the whole ring is unrecoverable.
 */
export function reconnectRuns(
  runs: RawOffsetPoint[][],
  sourcePts: Pt[],
  r: number,
  tolMm: number
): { points: Pt[] | null; lostFeature: boolean } {
  if (runs.length === 0) return { points: null, lostFeature: true }

  let lostFeature = false
  const out: Pt[] = []
  for (let ri = 0; ri < runs.length; ri++) {
    const run = runs[ri]
    out.push(...run.map(rp => rp.pt))
    const nextRun = runs[(ri + 1) % runs.length]
    const bridge = bridgeGap(run, nextRun, sourcePts, r, tolMm)
    if (!bridge) return { points: null, lostFeature: true }
    if (bridge.usedChord) lostFeature = true
    out.push(...bridge.points)
  }
  return { points: out, lostFeature }
}

export interface OffsetRingResult {
  /** Final offset polygon (closed loop; `points[0]` not repeated), or `null`
   *  when the ring could not be safely offset. Fabrication-file honesty
   *  rule: never a partial or guessed result — see this file's header. */
  points: Pt[] | null
  /** Fraction of raw (pre-reconnection) offset points that failed the
   *  proximity test. Callers apply their OWN ">25% pruned -> discard"
   *  policy on top of this (this function doesn't decide that threshold). */
  prunedFraction: number
  /** Every raw offset point was pruned, or reconnection produced nothing
   *  usable at all. */
  collapsed: boolean
  /** At least one gap fell back to a validated straight chord instead of a
   *  clean miter — a feature narrower than the bit was smoothed over. */
  lostFeature: boolean
  /** The offset ring's winding flipped relative to the source ring — the
   *  offset over-shrank past its own centre (e.g. a cutout smaller than the
   *  bit). Forces `collapsed`/`null` rather than emitting inverted geometry. */
  orientationFlipped: boolean
}

/**
 * Offset a closed, already-oriented ring to the right by `r` (see this
 * file's header for the orientation convention: CCW outer -> outward, CW
 * hole -> inward). The full pipeline: `rawOffsetRing` -> `pruneByProximity`
 * -> (if anything was pruned) group into runs and `reconnectRuns` -> dedupe
 * -> orientation cross-check.
 */
export function offsetClosedRing(sourcePts: Pt[], r: number, tolMm: number): OffsetRingResult {
  if (sourcePts.length < 3 || !(r > 0)) {
    return { points: null, prunedFraction: 0, collapsed: true, lostFeature: false, orientationFlipped: false }
  }

  const raw = rawOffsetRing(sourcePts, r, tolMm)
  const pruned = pruneByProximity(raw, sourcePts, r, tolMm)
  const prunedFraction = pruned.totalCount > 0 ? pruned.prunedCount / pruned.totalCount : 1

  if (pruned.survivors.length === 0) {
    return { points: null, prunedFraction, collapsed: true, lostFeature: true, orientationFlipped: false }
  }

  let candidate: Pt[]
  let lostFeature = false

  if (pruned.prunedCount === 0) {
    candidate = raw.map(rp => rp.pt)
  } else {
    const keepSet = new Set(pruned.survivors)
    const keep = raw.map(rp => keepSet.has(rp))
    const runs = groupRuns(raw, keep)
    const reconnected = reconnectRuns(runs, sourcePts, r, tolMm)
    if (!reconnected.points) {
      return { points: null, prunedFraction, collapsed: true, lostFeature: true, orientationFlipped: false }
    }
    candidate = reconnected.points
    lostFeature = reconnected.lostFeature
  }

  const finalPts = dedupeRingPoints(candidate, COINCIDENT_TOL_MM)
  if (finalPts.length < 3) {
    return { points: null, prunedFraction, collapsed: true, lostFeature, orientationFlipped: false }
  }

  const srcSign = Math.sign(signedArea(sourcePts))
  const outSign = Math.sign(signedArea(finalPts))
  const orientationFlipped = srcSign !== 0 && outSign !== 0 && srcSign !== outSign
  if (orientationFlipped) {
    return { points: null, prunedFraction, collapsed: true, lostFeature, orientationFlipped: true }
  }

  return { points: finalPts, prunedFraction, collapsed: false, lostFeature, orientationFlipped: false }
}

// ============================================================================
// Arc-length parameterization and tab placement on a closed ring
// ============================================================================

export interface ArcLengthEntry {
  /** Cumulative distance from `entries[0]` (arc length 0) to this vertex,
   *  walking the ring in point order. Monotonically increasing. */
  cumMm: number
  pt: Pt
}

export interface ArcLengthTable {
  /** One entry per ring vertex, in ring order. `entries[0].cumMm === 0`. */
  entries: ArcLengthEntry[]
  perimeterMm: number
}

/** Build the arc-length table for a closed ring (points[0] not repeated). */
export function buildArcLength(ringPts: Pt[]): ArcLengthTable {
  const entries: ArcLengthEntry[] = []
  let cum = 0
  const n = ringPts.length
  for (let i = 0; i < n; i++) {
    entries.push({ cumMm: cum, pt: ringPts[i] })
    const next = ringPts[(i + 1) % n]
    cum += Math.hypot(next.x - ringPts[i].x, next.y - ringPts[i].y)
  }
  return { entries, perimeterMm: cum }
}

function normalizeArcLength(d: number, perimeterMm: number): number {
  let dd = d % perimeterMm
  if (dd < 0) dd += perimeterMm
  return dd
}

/** The point on the ring at arc-length distance `d` from `entries[0]`,
 *  wrapping. Linearly interpolates between the bracketing vertices — fine at
 *  the chord tolerance the ring was already flattened to. */
export function sampleAt(ringPts: Pt[], table: ArcLengthTable, d: number): Pt {
  const dd = normalizeArcLength(d, table.perimeterMm)
  const n = ringPts.length
  for (let i = 0; i < n; i++) {
    const curCum = table.entries[i].cumMm
    const nextCum = i === n - 1 ? table.perimeterMm : table.entries[i + 1].cumMm
    if (dd >= curCum && dd <= nextCum) {
      const segLen = nextCum - curCum
      const t = segLen > 0 ? (dd - curCum) / segLen : 0
      const cur = ringPts[i]
      const next = ringPts[(i + 1) % n]
      return { x: cur.x + (next.x - cur.x) * t, y: cur.y + (next.y - cur.y) * t }
    }
  }
  return ringPts[0]
}

/** Unit tangent (direction of travel) at arc-length distance `d`. */
export function tangentAt(ringPts: Pt[], table: ArcLengthTable, d: number): Pt {
  const dd = normalizeArcLength(d, table.perimeterMm)
  const n = ringPts.length
  for (let i = 0; i < n; i++) {
    const curCum = table.entries[i].cumMm
    const nextCum = i === n - 1 ? table.perimeterMm : table.entries[i + 1].cumMm
    if (dd >= curCum && dd <= nextCum) {
      return unitDir(ringPts[i], ringPts[(i + 1) % n])
    }
  }
  return { x: 1, y: 0 }
}

/**
 * Total accumulated |turn| (radians) at every ring VERTEX whose arc-length
 * position falls within `[dStart, dEnd]` (wrapping). Because a flattened
 * round join contributes many closely-spaced small vertices, this is a
 * direct measure of how much the ring curves within a span — used by the
 * tab curvature guard to reject placing a tab across a corner or a tight arc.
 */
export function turningOver(ringPts: Pt[], table: ArcLengthTable, dStart: number, dEnd: number): number {
  const P = table.perimeterMm
  const a = normalizeArcLength(dStart, P)
  const b = normalizeArcLength(dEnd, P)
  const n = ringPts.length
  let total = 0
  for (let i = 0; i < n; i++) {
    const cum = table.entries[i].cumMm
    const inSpan = a <= b ? cum >= a && cum <= b : cum >= a || cum <= b
    if (!inSpan) continue
    const prev = ringPts[(i - 1 + n) % n]
    const cur = ringPts[i]
    const next = ringPts[(i + 1) % n]
    total += Math.abs(turnAngle(unitDir(prev, cur), unitDir(cur, next)))
  }
  return total
}

/**
 * The sub-polyline of a closed ring from arc-length `dStart` to `dEnd`
 * (wrapping if `dStart > dEnd`), starting and ending with the exact
 * interpolated points — NOT a straight chord between them. Used to build a
 * tab-interrupted route path segment: a naive chord would cut across a round
 * join or a source arc instead of following it.
 */
export function extractArcSpan(ringPts: Pt[], table: ArcLengthTable, dStart: number, dEnd: number): Pt[] {
  const P = table.perimeterMm
  const a = normalizeArcLength(dStart, P)
  const b = normalizeArcLength(dEnd, P)
  const n = ringPts.length
  const out: Pt[] = [sampleAt(ringPts, table, a)]
  if (a <= b) {
    for (let i = 0; i < n; i++) {
      const cum = table.entries[i].cumMm
      if (cum > a && cum < b) out.push(ringPts[i])
    }
  } else {
    // Wraps past the seam: vertices from `a` to the end of the array come
    // first (increasing cum), THEN vertices from the start of the array up
    // to `b` — matching true arc-length walk order, not array index order.
    for (let i = 0; i < n; i++) {
      if (table.entries[i].cumMm > a) out.push(ringPts[i])
    }
    for (let i = 0; i < n; i++) {
      if (table.entries[i].cumMm < b) out.push(ringPts[i])
    }
  }
  out.push(sampleAt(ringPts, table, b))
  return out
}

/**
 * Split the closed ring's `[0, perimeterMm)` domain by `interrupts`,
 * wrapping. Thin wrapper around `splitEdgeByTabs` (geometry.ts) that first
 * splits any interrupt straddling the seam (arc-length 0) into its two
 * pieces, so the underlying function — which only knows a plain `[0,L]`
 * domain — never has to reason about wraparound. Handling the seam here, in
 * the span domain, is what removes the need for a post-hoc wrap-around merge
 * pass on the contour path (unlike the bbox path in plan-routing.ts, which
 * still needs one because it walks a linear bottom->right->top->left scan of
 * what is actually a cycle).
 */
export function splitClosedByTabs(perimeterMm: number, interrupts: Span[]): Span[] {
  const normalized: Span[] = []
  for (const iv of interrupts) {
    if (iv.start < 0 && iv.end > 0) {
      normalized.push({ start: 0, end: iv.end })
      normalized.push({ start: perimeterMm + iv.start, end: perimeterMm })
    } else if (iv.end > perimeterMm && iv.start < perimeterMm) {
      normalized.push({ start: iv.start, end: perimeterMm })
      normalized.push({ start: 0, end: iv.end - perimeterMm })
    } else {
      normalized.push(iv)
    }
  }
  const spans = splitEdgeByTabs(perimeterMm, normalized)

  // Merge the wrap-around seam. `splitEdgeByTabs` only knows a plain [0,L]
  // domain, so whenever the domain isn't interrupted AT BOTH arc-length 0
  // and the perimeter (the common case: tabs sit somewhere in the middle,
  // not straddling the seam), it reports the leading remainder ([0, first
  // interrupt]) and the trailing remainder ([last interrupt, perimeter]) as
  // two SEPARATE spans — but on a closed ring those two remainders are one
  // continuous physical run through the seam. Left unmerged, a ring with N
  // evenly-spaced tabs produced N+1 outline paths instead of N (caught by
  // the Stage 2 verification harness: 4 tabs on a real 33x102mm contour
  // produced 5 spans, not 4). Represent the merged span with `end >
  // perimeterMm` (wrapping) — `extractArcSpan`/`sampleAt` already normalise
  // both endpoints mod perimeter and detect a wrap via `start > end`.
  if (spans.length > 1) {
    const first = spans[0]
    const last = spans[spans.length - 1]
    if (first.start === 0 && last.end === perimeterMm) {
      return [...spans.slice(1, -1), { start: last.start, end: first.end + perimeterMm }]
    }
  }
  return spans
}

/** Turning angle beyond which a tab is rejected outright (never placed
 *  across a corner or a tight curve — see `findSafeTabCenter`). */
export const MAX_TAB_TURNING_RAD = (20 * Math.PI) / 180

/**
 * Find an arc-length position near `desiredD` whose tab interrupt span
 * (`pathGapMm` wide, centred on the position) accumulates no more than
 * `MAX_TAB_TURNING_RAD` of ring turning. Tries the desired position first,
 * then nudges by +-pathGap/4 steps out to +-pathGap. `null` when no nearby
 * position clears the guard — the caller must skip this tab rather than
 * place it across a corner or tight arc.
 */
export function findSafeTabCenter(
  ringPts: Pt[],
  table: ArcLengthTable,
  desiredD: number,
  pathGapMm: number
): number | null {
  const steps = [0, pathGapMm / 4, -pathGapMm / 4, pathGapMm / 2, -pathGapMm / 2, (3 * pathGapMm) / 4, -(3 * pathGapMm) / 4, pathGapMm, -pathGapMm]
  for (const s of steps) {
    const d = desiredD + s
    const turning = turningOver(ringPts, table, d - pathGapMm / 2, d + pathGapMm / 2)
    if (turning <= MAX_TAB_TURNING_RAD) return d
  }
  return null
}
