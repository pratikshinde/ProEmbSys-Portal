/**
 * Headless correctness gate for the AOI rasteriser (plan P2) — run BEFORE
 * any UI exists, against real customer artwork rather than a synthetic
 * fixture:
 *
 *   npx tsx scripts/verify-aoi-raster.mts
 *
 * Pulls the `WLC INDICATOR` CAM job straight out of the dev database,
 * reproduces the real export pipeline (parse -> computePanel ->
 * generatePanelizedGerber), rasterises it through the exact same
 * `gerberToAoiBitmap` the worker will call, and asserts a set of oracles.
 * `@napi-rs/canvas` is Skia-backed — the same rasteriser family as Chrome —
 * so the sink under test runs completely unmodified here.
 *
 * Writes the PNGs to scripts/out/ for visual comparison against a known-good
 * render of the same board.
 */
import { createCanvas } from '@napi-rs/canvas'
import { PrismaClient } from '@prisma/client'
import { mkdirSync, writeFileSync } from 'node:fs'

import { readCamJobFile } from '../src/lib/cam-job-files'
import { parseGerber, parseExcellonDrill } from '../src/lib/gerber-parser'
import { computePanel, generatePanelizedGerber, resolveDesignGeometry } from '../src/lib/panelization-engine'
import { collectPanelizedDrillHoles, collectPanelizedDrillSlots } from '../src/lib/gerber-exporter'
import { gerberToAoiBitmap, drillMaskBitmap, type AoiCanvas } from '../src/lib/aoi/gerber-to-aoi'
import { measureFinestFeature } from '../src/lib/aoi/plot-to-raster'
import { encodeBinaryPng } from '../src/lib/aoi/png-encode'
import { mmToPx } from '../src/lib/aoi/types'

const JOB_ID = 'cmtu65eyb0001wt9k426g1nc7'
const OUT_DIR = 'scripts/out'

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

/** @napi-rs/canvas as an AoiCanvas. The browser worker will supply the
 *  OffscreenCanvas equivalent; nothing else differs. */
function nodeCanvasFactory(widthPx: number, heightPx: number): AoiCanvas {
  const canvas = createCanvas(widthPx, heightPx)
  const ctx = canvas.getContext('2d')
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ctx: ctx as any,
    readPixels: () => ctx.getImageData(0, 0, widthPx, heightPx).data,
    dispose: () => { canvas.width = 0 },
  }
}

const db = new PrismaClient()
const job = await db.camJob.findUnique({ where: { id: JOB_ID } })
if (!job) { console.error(`Job ${JOB_ID} not found in this database.`); process.exit(1) }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const config = job.config as any
const panelConfig = config.panelConfig
const panelInfo = config.panelInfo

// --- Reproduce the real export pipeline -----------------------------------
const wanted = ['copper', 'outline', 'drill']
const layers = []
for (const meta of config.files) {
  if (!wanted.includes(meta.type)) continue
  const content = await readCamJobFile(job.id, meta.layerFileId)
  const parsedLayer = meta.type === 'drill'
    ? parseExcellonDrill(content, meta.fileName)
    : parseGerber(content, meta.fileName)
  layers.push({ ...meta, rawContent: content, parsedLayer })
}
await db.$disconnect()

const geometry = resolveDesignGeometry(layers)
if (!geometry) { console.error('No usable geometry'); process.exit(1) }
const panel = computePanel(geometry.widthMm, geometry.heightMm, panelConfig, panelInfo)
console.log(`\nPanel ${panel.panelWidth.toFixed(1)} x ${panel.panelHeight.toFixed(1)} mm, ${panel.placements.length} placements, ` +
  `${panel.fiducials.length} fiducials, ${panel.toolingHoles.length} holes\n`)

const topCu = layers.find(l => l.type === 'copper' && l.side === 'top')!
const panelized = generatePanelizedGerber(
  topCu.parsedLayer, topCu.rawContent, panel, panelConfig, undefined, geometry.datum, 'copper', 'top'
)

// --- Rasterise -------------------------------------------------------------
const K = 20
const run = (side: 'top' | 'bottom', pxPerMm: number) =>
  gerberToAoiBitmap({
    content: panelized, side, pxPerMm,
    panelWidthMm: panel.panelWidth, panelHeightMm: panel.panelHeight,
    layerLabel: `${side}_Copper`, createCanvas: nodeCanvasFactory,
  })

const top = run('top', K)
if (!top.bitmap) { console.error('Top raster failed:', top.warnings); process.exit(1) }
console.log(`Rasterised ${top.widthPx} x ${top.heightPx} px at ${K} px/mm`)
for (const w of top.warnings) console.log(`  warning: ${w}`)

// The finest-feature metric must describe GEOMETRY, not the raster grid: a
// real feature has a fixed size in mm, so doubling the resolution must roughly
// double its pixel measurement. The first version of measureFinestFeature
// failed exactly here — it returned 1 px at every resolution (a round pad's
// topmost row is a 1 px run), so the warning fired forever, each time asking
// for double the resolution. See that function's own header.
// (80 px/mm would be 258 MP — over AOI_MAX_CANVAS_PX — so the pair is 20/40.)
{
  const measureAt = (k: number) => {
    const r = run('top', k)
    if (!r.bitmap) { console.error(`raster at ${k} px/mm failed:`, r.warnings); process.exit(1) }
    const t0 = Date.now()
    const m = measureFinestFeature(r.bitmap, r.widthPx, r.heightPx)
    return { ...m, ms: Date.now() - t0, finestMm: Math.min(m.minCopperPx, m.minGapPx) / k }
  }
  const a = measureAt(20)
  const b = measureAt(40)
  console.log(`\nFinest feature: copper ${a.minCopperPx}px / gap ${a.minGapPx}px at 20 px/mm (${a.finestMm.toFixed(4)} mm, measured in ${a.ms} ms)`)
  console.log(`                copper ${b.minCopperPx}px / gap ${b.minGapPx}px at 40 px/mm (${b.finestMm.toFixed(4)} mm, measured in ${b.ms} ms)`)
  // Copper width is the scale-invariant one, and the real regression test: a
  // conductor has a fixed size in mm, so its pixel measurement must roughly
  // double with the resolution. The naive scan returned 1 px at BOTH.
  const cuA = a.minCopperPx / 20, cuB = b.minCopperPx / 40
  check('copper width is a fixed physical size, not a pixel-grid artifact',
    Math.abs(cuA - cuB) / Math.max(cuA, cuB) < 0.35, `${cuA.toFixed(4)} mm vs ${cuB.toFixed(4)} mm`)
  check('finest feature is not the 1 px artifact the naive scan returned',
    b.minCopperPx > 1 && b.minGapPx > 1, `copper ${b.minCopperPx} px, gap ${b.minGapPx} px`)
  check('measurement cost is acceptable for an interactive generate', b.ms < 3000, `${b.ms} ms at 40 px/mm`)
  // Gaps deliberately are NOT asserted scale-invariant: this board's 0.05 mm
  // clearance survives as 2 px at 40 px/mm but closes entirely at 20 px/mm
  // (1 px of antialiased gap thresholds to copper), so the 20 px/mm raster
  // reports a larger "finest gap" because the real finest gap is GONE from it.
  // Measuring the output cannot see what the output lost — a real limit of
  // this metric, documented on measureFinestFeature itself.
  console.log(`                (gap ${a.minGapPx}px@20 vs ${b.minGapPx}px@40 — the 0.05 mm clearance closes up at 20 px/mm)`)
}

const coverage = (bm: Uint8Array) => bm.reduce((n, v) => n + v, 0) / bm.length

// --- Oracles ---------------------------------------------------------------
check('binarity: every pixel is 0 or 1', top.bitmap.every(v => v === 0 || v === 1))

// Upper bound is deliberately generous: this board has a ground pour (232
// G36 regions in the source), so most of the panel legitimately IS copper.
// Only a near-0% or near-100% result would indicate a polarity/scale fault.
const cov = coverage(top.bitmap)
check('coverage is plausible for a copper layer', cov > 0.03 && cov < 0.90, `${(cov * 100).toFixed(1)}% copper`)

// Mirror identity: the bottom-side transform must be an exact horizontal
// reflection of the top-side one. Catches a wrong mirror axis or an
// off-by-one in the W - k*x term.
const mirrored = run('bottom', K)
if (!mirrored.bitmap) { console.error('Bottom raster failed:', mirrored.warnings); process.exit(1) }
// Mirroring the TRANSFORM (rather than flipping pixels afterwards) means the
// two rasters sample the geometry on grids that are reflections of each
// other, so a feature edge landing exactly on a pixel boundary can round to
// opposite sides. Those flips are legitimate and confined to edges; a wrong
// mirror axis or an off-by-one in `W - k*x` would instead displace whole
// features, producing mismatches in the INTERIOR of solid areas. So assert
// both that the count is negligible AND that every mismatch sits on an edge.
let mirrorMismatch = 0
let interiorMismatch = 0
const at = (bm: Uint8Array, x: number, y: number) =>
  x < 0 || y < 0 || x >= top.widthPx || y >= top.heightPx ? -1 : bm[y * top.widthPx + x]
for (let y = 0; y < top.heightPx; y++) {
  for (let x = 0; x < top.widthPx; x++) {
    const v = top.bitmap[y * top.widthPx + x]
    if (v === mirrored.bitmap[y * top.widthPx + (top.widthPx - 1 - x)]) continue
    mirrorMismatch++
    const onEdge = [at(top.bitmap, x - 1, y), at(top.bitmap, x + 1, y), at(top.bitmap, x, y - 1), at(top.bitmap, x, y + 1)]
      .some(n => n !== -1 && n !== v)
    if (!onEdge) interiorMismatch++
  }
}
const mismatchPct = (mirrorMismatch / top.bitmap.length) * 100
check('mirror identity: differences are negligible', mismatchPct < 0.05, `${mirrorMismatch} px (${mismatchPct.toFixed(4)}%)`)
check('mirror identity: no interior (non-edge) displacement', interiorMismatch === 0, `${interiorMismatch} interior px`)

// Scale invariance: copper coverage must not depend on resolution. A Y-flip
// or transform error usually shows up here as a large divergence.
const half = run('top', K / 2)
if (half.bitmap) {
  const covHalf = coverage(half.bitmap)
  check('scale invariance: coverage stable at half resolution', Math.abs(covHalf - cov) < 0.015,
    `${(cov * 100).toFixed(1)}% vs ${(covHalf * 100).toFixed(1)}%`)
}

// Fiducial probe — the sharpest test of the Y-sign. Fiducials are emitted as
// SOLID COPPER DOTS on copper layers (panelization-engine.ts:3189 picks
// fiducialDiameter for copper, fiducialClearance only for mask), and they
// sit in otherwise-empty rib space. So: copper at the centre, substrate a
// short distance away. On a Y-flip error the centre lands in blank rib and
// this fails loudly.
let fidHit = 0
let fidClear = 0
for (const f of panel.fiducials) {
  const [px, py] = mmToPx('top', f.x, f.y, K, top.widthPx, top.heightPx)
  const ix = Math.round(px), iy = Math.round(py)
  if (top.bitmap[iy * top.widthPx + ix] === 1) fidHit++
  // Just outside the copper dot but inside the mask clearance ring.
  const outX = Math.round(px + (f.diameter / 2 + 0.4) * K)
  if (outX < top.widthPx && top.bitmap[iy * top.widthPx + outX] === 0) fidClear++
}
check('fiducial probe: centre is copper', fidHit === panel.fiducials.length, `${fidHit}/${panel.fiducials.length}`)
check('fiducial probe: surrounded by substrate', fidClear === panel.fiducials.length, `${fidClear}/${panel.fiducials.length}`)

// --- Drill mask ------------------------------------------------------------
// Same collection path the store uses (collectAllDesignsDrillHoles is just
// this per design, merged) plus the panel's own tooling/reference holes.
const drillLayers = layers.filter(l => l.type === 'drill' && l.parsedLayer?.bounds)
const holeGroups = collectPanelizedDrillHoles(drillLayers, panel, geometry.datum)
const slotGroups = collectPanelizedDrillSlots(drillLayers, panel, geometry.datum)
if (panelConfig.enableToolingHoles) {
  const byDia = new Map<number, { x: number; y: number }[]>()
  for (const h of panel.toolingHoles) {
    if (!byDia.has(h.diameter)) byDia.set(h.diameter, [])
    byDia.get(h.diameter)!.push({ x: h.x, y: h.y })
  }
  for (const [diameterMm, holes] of byDia) {
    const existing = holeGroups.find(g => g.diameterMm === diameterMm)
    if (existing) existing.holes.push(...holes)
    else holeGroups.push({ diameterMm, holes })
  }
}
const componentHoleCount = collectPanelizedDrillHoles(drillLayers, panel, geometry.datum)
  .reduce((n, g) => n + g.holes.length, 0)
const totalHoles = holeGroups.reduce((n, g) => n + g.holes.length, 0)
console.log(`\nDrill: ${componentHoleCount} component holes + ${totalHoles - componentHoleCount} tooling/reference, ` +
  `${slotGroups.reduce((n, g) => n + g.slots.length, 0)} slots, across ${holeGroups.length} diameters`)

const runDrill = (side: 'top' | 'bottom') =>
  drillMaskBitmap({
    holeGroups, slotGroups, side, pxPerMm: K,
    panelWidthMm: panel.panelWidth, panelHeightMm: panel.panelHeight,
    layerLabel: `${side}_Drill`, createCanvas: nodeCanvasFactory,
  })

const drillTop = runDrill('top')
if (!drillTop.bitmap) { console.error('Top drill mask failed:', drillTop.warnings); process.exit(1) }
for (const w of drillTop.warnings) console.log(`  warning: ${w}`)

check('drill mask: binary', drillTop.bitmap.every(v => v === 0 || v === 1))
check('drill mask: identical dimensions to the copper raster',
  drillTop.widthPx === top.widthPx && drillTop.heightPx === top.heightPx,
  `${drillTop.widthPx}x${drillTop.heightPx} vs ${top.widthPx}x${top.heightPx}`)

// Sparse but non-empty: holes cover a small fraction of a panel. A near-0%
// result means the geometry never landed; a large one means a scale fault.
const drillCov = coverage(drillTop.bitmap)
check('drill mask: coverage is sparse but non-zero', drillCov > 0.0001 && drillCov < 0.10,
  `${(drillCov * 100).toFixed(3)}% hole`)

// Every collected hole centre must be ink, on BOTH sides — the mask is
// useless if it lands anywhere but on the real holes. This is also the
// sharpest check of the Y-sign and the mirror for this raster.
for (const side of ['top', 'bottom'] as const) {
  const mask = side === 'top' ? drillTop : runDrill(side)
  if (!mask.bitmap) { check(`drill mask: ${side} rendered`, false); continue }
  let hit = 0, n = 0
  for (const g of holeGroups) {
    for (const h of g.holes) {
      n++
      const [px, py] = mmToPx(side, h.x, h.y, K, mask.widthPx, mask.heightPx)
      const ix = Math.round(px), iy = Math.round(py)
      if (ix >= 0 && iy >= 0 && ix < mask.widthPx && iy < mask.heightPx && mask.bitmap[iy * mask.widthPx + ix] === 1) hit++
    }
  }
  check(`drill mask: every hole centre is ink (${side})`, hit === n, `${hit}/${n}`)
}

// The reason this mask exists: a drilled pad is solid copper in the copper
// raster, so the inspection app would read the hole as missing copper unless
// it subtracts this. Confirm the overlap actually exists on component holes
// (tooling/reference holes sit in bare rib and legitimately have no copper).
let padHoles = 0, padHolesCovered = 0
for (const g of collectPanelizedDrillHoles(drillLayers, panel, geometry.datum)) {
  for (const h of g.holes) {
    const [px, py] = mmToPx('top', h.x, h.y, K, top.widthPx, top.heightPx)
    const ix = Math.round(px), iy = Math.round(py)
    if (ix < 0 || iy < 0 || ix >= top.widthPx || iy >= top.heightPx) continue
    if (top.bitmap[iy * top.widthPx + ix] !== 1) continue // not on a pad — via in a gap, NPTH, etc.
    padHoles++
    if (drillTop.bitmap[iy * top.widthPx + ix] === 1) padHolesCovered++
  }
}
check('drill mask: covers every hole that reads as copper in the copper raster',
  padHoles > 0 && padHolesCovered === padHoles, `${padHolesCovered}/${padHoles}`)

// --- Punched copper --------------------------------------------------------
// This is the feature the real bug report was about: the copper raster
// itself must already show donuts (a ring of copper around a
// substrate-coloured hole), not solid discs — a real photographed board
// never shows solid discs at a plated hole. Re-rasterise WITH holeGroups/
// slotGroups and diff against the already-computed unpunched `top`/
// `mirrored` rasters above.
const topPunched = gerberToAoiBitmap({
  content: panelized, side: 'top', pxPerMm: K,
  panelWidthMm: panel.panelWidth, panelHeightMm: panel.panelHeight,
  layerLabel: 'top_Copper', holeGroups, slotGroups, createCanvas: nodeCanvasFactory,
})
if (!topPunched.bitmap) { console.error('Punched top raster failed:', topPunched.warnings); process.exit(1) }

check('punched copper: binary', topPunched.bitmap.every(v => v === 0 || v === 1))
check('punched copper: identical dimensions to the unpunched raster',
  topPunched.widthPx === top.widthPx && topPunched.heightPx === top.heightPx,
  `${topPunched.widthPx}x${topPunched.heightPx} vs ${top.widthPx}x${top.heightPx}`)

const punchedCov = coverage(topPunched.bitmap)
check('punched copper: coverage decreased (holes removed material)', punchedCov < cov,
  `${(cov * 100).toFixed(2)}% -> ${(punchedCov * 100).toFixed(2)}%`)

// Every hole that sat on real copper (the same `padHoles` set identified
// above) must now read SUBSTRATE at its exact centre.
let padHolesPunched = 0
for (const g of collectPanelizedDrillHoles(drillLayers, panel, geometry.datum)) {
  for (const h of g.holes) {
    const [px, py] = mmToPx('top', h.x, h.y, K, top.widthPx, top.heightPx)
    const ix = Math.round(px), iy = Math.round(py)
    if (ix < 0 || iy < 0 || ix >= top.widthPx || iy >= top.heightPx) continue
    if (top.bitmap[iy * top.widthPx + ix] !== 1) continue // wasn't on a pad to begin with
    if (topPunched.bitmap[iy * top.widthPx + ix] === 0) padHolesPunched++
  }
}
check('punched copper: every hole that sat on a pad now reads substrate at its centre',
  padHoles > 0 && padHolesPunched === padHoles, `${padHolesPunched}/${padHoles}`)

// The ring must survive too — punching removes the hole, not the whole pad.
// Sample a point a few px beyond each hole's own radius, in device space; if
// that point was on copper before punching, it should still be copper after
// (this is a donut, not just a bigger hole).
let ringSample = 0
let ringSurvived = 0
for (const g of collectPanelizedDrillHoles(drillLayers, panel, geometry.datum)) {
  const offsetPx = Math.max(2, Math.round((g.diameterMm / 2) * K) + 3)
  for (const h of g.holes) {
    const [px, py] = mmToPx('top', h.x, h.y, K, top.widthPx, top.heightPx)
    const ix = Math.round(px) + offsetPx
    const iy = Math.round(py)
    if (ix < 0 || iy < 0 || ix >= top.widthPx || iy >= top.heightPx) continue
    if (top.bitmap[iy * top.widthPx + ix] !== 1) continue // wasn't on copper at that offset either
    ringSample++
    if (topPunched.bitmap[iy * top.widthPx + ix] === 1) ringSurvived++
  }
}
check('punched copper: the copper ring around each hole survives (donut, not just a bigger hole)',
  ringSample > 0 && ringSurvived / ringSample > 0.9, `${ringSurvived}/${ringSample}`)

// Mirror side too — same donut behaviour must hold under the bottom-side
// mirrored transform, not just top.
const bottomPunched = gerberToAoiBitmap({
  content: panelized, side: 'bottom', pxPerMm: K,
  panelWidthMm: panel.panelWidth, panelHeightMm: panel.panelHeight,
  layerLabel: 'bottom_Copper', holeGroups, slotGroups, createCanvas: nodeCanvasFactory,
})
if (bottomPunched.bitmap) {
  let botPadHoles = 0
  let botPadHolesPunched = 0
  for (const g of collectPanelizedDrillHoles(drillLayers, panel, geometry.datum)) {
    for (const h of g.holes) {
      const [px, py] = mmToPx('bottom', h.x, h.y, K, mirrored.widthPx, mirrored.heightPx)
      const ix = Math.round(px), iy = Math.round(py)
      if (ix < 0 || iy < 0 || ix >= mirrored.widthPx || iy >= mirrored.heightPx) continue
      if (mirrored.bitmap[iy * mirrored.widthPx + ix] !== 1) continue
      botPadHoles++
      if (bottomPunched.bitmap[iy * mirrored.widthPx + ix] === 0) botPadHolesPunched++
    }
  }
  check('punched copper: bottom (mirrored) side punches holes correctly too',
    botPadHoles > 0 && botPadHolesPunched === botPadHoles, `${botPadHolesPunched}/${botPadHoles}`)
} else {
  check('punched copper: bottom (mirrored) side rendered', false, JSON.stringify(bottomPunched.warnings))
}

// Omitting holeGroups/slotGroups entirely must be a byte-identical no-op —
// the punch step is conditionally skipped, not defaulted to an empty-array
// punch that happens to draw nothing. `top` above was rasterised with no
// holeGroups passed at all, so re-rasterising the same way must match it.
const topUnpunchedAgain = gerberToAoiBitmap({
  content: panelized, side: 'top', pxPerMm: K,
  panelWidthMm: panel.panelWidth, panelHeightMm: panel.panelHeight,
  layerLabel: 'top_Copper', createCanvas: nodeCanvasFactory,
})
let noOpMismatch = 0
if (topUnpunchedAgain.bitmap) {
  for (let i = 0; i < topUnpunchedAgain.bitmap.length; i++) {
    if (topUnpunchedAgain.bitmap[i] !== top.bitmap[i]) { noOpMismatch++; break }
  }
}
check('punched copper: omitting holeGroups/slotGroups is a byte-identical no-op',
  !!topUnpunchedAgain.bitmap && noOpMismatch === 0, 'compared against the unpunched raster above')

// A blank mask must never SHIP. Reproduces the real failure mode: holes are
// submitted (so the draw-call counter is satisfied and stays quiet) but none
// of them land, which once produced a 100%-black Top_Drill.png carrying an
// empty "warnings" array in its own manifest.
{
  const offPanel = drillMaskBitmap({
    holeGroups: [{ diameterMm: 1, holes: [{ x: -500, y: -500 }, { x: 9e4, y: 9e4 }] }],
    slotGroups: [], side: 'top', pxPerMm: 4,
    panelWidthMm: panel.panelWidth, panelHeightMm: panel.panelHeight,
    layerLabel: 'Top_Drill', createCanvas: nodeCanvasFactory,
  })
  check('a blank drill mask is dropped, not shipped', offPanel.bitmap === null,
    offPanel.bitmap === null ? 'bitmap null' : 'SHIPPED A BLANK MASK')
  check('a blank drill mask says so in warnings',
    offPanel.warnings.some(w => /blank/i.test(w)), JSON.stringify(offPanel.warnings))
}

// --- Emit PNGs for visual inspection --------------------------------------
// Top_Copper.png/Bottom_Copper.png are the PUNCHED rasters — what
// generateAoiFilesAction now actually produces. The unpunched pair rides
// along too, purely so the donut fix is visually checkable side by side.
mkdirSync(OUT_DIR, { recursive: true })
const topPng = await encodeBinaryPng(topPunched.bitmap, topPunched.widthPx, topPunched.heightPx)
writeFileSync(`${OUT_DIR}/Top_Copper.png`, topPng)
const botPng = bottomPunched.bitmap
  ? await encodeBinaryPng(bottomPunched.bitmap, bottomPunched.widthPx, bottomPunched.heightPx)
  : null
if (botPng) writeFileSync(`${OUT_DIR}/Bottom_Copper.png`, botPng)
const drillPng = await encodeBinaryPng(drillTop.bitmap, drillTop.widthPx, drillTop.heightPx)
writeFileSync(`${OUT_DIR}/Top_Drill.png`, drillPng)
const topUnpunchedPng = await encodeBinaryPng(top.bitmap, top.widthPx, top.heightPx)
writeFileSync(`${OUT_DIR}/Top_Copper_unpunched.png`, topUnpunchedPng)
console.log(`\nWrote ${OUT_DIR}/Top_Copper.png (${(topPng.length / 1024).toFixed(0)} KB, punched), ` +
  `Bottom_Copper.png (${botPng ? (botPng.length / 1024).toFixed(0) : '?'} KB, punched), ` +
  `Top_Drill.png (${(drillPng.length / 1024).toFixed(0)} KB), ` +
  `Top_Copper_unpunched.png (${(topUnpunchedPng.length / 1024).toFixed(0)} KB, for comparison)`)

// PNG round-trip: re-decode our own encoder's output and confirm it survives.
const decoded = await import('@napi-rs/canvas').then(m => m.loadImage(topPng))
check('PNG decodes at the right dimensions', decoded.width === top.widthPx && decoded.height === top.heightPx,
  `${decoded.width}x${decoded.height}`)

console.log(failures === 0 ? '\nAll oracles passed.' : `\n${failures} oracle(s) FAILED.`)
process.exit(failures === 0 ? 0 : 1)
