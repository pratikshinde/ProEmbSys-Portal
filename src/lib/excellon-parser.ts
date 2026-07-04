/**
 * Excellon Drill File Parser (RS-274 / EIA-274)
 *
 * Parses Excellon drill files (.drl, .txt, .xln, .drl) which are the standard
 * format for PCB drill data in the manufacturing industry. The format is
 * completely different from Gerber RS-274X.
 *
 * Key differences from Gerber:
 * - Uses T-codes for tool selection instead of D-codes
 * - Header block delimited by M48...M95
 * - Tool definitions: T<nn>C<diameter> (circular) or T<nn>S<width>X<length> (slot)
 * - Coordinates: X<val>Y<val> (drill) without D-code
 * - Supports repeat (R) and multiple drills per line
 *
 * Reference: Excellon Data Format Specification
 */

import {
  GerberLayer,
  GerberAperture,
  GerberUnit,
  GerberBounds,
  GerberDrawCommand,
} from './gerber-parser'

// ============================================================================
// Type Definitions
// ============================================================================

/** Excellon tool shape type */
export type ExcellonToolShape = 'circle' | 'slot' | 'special'

/** Parsed Excellon tool definition */
export interface ExcellonTool {
  /** Tool number */
  number: number
  /** Shape type */
  shape: ExcellonToolShape
  /** Diameter for circle tools, width for slot tools */
  diameter: number
  /** Length for slot tools (0 for circles) */
  length: number
  /** Feed rate (optional) */
  feedRate?: number
  /** Plunge rate (optional) */
  plungeRate?: number
  /** Retract rate (optional) */
  retractRate?: number
  /** Spindle speed (optional) */
  spindleSpeed?: number
}

/** Parsed Excellon drill hit */
export interface DrillHit {
  /** X coordinate (mm) */
  x: number
  /** Y coordinate (mm) */
  y: number
  /** Tool number used */
  toolNumber: number
}

/** Complete parsed Excellon file */
export interface ExcellonFile {
  /** Source file name */
  fileName: string
  /** Raw file content */
  rawContent: string
  /** Unit system */
  units: GerberUnit
  /** Coordinate format: integer digits before decimal */
  formatInteger: number
  /** Coordinate format: decimal digits after decimal */
  formatDecimal: number
  /** Zero suppression mode */
  zeroSuppression: 'leading' | 'trailing'
  /** All defined tools */
  tools: Map<number, ExcellonTool>
  /** All drill hits */
  hits: DrillHit[]
  /** Calculated bounding box */
  bounds: GerberBounds | null
  /** Warnings */
  warnings: string[]
}

// ============================================================================
// Parser State
// ============================================================================

class ExcellonParserState {
  units: GerberUnit = 'inches'
  formatInteger = 2
  formatDecimal = 4
  zeroSuppression: 'leading' | 'trailing' = 'leading'
  tools = new Map<number, ExcellonTool>()
  hits: DrillHit[] = []
  warnings: string[] = []

  currentTool: number | null = null
  currentX: number | null = null
  currentY: number | null = null
  absoluteMode = true // G90=absolute, G91=incremental

  private get totalDigits(): number {
    return this.formatInteger + this.formatDecimal
  }

  /**
   * Parse a coordinate value according to the current format.
   */
  parseCoordinateValue(raw: string | undefined, axis?: 'x' | 'y'): number | undefined {
    if (raw === undefined || raw === '') return undefined

    let negative = false
    let digits = raw
    if (digits.startsWith('-')) {
      negative = true
      digits = digits.substring(1)
    }
    if (digits.startsWith('+')) {
      digits = digits.substring(1)
    }
    // Remove any embedded decimal point
    digits = digits.replace('.', '')

    const totalDigits = this.totalDigits
    const intDigits = this.formatInteger

    let padded: string
    if (this.zeroSuppression === 'leading') {
      padded = digits.padStart(totalDigits, '0')
    } else {
      padded = digits.padEnd(totalDigits, '0')
    }

    // Handle overflow
    if (padded.length > totalDigits) {
      padded = padded.substring(padded.length - totalDigits)
    }

    const intPart = padded.substring(0, intDigits) || '0'
    const decPart = padded.substring(intDigits) || '0'
    const value = parseFloat(`${negative ? '-' : ''}${intPart}.${decPart}`)

    return isNaN(value) ? undefined : value
  }
}

// ============================================================================
// Tool Definition Parser
// ============================================================================

/**
 * Parse an Excellon tool definition line.
 * Formats:
 *   T01C0.020          — Circular tool, 0.020" diameter
 *   T01C0.5            — Circular tool, 0.5mm (if metric)
 *   T01F200S800        — Feed=200, Speed=800
 *   T01C0.8F300        — Diameter=0.8mm, Feed=300
 *   T01S0.020X0.100    — Slot tool, 0.020" x 0.100"
 *   T01B0.020          — B = diameter (alias for C)
 *   T01C0.02000X0.05000 — Circular with extra params (slot)
 */
function parseToolDefinition(line: string, state: ExcellonParserState): void {
  // Remove T prefix and extract tool number
  const match = line.match(/^T(\d+)/i)
  if (!match) return

  const toolNum = parseInt(match[1], 10)
  let rest = line.substring(match[0].length).trim().toUpperCase()

  // Check for special tool (T00 = tool change, T-1 = comment, etc.)
  if (toolNum === 0) {
    // T00 = tool change / end of header
    return
  }

  const tool: ExcellonTool = {
    number: toolNum,
    shape: 'circle',
    diameter: 0,
    length: 0,
  }

  // Parse parameters: C<size>, S<width>X<length>, F<rate>, etc.
  // The C and S can appear in different orders

  // Extract diameter: C or B parameter
  const cMatch = rest.match(/[CB]\s*([\d.]+)/)
  if (cMatch) {
    tool.diameter = parseFloat(cMatch[1])
  }

  // Check if it's a slot (has X after S or C)
  // Format: C<size>X<length> means slot with width=size, length=length
  // Format: S<width>X<length> means slot
  const sMatch = rest.match(/S\s*([\d.]+)/)
  if (sMatch) {
    tool.shape = 'slot'
    tool.diameter = parseFloat(sMatch[1])
    const xMatch = rest.match(/X\s*([\d.]+)/)
    if (xMatch) {
      tool.length = parseFloat(xMatch[1])
    }
  } else {
    // Check for C<size>X<length> format (slot via C with X)
    const cxMatch = rest.match(/[CB]\s*([\d.]+)\s*X\s*([\d.]+)/)
    if (cxMatch) {
      tool.diameter = parseFloat(cxMatch[1])
      tool.length = parseFloat(cxMatch[2])
      if (tool.length > 0) {
        tool.shape = 'slot'
      }
    }
  }

  // Extract feed rate: F<rate>
  const fMatch = rest.match(/F\s*([\d.]+)/)
  if (fMatch) {
    tool.feedRate = parseFloat(fMatch[1])
  }

  // Extract spindle speed: S<rpm> (but S can conflict with slot definition)
  // Only treat as spindle speed if there's no X after it and no C before it
  if (!sMatch) {
    const rpmMatch = rest.match(/S\s*([\d.]+)/)
    if (rpmMatch && tool.diameter === 0) {
      tool.spindleSpeed = parseFloat(rpmMatch[1])
    }
  }

  // Extract plunge rate
  const zMatch = rest.match(/Z\s*([\d.]+)/)
  if (zMatch) {
    tool.plungeRate = parseFloat(zMatch[1])
  }

  state.tools.set(toolNum, tool)
}

// ============================================================================
// Coordinate Extraction
// ============================================================================

/**
 * Extract X, Y coordinates and optional repeat count from a drill line.
 * Formats:
 *   X012345Y067890
 *   X012345Y067890
 *   X012345Y067890X012345Y067890  (multiple hits on one line)
 *   X012345Y067890R05  (with repeat)
 */
function extractDrillCoords(line: string): { x?: string; y?: string; remaining?: string; repeat?: number } {
  const result: { x?: string; y?: string; remaining?: string; repeat?: number } = {}

  // Extract repeat count (R parameter)
  const rMatch = line.match(/R\s*(\d+)/i)
  if (rMatch) {
    result.repeat = parseInt(rMatch[1], 10)
  }

  // Extract first X and Y
  const xMatch = line.match(/X([+-]?\d*\.?\d*)/i)
  const yMatch = line.match(/Y([+-]?\d*\.?\d*)/i)

  if (xMatch) result.x = xMatch[1]
  if (yMatch) result.y = yMatch[1]

  // Check for remaining coordinates after first hit
  const firstMatch = line.match(/[XY][+-]?\d*\.?\d*/i)
  if (firstMatch) {
    const afterFirst = line.substring(firstMatch.index! + firstMatch[0].length)
    // Check if there are more X/Y pairs
    const secondX = afterFirst.match(/X([+-]?\d*\.?\d*)/i)
    const secondY = afterFirst.match(/Y([+-]?\d*\.?\d*)/i)
    if (secondX || secondY) {
      result.remaining = afterFirst.trim()
    }
  }

  return result
}

// ============================================================================
// Main Parser
// ============================================================================

/**
 * Parse a complete Excellon drill file.
 *
 * @param content - Raw file content
 * @param fileName - Source file name
 * @returns Parsed ExcellonFile with tools, hits, and bounds
 */
export function parseExcellon(content: string, fileName: string): ExcellonFile {
  const state = new ExcellonParserState()

  // Normalize line endings
  const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const lines = normalized.split('\n')

  let inHeader = false
  let headerFinished = false

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx].trim()
    const upper = line.toUpperCase()

    // Skip empty lines and comments
    if (line === '' || line.startsWith(';') || line.startsWith('(')) continue

    // ---- Program start/end ----
    if (upper.includes('M48')) {
      inHeader = true
      continue
    }
    if (upper.includes('M95') || upper.includes('%')) {
      inHeader = false
      headerFinished = true
      continue
    }
    if (upper.includes('M30') || upper.includes('M02') || upper.includes('M2')) {
      break
    }

    // ---- Header commands ----
    if (inHeader) {
      // Units
      if (upper.includes('METRIC') || upper.includes('M71') || upper.includes('MM')) {
        state.units = 'mm'
      } else if (upper.includes('INCH') || upper.includes('M72') || upper === 'IMPERIAL') {
        state.units = 'inches'
      }

      // Format specification
      // FORMAT={int}.{decimal} or FORMAT={int}{decimal}
      const formatMatch = upper.match(/FORMAT[=/\s]*(\d)[\s,.](\d)/)
      if (formatMatch) {
        state.formatInteger = parseInt(formatMatch[1], 10)
        state.formatDecimal = parseInt(formatMatch[2], 10)
      }

      // ICI format: ICI,LZ (leading zero) or ICI,TZ (trailing zero)
      if (upper.includes('ICI')) {
        if (upper.includes('LZ') || upper.includes('LEADING')) {
          state.zeroSuppression = 'leading'
        } else if (upper.includes('TZ') || upper.includes('TRAILING')) {
          state.zeroSuppression = 'trailing'
        }
      }

      // VER (version) - informational, skip
      // TCH (tool change method) - informational, skip
      // DETECT, BREAK - informational, skip

      // Tool definitions in header
      if (upper.match(/^T\d+/i)) {
        parseToolDefinition(line, state)
      }

      continue
    }

    // ---- Body commands (after header) ----

    // Format commands that can appear in body too
    const bodyFormatMatch = upper.match(/FORMAT[=/\s]*(\d)[\s,.](\d)/)
    if (bodyFormatMatch) {
      state.formatInteger = parseInt(bodyFormatMatch[1], 10)
      state.formatDecimal = parseInt(bodyFormatMatch[2], 10)
    }

    // Units in body
    if (upper.includes('METRIC') || upper.includes('M71')) {
      state.units = 'mm'
    } else if (upper.includes('INCH') || upper.includes('M72')) {
      state.units = 'inches'
    }

    // G-codes
    if (upper.includes('G90')) {
      state.absoluteMode = true
      continue
    }
    if (upper.includes('G91')) {
      state.absoluteMode = false
      continue
    }
    // G00 = rapid move (no drill)
    // G01 = linear move with drill
    // G05 = drill mode
    // G81-G89 = canned cycles
    // G93 = inverse time feed rate mode
    // These are all drill modes — we just continue drilling

    // Tool definitions that can appear outside header
    if (upper.match(/^T\d+[CBSFXZ]/i)) {
      parseToolDefinition(line, state)
      continue
    }

    // Tool selection: T<nn>
    const toolSelectMatch = upper.match(/^T(\d+)\s*$/)
    if (toolSelectMatch) {
      state.currentTool = parseInt(toolSelectMatch[1], 10)
      continue
    }
    // Also handle T<nn> followed by coordinates on same line
    const toolSelectWithCoords = upper.match(/^T(\d+)/)
    if (toolSelectWithCoords && !upper.match(/^T\d+[CBS]/i)) {
      const tn = parseInt(toolSelectWithCoords[1], 10)
      if (tn !== 0) {
        state.currentTool = tn
      }
    }

    // Coordinate data: X<val>Y<val>
    if (upper.includes('X') || upper.includes('Y')) {
      processDrillLine(line, state)
    }
  }

  // Calculate bounds
  const bounds = calculateDrillBounds(state.hits, state.tools)

  return {
    fileName,
    rawContent: content,
    units: state.units,
    formatInteger: state.formatInteger,
    formatDecimal: state.formatDecimal,
    zeroSuppression: state.zeroSuppression,
    tools: state.tools,
    hits: state.hits,
    bounds,
    warnings: state.warnings,
  }
}

/**
 * Process a drill line containing X/Y coordinates.
 */
function processDrillLine(line: string, state: ExcellonParserState): void {
  // Extract all X/Y coordinate pairs from the line
  // Multiple hits can be on one line: X100Y200X300Y400

  const xValues: string[] = []
  const yValues: string[] = []

  const regex = /([XY])([+-]?\d*\.?\d*)/gi
  let match: RegExpExecArray | null

  while ((match = regex.exec(line)) !== null) {
    const letter = match[1].toUpperCase()
    const value = match[2]
    if (letter === 'X') {
      xValues.push(value)
    } else {
      yValues.push(value)
    }
  }

  // Extract repeat count
  const rMatch = line.match(/R\s*(\d+)/i)
  const repeat = rMatch ? parseInt(rMatch[1], 10) : 1

  if (state.currentTool === null) {
    // Some files have coordinates before tool selection
    // Use T01 as default
    state.currentTool = 1
    state.warnings.push('No tool selected before drill command, defaulting to T01')
  }

  if (xValues.length === 0 && yValues.length === 0) return

  // If we have one X and one Y, it's a single drill
  // If we have multiple, pair them up
  const maxCoords = Math.max(xValues.length, yValues.length)

  for (let ci = 0; ci < maxCoords; ci++) {
    const rawX = ci < xValues.length ? xValues[ci] : undefined
    const rawY = ci < yValues.length ? yValues[ci] : undefined

    const newX = state.parseCoordinateValue(rawX, 'x')
    const newY = state.parseCoordinateValue(rawY, 'y')

    if (state.absoluteMode) {
      // Absolute: new value becomes current position
      if (newX !== undefined) state.currentX = newX
      if (newY !== undefined) state.currentY = newY
    } else {
      // Incremental: add to current position
      if (newX !== undefined) state.currentX = (state.currentX || 0) + newX
      if (newY !== undefined) state.currentY = (state.currentY || 0) + newY
    }

    if (state.currentX !== null && state.currentY !== null) {
      // Apply repeat
      for (let r = 0; r < repeat; r++) {
        state.hits.push({
          x: state.currentX,
          y: state.currentY,
          toolNumber: state.currentTool!,
        })
      }
    }
  }
}

/**
 * Calculate bounding box from drill hits and tool sizes.
 */
function calculateDrillBounds(
  hits: DrillHit[],
  tools: Map<number, ExcellonTool>
): GerberBounds | null {
  if (hits.length === 0) return null

  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity

  for (const hit of hits) {
    const tool = tools.get(hit.toolNumber)
    const radius = tool ? tool.diameter / 2 : 0

    minX = Math.min(minX, hit.x - radius)
    maxX = Math.max(maxX, hit.x + radius)
    minY = Math.min(minY, hit.y - radius)
    maxY = Math.max(maxY, hit.y + radius)

    // For slots, account for length
    if (tool && tool.shape === 'slot' && tool.length > 0) {
      const halfLen = tool.length / 2
      minX = Math.min(minX, hit.x - halfLen)
      maxX = Math.max(maxX, hit.x + halfLen)
    }
  }

  return { minX, minY, maxX, maxY }
}

// ============================================================================
// Conversion to GerberLayer (for rendering compatibility)
// ============================================================================

/**
 * Convert a parsed ExcellonFile into a GerberLayer format so it can be
 * rendered by the existing GerberRenderer.
 *
 * Drill hits become flash commands with circular or rectangular apertures.
 */
export function excellonToGerberLayer(excellon: ExcellonFile): GerberLayer {
  const apertures = new Map<number, GerberAperture>()
  const commands: GerberDrawCommand[] = []

  // Convert tools to Gerber apertures
  for (const [toolNum, tool] of excellon.tools) {
    const ap: GerberAperture = {
      code: toolNum,
      shape: tool.shape === 'slot' ? 'rectangle' : 'circle',
      width: tool.diameter,
    }

    if (tool.shape === 'slot' && tool.length > 0) {
      ap.height = tool.length
    }

    apertures.set(toolNum, ap)
  }

  // Convert drill hits to flash commands
  for (const hit of excellon.hits) {
    commands.push({
      type: 'flash',
      coordinate: { x: hit.x, y: hit.y },
      apertureCode: hit.toolNumber,
      regionMode: false,
      polarity: 'dark',
    })
  }

  // Build result
  const layer: GerberLayer = {
    fileName: excellon.fileName,
    rawContent: excellon.rawContent,
    units: excellon.units,
    formatX: { integer: excellon.formatInteger, decimal: excellon.formatDecimal },
    formatY: { integer: excellon.formatInteger, decimal: excellon.formatDecimal },
    apertures,
    commands,
    regions: [],
    bounds: excellon.bounds,
    warnings: [
      ...excellon.warnings,
      `Excellon drill file: ${excellon.tools.size} tools, ${excellon.hits.length} hits`,
    ],
  }

  return layer
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Check if a file is likely an Excellon drill file based on content.
 */
export function isExcellonFile(content: string): boolean {
  const upper = content.substring(0, 2000).toUpperCase()
  // Common Excellon indicators
  return (
    upper.includes('M48') ||
    upper.includes('M95') ||
    upper.includes('T01C') ||
    upper.includes('T01C') ||
    upper.includes('FORMAT=') ||
    upper.includes('ICI,') ||
    (upper.includes('T01') && upper.includes('X') && upper.includes('Y') && !upper.includes('%FSLAX'))
  )
}

/**
 * Get a human-readable summary of a parsed Excellon file.
 */
export function excellonSummary(file: ExcellonFile): string {
  const lines: string[] = []
  lines.push('=== Excellon Drill File Summary ===')
  lines.push(`File: ${file.fileName}`)
  lines.push(`Units: ${file.units}`)
  lines.push(`Format: ${file.formatInteger}.${file.formatDecimal} (${file.zeroSuppression} zero suppression)`)
  lines.push(`Tools: ${file.tools.size}`)
  lines.push(`Drill Hits: ${file.hits.length}`)

  if (file.bounds) {
    lines.push(`Bounds:`)
    lines.push(`  X: [${file.bounds.minX.toFixed(4)}, ${file.bounds.maxX.toFixed(4)}]`)
    lines.push(`  Y: [${file.bounds.minY.toFixed(4)}, ${file.bounds.maxY.toFixed(4)}]`)
    const width = file.bounds.maxX - file.bounds.minX
    const height = file.bounds.maxY - file.bounds.minY
    lines.push(`  Size: ${width.toFixed(4)} x ${height.toFixed(4)} ${file.units}`)
  }

  if (file.tools.size > 0) {
    lines.push('Tools:')
    for (const [num, tool] of Array.from(file.tools.entries()).sort((a, b) => a[0] - b[0])) {
      const shapeStr = tool.shape === 'circle' ? '⌀' : tool.shape === 'slot' ? 'Slot' : '?'
      const sizeStr = tool.shape === 'slot'
        ? `${tool.diameter} x ${tool.length}`
        : `${tool.diameter}`
      lines.push(`  T${String(num).padStart(2, '0')}: ${shapeStr} ${sizeStr} ${file.units}`)
    }
  }

  if (file.warnings.length > 0) {
    lines.push('Warnings:')
    for (const w of file.warnings) {
      lines.push(`  ⚠ ${w}`)
    }
  }

  return lines.join('\n')
}
