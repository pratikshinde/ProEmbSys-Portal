/**
 * Builds one role-filtered share bundle (FILM / DRILL / TEST) entirely
 * client-side — CAM outputs never exist on the server (film PDFs render in
 * a browser Web Worker whose server path explicitly returns
 * 'Worker unavailable'), so this mirrors export-panel.tsx's own
 * handleExport preparation (mirror layers -> LayerFile[] -> generate) but
 * calls buildPanelArtifacts (the un-zipped, un-downloaded generation pass)
 * instead of exportPanelizedGerbers, then role-filters the result instead
 * of always shipping the whole panel.
 */
import {
  buildPanelArtifacts,
  buildGcodeArtifacts,
  generateDescriptiveLayerName,
  type LayerFile,
  type FilmRenderer,
} from '../gerber-exporter'
import { filterByRole, zipArtifacts, type CamArtifact } from './artifacts'
import {
  buildDrillManifest,
  buildTestManifest,
  renderDrillReadme,
  renderTestReadme,
  type FilmManifest,
  type DrillManifest,
  type TestManifest,
} from './manifest'
import { defaultFilmLayerSetting, type FilmConfig } from '../film-types'
import { renderFilmPdfs } from '../gerber-svg'
import { getMirroredLayers } from '../design-mirror'
import type { LayerEntry, DesignEntry } from '../store'
import type { PanelResult, PanelConfig, PanelInfo, OutputFormat } from '../panelization-engine'
import type { RoutingResult } from '../routing/types'
import type { GcodeFile } from '../routing/gcode'

export type ShareBundleKindLiteral = 'FILM' | 'DRILL' | 'TEST'

export interface BuildShareBundleInput {
  kind: ShareBundleKindLiteral
  layers: LayerEntry[]
  designs: DesignEntry[]
  panelResult: PanelResult
  panelConfig: PanelConfig
  panelInfo: PanelInfo
  outputFormat: OutputFormat
  routingResult: RoutingResult | null
  gcodeFiles: GcodeFile[] | null
  filmConfig: FilmConfig
}

export type BuildShareBundleResult =
  | { ok: true; blob: Blob; manifest: FilmManifest | DrillManifest | TestManifest; fileName: string; warnings: string[] }
  | { ok: false; error: string }

export async function buildShareBundle(input: BuildShareBundleInput): Promise<BuildShareBundleResult> {
  const { kind, layers, designs, panelResult, panelConfig, panelInfo, outputFormat, routingResult, gcodeFiles, filmConfig } = input

  // Same mirroring pass export-panel.tsx's handleExport runs — the ONE
  // shared point every file-producing consumer goes through, so a mirrored
  // design's share bundle can't disagree with its own downloaded ZIP.
  const { layers: mirroredLayers, warnings: mirrorWarnings } = getMirroredLayers(layers, designs)

  const layerFiles: LayerFile[] = mirroredLayers.map((l) => ({
    name: l.name,
    fileName: `panel_${l.type}_${l.id}.gerber`,
    content: l.rawContent,
    parsedLayer: l.parsedLayer,
    type: l.type,
    side: l.side,
    designId: l.designId,
  }))

  let film: { config: FilmConfig; render: FilmRenderer } | null = null
  if (kind === 'FILM') {
    if (!filmConfig.enabled) {
      return { ok: false, error: 'Film Plot is not enabled on the Info & Export tab.' }
    }
    // Resolve the sparse store map into a fully-populated one, identical to
    // handleExport's own resolution — so this bundle can never silently
    // disagree with what "Regenerate" on Info & Export would produce.
    const resolved: FilmConfig['layers'] = {}
    for (const l of mirroredLayers) {
      if (l.type === 'drill') continue
      const descriptiveName = generateDescriptiveLayerName({
        name: l.name,
        fileName: '',
        content: '',
        parsedLayer: null,
        type: l.type,
        side: l.side,
      })
      if (resolved[descriptiveName]) continue
      resolved[descriptiveName] = filmConfig.layers[descriptiveName] ?? defaultFilmLayerSetting(l.type)
    }
    const anyReady = Object.values(resolved).some((s) => s.include && s.polarity)
    if (!anyReady) {
      return { ok: false, error: 'No layer is both included and has a Positive/Negative choice set for film.' }
    }
    film = { config: { ...filmConfig, layers: resolved }, render: renderFilmPdfs }
  }

  // metaPanel is always null here — Meta-Panelization files are tagged role
  // 'meta' only (never film/drill/test) since they describe a tiled SHEET
  // of panel copies, a different concept from any single-panel bundle.
  const built = await buildPanelArtifacts(layerFiles, panelResult, panelConfig, panelInfo, outputFormat, routingResult, null, film)
  const warnings = [...mirrorWarnings, ...built.dcodeWarnings, ...built.filmWarnings]
  const baseFileName = `${built.partNumber}_${built.customerName}_${built.version}_${built.dateStr}`

  if (kind === 'FILM') {
    if (!built.filmManifest || built.filmManifest.films.length === 0) {
      return { ok: false, error: 'Film generation produced no files — check the warnings on the Info & Export tab.' }
    }
    // Already includes Film/README.txt (built.filmManifest's own rendered
    // text, tagged role 'film' alongside the PDFs) — no separate README
    // needed here, unlike DRILL/TEST below.
    const filmArtifacts = filterByRole(built.artifacts, 'film')
    const blob = await zipArtifacts(filmArtifacts, 'film_plot')
    return { ok: true, blob, manifest: built.filmManifest, fileName: `${baseFileName}_Film.zip`, warnings }
  }

  if (kind === 'DRILL') {
    // Spans TWO of buildPanelArtifacts's outputs: the panel's own
    // drill/route files (role 'drill') AND the G-Code tab's .ngc programs
    // (also tagged 'drill') — see share/artifacts.ts's own header for why
    // no single existing export ZIP already equals this bundle.
    const gcodeArtifacts = filterByRole(buildGcodeArtifacts(gcodeFiles ?? []), 'drill')
    const drillArtifacts = [...filterByRole(built.artifacts, 'drill'), ...gcodeArtifacts]
    if (drillArtifacts.length === 0) {
      return { ok: false, error: 'This panel has no drill, route, or G-code files to share.' }
    }
    const drillManifest = buildDrillManifest({
      partNumber: built.partNumber,
      panelWidthMm: panelResult.panelWidth,
      panelHeightMm: panelResult.panelHeight,
      drillFormat: panelConfig.drillFormat,
      files: drillArtifacts.map((a) => a.path),
      routing: routingResult,
    })
    const readme: CamArtifact = { path: 'README.txt', content: renderDrillReadme(drillManifest), roles: ['drill'] }
    const blob = await zipArtifacts([...drillArtifacts, readme], 'drilling_files')
    return { ok: true, blob, manifest: drillManifest, fileName: `${baseFileName}_Drill.zip`, warnings }
  }

  // TEST — the panel ZIP minus Film/, Meta-Panelization/, and route files;
  // deliberately includes _Drill.drl (a test house needs real holes) but
  // not _PINN.drl (tooling/pinning holes are a fab-fixture concern).
  const testArtifacts = filterByRole(built.artifacts, 'test')
  if (testArtifacts.length === 0) {
    return { ok: false, error: 'This panel has no test-bundle files to share.' }
  }
  const testManifest = buildTestManifest({
    partNumber: built.partNumber,
    panelWidthMm: panelResult.panelWidth,
    panelHeightMm: panelResult.panelHeight,
    layerNames: Array.from(new Set(mirroredLayers.filter((l) => l.type !== 'drill').map((l) => l.name))),
    files: testArtifacts.map((a) => a.path),
  })
  const readme: CamArtifact = { path: 'README.txt', content: renderTestReadme(testManifest), roles: ['test'] }
  const blob = await zipArtifacts([...testArtifacts, readme], 'test_files')
  return { ok: true, blob, manifest: testManifest, fileName: `${baseFileName}_Test.zip`, warnings }
}
