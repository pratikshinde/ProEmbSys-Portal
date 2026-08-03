/** Pure rectangle-packing primitives — no design/PCB semantics here. */

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export function rectArea(r: { w: number; h: number }): number {
  return r.w * r.h
}

export function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
}

/** True when `a` is fully inside (or equal to) `b`. */
export function rectContains(b: Rect, a: Rect): boolean {
  return a.x >= b.x && a.y >= b.y && a.x + a.w <= b.x + b.w && a.y + a.h <= b.y + b.h
}

/**
 * Smallest-bounding-box rectangular grid for `n` same-size cells (each
 * `cellW x cellH` with `gapX`/`gapY` between neighbours) — tries every column
 * count from 1..n and keeps whichever minimizes the resulting block's area,
 * breaking ties toward the most "square" layout. Used by the `block-grid`
 * packing strategy to size one design's own sub-grid.
 */
export function computeCompactGrid(
  n: number,
  cellW: number,
  cellH: number,
  gapX: number,
  gapY: number
): { rows: number; cols: number; blockW: number; blockH: number } {
  let best: { rows: number; cols: number; blockW: number; blockH: number } | null = null
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols)
    const blockW = cols * cellW + (cols - 1) * gapX
    const blockH = rows * cellH + (rows - 1) * gapY
    const area = blockW * blockH
    if (!best || area < best.blockW * best.blockH ||
        (area === best.blockW * best.blockH && Math.abs(rows - cols) < Math.abs(best.rows - best.cols))) {
      best = { rows, cols, blockW, blockH }
    }
  }
  // n <= 0 never reaches the loop — callers only ever pass n >= 1.
  return best!
}
