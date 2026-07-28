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
  generatePanelizedGerber,
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
} from './panelization-engine'
import { collectMouseBiteHoles, type RoutingResult } from './routing/types'
import { generateRouteGerber } from './routing/emit-gerber'
import { generateRoutFile, generateMouseBiteDrill } from './routing/emit-excellon'
import type { GcodeFile } from './routing/gcode'

export interface LayerFile {
  name: string
  fileName: string
  content: string // raw Gerber content
  parsedLayer: GerberLayer | null
  type: 'copper' | 'mask' | 'silk' | 'outline' | 'paste' | 'drill' | 'fab' | 'other'
  side?: 'top' | 'bottom' | 'none'
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
  routing?: RoutingResult | null
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

  // CRITICAL: Compute a UNIFORM base offset from the OUTLINE layer's bounds.
  // All layers must use this SAME offset so they align perfectly in the panel.
  // computePanel() uses the outline bounds for pcbWidth/pcbHeight, so the offset
  // must be derived from the same reference point.
  const outlineLayer = layers.find(l => l.type === 'outline' && l.parsedLayer?.bounds)
  let globalBaseOffset: BaseOffset | undefined
  if (outlineLayer?.parsedLayer?.bounds) {
    const ob = outlineLayer.parsedLayer.bounds
    globalBaseOffset = { x: -ob.minX, y: -ob.minY }
    console.log(`[Export] Global base offset from outline: (${globalBaseOffset.x.toFixed(3)}, ${globalBaseOffset.y.toFixed(3)})`)
  } else {
    console.warn(`[Export] No outline layer found — each layer will use its own bounds for offset (may cause misalignment)`)
  }

  // Check if PCB outline is rectangular for L-shape mark eligibility
  let outlineIsRectangular = false
  if (config.enableLShapeMarks && outlineLayer?.parsedLayer) {
    outlineIsRectangular = isRectangularOutline(outlineLayer.parsedLayer)
    if (!outlineIsRectangular) {
      console.warn('[Export] PCB outline is not rectangular — skipping L-shape marks')
    }
  }
  // Override config L-shape setting if outline is not rectangular
  const effectiveConfig: PanelConfig = outlineIsRectangular
    ? config
    : { ...config, enableLShapeMarks: false }

  const zip = new JSZip()
  const folder = zip.folder('panelized_gerbers')
  if (!folder) throw new Error('Failed to create ZIP folder')

  // File-naming fields: PartNumber_CustomerName_Version_Date_Panel.zip for the
  // archive, PartNumber_LayerName.gerber for each file inside it.
  const partNumber = sanitizeForFilename(info?.pcbName, 'PCB')
  const customerName = sanitizeForFilename(info?.customerRef, 'Customer')
  const version = sanitizeForFilename(info?.revision, 'v1')
  const dateStr = sanitizeForFilename(info?.date, new Date().toISOString().slice(0, 10))

  // Generate panel outline with 0.1mm width
  const outlineGerber = generatePanelOutlineGerber(panel, { ...config, panelBorderWidth: 0.1 }, fmt)
  folder.file(`${partNumber}_Panel_Border.gerber`, outlineGerber)

  // Routing (router tool paths + mouse bites), when a plan has been generated
  writeRouteFiles(folder, partNumber, routing, config, panel, fmt)

  // Generate panelized drill file with user-selected drill format
  // Always generate drill file when there are drill layers OR tooling/reference holes are enabled
  const drillLayers = layers.filter(l => l.type === 'drill')
  if (drillLayers.length > 0 || config.enableToolingHoles) {
    // Pass the Gerber output unit so drill format auto-syncs to prevent CAM350 scale mismatch
    // Mouse bites are folded in only when the user asked for it; by default they
    // go to their own file so this output stays byte-identical to before.
    const extraHoles =
      routing && routing.config.mouseBiteInMainDrill ? collectMouseBiteHoles(routing) : undefined
    const drillContent = generatePanelizedDrill(drillLayers, panel, config, globalBaseOffset, fmt.unit, extraHoles)
    folder.file(`${partNumber}_Drill.drl`, drillContent)
  }

  // Generate PINN.drl file with only tooling and reference holes
  if (config.enableToolingHoles) {
    const pinnContent = generatePINNDrill(panel, config, fmt.unit)
    folder.file(`${partNumber}_PINN.drl`, pinnContent)
  }

  // Panelize each layer using PARSED layer data
  for (const layerFile of layers) {
    if (!layerFile.parsedLayer || !layerFile.parsedLayer.bounds) continue
    if (layerFile.type === 'drill') continue

    try {
      // Use the new API: pass parsedLayer + rawContent + globalBaseOffset
      const panelized = generatePanelizedGerber(
        layerFile.parsedLayer,
        layerFile.content,
        panel,
        effectiveConfig,
        fmt,
        globalBaseOffset,
        layerFile.type,
        layerFile.side
      )
      // PartNumber_LayerName.gerber
      const descriptiveName = generateDescriptiveLayerName(layerFile)
      const outName = `${partNumber}_${descriptiveName}.gerber`
      folder.file(outName, panelized)
    } catch (e) {
      console.warn(`Failed to panelize ${layerFile.name}:`, e)
      folder.file(layerFile.fileName, layerFile.content)
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
  folder.file(`${partNumber}_Route.rou`, generateRoutFile(routing, config.drillFormat, panel, fmt.unit))

  // Own file unless the user folded the bites into the main drill program.
  if (!routing.config.mouseBiteInMainDrill) {
    const bites = generateMouseBiteDrill(routing, config.drillFormat, panel, fmt.unit)
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
  const version = sanitizeForFilename(info?.revision, 'v1')
  const dateStr = sanitizeForFilename(info?.date, new Date().toISOString().slice(0, 10))

  const zip = new JSZip()
  const folder = zip.folder('routing')
  if (!folder) throw new Error('Failed to create ZIP folder')

  writeRouteFiles(folder, partNumber, routing, config, panel, fmt)
  folder.file('README.txt', generateRoutingReadme(routing, fmt))

  const blob = await zip.generateAsync({ type: 'blob' })
  saveAs(blob, `${partNumber}_${customerName}_${version}_${dateStr}_Route.zip`)
}

/**
 * G-code-only ZIP, for downloading the generated LinuxCNC programs without
 * re-zipping the Gerber/route files each time.
 */
export async function exportGcodeFiles(
  gcodeFiles: GcodeFile[],
  info?: PanelInfo
): Promise<void> {
  const partNumber = sanitizeForFilename(info?.pcbName, 'PCB')
  const customerName = sanitizeForFilename(info?.customerRef, 'Customer')
  const version = sanitizeForFilename(info?.revision, 'v1')
  const dateStr = sanitizeForFilename(info?.date, new Date().toISOString().slice(0, 10))

  const zip = new JSZip()
  const folder = zip.folder('gcode')
  if (!folder) throw new Error('Failed to create ZIP folder')

  for (const f of gcodeFiles) folder.file(f.filename, f.content)

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
  folder.file('README.txt', lines.join('\n'))

  const blob = await zip.generateAsync({ type: 'blob' })
  saveAs(blob, `${partNumber}_${customerName}_${version}_${dateStr}_GCode.zip`)
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
  lines.push(`PCB Size: ${panel.pcbWidth.toFixed(2)} x ${panel.pcbHeight.toFixed(2)} mm`)
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
    for (const layer of layers) {
      const descriptiveName = generateDescriptiveLayerName(layer)
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
function generatePINNDrill(
  panel: PanelResult,
  config: PanelConfig,
  gerberUnit?: 'mm' | 'inches'
): string {
  const drillFmt = resolveExportDrillFormat(config.drillFormat, panel, gerberUnit, 'PINN Export')

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

function generatePanelizedDrill(
  drillLayers: LayerFile[],
  panel: PanelResult,
  config: PanelConfig,
  globalBaseOffset?: BaseOffset,
  gerberUnit?: 'mm' | 'inches',
  /** Mouse-bite perforations, only when the user opted to fold them in here
   *  rather than into their own file. Omitted by default, so this function's
   *  output stays byte-identical to before routing existed. */
  mouseBiteHoles?: { x: number; y: number; diameter: number }[]
): string {
  const drillFmt = resolveExportDrillFormat(config.drillFormat, panel, gerberUnit, 'Export')

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

        // Generate coordinates for each panel position
        const boX = globalBaseOffset ? globalBaseOffset.x : (dl.parsedLayer.bounds ? -dl.parsedLayer.bounds.minX : 0)
        const boY = globalBaseOffset ? globalBaseOffset.y : (dl.parsedLayer.bounds ? -dl.parsedLayer.bounds.minY : 0)

        for (const pos of panel.pcbPositions) {
          const x = (cmd.coordinate.x || 0) + pos.x + boX
          const y = (cmd.coordinate.y || 0) + pos.y + boY
          lines.push(`X${fmtCoord(x)}Y${fmtCoord(y)}`)
        }
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
      for (const pos of panel.pcbPositions) {
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
