/**
 * Pure geometry for the SMD paste-stencil DXF export: turns one flash's
 * resolved tracespace plot-tree shape into a closed cutout outline via
 * convex hull, plus panel-wide tiling and an optional area-based shrink
 * for fine-pitch bridging prevention.
 *
 * Why convex hull instead of resolving macro apertures ourselves: this
 * codebase's own parser (gerber-parser.ts) never resolves a macro aperture
 * into concrete geometry. dfm/capsules.ts solves the same problem for
 * copper-clearance checking by flattening the tracespace plot tree instead
 * — plot() has already resolved every macro (KiCad's RoundRect included)
 * into concrete primitive shapes with absolute board coordinates baked in.
 * This file reuses that same plot-tree input, but instead of capsules.ts's
 * boundary-segment representation (fine for distance checks, not for a
 * laser cutter), it samples every sub-primitive's boundary into points and
 * takes their convex hull. Real paste pad shapes are essentially always
 * convex (rect, roundrect, circle, obround), so this reproduces the true
 * outline exactly with no polygon-union math or new dependency needed — a
 * rare non-convex custom paste polygon would be slightly over-cut, an
 * accepted tradeoff (confirmed with the user).
 */

import { ARC_TOLERANCE_MM, MAX_ARC_SEGMENTS } from './dfm/capsules'

export interface Point {
  x: number
  y: number
}

type AnyNode = Record<string, unknown>

// ─── Shape sampling ──────────────────────────────────────────────────────
// Mirrors the shape list capsules.ts's pushShape / gerber-preprocess.ts's
// scaleShape walk — keep the three in step if tracespace's grammar ever
// grows a case.

function sampleCircle(cx: number, cy: number, r: number): Point[] {
  if (r <= 0) return [{ x: cx, y: cy }]
  const maxAngle = 2 * Math.acos(Math.max(-1, Math.min(1, 1 - ARC_TOLERANCE_MM / r)))
  const n = Math.max(3, Math.min(MAX_ARC_SEGMENTS, Math.ceil((Math.PI * 2) / Math.max(maxAngle, 1e-6))))
  const out: Point[] = []
  for (let i = 0; i < n; i++) {
    const a = (Math.PI * 2 * i) / n
    out.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) })
  }
  return out
}

/**
 * A rounded rectangle's true boundary is exactly the convex hull of the
 * four full circles (radius r) centred on its four corner-rounding centres
 * — every point on each circle lies either on the true outward-facing arc
 * for that corner, or curls back into the rectangle's own interior (and is
 * then discarded by the hull). This sidesteps having to track which
 * quarter-arc / angular range belongs to which corner.
 */
function sampleRectangle(x: number, y: number, w: number, h: number, r: number): Point[] {
  if (r <= 0) {
    return [
      { x, y },
      { x: x + w, y },
      { x: x + w, y: y + h },
      { x, y: y + h },
    ]
  }
  const x0 = x + r
  const y0 = y + r
  const x1 = x + w - r
  const y1 = y + h - r
  return [
    ...sampleCircle(x0, y0, r),
    ...sampleCircle(x1, y0, r),
    ...sampleCircle(x1, y1, r),
    ...sampleCircle(x0, y1, r),
  ]
}

function samplePolygon(points: unknown): Point[] {
  if (!Array.isArray(points)) return []
  const out: Point[] = []
  for (const p of points as [number, number][]) {
    if (Array.isArray(p) && p.length >= 2) out.push({ x: p[0], y: p[1] })
  }
  return out
}

function sampleArcSegment(
  out: Point[],
  start: [number, number],
  end: [number, number],
  center: [number, number],
  radius: number
): void {
  const a0 = Math.atan2(start[1] - center[1], start[0] - center[0])
  let a1 = Math.atan2(end[1] - center[1], end[0] - center[0])
  while (a1 < a0) a1 += Math.PI * 2
  const sweep = a1 - a0
  const maxAngle = radius > 0 ? 2 * Math.acos(Math.max(-1, Math.min(1, 1 - ARC_TOLERANCE_MM / radius))) : sweep
  const n = Math.max(1, Math.min(MAX_ARC_SEGMENTS, Math.ceil(sweep / Math.max(maxAngle, 1e-6))))
  out.push({ x: start[0], y: start[1] })
  for (let i = 1; i <= n; i++) {
    const a = a0 + (sweep * i) / n
    out.push({ x: center[0] + radius * Math.cos(a), y: center[1] + radius * Math.sin(a) })
  }
}

function sampleOutlineSegments(segments: unknown): Point[] {
  if (!Array.isArray(segments)) return []
  const out: Point[] = []
  for (const seg of segments as AnyNode[]) {
    if (!seg) continue
    const start = seg.start as [number, number] | undefined
    const end = seg.end as [number, number] | undefined
    if (!start || !end) continue
    const center = seg.center as [number, number] | undefined
    const radius = seg.radius as number | undefined
    if (center && typeof radius === 'number' && radius > 0) {
      sampleArcSegment(out, start, end, center, radius)
    } else {
      out.push({ x: start[0], y: start[1] }, { x: end[0], y: end[1] })
    }
  }
  return out
}

/**
 * Flatten one plot-tree child's `.shape` (circle | rectangle | polygon |
 * outline | layeredShape) into a flat list of boundary sample points, in
 * the shape's own absolute mm coordinates. A macro flash (layeredShape)
 * recurses into every sub-shape and concatenates — e.g. KiCad's RoundRect
 * (1 box polygon + 4 corner circles + 4 edge vector-lines) contributes each
 * sub-shape's own boundary samples, which is exactly the point cloud the
 * convex hull needs; the vector-line edges are redundant with the box/circle
 * samples but harmless — the hull discards interior points regardless.
 */
export function samplePlotShape(shape: unknown): Point[] {
  const s = shape as AnyNode | null
  if (!s) return []
  switch (s.type) {
    case 'circle':
      return sampleCircle(s.cx as number, s.cy as number, s.r as number)
    case 'rectangle':
      return sampleRectangle(
        s.x as number,
        s.y as number,
        s.xSize as number,
        s.ySize as number,
        typeof s.r === 'number' ? (s.r as number) : 0
      )
    case 'polygon':
      return samplePolygon(s.points)
    case 'outline':
      return sampleOutlineSegments(s.segments)
    case 'layeredShape': {
      const shapes = s.shapes as unknown[] | undefined
      if (!Array.isArray(shapes)) return []
      const out: Point[] = []
      for (const sub of shapes) out.push(...samplePlotShape(sub))
      return out
    }
    default:
      return []
  }
}

// ─── Convex hull ─────────────────────────────────────────────────────────

/**
 * Monotone-chain (Andrew's algorithm) convex hull. O(n log n), no external
 * dependency — matches this codebase's hand-rolled-geometry convention
 * (offset.ts, capsules.ts, the routing planner). Returns hull vertices in
 * CCW order, first point NOT repeated at the end (matches ContourRing.points'
 * convention). Degenerate inputs (0-2 distinct points, or all collinear)
 * return the input's distinct points unchanged — never throws.
 */
export function convexHull(points: Point[]): Point[] {
  const pts = dedupePoints(points).sort((a, b) => (a.x === b.x ? a.y - b.y : a.x - b.x))
  const n = pts.length
  if (n < 3) return pts

  const cross = (o: Point, a: Point, b: Point) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)

  const lower: Point[] = []
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop()
    lower.push(p)
  }
  const upper: Point[] = []
  for (let i = n - 1; i >= 0; i--) {
    const p = pts[i]
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop()
    upper.push(p)
  }
  lower.pop()
  upper.pop()
  const hull = [...lower, ...upper]
  // All-collinear input: both chains degenerate to the two extreme points.
  return hull.length >= 3 ? hull : dedupePoints(pts)
}

function dedupePoints(points: Point[]): Point[] {
  const seen = new Set<string>()
  const out: Point[] = []
  for (const p of points) {
    const key = `${p.x.toFixed(6)},${p.y.toFixed(6)}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(p)
  }
  return out
}

// ─── Reduction (fine-pitch bridging prevention) ─────────────────────────

function boundsCenter(points: Point[]): Point {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const p of points) {
    if (p.x < minX) minX = p.x
    if (p.x > maxX) maxX = p.x
    if (p.y < minY) minY = p.y
    if (p.y > maxY) maxY = p.y
  }
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 }
}

/**
 * Shrink a closed ring around its own bounding-box center by `reductionPct`
 * (0-100), for fine-pitch bridging prevention. Per-flash, not per-board —
 * each aperture shrinks around its own center, not the board's.
 * `reductionPct <= 0` returns the input unchanged (no allocation) so the
 * common exact-match case costs nothing.
 *
 * Scale factor k = sqrt(1 - pct/100): an area-based % reduction on a
 * self-similar shape scales each linear dimension by sqrt of the area
 * ratio, so a 20% area reduction is k ≈ 0.894, not 0.8.
 */
export function shrinkRingAroundCenter(points: Point[], reductionPct: number): Point[] {
  if (!reductionPct || reductionPct <= 0 || points.length === 0) return points
  const k = Math.sqrt(Math.max(0, 1 - reductionPct / 100))
  const c = boundsCenter(points)
  return points.map((p) => ({ x: c.x + (p.x - c.x) * k, y: c.y + (p.y - c.y) * k }))
}

// ─── Flash → aperture pipeline ───────────────────────────────────────────

export interface FlashAperture {
  /** Convex-hull outline, already reduced if a reduction% was requested —
   *  the actual cut geometry that goes into the DXF. */
  hull: Point[]
  /** The same hull BEFORE reduction — equal to `hull` by value when
   *  `reductionPct` is 0, kept separate (not just a conditional alias) so a
   *  preview can show the true pad shape alongside the reduced cut without
   *  re-deriving it. */
  originalHull: Point[]
  /** Bounding-box center this hull was scaled around (diagnostic use). */
  center: Point
}

/** One flash's full pipeline: sample its shape → hull → optional reduction.
 *  Returns null for a degenerate (<3 distinct point) flash so callers can
 *  skip it cleanly rather than emit a degenerate DXF entity. */
export function resolveFlashAperture(shape: unknown, reductionPct: number): FlashAperture | null {
  const samples = samplePlotShape(shape)
  if (samples.length === 0) return null
  const hull = convexHull(samples)
  if (hull.length < 3) return null
  const center = boundsCenter(hull)
  return { hull: shrinkRingAroundCenter(hull, reductionPct), originalHull: hull, center }
}

/**
 * Walk one (mm-scaled) plot tree's children and resolve every
 * flash-producing node (has a `.shape`) into a FlashAperture. Path/region
 * children (drawn paste traces — rare, out of scope for v1) are skipped but
 * counted, so a caller can warn rather than silently drop geometry.
 */
export function extractPasteApertures(
  tree: unknown,
  reductionPct: number
): { apertures: FlashAperture[]; skippedNonFlashCount: number } {
  const apertures: FlashAperture[] = []
  let skippedNonFlashCount = 0
  const children = (tree as AnyNode | null)?.children
  if (!Array.isArray(children)) return { apertures, skippedNonFlashCount }

  for (const child of children as AnyNode[]) {
    if (!child) continue
    if (child.shape) {
      const flash = resolveFlashAperture(child.shape, reductionPct)
      if (flash) apertures.push(flash)
      else skippedNonFlashCount++
    } else {
      skippedNonFlashCount++
    }
  }
  return { apertures, skippedNonFlashCount }
}

// ─── Panel tiling ─────────────────────────────────────────────────────────

/** Translate a set of rings by a fixed (dx, dy) — the same per-placement
 *  translation math generatePanelizedGerber uses (dx = pos.x + baseOffsetX),
 *  applied to point data instead of re-serialized Gerber commands. */
export function translateRings(rings: Point[][], dx: number, dy: number): Point[][] {
  if (dx === 0 && dy === 0) return rings
  return rings.map((ring) => ring.map((p) => ({ x: p.x + dx, y: p.y + dy })))
}

/**
 * Tile one design's aperture hulls (already in that design's own native
 * coordinate space) across every one of its placements on the panel,
 * applying each placement's (x + datum.x, y + datum.y) offset — mirrors
 * generatePanelizedGerber's translation exactly, so paste apertures land in
 * registration with an exported paste Gerber of the same panel.
 *
 * Rotation is a non-issue: PanelPlacement.rotationDeg is never set to
 * anything but 0 anywhere in panelization-engine.ts today (rotation is
 * scaffolded but deliberately unshipped, per CLAUDE.md's "Rotation is
 * deliberately NOT enabled" section) — translation-only tiling is correct
 * and complete for every panel this tool can currently produce.
 */
export function tileAperturesAcrossPlacements(
  hulls: Point[][],
  placements: { x: number; y: number }[],
  datum: { x: number; y: number }
): Point[][] {
  const out: Point[][] = []
  for (const pos of placements) {
    const dx = pos.x + datum.x
    const dy = pos.y + datum.y
    out.push(...translateRings(hulls, dx, dy))
  }
  return out
}
