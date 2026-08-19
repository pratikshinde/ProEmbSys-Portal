/**
 * Panelization Engine
 * Computes panel layout, fiducials, tooling holes, L-shape tabs, and panel info.
 * Generates proper RS-274X Gerber output from parsed layer data.
 */

import { GerberLayer, GerberAperture, GerberDrawCommand } from './gerber-parser'
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
 * gerber-parser.ts names *which zeros were removed* from the file. Here,
 * under the default `camCompatibility: 'cam350'`, 'leading' (LZ) strips
 * TRAILING zeros and 'trailing' (TZ) strips LEADING zeros, because CAM350
 * inverts the meaning of the LZ/TZ header keywords. The two do not collide
 * today: exported drills carry an explicit header, and the drill we hand the
 * viewer is normalized to explicit decimals. Do not "unify" the two
 * conventions without re-testing the output in CAM350.
 *
 * `camCompatibility: 'standard'` writes the SAME header keyword but strips
 * the zeros the keyword actually names per the Excellon spec (no inversion)
 * — for readers that don't share CAM350's quirk (confirmed against
 * tracespace.io). Picking the wrong mode for your destination tool doesn't
 * drop or corrupt digits, it just reconstructs the decimal point in the
 * wrong place — every coordinate comes out shifted, which reads as "drills
 * don't line up with pads, holes are too small or too big."
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
  }

  // Anything other than exactly 'standard' keeps today's verified CAM350
  // inversion — including old/undefined `camCompatibility` values from a
  // template saved before this field existed.
  const cam350 = drillFmt.camCompatibility !== 'standard'
  // True meaning of 'leading' (LZ) per the Excellon spec is "leading zeros
  // were suppressed" — strip leading. CAM350 reads its own LZ keyword
  // backwards, so under 'cam350' compatibility we strip trailing instead
  // while still writing the LZ keyword the user selected.
  const stripLeadingZeros = drillFmt.zeroSuppression === 'leading' ? !cam350 : cam350

  const stripped = stripLeadingZeros
    ? truncated.replace(/^0+/, '') || '0'
    : truncated.replace(/0+$/, '') || '0'
  return isNegative ? `-${stripped}` : stripped
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

/**
 * Resolve the drill format actually used for an export: a clone of the
 * configured format, with the integer digits widened if the panel is large
 * enough to overflow them.
 *
 * Returns a **clone** — never mutates `config.drillFormat`, which is live store
 * state.
 *
 * ⚠ Deliberately does NOT sync the drill unit to the Gerber output unit.
 * Mixed units between Gerber (commonly mm) and Excellon drill (commonly
 * inch) is standard, well-supported practice — each file independently
 * declares its own unit in its own header (`%MOMM%`/`%MOIN%` vs
 * `METRIC`/`INCH`), and any correct reader scales off that declaration, not
 * off an assumption that the two files must match. A prior version of this
 * function force-synced the two "to keep CAM350 from displaying them at
 * different scales" — confirmed wrong against a real KiCad reference export
 * (4.6mm Gerber + 2:4 inch drill, its own default), which the sync silently
 * overrode into an all-metric drill file the user never asked for. Removed
 * rather than kept as an opt-in: forcing agreement between two files that
 * are supposed to be independent isn't a feature worth a checkbox for.
 *
 * @param label Prefix for the console warnings, so each caller's log messages
 *   stay distinguishable (e.g. 'Export' vs 'PINN Export').
 *
 * `panel` only needs `panelWidth`/`panelHeight` — typed as a `Pick` (not the
 * full `PanelResult`) so callers sizing a DIFFERENT sheet than the actual
 * single-PCB panel (e.g. the meta-panelization array's much larger sheet in
 * `panel-array.ts`) can pass a plain `{ panelWidth, panelHeight }` literal
 * instead of fabricating a fake `PanelResult`.
 */
export function resolveExportDrillFormat(
  drillFormat: DrillFormatConfig,
  panel: Pick<PanelResult, 'panelWidth' | 'panelHeight'>,
  label: string
): DrillFormatConfig {
  const drillFmt: DrillFormatConfig = { ...drillFormat }

  // Auto-fix drill format: ensure integer digits are sufficient for panel dimensions.
  const maxCoord = Math.max(panel.panelWidth, panel.panelHeight)
  const maxCoordInUnit = drillFmt.unit === 'mm' ? maxCoord : maxCoord / 25.4
  const neededIntDigits = maxCoordInUnit <= 0 ? 3 : Math.floor(Math.log10(maxCoordInUnit)) + 2
  if (drillFmt.integerDigits < neededIntDigits) {
    drillFmt.integerDigits = Math.min(neededIntDigits, 6)
    console.warn(`[${label}] Auto-upgraded drill format to ${drillFmt.integerDigits}:${drillFmt.decimalDigits}`)
  }

  return drillFmt
}

/**
 * Emit the Excellon tool-definition block that closes a drill header:
 * one `T<nn>C<dia><params>` line per tool, then DETECT,ON / ATC,ON / %.
 *
 * `toolDiametersMm` must already be sorted and de-duplicated — the index of
 * each entry is its T-code, so callers resolve a diameter back to a T-code by
 * position in the same array.
 */
export function emitExcellonToolBlock(
  toolDiametersMm: number[],
  drillFmt: DrillFormatConfig
): string[] {
  const lines: string[] = []

  // Tool definitions — T01C<diameter>F<feed>B<break>S<speed>H<peck>
  // CAM350 includes F/B/S/H parameters in tool definitions.
  // We use standard placeholder values that CAM350 recognizes:
  //   F = feed rate, B = board break, S = spindle speed, H = peck height
  const toolParams = drillFmt.unit === 'mm' ? 'F42B423S6H2000' : 'F100B1000S6H2000'
  for (let i = 0; i < toolDiametersMm.length; i++) {
    const tCode = (i + 1).toString().padStart(2, '0')
    let dia: number
    if (drillFmt.unit === 'mm') {
      dia = toolDiametersMm[i]
    } else {
      dia = toolDiametersMm[i] / 25.4
    }
    lines.push(`T${tCode}C${dia.toFixed(drillFmt.decimalDigits)}${toolParams}`)
  }

  // DETECT,ON and ATC,ON — required by CAM350, placed before %
  lines.push('DETECT,ON')
  lines.push('ATC,ON')

  // End of header
  lines.push('%')

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
  // Match %AM<name>*...*% blocks — they start with %AM and end with *%.
  // Name can contain letters, digits, underscores, and hyphens (CAM350 uses
  // hyphens, e.g. "RoundRect-D12" — one uniquely-named, fully-instantiated
  // macro per aperture, rather than KiCad's single shared parameterized
  // macro). ⚠ The `\*\s*%` (not `\*%`) is deliberate: a real CAM350/
  // DFMSTREAM export puts the closing `%` on its OWN line — `...0.0*\r\n%`,
  // not `...0.0*%` — so requiring the two characters adjacent matched
  // ZERO macro blocks in that file, which meant NO %AM definitions were
  // ever copied into the exported panel at all (not just a truncated name)
  // and every macro-referencing aperture came out undefined. Confirmed on
  // a real CAM350 V14.6 re-export of a KiCad board.
  const regex = /%AM[A-Za-z0-9_-]+\*[^%]*\*\s*%/g
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
          // Parameters are stored as $1, $2, ..., $10, ... — a plain string sort
          // orders "$10" before "$2" (lexicographic), silently shifting every
          // parameter after $9 by one position for any macro with 10+ params
          // (e.g. KiCad's RoundRect: radius + 8 corner coords + trailing $10).
          // That corrupts the box-body polygon and every vector-line endpoint
          // derived from it, even though the parser captured the values correctly.
          const keys = Object.keys(ap.parameters).sort(
            (a, b) => parseInt(a.slice(1), 10) - parseInt(b.slice(1), 10)
          )
          for (const key of keys) {
            paramParts.push(ap.parameters[key].toFixed(6))
          }
        }
        // A macro aperture can legitimately have ZERO modifiers — CAM350/
        // DFMSTREAM re-exports emit exactly this (`%ADD12RoundRect-D12*%`,
        // no comma at all) for a macro whose geometry is fully baked into
        // its own %AM block rather than parameterized. Per spec the comma
        // only appears when there's at least one modifier; emitting a
        // trailing `,` with nothing after it is not what any real file
        // does and risks a stricter parser treating the empty string as a
        // malformed modifier.
        adds.push(
          paramParts.length > 0
            ? `%ADD${code}${name},${paramParts.join('X')}*%`
            : `%ADD${code}${name}*%`
        )
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

/**
 * Which reader's LZ/TZ convention `formatDrillCoordinate` targets when
 * `zeroSuppression` is 'leading' or 'trailing' (irrelevant for 'none', which
 * is unambiguous fixed-width in both conventions).
 *
 * 'cam350' (default, matches every format this app has ever exported) keeps
 * the CAM350-inverted behavior documented on `formatDrillCoordinate` —
 * verified against real CAM350 output. 'standard' writes the same LZ/TZ
 * header keyword but strips the zeros the keyword ACTUALLY names per the
 * Excellon spec, for readers that don't share CAM350's inversion (confirmed:
 * tracespace.io, and by extension most non-CAM350 Excellon parsers). Picking
 * the wrong one for your destination tool doesn't corrupt content or drop
 * digits — it just reconstructs every coordinate's decimal point in the
 * wrong place, which reads as drills randomly offset from their pads.
 */
export type DrillCamCompatibility = 'cam350' | 'standard'

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
  /** Which reader's LZ/TZ convention to target — see `DrillCamCompatibility`. */
  camCompatibility: DrillCamCompatibility
}

/** Preset definitions — maps preset name to its format parameters */
export const DRILL_FORMAT_PRESETS: Record<DrillFormatPreset, Omit<DrillFormatConfig, 'preset'>> = {
  'excellon-2-4': { integerDigits: 2, decimalDigits: 4, unit: 'inches', zeroSuppression: 'none', camCompatibility: 'cam350' },
  'excellon-3-3': { integerDigits: 3, decimalDigits: 3, unit: 'mm', zeroSuppression: 'none', camCompatibility: 'cam350' },
  'excellon-2-5': { integerDigits: 2, decimalDigits: 5, unit: 'inches', zeroSuppression: 'none', camCompatibility: 'cam350' },
  'excellon-3-4': { integerDigits: 3, decimalDigits: 4, unit: 'mm', zeroSuppression: 'none', camCompatibility: 'cam350' },
  'custom': { integerDigits: 2, decimalDigits: 4, unit: 'inches', zeroSuppression: 'none', camCompatibility: 'cam350' },
}

export const DEFAULT_DRILL_FORMAT: DrillFormatConfig = {
  preset: 'excellon-2-4',
  integerDigits: 2,
  decimalDigits: 4,
  unit: 'inches',
  zeroSuppression: 'none',
  camCompatibility: 'cam350',
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
  toolingHoleInset: number // distance from PCB grid edge to tooling/reference hole row's center (mm) — must clear a router bit's swept path past the grid edge; see the routing-collision comment at its use in computePanel
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
  // Font sizes for rib text (mm, cap height)
  topRibFontSize: number // customer/PCB reference text on the top rib
  bottomRibFontSize: number // per-layer labels on the bottom rib
  // V-groove / V-scoring alignment marks on panel ribs (manual V-scoring machines)
  enableVScoreMarks: boolean
  vScoreMarkStyle: 'arrow' | 'ticks' | 'stub' | 'stub-arrow'
  vScoreMarkSizeMm: number
  vScoreMarkLineWidth: number
  vScoreMarkInternalSeams: boolean
  vScoreMarkRailBoundary: boolean
  // Standalone documentation layer with full-length score lines (own Gerber file)
  enableVScoreLayer: boolean
}

export interface PanelInfo {
  pcbName: string
  customerRef: string
  date: string
  revision: string
  layers: string // e.g., "GTL GBL GTS GBS GTO GBO"
}

const MONTH_ABBR = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']

// Panel-facing dates (PanelInfo.date default, and the export filename/README
// fallback when the user leaves it blank) use DD-MMM-YYYY, e.g. "29-JUL-2026" —
// unambiguous across locales, unlike DD/MM/YYYY vs MM/DD/YYYY on a fabricated
// panel or its filename.
export function formatPanelDate(d: Date = new Date()): string {
  const dd = String(d.getDate()).padStart(2, '0')
  const mmm = MONTH_ABBR[d.getMonth()]
  const yyyy = d.getFullYear()
  return `${dd}-${mmm}-${yyyy}`
}

/**
 * One board instance placed on the panel. `x`/`y` are the low corner in
 * panel-absolute Gerber Y-up mm; `w`/`h` are the bbox AS PLACED (already
 * swapped for a 90/270 rotation — never re-derive from a design's own
 * unrotated size). `row`/`col` are populated only in grid mode and are
 * DISPLAY/DEBUG ONLY — never load-bearing for geometry, since a future
 * free-packed panel has no row/col concept at all.
 */
export interface PanelPlacement {
  x: number
  y: number
  w: number
  h: number
  rotationDeg: 0 | 90 | 180 | 270
  designId: string
  row?: number
  col?: number
}

/** Per-design rollup for display/README/rib-meta-text — never geometry. */
export interface PanelDesignSummary {
  designId: string
  name: string
  widthMm: number
  heightMm: number
  count: number
  rotationsDeg: (0 | 90 | 180 | 270)[]
}

export interface PanelResult {
  panelWidth: number
  panelHeight: number
  /** Replaces the old `pcbPositions` — every placed board instance. */
  placements: PanelPlacement[]
  designs: PanelDesignSummary[]
  toolingHoles: { id: string; x: number; y: number; diameter: number; type: 'tooling' | 'reference' }[]
  fiducials: { id: string; x: number; y: number; diameter: number; clearance: number }[]
  infoTexts: InfoText[]
  totalPCBs: number
  grid?: { rows: number; cols: number }
  source: 'grid' | 'pack'
  /** V-groove/V-scoring alignment marks on the panel ribs — see `computeVScoreLines`. */
  vScoreLines: VScoreLine[]
}

/**
 * One V-score line spanning the whole panel — a straight seam a V-scoring
 * blade would cut along. `axis: 'x'` = a vertical line at constant X
 * (crosses the top/bottom ribs); `axis: 'y'` = a horizontal line at constant
 * Y (crosses the left/right ribs). `kind: 'rail'` = the panel's own outer
 * boundary seam (bbox edge of the placements); `'internal'` = a seam between
 * two rows/columns of boards. See `computeVScoreLines` for derivation.
 */
export type VScoreLine = { axis: 'x' | 'y'; coord: number; kind: 'internal' | 'rail' }

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
  toolingHoleInset: 3,
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
  topRibFontSize: 2.8,
  bottomRibFontSize: 2.8,
  enableVScoreMarks: false,
  vScoreMarkStyle: 'arrow',
  vScoreMarkSizeMm: 2.0,
  vScoreMarkLineWidth: 0.254,
  vScoreMarkInternalSeams: true,
  vScoreMarkRailBoundary: true,
  enableVScoreLayer: false,
}

// ============================================================================
// Panel Layout Computation
// ============================================================================

/**
 * Minimal shape `resolveDesignGeometry` needs — deliberately generic so both
 * `store.ts`'s `LayerEntry` (real `visible: boolean`) and `gerber-exporter.ts`'s
 * `LayerFile` (no `visible` field at all — every entry it's given is already
 * meant to be exported) can be passed in without either importing the other's type.
 */
export interface DesignGeometrySource {
  type: string
  visible?: boolean
  parsedLayer: { bounds: { minX: number; minY: number; maxX: number; maxY: number } | null } | null
}

export interface ResolvedDesignGeometry {
  /** `-bounds.min` — the ONE offset every layer/drill-hit/route path for this
   *  design must share so they land in the same panel-absolute space. */
  datum: { x: number; y: number }
  widthMm: number
  heightMm: number
  /** true when no `type === 'outline'` layer had usable bounds and the
   *  largest-visible-area fallback was used instead. */
  fromFallback: boolean
}

/**
 * The single canonical way to decide "which layer sizes/positions this
 * design" — same explicit-outline-then-largest-visible-area priority
 * `computePanelResult` has always used (`type === 'outline'` first, since
 * non-standard exports like Eagle's `profile.gbr` don't declare themselves as
 * one), now shared by every site that needs the datum: the exporter's
 * `globalBaseOffset`, `computePanelResult`, `generateGcodeFilesAction`, and
 * `generatePanelArrayFilesAction`.
 *
 * ⚠ Before this was extracted, the exporter's own `globalBaseOffset`
 * computation (`gerber-exporter.ts`) had NEITHER the largest-area fallback
 * NOR a visibility check — an outline-less design already sized correctly by
 * `computePanelResult` (via the fallback) would then export with every layer
 * falling back to ITS OWN bounds instead of one shared datum, misregistering
 * the panel. Unifying onto this one function is a real behavior fix for that
 * case, not just a refactor — the fallback now applies everywhere the datum
 * is computed, not only where panel size happens to be computed.
 *
 * Deliberately NOT used by routing's contour-trace decision
 * (`findOutlineBoundsLayer`, `store.ts`) — tracing "the largest layer" when
 * it isn't actually a board outline would trace copper or silk artwork as if
 * it were a board edge, which is a different and much worse kind of wrong
 * than a slightly-off panel size. That call site intentionally keeps its
 * stricter no-fallback behavior.
 */
export function resolveDesignGeometry<T extends DesignGeometrySource>(layers: T[]): ResolvedDesignGeometry | null {
  const outlineLayer = layers.find(l => l.type === 'outline' && l.visible !== false && l.parsedLayer?.bounds)
  let boundsLayer = outlineLayer
  let fromFallback = false
  if (!boundsLayer) {
    const allVisibleWithBounds = layers.filter(l => l.visible !== false && l.parsedLayer?.bounds)
    // Prefer a recognized layer type (copper/mask/silk/drill/paste/fab) over
    // an unclassified 'other' one for the largest-area fallback — an 'other'
    // layer's real meaning is unknown (could be a mechanical drawing, a
    // customer-supplied panel/array reference, dimension annotations, etc.),
    // and is often far larger than the real board, which silently inflates
    // the whole panel to that layer's size instead of the PCB's own
    // footprint. Confirmed on a real customer file: a 378.7×260.5mm
    // unclassified "Other/Unspecified" layer (not a per-board outline) got
    // picked over the real ~66×116mm copper/mask/silk bounds, sizing a 1×3
    // panel at ~1147×270mm. Only fall back to 'other' layers when nothing
    // else has usable bounds, so a genuinely unclassified single-layer
    // import still panelizes rather than silently failing.
    const typedWithBounds = allVisibleWithBounds.filter(l => l.type !== 'other')
    const visibleWithBounds = typedWithBounds.length > 0 ? typedWithBounds : allVisibleWithBounds
    if (visibleWithBounds.length > 0) {
      boundsLayer = visibleWithBounds.reduce((best, layer) => {
        const b = layer.parsedLayer!.bounds!
        const bestB = best.parsedLayer!.bounds!
        const area = (b.maxX - b.minX) * (b.maxY - b.minY)
        const bestArea = (bestB.maxX - bestB.minX) * (bestB.maxY - bestB.minY)
        return area > bestArea ? layer : best
      })
      fromFallback = true
    }
  }

  if (!boundsLayer?.parsedLayer?.bounds) return null
  const b = boundsLayer.parsedLayer.bounds
  return {
    datum: { x: -b.minX, y: -b.minY },
    widthMm: b.maxX - b.minX,
    heightMm: b.maxY - b.minY,
    fromFallback,
  }
}

/**
 * The uniform-lattice half of `computePanel` — sizes the panel and lays out
 * one copy of the board at every grid cell. Split out (alongside `finishPanel`
 * below) so a future non-uniform layout (multiple different board designs
 * packed onto one panel, rather than one design repeated) can build its own
 * `placements` and feed it through the exact same tooling-hole/fiducial/
 * rib-text pipeline instead of duplicating ~550 lines of hard-won geometry
 * corrections. `computePanel` itself stays the thin single-design entry point.
 */
/** Single-design grid mode has no real design identity yet (that's Stage 2's
 *  `LayerEntry.designId`) — every placement/summary uses this sentinel. */
const SINGLE_DESIGN_ID = 'default'

function buildGridPlacements(
  pcbWidth: number,
  pcbHeight: number,
  config: PanelConfig
): { placements: PanelPlacement[]; panelWidth: number; panelHeight: number } {
  const { rows, cols, gapX, gapY } = config

  const gridWidth = cols * pcbWidth + (cols - 1) * gapX
  const gridHeight = rows * pcbHeight + (rows - 1) * gapY
  const panelWidth = config.sideRibLeft + gridWidth + config.sideRibRight
  const panelHeight = config.sideRibTop + gridHeight + config.sideRibBottom

  // PCB positions.
  //
  // Y is up with the origin at the panel's bottom-left (CAM350 first quadrant),
  // so the grid starts at `sideRibBottom` — NOT `sideRibTop`, which is what this
  // used to say. With the default symmetric 5/5 ribs the two are equal and the
  // difference is invisible, but with asymmetric ribs the whole grid was offset
  // vertically by (sideRibTop − sideRibBottom): the tooling-hole exclusion zone
  // below (and its duplicate in the fiducial block) correctly derives from
  // `sideRibBottom`, so it no longer described where the PCBs actually were and
  // holes were placed on top of boards. Measured on a 2×2 panel with T=20/B=5:
  // five tooling/reference holes landed at Y=77 with the PCBs spanning 20..82.
  //
  // Every other consumer in this file already treats Y this way — the hole
  // placement (top rib at `panelHeight − sideRibTop/2`, bottom rib at
  // `sideRibBottom/2`), both grid-exclusion computations, the fiducial
  // fallbacks, and both rib-text generators. This line was the sole outlier.
  const placements: PanelPlacement[] = []
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      placements.push({
        x: config.sideRibLeft + c * (pcbWidth + gapX),
        y: config.sideRibBottom + r * (pcbHeight + gapY),
        w: pcbWidth,
        h: pcbHeight,
        rotationDeg: 0,
        designId: SINGLE_DESIGN_ID,
        row: r,
        col: c,
      })
    }
  }

  return { placements, panelWidth, panelHeight }
}

export function computePanel(
  pcbWidth: number,
  pcbHeight: number,
  config: PanelConfig,
  info?: PanelInfo
): PanelResult {
  const { placements, panelWidth, panelHeight } = buildGridPlacements(pcbWidth, pcbHeight, config)
  const designs: PanelDesignSummary[] = placements.length > 0 ? [{
    designId: SINGLE_DESIGN_ID,
    name: info?.pcbName || 'PCB',
    widthMm: pcbWidth,
    heightMm: pcbHeight,
    count: placements.length,
    rotationsDeg: [0],
  }] : []
  return finishPanel(placements, designs, panelWidth, panelHeight, config, 'grid', info)
}

/**
 * Build a `PanelResult` from an already-packed, non-uniform layout — the
 * `src/lib/packing/` engine's counterpart to `computePanel`. `placements`
 * must already be final (panel-absolute mm, one entry per placed board
 * instance); this only adds tooling holes, fiducials, and rib text on top,
 * through the exact same `finishPanel` pipeline grid mode uses.
 */
export function finishPackedPanel(
  placements: PanelPlacement[],
  designs: PanelDesignSummary[],
  panelWidth: number,
  panelHeight: number,
  config: PanelConfig,
  info?: PanelInfo
): PanelResult {
  return finishPanel(placements, designs, panelWidth, panelHeight, config, 'pack', info)
}

/**
 * Everything past layout: tooling holes, fiducials, and rib text — all
 * measured against the placements' own bounding box, never against
 * `rows`/`cols`/a single `pcbWidth`/`pcbHeight` directly, so this function
 * has no idea whether `placements` came from a uniform lattice or a packed,
 * multi-design layout.
 */
/**
 * Derives every full-panel-width/height V-score seam from the placements
 * themselves (never from `rows`/`cols`), so it works identically for grid
 * and packed layouts. Must run BEFORE tooling holes, fiducials, and rib text
 * in `finishPanel` so all three can avoid the marks (see `vScoreMarksAsHoles`).
 */
export function computeVScoreLines(
  placements: PanelPlacement[],
  panelWidth: number,
  panelHeight: number,
  config: PanelConfig
): VScoreLine[] {
  if (!config.enableVScoreMarks || placements.length === 0) return []

  const EPS = 0.01

  let plMinX = Infinity, plMinY = Infinity, plMaxX = -Infinity, plMaxY = -Infinity
  for (const p of placements) {
    plMinX = Math.min(plMinX, p.x)
    plMinY = Math.min(plMinY, p.y)
    plMaxX = Math.max(plMaxX, p.x + p.w)
    plMaxY = Math.max(plMaxY, p.y + p.h)
  }

  function deriveAxis(getLo: (p: PanelPlacement) => number, getHi: (p: PanelPlacement) => number, gap: number, bboxMin: number, bboxMax: number): { coord: number; kind: 'internal' | 'rail' }[] {
    // Collect raw candidate coordinates from every placement edge.
    const raw: number[] = []
    for (const p of placements) {
      raw.push(getLo(p), getHi(p))
    }
    raw.sort((a, b) => a - b)

    // Cluster within tolerance and emit the cluster midpoint — collapses the
    // two edges of a gapped seam (board-right-edge, next-board-left-edge)
    // into one physically-correct score line at the channel centre. At
    // gap = 0 the duplicates already coincide, so this is a no-op there.
    const tol = Math.max(gap, EPS)
    const clusters: number[][] = []
    for (const v of raw) {
      const last = clusters[clusters.length - 1]
      if (last && v - last[last.length - 1] <= tol) {
        last.push(v)
      } else {
        clusters.push([v])
      }
    }
    const candidates = clusters.map(c => c.reduce((a, b) => a + b, 0) / c.length)

    // Reject any candidate that passes through a placement's interior —
    // panel-wide: the blade crosses the whole panel width/height, so a line
    // valid for one row/column but cutting through another board is invalid.
    const valid = candidates.filter(c => !placements.some(p => c > getLo(p) + EPS && c < getHi(p) - EPS))

    return valid.map(coord => ({
      coord,
      kind: (Math.abs(coord - bboxMin) <= tol || Math.abs(coord - bboxMax) <= tol) ? 'rail' : 'internal',
    }))
  }

  const xLines = deriveAxis(p => p.x, p => p.x + p.w, config.gapX, plMinX, plMaxX) as { coord: number; kind: 'internal' | 'rail' }[]
  const yLines = deriveAxis(p => p.y, p => p.y + p.h, config.gapY, plMinY, plMaxY) as { coord: number; kind: 'internal' | 'rail' }[]

  const lines: VScoreLine[] = []
  for (const l of xLines) {
    if (l.kind === 'internal' && !config.vScoreMarkInternalSeams) continue
    if (l.kind === 'rail' && !config.vScoreMarkRailBoundary) continue
    lines.push({ axis: 'x', coord: l.coord, kind: l.kind })
  }
  for (const l of yLines) {
    if (l.kind === 'internal' && !config.vScoreMarkInternalSeams) continue
    if (l.kind === 'rail' && !config.vScoreMarkRailBoundary) continue
    lines.push({ axis: 'y', coord: l.coord, kind: l.kind })
  }
  return lines
}

/**
 * Renders each V-score line into rib-confined mark polylines (panel-absolute
 * Gerber Y-up mm) — the ONE shared geometry generator used by the
 * single-design emitter, the merged emitter, the standalone doc layer, and
 * the viewer preview, so all four can never disagree on shape.
 *
 * An `axis:'x'` (vertical) line crosses the top and bottom ribs → one mark
 * on each; an `axis:'y'` (horizontal) line crosses the left and right ribs →
 * one mark on each. A rib of zero width is skipped (warned, not invented).
 * All styles stay confined to the rib band — never enter the PCB grid area,
 * since built-in marks are injected into the customer's own copper/mask.
 */
export function computeVScoreMarkStrokes(
  lines: VScoreLine[],
  panelWidth: number,
  panelHeight: number,
  config: PanelConfig
): { x: number; y: number }[][] {
  const strokes: { x: number; y: number }[][] = []
  const size = config.vScoreMarkSizeMm
  const style = config.vScoreMarkStyle

  // One mark centered at `coord` along the rib's transverse axis, spanning
  // the rib band [bandLo, bandHi] along the rib's own axis.
  function pushMark(coord: number, bandLo: number, bandHi: number, transverse: 'x' | 'y') {
    if (bandHi - bandLo <= 0) return
    const mid = (bandLo + bandHi) / 2
    const mk = (a: number, b: number): { x: number; y: number } => transverse === 'x' ? { x: a, y: b } : { x: b, y: a }

    switch (style) {
      case 'arrow':
        strokes.push([
          mk(coord - size / 2, bandLo),
          mk(coord + size / 2, bandLo),
          mk(coord, bandHi),
          mk(coord - size / 2, bandLo),
        ])
        break
      case 'ticks':
        strokes.push([mk(coord - size / 2, bandLo), mk(coord - size / 2, bandHi)])
        strokes.push([mk(coord + size / 2, bandLo), mk(coord + size / 2, bandHi)])
        break
      case 'stub':
        strokes.push([mk(coord, bandLo), mk(coord, bandHi)])
        break
      case 'stub-arrow':
        strokes.push([mk(coord, bandLo), mk(coord, bandHi)])
        strokes.push([
          mk(coord - size / 2, mid - size / 4),
          mk(coord, mid + size / 4),
          mk(coord + size / 2, mid - size / 4),
        ])
        break
    }
  }

  for (const line of lines) {
    if (line.axis === 'x') {
      // vertical line -> marks on top/bottom ribs
      if (config.sideRibBottom > 0) pushMark(line.coord, 0, config.sideRibBottom, 'x')
      else console.warn('[V-Score] skipped bottom-rib mark: sideRibBottom is 0')
      if (config.sideRibTop > 0) pushMark(line.coord, panelHeight - config.sideRibTop, panelHeight, 'x')
      else console.warn('[V-Score] skipped top-rib mark: sideRibTop is 0')
    } else {
      // horizontal line -> marks on left/right ribs
      if (config.sideRibLeft > 0) pushMark(line.coord, 0, config.sideRibLeft, 'y')
      else console.warn('[V-Score] skipped left-rib mark: sideRibLeft is 0')
      if (config.sideRibRight > 0) pushMark(line.coord, panelWidth - config.sideRibRight, panelWidth, 'y')
      else console.warn('[V-Score] skipped right-rib mark: sideRibRight is 0')
    }
  }

  return strokes
}

function finishPanel(
  placements: PanelPlacement[],
  designs: PanelDesignSummary[],
  panelWidth: number,
  panelHeight: number,
  config: PanelConfig,
  source: 'grid' | 'pack',
  info?: PanelInfo
): PanelResult {
  // Derived from the placements' own bbox — mathematically identical to the
  // old `config.cols * pcbWidth + (cols-1)*gapX` formula for a uniform grid
  // (min(x) = sideRibLeft, max(x+w) = sideRibLeft + cols*pcbWidth +
  // (cols-1)*gapX, verified against the golden corpus), and correctly
  // generalizes to a non-uniform packed layout, where no single
  // pcbWidth/cols describes the layout at all.
  let plMinX = Infinity, plMinY = Infinity, plMaxX = -Infinity, plMaxY = -Infinity
  for (const p of placements) {
    plMinX = Math.min(plMinX, p.x)
    plMinY = Math.min(plMinY, p.y)
    plMaxX = Math.max(plMaxX, p.x + p.w)
    plMaxY = Math.max(plMaxY, p.y + p.h)
  }
  const gridWidth = placements.length > 0 ? plMaxX - plMinX : 0
  const gridHeight = placements.length > 0 ? plMaxY - plMinY : 0

  // V-score lines must be computed before tooling holes, fiducials, and rib
  // text, so all three can avoid the marks (see `vScoreMarksAsHoles`).
  const vScoreLines = computeVScoreLines(placements, panelWidth, panelHeight, config)

  // Representative single-board size for the parts of this function that
  // still assume one board (the rib-text call just below) — always correct
  // for grid mode (exactly one design, always), and a deliberate, documented
  // simplification for pack mode until a later stage generalizes rib text
  // to show every design rather than just the first.
  const pcbWidth = designs[0]?.widthMm ?? 0
  const pcbHeight = designs[0]?.heightMm ?? 0

  // Tooling holes — placed ONLY on side ribs, not on PCB area
  // Coordinate system: CAM350 first quadrant (X+ right, Y+ up, origin at bottom-left)
  const toolingHoles: PanelResult['toolingHoles'] = []
  if (config.enableToolingHoles) {
    // ⚠ `inset` is the hole row's clearance from the PCB grid edge (used for
    // ALL corner tooling/reference hole Y-positions below), NOT a distance
    // from the panel edge — see the routing-collision comment at the tlY/blY
    // assignments for why this must be measured from the grid edge.
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
      // Must not land on a V-score mark — marks are immovable.
      const onTopRib = y >= panelHeight - config.sideRibTop - 0.01
      const onBottomRib = y <= config.sideRibBottom + 0.01
      if (onTopRib || onBottomRib) {
        for (const mark of vScoreMarksAsHoles(vScoreLines, config, onTopRib)) {
          if (Math.abs(mark.x - x) < mark.diameter / 2 + diameter / 2 + 2.0) {
            console.log(`[${type} hole] Position (${x.toFixed(2)}, ${y.toFixed(2)}) rejected: V-score mark`)
            return
          }
        }
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
    // ⚠ Y is measured as `inset` OUT from the PCB grid edge (`gridTop`),
    // toward the panel's own outer edge — not dead-center of the rib
    // (`sideRibTop/2`, the old formula), and not `inset` in from the PANEL
    // edge either (this field's own doc comment used to claim that, but it
    // was dead code — never actually read anywhere — so that claim was never
    // exercised or verified). A depaneling router cuts a path offset OUTWARD
    // from the grid edge by the bit radius, so a hole only centered in the
    // rib leaves just `sideRibTop/2 − bitRadius` of clearance from that cut,
    // not `sideRibTop/2` — at the default 5mm rib this measured out to only
    // 1.5mm of actual gap against a 2mm bit + 2mm tooling hole (needs 2mm),
    // a real collision confirmed both with a standalone routing-planner
    // reproduction AND live on a real panel with no side ribs (where this
    // same rib-half-width formula still governs the top/bottom ribs that DO
    // remain) — the router path ran straight through the pinning hole.
    // `toolingHoleInset` already existed as a user-facing "Pinning Inset"
    // field for exactly this, just never actually wired up (`inset` was
    // assigned and unused). At its new 3mm default, clearance from a 2mm
    // bit is exactly 0 (tangent, not overlapping) for the default 2mm
    // tooling hole — the tightest of the three bit presets — and a
    // genuinely positive 0.5–1.0mm for the two smaller presets; a
    // routing-plan-time check (`plan-routing.ts`'s hole-collision issue)
    // is the authoritative backstop for whatever bit/hole-size combination
    // is actually in use, since this default can't see the future bit
    // choice. A rib narrower than `inset` simply won't fit a hole here at
    // all — `addHole`'s existing grid-overlap/edge-distance rejection
    // already skips it rather than placing something unsafe.
    const tlY = gridTop + inset  // From bottom edge (high Y in CAM350)
    console.log(`[Tooling hole] Top-left: (${tlX.toFixed(2)}, ${tlY.toFixed(2)})`)
    addHole('tooling_tl', tlX, tlY, config.toolingHoleDiameter, 'tooling')

    // Top-right corner (Y is high in CAM350 system)
    const trX = panelWidth - config.sideRibRight - toolingDistanceFromPCBEdge  // From panel edge
    const trY = tlY
    console.log(`[Tooling hole] Top-right: (${trX.toFixed(2)}, ${trY.toFixed(2)})`)
    addHole('tooling_tr', trX, trY, config.toolingHoleDiameter, 'tooling')

    // Bottom-left corner (Y is low in CAM350 system) - moved to 11mm as specified
    const blX = config.sideRibLeft + toolingDistanceFromPCBEdge - 1.5  // 12.5 - 1.5 = 11mm from panel edge
    const blY = gridBottom - inset  // From bottom edge (low Y in CAM350) — see tlY for why, not `sideRibBottom/2`
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
    //
    // Reference holes share the same routing-clearance Y as the tooling holes
    // above (`inset`, not `sideRib*/2`) — they sit in the same rib "row" by
    // design (same corner, aligned along one Y), so using a different Y here
    // would both reintroduce the same routing collision for these holes AND
    // break that alignment.

    // Bottom-left corner: 1 reference hole - moved to 7mm as specified
    if (config.sideRibBottom > 0) {
      const yRef = gridBottom - inset  // From bottom edge (low Y in CAM350)
      const xLeft = config.sideRibLeft + refInset - 1.0           // 7mm from panel edge (5mm rib + 2mm)
      console.log(`[Reference holes] Bottom-left: (${xLeft.toFixed(2)}, ${yRef.toFixed(2)})`)
      addHole('ref_bl', xLeft, yRef, config.referenceHoleDiameter, 'reference')
    }

    // Bottom-right corner: 1 reference hole
    if (config.sideRibBottom > 0) {
      const yRef = gridBottom - inset  // From bottom edge (low Y in CAM350)
      const xRight = panelWidth - config.sideRibRight - refInset  // 102mm from panel edge
      console.log(`[Reference holes] Bottom-right: (${xRight.toFixed(2)}, ${yRef.toFixed(2)})`)
      addHole('ref_br', xRight, yRef, config.referenceHoleDiameter, 'reference')
    }

    // Top-right corner: 1 reference hole
    if (config.sideRibTop > 0) {
      const yRef = gridTop + inset  // From bottom edge (high Y in CAM350)
      const xRight = panelWidth - config.sideRibRight - refInset  // 102mm from panel edge
      console.log(`[Reference holes] Top-right: (${xRight.toFixed(2)}, ${yRef.toFixed(2)})`)
      addHole('ref_tr', xRight, yRef, config.referenceHoleDiameter, 'reference')
    }

    // Top-left corner: 2 reference holes (for PCB orientation understanding)
    if (config.sideRibTop > 0) {
      const yRef = gridTop + inset  // From bottom edge (high Y in CAM350)
      const xLeft1 = config.sideRibLeft + refInset - 1.0       // 7mm from panel edge (5mm rib + 2mm) - gives 3.5mm spacing
      const xLeft2 = config.sideRibLeft + refInset + 2.5      // ~10.5mm from panel edge

      console.log(`[Reference holes] Top-left 1: (${xLeft1.toFixed(2)}, ${yRef.toFixed(2)})`)
      console.log(`[Reference holes] Top-left 2: (${xLeft2.toFixed(2)}, ${yRef.toFixed(2)})`)

      addHole('ref_tl1', xLeft1, yRef, config.referenceHoleDiameter, 'reference')
      addHole('ref_tl2', xLeft2, yRef, config.referenceHoleDiameter, 'reference')
    }
  }

  // `infoTexts` is populated further below, AFTER fiducials — see the note
  // at that population site for why the order flipped from an earlier
  // version of this function (fiducials used to run after text, so they
  // could avoid it; text now avoids fiducials instead, which needs the
  // REAL final fiducial position, not a guess at one).
  const infoTexts: InfoText[] = []

  // Fiducials — placed ONLY on side ribs, near corners, no overlap with tooling holes or other features
  let fiducials: PanelResult['fiducials'] = []
  const fidsTop = config.fiducialsTop !== false
  const fidsBottom = config.fiducialsBottom !== false
  if (config.enableFiducials && (fidsTop || fidsBottom)) {
    const gridLeft = config.sideRibLeft
    const gridRight = config.sideRibLeft + gridWidth
    const gridBottom = config.sideRibBottom
    const gridTop = config.sideRibBottom + gridHeight

    const radius = config.fiducialDiameter / 2
    const clearanceOffset = Math.max(0, (config.fiducialClearance - config.fiducialDiameter) / 2)
    // Shared with `fiducialsAsHoles` (used by the text functions below, which
    // now run AFTER this block) — kept as one function so the two can't
    // drift apart.
    const fidHalfSpan = fiducialHalfSpanMm(config)

    // Fiducial-to-fiducial spacing floor — the physical minimum that keeps
    // mask-clearance rings from touching. The actual TARGET spacing is
    // found by a binary search near the bottom of this block (see its own
    // comment) and written into `minFidSpacingMm`, read by check #4 in
    // `isValidPosition` below as a closure variable.
    const physicalMinFidSpacingMm = config.fiducialDiameter + clearanceOffset * 2 + 2.0
    let minFidSpacingMm = physicalMinFidSpacingMm

    // ⚠ A fiducial no longer needs to avoid the customer/PCB-name legend or
    // the revision/date/size overflow text at all — this block now runs
    // BEFORE `generatePanelMetaText`/`generateLayerLabels` are called (see
    // the `infoTexts` population site further down), and THOSE functions
    // avoid the fiducial instead (`fiducialsAsHoles`), using its real final
    // position. That flip is deliberate: a reservation computed here could
    // only ever guess at where a fiducial's own fallback/widest-spacing
    // search will actually land it, and a real customer panel showed that
    // guess going wrong in both directions — too narrow (text still
    // overlapping the fiducial) and too wide (text needlessly shoved into a
    // real hole's clearance zone to dodge a fiducial that never actually
    // landed near there). Avoiding the REAL position afterward has no such
    // guessing problem.
    //
    // The ONE reservation still needed here is the bottom rib's RIGHT side:
    // real per-layer labels aren't generated until `generateLayerLabels`,
    // called much later in store.ts once the customer's Gerber imports are
    // known — by then this fiducial's position is already fixed and can't
    // be revisited, so this still has to guess at a WORST-CASE label zone
    // the way it always did (see `worstCaseBottomRibLabelZone`'s own docs).
    interface XInterval { min: number; max: number }
    const worstCase = worstCaseBottomRibLabelZone(config, panelWidth, toolingHoles, vScoreLines)
    const bottomRibIntervals: XInterval[] = [{ min: worstCase.minX, max: worstCase.maxX }]
    const bottomRibBandY = { min: 0, max: config.sideRibBottom }

    // ⚠ Band membership must be inflated by `fidHalfSpan` too, not just the
    // interval check within the band — a fiducial's CENTER can sit just
    // outside the bottom rib's Y band while its clearance-inflated disc
    // still physically reaches into the band and touches the reserved zone
    // there.
    function collidesWithRibText(x: number, y: number): boolean {
      if (y + fidHalfSpan >= bottomRibBandY.min && y - fidHalfSpan <= bottomRibBandY.max) {
        for (const iv of bottomRibIntervals) {
          if (x + fidHalfSpan >= iv.min && x - fidHalfSpan <= iv.max) return true
        }
      }
      return false
    }

    function isValidPosition(x: number, y: number, ignoreRibText = false): boolean {
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

      // 3b. Must not overlap a V-score mark — marks are immovable, a
      // fiducial must dodge them the same way it dodges a real hole.
      // Vertical (axis:'x') marks live on the top/bottom ribs; horizontal
      // (axis:'y') marks live on the left/right ribs — check whichever rib
      // this candidate is actually on.
      const onBottomOrTopRib = y <= config.sideRibBottom + 0.01 || y >= panelHeight - config.sideRibTop - 0.01
      if (onBottomOrTopRib) {
        for (const mark of vScoreMarksAsHoles(vScoreLines, config, y >= panelHeight - config.sideRibTop - 0.01)) {
          if (Math.abs(mark.x - x) < mark.diameter / 2 + (config.fiducialDiameter / 2) + clearanceOffset + 2.0) return false
        }
      }

      // 4. Must not overlap with other already placed fiducials — and stay
      // at least `minFidSpacingMm` apart (see the tiered-retry loop below):
      // the bare physical minimum here used to be the ONLY spacing rule, so
      // a scan or a small panel could legally place two fiducials just a
      // few mm apart — technically non-overlapping but useless for
      // pick-and-place/AOI, which wants fiducials well spread out for an
      // accurate affine fit. Confirmed live: three fiducials landing within
      // a 25mm span, two of them under 20mm apart, after the "no side ribs"
      // scan fallback above put all three on the same rib.
      for (const fid of fiducials) {
        const dist = Math.hypot(fid.x - x, fid.y - y)
        if (dist < minFidSpacingMm) {
          return false
        }
      }

      // 5. Must not collide with rib text (layer-name labels or the
      // customer/PCB-name legend) — see the reservation comment above.
      // Skippable (`ignoreRibText`) for the absolute-last-resort fiducial
      // scan tier: "minimum 3 fiducials" is a hard requirement, avoiding
      // decorative text is only a preference, and on a single narrow rib
      // carrying holes + meta text + the worst-case per-layer-label
      // reservation all at once, that reservation can legitimately consume
      // the whole rib and leave zero HOLE-clear spots that also miss text —
      // in that case a fiducial slightly under some rib text beats only
      // having one or two fiducials on the whole panel.
      if (!ignoreRibText && collidesWithRibText(x, y)) {
        return false
      }

      return true
    }
 
    function addFiducial(id: string, x: number, y: number, ignoreRibText = false) {
      if (isValidPosition(x, y, ignoreRibText)) {
        const override = config.xyOverrides?.[id]
        const finalX = override?.x !== undefined ? override.x : x
        const finalY = override?.y !== undefined ? override.y : y

        fiducials.push({ id, x: finalX, y: finalY, diameter: config.fiducialDiameter, clearance: config.fiducialClearance })
        console.log(`[Fiducial] Added ${id} at (${finalX.toFixed(2)}, ${finalY.toFixed(2)})`)
        return true
      }
      return false
    }

    // Scanning fallbacks — see `fiducialFallbackChain` below. Only reached
    // once the two fixed candidates for a corner both fail, so the common
    // case (all four ribs present) is byte-identical to before.
    function scanHorizontalRib(y: number, xFrom: number, xTo: number, stepMm: number, ignoreRibText = false): { x: number; y: number } | null {
      const dir = xTo >= xFrom ? 1 : -1
      for (let x = xFrom; dir > 0 ? x <= xTo : x >= xTo; x += dir * stepMm) {
        if (isValidPosition(x, y, ignoreRibText)) return { x, y }
      }
      return null
    }
    function scanVerticalRib(x: number, yFrom: number, yTo: number, stepMm: number, ignoreRibText = false): { x: number; y: number } | null {
      const dir = yTo >= yFrom ? 1 : -1
      for (let y = yFrom; dir > 0 ? y <= yTo : y >= yTo; y += dir * stepMm) {
        if (isValidPosition(x, y, ignoreRibText)) return { x, y }
      }
      return null
    }

    // "Minimum 3 fiducials" is a hard requirement — a panel is only useful
    // for pick-and-place/AOI registration with all three present, and
    // dropping to one or two is a real defect, not a cosmetic shortfall (the
    // routing/DFM engines raise blocking errors for the fabrication-safety
    // equivalent of this; rib text degrades gracefully because it's cosmetic
    // branding — fiducials are neither). The two FIXED candidates per corner
    // below were tuned for the common case (all four ribs present) and are
    // kept first for byte-identical output there, but they structurally
    // cannot succeed once the relevant side rib is removed: the fallback
    // candidate centers the fiducial IN that rib (`sideRibLeft/2` /
    // `panelWidth - sideRibRight/2`), which sits exactly on the panel edge
    // — outside the margin check — once that rib's width is 0. Confirmed
    // live: removing the left AND right ribs left only `fid_tr` placed (its
    // primary candidate happens to live on the TOP rib, which was still
    // present), fid_bl/fid_br both silently missing.
    //
    // `fiducialFallbackChain` scans whichever ribs still have nonzero width
    // — first a narrower "stay on your own corner's side" range so the
    // three fiducials remain usefully spread out for orientation, then (if
    // that finds nothing — e.g. rib-text or an unusually dense hole layout
    // fills that whole range) the FULL rib width as a last resort. This
    // guarantees a valid spot whenever ANY horizontal rib (top or bottom)
    // has room anywhere, regardless of which side ribs are enabled.
    const scanStepMm = 2.0
    interface FiducialScanAttempt {
      scan: () => { x: number; y: number } | null
      ignoreRibText: boolean
    }

    function fiducialFallbackChain(preferLeft: boolean, preferTop: boolean): FiducialScanAttempt[] {
      const bottomY = config.sideRibBottom / 2
      const topY = panelHeight - config.sideRibTop / 2
      const sideX = preferLeft ? config.sideRibLeft / 2 : panelWidth - config.sideRibRight / 2
      const sideRibWidth = preferLeft ? config.sideRibLeft : config.sideRibRight
      const xMargin = radius + 1.0
      const xFar = panelWidth - radius - 1.0
      const yMargin = radius + 1.0
      const yFar = panelHeight - radius - 1.0
      const ownSideNear = preferLeft ? xMargin : xFar
      const ownSideFar = preferLeft ? panelWidth * 0.4 : panelWidth * 0.6

      const ownSideBottom: FiducialScanAttempt = { scan: () => config.sideRibBottom > 0 ? scanHorizontalRib(bottomY, ownSideNear, ownSideFar, scanStepMm) : null, ignoreRibText: false }
      const ownSideTop: FiducialScanAttempt = { scan: () => config.sideRibTop > 0 ? scanHorizontalRib(topY, ownSideNear, ownSideFar, scanStepMm) : null, ignoreRibText: false }
      const ownSideRib = preferTop ? [ownSideTop, ownSideBottom] : [ownSideBottom, ownSideTop]

      return [
        ...ownSideRib,
        { scan: () => sideRibWidth > 0 ? scanVerticalRib(sideX, yMargin, yFar, scanStepMm) : null, ignoreRibText: false },
        { scan: () => config.sideRibBottom > 0 ? scanHorizontalRib(bottomY, xMargin, xFar, scanStepMm) : null, ignoreRibText: false },
        { scan: () => config.sideRibTop > 0 ? scanHorizontalRib(topY, xMargin, xFar, scanStepMm) : null, ignoreRibText: false },
        // Absolute last resort: same two full-width scans again, but this
        // time ignoring the rib-text reservation (never the holes/grid/other
        // fiducials, which are real physical constraints). On a single
        // narrow rib carrying holes + meta text + the worst-case per-layer-
        // label reservation all at once, that reservation can legitimately
        // consume the whole rib — confirmed live (sideRibTop=0, only an 8mm
        // bottom rib) — and a fiducial slightly under some rib text beats
        // the panel having only one or two fiducials at all. `ignoreRibText`
        // must carry through to the final `addFiducial` re-validation below,
        // not just the scan — otherwise the scan approves a spot the
        // re-check then silently rejects again, and the fallback never
        // actually succeeds (confirmed live: the scan found x=11.5 on an
        // 8mm bottom rib, but `addFiducial` re-validated without the flag
        // and rejected that same spot).
        { scan: () => config.sideRibBottom > 0 ? scanHorizontalRib(bottomY, xMargin, xFar, scanStepMm, true) : null, ignoreRibText: true },
        { scan: () => config.sideRibTop > 0 ? scanHorizontalRib(topY, xMargin, xFar, scanStepMm, true) : null, ignoreRibText: true },
      ]
    }

    function placeFiducial(id: string, fixedCandidates: { x: number; y: number }[], scanFallbacks: FiducialScanAttempt[]): boolean {
      for (const c of fixedCandidates) {
        if (addFiducial(id, c.x, c.y)) return true
      }
      for (const attempt of scanFallbacks) {
        const spot = attempt.scan()
        if (spot && addFiducial(id, spot.x, spot.y, attempt.ignoreRibText)) return true
      }
      return false
    }

    // We place three fiducials near the corners (Bottom-Left, Bottom-Right,
    // Top-Right). Places all three from scratch at a given spacing —
    // restarting together, rather than keeping whichever corners already
    // succeeded and only retrying the failures, avoids an early corner
    // greedily claiming a spot at a spacing that a LATER corner then can't
    // match, when a slightly different (still-achievable) choice for the
    // early corner would have left room for all three.
    //
    // `allowIgnoreRibText` gates whether the scan chain's absolute-last-
    // resort tiers (which skip the rib-text collision check) are even
    // offered — see the phased search below for why this has to be a
    // separate axis from the spacing search, not just another fallback tier.
    function attemptAllAtSpacing(spacingMm: number, allowIgnoreRibText: boolean): boolean {
      minFidSpacingMm = spacingMm
      fiducials = []
      const chain = (preferLeft: boolean, preferTop: boolean) => {
        const full = fiducialFallbackChain(preferLeft, preferTop)
        return allowIgnoreRibText ? full : full.filter(a => !a.ignoreRibText)
      }

      const blOk = placeFiducial('fid_bl', [
        { x: config.sideRibLeft + 15, y: config.sideRibBottom / 2 },
        { x: config.sideRibLeft / 2, y: config.sideRibBottom + 12 }
      ], chain(true, false))

      const brOk = placeFiducial('fid_br', [
        { x: panelWidth - config.sideRibRight - 40, y: config.sideRibBottom / 2 },
        { x: panelWidth - config.sideRibRight / 2, y: config.sideRibBottom + 12 }
      ], chain(false, false))

      const trOk = placeFiducial('fid_tr', [
        { x: panelWidth - config.sideRibRight - 20, y: panelHeight - config.sideRibTop / 2 },
        { x: panelWidth - config.sideRibRight / 2, y: panelHeight - config.sideRibTop - 12 }
      ], chain(false, true))

      return blOk && brOk && trOk
    }

    // Search for the WIDEST fiducial-to-fiducial spacing this panel can
    // actually achieve, rather than settling for the first of a few fixed
    // tiers that merely clears a floor. Real pick-and-place/AOI vision
    // systems compute panel rotation/skew from the ANGLE between fiducials —
    // the further apart they are, the less a small pixel-measurement error
    // amplifies into a large angle error, so "as far apart as the panel
    // allows" is the actual industry-practice target, not just "far enough
    // to not cluster."
    //
    // ⚠ This is deliberately a LINEAR descent over candidate spacings, not a
    // binary search. A binary search needs `attemptAllAtSpacing(spacing)` to
    // be monotonic — success at a wide spacing implying success at every
    // narrower one — and that does NOT actually hold here. `fid_bl` is
    // spacing-invariant (no other fiducial exists yet when it's placed), but
    // `fid_br` and `fid_tr` each take the FIRST candidate that clears their
    // deterministic scan order; as the spacing threshold changes, an EARLIER
    // (closer) candidate can newly become valid and get chosen instead of
    // the one used at a different threshold. That can shift `fid_br` into a
    // position that leaves LESS room for `fid_tr` than a narrower spacing
    // would have — success is not simply "wider threshold, more room."
    // Confirmed live: a bisection here converged to 15.5mm minimum spacing
    // on a small panel even though 20mm was directly achievable — the
    // midpoints binary search happened to probe in between landed on a
    // worse `fid_br` placement and falsely reported failure, permanently
    // discarding the wider half of the range. A plain descending scan can't
    // make that mistake: it tests real candidate spacings in order from
    // widest to narrowest and keeps the first (i.e. widest) that actually
    // works, so it can never do worse than any individual spacing it tests.
    // `diagonalMm` is a safe, always-unreachable upper bound, since no two
    // points inside the panel can be farther apart than its own diagonal,
    // let alone three pairs simultaneously. The step count is a FRACTION of
    // the full range, so resolution scales with panel size automatically —
    // fine-grained on a small panel, coarser (but still sub-mm to a few mm)
    // on a large one — while keeping the total number of placement attempts
    // (and thus runtime) bounded regardless of panel size.
    //
    // ⚠ The search runs in TWO PHASES, not one search that happens to reach
    // the `ignoreRibText` tiers when convenient. A single search across the
    // full chain (spacing and text-avoidance both relaxing together)
    // pushes the spacing *as wide as the loosest rule allows* — which
    // routinely means landing on an `ignoreRibText` position purely to buy
    // a few more mm of spread, even though a slightly tighter — but
    // otherwise completely clean — spacing was available. Confirmed live:
    // a 100mm-wide panel placed `fid_tr` directly under the customer/PCB
    // name text, when backing off to a still-wide-enough spacing avoided
    // it entirely. `ignoreRibText` exists ONLY to guarantee "minimum 3" as
    // a last resort (see that section above) — it must never be spent on
    // spacing that clean placement didn't need. So: search phase 1 with
    // `allowIgnoreRibText: false` first; only if THAT fails even at the
    // physical floor (i.e. clean placement is impossible at any spacing)
    // does phase 2 re-run the same search allowing it.
    const diagonalMm = Math.hypot(panelWidth, panelHeight)
    const spacingSearchSteps = 48
    function widestSpacingSearch(allowIgnoreRibText: boolean): boolean {
      const range = diagonalMm - physicalMinFidSpacingMm
      for (let i = 0; i <= spacingSearchSteps; i++) {
        const spacing = i === spacingSearchSteps
          ? physicalMinFidSpacingMm
          : diagonalMm - (i / spacingSearchSteps) * range
        if (attemptAllAtSpacing(spacing, allowIgnoreRibText)) return true
      }
      return false
    }

    if (!widestSpacingSearch(false)) {
      widestSpacingSearch(true)
    }

    if (fiducials.length < 3) {
      console.warn(`[Fiducial] Could only place ${fiducials.length}/3 fiducials even at the tightest spacing (${physicalMinFidSpacingMm.toFixed(1)}mm) — panel has no rib space left anywhere`)
    }
  }

  // Generate panel meta text (Customer/PCB name, revision, date, PCB size,
  // panel size) AFTER fiducials, passing the now-final `fiducials` array
  // through — see the reordering note at `infoTexts`'s declaration above for
  // why this flipped from an earlier version that ran text first.
  if (info) {
    const metaTexts = generatePanelMetaText(info, pcbWidth, pcbHeight, panelWidth, panelHeight, config, toolingHoles, fiducials, vScoreLines)
    infoTexts.push(...metaTexts)
  }

  return {
    panelWidth,
    panelHeight,
    placements,
    designs,
    toolingHoles,
    fiducials,
    infoTexts,
    totalPCBs: placements.length,
    grid: source === 'grid' ? { rows: config.rows, cols: config.cols } : undefined,
    source,
    vScoreLines,
  }
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
/**
 * A fiducial's clearance-inflated "radius" — copper dot radius plus the
 * gap out to the mask keep-out ring, plus a small explicit margin beyond
 * that geometry so the ring doesn't just barely graze a neighboring
 * feature (confirmed live on real panels: 1mm alone left text/holes
 * landing only ~1mm from a fiducial's edge — technically clear but too
 * tight to trust against real fab registration tolerance). Shared by
 * `computePanel`'s own fiducial placement AND `fiducialsAsHoles` below, so
 * the two can't drift apart.
 */
function fiducialHalfSpanMm(config: PanelConfig): number {
  const radius = config.fiducialDiameter / 2
  const clearanceOffset = Math.max(0, (config.fiducialClearance - config.fiducialDiameter) / 2)
  const marginBeyondClearanceMm = 1.5
  return radius + clearanceOffset + marginBeyondClearanceMm
}

/**
 * Adapts already-placed fiducials into the `{x, diameter}` shape
 * `clearHolesAlongAxis` expects, so rib TEXT (the customer/PCB-name line,
 * the revision/date/size overflow lines, and per-layer labels) can treat a
 * fiducial as just one more obstacle to clear — restoring the "reference
 * hole, tooling hole, fiducial, THEN text" reading order a real customer
 * asked for at a corner. `fid.clearance` is already the mask keep-out
 * ring's OUTER diameter (see `clearanceOffset`'s derivation above), so no
 * extra half-span math is needed here the way the fiducial's OWN placement
 * needs `fiducialHalfSpanMm` — `clearHolesAlongAxis` adds its own
 * `clearanceMm` buffer on top, same as it does for real holes.
 *
 * Filtered to `ribY`'s band first — a fiducial that (via its own fallback
 * chain) ended up on a DIFFERENT rib than the text being laid out must not
 * phantom-block that text; only same-rib fiducials are real obstacles here.
 */
function fiducialsAsHoles(
  fiducials: PanelResult['fiducials'],
  ribYMin: number,
  ribYMax: number
): { x: number; diameter: number }[] {
  return fiducials
    .filter(f => f.y >= ribYMin - 0.01 && f.y <= ribYMax + 0.01)
    .map(f => ({ x: f.x, diameter: f.clearance }))
}

/**
 * V-score marks as obstacles, same `{x, diameter}[]` shape `fiducialsAsHoles`
 * already produces for `clearHolesAlongAxis` — marks are IMMOVABLE (their
 * coordinate is fixed by the score line they annotate), so everything else
 * (rib text, fiducials, tooling/reference holes) must yield around them, not
 * the reverse. Only `axis:'x'` (vertical) lines mark the top/bottom ribs,
 * which are the ribs carrying the horizontal text these callers place.
 * `diameter` is the mark's full X extent — `clearHolesAlongAxis` adds its
 * own clearance on top, same as for a real hole.
 */
function vScoreMarksAsHoles(
  vScoreLines: VScoreLine[],
  config: PanelConfig,
  ribIsTop: boolean
): { x: number; diameter: number }[] {
  if (!config.enableVScoreMarks) return []
  const ribWidth = ribIsTop ? config.sideRibTop : config.sideRibBottom
  if (ribWidth <= 0) return []
  return vScoreLines
    .filter(l => l.axis === 'x')
    .filter(l => (l.kind === 'internal' && config.vScoreMarkInternalSeams) || (l.kind === 'rail' && config.vScoreMarkRailBoundary))
    .map(l => ({ x: l.coord, diameter: config.vScoreMarkSizeMm }))
}

/**
 * The free-width zone on the RIGHT side of the bottom rib that
 * `generateLayerLabels`'s per-layer labels will eventually occupy. The real
 * layer list isn't known this early (`computePanel` has no access to it —
 * layer labels are generated later, in `store.ts`, once the customer's
 * actual Gerber imports are known) so this is a worst-case reservation sized
 * from the longest label string this codebase's naming ever produces
 * ("Bottom Copper"/"Bottom Silk"/"Bottom Paste", all 13 characters), at the
 * actual configured rib font size, anchored at the same fixed
 * `panelWidth - 17` / `panelWidth - 30` positions `generateLayerLabels`
 * itself uses. Shared by the fiducial rib-text reservation and by
 * `generatePanelMetaText`'s bottom-rib-left overflow placement, so the two
 * can't drift apart.
 *
 * ⚠ Must run the SAME `clearHolesAlongAxis` hole-avoidance `generateLayerLabels`
 * itself applies, using the same worst-case width, direction, and
 * `holeClearanceMm` — not just the raw unshifted `panelWidth - 17` /
 * `panelWidth - 30` anchors. A real panel's `ref_br`/`tooling_br` can sit
 * close enough to the bottom-right corner that `generateLayerLabels` shifts
 * its real "Bottom Copper" label further left/right than this reservation
 * assumed, letting a fiducial validated against the (too-narrow) unshifted
 * zone land under the label once it's actually placed — confirmed via a
 * randomized sweep across panel/rib sizes: `fid_br` landing within under
 * 1mm of the real label's edge, a consistent gap regardless of panel size
 * (the shift itself doesn't depend on panel size, only on hole geometry
 * relative to the corner). Passing `toolingHoles` here and reusing the exact
 * same shift logic keeps the two reservations honest instead of two
 * independently-guessed anchors that can silently drift apart.
 *
 * ⚠ The reservation unions BOTH the unshifted anchor AND the
 * `clearHolesAlongAxis`-shifted one (each spanned by the worst-case width),
 * rather than trusting the shifted one alone. `clearHolesAlongAxis`'s
 * retreat-vs-advance choice depends on the SPAN WIDTH — a real label is
 * almost always narrower than the worst-case string, so it can collide with
 * a hole the (wider) worst-case span doesn't, or resolve the same collision
 * by shifting a different amount or even a different direction. A follow-up
 * randomized sweep caught exactly this after the shift-aware fix above:
 * "Top Copper" (real, narrower) shifted from its unshifted anchor while the
 * worst-case-width span at that same anchor found no collision to shift
 * for, so the single "shifted" span alone didn't cover the real label's
 * position. Unioning both is a cheap superset that doesn't need to reason
 * about which specific width would trigger which shift.
 */
function worstCaseBottomRibLabelZone(
  config: PanelConfig,
  panelWidth: number,
  toolingHoles?: PanelResult['toolingHoles'],
  vScoreLines?: VScoreLine[]
): { minX: number; maxX: number } {
  const bottomRibFontSizeMm = config.bottomRibFontSize ?? 1.8
  const worstCaseLabelWidth = measureRegionText('Bottom Copper') * bottomRibFontSizeMm
  const bottomGroupAnchorX = panelWidth - 17
  const topGroupAnchorX = panelWidth - 30
  const holeClearanceMm = 2.5
  const ribHeight = config.sideRibBottom
  const bottomRibHoles: { x: number; diameter: number }[] = (toolingHoles ?? [])
    .filter(h => h.y >= -0.01 && h.y <= ribHeight + 0.01)
    .map(h => ({ x: h.x, diameter: h.diameter }))
    .concat(vScoreMarksAsHoles(vScoreLines ?? [], config, false))
  const clearedBottomAnchorX = clearHolesAlongAxis(bottomGroupAnchorX, worstCaseLabelWidth, bottomRibHoles, 'left', holeClearanceMm)
  const clearedTopAnchorX = clearHolesAlongAxis(topGroupAnchorX, worstCaseLabelWidth, bottomRibHoles, 'right', holeClearanceMm)
  return {
    minX: Math.min(
      bottomGroupAnchorX - worstCaseLabelWidth,
      clearedBottomAnchorX - worstCaseLabelWidth,
      topGroupAnchorX,
      clearedTopAnchorX
    ),
    maxX: Math.max(
      bottomGroupAnchorX,
      clearedBottomAnchorX,
      topGroupAnchorX + worstCaseLabelWidth,
      clearedTopAnchorX + worstCaseLabelWidth
    ),
  }
}

/**
 * Nudge a text anchor along one growth direction until it clears every hole
 * in the list — `[anchor, anchor+width]` growing right, `[anchor-width,
 * anchor]` growing left — iterating to a fixed point since clearing one hole
 * can newly overlap another further along the same direction. Shared by
 * `generateLayerLabels` (bottom-rib layer labels vs. tooling/reference
 * holes) and `generatePanelMetaText` (top-rib and bottom-rib-left overflow
 * text vs. the same holes).
 *
 * On a collision there are always two ways to clear a hole — retreat behind
 * its near edge, or advance past its far edge — and this picks whichever
 * needs LESS displacement from the current anchor, not always retreat. An
 * earlier version always retreated, which is what `generateLayerLabels`'s
 * right-growing labels happen to want (their anchor starts near the panel's
 * right edge with open space to their left) but is the wrong choice for
 * left-anchored, right-growing text with a hole close by (`
 * generatePanelMetaText`'s bottom-rib-left overflow, and its top-rib name
 * line on a small-rib panel): retreating from a small hole a few mm to the
 * right of a left-edge anchor pushes the anchor negative — off the panel
 * entirely — confirmed live (anchor landed at -32mm on a 110mm panel).
 * Advancing past the hole instead needs only a few mm and stays on-panel.
 */
function clearHolesAlongAxis(
  startX: number,
  width: number,
  holes: { x: number; diameter: number }[],
  direction: 'right' | 'left',
  clearanceMm: number
): number {
  let anchor = startX
  for (let iter = 0; iter <= holes.length; iter++) {
    let moved = false
    for (const h of holes) {
      const holeMin = h.x - h.diameter / 2 - clearanceMm
      const holeMax = h.x + h.diameter / 2 + clearanceMm
      if (direction === 'right') {
        const spanLo = anchor, spanHi = anchor + width
        if (spanHi > holeMin && spanLo < holeMax) {
          const retreat = holeMin - width  // span entirely before the hole
          const advance = holeMax          // span entirely after the hole
          anchor = Math.abs(retreat - anchor) <= Math.abs(advance - anchor) ? retreat : advance
          moved = true
        }
      } else {
        const spanLo = anchor - width, spanHi = anchor
        if (spanHi > holeMin && spanLo < holeMax) {
          const advance = holeMax + width  // span entirely after the hole
          const retreat = holeMin          // span entirely before the hole
          anchor = Math.abs(advance - anchor) <= Math.abs(retreat - anchor) ? advance : retreat
          moved = true
        }
      }
    }
    if (!moved) break
  }
  return anchor
}

export function generateLayerLabels(
  layers: LayerLabelInfo[],
  panelWidth: number,
  panelHeight: number,
  config: PanelConfig,
  pcbWidth: number,
  pcbHeight: number,
  pcbPositions: PanelPlacement[],
  toolingHoles?: PanelResult['toolingHoles'],
  fiducials?: PanelResult['fiducials'],
  vScoreLines?: VScoreLine[]
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

  const fontSize = config.bottomRibFontSize ?? 1.8

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

  // These hardcoded offsets were tuned against tooling/reference hole positions
  // that are placed independently in the hole-placement block above (real
  // examples: ref_br/tooling_br routinely land at ~97.5-102mm on a 110mm-wide
  // panel) and can drill straight through the label text — a real hole punched
  // through printed layer-ID text, not just a preview glitch. Unlike the
  // fiducial/rib-text fix above (which reserves a zone before placement), here
  // the real label strings and their measured widths are only known at this
  // call (computePanel has no layer list), so the anchors are nudged clear of
  // any hole on this rib using the REAL measured text width via
  // measureRegionText, same source of truth the emitter and preview both use.
  // 1.0mm used to leave the label text landing only ~1.1-1.2mm from a
  // pinning hole's edge in real exports — technically clear but tight
  // enough that a user reasonably read it as "placed near the hole".
  // Widened for a safer real-world margin against fab registration
  // tolerance.
  const holeClearanceMm = 2.5
  const bottomRibHoles = (toolingHoles ?? []).filter(h => h.y >= -0.01 && h.y <= ribHeight + 0.01)
  const maxTopWidth = topLabels.reduce((max, l) => Math.max(max, measureRegionText(l.name) * fontSize), 0)
  const maxBottomWidth = bottomLabels.reduce((max, l) => Math.max(max, measureRegionText(l.name) * fontSize), 0)

  // BOTTOM labels are mirrored and grow LEFT from `bottomFirstCharX` — i.e.
  // toward `fid_br`'s own corner — so without this they can (and on a real
  // no-side-rib panel, did) grow straight past the fiducial there. Folded in
  // as one more synthetic "hole" for the existing `clearHolesAlongAxis` pass
  // rather than a separate check, so it gets the same iterate-to-a-fixed-
  // point treatment as the real holes. `computePanel` now places fiducials
  // BEFORE calling this function specifically so `fiducials` here is the
  // REAL final position (not a guess at where it might land) — see the
  // reordering note on `computePanel`'s own fiducial block.
  const bottomRibFiducialHoles = fiducialsAsHoles(fiducials ?? [], 0, ribHeight)
  const bottomRibVScoreMarks = vScoreMarksAsHoles(vScoreLines ?? [], config, false)
  const bottomRibHolesWithFid = [...bottomRibHoles, ...bottomRibFiducialHoles, ...bottomRibVScoreMarks]

  const topAnchorX = topLabels.length > 0 ? clearHolesAlongAxis(topFirstCharX, maxTopWidth, bottomRibHolesWithFid, 'right', holeClearanceMm) : topFirstCharX
  const bottomAnchorX = bottomLabels.length > 0 ? clearHolesAlongAxis(bottomFirstCharX, maxBottomWidth, bottomRibHolesWithFid, 'left', holeClearanceMm) : bottomFirstCharX

  if (topAnchorX !== topFirstCharX) {
    console.log(`[Label Position] TOP layers anchor shifted from ${topFirstCharX.toFixed(2)}mm to ${topAnchorX.toFixed(2)}mm to clear tooling/reference holes (widest label ${maxTopWidth.toFixed(2)}mm)`)
  }
  if (bottomAnchorX !== bottomFirstCharX) {
    console.log(`[Label Position] BOTTOM layers anchor shifted from ${bottomFirstCharX.toFixed(2)}mm to ${bottomAnchorX.toFixed(2)}mm to clear tooling/reference holes (widest label ${maxBottomWidth.toFixed(2)}mm)`)
  }
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
 * Generate panel meta text — customer/PCB name, revision, date, PCB size,
 * and panel size — across the panel's ribs.
 *
 * The customer/PCB-name line is the one line that always exists and is
 * never dropped; it keeps its original anchor (3.5mm right of the top-left
 * tooling hole) so existing panels don't shift. The three new lines
 * (revision+date, PCB size, panel size) are placed tier by tier, most
 * important first, each tier only used once the previous one runs out of
 * room:
 *
 *   1. TOP rib, stacked below the name line — as many lines as
 *      `config.sideRibTop` has height for.
 *   2. BOTTOM rib, LEFT side — clear of `ref_bl`/`tooling_bl` (via the same
 *      `clearHolesAlongAxis` hole-avoidance `generateLayerLabels` uses) and
 *      of the worst-case per-layer-label zone reserved on the right
 *      (`worstCaseBottomRibLabelZone`) — as many as `config.sideRibBottom`
 *      has height for and as fit before that zone.
 *   3. LEFT/RIGHT side ribs, vertical text — only entered if the user has
 *      actually given the panel side ribs (`sideRibLeft`/`sideRibRight` both
 *      > 0), split between the two ribs, centered on the grid's own vertical
 *      span. Rotation 90° (reads bottom-to-top), matching the `InfoText`
 *      rotation convention already documented on the type.
 *
 * Anything that still doesn't fit after all three tiers is dropped with a
 * console.warn rather than silently overlapping another feature — this is
 * cosmetic panel branding, not a fabrication safety feature (contrast with
 * the routing/DFM engines, which raise a blocking error instead: those are
 * toolpaths that would scrap a board if wrong).
 *
 * @param info - Panel information containing customer reference, PCB name, revision, date
 * @param pcbWidth - Single PCB width in mm
 * @param pcbHeight - Single PCB height in mm
 * @param panelWidth - Full panel width in mm
 * @param panelHeight - Full panel height in mm
 * @param config - Panel configuration with side rib dimensions
 * @param toolingHoles - Tooling/reference hole positions, for anchor + hole-avoidance
 * @param fiducials - Already-placed fiducial positions, for hole-avoidance-style
 *   clearance so text starts clear of a fiducial at the same corner instead of
 *   claiming that space first — `computePanel` places fiducials before calling
 *   this function specifically so this is the real final position, not a guess.
 * @returns Array of InfoText items across whichever ribs had room
 */
export function generatePanelMetaText(
  info: PanelInfo,
  pcbWidth: number,
  pcbHeight: number,
  panelWidth: number,
  panelHeight: number,
  config: PanelConfig,
  toolingHoles?: PanelResult['toolingHoles'],
  fiducials?: PanelResult['fiducials'],
  vScoreLines?: VScoreLine[]
): InfoText[] {
  const texts: InfoText[] = []
  if (!info) return texts

  const topFontSize = config.topRibFontSize ?? 2.8
  const bottomFontSize = config.bottomRibFontSize ?? 1.8
  const lineHeightOf = (fontSize: number) => fontSize * 1.4
  const marginMm = 1.0
  // Matches generateLayerLabels' own widened margin — see that constant's
  // comment for why 1.0mm wasn't enough real-world clearance.
  const holeClearanceMm = 2.5
  const measureTextWidth = (text: string, fontSize: number) => measureRegionText(text) * fontSize

  // Content lines, most important first — the name line is never dropped.
  const dateText = info.date || ''
  let remaining: string[] = [
    `${info.customerRef || 'Customer Name'} : ${info.pcbName || 'PCB-001'}`,
    `Rev ${info.revision || '1.0'}${dateText ? '  ' + dateText : ''}`,
    `PCB ${pcbWidth.toFixed(1)}x${pcbHeight.toFixed(1)}mm`,
    `Panel ${panelWidth.toFixed(1)}x${panelHeight.toFixed(1)}mm`,
  ]

  const pushHorizontalPair = (
    lineText: string, anchorX: number, y: number, fontSize: number, location: 'top-rib' | 'bottom-rib'
  ) => {
    const textWidth = measureTextWidth(lineText, fontSize)
    texts.push({ x: anchorX, y, text: lineText, fontSize, align: 'left', rotation: 0, location, mirrored: false })
    texts.push({ x: anchorX + textWidth, y, text: lineText, fontSize, align: 'left', rotation: 0, location, mirrored: true })
  }

  // --- Tier 1: TOP rib, stacked from the top-left tooling hole ---
  const textOffsetFromHole = 3.5
  let firstCharX = 10.0 // fallback position
  // Reduce over the FILTERED array with its own [0] as the seed — reducing
  // over the filtered list but seeding from the unfiltered `toolingHoles[0]`
  // silently returns that seed untouched when no 'tooling'-type hole exists
  // at all (e.g. small ribs reject tooling holes as too close to the edge —
  // see `addHole`'s `minEdgeDistance` check — while the smaller reference
  // holes still fit), landing on a 'reference' hole's position instead. Found
  // via the tiny-rib regression test for the panel-meta-text tiers below.
  const toolingOnly = (toolingHoles ?? []).filter(h => h.type === 'tooling')
  if (toolingOnly.length > 0) {
    const topLeftHole = toolingOnly.reduce((topleft, hole) => {
      if (hole.y > topleft.y) return hole
      if (hole.y === topleft.y && hole.x < topleft.x) return hole
      return topleft
    }, toolingOnly[0])
    firstCharX = topLeftHole.x + textOffsetFromHole
    console.log(`[Top Rib Position] Using top left tooling hole at (${topLeftHole.x.toFixed(2)}, ${topLeftHole.y.toFixed(2)}), text position: ${firstCharX.toFixed(2)}mm`)
  } else {
    console.log(`[Top Rib Position] No tooling holes found, using fallback position: ${firstCharX.toFixed(2)}mm`)
  }

  const topRibY = panelHeight - config.sideRibTop / 2
  const topLineHeight = lineHeightOf(topFontSize)
  const topLinesFit = Math.max(1, Math.floor((config.sideRibTop - marginMm) / topLineHeight))

  const placedOnTop = remaining.splice(0, Math.min(topLinesFit, remaining.length))

  // All lines in this tier share one X anchor (stacked at different Y) — clear
  // it against every hole on the top rib (tooling AND reference; the fallback
  // `firstCharX` above has no hole awareness at all, and even the tooling-hole
  // anchor sits close enough to the top-left reference-hole pair that a wide
  // enough line can still reach them) using the widest line that will actually
  // land here, same `clearHolesAlongAxis` machinery `generateLayerLabels` uses.
  const topRibHoles = (toolingHoles ?? []).filter(h => h.y >= panelHeight - config.sideRibTop - 0.01)
  const topRibFiducialHoles = fiducialsAsHoles(fiducials ?? [], panelHeight - config.sideRibTop, panelHeight)
  const topRibVScoreMarks = vScoreMarksAsHoles(vScoreLines ?? [], config, true)
  const topRibHolesWithFid = [...topRibHoles, ...topRibFiducialHoles, ...topRibVScoreMarks]
  const maxTopMetaWidth = placedOnTop.reduce((max, l) => Math.max(max, measureTextWidth(l, topFontSize)), 0)
  const clearedFirstCharX = clearHolesAlongAxis(firstCharX, maxTopMetaWidth, topRibHolesWithFid, 'right', holeClearanceMm)
  // The name line is never dropped, so it must never be pushed off the panel
  // (a wide enough name + a cramped top-left hole cluster can otherwise walk
  // the anchor negative — clearing holes is only useful while it stays on
  // the panel). Clamp to the margin and accept the residual hole overlap in
  // that genuinely-too-tight case; this is cosmetic branding text, not a
  // fabrication safety feature.
  if (clearedFirstCharX < marginMm) {
    console.warn(`[Top Rib] Widest line (${maxTopMetaWidth.toFixed(2)}mm) doesn't fit clear of top-left holes on this panel — clamping anchor to the margin instead of pushing it off-panel`)
    firstCharX = marginMm
  } else {
    firstCharX = clearedFirstCharX
  }

  // Group-center around the rib's vertical middle, same as before — but the
  // name line is forced to place even when `config.sideRibTop` is smaller
  // than one line's height (`topLinesFit`'s `Math.max(1, ...)` floor, right
  // above), since it's never dropped. Centering on a rib that's too small
  // for it pushes the group's bottom edge past the rib's own lower boundary
  // (`panelHeight - config.sideRibTop`, where the PCB grid starts) and
  // straight onto the fabricated board's own silkscreen/copper — confirmed
  // live with a 2mm top rib at the default 2.8mm font (line height 3.92mm):
  // "Customer Name : PCB-001" rendered directly on top of the first row of
  // component silkscreen. Glyphs span ±fontSize/2 around their own anchor
  // (region-font.ts's `perpOffsetNorm = -0.5`), so shift the whole group
  // UP by whatever the bottom-most glyph edge would otherwise overshoot by.
  // This only engages when the rib is genuinely too small for the text
  // (the common case, rib comfortably bigger than the font, is a no-op) —
  // shifting outward past the panel's own top edge into blank border space
  // is the correct trade against overlapping real board content, matching
  // this text's own documented "cosmetic branding, not fabrication-safety"
  // status elsewhere in this function.
  const topGroupOffset = ((placedOnTop.length - 1) / 2) * topLineHeight
  const topGroupBottomY = topRibY - topGroupOffset - topFontSize / 2
  const topGridBoundaryY = panelHeight - config.sideRibTop
  const topRibYShift = Math.max(0, topGridBoundaryY - topGroupBottomY)

  placedOnTop.forEach((lineText, i) => {
    const lineY = topRibY + topRibYShift + topGroupOffset - i * topLineHeight
    console.log(`[Top Rib] Adding line ${i}: "${lineText}" at ${firstCharX.toFixed(2)}mm`)
    pushHorizontalPair(lineText, firstCharX, lineY, topFontSize, 'top-rib')
  })
  console.log(`[Top Rib] Generated ${placedOnTop.length * 2} texts (${placedOnTop.length} per side) in ${placedOnTop.length} lines`)

  // --- Tier 2: BOTTOM rib, LEFT side (clear of ref_bl/tooling_bl and the
  // worst-case per-layer-label zone the RIGHT side is reserved for) ---
  if (remaining.length > 0) {
    const ribHeight = config.sideRibBottom
    const bottomLineHeight = lineHeightOf(bottomFontSize)
    const bottomLinesFitByHeight = Math.max(0, Math.floor((ribHeight - marginMm) / bottomLineHeight))
    const bottomRibHoles = (toolingHoles ?? []).filter(h => h.y >= -0.01 && h.y <= ribHeight + 0.01)
    const zone = worstCaseBottomRibLabelZone(config, panelWidth, toolingHoles, vScoreLines)
    const bottomStartX = config.sideRibLeft + 2.0
    const bottomCenterY = ribHeight / 2

    // `fid_bl` sits between this text's own start anchor and where it would
    // otherwise grow toward. Folded in as one more synthetic "hole" for the
    // existing `clearHolesAlongAxis` pass (same treatment `generateLayerLabels`
    // gives `fid_br` on the opposite corner) so the text starts AFTER the
    // reference hole, tooling hole, AND the fiducial — not on top of it.
    // `computePanel` places fiducials before calling this function
    // specifically so this is the fiducial's real final position.
    const bottomRibFiducialHoles = fiducialsAsHoles(fiducials ?? [], 0, ribHeight)
    const bottomRibVScoreMarks = vScoreMarksAsHoles(vScoreLines ?? [], config, false)
    const bottomRibHolesWithFid = [...bottomRibHoles, ...bottomRibFiducialHoles, ...bottomRibVScoreMarks]

    const placedOnBottom: string[] = []
    for (const lineText of remaining) {
      if (placedOnBottom.length >= bottomLinesFitByHeight) break
      const textWidth = measureTextWidth(lineText, bottomFontSize)
      const anchorX = clearHolesAlongAxis(bottomStartX, textWidth, bottomRibHolesWithFid, 'right', holeClearanceMm)
      if (anchorX + textWidth + marginMm > zone.minX) break // would run into the per-layer-label zone
      placedOnBottom.push(lineText)
    }
    remaining = remaining.slice(placedOnBottom.length)

    placedOnBottom.forEach((lineText, i) => {
      const groupOffset = ((placedOnBottom.length - 1) / 2) * bottomLineHeight
      const lineY = bottomCenterY + groupOffset - i * bottomLineHeight
      const textWidth = measureTextWidth(lineText, bottomFontSize)
      const anchorX = clearHolesAlongAxis(bottomStartX, textWidth, bottomRibHolesWithFid, 'right', holeClearanceMm)
      console.log(`[Bottom Rib] Adding meta line: "${lineText}" at ${anchorX.toFixed(2)}mm`)
      pushHorizontalPair(lineText, anchorX, lineY, bottomFontSize, 'bottom-rib')
    })
  }

  // --- Tier 3: LEFT/RIGHT side ribs, vertical text — only if the user has
  // actually given the panel side ribs (nonzero width) ---
  if (remaining.length > 0 && config.sideRibLeft > 0 && config.sideRibRight > 0) {
    const sideFontSize = bottomFontSize
    const sideLineThickness = sideFontSize * 1.4 // horizontal thickness once rotated 90°
    const leftOk = config.sideRibLeft >= sideFontSize + marginMm
    const rightOk = config.sideRibRight >= sideFontSize + marginMm

    if (leftOk || rightOk) {
      const gridBottom = config.sideRibBottom
      const gridTop = panelHeight - config.sideRibTop
      const availableRun = gridTop - gridBottom
      const midY = (gridBottom + gridTop) / 2

      const fitting = remaining.filter(lineText => measureTextWidth(lineText, sideFontSize) + marginMm * 2 <= availableRun)
      remaining = remaining.filter(l => !fitting.includes(l))

      const leftLines: string[] = []
      const rightLines: string[] = []
      fitting.forEach((lineText, i) => {
        if (leftOk && rightOk) (i % 2 === 0 ? leftLines : rightLines).push(lineText)
        else if (leftOk) leftLines.push(lineText)
        else rightLines.push(lineText)
      })

      const placeSideGroup = (lines: string[], location: 'left-rib' | 'right-rib', centerX: number) => {
        lines.forEach((lineText, i) => {
          const textLen = measureTextWidth(lineText, sideFontSize)
          const groupOffset = ((lines.length - 1) / 2) * sideLineThickness
          const lineX = centerX + groupOffset - i * sideLineThickness
          const startY = midY - textLen / 2
          const endY = startY + textLen
          console.log(`[${location}] Adding vertical meta line: "${lineText}" at x=${lineX.toFixed(2)}mm`)
          texts.push({ x: lineX, y: startY, text: lineText, fontSize: sideFontSize, align: 'left', rotation: 90, location, mirrored: false })
          texts.push({ x: lineX, y: endY, text: lineText, fontSize: sideFontSize, align: 'left', rotation: 90, location, mirrored: true })
        })
      }
      placeSideGroup(leftLines, 'left-rib', config.sideRibLeft / 2)
      placeSideGroup(rightLines, 'right-rib', panelWidth - config.sideRibRight / 2)
    }
  }

  if (remaining.length > 0) {
    console.warn(`[Panel Meta Text] ${remaining.length} line(s) dropped — no rib had room: ${remaining.join(' | ')}`)
  }

  return texts
}

// ============================================================================
// PCB Outline Shape Detection & L-Shape Mark Generation

// ============================================================================
// PCB Outline Shape Detection & L-Shape Mark Generation
// ============================================================================

/**
 * Check if a parsed Gerber layer (outline) has sharp 90° corners at its
 * bounding-box extremes — the only thing that actually matters for placing
 * an L-shape corner mark, since the mark sits at those four points.
 *
 * Deliberately does NOT reject a file for containing arcs anywhere: a
 * rectangular board very commonly has a mounting hole or fillet drawn on the
 * Edge.Cuts/profile layer away from the corners, and a prior global
 * arc-vs-line ratio heuristic rejected those boards outright — silently
 * dropping L-shapes from copper and mask on export with no user-facing
 * warning, even though the board's actual corners were perfectly square.
 * Confirmed against a synthetic rectangle with one arc-drawn mounting hole:
 * the old heuristic returned false, this one correctly returns true.
 *
 * Coordinates are modal (an axis is omitted when unchanged from the previous
 * command), so absolute endpoints are resolved by walking the command list.
 */
export function isRectangularOutline(layer: GerberLayer): boolean {
  if (!layer.commands || layer.commands.length === 0 || !layer.bounds) return false

  const { minX, minY, maxX, maxY } = layer.bounds
  const eps = 1e-3 // mm

  let curX = 0
  let curY = 0
  const straightEndpoints: { x: number; y: number }[] = []
  const arcEndpoints: { x: number; y: number }[] = []

  for (const cmd of layer.commands) {
    const x2 = cmd.coordinate.x ?? curX
    const y2 = cmd.coordinate.y ?? curY
    if (cmd.type === 'interpolate') {
      straightEndpoints.push({ x: curX, y: curY }, { x: x2, y: y2 })
    } else if (cmd.type === 'arc_cw' || cmd.type === 'arc_ccw') {
      arcEndpoints.push({ x: curX, y: curY }, { x: x2, y: y2 })
    }
    curX = x2
    curY = y2
  }

  if (straightEndpoints.length === 0) return false

  const near = (p: { x: number; y: number }, x: number, y: number) =>
    Math.abs(p.x - x) < eps && Math.abs(p.y - y) < eps

  const corners: [number, number][] = [
    [minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY],
  ]
  for (const [cx, cy] of corners) {
    const touchedByArc = arcEndpoints.some(p => near(p, cx, cy))
    if (touchedByArc) return false
    const touchedByStraightLine = straightEndpoints.some(p => near(p, cx, cy))
    if (!touchedByStraightLine) return false
  }

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
  commands: GerberDrawCommand[],
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

  for (let i = 0; i < commands.length; i++) {
    const cmd = commands[i]

    if (cmd.coordinate.x !== undefined) posX = cmd.coordinate.x
    if (cmd.coordinate.y !== undefined) posY = cmd.coordinate.y

    // --- Region close ---
    // Must run BEFORE a polarity change: %LP is not legal inside an open
    // G36/G37 region statement. Also fires when the polarity is about to
    // change while STILL inside a region (two adjacent source G36..G37
    // blocks of different polarity collapse into one contiguous regionMode
    // run in `commands`, so this is the only place that split can be
    // detected) — closing, switching polarity, then reopening below keeps
    // both region statements legal instead of emitting %LP mid-region.
    if (inRegion && (!cmd.regionMode || cmd.polarity !== lastPolarity)) {
      lines.push('G37*')
      inRegion = false
    }

    // --- Polarity changes ---
    if (cmd.polarity !== lastPolarity) {
      lines.push(cmd.polarity === 'clear' ? '%LPC*%' : '%LPD*%')
      lastPolarity = cmd.polarity
    }

    // --- Region open ---
    if (cmd.regionMode && !inRegion) {
      lines.push('G36*')
      inRegion = true
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

  // Restore dark polarity before returning. Without this, a copy whose last
  // drawing command was clear-polarity (a thermal relief / pour cutout /
  // anti-pad — extremely common on real copper layers) leaves the emitted
  // FILE in %LPC*% while this function's own `lastPolarity` is about to be
  // thrown away and reinitialized to 'dark' on the NEXT call — so the next
  // panel copy's first dark command sees `cmd.polarity === lastPolarity`
  // and wrongly skips re-emitting %LPD*%. Every subsequent copy is then
  // drawn in ERASE mode and renders invisible — confirmed live on a real
  // customer panel: 3 evenly-spaced, fully-populated copper copies in the
  // data, but only the first one visible in a neutral third-party Gerber
  // viewer, because copies 2 and 3 were silently clearing instead of
  // drawing. The same gap left every panel overlay appended AFTER the
  // placement loop (L-shapes, V-score marks, donuts, fiducials, rib text)
  // in whatever polarity the LAST copy happened to end on. Must come AFTER
  // the G37* close directly above — %LP is not legal inside an open region
  // statement. Byte-identical for the overwhelmingly common case (any layer
  // whose last drawing command is already dark — every mask/silk/paste and
  // most copper).
  if (lastPolarity !== 'dark') {
    lines.push('%LPD*%')
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
  layerSide?: 'top' | 'bottom' | 'none',
  /** Restrict body + PCB-corner-L-shape emission to a subset of the panel's
   *  placements — used by `generateMergedPanelizedGerber`'s single-contributor
   *  delegate so a design's own layer is only stamped at ITS OWN placements,
   *  not every design's. Defaults to `panel.placements` (all of them), which
   *  is every existing call site's behavior — this parameter is purely
   *  additive. */
  placementsOverride?: PanelPlacement[]
): string {
  const fmt: OutputFormat = outputFormat || DEFAULT_OUTPUT_FORMAT
  const lines: string[] = []
  const placements = placementsOverride ?? panel.placements

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
  const vScoreApertureCode = baseCode + 5

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

  for (const pos of placements) {
    const dx = pos.x + baseOffsetX
    const dy = pos.y + baseOffsetY

    // Pass previous interpolation mode so state is continuous across copies
    lastInterp = generateBodyFromCommands(parsedLayer.commands, dx, dy, fmt, lines, lastInterp)
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
    // Generate L-shape commands relative to PCB origin (0,0). All placements
    // share one size in single-design grid mode, so the first is representative.
    const lShapeBase = generateLShapeGerberCommands(placements[0]?.w ?? 0, placements[0]?.h ?? 0, config, fmt, lShapeCornerCode)

    // For each panel position, offset the L-shape coordinates
    if (lShapeBase.length > 0) {
      // Define the aperture once, not per position — duplicate %ADD blocks
      // trip warnings in CAM tools.
      lines.push(`%ADD${lShapeCornerCode}C,${config.lShapeLineWidth.toFixed(6)}*%`)

      for (const pos of placements) {
        // pos.x/pos.y are already panel-absolute (from computePanel), same as
        // panel.toolingHoles/fiducials/infoTexts below — do NOT add
        // baseOffsetX/baseOffsetY here, that's only for converting the body
        // content's *native* file coordinates into panel space. Adding it a
        // second time on top of already-local arm/w/h shifted every mark by
        // the outline's native origin (e.g. -53mm/+170mm on a real board),
        // landing them nowhere near the actual PCB corners.
        const offX = pos.x
        const offY = pos.y

        // Re-generate L-shapes with position offset
        const arm = config.lShapeArmLength
        const w = pos.w
        const h = pos.h

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

  // ---- 6.7. V-score alignment marks on panel ribs (copper & mask only) ----
  // Coordinates are already panel-absolute — do NOT add baseOffsetX/baseOffsetY
  // (same trap documented at the panel-border L-shape block above).
  if (config.enableVScoreMarks && layerType && layerNeedsLShapeMarks(layerType) && panel.vScoreLines.length > 0) {
    const strokes = computeVScoreMarkStrokes(panel.vScoreLines, panel.panelWidth, panel.panelHeight, config)
    if (strokes.length > 0) {
      lines.push(`%ADD${vScoreApertureCode}C,${config.vScoreMarkLineWidth.toFixed(6)}*%`)
      const f = (v: number) => formatCoordinate(v, fmt)
      lines.push(`G54D${vScoreApertureCode}*`)
      for (const stroke of strokes) {
        stroke.forEach((pt, i) => {
          lines.push(`X${f(pt.x)}Y${f(pt.y)}D${i === 0 ? '02' : '01'}*`)
        })
      }
    }
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

/**
 * One design's contribution to a single merged output file (one per
 * `(layerType, layerSide)` key — see `generateMergedPanelizedGerber`).
 */
export interface GerberExportContributor {
  parsedLayer: GerberLayer
  rawContent: string
  /** This design's own datum (from `resolveDesignGeometry`), NOT the whole
   *  panel's — every design has its own native-coordinate origin. */
  baseOffset: BaseOffset
  /** Only this design's own placements — never the full `panel.placements`. */
  placements: PanelPlacement[]
  /** This design's own L-shape-mark eligibility (its own outline-rectangular
   *  check) folded into an otherwise-shared `PanelConfig`. */
  effectiveConfig: PanelConfig
}

/**
 * Merge N designs' contributions to ONE output file (one Gerber layer, e.g.
 * "Top_Copper", shared by every design in the panel that has a matching
 * layer) with a D-code / `%AM` macro-name remap so the merged file has no
 * collisions.
 *
 * ⚠ Byte-identity for the single-design case is STRUCTURAL, not incidental:
 * with exactly one contributor this delegates straight to the unmodified
 * `generatePanelizedGerber` (contributor 0 is never remapped in the merge
 * path either, so the two paths would agree even if this delegate didn't
 * exist — but delegating means the single-contributor case can never drift
 * from that function's own behavior as it evolves).
 *
 * Contributors are expected in the caller's chosen order (this codebase uses
 * `panel.designs` order, i.e. store design order) — contributor 0's D-codes
 * and macro names are NEVER touched; contributors 1..N are remapped in
 * ascending old-code order, continuing the same code cursor across
 * contributors so no two contributors' codes can collide.
 */
export function generateMergedPanelizedGerber(
  contributors: GerberExportContributor[],
  panel: PanelResult,
  panelConfig: PanelConfig,
  outputFormat?: OutputFormat,
  layerType?: string,
  layerSide?: 'top' | 'bottom' | 'none'
): string {
  if (contributors.length === 0) return ''

  if (contributors.length === 1) {
    const c = contributors[0]
    return generatePanelizedGerber(
      c.parsedLayer, c.rawContent, panel, c.effectiveConfig, outputFormat,
      c.baseOffset, layerType, layerSide, c.placements
    )
  }

  const fmt: OutputFormat = outputFormat || DEFAULT_OUTPUT_FORMAT
  const lines: string[] = []

  // ---- 0. Merge macros + apertures, remapping D-codes/macro names for every
  // contributor after the first ----
  const macroLines: string[] = []
  const usedMacroNames = new Set<string>()
  const addLines: string[] = []

  interface RemappedContributor {
    commands: GerberDrawCommand[]
    baseOffset: BaseOffset
    placements: PanelPlacement[]
    effectiveConfig: PanelConfig
    hasBounds: boolean
  }
  const remapped: RemappedContributor[] = []

  // Contributor 0's own max D-code seeds the shared cursor — identical to
  // generatePanelizedGerber's own single-file allocation.
  let nextCode = 10
  {
    const c0 = contributors[0]
    let maxD0 = findMaxDCode(c0.rawContent)
    for (const code of c0.parsedLayer.apertures.keys()) {
      if (code > maxD0) maxD0 = code
    }
    nextCode = maxD0 + 1
  }

  contributors.forEach((c, k) => {
    if (k === 0) {
      // Identity — verbatim macros, apertures, commands.
      for (const macro of extractMacroDefinitions(c.rawContent)) {
        const nameMatch = macro.match(/^%AM([A-Za-z0-9_-]+)\*/)
        if (nameMatch) usedMacroNames.add(nameMatch[1])
        macroLines.push(macro)
      }
      addLines.push(...generateApertureDefinitions(c.parsedLayer.apertures))
      remapped.push({
        commands: c.parsedLayer.commands,
        baseOffset: c.baseOffset,
        placements: c.placements,
        effectiveConfig: c.effectiveConfig,
        hasBounds: !!c.parsedLayer.bounds,
      })
      return
    }

    // ---- Macro name remap: rename ONLY on collision, never try to prove two
    // identically-named bodies are equivalent (see this function's own docs
    // + CLAUDE.md's D-code/macro remap section). ----
    const macroNameMap = new Map<string, string>()
    for (const macro of extractMacroDefinitions(c.rawContent)) {
      const nameMatch = macro.match(/^%AM([A-Za-z0-9_-]+)\*/)
      if (!nameMatch) continue
      const origName = nameMatch[1]
      const finalName = usedMacroNames.has(origName) ? `${origName}_${k}` : origName
      macroNameMap.set(origName, finalName)
      usedMacroNames.add(finalName)
      macroLines.push(finalName === origName ? macro : macro.replace(/^%AM[A-Za-z0-9_-]+\*/, `%AM${finalName}*`))
    }

    // ---- D-code remap: ascending old-code order, continuing the shared
    // cursor from every previously-processed contributor. ----
    const oldCodes = Array.from(c.parsedLayer.apertures.keys()).sort((a, b) => a - b)
    const codeMap = new Map<number, number>()
    for (const oldCode of oldCodes) {
      codeMap.set(oldCode, nextCode)
      nextCode++
    }

    const remappedApertures = new Map<number, GerberAperture>()
    for (const [oldCode, ap] of c.parsedLayer.apertures.entries()) {
      const newCode = codeMap.get(oldCode)!
      const ap2: GerberAperture = { ...ap, code: newCode }
      if (ap2.shape === 'macro' && ap2.macroName) {
        ap2.macroName = macroNameMap.get(ap2.macroName) ?? ap2.macroName
      }
      remappedApertures.set(newCode, ap2)
    }
    addLines.push(...generateApertureDefinitions(remappedApertures))

    const remappedCommands: GerberDrawCommand[] = c.parsedLayer.commands.map(cmd => {
      if (cmd.apertureCode === null) return cmd
      const newCode = codeMap.get(cmd.apertureCode)
      return newCode === undefined ? cmd : { ...cmd, apertureCode: newCode }
    })

    remapped.push({
      commands: remappedCommands,
      baseOffset: c.baseOffset,
      placements: c.placements,
      effectiveConfig: c.effectiveConfig,
      hasBounds: !!c.parsedLayer.bounds,
    })
  })

  // Overlay codes go above every contributor's codes, same "next century"
  // convention as the single-design function.
  const baseCode = Math.max(301, Math.ceil(nextCode / 100) * 100 + 1)
  const lShapeCornerCode = baseCode
  const lShapeBorderCode = baseCode + 1
  const strokeFontApertureCode = baseCode + 2
  const donutApertureCode = baseCode + 3
  const fiducialApertureCode = baseCode + 4
  const vScoreApertureCode = baseCode + 5

  // ---- 1. Format header ----
  lines.push(generateFSCommand(fmt))
  lines.push(generateMOCommand(fmt))
  lines.push('%LPD*%')

  // ---- 2. Merged macro definitions ----
  lines.push(...macroLines)

  // ---- 3. Merged aperture definitions ----
  lines.push(...addLines)

  // ---- 4. G-code initialization ----
  lines.push(generateGUnitCode(fmt))
  lines.push('G01*')

  // ---- 5. Body — each contributor's own placements only, one continuous
  // interpolation-mode stream across all contributors (same convention as
  // the single-design function's continuity across placements). A
  // contributor with no bounds contributes no geometry but doesn't abort the
  // whole file — other designs may still have usable geometry. ----
  let lastInterp: 'linear' | 'cw' | 'ccw' = 'linear'
  for (const rc of remapped) {
    if (!rc.hasBounds) continue
    for (const pos of rc.placements) {
      const dx = pos.x + rc.baseOffset.x
      const dy = pos.y + rc.baseOffset.y
      lastInterp = generateBodyFromCommands(rc.commands, dx, dy, fmt, lines, lastInterp)
    }
  }
  if (lastInterp !== 'linear') {
    lines.push('G74*')
    lines.push('G01*')
    lastInterp = 'linear'
  }

  // ---- 6. L-shape marks at PCB corners — per contributor, using THAT
  // design's own w/h and its own outline-rectangular eligibility
  // (`effectiveConfig.enableLShapeMarks`), so a rectangular design sharing a
  // file with a shaped one doesn't lose its marks. One shared aperture code
  // (the line width is panel-wide, not per-design). ----
  if (layerType && layerNeedsLShapeMarks(layerType)) {
    const eligible = remapped.filter(rc => rc.hasBounds && rc.effectiveConfig.enableLShapeMarks && rc.placements.length > 0)
    if (eligible.length > 0) {
      lines.push(`%ADD${lShapeCornerCode}C,${panelConfig.lShapeLineWidth.toFixed(6)}*%`)
      lines.push(`G54D${lShapeCornerCode}*`)
      const arm = panelConfig.lShapeArmLength
      for (const rc of eligible) {
        for (const pos of rc.placements) {
          const maxArm = Math.min(pos.w / 2, pos.h / 2)
          if (arm <= 0 || arm > maxArm) continue
          const f = (v: number) => formatCoordinate(v + pos.x, fmt)
          const fy = (v: number) => formatCoordinate(v + pos.y, fmt)
          const w = pos.w
          const h = pos.h
          lines.push(`X${f(arm)}Y${fy(0)}D02*`)
          lines.push(`X${f(0)}Y${fy(0)}D01*`)
          lines.push(`X${f(0)}Y${fy(arm)}D01*`)
          lines.push(`X${f(w - arm)}Y${fy(0)}D02*`)
          lines.push(`X${f(w)}Y${fy(0)}D01*`)
          lines.push(`X${f(w)}Y${fy(arm)}D01*`)
          lines.push(`X${f(w)}Y${fy(h - arm)}D02*`)
          lines.push(`X${f(w)}Y${fy(h)}D01*`)
          lines.push(`X${f(w - arm)}Y${fy(h)}D01*`)
          lines.push(`X${f(arm)}Y${fy(h)}D02*`)
          lines.push(`X${f(0)}Y${fy(h)}D01*`)
          lines.push(`X${f(0)}Y${fy(h - arm)}D01*`)
        }
      }
    }
  }

  // ---- 6.5. L-shape marks on panel border — panel-wide, not per-design. ----
  if (panelConfig.enablePanelBorderLShape && layerType && layerNeedsLShapeMarks(layerType)) {
    lines.push(...generatePanelBorderLShapeGerberCommands(panel.panelWidth, panel.panelHeight, panelConfig, fmt, lShapeBorderCode))
  }

  // ---- 6.7. V-score alignment marks on panel ribs — panel-wide, reads
  // panelConfig (not a contributor's effectiveConfig), same as 6.5 above.
  if (panelConfig.enableVScoreMarks && layerType && layerNeedsLShapeMarks(layerType) && panel.vScoreLines.length > 0) {
    const strokes = computeVScoreMarkStrokes(panel.vScoreLines, panel.panelWidth, panel.panelHeight, panelConfig)
    if (strokes.length > 0) {
      lines.push(`%ADD${vScoreApertureCode}C,${panelConfig.vScoreMarkLineWidth.toFixed(6)}*%`)
      const f = (v: number) => formatCoordinate(v, fmt)
      lines.push(`G54D${vScoreApertureCode}*`)
      for (const stroke of strokes) {
        stroke.forEach((pt, i) => {
          lines.push(`X${f(pt.x)}Y${f(pt.y)}D${i === 0 ? '02' : '01'}*`)
        })
      }
    }
  }

  // ---- 7. Donut rings around reference holes — panel-wide. ----
  if (panelConfig.enableToolingHoles && layerType && layerNeedsDonutShapes(layerType)) {
    const refHoles = panel.toolingHoles.filter(h => h.type === 'reference')
    if (refHoles.length > 0) {
      const od = panelConfig.donutOuterDiameter || 2.25
      const id = panelConfig.donutInnerDiameter || 1.25
      lines.push(`%ADD${donutApertureCode}C,${od.toFixed(5)}X${id.toFixed(5)}*%`)
      const f = (v: number) => formatCoordinate(v, fmt)
      lines.push(`G54D${donutApertureCode}*`)
      for (const hole of refHoles) {
        lines.push(`X${f(hole.x)}Y${f(hole.y)}D03*`)
      }
    }
  }

  // ---- 7.5. Fiducials — panel-wide. ----
  if (panelConfig.enableFiducials && layerType && (layerType === 'copper' || layerType === 'mask') && panel.fiducials.length > 0) {
    const isTop = layerSide === 'top'
    const isBottom = layerSide === 'bottom'
    const enabledForSide = (isTop && panelConfig.fiducialsTop !== false) || (isBottom && panelConfig.fiducialsBottom !== false)
    if (enabledForSide) {
      const diameter = layerType === 'copper' ? panelConfig.fiducialDiameter : panelConfig.fiducialClearance
      lines.push(`%ADD${fiducialApertureCode}C,${diameter.toFixed(6)}*%`)
      const f = (v: number) => formatCoordinate(v, fmt)
      lines.push(`G54D${fiducialApertureCode}*`)
      for (const fid of panel.fiducials) {
        lines.push(`X${f(fid.x)}Y${f(fid.y)}D03*`)
      }
    }
  }

  // ---- 8. Text on panel ribs — panel-wide. ----
  const isRegionFont = panelConfig.textFont === 'region'
  const layerNeedsFont = isRegionFont ? layerNeedsRegionText(layerType || 'none') : layerNeedsTextShapes(layerType || 'none')
  if (layerType && layerNeedsFont && panel.infoTexts.length > 0) {
    const currentLayerSide = layerSide || 'none'
    const filteredText = panel.infoTexts.filter(t => {
      if (layerType === 'paste') return false
      if (!t.targetLayerType) {
        if (currentLayerSide === 'top' && t.mirrored) return false
        if (currentLayerSide === 'bottom' && !t.mirrored) return false
        return true
      }
      return t.targetLayerType === layerType && t.targetLayerSide === currentLayerSide
    })
    if (filteredText.length > 0) {
      const textCmds = isRegionFont
        ? generateRegionTextGerberCommands(filteredText, fmt)
        : generateStrokeFontGerberCommands(filteredText, fmt, strokeFontApertureCode)
      lines.push(...textCmds)
    }
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
