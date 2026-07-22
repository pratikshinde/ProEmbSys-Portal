/**
 * Copper-to-copper clearance, computed exactly from tracespace plot trees.
 *
 * Why plot trees and not our own parsed commands: `plot()` has already resolved
 * aperture *macros* into concrete primitives. Our own parser leaves them
 * unresolved, which is exactly why measure.ts skips macro apertures rather than
 * guess their extent. Working from the plot tree removes that blind spot.
 *
 * The whole grammar collapses onto **one** primitive — a capsule (a segment
 * with a radius) — which makes clearance a single distance function instead of
 * a matrix of shape-pair cases:
 *   circle           → capsule(c, c, r)                   (a disc)
 *   stroked path     → one capsule per segment, r = width/2
 *   rectangle        → its four edges, r = corner radius (0 if square)
 *   polygon/outline  → its edges, r = 0
 *   layeredShape     → recurse
 * Distance between two capsules is segment-segment distance minus both radii,
 * which is *exact* for discs and strokes — i.e. for the overwhelming majority
 * of real copper. Polygon interiors are represented by their boundary, so a
 * shape wholly containing another would measure boundary-to-boundary; that only
 * arises within a single net, which is excluded from clearance anyway.
 *
 * All coordinates are Gerber-native Y-up mm (the tree is scaled to mm before
 * flattening). The viewer converts to its Y-down space when placing markers.
 */

export interface Capsule {
  ax: number
  ay: number
  bx: number
  by: number
  r: number
}

// Arc flattening: an arc is split until each chord's sagitta is below this,
// so the polyline never deviates from the true arc by more than this much.
// 5µm is far below any clearance rule we grade against.
const ARC_TOLERANCE_MM = 0.005
const MAX_ARC_SEGMENTS = 64

type AnyNode = Record<string, unknown>

function pushArc(
  out: Capsule[],
  start: [number, number],
  end: [number, number],
  center: [number, number],
  radius: number,
  r: number
): void {
  const a0 = Math.atan2(start[1] - center[1], start[0] - center[0])
  let a1 = Math.atan2(end[1] - center[1], end[0] - center[0])
  // Normalise to a positive sweep; direction doesn't matter for distance.
  while (a1 < a0) a1 += Math.PI * 2
  const sweep = a1 - a0
  // Segments needed to keep the sagitta under tolerance.
  const maxAngle = radius > 0 ? 2 * Math.acos(Math.max(-1, Math.min(1, 1 - ARC_TOLERANCE_MM / radius))) : sweep
  const n = Math.max(1, Math.min(MAX_ARC_SEGMENTS, Math.ceil(sweep / Math.max(maxAngle, 1e-6))))
  let px = start[0]
  let py = start[1]
  for (let i = 1; i <= n; i++) {
    const a = a0 + (sweep * i) / n
    const qx = center[0] + radius * Math.cos(a)
    const qy = center[1] + radius * Math.sin(a)
    out.push({ ax: px, ay: py, bx: qx, by: qy, r })
    px = qx
    py = qy
  }
}

function pushSegments(out: Capsule[], segments: unknown, r: number): void {
  if (!Array.isArray(segments)) return
  for (const seg of segments as AnyNode[]) {
    if (!seg) continue
    const start = seg.start as [number, number] | undefined
    const end = seg.end as [number, number] | undefined
    if (!start || !end) continue
    const center = seg.center as [number, number] | undefined
    const radius = seg.radius as number | undefined
    if (center && typeof radius === "number" && radius > 0) {
      pushArc(out, start, end, center, radius, r)
    } else {
      out.push({ ax: start[0], ay: start[1], bx: end[0], by: end[1], r })
    }
  }
}

/** Flatten one plot-tree shape into capsules. Mirrors the shape list that
 *  gerber-preprocess.ts's `scaleShape` walks — keep the two in step if
 *  tracespace's grammar ever grows a case. */
function pushShape(out: Capsule[], shape: unknown): void {
  const s = shape as AnyNode | null
  if (!s) return
  switch (s.type) {
    case "circle": {
      const cx = s.cx as number
      const cy = s.cy as number
      const r = s.r as number
      out.push({ ax: cx, ay: cy, bx: cx, by: cy, r })
      break
    }
    case "rectangle": {
      const x = s.x as number
      const y = s.y as number
      const w = s.xSize as number
      const h = s.ySize as number
      const r = typeof s.r === "number" ? (s.r as number) : 0
      // Inset by the corner radius so the capsules' radius reproduces the
      // rounded outline rather than inflating a square one.
      const x0 = x + r
      const y0 = y + r
      const x1 = x + w - r
      const y1 = y + h - r
      out.push({ ax: x0, ay: y0, bx: x1, by: y0, r })
      out.push({ ax: x1, ay: y0, bx: x1, by: y1, r })
      out.push({ ax: x1, ay: y1, bx: x0, by: y1, r })
      out.push({ ax: x0, ay: y1, bx: x0, by: y0, r })
      break
    }
    case "polygon": {
      const pts = s.points as [number, number][] | undefined
      if (!Array.isArray(pts) || pts.length < 2) break
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i]
        const b = pts[(i + 1) % pts.length]
        out.push({ ax: a[0], ay: a[1], bx: b[0], by: b[1], r: 0 })
      }
      break
    }
    case "outline":
      pushSegments(out, s.segments, 0)
      break
    case "layeredShape": {
      const shapes = s.shapes as unknown[] | undefined
      if (Array.isArray(shapes)) for (const sub of shapes) pushShape(out, sub)
      break
    }
  }
}

/**
 * A filled region (copper pour). We keep its outline as a point ring so we can
 * later ask whether some *other* primitive lies inside it — see
 * `mergeRegionContents`. Without that, a pad flooded by the pour it connects to
 * looks like a separate net that happens to sit a few microns away, and gets
 * reported as a clearance violation.
 */
export interface RegionRing {
  /** Flattened x,y pairs of the region outline, including any void sub-paths
   *  (even-odd winding is what makes anti-pad voids come out as "outside"). */
  points: number[]
  minX: number
  minY: number
  maxX: number
  maxY: number
  /** Index range of this region's own capsules in the capsule array. */
  first: number
  count: number
}

/** Flatten a whole (mm-scaled) plot tree into capsules, plus the filled-region
 *  outlines needed for containment tests. */
export function flattenPlotTree(
  tree: unknown,
  budget: number
): { capsules: Capsule[]; regions: RegionRing[]; truncated: boolean } {
  const out: Capsule[] = []
  const regions: RegionRing[] = []
  const children = (tree as AnyNode | null)?.children
  if (!Array.isArray(children)) return { capsules: out, regions, truncated: false }

  for (const child of children as AnyNode[]) {
    if (!child) continue
    if (out.length > budget) return { capsules: out, regions, truncated: true }
    if (child.shape) {
      pushShape(out, child.shape)
    } else if (Array.isArray(child.segments)) {
      const width = typeof child.width === "number" ? (child.width as number) : 0
      const first = out.length
      pushSegments(out, child.segments, width / 2)
      // A zero-width path in the plot tree is a filled region (imageRegion),
      // not a hairline trace — its interior is copper.
      if (child.type === "imageRegion" || width === 0) {
        const points: number[] = []
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
        for (let i = first; i < out.length; i++) {
          const c = out[i]
          points.push(c.ax, c.ay)
          minX = Math.min(minX, c.ax, c.bx)
          minY = Math.min(minY, c.ay, c.by)
          maxX = Math.max(maxX, c.ax, c.bx)
          maxY = Math.max(maxY, c.ay, c.by)
        }
        if (points.length >= 6) {
          regions.push({ points, minX, minY, maxX, maxY, first, count: out.length - first })
        }
      }
    }
  }
  return { capsules: out, regions, truncated: out.length > budget }
}

/** Even-odd ray cast. Voids inside a pour are traced as additional sub-paths
 *  within the same region, so even-odd correctly reports a pad sitting in an
 *  anti-pad void as *outside* the copper. */
function pointInRing(px: number, py: number, pts: number[]): boolean {
  let inside = false
  const n = pts.length / 2
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = pts[i * 2], yi = pts[i * 2 + 1]
    const xj = pts[j * 2], yj = pts[j * 2 + 1]
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
      inside = !inside
    }
  }
  return inside
}

// ─── Distance ────────────────────────────────────────────────────────────────

/** The pair of closest points on two segments: [p1x, p1y, p2x, p2y]. */
function closestPoints(
  ax: number, ay: number, bx: number, by: number,
  cx: number, cy: number, dx: number, dy: number
): [number, number, number, number] {
  const ux = bx - ax
  const uy = by - ay
  const vx = dx - cx
  const vy = dy - cy
  const wx = ax - cx
  const wy = ay - cy

  const a = ux * ux + uy * uy
  const b = ux * vx + uy * vy
  const c = vx * vx + vy * vy
  const d = ux * wx + uy * wy
  const e = vx * wx + vy * wy
  const denom = a * c - b * b

  // Unconstrained closest point on segment 1; `t` is then derived from the
  // clamped `s` below rather than solved for here, so the parallel/degenerate
  // case needs no special value.
  let s = denom < 1e-12 ? 0 : (b * e - c * d) / denom
  s = Math.max(0, Math.min(1, s))
  // Project onto segment 2 from the clamped point, then back again, so a
  // closest pair that lies at an endpoint is found rather than missed.
  const sx = ax + s * ux
  const sy = ay + s * uy
  const tt = c > 1e-12 ? Math.max(0, Math.min(1, ((sx - cx) * vx + (sy - cy) * vy) / c)) : 0
  const tx = cx + tt * vx
  const ty = cy + tt * vy
  const ss = a > 1e-12 ? Math.max(0, Math.min(1, ((tx - ax) * ux + (ty - ay) * uy) / a)) : 0
  const fx = ax + ss * ux
  const fy = ay + ss * uy
  return [fx, fy, tx, ty]
}

/** Clearance between two capsules (negative when they overlap). */
export function capsuleDistance(p: Capsule, q: Capsule): number {
  const [px, py, qx, qy] = closestPoints(p.ax, p.ay, p.bx, p.by, q.ax, q.ay, q.bx, q.by)
  return Math.hypot(px - qx, py - qy) - p.r - q.r
}

/**
 * Midpoint of the *closest approach* between two capsules — where the gap
 * actually is, which is where a marker must point. The midpoint of the two
 * capsules' centres is not good enough: a long pour edge against a small pad
 * puts that point far from the offending gap, sending the user to the wrong
 * part of the board.
 */
function closestMidpoint(p: Capsule, q: Capsule): { x: number; y: number } {
  const [px, py, qx, qy] = closestPoints(p.ax, p.ay, p.bx, p.by, q.ax, q.ay, q.bx, q.by)
  return { x: (px + qx) / 2, y: (py + qy) / 2 }
}

// ─── Spatial grid ────────────────────────────────────────────────────────────

function capsuleBounds(c: Capsule) {
  return {
    minX: Math.min(c.ax, c.bx) - c.r,
    minY: Math.min(c.ay, c.by) - c.r,
    maxX: Math.max(c.ax, c.bx) + c.r,
    maxY: Math.max(c.ay, c.by) + c.r,
  }
}

/** Index capsules into a uniform grid, each inserted into every cell its
 *  bounds (expanded by `pad`) touch, so a proximity query only has to look at
 *  co-located candidates. */
function buildGrid(capsules: Capsule[], cell: number, pad: number): Map<string, number[]> {
  const grid = new Map<string, number[]>()
  capsules.forEach((c, i) => {
    const b = capsuleBounds(c)
    const x0 = Math.floor((b.minX - pad) / cell)
    const x1 = Math.floor((b.maxX + pad) / cell)
    const y0 = Math.floor((b.minY - pad) / cell)
    const y1 = Math.floor((b.maxY + pad) / cell)
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        const k = `${x},${y}`
        const bucket = grid.get(k)
        if (bucket) bucket.push(i)
        else grid.set(k, [i])
      }
    }
  })
  return grid
}

// ─── Union-find (net grouping) ───────────────────────────────────────────────

class DisjointSet {
  private parent: Int32Array
  constructor(n: number) {
    this.parent = new Int32Array(n)
    for (let i = 0; i < n; i++) this.parent[i] = i
  }
  find(i: number): number {
    let root = i
    while (this.parent[root] !== root) root = this.parent[root]
    // Path compression.
    while (this.parent[i] !== root) {
      const next = this.parent[i]
      this.parent[i] = root
      i = next
    }
    return root
  }
  union(a: number, b: number): void {
    const ra = this.find(a)
    const rb = this.find(b)
    if (ra !== rb) this.parent[rb] = ra
  }
}

export interface SpacingComputation {
  /**
   * Smallest clearance among pairs that came within the checked window, or
   * null when no two different nets got within `minSpacingMm` of each other.
   *
   * This is deliberately NOT a global minimum gap: the spatial grid only
   * compares primitives already within the query radius, because the question
   * a DFM check answers is "is anything closer than the rule?" — not "what is
   * the closest approach anywhere on this board", which would cost far more to
   * compute. Callers must not present it as the latter; when it's null the
   * honest statement is "nothing closer than {rule}", not a specific number.
   */
  minClearanceMm: number | null
  violations: { x: number; y: number; clearanceMm: number }[]
  primitiveCount: number
  netCount: number
}

/**
 * Minimum clearance between primitives belonging to *different* nets.
 *
 * Net grouping is not optional: a track meets its own pad at distance 0, so
 * without first merging touching copper into nets every board would report
 * thousands of "violations". Two passes over the same grid — first union
 * everything that touches, then measure only across different nets.
 */
/**
 * Slack when deciding whether two primitives *touch* (and so belong to the same
 * net). Shapes that are meant to meet exactly — consecutive edges of a filled
 * region, a track meeting its pad — can land a hair apart from coordinate
 * quantisation (4.6-format Gerbers snap to 1e-6 mm) and from floating-point
 * rounding in the distance itself. Requiring a strictly non-positive distance
 * therefore leaves them in *different* nets, and every such joint is then
 * reported as a 0.0000mm clearance violation — which is what a real board did
 * before this tolerance existed.
 *
 * 0.1 µm is ~100× the quantisation step and ~900× below the tightest rule we
 * grade against (0.09 mm), so it cannot mask a genuine violation.
 */
const TOUCH_EPSILON_MM = 1e-4

export function computeSpacing(
  capsules: Capsule[],
  minSpacingMm: number,
  maxViolations = 200,
  regions: RegionRing[] = []
): SpacingComputation {
  const n = capsules.length
  if (n < 2) {
    return { minClearanceMm: null, violations: [], primitiveCount: n, netCount: n }
  }

  // Cell sized to the query radius so neighbours are always co-located.
  const cell = Math.max(minSpacingMm * 2, 0.05)
  const grid = buildGrid(capsules, cell, minSpacingMm)

  // Pass 1 — merge touching/overlapping primitives into nets.
  const ds = new DisjointSet(n)
  for (const bucket of grid.values()) {
    for (let i = 0; i < bucket.length; i++) {
      for (let j = i + 1; j < bucket.length; j++) {
        const a = bucket[i]
        const b = bucket[j]
        if (ds.find(a) === ds.find(b)) continue
        if (capsuleDistance(capsules[a], capsules[b]) <= TOUCH_EPSILON_MM) ds.union(a, b)
      }
    }
  }

  // Pass 1b — anything lying *inside* a filled region belongs to that region's
  // net. Boundary-only geometry can't see this: a pad flooded by the pour it
  // connects to never touches the outline, so without this it reads as a
  // separate net a few microns away — a clearance "violation" that isn't one.
  for (const region of regions) {
    const regionRoot = ds.find(region.first)
    for (let i = 0; i < n; i++) {
      // Skip the region's own outline segments.
      if (i >= region.first && i < region.first + region.count) continue
      const c = capsules[i]
      // Cheap bbox reject before the ray cast (region rings can be thousands
      // of points, and most primitives are nowhere near any given pour).
      const midX = (c.ax + c.bx) / 2
      const midY = (c.ay + c.by) / 2
      if (midX < region.minX || midX > region.maxX || midY < region.minY || midY > region.maxY) continue
      if (ds.find(i) === regionRoot) continue
      if (pointInRing(midX, midY, region.points)) ds.union(region.first, i)
    }
  }

  // Pass 2 — clearance between different nets only.
  let minClearanceMm: number | null = null
  // One entry per net pair — a tight run of parallel tracks would otherwise
  // emit hundreds of markers for what a person sees as a single problem. The
  // entry always holds that pair's *tightest* contact, so the marker points at
  // the worst spot rather than wherever the scan happened to hit first.
  const worstByNetPair = new Map<string, { x: number; y: number; clearanceMm: number }>()

  for (const bucket of grid.values()) {
    for (let i = 0; i < bucket.length; i++) {
      for (let j = i + 1; j < bucket.length; j++) {
        const a = bucket[i]
        const b = bucket[j]
        const na = ds.find(a)
        const nb = ds.find(b)
        if (na === nb) continue
        const d = capsuleDistance(capsules[a], capsules[b])
        if (minClearanceMm === null || d < minClearanceMm) minClearanceMm = d
        if (d >= minSpacingMm) continue

        const key = na < nb ? `${na}:${nb}` : `${nb}:${na}`
        const existing = worstByNetPair.get(key)
        if (existing && existing.clearanceMm <= d) continue
        if (!existing && worstByNetPair.size >= maxViolations) continue
        const m = closestMidpoint(capsules[a], capsules[b])
        worstByNetPair.set(key, { x: m.x, y: m.y, clearanceMm: d })
      }
    }
  }

  const roots = new Set<number>()
  for (let i = 0; i < n; i++) roots.add(ds.find(i))

  const violations = [...worstByNetPair.values()].sort((p, q) => p.clearanceMm - q.clearanceMm)
  return { minClearanceMm, violations, primitiveCount: n, netCount: roots.size }
}
