/**
 * Panelization Engine
 * Computes panel layout, fiducials, tooling holes, L-shape tabs, and panel info.
 * Generates proper RS-274X Gerber output from parsed layer data.
 */

import { GerberLayer, GerberAperture } from './gerber-parser'
import { generateStrokeFontGerberCommands, layerNeedsTextShapes } from './stroke-font'
import { generateRegionTextGerberCommands, layerNeedsRegionText, measureRegionText } from './region-font'

// ============================================================================
// Output Format Configuration
// ============================================================================

/** Gerber unit system for output files */
export type OutputUnit = 'mm' | 'inches'

/** Zero omission mode — how unspecified digits are interpreted */
export type ZeroOmission = 'leading' | 'trailing' | 'none'

/** Coordinate notation mode */
export type CoordinateNotation = 'absolute' | 'incremental'

/**
 * Gerber output format specification.
 * Controls the format header written into exported Gerber files.
 *
 * KiCad default: 4.6 format, mm, leading zero omitted, absolute
 *   Header: %FSLAX46Y46*%  %MOMM*%  G71*
 *
 * Legacy CAM default: 2.4 format, inches, leading zero omitted, absolute
 *   Header: %FSLAX24Y24*%  %MOIN*%  G70*
 *
 * The FS command format is: %FS<L><A>X<int><dec>Y<int><dec>*%
 *   <L> = L (leading zero omit) or T (trailing zero omit)
 *   <A> = A (absolute) or I (incremental)
 */
export interface OutputFormat {
  /** Number of integer digits (before decimal). Common: 2, 3, 4, 5 */
  integerDigits: number
  /** Number of decimal digits (after decimal). Common: 3, 4, 5, 6 */
  decimalDigits: number
  /** Output unit system */
  unit: OutputUnit
  /** Zero omission: 'leading' or 'trailing' */
  zeroOmission: ZeroOmission
  /** Coordinate notation: 'absolute' or 'incremental' */
  notation: CoordinateNotation
}

export const DEFAULT_OUTPUT_FORMAT: OutputFormat = {
  integerDigits: 4,
  decimalDigits: 6,
  unit: 'mm',
  zeroOmission: 'leading',
  notation: 'absolute',
}

/**
 * Auto-detect the minimum integer digits needed for the given panel dimensions.
 * Ensures coordinates don't overflow the format.
 */
export function autoDetectIntegerDigits(
  panelWidth: number,
  panelHeight: number,
  unit: OutputUnit
): number {
  let maxCoord: number
  if (unit === 'mm') {
    maxCoord = Math.max(panelWidth, panelHeight)
  } else {
    maxCoord = Math.max(panelWidth, panelHeight) / 25.4
  }
  // Need enough integer digits to represent the largest coordinate
  if (maxCoord <= 0) return 4
  const needed = Math.floor(Math.log10(maxCoord)) + 2 // +1 for safety margin
  return Math.max(needed, 3) // minimum 3 integer digits
}

/**
 * Generate the Gerber FS (Format Specification) extended command.
 * Example output: %FSLAX46Y46*%
 */
export function generateFSCommand(format: OutputFormat): string {
  const zero = format.zeroOmission === 'leading' ? 'L' : format.zeroOmission === 'trailing' ? 'T' : ''
  const notation = format.notation === 'absolute' ? 'A' : 'I'
  const xi = format.integerDigits.toString()
  const xd = format.decimalDigits.toString()
  const yi = format.integerDigits.toString()
  const yd = format.decimalDigits.toString()
  return `%FS${zero}${notation}X${xi}${xd}Y${yi}${yd}*%`
}

/**
 * Generate the Gerber MO (Mode) extended command for units.
 * Example output: %MOMM*% or %MOIN*%
 */
export function generateMOCommand(format: OutputFormat): string {
  return format.unit === 'mm' ? '%MOMM*%' : '%MOIN*%'
}

/**
 * Generate the G-code for units.
 * G70 = inches, G71 = millimeters
 */
export function generateGUnitCode(format: OutputFormat): string {
  return format.unit === 'mm' ? 'G71*' : 'G70*'
}

/**
 * Format a numeric value (in mm) into a Gerber coordinate string
 * according to the specified output format.
 *
 * @param valueMm - The value in millimeters
 * @param format - The output format specification
 * @returns A string of digits with optional sign prefix (no decimal point)
 *
 * Examples:
 *   formatCoordinate(300.0, {integerDigits:4, decimalDigits:6, ...})
 *   → "300000000"  (300.000000 in 4.6 format, leading zero omit)
 *
 *   formatCoordinate(-298.88, {integerDigits:4, decimalDigits:6, ...})
 *   → "-298880000"  (-298.880000 in 4.6 format)
 */
export function formatCoordinate(valueMm: number, format: OutputFormat): string {
  // Convert mm to the target unit
  let value: number
  if (format.unit === 'mm') {
    value = valueMm
  } else {
    value = valueMm / 25.4
  }

  const totalDigits = format.integerDigits + format.decimalDigits

  // Scale to integer representation (multiply by 10^decimalDigits)
  const scaled = Math.round(value * Math.pow(10, format.decimalDigits))
  const isNegative = scaled < 0
  const absScaled = Math.abs(scaled)

  // Pad to total digits
  const padded = absScaled.toString().padStart(totalDigits, '0')

  // Truncate to total digits (in case of overflow)
  const truncated = padded.length > totalDigits
    ? padded.substring(padded.length - totalDigits)
    : padded

  if (format.zeroOmission === 'leading') {
    // Strip leading zeros, but keep at least one digit
    const stripped = truncated.replace(/^0+/, '') || '0'
    return isNegative ? `-${stripped}` : stripped
  } else {
    // Trailing zero omission: strip trailing zeros
    const stripped = truncated.replace(/0+$/, '') || '0'
    return isNegative ? `-${stripped}` : stripped
  }
}

/**
 * Format a numeric value (in mm) into an Excellon drill coordinate string
 * according to the specified drill format config.
 *
 * Excellon format differs from Gerber RS-274X format:
 * - No X/Y prefixes (just digits for each coordinate)
 * - Uses FMAT command to specify format
 * - Zero suppression: TZ (trailing zeros) or LZ (leading zeros)
 *
 * @param valueMm - The value in millimeters
 * @param drillFmt - The drill format configuration
 * @returns A string of digits formatted for Excellon
 */
/**
 * WARNING — opposite convention to the parser. `DrillZeroSuppressionMode` in
 * gerber-parser.ts names *which zeros were removed* from the file. Here
 * 'leading' (LZ) strips TRAILING zeros and 'trailing' (TZ) strips LEADING
 * zeros, because CAM350 inverts the meaning of the LZ/TZ header keywords.
 * The two do not collide today: exported drills carry an explicit header, and
 * the drill we hand the viewer is normalized to explicit decimals. Do not
 * "unify" the two conventions without re-testing the output in CAM350.
 */
export function formatDrillCoordinate(valueMm: number, drillFmt: DrillFormatConfig): string {
  // Convert mm to the target unit
  let value: number
  if (drillFmt.unit === 'mm') {
    value = valueMm
  } else {
    value = valueMm / 25.4
  }

  const totalDigits = drillFmt.integerDigits + drillFmt.decimalDigits

  // Scale to integer representation (multiply by 10^decimalDigits)
  const scaled = Math.round(value * Math.pow(10, drillFmt.decimalDigits))
  const isNegative = scaled < 0
  const absScaled = Math.abs(scaled)

  // Pad to total digits with zeros
  const padded = absScaled.toString().padStart(totalDigits, '0')

  // Truncate to total digits (in case of overflow)
  const truncated = padded.length > totalDigits
    ? padded.substring(padded.length - totalDigits)
    : padded

  if (drillFmt.zeroSuppression === 'none') {
    // No suppression: always output full fixed-width digits (safest for CAM350 compatibility)
    return isNegative ? `-${truncated}` : truncated
  } else if (drillFmt.zeroSuppression === 'leading') {
    // Leading zero suppression: strip leading zeros, keep at least one digit
    // NOTE: CAM350 inverts LZ/TZ meaning! When user selects 'leading' (LZ),
    // we write header as METRIC,LZ but we actually strip TRAILING zeros because
    // CAM350 interprets LZ as "strip trailing zeros" (opposite of standard).
    const stripped = truncated.replace(/0+$/, '') || '0'
    return isNegative ? `-${stripped}` : stripped
  } else {
    // Trailing zero suppression: strip trailing zeros
    // NOTE: CAM350 inverts LZ/TZ! When user selects 'trailing' (TZ),
    // we write header as METRIC,TZ but we actually strip LEADING zeros because
    // CAM350 interprets TZ as "strip leading zeros" (opposite of standard).
    const stripped = truncated.replace(/^0+/, '') || '0'
    return isNegative ? `-${stripped}` : stripped
  }
}

/**
 * Generate the Excellon FMAT (Format) command header.
 * Produces a CAM350-compatible header matching the exact format CAM350 exports.
 *
 * CAM350 reference format (mm):
 *   M48
 *   METRIC,TZ
 *   VER,1
 *   FMAT,2
 *   T01C3.2F42B423S6H2000
 *   DETECT,ON
 *   ATC,ON
 *   %
 *
 * CAM350 reference format (inches):
 *   M48
 *   INCH,TZ
 *   VER,1
 *   FMAT,2
 *   T01C0.125984F100B1000S6H2000
 *   DETECT,ON
 *   ATC,ON
 *   %
 *
 * IMPORTANT: No semicolon comments in the header between M48 and %.
 * CAM350 may misinterpret comment lines as commands.
 */
export function generateDrillFormatHeader(drillFmt: DrillFormatConfig): string[] {
  const lines: string[] = []
  lines.push('M48')
  // Unit and zero suppression command — MUST come first after M48
  // CAM350 behavior:
  //   - No suffix (just METRIC/INCH) = no zero suppression, all coordinates are fixed-width
  //   - TZ = CAM350 strips leading zeros (opposite of standard Excellon TZ!)
  //   - LZ = CAM350 strips trailing zeros (opposite of standard Excellon LZ!)
  if (drillFmt.zeroSuppression === 'none') {
    // No zero suppression — safest option, all coordinates are full fixed-width
    if (drillFmt.unit === 'mm') {
      lines.push('METRIC')
    } else {
      lines.push('INCH')
    }
  } else {
    // CAM350-inverted LZ/TZ: we write the label the user expects,
    // but the coordinate formatting is already swapped (see formatDrillCoordinate)
    const zs = drillFmt.zeroSuppression === 'leading' ? 'LZ' : 'TZ'
    if (drillFmt.unit === 'mm') {
      lines.push(`METRIC,${zs}`)
    } else {
      lines.push(`INCH,${zs}`)
    }
  }
  // VER command — Excellon version
  lines.push('VER,1')
  // FMAT command — legacy Excellon format specification
  lines.push('FMAT,2')
  return lines
}

// ============================================================================
// Aperture Definition Extraction
// ============================================================================

/**
 * Extract aperture macro definitions (AM blocks) from raw Gerber content.
 * These blocks define complex shapes used by macro apertures.
 */
function extractMacroDefinitions(rawContent: string): string[] {
  const macros: string[] = []
  // Match %AM<name>*...*% blocks — they start with %AM and end with *%
  // Name can contain letters, digits, underscores, and hyphens (CAM350 uses hyphens)
  const regex = /%AM[A-Za-z0-9_-]+\*[^%]*\*%/g
  let match
  while ((match = regex.exec(rawContent)) !== null) {
    macros.push(match[0])
  }
  return macros
}

/**
 * Generate aperture definition commands (%ADD...) from parsed aperture data.
 * Uses the already unit-converted dimensions from the parsed layer,
 * so the output always matches the MO unit in the Gerber header.
 */
function generateApertureDefinitions(apertures: Map<number, GerberAperture>): string[] {
  const adds: string[] = []
  // Sort by aperture code for consistent output
  const sorted = Array.from(apertures.entries()).sort((a, b) => a[0] - b[0])

  for (const [code, ap] of sorted) {
    switch (ap.shape) {
      case 'circle': {
        let params = ap.width !== undefined ? ap.width.toFixed(6) : '0.000000'
        if (ap.holeDiameter !== undefined) {
          params += `X${ap.holeDiameter.toFixed(6)}`
        }
        adds.push(`%ADD${code}C,${params}*%`)
        break
      }
      case 'rectangle': {
        let params = ap.width !== undefined ? ap.width.toFixed(6) : '0.000000'
        if (ap.height !== undefined) {
          params += `X${ap.height.toFixed(6)}`
        }
        if (ap.holeDiameter !== undefined) {
          params += `X${ap.holeDiameter.toFixed(6)}`
        }
        if (ap.rotation !== undefined && ap.rotation !== 0) {
          params += `X${ap.rotation.toFixed(1)}`
        }
        adds.push(`%ADD${code}R,${params}*%`)
        break
      }
      case 'obround': {
        let params = ap.width !== undefined ? ap.width.toFixed(6) : '0.000000'
        if (ap.height !== undefined) {
          params += `X${ap.height.toFixed(6)}`
        }
        if (ap.holeDiameter !== undefined) {
          params += `X${ap.holeDiameter.toFixed(6)}`
        }
        if (ap.rotation !== undefined && ap.rotation !== 0) {
          params += `X${ap.rotation.toFixed(1)}`
        }
        adds.push(`%ADD${code}O,${params}*%`)
        break
      }
      case 'polygon': {
        let params = ap.width !== undefined ? ap.width.toFixed(6) : '0.000000'
        if (ap.height !== undefined) {
          params += `X${ap.height.toFixed(6)}`
        }
        if (ap.rotation !== undefined && ap.rotation !== 0) {
          params += `X${ap.rotation.toFixed(1)}`
        }
        adds.push(`%ADD${code}P,${params}*%`)
        break
      }
      case 'macro': {
        // Macro apertures — reference the macro name with parameters
        const name = ap.macroName || 'UNKNOWN'
        const paramParts: string[] = []
        if (ap.parameters) {
          // Parameters are stored as $1, $2, etc.
          const keys = Object.keys(ap.parameters).sort()
          for (const key of keys) {
            paramParts.push(ap.parameters[key].toFixed(6))
          }
        }
        const paramStr = paramParts.length > 0 ? paramParts.join('X') : ''
        adds.push(`%ADD${code}${name},${paramStr}*%`)
        break
      }
    }
  }
  return adds
}

// ============================================================================
// Panel Configuration Types
// ============================================================================

/** Drill output format preset names */
export type DrillFormatPreset = 'excellon-2-4' | 'excellon-3-3' | 'excellon-2-5' | 'excellon-3-4' | 'custom'

/** Drill zero suppression mode */
export type DrillZeroSuppression = 'none' | 'leading' | 'trailing'

/** Drill output format configuration — each field is independently configurable */
export interface DrillFormatConfig {
  /** Format preset name (for quick selection) */
  preset: DrillFormatPreset
  /** Number of integer digits before decimal. Common: 2, 3 */
  integerDigits: number
  /** Number of decimal digits after decimal. Common: 3, 4, 5 */
  decimalDigits: number
  /** Drill output unit */
  unit: 'mm' | 'inches'
  /** Zero suppression mode: 'none' = always output full fixed-width digits (safest for CAM350) */
  zeroSuppression: DrillZeroSuppression
}

/** Preset definitions — maps preset name to its format parameters */
export const DRILL_FORMAT_PRESETS: Record<DrillFormatPreset, Omit<DrillFormatConfig, 'preset'>> = {
  'excellon-2-4': { integerDigits: 2, decimalDigits: 4, unit: 'inches', zeroSuppression: 'none' },
  'excellon-3-3': { integerDigits: 3, decimalDigits: 3, unit: 'mm', zeroSuppression: 'none' },
  'excellon-2-5': { integerDigits: 2, decimalDigits: 5, unit: 'inches', zeroSuppression: 'none' },
  'excellon-3-4': { integerDigits: 3, decimalDigits: 4, unit: 'mm', zeroSuppression: 'none' },
  'custom': { integerDigits: 2, decimalDigits: 4, unit: 'inches', zeroSuppression: 'none' },
}

export const DEFAULT_DRILL_FORMAT: DrillFormatConfig = {
  preset: 'excellon-2-4',
  integerDigits: 2,
  decimalDigits: 4,
  unit: 'inches',
  zeroSuppression: 'none',
}

export interface PanelConfig {
  rows: number
  cols: number
  gapX: number // gap between PCBs in X (mm)
  gapY: number // gap between PCBs in Y (mm)
  sideRibTop: number // top side rib width (mm), 0 = none
  sideRibBottom: number
  sideRibLeft: number
  sideRibRight: number
  panelBorderWidth: number // outer panel border width (mm)
  enableToolingHoles: boolean
  toolingHoleDiameter: number // pinning hole size (mm), e.g., 2mm
  referenceHoleDiameter: number // reference hole size (mm), e.g., 1mm
  referenceHoleInset: number // distance from outermost PCB edge to reference hole center (mm), default 3.0
  toolingHoleInset: number // distance from panel edge to tooling hole center (mm)
  enableFiducials: boolean
  fiducialDiameter: number // copper fiducial size (mm)
  fiducialClearance: number // clearance around fiducial / mask opening size (mm)
  fiducialsTop: boolean // place on top layers
  fiducialsBottom: boolean // place on bottom layers
  drillFormat: DrillFormatConfig
  // L-shape marks on copper and mask layers at PCB corners
  enableLShapeMarks: boolean
  lShapeArmLength: number // L-shape arm length in mm (how far along each edge)
  lShapeLineWidth: number // L-shape line width in mm (e.g., 0.254mm)
  // L-shape marks on panel border/outline
  enablePanelBorderLShape: boolean
  panelBorderLShapeArmLength: number // Panel border L-shape arm length in mm
  panelBorderLShapeLineWidth: number // Panel border L-shape line width in mm
  // Donut rings on copper/mask/silkscreen layers around reference holes
  donutOuterDiameter: number // outer diameter of donut (mm), default 2.25
  donutInnerDiameter: number // inner diameter of donut (mm), default 1.25
  // Layer naming convention for text labels
  layerNamingConvention: 'top-bottom' | 'comp-sold' // 'top-bottom' = Top/Bottom, 'comp-sold' = COMP/SOLD
  // Custom X, Y position overrides for individual holes and fiducials
  xyOverrides?: Record<string, { x?: number; y?: number }>
  // Font type for panel text
  textFont: 'stroke' | 'region'
}

export interface PanelInfo {
  pcbName: string
  customerRef: string
  date: string
  revision: string
  layers: string // e.g., "GTL GBL GTS GBS GTO GBO"
}

export interface PanelResult {
  pcbWidth: number
  pcbHeight: number
  panelWidth: number
  panelHeight: number
  pcbPositions: { x: number; y: number; row: number; col: number }[]
  toolingHoles: { id: string; x: number; y: number; diameter: number; type: 'tooling' | 'reference' }[]
  fiducials: { id: string; x: number; y: number; diameter: number; clearance: number }[]
  infoTexts: InfoText[]
  totalPCBs: number
}

export interface InfoText {
  x: number
  y: number
  text: string
  fontSize: number
  align: 'left' | 'center' | 'right'
  /** Rotation angle in degrees: 0=horizontal, 90=vertical reading bottom-to-top, -90=vertical reading top-to-bottom */
  rotation: number
  /** Which area this text is placed in (for rendering context) */
  location: 'top-rib' | 'bottom-rib' | 'left-rib' | 'right-rib' | 'pcb-corner' | 'none'
  /** Whether this text should be mirrored (for bottom layer labels on side ribs) */
  mirrored?: boolean
  /** The specific layer type this text belongs to (e.g., 'copper', 'silk') */
  targetLayerType?: string
  /** The specific side this text belongs to ('top', 'bottom') */
  targetLayerSide?: 'top' | 'bottom' | 'none'
}

/** Layer label info for generating text on panel side ribs */
export interface LayerLabelInfo {
  name: string
  type: string
  side: 'top' | 'bottom' | 'none'
}

export const DEFAULT_PANEL_CONFIG: PanelConfig = {
  rows: 2,
  cols: 3,
  gapX: 0.5,
  gapY: 0.5,
  sideRibTop: 5,
  sideRibBottom: 5,
  sideRibLeft: 5,
  sideRibRight: 5,
  panelBorderWidth: 0.15,
  enableToolingHoles: true,
  toolingHoleDiameter: 2,
  referenceHoleDiameter: 1,
  referenceHoleInset: 3.0,
  toolingHoleInset: 5,
  enableFiducials: true,
  fiducialDiameter: 1.0,
  fiducialClearance: 2.0,
  fiducialsTop: true,
  fiducialsBottom: true,
  drillFormat: { ...DEFAULT_DRILL_FORMAT },
  enableLShapeMarks: true,
  lShapeArmLength: 5,
  lShapeLineWidth: 0.254,
  enablePanelBorderLShape: false,
  panelBorderLShapeArmLength: 5,
  panelBorderLShapeLineWidth: 0.254,
  donutOuterDiameter: 2.25,
  donutInnerDiameter: 1.25,
  layerNamingConvention: 'top-bottom',
  xyOverrides: {},
  textFont: 'region',
}

// ============================================================================
// Panel Layout Computation
// ============================================================================

export function computePanel(
  pcbWidth: number,
  pcbHeight: number,
  config: PanelConfig,
  info?: PanelInfo
): PanelResult {
  const { rows, cols, gapX, gapY } = config

  const gridWidth = cols * pcbWidth + (cols - 1) * gapX
  const gridHeight = rows * pcbHeight + (rows - 1) * gapY
  const panelWidth = config.sideRibLeft + gridWidth + config.sideRibRight
  const panelHeight = config.sideRibTop + gridHeight + config.sideRibBottom

  // PCB positions
  const pcbPositions: PanelResult['pcbPositions'] = []
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      pcbPositions.push({
        x: config.sideRibLeft + c * (pcbWidth + gapX),
        y: config.sideRibTop + r * (pcbHeight + gapY),
        row: r,
        col: c,
      })
    }
  }

  // Tooling holes — placed ONLY on side ribs, not on PCB area
  // Coordinate system: CAM350 first quadrant (X+ right, Y+ up, origin at bottom-left)
  const toolingHoles: PanelResult['toolingHoles'] = []
  if (config.enableToolingHoles) {
    const inset = config.toolingHoleInset
    // Minimum spacing between different hole types
    // The sample panel shows reference holes (1mm) can be ~2.5-3mm apart in top-left corner
    const minSpacingToolingToRef = (config.toolingHoleDiameter + config.referenceHoleDiameter) / 2 + 2  // 3.5mm
    const minSpacingRefToRef = 2.0  // Reference holes can be closer (2mm minimum)
    const minSpacingToolingToTooling = (config.toolingHoleDiameter + config.toolingHoleDiameter) / 2 + 2  // 4mm

    // Helper to check if a point is within the PCB grid area
    const gridLeft = config.sideRibLeft
    const gridRight = config.sideRibLeft + gridWidth
    const gridBottom = config.sideRibBottom  // Y coordinate increases upward
    const gridTop = config.sideRibBottom + gridHeight  // Y coordinate increases upward

    // Collect all occupied positions to prevent overlap
    const occupied: { x: number; y: number; type: 'tooling' | 'reference' }[] = []

    function isOverlapping(x: number, y: number, type: 'tooling' | 'reference'): boolean {
      for (const occ of occupied) {
        // Determine minimum spacing based on hole types
        let minSpacing = 0
        if (type === 'reference' && occ.type === 'reference') {
          minSpacing = minSpacingRefToRef  // Reference holes can be closer
        } else if (type === 'tooling' && occ.type === 'tooling') {
          minSpacing = minSpacingToolingToTooling
        } else {
          minSpacing = minSpacingToolingToRef  // Different hole types
        }

        if (Math.abs(occ.x - x) < minSpacing && Math.abs(occ.y - y) < minSpacing) return true
      }
      return false
    }

    function addHole(id: string, x: number, y: number, diameter: number, type: 'tooling' | 'reference') {
      const radius = diameter / 2
      const minEdgeDistance = radius + 1  // Keep at least 1mm from panel edge
      if (x < minEdgeDistance || y < minEdgeDistance || x > panelWidth - minEdgeDistance || y > panelHeight - minEdgeDistance) {
        console.log(`[${type} hole] Position (${x.toFixed(2)}, ${y.toFixed(2)}) rejected: too close to edge`)
        return
      }
      // Skip if on PCB grid area (CAM350: Y increases upward)
      if (x > gridLeft && x < gridRight && y > gridBottom && y < gridTop) {
        console.log(`[${type} hole] Position (${x.toFixed(2)}, ${y.toFixed(2)}) rejected: inside PCB grid`)
        return
      }
      if (isOverlapping(x, y, type)) {
        console.log(`[${type} hole] Position (${x.toFixed(2)}, ${y.toFixed(2)}) rejected: overlapping`)
        return
      }

      // Apply xy override if specified by the user
      const override = config.xyOverrides?.[id]
      const finalX = override?.x !== undefined ? override.x : x
      const finalY = override?.y !== undefined ? override.y : y

      occupied.push({ x: finalX, y: finalY, type })
      toolingHoles.push({ id, x: finalX, y: finalY, diameter, type })
      console.log(`[${type} hole] Added ${id} at (${finalX.toFixed(2)}, ${finalY.toFixed(2)}) diameter ${diameter}mm`)
    }

    // Pinning holes at corners of side ribs
    // Based on sample panel pattern to avoid overlap with reference holes:
    // - Reference holes (1mm) are at referenceInset (3mm) from PCB edges: 8mm, 102mm from panel edges
    // - Tooling holes (2.15mm) should be at ~12.5mm, 98mm from panel edges (sample panel)
    // - Key: Tooling holes must be positioned further from edges than reference holes

    const refInset = config.referenceHoleInset || 3.0

    // Calculate tooling hole positions to match sample panel pattern:
    // Left side: tooling hole at refInset + 4.5 from PCB edge (3 + 4.5 = 7.5) -> 12.5 from panel edge with 5mm rib
    // Right side: tooling hole at refInset + 4.5 from PCB edge -> 98mm from panel edge with 5mm rib
    const toolingDistanceFromPCBEdge = refInset + 4.5  // Match sample panel spacing

    console.log(`[Hole positioning] refInset: ${refInset}, toolingDistance: ${toolingDistanceFromPCBEdge}`)
    console.log(`[Hole positioning] Panel: ${panelWidth.toFixed(1)}x${panelHeight.toFixed(1)}mm (CAM350: X+ right, Y+ up)`)
    console.log(`[Hole positioning] Side ribs: L${config.sideRibLeft}, R${config.sideRibRight}, T${config.sideRibTop}, B${config.sideRibBottom}`)

    // Top-left corner (Y is high in CAM350 system) - moved to 14.5mm to avoid overlap with reference holes
    const tlX = config.sideRibLeft + toolingDistanceFromPCBEdge + 2.0  // 12.5 + 2.0 = 14.5mm from panel edge
    const tlY = panelHeight - config.sideRibTop / 2  // From bottom edge (high Y in CAM350)
    console.log(`[Tooling hole] Top-left: (${tlX.toFixed(2)}, ${tlY.toFixed(2)})`)
    addHole('tooling_tl', tlX, tlY, config.toolingHoleDiameter, 'tooling')

    // Top-right corner (Y is high in CAM350 system)
    const trX = panelWidth - config.sideRibRight - toolingDistanceFromPCBEdge  // From panel edge
    const trY = tlY
    console.log(`[Tooling hole] Top-right: (${trX.toFixed(2)}, ${trY.toFixed(2)})`)
    addHole('tooling_tr', trX, trY, config.toolingHoleDiameter, 'tooling')

    // Bottom-left corner (Y is low in CAM350 system) - moved to 11mm as specified
    const blX = config.sideRibLeft + toolingDistanceFromPCBEdge - 1.5  // 12.5 - 1.5 = 11mm from panel edge
    const blY = config.sideRibBottom / 2  // From bottom edge (low Y in CAM350)
    addHole('tooling_bl', blX, blY, config.toolingHoleDiameter, 'tooling')

    // Bottom-right corner (Y is low in CAM350 system)
    const brX = trX
    const brY = blY
    addHole('tooling_br', brX, brY, config.toolingHoleDiameter, 'tooling')

    // Printing reference holes on top and bottom side ribs
    // Based on sample panel pattern: 5 reference holes total
    // - Top-left corner: 2 holes at ~8mm and ~11mm (for PCB orientation understanding)
    // - Other corners: 1 hole each at ~8mm from panel edge
    // - CAM350 coordinate system: X+ right, Y+ up, origin at bottom-left

    // Bottom-left corner: 1 reference hole - moved to 7mm as specified
    if (config.sideRibBottom > 0) {
      const yRef = config.sideRibBottom / 2  // From bottom edge (low Y in CAM350)
      const xLeft = config.sideRibLeft + refInset - 1.0           // 7mm from panel edge (5mm rib + 2mm)
      console.log(`[Reference holes] Bottom-left: (${xLeft.toFixed(2)}, ${yRef.toFixed(2)})`)
      addHole('ref_bl', xLeft, yRef, config.referenceHoleDiameter, 'reference')
    }

    // Bottom-right corner: 1 reference hole
    if (config.sideRibBottom > 0) {
      const yRef = config.sideRibBottom / 2  // From bottom edge (low Y in CAM350)
      const xRight = panelWidth - config.sideRibRight - refInset  // 102mm from panel edge
      console.log(`[Reference holes] Bottom-right: (${xRight.toFixed(2)}, ${yRef.toFixed(2)})`)
      addHole('ref_br', xRight, yRef, config.referenceHoleDiameter, 'reference')
    }

    // Top-right corner: 1 reference hole
    if (config.sideRibTop > 0) {
      const yRef = panelHeight - config.sideRibTop / 2  // From bottom edge (high Y in CAM350)
      const xRight = panelWidth - config.sideRibRight - refInset  // 102mm from panel edge
      console.log(`[Reference holes] Top-right: (${xRight.toFixed(2)}, ${yRef.toFixed(2)})`)
      addHole('ref_tr', xRight, yRef, config.referenceHoleDiameter, 'reference')
    }

    // Top-left corner: 2 reference holes (for PCB orientation understanding)
    if (config.sideRibTop > 0) {
      const yRef = panelHeight - config.sideRibTop / 2  // From bottom edge (high Y in CAM350)
      const xLeft1 = config.sideRibLeft + refInset - 1.0       // 7mm from panel edge (5mm rib + 2mm) - gives 3.5mm spacing
      const xLeft2 = config.sideRibLeft + refInset + 2.5      // ~10.5mm from panel edge

      console.log(`[Reference holes] Top-left 1: (${xLeft1.toFixed(2)}, ${yRef.toFixed(2)})`)
      console.log(`[Reference holes] Top-left 2: (${xLeft2.toFixed(2)}, ${yRef.toFixed(2)})`)

      addHole('ref_tl1', xLeft1, yRef, config.referenceHoleDiameter, 'reference')
      addHole('ref_tl2', xLeft2, yRef, config.referenceHoleDiameter, 'reference')
    }
  }

  // Fiducials — placed ONLY on side ribs, near corners, no overlap with tooling holes or other features
  const fiducials: PanelResult['fiducials'] = []
  const fidsTop = config.fiducialsTop !== false
  const fidsBottom = config.fiducialsBottom !== false
  if (config.enableFiducials && (fidsTop || fidsBottom)) {
    const gridLeft = config.sideRibLeft
    const gridRight = config.sideRibLeft + gridWidth
    const gridBottom = config.sideRibBottom
    const gridTop = config.sideRibBottom + gridHeight
 
    const radius = config.fiducialDiameter / 2
    const clearanceOffset = Math.max(0, (config.fiducialClearance - config.fiducialDiameter) / 2)
 
    function isValidPosition(x: number, y: number): boolean {
      // 1. Must be within panel boundaries with at least margin
      const margin = radius + 1.0
      if (x < margin || x > panelWidth - margin || y < margin || y > panelHeight - margin) {
        return false
      }
 
      // 2. Must be on a side rib (NOT in the PCB grid area)
      const inGridX = x >= gridLeft && x <= gridRight
      const inGridY = y >= gridBottom && y <= gridTop
      if (inGridX && inGridY) {
        return false
      }
 
      // 3. Must not overlap with tooling/reference holes (including clearance)
      for (const hole of toolingHoles) {
        const dist = Math.hypot(hole.x - x, hole.y - y)
        // Minimum clearance between fiducial mask edge and hole edge
        const minSpacing = (config.fiducialDiameter / 2) + clearanceOffset + (hole.diameter / 2) + 2.0
        if (dist < minSpacing) {
          return false
        }
      }
 
      // 4. Must not overlap with other already placed fiducials
      for (const fid of fiducials) {
        const dist = Math.hypot(fid.x - x, fid.y - y)
        const minSpacing = config.fiducialDiameter + clearanceOffset * 2 + 2.0
        if (dist < minSpacing) {
          return false
        }
      }
 
      return true
    }
 
    function addFiducial(id: string, x: number, y: number) {
      if (isValidPosition(x, y)) {
        const override = config.xyOverrides?.[id]
        const finalX = override?.x !== undefined ? override.x : x
        const finalY = override?.y !== undefined ? override.y : y

        fiducials.push({ id, x: finalX, y: finalY, diameter: config.fiducialDiameter, clearance: config.fiducialClearance })
        console.log(`[Fiducial] Added ${id} at (${finalX.toFixed(2)}, ${finalY.toFixed(2)})`)
        return true
      }
      return false
    }

    // We place three fiducials near the corners (Bottom-Left, Bottom-Right, Top-Right)
    // Try placing on the top/bottom ribs as requested:

    // 1. Bottom-Left Corner:
    const blCandidates = [
      { x: config.sideRibLeft + 15, y: config.sideRibBottom / 2 },
      { x: config.sideRibLeft / 2, y: config.sideRibBottom + 12 }
    ]
    for (const c of blCandidates) {
      if (addFiducial('fid_bl', c.x, c.y)) {
        break
      }
    }

    // 2. Bottom-Right Corner:
    const brCandidates = [
      { x: panelWidth - config.sideRibRight - 40, y: config.sideRibBottom / 2 },
      { x: panelWidth - config.sideRibRight / 2, y: config.sideRibBottom + 12 }
    ]
    for (const c of brCandidates) {
      if (addFiducial('fid_br', c.x, c.y)) {
        break
      }
    }

    // 3. Top-Right Corner:
    const trCandidates = [
      { x: panelWidth - config.sideRibRight - 20, y: panelHeight - config.sideRibTop / 2 },
      { x: panelWidth - config.sideRibRight / 2, y: panelHeight - config.sideRibTop - 12 }
    ]
    for (const c of trCandidates) {
      if (addFiducial('fid_tr', c.x, c.y)) {
        break
      }
    }
  }

  // Generate top rib text (Customer Name, PCB Name/Part Number)
  // This text will appear on all appropriate layers (generic text)
  const infoTexts: InfoText[] = []
  if (info) {
    const topRibTexts = generateTopRibText(info, pcbWidth, pcbHeight, panelWidth, panelHeight, config, toolingHoles, rows, cols)
    infoTexts.push(...topRibTexts)
  }

  return { pcbWidth, pcbHeight, panelWidth, panelHeight, pcbPositions, toolingHoles, fiducials, infoTexts, totalPCBs: rows * cols }
}

// ============================================================================
// Layer Label Generation for Panel Side Ribs
// ============================================================================

/**
 * Generate layer label text items for the panel side ribs.
 *
 * Layout convention (matching real PCB panel manufacturing):
 *   Left rib, from bottom to top:
 *     GBO (bottom silk)    ← mirrored
 *     GBS (bottom mask)    ← mirrored
 *     GBL (bottom copper)  ← mirrored
 *     --- board area ---
 *     GTL (top copper)     ← normal
 *     GTS (top mask)       ← normal
 *     GTO (top silk)       ← normal
 *
 * Top layers have normal text, bottom layers have mirrored text
 * so they read correctly when the PCB is viewed from the bottom side.
 *
 * @param layers - List of layer labels with name, type, and side
 * @param panelWidth - Full panel width in mm
 * @param panelHeight - Full panel height in mm
 * @param config - Panel configuration (for rib dimensions)
 * @returns Array of InfoText items to be added to the panel result
 */
export function generateLayerLabels(
  layers: LayerLabelInfo[],
  panelWidth: number,
  panelHeight: number,
  config: PanelConfig,
  pcbWidth: number,
  pcbHeight: number,
  pcbPositions: PanelResult['pcbPositions'],
  toolingHoles?: PanelResult['toolingHoles']
): InfoText[] {
  const texts: InfoText[] = []

  if (layers.length === 0) return texts

  // --- Place layer names on the RIGHT side of the BOTTOM rib ---
  // Layout: horizontal text, right-aligned, stacked vertically from bottom
  // Each layer label gets its own line, placed from bottom to top in the rib area.
  //
  // Position reference:
  //   Bottom rib Y range: [0, sideRibBottom]
  //   Right side X: panelWidth - margin

  const fontSize = 1.8

  // Apply naming convention based on config
  const namingConvention = config.layerNamingConvention || 'top-bottom'

  // Build ordered label list - separated by TOP and BOTTOM groups
  const topLabels: { name: string; isBottom: boolean; index: number }[] = []
  const bottomLabels: { name: string; isBottom: boolean; index: number }[] = []

  for (let i = 0; i < layers.length; i++) {
    const layer = layers[i]
    const layerName = namingConvention === 'comp-sold'
      ? layer.name.replace('Bottom', 'SOLD').replace('Top', 'COMP')
      : layer.name

    if (layer.side === 'top') {
      topLabels.push({ name: layerName, isBottom: false, index: i })
    } else if (layer.side === 'bottom') {
      bottomLabels.push({ name: layerName, isBottom: true, index: i })
    }
  }

  // Calculate Y position: EXACT CENTER of rib height for ALL labels
  const ribHeight = config.sideRibBottom
  const centerTextY = ribHeight / 2  // Exact center of the bottom rib

  // Position based on first character location from panel border
  const topFirstCharX = panelWidth - 30  // "T" at 30mm from right border
  const bottomFirstCharX = panelWidth - 17  // "B" at 17mm from right border

  // Calculate anchor points for positioning
  // For TOP layers (normal left-aligned): anchor at first character position
  // All top texts share the same anchor point for overlapping
  const topAnchorX = topFirstCharX

  // For BOTTOM layers (mirrored right-aligned): anchor at first character position
  // All bottom texts share the same anchor point for overlapping
  const bottomAnchorX = bottomFirstCharX

  console.log(`[Label Position] TOP layers: First char at ${topFirstCharX.toFixed(2)}mm (30mm from right border), Anchor at ${topAnchorX.toFixed(2)}mm`)
  console.log(`[Label Position] BOTTOM layers: First char at ${bottomFirstCharX.toFixed(2)}mm (17mm from right border), Anchor at ${bottomAnchorX.toFixed(2)}mm`)

  // Generate TOP labels at overlaid center position (non-mirrored)
  if (topLabels.length > 0) {
    for (const label of topLabels) {
      console.log(`[Label Gen] Adding TOP label: "${label.name}" with anchor at ${topAnchorX.toFixed(2)}mm`)
      texts.push({
        x: topAnchorX,
        y: centerTextY,
        text: label.name,
        fontSize,
        align: 'left',
        rotation: 0,
        location: 'bottom-rib',
        mirrored: false,  // TOP layers are NOT mirrored
        targetLayerType: layers[label.index].type,
        targetLayerSide: layers[label.index].side,
      })
    }
    console.log(`[Label Gen] Generated ${topLabels.length} TOP labels at position (${topAnchorX.toFixed(2)}, ${centerTextY.toFixed(2)})`)
  }

  // Generate BOTTOM labels at overlaid center position (mirrored)
  if (bottomLabels.length > 0) {
    for (const label of bottomLabels) {
      console.log(`[Label Gen] Adding BOTTOM label: "${label.name}" for layer type: ${layers[label.index].type}, side: ${layers[label.index].side}`)
      texts.push({
        x: bottomAnchorX,
        y: centerTextY,
        text: label.name,
        fontSize,
        align: 'left',
        rotation: 0,
        location: 'bottom-rib',
        mirrored: true,  // BOTTOM layers are mirrored
        targetLayerType: layers[label.index].type,
        targetLayerSide: layers[label.index].side,
      })
    }
    console.log(`[Label Gen] Generated ${bottomLabels.length} BOTTOM labels at position (${bottomAnchorX.toFixed(2)}, ${centerTextY.toFixed(2)})`)
  }

  console.log(`[Label Gen] Total labels generated: ${texts.length}`)
  return texts
}

/**
 * Generate panel info text for top rib (Customer Name, PCB Name/Part Number)
 * This text will appear on all appropriate layers (generic text, no specific layer targeting)
 *
 * @param info - Panel information containing customer reference, PCB name, etc.
 * @param panelWidth - Full panel width in mm
 * @param panelHeight - Full panel height in mm
 * @param config - Panel configuration with side rib dimensions
 * @param toolingHoles - Tooling holes positions for positioning reference
 * @returns Array of InfoText items for top rib
 */
export function generateTopRibText(
  info: PanelInfo,
  pcbWidth: number,
  pcbHeight: number,
  panelWidth: number,
  panelHeight: number,
  config: PanelConfig,
  toolingHoles?: PanelResult['toolingHoles'],
  rows: number = 2,
  cols: number = 3
): InfoText[] {
  const texts: InfoText[] = []

  if (!info) return texts

  // Calculate Y position: center of top rib
  const ribHeight = config.sideRibTop
  const topRibY = panelHeight - ribHeight / 2  // Center of top rib

  // Text width for positioning, using the shared region-font metrics so the
  // rib text lands exactly where the glyphs render (single source of truth —
  // see measureRegionText in region-font.ts).
  const measureTextWidth = (text: string) => measureRegionText(text) * fontSize

  // Position: 3.5mm right of top left tooling hole (first character position)
  const textOffsetFromHole = 3.5
  let firstCharX = 10.0 // fallback position

  if (toolingHoles && toolingHoles.length > 0) {
    // Find top left tooling hole (lowest X, highest Y)
    const topLeftHole = toolingHoles
      .filter(h => h.type === 'tooling')
      .reduce((topleft, hole) => {
        // Prefer lowest X, then highest Y (top left corner)
        if (hole.y > topleft.y) return hole
        if (hole.y === topleft.y && hole.x < topleft.x) return hole
        return topleft
      }, toolingHoles[0])

    if (topLeftHole) {
      firstCharX = topLeftHole.x + textOffsetFromHole
      console.log(`[Top Rib Position] Using top left tooling hole at (${topLeftHole.x.toFixed(2)}, ${topLeftHole.y.toFixed(2)}), text position: ${firstCharX.toFixed(2)}mm`)
    }
  } else {
    console.log(`[Top Rib Position] No tooling holes found, using fallback position: ${firstCharX.toFixed(2)}mm`)
  }

  // Prepare single line of text as requested: "Customer name: PCB name"
  const linesOfText: string[] = [
    `${info.customerRef || 'Customer Name'} : ${info.pcbName || 'PCB-001'}`
  ]

  const fontSize = 2.8 // Height approx 3mm (normalized height 1.0 * 2.8)
  const lineSpacing = 0 // Only one line

  for (let i = 0; i < linesOfText.length; i++) {
    const combinedText = linesOfText[i]
    const currentLineY = topRibY - (i * lineSpacing)

    if (combinedText.trim()) {
      const textWidth = measureTextWidth(combinedText)
      const rightAnchorX = firstCharX + textWidth

      console.log(`[Top Rib] Adding line ${i}: "${combinedText}" at ${firstCharX.toFixed(2)}mm`)

      // Add normal version for top layers (Start at LEFT, render right)
      texts.push({
        x: firstCharX,
        y: currentLineY,
        text: combinedText,
        fontSize,
        align: 'left',
        rotation: 0,
        location: 'top-rib',
        mirrored: false,
      })

      // Add mirrored version for bottom layers (Start at RIGHT, render left)
      texts.push({
        x: rightAnchorX,
        y: currentLineY,
        text: combinedText,
        fontSize,
        align: 'left',
        rotation: 0,
        location: 'top-rib',
        mirrored: true,
      })
    }
  }

  console.log(`[Top Rib] Generated ${texts.length} texts (${texts.length / 2} per side) in ${linesOfText.length} lines`)
  return texts
}

// ============================================================================
// PCB Outline Shape Detection & L-Shape Mark Generation

// ============================================================================
// PCB Outline Shape Detection & L-Shape Mark Generation
// ============================================================================

/**
 * Check if a parsed Gerber layer (outline) has a primarily rectangular outline.
 * Returns true if the outline boundary appears to be a rectangle.
 * Rejects if the outline contains significant arc/curve segments that suggest
 * circular, elliptical, or rounded-corner PCB shapes.
 *
 * Detection heuristic:
 * - Count linear interpolation commands (interpolate) vs arc commands (arc_cw, arc_ccw)
 * - If arcs make up more than 10% of moves, the outline likely has curves
 * - Also checks that the outline commands form roughly 4 corner points
 */
export function isRectangularOutline(layer: GerberLayer): boolean {
  if (!layer.commands || layer.commands.length === 0) return false

  let linearCount = 0
  let arcCount = 0
  let moveCount = 0

  for (const cmd of layer.commands) {
    if (cmd.type === 'interpolate') linearCount++
    else if (cmd.type === 'arc_cw' || cmd.type === 'arc_ccw') arcCount++
    else if (cmd.type === 'move') moveCount++
  }

  // If no linear commands, definitely not rectangular
  if (linearCount === 0) return false

  // If arcs dominate, it's likely a circle/ellipse/rounded shape
  const totalMoves = linearCount + arcCount
  if (totalMoves > 0 && arcCount / totalMoves > 0.10) return false

  return true
}

/**
 * Generate L-shape Gerber commands for PCB corners.
 *
 * The L-shapes overlap the PCB corner — each arm extends along one edge.
 * Pattern (matching CAM350 reference):
 *
 *   Bottom-left:  (arm, 0) → (0, 0) → (0, arm)
 *   Bottom-right: (w-arm, 0) → (w, 0) → (w, arm)
 *   Top-right:     (w, h-arm) → (w, h) → (w-arm, h)
 *   Top-left:      (arm, h) → (0, h) → (0, h-arm)
 *
 * Where w = PCB width, h = PCB height, arm = arm length.
 *
 * @param pcbWidth - PCB width in mm
 * @param pcbHeight - PCB height in mm
 * @param config - Panel configuration (uses enableLShapeMarks, lShapeArmLength, lShapeLineWidth)
 * @param fmt - Output format for coordinate formatting
 * @returns Array of Gerber command strings, or empty array if disabled
 */
export function generateLShapeGerberCommands(
  pcbWidth: number,
  pcbHeight: number,
  config: PanelConfig,
  fmt: OutputFormat,
  apertureCode: number = 53
): string[] {
  if (!config.enableLShapeMarks) return []

  const arm = config.lShapeArmLength
  const lines: string[] = []

  // Validate arm length doesn't exceed half the PCB dimension
  const maxArm = Math.min(pcbWidth / 2, pcbHeight / 2)
  if (arm <= 0 || arm > maxArm) return []

  // Define a line aperture for the L-shapes. The code must not collide with
  // any D-code already used in the customer's Gerber — see findMaxDCode().
  lines.push(`%ADD${apertureCode}C,${config.lShapeLineWidth.toFixed(6)}*%`)

  const f = (v: number) => formatCoordinate(v, fmt)

  // Bottom-left corner (0, 0): L from (arm, 0) → (0, 0) → (0, arm)
  lines.push(`G54D${apertureCode}*`)
  lines.push(`X${f(arm)}Y${f(0)}D02*`)
  lines.push(`X${f(0)}Y${f(0)}D01*`)
  lines.push(`X${f(0)}Y${f(arm)}D01*`)

  // Bottom-right corner (w, 0): L from (w-arm, 0) → (w, 0) → (w, arm)
  lines.push(`X${f(pcbWidth - arm)}Y${f(0)}D02*`)
  lines.push(`X${f(pcbWidth)}Y${f(0)}D01*`)
  lines.push(`X${f(pcbWidth)}Y${f(arm)}D01*`)

  // Top-right corner (w, h): L from (w, h-arm) → (w, h) → (w-arm, h)
  lines.push(`X${f(pcbWidth)}Y${f(pcbHeight - arm)}D02*`)
  lines.push(`X${f(pcbWidth)}Y${f(pcbHeight)}D01*`)
  lines.push(`X${f(pcbWidth - arm)}Y${f(pcbHeight)}D01*`)

  // Top-left corner (0, h): L from (arm, h) → (0, h) → (0, h-arm)
  lines.push(`X${f(arm)}Y${f(pcbHeight)}D02*`)
  lines.push(`X${f(0)}Y${f(pcbHeight)}D01*`)
  lines.push(`X${f(0)}Y${f(pcbHeight - arm)}D01*`)

  return lines
}

/**
 * Generate L-shape Gerber commands for panel border/outline corners.
 *
 * The L-shapes are placed on the panel border, not on individual PCBs.
 * Pattern:
 *
 *   Bottom-left:  (arm, 0) → (0, 0) → (0, arm)
 *   Bottom-right: (pw-arm, 0) → (pw, 0) → (pw, arm)
 *   Top-right:     (pw, ph-arm) → (pw, ph) → (pw-arm, ph)
 *   Top-left:      (arm, ph) → (0, ph) → (0, ph-arm)
 *
 * Where pw = panel width, ph = panel height, arm = arm length.
 *
 * @param panelWidth - Panel width in mm
 * @param panelHeight - Panel height in mm
 * @param config - Panel configuration (uses enablePanelBorderLShape, panelBorderLShapeArmLength, panelBorderLShapeLineWidth)
 * @param fmt - Output format for coordinate formatting
 * @returns Array of Gerber command strings, or empty array if disabled
 */
export function generatePanelBorderLShapeGerberCommands(
  panelWidth: number,
  panelHeight: number,
  config: PanelConfig,
  fmt: OutputFormat,
  apertureCode: number = 54
): string[] {
  if (!config.enablePanelBorderLShape) return []

  const arm = config.panelBorderLShapeArmLength
  const lines: string[] = []

  // Validate arm length doesn't exceed half the panel dimension
  const maxArm = Math.min(panelWidth / 2, panelHeight / 2)
  if (arm <= 0 || arm > maxArm) return []

  // Define a line aperture for the panel border L-shapes (distinct from the
  // PCB-corner L-shape code; both are allocated above the customer's max
  // D-code — see findMaxDCode()).
  lines.push(`%ADD${apertureCode}C,${config.panelBorderLShapeLineWidth.toFixed(6)}*%`)

  const f = (v: number) => formatCoordinate(v, fmt)

  // Bottom-left corner (0, 0): L from (arm, 0) → (0, 0) → (0, arm)
  lines.push(`G54D${apertureCode}*`)
  lines.push(`X${f(arm)}Y${f(0)}D02*`)
  lines.push(`X${f(0)}Y${f(0)}D01*`)
  lines.push(`X${f(0)}Y${f(arm)}D01*`)

  // Bottom-right corner (pw, 0): L from (pw-arm, 0) → (pw, 0) → (pw, arm)
  lines.push(`X${f(panelWidth - arm)}Y${f(0)}D02*`)
  lines.push(`X${f(panelWidth)}Y${f(0)}D01*`)
  lines.push(`X${f(panelWidth)}Y${f(arm)}D01*`)

  // Top-right corner (pw, ph): L from (pw, ph-arm) → (pw, ph) → (pw-arm, ph)
  lines.push(`X${f(panelWidth)}Y${f(panelHeight - arm)}D02*`)
  lines.push(`X${f(panelWidth)}Y${f(panelHeight)}D01*`)
  lines.push(`X${f(panelWidth - arm)}Y${f(panelHeight)}D01*`)

  // Top-left corner (0, ph): L from (arm, ph) → (0, ph) → (0, ph-arm)
  lines.push(`X${f(arm)}Y${f(panelHeight)}D02*`)
  lines.push(`X${f(0)}Y${f(panelHeight)}D01*`)
  lines.push(`X${f(0)}Y${f(panelHeight - arm)}D01*`)

  return lines
}

/**
 * Check if a layer type should receive L-shape marks.
 * Only copper and mask layers get L-shapes.
 */
export function layerNeedsLShapeMarks(layerType: string): boolean {
  return layerType === 'copper' || layerType === 'mask'
}

/**
 * Check if a layer type should receive donut ring shapes around reference holes.
 * Copper, mask, and silkscreen layers get donuts. Paste layers do NOT.
 */
export function layerNeedsDonutShapes(layerType: string): boolean {
  return layerType === 'copper' || layerType === 'mask' || layerType === 'silk'
}

// ============================================================================
// Gerber Code Generation from Parsed Layer Data
// ============================================================================

/**
 * Generate Gerber body commands from a parsed GerberLayer's command array.
 * This is the core function that produces correct RS-274X output.
 *
 * @param layer - The parsed Gerber layer (commands are in mm)
 * @param offsetX - X offset to add to all coordinates (for panelization)
 * @param offsetY - Y offset to add to all coordinates (for panelization)
 * @param fmt - Output format specification
 * @param lines - Array to append generated Gerber lines to
 * @param initialInterpMode - Interpolation mode from the previous call (for continuity)
 * @returns The final interpolation mode after processing all commands
 */
function generateBodyFromCommands(
  layer: GerberLayer,
  offsetX: number,
  offsetY: number,
  fmt: OutputFormat,
  lines: string[],
  initialInterpMode?: 'linear' | 'cw' | 'ccw'
): 'linear' | 'cw' | 'ccw' {
  const f = (v: number) => formatCoordinate(v, fmt)

  // State tracking to minimize output — carry over from previous call if provided
  let currentInterp: 'linear' | 'cw' | 'ccw' = initialInterpMode || 'linear'
  let lastAperture: number | null = null
  let inRegion = false
  let lastPolarity: 'dark' | 'clear' = 'dark'
  // Track last output position to omit redundant coordinates (standard RS-274X optimization)
  let lastOutputX: string | null = null
  let lastOutputY: string | null = null

  // Track the parser's absolute position for the original layer commands
  let posX = 0
  let posY = 0
  let isFirstCommandInCopy = true

  // Ensure linear mode and establish a known starting position for this copy.
  // Without this, if the previous copy ended in arc mode or the first command
  // lacks explicit coordinates, subsequent copies would draw at wrong positions.
  if (currentInterp !== 'linear') {
    lines.push('G74*')
    lines.push('G01*')
    currentInterp = 'linear'
  }

  for (let i = 0; i < layer.commands.length; i++) {
    const cmd = layer.commands[i]

    if (cmd.coordinate.x !== undefined) posX = cmd.coordinate.x
    if (cmd.coordinate.y !== undefined) posY = cmd.coordinate.y

    // --- Polarity changes ---
    if (cmd.polarity !== lastPolarity) {
      lines.push(cmd.polarity === 'clear' ? '%LPC*%' : '%LPD*%')
      lastPolarity = cmd.polarity
    }

    // --- Region boundaries ---
    if (cmd.regionMode && !inRegion) {
      lines.push('G36*')
      inRegion = true
    } else if (!cmd.regionMode && inRegion) {
      lines.push('G37*')
      inRegion = false
    }

    // --- Interpolation mode ---
    let newInterp: 'linear' | 'cw' | 'ccw' = currentInterp
    if (cmd.type === 'interpolate') newInterp = 'linear'
    else if (cmd.type === 'arc_cw') newInterp = 'cw'
    else if (cmd.type === 'arc_ccw') newInterp = 'ccw'

    if (newInterp !== currentInterp) {
      if (newInterp === 'linear') {
        lines.push('G74*')  // Reset to single-quadrant mode
        lines.push('G01*')  // Explicit linear interpolation mode
      } else if (newInterp === 'cw') {
        lines.push('G75*')  // Multi-quadrant mode for arcs
        lines.push('G02*')
      } else {
        lines.push('G75*')  // Multi-quadrant mode for arcs
        lines.push('G03*')
      }
      currentInterp = newInterp
    }

    // --- Aperture selection ---
    if (cmd.apertureCode !== null && cmd.apertureCode !== lastAperture) {
      lines.push(`D${cmd.apertureCode}*`)
      lastAperture = cmd.apertureCode
    }

    // --- Build coordinate string ---
    // Only output coordinates that have actually changed (RS-274X optimization).
    // When X or Y is undefined (omitted in source), the current position is reused.
    // For flash commands (D03), always output both X and Y for clarity.
    const isFlash = cmd.type === 'flash'
    const parts: string[] = []

    if (isFirstCommandInCopy && (cmd.coordinate.x !== undefined || cmd.coordinate.y !== undefined || isFlash)) {
      // Force writing both X and Y for the very first coordinate command to establish the offset position
      const xStr = `X${f(posX + offsetX)}`
      const yStr = `Y${f(posY + offsetY)}`
      parts.push(xStr, yStr)
      lastOutputX = xStr
      lastOutputY = yStr
      isFirstCommandInCopy = false
    } else {
      if (cmd.coordinate.x !== undefined) {
        const xStr = `X${f(cmd.coordinate.x + offsetX)}`
        parts.push(xStr)
        lastOutputX = xStr
      }
      if (cmd.coordinate.y !== undefined) {
        const yStr = `Y${f(cmd.coordinate.y + offsetY)}`
        parts.push(yStr)
        lastOutputY = yStr
      }
    }

    // I/J are relative offsets — don't add panel offset, but DO format for output
    if (cmd.coordinate.i !== undefined) {
      parts.push(`I${f(cmd.coordinate.i)}`)
    }
    if (cmd.coordinate.j !== undefined) {
      parts.push(`J${f(cmd.coordinate.j)}`)
    }

    // --- D-code ---
    let dcode: string
    if (cmd.type === 'move') {
      dcode = 'D02*'
    } else if (cmd.type === 'flash') {
      dcode = 'D03*'
    } else {
      // interpolate, arc_cw, arc_ccw all use D01
      dcode = 'D01*'
    }

    if (parts.length > 0) {
      lines.push(parts.join('') + dcode)
    } else {
      // Standalone D-code (e.g., flash at current position)
      lines.push(dcode)
    }
  }

  // Close any unclosed region
  if (inRegion) {
    lines.push('G37*')
  }

  return currentInterp
}

/**
 * Generate a panelized Gerber RS-274X file from a parsed GerberLayer.
 *
 * This function works from the PARSED layer data (which has proper mm values)
 * rather than regex-transforming raw text. This ensures correct coordinate
 * handling regardless of the source file's format.
 *
 * Strategy:
 * 1. Write format header (FS, MO, G-code)
 * 2. Copy macro definitions (AM blocks) from original raw content
 * 3. Copy aperture definitions (ADD commands) from original raw content
 * 4. For each panel position, generate body commands from parsed data with offset
 *
 * @param parsedLayer - The fully parsed Gerber layer (commands in mm)
 * @param rawContent - The original raw Gerber file content (for macro/ADD extraction)
 * @param panel - Computed panel layout
 * @param config - Panel configuration
 * @param outputFormat - Output format specification
 */
export interface BaseOffset {
  x: number
  y: number
}

/**
 * Scan raw Gerber content to find the maximum D-code defined or selected.
 * Matches extended commands %ADD<number> and select commands D<number>* where number >= 10.
 *
 * Used to allocate panel-overlay aperture codes (L-shapes, text, donuts,
 * fiducials) above anything the customer's file already uses — fixed codes
 * like D53 collide with real-world Gerbers (customer apertures commonly run
 * D10 and up) and duplicate definitions trip CAM tools.
 */
export function findMaxDCode(gerberContent: string): number {
  let maxD = 9 // Minimum standard D-code starts at 10

  // 1. Match %ADD<number><shape>
  const addRegex = /%ADD(\d+)/g
  let match
  while ((match = addRegex.exec(gerberContent)) !== null) {
    const code = parseInt(match[1], 10)
    if (!isNaN(code) && code > maxD) {
      maxD = code
    }
  }

  // 2. Match D<number>* selection commands where number >= 10
  const selectRegex = /D(\d+)\*/g
  while ((match = selectRegex.exec(gerberContent)) !== null) {
    const code = parseInt(match[1], 10)
    if (!isNaN(code) && code >= 10 && code > maxD) {
      maxD = code
    }
  }

  return maxD
}

export function generatePanelizedGerber(
  parsedLayer: GerberLayer,
  rawContent: string,
  panel: PanelResult,
  config: PanelConfig,
  outputFormat?: OutputFormat,
  globalBaseOffset?: BaseOffset,
  layerType?: string,
  layerSide?: 'top' | 'bottom' | 'none'
): string {
  const fmt: OutputFormat = outputFormat || DEFAULT_OUTPUT_FORMAT
  const lines: string[] = []

  // ---- 0. Allocate collision-free D-codes for panel overlay features ----
  // Scan both the raw content and the parsed aperture table (parsing may have
  // renumbered or the raw file may select codes the parser normalized away),
  // then start our codes at the next "century" boundary above the max, and
  // never below 301.
  let maxD = findMaxDCode(rawContent)
  for (const code of parsedLayer.apertures.keys()) {
    if (code > maxD) maxD = code
  }
  const baseCode = Math.max(301, Math.ceil((maxD + 1) / 100) * 100 + 1)
  const lShapeCornerCode = baseCode
  const lShapeBorderCode = baseCode + 1
  const strokeFontApertureCode = baseCode + 2
  const donutApertureCode = baseCode + 3
  const fiducialApertureCode = baseCode + 4

  // ---- 1. Format header ----
  lines.push(generateFSCommand(fmt))
  lines.push(generateMOCommand(fmt))
  lines.push('%LPD*%')

  // ---- 2. Macro definitions (AM blocks) from original ----
  const macros = extractMacroDefinitions(rawContent)
  for (const macro of macros) {
    lines.push(macro)
  }

  // ---- 3. Aperture definitions from parsed data ----
  // CRITICAL: Generate ADD commands from parsed aperture data (already unit-converted)
  // rather than extracting raw strings from the original file. The original file may
  // use different units (e.g., inches) while the output header declares mm, which
  // would cause aperture sizes to be misinterpreted by CAM tools.
  const addCmds = generateApertureDefinitions(parsedLayer.apertures)
  for (const add of addCmds) {
    lines.push(add)
  }

  // ---- 4. G-code initialization ----
  lines.push(generateGUnitCode(fmt))
  lines.push('G01*')

  // ---- 5. Generate body for each panel position ----
  if (!parsedLayer.bounds) {
    lines.push('M02*')
    return lines.join('\n')
  }

  // Offset to move PCB origin (minX, minY) to panel position.
  // CRITICAL: When globalBaseOffset is provided (from the outline layer), ALL layers
  // use the SAME offset. This ensures all layers are perfectly aligned in the panel.
  // If not provided, fall back to this layer's own bounds (legacy behavior).
  const baseOffsetX = globalBaseOffset ? globalBaseOffset.x : -parsedLayer.bounds.minX
  const baseOffsetY = globalBaseOffset ? globalBaseOffset.y : -parsedLayer.bounds.minY

  let lastInterp: 'linear' | 'cw' | 'ccw' = 'linear'

  for (const pos of panel.pcbPositions) {
    const dx = pos.x + baseOffsetX
    const dy = pos.y + baseOffsetY

    // Pass previous interpolation mode so state is continuous across copies
    lastInterp = generateBodyFromCommands(parsedLayer, dx, dy, fmt, lines, lastInterp)
  }

  // FORCE LINEAR MODE FOR APPENDED ELEMENTS
  // If the last PCB instance ended in an arc mode (G02/G03), we must explicitly
  // switch back to linear mode (G01) before drawing panel border elements,
  // tooling holes, or text, which all assume linear interpolation.
  // Failure to do this causes "Arc Warning" errors in CAM350.
  if (lastInterp !== 'linear') {
    lines.push('G74*')  // Single-quadrant mode (standard for linear)
    lines.push('G01*')
    lastInterp = 'linear'
  }

  // ---- 6. L-shape marks at PCB corners (for copper & mask layers) ----
  // Generate L-shapes for each panel position, offset to match panel layout.
  // L-shapes are added to copper and mask layers only.
  if (config.enableLShapeMarks && layerType && layerNeedsLShapeMarks(layerType)) {
    // Generate L-shape commands relative to PCB origin (0,0)
    const lShapeBase = generateLShapeGerberCommands(panel.pcbWidth, panel.pcbHeight, config, fmt, lShapeCornerCode)

    // For each panel position, offset the L-shape coordinates
    if (lShapeBase.length > 0) {
      // Define the aperture once, not per position — duplicate %ADD blocks
      // trip warnings in CAM tools.
      lines.push(`%ADD${lShapeCornerCode}C,${config.lShapeLineWidth.toFixed(6)}*%`)

      for (const pos of panel.pcbPositions) {
        const offX = pos.x + baseOffsetX
        const offY = pos.y + baseOffsetY

        // Re-generate L-shapes with position offset
        const arm = config.lShapeArmLength
        const w = panel.pcbWidth
        const h = panel.pcbHeight

        const f = (v: number) => formatCoordinate(v + offX, fmt)
        const fy = (v: number) => formatCoordinate(v + offY, fmt)

        lines.push(`G54D${lShapeCornerCode}*`)
        // Bottom-left: (arm, 0) → (0, 0) → (0, arm)
        lines.push(`X${f(arm)}Y${fy(0)}D02*`)
        lines.push(`X${f(0)}Y${fy(0)}D01*`)
        lines.push(`X${f(0)}Y${fy(arm)}D01*`)
        // Bottom-right: (w-arm, 0) → (w, 0) → (w, arm)
        lines.push(`X${f(w - arm)}Y${fy(0)}D02*`)
        lines.push(`X${f(w)}Y${fy(0)}D01*`)
        lines.push(`X${f(w)}Y${fy(arm)}D01*`)
        // Top-right: (w, h-arm) → (w, h) → (w-arm, h)
        lines.push(`X${f(w)}Y${fy(h - arm)}D02*`)
        lines.push(`X${f(w)}Y${fy(h)}D01*`)
        lines.push(`X${f(w - arm)}Y${fy(h)}D01*`)
        // Top-left: (arm, h) → (0, h) → (0, h-arm)
        lines.push(`X${f(arm)}Y${fy(h)}D02*`)
        lines.push(`X${f(0)}Y${fy(h)}D01*`)
        lines.push(`X${f(0)}Y${fy(h - arm)}D01*`)
      }
    }
  }

  // ---- 6.5. L-shape marks on panel border (for copper & mask layers) ----
  // Generate L-shapes on panel border/outline corners
  if (config.enablePanelBorderLShape && layerType && layerNeedsLShapeMarks(layerType)) {
    const panelBorderLShapes = generatePanelBorderLShapeGerberCommands(
      panel.panelWidth,
      panel.panelHeight,
      config,
      fmt,
      lShapeBorderCode
    )
    lines.push(...panelBorderLShapes)
  }

  // ---- 7. Donut ring shapes around reference holes (for copper/mask/silkscreen) ----
  // Flash donut aperture (C,outerXinner) at each reference hole position.
  // Donut shapes are added to copper, mask, and silkscreen layers only (NOT paste).
  if (config.enableToolingHoles && layerType && layerNeedsDonutShapes(layerType)) {
    const refHoles = panel.toolingHoles.filter(h => h.type === 'reference')
    if (refHoles.length > 0) {
      const od = config.donutOuterDiameter || 2.25
      const id = config.donutInnerDiameter || 1.25
      // Add donut aperture definition (dynamic code — see findMaxDCode)
      lines.push(`%ADD${donutApertureCode}C,${od.toFixed(5)}X${id.toFixed(5)}*%`)

      const f = (v: number) => formatCoordinate(v, fmt)

      lines.push(`G54D${donutApertureCode}*`)
      for (const hole of refHoles) {
        lines.push(`X${f(hole.x)}Y${f(hole.y)}D03*`)
      }
    }
  }
  // ---- 7.5. Copper Fiducials (for copper and mask layers) ----
  if (config.enableFiducials && layerType && (layerType === 'copper' || layerType === 'mask') && panel.fiducials.length > 0) {
    const isTop = layerSide === 'top'
    const isBottom = layerSide === 'bottom'
    const enabledForSide = (isTop && config.fiducialsTop !== false) || (isBottom && config.fiducialsBottom !== false)

    if (enabledForSide) {
      const diameter = layerType === 'copper' ? config.fiducialDiameter : config.fiducialClearance
      // Add circular aperture definition (dynamic code — see findMaxDCode)
      lines.push(`%ADD${fiducialApertureCode}C,${diameter.toFixed(6)}*%`)

      const f = (v: number) => formatCoordinate(v, fmt)

      lines.push(`G54D${fiducialApertureCode}*`)
      for (const fid of panel.fiducials) {
        lines.push(`X${f(fid.x)}Y${f(fid.y)}D03*`)
      }
    }
  }

  // ---- 8. Text on panel ribs (copper/mask/silk layers, NOT paste) ----
  // Renders panel info text using either region-based or stroke-based font
  // Region-based produces solid shapes, stroke-based produces single-stroke lines.
  const isRegionFont = config.textFont === 'region'
  const layerNeedsFont = isRegionFont ? layerNeedsRegionText(layerType || 'none') : layerNeedsTextShapes(layerType || 'none')

  if (layerType && layerNeedsFont && panel.infoTexts.length > 0) {
    // Filter text:
    // 1. Generic panel info (location !== 'pcb-corner' and targetLayerType undefined)
    // 2. THIS specific layer's label (targetLayerType matches layerType AND targetLayerSide matches)
    const currentLayerSide = layerSide || 'none'
    console.log(`[Gerber Filter] Processing layer: ${layerType} (${currentLayerSide})`)
    console.log(`[Gerber Filter] Available infoTexts:`, panel.infoTexts.map(t => ({
      text: t.text,
      targetLayerType: t.targetLayerType,
      targetLayerSide: t.targetLayerSide
    })))

    const filteredText = panel.infoTexts.filter(t => {
      if (layerType === 'paste') return false // Double-check safety for paste

      if (!t.targetLayerType) {
        // Generic panel info text (customer ref, pcb name) - filter by mirroring
        // Top layers get only non-mirrored text
        // Bottom layers get only mirrored text
        if (currentLayerSide === 'top' && t.mirrored) return false
        if (currentLayerSide === 'bottom' && !t.mirrored) return false
        return true
      }

      // Layer-specific label: must match both type and side
      const typeMatch = t.targetLayerType === layerType
      const sideMatch = t.targetLayerSide === currentLayerSide
      console.log(`[Gerber Filter] Checking "${t.text}": typeMatch=${typeMatch} (${t.targetLayerType} vs ${layerType}), sideMatch=${sideMatch} (${t.targetLayerSide} vs ${currentLayerSide})`)
      return typeMatch && sideMatch
    })

    if (filteredText.length > 0) {
      console.log(`[Gerber] Adding ${filteredText.length} text items to ${layerType} (${currentLayerSide}) layer using ${isRegionFont ? 'region' : 'stroke'} font`)
      const textCmds = isRegionFont
        ? generateRegionTextGerberCommands(filteredText, fmt)
        : generateStrokeFontGerberCommands(filteredText, fmt, strokeFontApertureCode)
      lines.push(...textCmds)
    } else {
      console.log(`[Gerber] No text items for ${layerType} (${currentLayerSide}) layer`)
      console.log(`[Gerber] Available infoTexts:`, panel.infoTexts.map(t => ({
        text: t.text,
        targetLayerType: t.targetLayerType,
        targetLayerSide: t.targetLayerSide
      })))
    }
  }

  // Always reset to linear mode before end-of-file to avoid arc warnings in CAM tools
  if (lastInterp !== 'linear') {
    lines.push('G74*')
    lines.push('G01*')
  }

  lines.push('M02*')
  return lines.join('\n')
}

// ============================================================================
// Panel Outline Generation
// ============================================================================

/**
 * Generate panel outline Gerber commands.
 * Returns Gerber RS-274X string for the panel board outline layer.
 * Draws ONE single panel outline rectangle with specified width.
 */
export function generatePanelOutlineGerber(panel: PanelResult, config: PanelConfig, outputFormat?: OutputFormat): string {
  const fmt: OutputFormat = outputFormat || DEFAULT_OUTPUT_FORMAT
  const lines: string[] = []
  const pw = panel.panelWidth
  const ph = panel.panelHeight

  console.log(`[Panel Outline] Generating outline for ${pw.toFixed(1)}x${ph.toFixed(1)}mm panel with width: ${config.panelBorderWidth}mm`)

  // Use 3.4 format to match sample
  const outlineFmt: OutputFormat = {
    integerDigits: 3,
    decimalDigits: 4,
    unit: 'mm',
    zeroOmission: 'leading',
    notation: 'absolute'
  }

  // Header (matching sample format)
  lines.push('G04 Panel Border*')
  lines.push(generateFSCommand(outlineFmt))
  lines.push(generateMOCommand(outlineFmt))
  lines.push('%SFA1.000B1.000*%')
  lines.push('')
  lines.push('%MIA0B0*%')
  lines.push('%IPPOS*%')
  lines.push('%ADD143C,0.10000*%')   // Use D-code 143 like sample
  lines.push('%LNPanel_border*%')
  lines.push('%LPD*%')

  // G-unit code
  lines.push(generateGUnitCode(outlineFmt))
  lines.push('G54D143*')   // Select aperture

  const f = (v: number) => formatCoordinate(v, outlineFmt)

  // Single outer panel outline (matching sample format)
  lines.push(`X${f(0)}Y${f(0)}D02*`)
  lines.push(`G01X${f(pw)}Y${f(0)}D01*`)
  lines.push(`Y${f(ph)}*`)
  lines.push(`X${f(0)}*`)
  lines.push(`Y${f(0)}*`)

  lines.push('M02*')
  console.log(`[Panel Outline] Generated ${lines.length} lines`)
  return lines.join('\n')
}
