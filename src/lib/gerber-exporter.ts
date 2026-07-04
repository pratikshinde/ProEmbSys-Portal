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
  DrillFormatConfig,
  autoDetectIntegerDigits,
  generatePanelOutlineGerber,
  generatePanelizedGerber,
  generateFSCommand,
  generateMOCommand,
  generateGUnitCode,
  formatCoordinate,
  formatDrillCoordinate,
  generateDrillFormatHeader,
  BaseOffset,
  isRectangularOutline,
} from './panelization-engine'

export interface LayerFile {
  name: string
  fileName: string
  content: string // raw Gerber content
  parsedLayer: GerberLayer | null
  type: 'copper' | 'mask' | 'silk' | 'outline' | 'paste' | 'drill' | 'fab' | 'other'
  side?: 'top' | 'bottom' | 'none'
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
  outputFormat?: OutputFormat
): Promise<void> {
  const fmt: OutputFormat = outputFormat || DEFAULT_OUTPUT_FORMAT

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

  // Generate panel outline with 0.1mm width
  const outlineGerber = generatePanelOutlineGerber(panel, { ...config, panelBorderWidth: 0.1 }, fmt)
  folder.file('panel_border.gerber', outlineGerber)



  // Generate panelized drill file with user-selected drill format
  // Always generate drill file when there are drill layers OR tooling/reference holes are enabled
  const drillLayers = layers.filter(l => l.type === 'drill')
  if (drillLayers.length > 0 || config.enableToolingHoles) {
    // Pass the Gerber output unit so drill format auto-syncs to prevent CAM350 scale mismatch
    const drillContent = generatePanelizedDrill(drillLayers, panel, config, globalBaseOffset, fmt.unit)
    folder.file('panel_drill.drl', drillContent)
  }

  // Generate PINN.drl file with only tooling and reference holes
  if (config.enableToolingHoles) {
    const pinnContent = generatePINNDrill(panel, config, fmt.unit)
    folder.file('PINN.drl', pinnContent)
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
      // Use a clean filename with descriptive layer name
      const ext = layerFile.fileName.endsWith('.gbr') ? '.gbr' : '.gerber'
      const descriptiveName = generateDescriptiveLayerName(layerFile)
      const outName = `panel_${descriptiveName}${ext}`
      folder.file(outName, panelized)
    } catch (e) {
      console.warn(`Failed to panelize ${layerFile.name}:`, e)
      folder.file(layerFile.fileName, layerFile.content)
    }
  }

  // Add README
  const readme = generateReadme(panel, config, info, layers, fmt)
  folder.file('README.txt', readme)

  // Generate and download ZIP
  const blob = await zip.generateAsync({ type: 'blob' })
  saveAs(blob, `panelized_${panel.totalPCBs}up_${new Date().toISOString().slice(0, 10)}.zip`)
}



function generateReadme(
  panel: PanelResult,
  config: PanelConfig,
  info?: PanelInfo,
  layers?: LayerFile[],
  fmt?: OutputFormat
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
  lines.push(`L-Shape Cuts: N/A`)
  lines.push(`Tooling Holes: ${config.enableToolingHoles ? `Enabled (${config.toolingHoleDiameter}mm)` : 'Disabled'}`)
  lines.push(`Reference Holes: ${config.enableToolingHoles ? `Enabled (${config.referenceHoleDiameter}mm)` : 'Disabled'}`)
  lines.push(`Fiducials: ${config.enableFiducials ? `Enabled (⌀ Copper: ${config.fiducialDiameter}mm, ⌀ Mask: ${config.fiducialClearance}mm, Top: ${config.fiducialsTop !== false ? 'Yes' : 'No'}, Bottom: ${config.fiducialsBottom !== false ? 'Yes' : 'No'})` : 'Disabled'}`)
  lines.push('')
  lines.push('--- Drill Output Format ---')
  lines.push(`Format: ${config.drillFormat.integerDigits}:${config.drillFormat.decimalDigits}`)
  lines.push(`Units: ${config.drillFormat.unit === 'mm' ? 'Metric (mm)' : 'English (inches)'}`)
  lines.push(`Zero Suppression: ${config.drillFormat.zeroSuppression === 'none' ? 'None (fixed-width)' : config.drillFormat.zeroSuppression === 'leading' ? 'Leading Zero (LZ)' : 'Trailing Zero (TZ)'}`)
  lines.push('')

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
    lines.push('--- Files ---')
    lines.push('panel_border.gerber - Panel outline (border only)')
    const hasDrills = layers.some(l => l.type === 'drill')
    if (hasDrills) {
      lines.push('panel_drill.drl - Panelized drill file (Excellon)')
    }
    for (const layer of layers) {
      const descriptiveName = generateDescriptiveLayerName(layer)
      lines.push(`panel_${descriptiveName}.gerber - Panelized ${descriptiveName}`)
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
  // Clone drill format so we can auto-fix integer digits if needed
  const drillFmt: DrillFormatConfig = { ...config.drillFormat }

  // CRITICAL: Sync drill unit with the Gerber output unit.
  // CAM350 may display Gerber and drill at different scales if units differ.
  if (gerberUnit && drillFmt.unit !== gerberUnit) {
    const prevUnit = drillFmt.unit
    drillFmt.unit = gerberUnit
    // When switching from inches to mm, increase decimal digits for adequate resolution
    if (prevUnit === 'inches' && gerberUnit === 'mm') {
      if (drillFmt.decimalDigits < 3) drillFmt.decimalDigits = 3
    }
    console.warn(`[PINN Export] Auto-synced drill unit from ${prevUnit} to ${gerberUnit} to match Gerber output`)
  }

  // Auto-fix drill format: ensure integer digits are sufficient for panel dimensions.
  const maxCoord = Math.max(panel.panelWidth, panel.panelHeight)
  const maxCoordInUnit = drillFmt.unit === 'mm' ? maxCoord : maxCoord / 25.4
  const neededIntDigits = maxCoordInUnit <= 0 ? 3 : Math.floor(Math.log10(maxCoordInUnit)) + 2
  if (drillFmt.integerDigits < neededIntDigits) {
    drillFmt.integerDigits = Math.min(neededIntDigits, 6)
    console.warn(`[PINN Export] Auto-upgraded drill format to ${drillFmt.integerDigits}:${drillFmt.decimalDigits}`)
  }

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

  // Tool definitions — T01C<diameter>F<feed>B<break>S<speed>H<peck>
  // CAM350 includes F/B/S/H parameters in tool definitions.
  // We use standard placeholder values that CAM350 recognizes:
  //   F = feed rate, B = board break, S = spindle speed, H = peck height
  const toolParams = drillFmt.unit === 'mm' ? 'F42B423S6H2000' : 'F100B1000S6H2000'
  for (let i = 0; i < toolDiameters.length; i++) {
    const tCode = (i + 1).toString().padStart(2, '0')
    let dia: number
    if (drillFmt.unit === 'mm') {
      dia = toolDiameters[i]
    } else {
      dia = toolDiameters[i] / 25.4
    }
    lines.push(`T${tCode}C${dia.toFixed(drillFmt.decimalDigits)}${toolParams}`)
  }

  // DETECT,ON and ATC,ON — required by CAM350, placed before %
  lines.push('DETECT,ON')
  lines.push('ATC,ON')

  // End of header
  lines.push('%')

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
  gerberUnit?: 'mm' | 'inches'
): string {
  // Clone drill format so we can auto-fix integer digits if needed
  const drillFmt: DrillFormatConfig = { ...config.drillFormat }

  // CRITICAL: Sync drill unit with the Gerber output unit.
  // CAM350 may display Gerber and drill at different scales if units differ.
  if (gerberUnit && drillFmt.unit !== gerberUnit) {
    const prevUnit = drillFmt.unit
    drillFmt.unit = gerberUnit
    // When switching from inches to mm, increase decimal digits for adequate resolution
    if (prevUnit === 'inches' && gerberUnit === 'mm') {
      if (drillFmt.decimalDigits < 3) drillFmt.decimalDigits = 3
    }
    console.warn(`[Export] Auto-synced drill unit from ${prevUnit} to ${gerberUnit} to match Gerber output`)
  }

  // Auto-fix drill format: ensure integer digits are sufficient for panel dimensions.
  const maxCoord = Math.max(panel.panelWidth, panel.panelHeight)
  const maxCoordInUnit = drillFmt.unit === 'mm' ? maxCoord : maxCoord / 25.4
  const neededIntDigits = maxCoordInUnit <= 0 ? 3 : Math.floor(Math.log10(maxCoordInUnit)) + 2
  if (drillFmt.integerDigits < neededIntDigits) {
    drillFmt.integerDigits = Math.min(neededIntDigits, 6)
    console.warn(`[Export] Auto-upgraded drill format to ${drillFmt.integerDigits}:${drillFmt.decimalDigits}`)
  }

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

  // Sort by diameter
  toolDiameters.sort((a, b) => a - b)

  // Tool definitions — T01C<diameter>F<feed>B<break>S<speed>H<peck>
  // CAM350 includes F/B/S/H parameters in tool definitions.
  // We use standard placeholder values that CAM350 recognizes:
  //   F = feed rate, B = board break, S = spindle speed, H = peck height
  const toolParams = drillFmt.unit === 'mm' ? 'F42B423S6H2000' : 'F100B1000S6H2000'
  for (let i = 0; i < toolDiameters.length; i++) {
    const tCode = (i + 1).toString().padStart(2, '0')
    let dia: number
    if (drillFmt.unit === 'mm') {
      dia = toolDiameters[i]
    } else {
      dia = toolDiameters[i] / 25.4
    }
    lines.push(`T${tCode}C${dia.toFixed(drillFmt.decimalDigits)}${toolParams}`)
  }

  // DETECT,ON and ATC,ON — required by CAM350, placed before %
  lines.push('DETECT,ON')
  lines.push('ATC,ON')

  // End of header
  lines.push('%')

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

  // End program — M30 only, no G05 (matching CAM350 reference)
  lines.push('M30')

  return lines.join('\n')
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
