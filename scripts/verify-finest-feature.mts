/**
 * Regression gate for `measureFinestFeature` (src/lib/aoi/plot-to-raster.ts),
 * on synthetic shapes whose true dimensions are known exactly:
 *
 *   npx tsx scripts/verify-finest-feature.mts
 *
 * Needs no database and no Gerber fixture, unlike verify-aoi-raster.mts.
 *
 * Exists because the first implementation was wrong in a way that LOOKED
 * right on a real board: it took the minimum run over every scan line, which
 * measures the tapering chords of any curved boundary rather than conductor
 * width. A solid 200 px disc reported a 1 px "finest feature", so the AOI
 * resolution warning fired at every resolution, each time asking for double
 * the current one. The disc cases below are the ones that catch it.
 */
import { measureFinestFeature } from '../src/lib/aoi/plot-to-raster'

const W = 600, H = 600
const blank = () => new Uint8Array(W * H)

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

function fillDisc(bm: Uint8Array, cx: number, cy: number, r: number): void {
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) bm[y * W + x] = 1
    }
  }
}

/** A solid disc: nothing in it is thinner than its diameter. */
function disc(r: number): Uint8Array {
  const bm = blank()
  fillDisc(bm, W / 2, H / 2, r)
  return bm
}

/** Axis-aligned vertical bar, w px wide — an unambiguous thin conductor. */
function bar(w: number): Uint8Array {
  const bm = blank()
  for (let y = 50; y < H - 50; y++) for (let x = 300; x < 300 + w; x++) bm[y * W + x] = 1
  return bm
}

/** Two pads joined by a thin neck — the constriction that actually matters. */
function dumbbell(neckW: number): Uint8Array {
  const bm = blank()
  fillDisc(bm, 300, 180, 60)
  fillDisc(bm, 300, 420, 60)
  const x0 = 300 - Math.floor(neckW / 2)
  for (let y = 180; y < 420; y++) for (let x = x0; x < x0 + neckW; x++) bm[y * W + x] = 1
  return bm
}

/** Two parallel bars separated by a thin gap. */
function gapPair(gapW: number): Uint8Array {
  const bm = blank()
  for (let y = 50; y < H - 50; y++) {
    for (let x = 200; x < 290; x++) bm[y * W + x] = 1
    for (let x = 290 + gapW; x < 400; x++) bm[y * W + x] = 1
  }
  return bm
}

// A disc of radius r spans 2r+1 px. Allow a few px of slack: within the
// sustain band the chord barely changes near the equator, so a slightly
// off-equator plateau can win. Immaterial at these magnitudes — what must
// never happen again is a large pad reporting single-digit pixels.
for (const r of [100, 40]) {
  const { minCopperPx } = measureFinestFeature(disc(r), W, H)
  const trueWidth = 2 * r + 1
  check(`disc r=${r}: measured as a wide pad, not a 1 px taper chord`,
    minCopperPx >= trueWidth - 8 && minCopperPx <= trueWidth,
    `${minCopperPx} px (true ${trueWidth} px)`)
}

for (const w of [1, 6, 15]) {
  const { minCopperPx } = measureFinestFeature(bar(w), W, H)
  check(`vertical bar ${w} px wide measures exactly`, minCopperPx === w, `${minCopperPx} px`)
}

for (const w of [2, 9]) {
  const { minCopperPx } = measureFinestFeature(dumbbell(w), W, H)
  check(`${w} px neck between two pads measures exactly`, minCopperPx === w, `${minCopperPx} px`)
}

for (const g of [1, 7]) {
  const { minGapPx } = measureFinestFeature(gapPair(g), W, H)
  check(`${g} px gap between two bars measures exactly`, minGapPx === g, `${minGapPx} px`)
}

console.log(failures === 0 ? '\nAll oracles passed.' : `\n${failures} oracle(s) FAILED.`)
process.exit(failures === 0 ? 0 : 1)
