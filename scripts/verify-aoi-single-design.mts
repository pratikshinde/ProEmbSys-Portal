/**
 * Headless correctness gate for AOI's single-board export — the change that
 * replaced "rasterise the whole tiled panel" with "rasterise just the
 * active design's own single board" (`generateAoiFilesAction`, store.ts).
 *
 *   npx tsx scripts/verify-aoi-single-design.mts
 *
 * Reuses the same real WLC INDICATOR job as verify-aoi-raster.mts (a single
 * design, panelized 2x2 in the real portal — 166.3 x 242.3 mm), but drives
 * the SAME `buildPanelizedCopperSources`/`collectPanelizedDrillHoles`/
 * `collectPanelizedDrillSlots` the store action calls, fed a synthetic
 * 1-board "panel" — exactly what `generateAoiFilesAction` now does — rather
 * than reimplementing that construction by hand, so this test can't drift
 * from production.
 */
import { createCanvas } from '@napi-rs/canvas'
import { PrismaClient } from '@prisma/client'

import { readCamJobFile } from '../src/lib/cam-job-files'
import { parseGerber, parseExcellonDrill } from '../src/lib/gerber-parser'
import { resolveDesignGeometry, type PanelResult, type PanelConfig } from '../src/lib/panelization-engine'
import { buildPanelizedCopperSources, collectPanelizedDrillHoles, collectPanelizedDrillSlots, type LayerFile } from '../src/lib/gerber-exporter'
import { gerberToAoiBitmap, type AoiCanvas } from '../src/lib/aoi/gerber-to-aoi'
import { rasterDimensions } from '../src/lib/aoi/plot-to-raster'
import { mmToPx } from '../src/lib/aoi/types'
import { encodeBinaryPng } from '../src/lib/aoi/png-encode'
import { mkdirSync, writeFileSync } from 'node:fs'

const JOB_ID = 'cmtu65eyb0001wt9k426g1nc7'
const OUT_DIR = 'scripts/out'
// The real computed panel for this job (verify-aoi-raster.mts confirms this
// live): 166.3 x 242.3 mm, 2x2 of this one design. Used only as a sanity
// bound below — the single-board raster must be a small fraction of it.
const REAL_PANEL_AREA_MM2 = 166.3 * 242.3
const DESIGN_ID = 'design1'

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

/** @napi-rs/canvas as an AoiCanvas — same factory every other AOI script uses. */
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
const panelConfig: PanelConfig = config.panelConfig

const wanted = ['copper', 'outline', 'drill']
const rawLayers: { fileName: string; type: string; side: string; rawContent: string; parsedLayer: ReturnType<typeof parseGerber>; designId: string }[] = []
for (const meta of config.files) {
  if (!wanted.includes(meta.type)) continue
  const content = await readCamJobFile(job.id, meta.layerFileId)
  const parsedLayer = meta.type === 'drill'
    ? parseExcellonDrill(content, meta.fileName)
    : parseGerber(content, meta.fileName)
  // Every layer forced onto the SAME synthetic design id — this test only
  // needs internal consistency between layerFiles/placements/designs, not
  // whatever real id the browser session happened to assign.
  rawLayers.push({ fileName: meta.fileName, type: meta.type, side: meta.side, rawContent: content, parsedLayer, designId: DESIGN_ID })
}
await db.$disconnect()

const geometry = resolveDesignGeometry(rawLayers)
if (!geometry) { console.error('No usable geometry'); process.exit(1) }
const { widthMm, heightMm, datum } = geometry
console.log(`\nDesign geometry: ${widthMm.toFixed(2)} x ${heightMm.toFixed(2)} mm (datum ${JSON.stringify(datum)})`)

// --- Exactly what generateAoiFilesAction builds -----------------------------
const layerFiles: LayerFile[] = rawLayers.map(l => ({
  name: l.fileName,
  fileName: l.fileName,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  content: l.rawContent, parsedLayer: l.parsedLayer as any, type: l.type as any, side: l.side as any, designId: l.designId,
}))

const singleBoardPanel: PanelResult = {
  panelWidth: widthMm, panelHeight: heightMm, totalPCBs: 1,
  placements: [{ row: 0, col: 0, x: 0, y: 0, w: widthMm, h: heightMm, rotationDeg: 0, designId: DESIGN_ID }],
  designs: [{ designId: DESIGN_ID, name: 'Design 1', widthMm, heightMm, count: 1, rotationsDeg: [0] }],
  toolingHoles: [], fiducials: [], infoTexts: [],
  source: 'grid',
  vScoreLines: [],
}
const singleBoardConfig: PanelConfig = {
  ...panelConfig,
  enableLShapeMarks: false, enableToolingHoles: false, enableFiducials: false,
  enableVScoreMarks: false, enableVScoreLayer: false,
}

const { top: topContent, bottom: bottomContent, warnings: buildWarnings } =
  buildPanelizedCopperSources(layerFiles, singleBoardPanel, singleBoardConfig)
for (const w of buildWarnings) console.log(`  build warning: ${w}`)
if (!topContent) { console.error('No top content produced'); process.exit(1) }
check('bottom copper also produced (this job has a bottom copper layer)', !!bottomContent)

// --- Drill geometry, board-relative ----------------------------------------
const drillLayerFiles = layerFiles.filter(l => l.type === 'drill' && l.parsedLayer?.bounds)
const holeGroups = collectPanelizedDrillHoles(drillLayerFiles, singleBoardPanel, datum)
const slotGroups = collectPanelizedDrillSlots(drillLayerFiles, singleBoardPanel, datum)
const totalHoles = holeGroups.reduce((n, g) => n + g.holes.length, 0)
console.log(`Drill: ${totalHoles} holes, ${slotGroups.reduce((n, g) => n + g.slots.length, 0)} slots`)

// --- Rasterise, WITH holes punched (production behaviour) ------------------
const K = 40
const top = gerberToAoiBitmap({
  content: topContent, side: 'top', pxPerMm: K,
  panelWidthMm: widthMm, panelHeightMm: heightMm,
  layerLabel: 'top_Copper', holeGroups, slotGroups, createCanvas: nodeCanvasFactory,
})
if (!top.bitmap) { console.error('Top raster failed:', top.warnings); process.exit(1) }
for (const w of top.warnings) console.log(`  warning: ${w}`)

// --- Oracles -----------------------------------------------------------
const expected = rasterDimensions(widthMm, heightMm, K)
check('raster is sized to the SINGLE BOARD, not the whole tiled panel',
  top.widthPx === expected.widthPx && top.heightPx === expected.heightPx,
  `${top.widthPx}x${top.heightPx} (expected ${expected.widthPx}x${expected.heightPx} for a ${widthMm.toFixed(1)}x${heightMm.toFixed(1)}mm board)`)

const boardAreaMm2 = widthMm * heightMm
check('single-board area is a small fraction of the real panel area (proves this is NOT the tiled panel)',
  boardAreaMm2 < REAL_PANEL_AREA_MM2 * 0.4, `${boardAreaMm2.toFixed(0)} mm² vs panel ${REAL_PANEL_AREA_MM2.toFixed(0)} mm²`)

check('binarity: every pixel is 0 or 1', top.bitmap.every(v => v === 0 || v === 1))

const coverage = top.bitmap.reduce((n, v) => n + v, 0) / top.bitmap.length
check('coverage is plausible for a copper layer', coverage > 0.03 && coverage < 0.90, `${(coverage * 100).toFixed(1)}% copper`)

// Holes must be punched relative to the BOARD's own (0,0) origin — every
// collected hole must land inside the board's own raster bounds. Before this
// feature, drill positions were panel-absolute (166.3 x 242.3mm); if that
// math leaked into this path, most holes would land far outside an
// 83 x 116mm board and this check would fail loudly.
let inBounds = 0
for (const g of holeGroups) {
  for (const h of g.holes) {
    if (h.x >= -0.5 && h.x <= widthMm + 0.5 && h.y >= -0.5 && h.y <= heightMm + 0.5) inBounds++
  }
}
check("every drilled hole lands inside the single board's own bounds (board-relative, not panel-absolute)",
  totalHoles > 0 && inBounds === totalHoles, `${inBounds}/${totalHoles}`)

// Every single hole must actually be PUNCHED — substrate, not copper, at its
// exact centre pixel — not just "inside bounds". This is the check that
// would have caught a punch that silently no-ops on the single-board path
// specifically (e.g. a mismatched transform between the build and the punch
// call) even though the whole-panel path (verify-aoi-raster.mts) is fine.
let punchedAtCentre = 0
for (const g of holeGroups) {
  for (const h of g.holes) {
    const [px, py] = mmToPx('top', h.x, h.y, K, top.widthPx, top.heightPx)
    const ix = Math.round(px), iy = Math.round(py)
    if (ix >= 0 && iy >= 0 && ix < top.widthPx && iy < top.heightPx && top.bitmap[iy * top.widthPx + ix] === 0) punchedAtCentre++
  }
}
check('every hole reads as substrate (punched) at its exact centre pixel',
  totalHoles > 0 && punchedAtCentre === totalHoles, `${punchedAtCentre}/${totalHoles}`)

// Bottom side too — same board-sized raster, mirrored.
const bottom = bottomContent
  ? gerberToAoiBitmap({
    content: bottomContent, side: 'bottom', pxPerMm: K,
    panelWidthMm: widthMm, panelHeightMm: heightMm,
    layerLabel: 'bottom_Copper', holeGroups, slotGroups, createCanvas: nodeCanvasFactory,
  })
  : null
check('bottom raster is also sized to the single board',
  !!bottom?.bitmap && bottom.widthPx === expected.widthPx && bottom.heightPx === expected.heightPx,
  bottom?.bitmap ? `${bottom.widthPx}x${bottom.heightPx}` : 'no bottom bitmap')

// --- Regression: "Hide All" / partial-hide must never affect AOI -----------
// Reported live as two symptoms of one bug: `resolveDesignGeometry` filters
// on `.visible`, and Generate Reference used it unmodified — so hiding every
// layer left NO layer qualifying (geometry -> null -> button disabled), and
// hiding just the outline while some copper stayed visible silently sized
// the reference off a smaller fallback layer, which then made the OTHER
// side's real content fail gerberToAoiBitmap's bounds guard and vanish from
// the ZIP. `generateAoiFilesAction`/`aoi-panel.tsx` now force every layer
// visible before resolving geometry — reproduced here directly.
{
  const allHidden = rawLayers.map(l => ({ ...l, visible: false }))
  const brokenGeometry = resolveDesignGeometry(allHidden)
  check('(sanity) resolveDesignGeometry alone DOES return null when every layer is hidden — proves the bug is real',
    brokenGeometry === null, brokenGeometry ? 'unexpectedly non-null' : 'null, as expected pre-fix')

  const fixedGeometry = resolveDesignGeometry(allHidden.map(l => ({ ...l, visible: true })))
  check("Hide All: forcing visible:true recovers the SAME geometry as never hiding anything",
    !!fixedGeometry && Math.abs(fixedGeometry.widthMm - widthMm) < 1e-6 && Math.abs(fixedGeometry.heightMm - heightMm) < 1e-6,
    fixedGeometry ? `${fixedGeometry.widthMm.toFixed(2)}x${fixedGeometry.heightMm.toFixed(2)}mm vs ${widthMm.toFixed(2)}x${heightMm.toFixed(2)}mm` : 'still null')

  // Partial hide: outline + top copper hidden, bottom copper (smaller-area
  // side, on this real board) left visible — the exact shape of bug report
  // #2 ("only bottom came out"). Without the fix this undersizes the board
  // from whatever's left visible; with the fix it must be byte-identical to
  // the fully-visible geometry, and BOTH sides must still rasterise.
  const partiallyHidden = rawLayers.map(l =>
    ({ ...l, visible: !(l.type === 'outline' || (l.type === 'copper' && l.side === 'top')) }))
  const partialGeometryBroken = resolveDesignGeometry(partiallyHidden)
  const partialGeometryFixed = resolveDesignGeometry(partiallyHidden.map(l => ({ ...l, visible: true })))
  check('partial hide (outline + top copper off): the FIX still gives the true full-board size, not a smaller fallback',
    !!partialGeometryFixed && Math.abs(partialGeometryFixed.widthMm - widthMm) < 1e-6 && Math.abs(partialGeometryFixed.heightMm - heightMm) < 1e-6,
    `fixed=${partialGeometryFixed ? `${partialGeometryFixed.widthMm.toFixed(2)}x${partialGeometryFixed.heightMm.toFixed(2)}` : 'null'}, ` +
      `unfixed=${partialGeometryBroken ? `${partialGeometryBroken.widthMm.toFixed(2)}x${partialGeometryBroken.heightMm.toFixed(2)}` : 'null'} (true ${widthMm.toFixed(2)}x${heightMm.toFixed(2)})`)

  if (partialGeometryFixed) {
    const partialLayerFiles: LayerFile[] = partiallyHidden.map(l => ({
      name: l.fileName, fileName: l.fileName, content: l.rawContent,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      parsedLayer: l.parsedLayer as any, type: l.type as any, side: l.side as any, designId: l.designId,
    }))
    const partialPanel: PanelResult = {
      panelWidth: partialGeometryFixed.widthMm, panelHeight: partialGeometryFixed.heightMm, totalPCBs: 1,
      placements: [{ row: 0, col: 0, x: 0, y: 0, w: partialGeometryFixed.widthMm, h: partialGeometryFixed.heightMm, rotationDeg: 0, designId: DESIGN_ID }],
      designs: [{ designId: DESIGN_ID, name: 'Design 1', widthMm: partialGeometryFixed.widthMm, heightMm: partialGeometryFixed.heightMm, count: 1, rotationsDeg: [0] }],
      toolingHoles: [], fiducials: [], infoTexts: [], source: 'grid', vScoreLines: [],
    }
    const { top: partialTop, bottom: partialBottom } = buildPanelizedCopperSources(partialLayerFiles, partialPanel, singleBoardConfig)
    check('partial hide: TOP copper content still produced (this was the reported missing side)', !!partialTop)
    check('partial hide: BOTTOM copper content still produced', !!partialBottom)

    if (partialTop) {
      const partialTopRaster = gerberToAoiBitmap({
        content: partialTop, side: 'top', pxPerMm: K,
        panelWidthMm: partialGeometryFixed.widthMm, panelHeightMm: partialGeometryFixed.heightMm,
        layerLabel: 'top_Copper', createCanvas: nodeCanvasFactory,
      })
      check("partial hide: TOP copper actually rasterises (doesn't fail the bounds guard)",
        !!partialTopRaster.bitmap, partialTopRaster.bitmap ? 'ok' : JSON.stringify(partialTopRaster.warnings))
    }
  }
}

// --- Emit for visual inspection ---------------------------------------
mkdirSync(OUT_DIR, { recursive: true })
const topPng = await encodeBinaryPng(top.bitmap, top.widthPx, top.heightPx)
writeFileSync(`${OUT_DIR}/Top_Copper_single_board.png`, topPng)
console.log(`\nWrote ${OUT_DIR}/Top_Copper_single_board.png (${(topPng.length / 1024).toFixed(0)} KB, ` +
  `${top.widthPx}x${top.heightPx} — one board, not the whole panel)`)

console.log(failures === 0 ? '\nAll oracles passed.' : `\n${failures} oracle(s) FAILED.`)
process.exit(failures === 0 ? 0 : 1)
