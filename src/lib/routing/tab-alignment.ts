/**
 * Cross-placement break-away tab alignment.
 *
 * When two PCB placements sit directly across a gap from each other, their
 * tabs on the facing edges should land at the same world-space position —
 * otherwise a shop breaking one board's tab has nothing lined up on its
 * neighbour, and (worse) the panel photographs as visibly inconsistent.
 * Nothing elsewhere in the routing engine deliberately does this: the only
 * existing cross-PCB machinery (`extraSilentDs` in contour mode, the bbox
 * branch's own Phase 2 foreign-tab fold-in) is purely REACTIVE — it avoids
 * re-cutting a tab that already happens to coincide, it never forces two
 * PCBs' tabs to coincide. A uniform single-design grid panel "works" today
 * only because `evenTabCenters` produces identical output for identical
 * edge length + position — coincidence, not design. Confirmed broken on a
 * real fabricated panel: a rounded (contour-mode) board's single bottom-edge
 * tab landed nowhere near either rectangular board's own top-edge tabs.
 *
 * This module only DETECTS facing placement pairs and converts between a
 * placement's own edge-local coordinate ("dGlobal", see plan-routing.ts's
 * own convention comment) and world space. It does not decide who's the
 * anchor or mutate any tab list — that reconciliation lives in
 * `plan-routing.ts`, which is the only place that already has both sides'
 * real tab data in scope.
 *
 * Pure functions only: no store, no React, no I/O — same discipline as
 * `geometry.ts`/`offset.ts`.
 */

import type { Pt } from './types'

export type FacingAxis = 'x' | 'y'
export type FacingSide = 'left' | 'right' | 'top' | 'bottom'

export interface FacingPlacement {
  pos: { x: number; y: number; w: number; h: number }
  pcbIndex: number
}

export interface FacingPair {
  aIndex: number
  bIndex: number
  /** 'x' = the gap runs along X (vertical facing edges: A's right vs B's left).
   *  'y' = the gap runs along Y (horizontal facing edges: A's top vs B's bottom). */
  axis: FacingAxis
  aSide: FacingSide
  bSide: FacingSide
  /** World coordinate range on the PERPENDICULAR axis where the two edges
   *  actually run alongside each other — world Y for axis='x', world X for
   *  axis='y'. Only tabs within this window can ever be aligned; anything
   *  outside it isn't physically facing the other board at all. */
  overlapStart: number
  overlapEnd: number
  gapMm: number
}

/** Comfortably above any realistic gap/rib configuration in this tool
 *  (typical gapX/gapY is 0.5-10mm; packed-panel per-item gaps are similar)
 *  but small enough that two placements on opposite sides of a wide panel
 *  are never mistaken for facing each other. */
const DEFAULT_MAX_FACING_GAP_MM = 20

/**
 * Geometric (AABB) adjacency detection between placements — works uniformly
 * for bbox and contour placements alike, since every `PanelPlacement` (grid
 * or packed) carries `x/y/w/h` regardless of how it ultimately routes.
 *
 * `minOverlapMm` should be at least `pathGap` (tabWidth + bit) — a corner-
 * only sliver of overlap isn't wide enough to ever host an aligned tab, and
 * would otherwise register as a spurious facing pair.
 */
export function findFacingPairs(
  placements: FacingPlacement[],
  minOverlapMm: number,
  maxGapMm: number = DEFAULT_MAX_FACING_GAP_MM
): FacingPair[] {
  const pairs: FacingPair[] = []

  // A third placement sitting physically inside the gap strip between two
  // candidates means they aren't really facing each other — e.g. three
  // boards in a row, A and C aren't "facing" just because their combined
  // gap-plus-B's-width happens to be under maxGapMm. Checked against every
  // OTHER placement's own bbox, not just the two candidates.
  function isObstructed(strip: { xMin: number; xMax: number; yMin: number; yMax: number }, excludeA: number, excludeB: number): boolean {
    for (const p of placements) {
      if (p.pcbIndex === excludeA || p.pcbIndex === excludeB) continue
      const overlapsX = p.pos.x < strip.xMax && p.pos.x + p.pos.w > strip.xMin
      const overlapsY = p.pos.y < strip.yMax && p.pos.y + p.pos.h > strip.yMin
      if (overlapsX && overlapsY) return true
    }
    return false
  }

  for (let i = 0; i < placements.length; i++) {
    for (let j = i + 1; j < placements.length; j++) {
      const A = placements[i]
      const B = placements[j]

      // Vertical facing edges (gap along X): A's right edge vs B's left edge,
      // or vice versa. Requires Y-range overlap to actually run alongside.
      const overlapY = Math.min(A.pos.y + A.pos.h, B.pos.y + B.pos.h) - Math.max(A.pos.y, B.pos.y)
      if (overlapY >= minOverlapMm) {
        const oyMin = Math.max(A.pos.y, B.pos.y)
        const oyMax = Math.min(A.pos.y + A.pos.h, B.pos.y + B.pos.h)
        const gapAtoB = B.pos.x - (A.pos.x + A.pos.w)
        const gapBtoA = A.pos.x - (B.pos.x + B.pos.w)
        if (gapAtoB >= 0 && gapAtoB <= maxGapMm && !isObstructed({ xMin: A.pos.x + A.pos.w, xMax: B.pos.x, yMin: oyMin, yMax: oyMax }, A.pcbIndex, B.pcbIndex)) {
          pairs.push({
            aIndex: A.pcbIndex, bIndex: B.pcbIndex, axis: 'x', aSide: 'right', bSide: 'left',
            overlapStart: oyMin, overlapEnd: oyMax, gapMm: gapAtoB,
          })
        } else if (gapBtoA >= 0 && gapBtoA <= maxGapMm && !isObstructed({ xMin: B.pos.x + B.pos.w, xMax: A.pos.x, yMin: oyMin, yMax: oyMax }, A.pcbIndex, B.pcbIndex)) {
          pairs.push({
            aIndex: B.pcbIndex, bIndex: A.pcbIndex, axis: 'x', aSide: 'right', bSide: 'left',
            overlapStart: oyMin, overlapEnd: oyMax, gapMm: gapBtoA,
          })
        }
      }

      // Horizontal facing edges (gap along Y): A's top edge vs B's bottom
      // edge, or vice versa. Requires X-range overlap.
      const overlapX = Math.min(A.pos.x + A.pos.w, B.pos.x + B.pos.w) - Math.max(A.pos.x, B.pos.x)
      if (overlapX >= minOverlapMm) {
        const oxMin = Math.max(A.pos.x, B.pos.x)
        const oxMax = Math.min(A.pos.x + A.pos.w, B.pos.x + B.pos.w)
        const gapAtoB = B.pos.y - (A.pos.y + A.pos.h)
        const gapBtoA = A.pos.y - (B.pos.y + B.pos.h)
        if (gapAtoB >= 0 && gapAtoB <= maxGapMm && !isObstructed({ xMin: oxMin, xMax: oxMax, yMin: A.pos.y + A.pos.h, yMax: B.pos.y }, A.pcbIndex, B.pcbIndex)) {
          pairs.push({
            aIndex: A.pcbIndex, bIndex: B.pcbIndex, axis: 'y', aSide: 'top', bSide: 'bottom',
            overlapStart: oxMin, overlapEnd: oxMax, gapMm: gapAtoB,
          })
        } else if (gapBtoA >= 0 && gapBtoA <= maxGapMm && !isObstructed({ xMin: oxMin, xMax: oxMax, yMin: B.pos.y + B.pos.h, yMax: A.pos.y }, A.pcbIndex, B.pcbIndex)) {
          pairs.push({
            aIndex: B.pcbIndex, bIndex: A.pcbIndex, axis: 'y', aSide: 'top', bSide: 'bottom',
            overlapStart: oxMin, overlapEnd: oxMax, gapMm: gapBtoA,
          })
        }
      }
    }
  }

  // Stable order: by (min index, max index) — deterministic regardless of
  // placement array order, and independent of which side of a pair happened
  // to be discovered as A vs B above.
  pairs.sort((p, q) => {
    const pMin = Math.min(p.aIndex, p.bIndex), qMin = Math.min(q.aIndex, q.bIndex)
    if (pMin !== qMin) return pMin - qMin
    return Math.max(p.aIndex, p.bIndex) - Math.max(q.aIndex, q.bIndex)
  })
  return pairs
}

/**
 * A placement's own edge-local "dGlobal" distance is, by construction
 * (see plan-routing.ts's `isReversedEdge` convention), already measured
 * left-to-right for horizontal edges and bottom-to-top for vertical edges —
 * i.e. already axis-aligned with world space. No reversal correction is
 * needed here; that correction only applies when converting dGlobal to the
 * raw a→b `rectEdges` walk direction, which is plan-routing.ts's own concern.
 *
 * ⚠ dGlobal is measured along the OFFSET TOOL-PATH edge (`offsetRectOutward`
 * grows the board rect outward by the bit radius `r` on every side), NOT
 * along the true board edge — so dGlobal=0 corresponds to a world point `r`
 * mm BEFORE the true edge's own corner (see `boardEdgePoint`'s own
 * `d = dAlongToolPath - r` conversion in plan-routing.ts). A `RouteTab`'s
 * `.center`, by contrast, is deliberately on the TRUE board edge (pulled
 * back inward by `r`, both in bbox mode's `boardEdgePoint` and contour
 * mode's `planContourPcb`). Converting between a real tab's world position
 * and a `centersAlong`-style dGlobal value therefore needs the `+ r` (or
 * `- r`) correction below — confirmed live via a synthetic-panel headless
 * test: omitting it landed an "aligned" tab exactly `r` mm away from the
 * real anchor tab it was supposed to match.
 */
export function worldPointToDGlobal(pos: { x: number; y: number }, edge: FacingSide, worldPt: Pt, r: number): number {
  const trueEdgeCoord = edge === 'left' || edge === 'right' ? worldPt.y - pos.y : worldPt.x - pos.x
  return trueEdgeCoord + r
}

export function dGlobalToWorldCoord(pos: { x: number; y: number }, edge: FacingSide, dGlobal: number, r: number): number {
  const origin = edge === 'left' || edge === 'right' ? pos.y : pos.x
  return origin + dGlobal - r
}

/** Inverse of `dGlobalToWorldCoord`, for callers that already have a bare
 *  perpendicular-axis world coordinate (not a full `Pt`) — e.g. converting
 *  one placement's own tab position into a facing neighbour's edge frame,
 *  where both edges' perpendicular coordinate is the same axis by
 *  definition (that's what makes them "facing" in the first place). */
export function worldCoordToDGlobal(pos: { x: number; y: number }, edge: FacingSide, worldCoord: number, r: number): number {
  const trueEdgeCoord = edge === 'left' || edge === 'right' ? worldCoord - pos.y : worldCoord - pos.x
  return trueEdgeCoord + r
}
