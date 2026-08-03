/**
 * The three generic rectangle-packing strategies (`block-grid` is special —
 * it groups by design first, so it lives in `pack.ts` where design identity
 * is available; it still calls `packShelf` here for its outer block layout).
 *
 * All three operate in already-inflated space: callers pass `w+gapX`/`h+gapY`
 * per item and `binW+gapX`/`binH+gapY` for the bin (see `pack.ts`'s "gap via
 * high-side inflation" — the returned `{x,y}` is used directly as the real
 * item's un-inflated low corner, so no de-inflation step is needed here).
 *
 * Every strategy tries requests strictly in the given order and SKIPS (leaves
 * `null`) any individual request it can't place, rather than aborting — a
 * later, smaller request may still fit even when an earlier one didn't.
 * Callers decide whether a `null` on a mandatory request makes the whole
 * candidate infeasible.
 */

import { rectContains, rectsOverlap, type Rect } from './geometry'

export interface PlaceRequest {
  w: number
  h: number
}

export interface PlacedPos {
  x: number
  y: number
}

/** Next-Fit Decreasing Height-style shelf packing — tidy rows, the simplest
 *  and most "obviously correct to a human" of the three. */
export function packShelf(requests: PlaceRequest[], binW: number, binH: number): (PlacedPos | null)[] {
  const results: (PlacedPos | null)[] = new Array(requests.length).fill(null)
  let shelfStarted = false
  let shelfY = 0
  let shelfH = 0
  let usedW = 0

  for (let i = 0; i < requests.length; i++) {
    const { w, h } = requests[i]
    if (w > binW || h > binH) continue

    if (shelfStarted && usedW + w <= binW && h <= shelfH) {
      results[i] = { x: usedW, y: shelfY }
      usedW += w
      continue
    }

    const newY = shelfStarted ? shelfY + shelfH : 0
    if (newY + h > binH) continue

    shelfY = newY
    shelfH = h
    usedW = w
    shelfStarted = true
    results[i] = { x: 0, y: shelfY }
  }

  return results
}

/**
 * Guillotine, best-area-fit: each placement splits its free rect into a
 * right remainder (same height as the item) and a top remainder (full
 * width) — a fixed split rule, not the shorter-leftover-axis heuristic some
 * implementations use, kept simple since correctness (no overlap, full
 * coverage) doesn't depend on which axis is split first.
 */
export function packGuillotine(requests: PlaceRequest[], binW: number, binH: number): (PlacedPos | null)[] {
  const results: (PlacedPos | null)[] = new Array(requests.length).fill(null)
  const free: Rect[] = [{ x: 0, y: 0, w: binW, h: binH }]

  for (let i = 0; i < requests.length; i++) {
    const { w, h } = requests[i]
    let bestIdx = -1
    let bestLeftover = Infinity
    for (let f = 0; f < free.length; f++) {
      const r = free[f]
      if (w <= r.w && h <= r.h) {
        const leftover = r.w * r.h - w * h
        if (leftover < bestLeftover) { bestLeftover = leftover; bestIdx = f }
      }
    }
    if (bestIdx === -1) continue

    const r = free[bestIdx]
    results[i] = { x: r.x, y: r.y }
    free.splice(bestIdx, 1)
    const rightW = r.w - w
    const topH = r.h - h
    if (rightW > 0) free.push({ x: r.x + w, y: r.y, w: rightW, h })
    if (topH > 0) free.push({ x: r.x, y: r.y + h, w: r.w, h: topH })
  }

  return results
}

/**
 * MAXRECTS best-short-side-fit (Jylänki) — the densest of the three. Free
 * rectangles are allowed to overlap each other (that's the technique's whole
 * point); every free rect touching a newly-placed item is split into its
 * uncovered remnants, then fully-contained remnants are pruned.
 */
export function packMaxRects(requests: PlaceRequest[], binW: number, binH: number): (PlacedPos | null)[] {
  const results: (PlacedPos | null)[] = new Array(requests.length).fill(null)
  let free: Rect[] = [{ x: 0, y: 0, w: binW, h: binH }]

  for (let i = 0; i < requests.length; i++) {
    const { w, h } = requests[i]
    let bestIdx = -1
    let bestShortSide = Infinity
    for (let f = 0; f < free.length; f++) {
      const r = free[f]
      if (w <= r.w && h <= r.h) {
        const shortSide = Math.min(r.w - w, r.h - h)
        if (shortSide < bestShortSide) { bestShortSide = shortSide; bestIdx = f }
      }
    }
    if (bestIdx === -1) continue

    const chosen = free[bestIdx]
    const placedRect: Rect = { x: chosen.x, y: chosen.y, w, h }
    results[i] = { x: placedRect.x, y: placedRect.y }

    const next: Rect[] = []
    for (const f of free) {
      if (!rectsOverlap(f, placedRect)) { next.push(f); continue }
      if (placedRect.x > f.x) next.push({ x: f.x, y: f.y, w: placedRect.x - f.x, h: f.h })
      if (placedRect.x + placedRect.w < f.x + f.w) {
        next.push({ x: placedRect.x + placedRect.w, y: f.y, w: f.x + f.w - (placedRect.x + placedRect.w), h: f.h })
      }
      if (placedRect.y > f.y) next.push({ x: f.x, y: f.y, w: f.w, h: placedRect.y - f.y })
      if (placedRect.y + placedRect.h < f.y + f.h) {
        next.push({ x: f.x, y: placedRect.y + placedRect.h, w: f.w, h: f.y + f.h - (placedRect.y + placedRect.h) })
      }
    }

    const pruned: Rect[] = []
    for (let a = 0; a < next.length; a++) {
      if (next[a].w <= 0 || next[a].h <= 0) continue
      let containedInAnother = false
      for (let b = 0; b < next.length; b++) {
        if (a === b || next[b].w <= 0 || next[b].h <= 0) continue
        if (rectContains(next[b], next[a])) { containedInAnother = true; break }
      }
      if (!containedInAnother) pruned.push(next[a])
    }
    free = pruned
  }

  return results
}
