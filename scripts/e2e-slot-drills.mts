/**
 * End-to-end check of slot handling on the REAL saved job "MF Rev 1.1"
 * (multi-design: relay pcb + automotive_headlight_retrofit), driving the actual
 * store — load job -> re-pack panel -> routing -> G-code — and the actual
 * panelized Excellon writer, then asserting on the OUTPUT TEXT.
 *
 *   npx tsx scripts/e2e-slot-drills.mts
 */
import { PrismaClient } from '@prisma/client'
import { mkdirSync, writeFileSync } from 'node:fs'

import { readCamJobFile } from '../src/lib/cam-job-files'
import { useAppStore } from '../src/lib/store'
import { collectPanelizedDrillSlots, generatePanelizedDrill, type LayerFile } from '../src/lib/gerber-exporter'
import { computeDesignOffsetsAndConfigs } from '../src/lib/gerber-exporter'
import { getMirroredLayers } from '../src/lib/design-mirror'
import { slotDrillPoints, resolveSlotDrillSettings } from '../src/lib/drill-slots'
import { resolveDesignGeometry } from '../src/lib/panelization-engine'

const JOB_ID = process.argv[2] ?? 'cmuf6xap20016wtvcp1xheb07'

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

// --- Load the saved job through the REAL store path -------------------------
const db = new PrismaClient()
const job = await db.camJob.findUnique({ where: { id: JOB_ID } })
if (!job) { console.error('job not found'); process.exit(1) }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const snapshot = job.config as any
const contents: Record<string, string> = {}
for (const f of snapshot.files) contents[f.layerFileId] = await readCamJobFile(job.id, f.layerFileId)
await db.$disconnect()

const store = useAppStore
const { missingFiles } = await store.getState().loadCamJobSnapshot(snapshot, contents)
check('job loaded with no missing files', missingFiles.length === 0, `${missingFiles.length} missing`)

const s0 = store.getState()
check('multi-design mode with two designs', s0.camMode === 'multi' && s0.designs.length === 2,
  `${s0.camMode}, designs=${s0.designs.map(d => d.name).join(' + ')}`)

const drillLayers = s0.layers.filter(l => l.type === 'drill')
const slotsPerDesign = drillLayers.map(l => ({ design: l.designId, file: l.fileName, slots: l.parsedLayer.drillSlots?.length ?? 0 }))
console.log('drill layers:', JSON.stringify(slotsPerDesign))
check('BOTH designs\' drill layers carry parsed slots (not phantom round holes)',
  slotsPerDesign.length === 2 && slotsPerDesign.every(d => d.slots > 0), JSON.stringify(slotsPerDesign.map(d => d.slots)))

// --- Build the real multi-design panel -------------------------------------
store.getState().computePanelResult()
const panel = store.getState().panelResult
if (!panel) { console.error('panel did not compute'); process.exit(1) }
const perDesignCount = new Map<string, number>()
for (const p of panel.placements) perDesignCount.set(p.designId, (perDesignCount.get(p.designId) ?? 0) + 1)
console.log(`panel ${panel.panelWidth.toFixed(1)} x ${panel.panelHeight.toFixed(1)} mm, placements per design:`, JSON.stringify([...perDesignCount]))
check('panel contains BOTH designs', perDesignCount.size === 2, JSON.stringify([...perDesignCount]))

// --- Expected slot geometry, straight from the parsed layers ---------------
const settings = resolveSlotDrillSettings(store.getState().panelConfig)
console.log('slot settings:', JSON.stringify(settings))
check('slots-as-drills is ON for this pre-existing job (old job has no field -> default)', settings.asDrills === true)

// --- 1) Panelized Excellon export -----------------------------------------
{
  const st = store.getState()
  const { layers: mirrored } = getMirroredLayers(st.layers, st.designs)
  const layerFiles: LayerFile[] = mirrored.map(l => ({
    name: l.name, fileName: l.fileName, content: l.rawContent, parsedLayer: l.parsedLayer,
    type: l.type, side: l.side, designId: l.designId,
  }))
  const drillFiles = layerFiles.filter(l => l.type === 'drill')
  const { baseOffsetByDesign } = computeDesignOffsetsAndConfigs(layerFiles, st.panelConfig)

  const asDrills = generatePanelizedDrill(drillFiles, panel, { ...st.panelConfig, slotsAsDrills: true }, undefined, undefined, baseOffsetByDesign)
  const native = generatePanelizedDrill(drillFiles, panel, { ...st.panelConfig, slotsAsDrills: false }, undefined, undefined, baseOffsetByDesign)

  const hitLines = (t: string) => t.split('\n').filter(l => /^X-?[\d.]+Y-?[\d.]+$/.test(l)).length
  const g85Lines = (t: string) => t.split('\n').filter(l => l.includes('G85')).length

  const totalSlots = [...perDesignCount].reduce((n, [designId, placements]) => {
    const dl = drillFiles.find(l => l.designId === designId)
    return n + (dl?.parsedLayer?.drillSlots?.length ?? 0) * placements
  }, 0)
  console.log(`\nExport: native has ${g85Lines(native)} G85 slot lines (expected ${totalSlots}); as-drills has ${g85Lines(asDrills)}`)
  check('native mode: every slot on every placement is a G85 line (both designs)', g85Lines(native) === totalSlots, `${g85Lines(native)} vs ${totalSlots}`)
  check('as-drills mode: NO G85 lines remain', g85Lines(asDrills) === 0)

  // Expected extra hits = sum over slots of (points per slot) * placements, minus nothing.
  let expectedSlotHits = 0
  for (const [designId, placements] of perDesignCount) {
    const dl = drillFiles.find(l => l.designId === designId)
    for (const s of dl?.parsedLayer?.drillSlots ?? []) {
      expectedSlotHits += slotDrillPoints(s, s.diameterMm, settings.pitchRatio).length * placements
    }
  }
  const delta = hitLines(asDrills) - hitLines(native)
  check('as-drills mode emits exactly the expected number of slot hits (multiple per slot, every placement, both designs)',
    delta === expectedSlotHits, `+${delta} hit lines vs expected +${expectedSlotHits}`)
  check('every slot became MORE than two drills (the reported bug was exactly two)',
    expectedSlotHits > totalSlots * 2, `${expectedSlotHits} hits for ${totalSlots} slots`)
}

// --- 2) G-code (real store action, real routing) -----------------------------
// Only DRILLING programs are inspected: the cutting/routing program always
// carries its own `#<XY_Feed>` header, so matching it there proves nothing.
const drillingOnly = (files: { filename: string; content: string }[]) => files.filter(f => /Drilling/i.test(f.filename))
const hasNativeSlotBlock = (files: { filename: string; content: string }[]) =>
  drillingOnly(files).some(f => /#<XY_Feed>/.test(f.content))
/** X/Y of every coordinate word in a drilling program, as numbers. */
const plungePoints = (content: string): [number, number][] => {
  const pts: [number, number][] = []
  for (const m of content.matchAll(/X(-?[0-9]+[.]?[0-9]*)[ ]*Y(-?[0-9]+[.]?[0-9]*)/g)) pts.push([Number(m[1]), Number(m[2])])
  return pts
}
{
  await store.getState().generateRouting()
  check('routing generated', !!store.getState().routingResult, store.getState().routingResult ? 'ok' : 'no routing result')
  store.getState().generateGcodeFilesAction()
  const files = store.getState().gcodeFiles
  check('G-code files generated', !!files && files.length > 0, `${files?.length ?? 0} files`)
  if (files) {
    mkdirSync('scripts/out/gcode', { recursive: true })
    for (const f of files) writeFileSync(`scripts/out/gcode/${f.filename}`, f.content)
    check('as-drills G-code: no native slot (lateral cut) block in ANY drilling program', !hasNativeSlotBlock(files))

    // Every expected slot hit, on every placement of its own design, must be a
    // plunge in the program for that slot's diameter.
    const st = store.getState()
    const { layers: mirrored } = getMirroredLayers(st.layers, st.designs)
    let expected = 0
    let found = 0
    const missing: string[] = []
    for (const dl of mirrored.filter(l => l.type === 'drill')) {
      const geom = resolveDesignGeometry(dl.designId ? mirrored.filter(l => l.designId === dl.designId).map(l => ({ ...l, visible: true })) : [])
      if (!geom) continue
      const placements = panel.placements.filter(p => p.designId === dl.designId)
      for (const s of dl.parsedLayer.drillSlots ?? []) {
        const diaLabel = s.diameterMm.toFixed(2).replace('.', '-')
        const prog = drillingOnly(files).find(f => f.filename.includes(`_Drilling_${diaLabel}_`))
        const pts = prog ? plungePoints(prog.content) : []
        for (const pos of placements) {
          for (const p of slotDrillPoints(s, s.diameterMm, settings.pitchRatio)) {
            expected++
            const ex = p.x + pos.x + geom.datum.x
            const ey = p.y + pos.y + geom.datum.y
            // 2 µm tolerance: G-code prints a rounded decimal, so an exact string match
            // would flag a pure formatting tie as a missing hole.
            if (pts.some(([x, y]) => Math.abs(x - ex) < 0.002 && Math.abs(y - ey) < 0.002)) found++
            else if (missing.length < 3) missing.push(`${dl.designId} dia ${diaLabel} ${ex.toFixed(4)},${ey.toFixed(4)}`)
          }
        }
      }
    }
    check('every slot hit (every placement, both designs) is a plunge in the program for its own diameter',
      expected > 0 && found === expected, `${found}/${expected}${missing.length ? ' e.g. missing ' + missing.join(' | ') : ''}`)
  }
}

// --- 3) Turning the setting off restores native slots -------------------------
{
  store.getState().updatePanelConfig({ slotsAsDrills: false })
  store.getState().generateGcodeFilesAction()
  const files = store.getState().gcodeFiles
  check('slotsAsDrills=false restores native slot cuts in the drilling programs', !!files && hasNativeSlotBlock(files))
}

// --- 4) Meta-panel (multi-panel array) batch export --------------------------
{
  const arrayHits = (t: string) => t.split(String.fromCharCode(10)).filter(l => /^X-?[0-9.]+Y-?[0-9.]+$/.test(l)).length
  const g85 = (t: string) => t.split(String.fromCharCode(10)).filter(l => l.includes('G85')).length

  store.getState().updatePanelConfig({ slotsAsDrills: true })
  store.getState().generatePanelArrayFilesAction()
  const on = store.getState().panelArrayFiles
  const onCount = on ? store.getState().panelArrayResult : null
  check('meta-panel array generated (as-drills)', !!on && !!onCount, onCount ? (onCount.cols + ' x ' + onCount.rows + ' copies') : 'no array fit')
  if (on) {
    check('meta-panel Excellon: no G85 slot lines remain', g85(on.drillContent) === 0)
    check('meta-panel G-code: no native slot block in any drilling program', !hasNativeSlotBlock(on.gcodeFiles))
  }

  store.getState().updatePanelConfig({ slotsAsDrills: false })
  store.getState().generatePanelArrayFilesAction()
  const off = store.getState().panelArrayFiles
  if (on && off) {
    check('meta-panel Excellon (native mode): G85 slot lines present', g85(off.drillContent) > 0, g85(off.drillContent) + ' G85 lines')
    check('meta-panel: as-drills mode emits MORE hits than native mode (the slot bodies)', arrayHits(on.drillContent) > arrayHits(off.drillContent),
      arrayHits(on.drillContent) + ' vs ' + arrayHits(off.drillContent))
  }
}

// --- 5) Changing the setting drops stale generated bundles -------------------
{
  store.getState().updatePanelConfig({ slotsAsDrills: true })
  store.getState().generateGcodeFilesAction()
  store.getState().generatePanelArrayFilesAction()
  const before = !!store.getState().gcodeFiles && !!store.getState().panelArrayFiles
  const routingStaleBefore = store.getState().routingStale
  store.getState().updatePanelConfig({ slotsAsDrills: false })
  const after = store.getState()
  check('toggling the setting clears already-generated G-code + array bundles (no stale program)',
    before && after.gcodeFiles === null && after.panelArrayFiles === null)
  check('toggling the setting does NOT spuriously mark routing stale', after.routingStale === routingStaleBefore, 'routingStale=' + after.routingStale)
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`)
process.exit(failures === 0 ? 0 : 1)
