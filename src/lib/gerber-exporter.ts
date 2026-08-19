/**
 * Gerber Export Manager
 * Generates a ZIP file containing panelized Gerber files for all layers.
 */

import JSZip from 'jszip'
import { saveAs } from 'file-saver'
import { GerberLayer } from './gerber-parser'
import {
  PanelResult,
  PanelConfig,
  PanelInfo,
  OutputFormat,
  DEFAULT_OUTPUT_FORMAT,
  autoDetectIntegerDigits,
  generatePanelOutlineGerber,
  generateMergedPanelizedGerber,
  generateFSCommand,
  generateMOCommand,
  generateGUnitCode,
  formatCoordinate,
  formatDrillCoordinate,
  generateDrillFormatHeader,
  resolveExportDrillFormat,
  emitExcellonToolBlock,
  BaseOffset,
  isRectangularOutline,
  formatPanelDate,
  resolveDesignGeometry,
  type DrillFormatConfig,
  type GerberExportContributor,
} from './panelization-engine'
import { collectMouseBiteHoles, type RoutingResult } from './routing/types'
import { generateRouteGerber } from './routing/emit-gerber'
import { generateVScoreGerber } from './vscore/emit-gerber'
import { generateRoutFile, generateMouseBiteDrill } from './routing/emit-excellon'
import type { GcodeFile } from './routing/gcode'
import type { PanelArrayResult } from './panel-array'

export interface LayerFile {
  name: string
  fileName: string
  content: string // raw Gerber content
  parsedLayer: GerberLayer | null
  type: 'copper' | 'mask' | 'silk' | 'outline' | 'paste' | 'drill' | 'fab' | 'other'
  side?: 'top' | 'bottom' | 'none'
  /** Which design this layer belongs to. Defaults to a single shared value
   *  for every existing caller that doesn't pass one (see the fallback in
   *  `exportPanelizedGerbers`), so a caller that has never heard of designs
   *  still exports exactly as before. */
  designId?: string
}

/**
 * Sanitize a user-entered PanelInfo field (part number, customer name, etc.)
 * for safe use inside a filename — strips characters invalid on Windows/macOS
 * filesystems and collapses whitespace/repeated separators to a single "_".
 */
function sanitizeForFilename(value: string | undefined, fallback: string): string {
  const cleaned = (value || '').trim().replace(/[<>:"/\\|?*\s]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '')
  return cleaned || fallback
}

/**
 * Same as `sanitizeForFilename`, plus replaces dots with "V" (e.g. "1.0" ->
 * "1V0"). A revision string is the one field that routinely contains a raw
 * version number — a dot mid-filename reads to Windows Explorer as another
 * extension boundary, which can misdetect/hide the real `.zip`/`.gerber`
 * extension on some configurations. Only applied to `revision`, not the
 * other sanitized fields (customer/PCB name), which don't carry this risk.
 */
function sanitizeVersionForFilename(value: string | undefined, fallback: string): string {
  return sanitizeForFilename(value, fallback).replace(/\./g, 'V')
}

/**
 * Generate a descriptive layer name based on type and side.
 * This ensures exported Gerber files have readable names instead of standard abbreviations.
 */
function generateDescriptiveLayerName(layerFile: LayerFile): string {
  const { type, side, name } = layerFile

  if (type === 'copper') {
    if (side === 'top') return 'Top_Copper'
    if (side === 'bottom') return 'Bottom_Copper'
    return 'Copper'
  } else if (type === 'mask') {
    if (side === 'top') return 'Top_Mask'
    if (side === 'bottom') return 'Bottom_Mask'
    return 'Mask'
  } else if (type === 'silk') {
    if (side === 'top') return 'Top_Silk'
    if (side === 'bottom') return 'Bottom_Silk'
    return 'Silk'
  } else if (type === 'paste') {
    if (side === 'top') return 'Top_Paste'
    if (side === 'bottom') return 'Bottom_Paste'
    return 'Paste'
  } else if (type === 'fab') {
    return 'Fab'
  } else if (type === 'drill') {
    return 'Drill'
  } else if (type === 'outline') {
    return 'Outline'
  }

  // Fallback to original name for 'other' types
  return name
}

/**
 * Export all panelized Gerber files as a ZIP download.
 */
export async function exportPanelizedGerbers(
  layers: LayerFile[],
  panel: PanelResult,
  config: PanelConfig,
  info?: PanelInfo,
  outputFormat?: OutputFormat,
  /** Router tool paths, when the Routing tab has generated a plan. Optional so
   *  every existing caller is unaffected. */
  routing?: RoutingResult | null,
  /** Meta-panelization (multi-panel-array CNC batch) files, when the G-Code
   *  tab's array section has generated them. Optional so every existing
   *  caller is unaffected. Written into their own `Meta-Panelization/`
   *  subfolder rather than mixed in with the single panel's own layers. */
  metaPanel?: { borderMarksGerberFilename: string; borderMarksGerber: string; drillFilename: string; drillContent: string } | null
): Promise<void> {
  // Clone: the auto-upgrade below writes fmt.integerDigits, and callers pass
  // the store's outputFormat object straight in — mutating it would compound
  // across exports.
  const fmt: OutputFormat = { ...(outputFormat || DEFAULT_OUTPUT_FORMAT) }

  // Auto-fix output format: ensure integer digits are sufficient for panel dimensions.
  // If not, silently upgrade to prevent coordinate truncation (which would cause
  // panel copies to overlap or shift incorrectly).
  const neededDigits = autoDetectIntegerDigits(panel.panelWidth, panel.panelHeight, fmt.unit)
  if (fmt.integerDigits < neededDigits) {
    fmt.integerDigits = neededDigits
    console.warn(`[Export] Auto-upgraded Gerber format to ${neededDigits}.${fmt.decimalDigits} to prevent coordinate truncation`)
  }

  // Every layer belongs to a design — callers that have never heard of
  // designs (or a single-design panel) get one synthetic id, so every
  // computation below (which is now always PER-DESIGN) reduces to exactly
  // today's single global computation in that case.
  const layersWithDesignId = layers.map(l => ({ ...l, designId: l.designId ?? '__default__' }))
  const designIds = [...new Set(layersWithDesignId.map(l => l.designId))]

  // CRITICAL: Compute a UNIFORM base offset PER DESIGN from the layer that
  // sizes that design — explicit 'outline' first, else the largest visible
  // layer. All of one design's layers must use that SAME offset so they
  // align perfectly in the panel; a different design has its own unrelated
  // native-coordinate origin and must never share another design's offset.
  // Shared with `computePanelResult`/`generateGcodeFilesAction`/
  // `generatePanelArrayFilesAction` via `resolveDesignGeometry` so all four
  // agree — see that function's own docs.
  const baseOffsetByDesign = new Map<string, BaseOffset>()
  // Per-design L-shape-mark eligibility — a rectangular design sharing a
  // merged file with a non-rectangular one must not lose its own marks, so
  // this is never a single panel-wide flag (see the D-code/macro remap
  // section in CLAUDE.md).
  const effectiveConfigByDesign = new Map<string, PanelConfig>()
  for (const designId of designIds) {
    const designLayers = layersWithDesignId.filter(l => l.designId === designId)
    const geometry = resolveDesignGeometry(designLayers)
    if (geometry) {
      baseOffsetByDesign.set(designId, geometry.datum)
      console.log(`[Export] Design "${designId}" base offset from ${geometry.fromFallback ? 'largest-area fallback layer' : 'outline'}: (${geometry.datum.x.toFixed(3)}, ${geometry.datum.y.toFixed(3)})`)
    } else {
      console.warn(`[Export] Design "${designId}" has no layer with usable bounds — its layers will use their own bounds for offset (may cause misalignment)`)
    }

    const outlineLayer = designLayers.find(l => l.type === 'outline' && l.parsedLayer?.bounds)
    let outlineIsRectangular = false
    if (config.enableLShapeMarks && outlineLayer?.parsedLayer) {
      outlineIsRectangular = isRectangularOutline(outlineLayer.parsedLayer)
      if (!outlineIsRectangular) {
        console.warn(`[Export] Design "${designId}" outline is not rectangular — skipping its L-shape marks`)
      }
    }
    effectiveConfigByDesign.set(designId, outlineIsRectangular ? config : { ...config, enableLShapeMarks: false })
  }
  // Kept for the drill export below and as the single-design fallback.
  const globalBaseOffset: BaseOffset | undefined = baseOffsetByDesign.get(designIds[0])

  const zip = new JSZip()
  const folder = zip.folder('panelized_gerbers')
  if (!folder) throw new Error('Failed to create ZIP folder')

  // File-naming fields: PartNumber_CustomerName_Version_Date_Panel.zip for the
  // archive, PartNumber_LayerName.gerber for each file inside it.
  const partNumber = sanitizeForFilename(info?.pcbName, 'PCB')
  const customerName = sanitizeForFilename(info?.customerRef, 'Customer')
  const version = sanitizeVersionForFilename(info?.revision, 'v1')
  const dateStr = sanitizeForFilename(info?.date, formatPanelDate())

  // Generate panel outline with 0.1mm width
  const outlineGerber = generatePanelOutlineGerber(panel, { ...config, panelBorderWidth: 0.1 }, fmt)
  folder.file(`${partNumber}_Panel_Border.gerber`, outlineGerber)

  // V-score documentation layer (full-length score lines + rib marks), when
  // enabled and the panel actually has computed score lines.
  if (config.enableVScoreLayer && panel.vScoreLines.length > 0) {
    const vScoreGerber = generateVScoreGerber(panel, config, fmt)
    folder.file(`${partNumber}_VScore.gerber`, vScoreGerber)
  }

  // Routing (router tool paths + mouse bites), when a plan has been generated
  writeRouteFiles(folder, partNumber, routing, config, panel, fmt)

  // Meta-panelization (multi-panel-array CNC batch drilling), when the
  // G-Code tab's array section has generated it. Own subfolder — these files
  // describe the WHOLE SHEET of tiled panel copies, a different coordinate
  // space than every other file in this ZIP (which are all single-panel).
  if (metaPanel) {
    const metaFolder = folder.folder('Meta-Panelization')
    if (metaFolder) {
      metaFolder.file(metaPanel.borderMarksGerberFilename, metaPanel.borderMarksGerber)
      metaFolder.file(metaPanel.drillFilename, metaPanel.drillContent)
    }
  }

  // Generate panelized drill file with user-selected drill format
  // Always generate drill file when there are drill layers OR tooling/reference holes are enabled
  //
  // ⚠ Only designs that actually have PLACEMENTS on this panel contribute
  // drill layers. A design with zero placements (a packed candidate that
  // dropped it, or a design hidden by single mode) otherwise still folds its
  // tool diameters into the Excellon tool table AND emits one dangling bare
  // `Tnn` line per flash — `generatePanelizedDrill` pushes the T-code before
  // looping the (empty) position list. The Gerber merge path already skips
  // zero-placement designs (see the merge-group loop below); this brings the
  // drill path in line. Byte-identical for every single-design export, whose
  // one design always has placements.
  const drillLayers = layersWithDesignId
    .filter(l => l.type === 'drill')
    .filter(l => panel.designs.length === 0 || panel.placements.some(p => p.designId === l.designId))
  if (drillLayers.length > 0 || config.enableToolingHoles) {
    // Mouse bites are folded in only when the user asked for it; by default they
    // go to their own file so this output stays byte-identical to before.
    const extraHoles =
      routing && routing.config.mouseBiteInMainDrill ? collectMouseBiteHoles(routing) : undefined
    const drillContent = generatePanelizedDrill(drillLayers, panel, config, globalBaseOffset, extraHoles, baseOffsetByDesign)
    folder.file(`${partNumber}_Drill.drl`, drillContent)
  }

  // Generate PINN.drl file with only tooling and reference holes
  if (config.enableToolingHoles) {
    const pinnContent = generatePINNDrill(panel, config)
    folder.file(`${partNumber}_PINN.drl`, pinnContent)
  }

  // ---- Merge + export each Gerber layer type/side across every design ----
  // Two designs each contributing e.g. a "Top_Copper" layer merge into ONE
  // output file — that IS the point of panelizing them together, one panel
  // has one Top_Copper. The merge key is the exact output filename fragment
  // (generateDescriptiveLayerName), which mirrors — byte for byte — the
  // collision behavior this loop already had for a SINGLE design with two
  // layers of the same type/side (e.g. two inner-copper layers both
  // classifying side:'none'): whichever LayerFile comes last in array order
  // wins that design's contribution to the group, exactly like the old
  // `folder.file()` call overwriting a previous one of the same name. Real
  // multi-layer stackups aren't disambiguated (see the "no stackup checking"
  // decision this feature is built on) — only surfaced via a console.warn.
  interface MergeGroup {
    descriptiveName: string
    layerType: LayerFile['type']
    layerSide?: LayerFile['side']
    perDesign: Map<string, LayerFile & { designId: string }>
  }
  const mergeGroups = new Map<string, MergeGroup>()
  for (const layerFile of layersWithDesignId) {
    if (!layerFile.parsedLayer || !layerFile.parsedLayer.bounds) continue
    if (layerFile.type === 'drill') continue

    const descriptiveName = generateDescriptiveLayerName(layerFile)
    let group = mergeGroups.get(descriptiveName)
    if (!group) {
      group = { descriptiveName, layerType: layerFile.type, layerSide: layerFile.side, perDesign: new Map() }
      mergeGroups.set(descriptiveName, group)
    }
    if (group.perDesign.has(layerFile.designId)) {
      console.warn(`[Export] Design "${layerFile.designId}" contributes multiple layers to merge group "${descriptiveName}" — using the last one (${layerFile.name}); multi-layer stackups (e.g. inner copper) aren't disambiguated.`)
    }
    group.perDesign.set(layerFile.designId, layerFile)
  }

  // designIds order = layer-array order (first appearance), used only as a
  // fallback when `panel.designs` doesn't know about a design (shouldn't
  // happen in practice — panel.designs is built from the same store designs
  // list these layers were tagged from — but a merge must never silently
  // drop a contributor over an ordering mismatch).
  const designOrder = panel.designs.length > 0 ? panel.designs.map(d => d.designId) : designIds
  for (const id of designIds) if (!designOrder.includes(id)) designOrder.push(id)

  for (const group of mergeGroups.values()) {
    const contributors: GerberExportContributor[] = []
    for (const designId of designOrder) {
      const layerFile = group.perDesign.get(designId)
      if (!layerFile?.parsedLayer) continue
      const placements = panel.placements.filter(p => p.designId === designId)
      if (placements.length === 0) continue
      const baseOffset = baseOffsetByDesign.get(designId)
      if (!baseOffset) continue
      const effectiveConfig = effectiveConfigByDesign.get(designId) ?? config
      contributors.push({ parsedLayer: layerFile.parsedLayer, rawContent: layerFile.content, baseOffset, placements, effectiveConfig })
    }
    if (contributors.length === 0) continue
    if (contributors.length > 1) {
      console.log(`[Export] Merge group "${group.descriptiveName}": ${contributors.length} contributing designs`)
    }

    try {
      const panelized = generateMergedPanelizedGerber(contributors, panel, config, fmt, group.layerType, group.layerSide)
      const outName = `${partNumber}_${group.descriptiveName}.gerber`
      folder.file(outName, panelized)
    } catch (e) {
      console.warn(`Failed to panelize merge group ${group.descriptiveName}:`, e)
    }
  }

  // Add README
  const readme = generateReadme(panel, config, info, layers, fmt, routing)
  folder.file('README.txt', readme)

  // Generate and download ZIP
  const blob = await zip.generateAsync({ type: 'blob' })
  saveAs(blob, `${partNumber}_${customerName}_${version}_${dateStr}_Panel.zip`)
}

/**
 * Write the routing outputs into an existing ZIP folder.
 *
 * Shared by the full panel export and the route-only export so the two can
 * never produce different route files for the same plan.
 */
function writeRouteFiles(
  folder: JSZip,
  partNumber: string,
  routing: RoutingResult | null | undefined,
  config: PanelConfig,
  panel: PanelResult,
  fmt: OutputFormat
): void {
  if (!routing || routing.paths.length === 0) return

  folder.file(`${partNumber}_Route.gerber`, generateRouteGerber(routing, fmt))
  folder.file(`${partNumber}_Route.rou`, generateRoutFile(routing, config.drillFormat, panel))

  // Own file unless the user folded the bites into the main drill program.
  if (!routing.config.mouseBiteInMainDrill) {
    const bites = generateMouseBiteDrill(routing, config.drillFormat, panel)
    if (bites) folder.file(`${partNumber}_MouseBites.drl`, bites)
  }
}

/**
 * Route-only ZIP, for iterating on bit size from the Routing tab without
 * re-zipping a dozen panelized layers each time.
 */
export async function exportRoutingFiles(
  routing: RoutingResult,
  config: PanelConfig,
  panel: PanelResult,
  info?: PanelInfo,
  outputFormat?: OutputFormat
): Promise<void> {
  const fmt: OutputFormat = { ...(outputFormat || DEFAULT_OUTPUT_FORMAT) }

  const neededDigits = autoDetectIntegerDigits(panel.panelWidth, panel.panelHeight, fmt.unit)
  if (fmt.integerDigits < neededDigits) fmt.integerDigits = neededDigits

  const partNumber = sanitizeForFilename(info?.pcbName, 'PCB')
  const customerName = sanitizeForFilename(info?.customerRef, 'Customer')
  const version = sanitizeVersionForFilename(info?.revision, 'v1')
  const dateStr = sanitizeForFilename(info?.date, formatPanelDate())

  const zip = new JSZip()
  const folder = zip.folder('routing')
  if (!folder) throw new Error('Failed to create ZIP folder')

  writeRouteFiles(folder, partNumber, routing, config, panel, fmt)
  folder.file('README.txt', generateRoutingReadme(routing, fmt))

  const blob = await zip.generateAsync({ type: 'blob' })
  saveAs(blob, `${partNumber}_${customerName}_${version}_${dateStr}_Route.zip`)
}

/**
 * Meta-panelization-only ZIP — the Border_Marks Gerber, the batch-tiled
 * Excellon drill file, and the mark-routing/batch-drilling G-code, all in one
 * download for the CNC batch-drilling workflow (see `panel-array.ts`'s file
 * header). The SAME files also ride along inside the main panel export's
 * `Meta-Panelization/` subfolder (via `exportPanelizedGerbers`'s `metaPanel`
 * param) — this is a standalone download for iterating on just the array
 * config without re-zipping every panelized layer each time, mirroring the
 * existing `exportRoutingFiles`/`exportGcodeFiles` precedent of multiple
 * export granularities.
 */
export async function exportMetaPanelFiles(
  files: {
    borderMarksGerberFilename: string
    borderMarksGerber: string
    drillFilename: string
    drillContent: string
    gcodeFiles: GcodeFile[]
    mirroredX?: boolean
  },
  info?: PanelInfo
): Promise<void> {
  const partNumber = sanitizeForFilename(info?.pcbName, 'PCB')
  const customerName = sanitizeForFilename(info?.customerRef, 'Customer')
  const version = sanitizeVersionForFilename(info?.revision, 'v1')
  const dateStr = sanitizeForFilename(info?.date, formatPanelDate())

  const zip = new JSZip()
  const folder = zip.folder('meta_panelization')
  if (!folder) throw new Error('Failed to create ZIP folder')

  folder.file(files.borderMarksGerberFilename, files.borderMarksGerber)
  folder.file(files.drillFilename, files.drillContent)
  for (const f of files.gcodeFiles) folder.file(f.filename, f.content)

  const lines: string[] = []
  lines.push('=== Meta-Panelization (Multi-Panel Array CNC Batch) ===')
  lines.push('')
  lines.push(`Generated: ${new Date().toISOString()}`)
  lines.push('')
  lines.push('1. Rout the border-mark G-code into a blank sacrificial spoiler board.')
  lines.push('2. Place each already-fabricated panel copy on the bed, registering its')
  lines.push('   corners against the scored marks, and tape it down.')
  lines.push('3. Run the batch drilling G-code (or the Excellon .drl on your own CAM/CNC')
  lines.push('   post) to drill every copy\'s component + tooling holes in one pass.')
  lines.push('')
  lines.push('Depaneling each copy into individual PCBs is a separate, later, per-panel')
  lines.push('step through the normal Routing tab — this batch only covers alignment')
  lines.push('marks and drilling.')
  lines.push('')
  if (files.mirroredX) {
    lines.push('*** DRILLING IS MIRRORED (copper-up) ***')
    lines.push('The border marks below are identical either way — they alone do not tell')
    lines.push('you this file is mirrored. Drill with the panel copper-side UP.')
    lines.push('')
  }
  lines.push('--- Files ---')
  lines.push(files.borderMarksGerberFilename)
  lines.push(files.drillFilename)
  for (const f of files.gcodeFiles) lines.push(f.filename)
  folder.file('README.txt', lines.join('\n'))

  const blob = await zip.generateAsync({ type: 'blob' })
  saveAs(blob, `${partNumber}_${customerName}_${version}_${dateStr}_MetaPanel.zip`)
}

/**
 * G-code-only ZIP, for downloading the generated LinuxCNC programs without
 * re-zipping the Gerber/route files each time.
 */
export async function exportGcodeFiles(
  gcodeFiles: GcodeFile[],
  info?: PanelInfo,
  /** Meta-panelization (multi-panel-array) G-code — border-mark routing +
   *  batch drilling — written into its own subfolder alongside the normal
   *  per-panel files. Optional so every existing caller is unaffected. */
  metaPanelGcodeFiles?: GcodeFile[] | null
): Promise<void> {
  const partNumber = sanitizeForFilename(info?.pcbName, 'PCB')
  const customerName = sanitizeForFilename(info?.customerRef, 'Customer')
  const version = sanitizeVersionForFilename(info?.revision, 'v1')
  const dateStr = sanitizeForFilename(info?.date, formatPanelDate())

  const zip = new JSZip()
  const folder = zip.folder('gcode')
  if (!folder) throw new Error('Failed to create ZIP folder')

  for (const f of gcodeFiles) folder.file(f.filename, f.content)

  if (metaPanelGcodeFiles && metaPanelGcodeFiles.length > 0) {
    const metaFolder = folder.folder('Meta-Panelization')
    if (metaFolder) {
      for (const f of metaPanelGcodeFiles) metaFolder.file(f.filename, f.content)
    }
  }

  const lines: string[] = []
  lines.push('=== G-Code Files ===')
  lines.push('')
  lines.push(`Generated: ${new Date().toISOString()}`)
  lines.push('Dialect: LinuxCNC (RS274NGC, named parameters, M64/M65 P0 pressure pad)')
  lines.push('')
  lines.push('One cutting program per router-bit diameter, one drilling program per distinct')
  lines.push('hole diameter (mouse bites and imported drill hits sharing a diameter are combined).')
  lines.push('LinuxCNC\'s manual tool change means separate programs per bit rather than')
  lines.push('mid-file T-code changes.')
  lines.push('')
  lines.push('--- Files ---')
  for (const f of gcodeFiles) lines.push(f.filename)
  if (metaPanelGcodeFiles && metaPanelGcodeFiles.length > 0) {
    lines.push('')
    lines.push('--- Meta-Panelization/ (multi-panel-array CNC batch) ---')
    for (const f of metaPanelGcodeFiles) lines.push(f.filename)
  }
  folder.file('README.txt', lines.join('\n'))

  const blob = await zip.generateAsync({ type: 'blob' })
  saveAs(blob, `${partNumber}_${customerName}_${version}_${dateStr}_GCode.zip`)
}

/**
 * Stencil-only ZIP — DXF paste apertures + scribe outline for laser-cutting
 * a solder-paste stencil, downloadable independently of the main panelized-
 * Gerber export. Mirrors exportRoutingFiles/exportGcodeFiles/
 * exportMetaPanelFiles's identical shape.
 */
export async function exportStencilFiles(
  stencilFiles: { filename: string; content: string }[],
  info?: PanelInfo
): Promise<void> {
  const partNumber = sanitizeForFilename(info?.pcbName, 'PCB')
  const customerName = sanitizeForFilename(info?.customerRef, 'Customer')
  const version = sanitizeVersionForFilename(info?.revision, 'v1')
  const dateStr = sanitizeForFilename(info?.date, formatPanelDate())

  const zip = new JSZip()
  const folder = zip.folder('stencil')
  if (!folder) throw new Error('Failed to create ZIP folder')

  for (const f of stencilFiles) folder.file(f.filename, f.content)

  const lines: string[] = []
  lines.push('=== SMD Solder-Paste Stencil (DXF) ===')
  lines.push('')
  lines.push(`Generated: ${new Date().toISOString()}`)
  lines.push('')
  lines.push('DXF R12 ASCII, millimetres, POLYLINE/VERTEX/SEQEND entities on layers')
  lines.push('APERTURES and (if included) OUTLINE. Import directly into your laser-cutter')
  lines.push('software (LightBurn, LaserGRBL, etc.) and cut from 0.15mm or 0.25mm Mylar/')
  lines.push('polyester sheet.')
  lines.push('')
  lines.push('Rounded/macro pad shapes (e.g. KiCad RoundRect) are reproduced as the convex')
  lines.push('hull of their resolved geometry — exact for any convex pad shape, which is the')
  lines.push('overwhelming majority of real paste apertures.')
  lines.push('')
  lines.push('--- Files ---')
  for (const f of stencilFiles) lines.push(f.filename)
  folder.file('README.txt', lines.join('\n'))

  const blob = await zip.generateAsync({ type: 'blob' })
  saveAs(blob, `${partNumber}_${customerName}_${version}_${dateStr}_Stencil.zip`)
}

/**
 * The routing section of a README. Shared by both exports.
 *
 * The tool-center sentence is load-bearing: a fab opening the route layer has no
 * way to tell a centerline path from a board-edge path, and guessing wrong
 * mis-sizes every board by the bit diameter.
 */
function routingReadmeLines(routing: RoutingResult): string[] {
  const c = routing.config
  const holeCount = routing.tabs.reduce((n, t) => n + t.holes.length, 0)
  const scopes = [
    c.routePanelOutline ? 'panel outline' : null,
    c.routeIndividualPcbs ? 'individual PCBs' : null,
  ].filter(Boolean).join(' + ') || 'none'

  const isContour = routing.pcbOutlineMode === 'contour'
  const cutoutCount = routing.paths.filter(p => p.role === 'pcb-cutout').length

  const lines: string[] = []
  lines.push('--- Routing ---')
  lines.push(`Router bit: ${c.bitDiameterMm} mm`)
  lines.push(`Scope: ${scopes}`)
  lines.push(`PCB outline: ${isContour ? 'traced board contour' : 'bounding box'}`)
  lines.push(`Passes: ${routing.paths.length}`)
  lines.push(`Total cut length: ${routing.totalPathLengthMm.toFixed(1)} mm`)
  if (c.routeIndividualPcbs) {
    lines.push(`Tab style: ${c.tabStyle}`)
    if (c.tabStyle !== 'none') {
      lines.push(`Tab width (uncut bridge): ${c.tabWidthMm} mm`)
      if (isContour) {
        lines.push(`Tabs around contour: ${c.tabsPerContour}   Total tabs: ${routing.tabs.length}`)
      } else {
        lines.push(`Tabs per edge: ${c.tabsPerEdge}   Total tabs: ${routing.tabs.length}`)
      }
      lines.push(`Path gap per tab: ${(c.tabWidthMm + c.bitDiameterMm).toFixed(3)} mm (tab width + bit diameter)`)
    }
    if (c.tabStyle === 'mousebite') {
      lines.push(`Mouse bites: ${holeCount} holes, ${c.mouseBiteHoleDiameterMm} mm dia at ${c.mouseBiteHolePitchMm} mm pitch`)
      lines.push(`Mouse-bite hole row is offset ${c.mouseBiteEdgeClearanceMm} mm outward from the true board edge (clear of the finished PCB, not straddling the cut line)`)
      lines.push(`Mouse-bite holes location: ${c.mouseBiteInMainDrill ? 'folded into the main drill file' : 'separate _MouseBites.drl'}`)
    }
    if (isContour) {
      lines.push(`Interior cutouts: ${c.routeInteriorCutouts ? `${cutoutCount} routed, cut BEFORE the outer profile on each PCB` : 'not routed'}`)
    } else {
      lines.push(`Shared-gap passes merged: ${c.mergeCoincidentPasses ? 'yes' : 'no'}`)
    }
  }
  lines.push('')
  lines.push('IMPORTANT: Route paths are TOOL-CENTER coordinates, offset outward from the')
  lines.push(`finished board edge by the bit radius (${(c.bitDiameterMm / 2).toFixed(4)} mm). Do not apply`)
  lines.push('cutter compensation again.')
  if (isContour) {
    lines.push('')
    lines.push(`PCB outline paths are FLATTENED POLYLINES (no arcs), chord tolerance ${c.contourToleranceMm} mm —`)
    lines.push('traced from the outline layer and offset by the bit radius. Interior cutouts')
    lines.push('are included in this package and are cut before the outer profile on each PCB,')
    lines.push('since the board must still be fully supported by the panel while interior')
    lines.push('features are milled.')
  }
  lines.push('')
  lines.push('NOTE: the .rou dialect is provisional — it has not yet been verified against a')
  lines.push('CAM350 rout export. Please confirm it against your router before production use.')
  return lines
}

function generateRoutingReadme(routing: RoutingResult, fmt: OutputFormat): string {
  const lines: string[] = []
  lines.push('=== Routing Files ===')
  lines.push('')
  lines.push(`Generated: ${new Date().toISOString()}`)
  lines.push(`Panel: ${routing.panelWidthMm.toFixed(1)} x ${routing.panelHeightMm.toFixed(1)} mm`)
  lines.push(`Gerber format: ${fmt.integerDigits}.${fmt.decimalDigits} ${fmt.unit === 'mm' ? 'metric' : 'imperial'}`)
  lines.push('')
  lines.push(...routingReadmeLines(routing))
  lines.push('')
  lines.push('--- Files ---')
  lines.push('*_Route.gerber   Router tool paths as a Gerber layer (documentation / CAM interchange)')
  lines.push('*_Route.rou      Excellon-format rout program with tool definitions')
  if (!routing.config.mouseBiteInMainDrill && routing.tabs.some(t => t.holes.length > 0)) {
    lines.push('*_MouseBites.drl Break-away perforation holes (NPTH)')
  }
  return lines.join('\n')
}



function generateReadme(
  panel: PanelResult,
  config: PanelConfig,
  info?: PanelInfo,
  layers?: LayerFile[],
  fmt?: OutputFormat,
  routing?: RoutingResult | null
): string {
  const format = fmt || DEFAULT_OUTPUT_FORMAT
  const lines: string[] = []
  lines.push('=== Panelized Gerber Package ===')
  lines.push('')
  lines.push(`Generated: ${new Date().toISOString()}`)
  lines.push('')
  lines.push('--- Output Format ---')
  lines.push(`Format: ${format.integerDigits}.${format.decimalDigits} (${format.integerDigits} integer + ${format.decimalDigits} decimal digits)`)
  lines.push(`Units: ${format.unit === 'mm' ? 'Metric (mm)' : 'English (inches)'}`)
  lines.push(`Zero Omission: ${format.zeroOmission}`)
  lines.push(`Coordinate Notation: ${format.notation}`)
  lines.push(`FS Command: ${generateFSCommand(format)}`)
  lines.push(`MO Command: ${generateMOCommand(format)}`)
  lines.push(`G-Code: ${generateGUnitCode(format)}`)
  lines.push('')
  lines.push('--- Panel Configuration ---')
  if (panel.designs.length > 1) {
    lines.push(`Designs: ${panel.designs.length} (${panel.source === 'pack' ? 'multi-design pack' : 'multi-design grid'})`)
    for (const d of panel.designs) {
      lines.push(`  - ${d.name}: ${d.widthMm.toFixed(2)} x ${d.heightMm.toFixed(2)} mm, qty ${d.count}`)
    }
  } else {
    lines.push(`PCB Size: ${(panel.designs[0]?.widthMm ?? 0).toFixed(2)} x ${(panel.designs[0]?.heightMm ?? 0).toFixed(2)} mm`)
  }
  lines.push(`Panel Size: ${panel.panelWidth.toFixed(2)} x ${panel.panelHeight.toFixed(2)} mm`)
  lines.push(`Layout: ${config.rows} rows x ${config.cols} columns`)
  lines.push(`Total PCBs: ${panel.totalPCBs}`)
  lines.push(`X Gap: ${config.gapX} mm`)
  lines.push(`Y Gap: ${config.gapY} mm`)
  lines.push(`Side Ribs: T=${config.sideRibTop} B=${config.sideRibBottom} L=${config.sideRibLeft} R=${config.sideRibRight} mm`)
  lines.push(`L-Shape Marks: ${config.enableLShapeMarks ? `Enabled (arm ${config.lShapeArmLength}mm, width ${config.lShapeLineWidth}mm)` : 'Disabled'}`)
  lines.push(`Tooling Holes: ${config.enableToolingHoles ? `Enabled (${config.toolingHoleDiameter}mm)` : 'Disabled'}`)
  lines.push(`Reference Holes: ${config.enableToolingHoles ? `Enabled (${config.referenceHoleDiameter}mm)` : 'Disabled'}`)
  lines.push(`Fiducials: ${config.enableFiducials ? `Enabled (⌀ Copper: ${config.fiducialDiameter}mm, ⌀ Mask: ${config.fiducialClearance}mm, Top: ${config.fiducialsTop !== false ? 'Yes' : 'No'}, Bottom: ${config.fiducialsBottom !== false ? 'Yes' : 'No'})` : 'Disabled'}`)
  if (config.enableVScoreMarks) {
    const internalCount = panel.vScoreLines.filter(l => l.kind === 'internal').length
    const railCount = panel.vScoreLines.filter(l => l.kind === 'rail').length
    lines.push(`V-Score Marks: Enabled (style ${config.vScoreMarkStyle}, size ${config.vScoreMarkSizeMm}mm, ${internalCount} internal / ${railCount} rail)`)
  } else {
    lines.push('V-Score Marks: Disabled')
  }
  lines.push('')
  lines.push('--- Drill Output Format ---')
  lines.push(`Format: ${config.drillFormat.integerDigits}:${config.drillFormat.decimalDigits}`)
  lines.push(`Units: ${config.drillFormat.unit === 'mm' ? 'Metric (mm)' : 'English (inches)'}`)
  lines.push(`Zero Suppression: ${config.drillFormat.zeroSuppression === 'none' ? 'None (fixed-width)' : config.drillFormat.zeroSuppression === 'leading' ? 'Leading Zero (LZ)' : 'Trailing Zero (TZ)'}`)
  lines.push('')

  if (routing && routing.paths.length > 0) {
    lines.push(...routingReadmeLines(routing))
    lines.push('')
  }

  if (info) {
    lines.push('--- PCB Information ---')
    lines.push(`PCB Name: ${info.pcbName}`)
    lines.push(`Customer Reference: ${info.customerRef}`)
    lines.push(`Date: ${info.date}`)
    lines.push(`Revision: ${info.revision}`)
    lines.push(`Layers: ${info.layers}`)
    lines.push('')
  }

  if (layers && layers.length > 0) {
    const partNumber = sanitizeForFilename(info?.pcbName, 'PCB')
    lines.push('--- Files ---')
    lines.push(`${partNumber}_Panel_Border.gerber - Panel outline (border only)`)
    if (config.enableVScoreLayer && panel.vScoreLines.length > 0) {
      lines.push(`${partNumber}_VScore.gerber - V-score alignment layer (score lines + rib marks)`)
    }
    const hasDrills = layers.some(l => l.type === 'drill')
    if (hasDrills) {
      lines.push(`${partNumber}_Drill.drl - Panelized drill file (Excellon)`)
    }
    if (routing && routing.paths.length > 0) {
      lines.push(`${partNumber}_Route.gerber - Router tool paths as a Gerber layer`)
      lines.push(`${partNumber}_Route.rou - Excellon-format rout program (provisional dialect)`)
      if (!routing.config.mouseBiteInMainDrill && routing.tabs.some(t => t.holes.length > 0)) {
        lines.push(`${partNumber}_MouseBites.drl - Break-away perforation holes (NPTH)`)
      }
    }
    // One line per MERGED output file, not per LayerFile — with 2+ designs,
    // several designs' LayerFiles collapse into the same output file (see
    // exportPanelizedGerbers' merge-group loop), so this must dedupe by the
    // same key that loop merges on or a 2-design panel would list
    // "Top_Copper.gerber" twice for one actual file.
    const seenNames = new Set<string>()
    for (const layer of layers) {
      const descriptiveName = generateDescriptiveLayerName(layer)
      if (seenNames.has(descriptiveName)) continue
      seenNames.add(descriptiveName)
      lines.push(`${partNumber}_${descriptiveName}.gerber - Panelized ${descriptiveName}`)
    }
    lines.push('')
  }

  return lines.join('\n')
}

/**
 * Generate a panelized Excellon drill file (.drl) from drill layer data.
 * Produces output matching CAM350's native drill format exactly.
 *
 * CAM350 reference format:
 *   M48
 *   METRIC,TZ
 *   VER,1
 *   FMAT,2
 *   T01C3.2F42B423S6H2000
 *   T02C1.702F42B423S6H2000
 *   DETECT,ON
 *   ATC,ON
 *   %
 *   T10
 *   X29300Y30800
 *   ...
 *   M30
 *
 * Key CAM350 requirements:
 * - NO comment lines between M48 and %
 * - TZ (trailing zero) suppression
 * - DETECT,ON and ATC,ON before %
 * - Tool defs include F/B/S/H parameters
 * - No G90/G05 in body
 * - M30 to end
 */
export function generatePINNDrill(
  panel: PanelResult,
  config: PanelConfig
): string {
  const drillFmt = resolveExportDrillFormat(config.drillFormat, panel, 'PINN Export')

  const lines: string[] = []

  // Header — matches CAM350's exact format: M48, UNIT+ZS, VER, FMAT
  const headerLines = generateDrillFormatHeader(drillFmt)
  lines.push(...headerLines)

  // Only include tooling and reference holes (not PCB drill holes)
  const toolDiameters: number[] = []
  const seenDiameters = new Set<number>()

  if (config.enableToolingHoles) {
    // Add tooling hole diameters
    if (!seenDiameters.has(config.toolingHoleDiameter)) {
      toolDiameters.push(config.toolingHoleDiameter)
      seenDiameters.add(config.toolingHoleDiameter)
    }
    // Add reference hole diameters
    if (!seenDiameters.has(config.referenceHoleDiameter)) {
      toolDiameters.push(config.referenceHoleDiameter)
      seenDiameters.add(config.referenceHoleDiameter)
    }
  }

  // Sort by diameter
  toolDiameters.sort((a, b) => a - b)

  lines.push(...emitExcellonToolBlock(toolDiameters, drillFmt))

  // Helper to get T-code for a diameter
  function getTCode(dia: number): string {
    const idx = toolDiameters.indexOf(dia)
    if (idx >= 0) return 'T' + (idx + 1).toString().padStart(2, '0')
    return 'T01'
  }

  const fmtCoord = (v: number) => formatDrillCoordinate(v, drillFmt)

  // Only tooling and reference holes (no PCB drill hits)
  if (config.enableToolingHoles) {
    const toolingByDia = new Map<number, PanelResult['toolingHoles']>()
    for (const hole of panel.toolingHoles) {
      if (!toolingByDia.has(hole.diameter)) {
        toolingByDia.set(hole.diameter, [])
      }
      toolingByDia.get(hole.diameter)!.push(hole)
    }

    for (const [dia, holes] of toolingByDia) {
      const tCode = getTCode(dia)
      lines.push(tCode)
      for (const hole of holes) {
        lines.push(`X${fmtCoord(hole.x)}Y${fmtCoord(hole.y)}`)
      }
    }
  }

  // End program — M30 only, no G05 (matching CAM350 reference)
  lines.push('M30')

  return lines.join('\n')
}

export function generatePanelizedDrill(
  drillLayers: LayerFile[],
  panel: PanelResult,
  config: PanelConfig,
  globalBaseOffset?: BaseOffset,
  /** Mouse-bite perforations, only when the user opted to fold them in here
   *  rather than into their own file. Omitted by default, so this function's
   *  output stays byte-identical to before routing existed. */
  mouseBiteHoles?: { x: number; y: number; diameter: number }[],
  /** Per-design datum + placement scoping, keyed by `LayerFile.designId`.
   *  When provided, each drill layer is only stamped at ITS OWN design's
   *  placements using ITS OWN datum — never every design's, and never
   *  another design's offset. Omitted (or a layer's designId missing from
   *  the map) falls back to `globalBaseOffset` + every `panel.placements`,
   *  exactly today's single-design behavior — this parameter is purely
   *  additive. */
  perDesignBaseOffset?: Map<string, BaseOffset>
): string {
  const drillFmt = resolveExportDrillFormat(config.drillFormat, panel, 'Export')

  const lines: string[] = []

  // Header — matches CAM350's exact format: M48, UNIT+ZS, VER, FMAT
  const headerLines = generateDrillFormatHeader(drillFmt)
  lines.push(...headerLines)

  // Collect unique tool diameters from all drill layers (in mm)
  const toolDiameters: number[] = []
  const seenDiameters = new Set<number>()

  for (const dl of drillLayers) {
    if (!dl.parsedLayer || !dl.parsedLayer.apertures) continue
    for (const apt of dl.parsedLayer.apertures.values()) {
      const dia = extractDrillDiameter(apt)
      if (dia > 0 && !seenDiameters.has(dia)) {
        seenDiameters.add(dia)
        toolDiameters.push(dia)
      }
    }
  }

  // Add tooling hole diameters from panel config
  if (config.enableToolingHoles) {
    if (!seenDiameters.has(config.toolingHoleDiameter)) {
      toolDiameters.push(config.toolingHoleDiameter)
      seenDiameters.add(config.toolingHoleDiameter)
    }
    if (!seenDiameters.has(config.referenceHoleDiameter)) {
      toolDiameters.push(config.referenceHoleDiameter)
      seenDiameters.add(config.referenceHoleDiameter)
    }
  }

  // Mouse-bite diameters, only when the user folded them into this program
  if (mouseBiteHoles) {
    for (const h of mouseBiteHoles) {
      if (h.diameter > 0 && !seenDiameters.has(h.diameter)) {
        seenDiameters.add(h.diameter)
        toolDiameters.push(h.diameter)
      }
    }
  }

  // Sort by diameter
  toolDiameters.sort((a, b) => a - b)

  lines.push(...emitExcellonToolBlock(toolDiameters, drillFmt))

  // Helper to get T-code for a diameter
  function getTCode(dia: number): string {
    const idx = toolDiameters.indexOf(dia)
    if (idx >= 0) return 'T' + (idx + 1).toString().padStart(2, '0')
    return 'T01'
  }

  const fmtCoord = (v: number) => formatDrillCoordinate(v, drillFmt)

  // Drill hits from drill layers — repeat for each panel position
  for (const dl of drillLayers) {
    if (!dl.parsedLayer) continue

    for (const cmd of dl.parsedLayer.commands) {
      if (cmd.type === 'flash' && cmd.apertureCode !== null && cmd.coordinate) {
        const apt = dl.parsedLayer.apertures.get(cmd.apertureCode)
        if (!apt) continue
        const dia = extractDrillDiameter(apt)
        if (dia <= 0) continue

        const tCode = getTCode(dia)
        // Emit T-code for each hit
        lines.push(tCode)

        // Generate coordinates for each panel position — this design's own
        // datum + own placements when perDesignBaseOffset is provided,
        // else today's single global offset + every placement.
        const designOffset = perDesignBaseOffset && dl.designId ? perDesignBaseOffset.get(dl.designId) : undefined
        const boX = designOffset ? designOffset.x : globalBaseOffset ? globalBaseOffset.x : (dl.parsedLayer.bounds ? -dl.parsedLayer.bounds.minX : 0)
        const boY = designOffset ? designOffset.y : globalBaseOffset ? globalBaseOffset.y : (dl.parsedLayer.bounds ? -dl.parsedLayer.bounds.minY : 0)
        const positions = perDesignBaseOffset && dl.designId ? panel.placements.filter(p => p.designId === dl.designId) : panel.placements

        for (const pos of positions) {
          const x = (cmd.coordinate.x || 0) + pos.x + boX
          const y = (cmd.coordinate.y || 0) + pos.y + boY
          lines.push(`X${fmtCoord(x)}Y${fmtCoord(y)}`)
        }
      }
    }
  }

  // Milled slots (Excellon G85) — same panel-position repeat as flash hits
  // above, but each slot needs BOTH endpoints translated, not just one
  // point. Kept as a separate pass because slots live outside `commands`
  // (see `DrillSlot`'s own docs in gerber-parser.ts) — folding them into
  // the flash loop above would require every reader of that loop to first
  // check "is this actually a slot", which is exactly the kind of silent
  // cross-contamination that design avoids.
  for (const dl of drillLayers) {
    if (!dl.parsedLayer?.drillSlots?.length) continue

    const designOffset = perDesignBaseOffset && dl.designId ? perDesignBaseOffset.get(dl.designId) : undefined
    const boX = designOffset ? designOffset.x : globalBaseOffset ? globalBaseOffset.x : (dl.parsedLayer.bounds ? -dl.parsedLayer.bounds.minX : 0)
    const boY = designOffset ? designOffset.y : globalBaseOffset ? globalBaseOffset.y : (dl.parsedLayer.bounds ? -dl.parsedLayer.bounds.minY : 0)
    const positions = perDesignBaseOffset && dl.designId ? panel.placements.filter(p => p.designId === dl.designId) : panel.placements

    for (const slot of dl.parsedLayer.drillSlots) {
      if (slot.diameterMm <= 0) continue
      const tCode = getTCode(slot.diameterMm)
      lines.push(tCode)
      for (const pos of positions) {
        const sx = slot.start.x + pos.x + boX
        const sy = slot.start.y + pos.y + boY
        const ex = slot.end.x + pos.x + boX
        const ey = slot.end.y + pos.y + boY
        lines.push(`X${fmtCoord(sx)}Y${fmtCoord(sy)}G85X${fmtCoord(ex)}Y${fmtCoord(ey)}`)
      }
    }
  }

  // Tooling and reference holes
  if (config.enableToolingHoles) {
    const toolingByDia = new Map<number, PanelResult['toolingHoles']>()
    for (const hole of panel.toolingHoles) {
      if (!toolingByDia.has(hole.diameter)) {
        toolingByDia.set(hole.diameter, [])
      }
      toolingByDia.get(hole.diameter)!.push(hole)
    }

    for (const [dia, holes] of toolingByDia) {
      const tCode = getTCode(dia)
      lines.push(tCode)
      for (const hole of holes) {
        lines.push(`X${fmtCoord(hole.x)}Y${fmtCoord(hole.y)}`)
      }
    }
  }

  // Mouse-bite perforations, grouped by diameter (coordinates already
  // panel-absolute, so they need no per-position offsetting)
  if (mouseBiteHoles && mouseBiteHoles.length > 0) {
    const bitesByDia = new Map<number, typeof mouseBiteHoles>()
    for (const h of mouseBiteHoles) {
      if (!bitesByDia.has(h.diameter)) bitesByDia.set(h.diameter, [])
      bitesByDia.get(h.diameter)!.push(h)
    }
    for (const [dia, holes] of bitesByDia) {
      lines.push(getTCode(dia))
      for (const h of holes) {
        lines.push(`X${fmtCoord(h.x)}Y${fmtCoord(h.y)}`)
      }
    }
  }

  // End program — M30 only, no G05 (matching CAM350 reference)
  lines.push('M30')

  return lines.join('\n')
}

/**
 * Meta-panelization batch drill file — the array-tiled equivalent of
 * `generatePanelizedDrill`, but built from already-collected, already-tiled
 * `{diameterMm, holes}[]`/`{diameterMm, slots}[]` groups (see
 * `tileHolesAcrossArray`/`tileSlotsAcrossArray` in `panel-array.ts`) instead
 * of walking `LayerFile[]` apertures directly — the caller (the store action)
 * has already merged the customer's own component holes with the panel's
 * tooling/reference holes by diameter, so this function only needs to know
 * about diameters and coordinates, not where they came from.
 */
export function generateMetaPanelDrill(
  holeGroups: { diameterMm: number; holes: { x: number; y: number }[] }[],
  slotGroups: { diameterMm: number; slots: { start: { x: number; y: number }; end: { x: number; y: number } }[] }[],
  drillFormat: DrillFormatConfig,
  panelArray: PanelArrayResult
): string {
  const drillFmt = resolveExportDrillFormat(
    drillFormat,
    { panelWidth: panelArray.sheetWidthMm, panelHeight: panelArray.sheetHeightMm },
    'Meta-Panel Export'
  )

  const lines: string[] = []
  lines.push(...generateDrillFormatHeader(drillFmt))

  const diameters = [...new Set([
    ...holeGroups.map(g => g.diameterMm),
    ...slotGroups.map(g => g.diameterMm),
  ])].sort((a, b) => a - b)
  lines.push(...emitExcellonToolBlock(diameters, drillFmt))

  const fmtCoord = (v: number) => formatDrillCoordinate(v, drillFmt)
  const getTCode = (dia: number): string => {
    const idx = diameters.indexOf(dia)
    return 'T' + (idx >= 0 ? idx + 1 : 1).toString().padStart(2, '0')
  }

  for (const g of holeGroups) {
    if (g.holes.length === 0) continue
    lines.push(getTCode(g.diameterMm))
    for (const h of g.holes) lines.push(`X${fmtCoord(h.x)}Y${fmtCoord(h.y)}`)
  }

  for (const g of slotGroups) {
    if (g.slots.length === 0) continue
    lines.push(getTCode(g.diameterMm))
    for (const s of g.slots) {
      lines.push(`X${fmtCoord(s.start.x)}Y${fmtCoord(s.start.y)}G85X${fmtCoord(s.end.x)}Y${fmtCoord(s.end.y)}`)
    }
  }

  lines.push('M30')
  return lines.join('\n')
}

/**
 * Panelized drill hole positions grouped by diameter, in panel-absolute mm.
 *
 * Extracted from the per-diameter loop inside `generatePanelizedDrill` so the
 * G-code layer (`routing/gcode.ts`) can drill the customer's own imported
 * holes — not just mouse bites — without duplicating the flash-command walk
 * or the panel-position repeat logic.
 */
export function collectPanelizedDrillHoles(
  drillLayers: LayerFile[],
  panel: PanelResult,
  globalBaseOffset?: BaseOffset
): { diameterMm: number; holes: { x: number; y: number }[] }[] {
  const byDia = new Map<number, { x: number; y: number }[]>()

  for (const dl of drillLayers) {
    if (!dl.parsedLayer) continue
    const boX = globalBaseOffset ? globalBaseOffset.x : (dl.parsedLayer.bounds ? -dl.parsedLayer.bounds.minX : 0)
    const boY = globalBaseOffset ? globalBaseOffset.y : (dl.parsedLayer.bounds ? -dl.parsedLayer.bounds.minY : 0)

    for (const cmd of dl.parsedLayer.commands) {
      if (cmd.type !== 'flash' || cmd.apertureCode === null || !cmd.coordinate) continue
      const apt = dl.parsedLayer.apertures.get(cmd.apertureCode)
      if (!apt) continue
      const dia = extractDrillDiameter(apt)
      if (dia <= 0) continue

      if (!byDia.has(dia)) byDia.set(dia, [])
      const holes = byDia.get(dia)!
      for (const pos of panel.placements) {
        holes.push({
          x: (cmd.coordinate.x || 0) + pos.x + boX,
          y: (cmd.coordinate.y || 0) + pos.y + boY,
        })
      }
    }
  }

  return [...byDia.entries()]
    .sort(([a], [b]) => a - b)
    .map(([diameterMm, holes]) => ({ diameterMm, holes }))
}

/**
 * Panelized drill SLOT positions grouped by diameter, in panel-absolute mm —
 * the slot equivalent of `collectPanelizedDrillHoles` above, for the same
 * reason (shared by the panelized Excellon drill file and the G-code layer,
 * without duplicating the panel-position repeat logic). Each slot carries
 * both its start and end point, translated together by the same offset.
 */
export function collectPanelizedDrillSlots(
  drillLayers: LayerFile[],
  panel: PanelResult,
  globalBaseOffset?: BaseOffset
): { diameterMm: number; slots: { start: { x: number; y: number }; end: { x: number; y: number } }[] }[] {
  const byDia = new Map<number, { start: { x: number; y: number }; end: { x: number; y: number } }[]>()

  for (const dl of drillLayers) {
    if (!dl.parsedLayer?.drillSlots?.length) continue
    const boX = globalBaseOffset ? globalBaseOffset.x : (dl.parsedLayer.bounds ? -dl.parsedLayer.bounds.minX : 0)
    const boY = globalBaseOffset ? globalBaseOffset.y : (dl.parsedLayer.bounds ? -dl.parsedLayer.bounds.minY : 0)

    for (const slot of dl.parsedLayer.drillSlots) {
      if (slot.diameterMm <= 0) continue
      if (!byDia.has(slot.diameterMm)) byDia.set(slot.diameterMm, [])
      const slots = byDia.get(slot.diameterMm)!
      for (const pos of panel.placements) {
        slots.push({
          start: { x: slot.start.x + pos.x + boX, y: slot.start.y + pos.y + boY },
          end: { x: slot.end.x + pos.x + boX, y: slot.end.y + pos.y + boY },
        })
      }
    }
  }

  return [...byDia.entries()]
    .sort(([a], [b]) => a - b)
    .map(([diameterMm, slots]) => ({ diameterMm, slots }))
}

/**
 * Extract drill diameter from a parsed Gerber aperture definition.
 * Uses the aperture's width field (diameter for circles).
 */
function extractDrillDiameter(apt: any): number {
  if (!apt) return 0
  // For circular apertures, width IS the diameter
  if (apt.shape === 'circle' && apt.width !== undefined && apt.width > 0) {
    return apt.width
  }
  // For other shapes, use width as fallback
  if (apt.width !== undefined && apt.width > 0) {
    return apt.width
  }
  return 0
}
