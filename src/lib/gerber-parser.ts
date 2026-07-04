/**
 * Gerber RS-274X Parser
 *
 * A complete parser for the Gerber RS-274X file format used in PCB manufacturing.
 * Handles aperture definitions, coordinate formats, interpolation modes, region mode,
 * draw/flash commands, polarity, and boundary calculation.
 *
 * Reference: Ucamco Gerber Layer Format Specification (RS-274X)
 */

// ============================================================================
// Type Definitions
// ============================================================================

/** Shape type for standard aperture definitions */
export type ApertureShape = 'circle' | 'rectangle' | 'obround' | 'polygon' | 'macro';

/** Polarity mode — dark (default) or clear */
export type Polarity = 'dark' | 'clear';

/** Unit system for the Gerber file */
export type GerberUnit = 'inches' | 'mm';

/** Coordinate format specification for X/Y axes */
export interface CoordinateFormat {
  integer: number;
  decimal: number;
}

/** Complete aperture definition from %ADD...*% */
export interface GerberAperture {
  /** Aperture code number, e.g. 11 for D11 */
  code: number;
  /** Shape type */
  shape: ApertureShape;
  /** X dimension (or diameter for circles) */
  width?: number;
  /** Y dimension */
  height?: number;
  /** Rotation in degrees */
  rotation?: number;
  /** Hole diameter (for circles and rectangles) */
  holeDiameter?: number;
  /** Name of aperture macro (when shape is 'macro') */
  macroName?: string;
  /** Macro parameters (when shape is 'macro') */
  parameters?: Record<string, number>;
}

/** Parsed coordinate values from a draw command */
export interface GerberCoordinate {
  x?: number;
  y?: number;
  /** Arc center offset X (for G02/G03 arcs) */
  i?: number;
  /** Arc center offset Y (for G02/G03 arcs) */
  j?: number;
}

/** Type of draw/flash command */
export type CommandType = 'move' | 'interpolate' | 'flash' | 'arc_cw' | 'arc_ccw';

/** A single draw command (move, interpolate, flash, or arc) */
export interface GerberDrawCommand {
  /** Command type */
  type: CommandType;
  /** Coordinate data (X, Y, I, J) */
  coordinate: GerberCoordinate;
  /** Currently selected aperture code, or null if none selected */
  apertureCode: number | null;
  /** Whether the command occurs inside a region (G36..G37) */
  regionMode: boolean;
  /** Current polarity */
  polarity: Polarity;
}

/** A region boundary (G36..G37 block) */
export interface GerberRegion {
  /** Start index (inclusive) in the commands array */
  startIdx: number;
  /** End index (exclusive) in the commands array */
  endIdx: number;
  /** Polarity of the region */
  polarity: Polarity;
}

/** Bounding box of the Gerber layer */
export interface GerberBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Complete parsed Gerber layer */
export interface GerberLayer {
  /** Source file name */
  fileName: string;
  /** Raw file content */
  rawContent: string;
  /** Unit system */
  units: GerberUnit;
  /** X-axis coordinate format */
  formatX: CoordinateFormat;
  /** Y-axis coordinate format */
  formatY: CoordinateFormat;
  /** All defined apertures keyed by code */
  apertures: Map<number, GerberAperture>;
  /** Ordered list of draw commands */
  commands: GerberDrawCommand[];
  /** Detected region boundaries */
  regions: GerberRegion[];
  /** Calculated bounding box, or null if no geometry */
  bounds: GerberBounds | null;
  /** Warnings encountered during parsing */
  warnings: string[];
}

// ============================================================================
// Internal Parser State
// ============================================================================

/** Zero omission mode from the FS command */
type ZeroOmission = 'leading' | 'trailing';

/** Coordinate notation from the FS command */
type CoordinateNotation = 'absolute' | 'incremental';

/**
 * Internal mutable state for the parser during processing.
 * Tracks the current mode settings as we walk through the file line by line.
 */
class ParserState {
  /** Current unit system (defaults to inches) */
  units: GerberUnit = 'inches';

  /** X-axis format: number of integer digits before the decimal point */
  fmtXInteger = 2;
  /** X-axis format: number of decimal digits after the decimal point */
  fmtXDecimal = 4;
  /** Y-axis format: number of integer digits before the decimal point */
  fmtYInteger = 2;
  /** Y-axis format: number of decimal digits after the decimal point */
  fmtYDecimal = 4;

  /** Zero omission mode (default: leading) */
  zeroOmission: ZeroOmission = 'leading';
  /** Coordinate notation mode (default: absolute) */
  coordinateNotation: CoordinateNotation = 'absolute';

  /** Currently selected aperture code */
  currentAperture: number | null = null;

  /** Last seen coordinate operation code (1, 2, or 3) */
  lastDCode: number | null = null;

  /** Currently selected interpolation mode */
  interpolationMode: CommandType = 'interpolate';

  /** Whether we are inside a G36 region */
  regionMode = false;
  /** Index of the first command in the current region, or null */
  regionStartIdx: number | null = null;

  /** Current polarity */
  polarity: Polarity = 'dark';

  /** Current X/Y position (for incremental modes and bounds tracking) */
  currentX: number | null = null;
  currentY: number | null = null;

  /** Collected apertures */
  apertures = new Map<number, GerberAperture>();

  /** Collected draw commands */
  commands: GerberDrawCommand[] = [];

  /** Collected regions */
  regions: GerberRegion[] = [];

  /** Warnings */
  warnings: string[] = [];

  /** Total number of characters in the X/Y coordinate fields */
  private get totalDigitsX(): number {
    return this.fmtXInteger + this.fmtXDecimal;
  }

  private get totalDigitsY(): number {
    return this.fmtYInteger + this.fmtYDecimal;
  }

  /**
   * Convert a raw coordinate string into a real number based on the current
   * format specification and zero omission mode.
   *
   * @param raw - The raw digit string (e.g., "92475" or "0092475")
   * @param axis - 'x' or 'y' (or 'ij' which uses X format by convention)
   * @returns The interpreted coordinate value, or undefined if raw is empty
   */
  parseCoordinateValue(raw: string | undefined, axis: 'x' | 'y' | 'ij'): number | undefined {
    if (raw === undefined || raw === '') {
      return undefined;
    }

    // Determine total digit count for this axis
    // I/J offsets typically use the same format as X/Y
    const totalDigits = axis === 'y' ? this.totalDigitsY : this.totalDigitsX;
    const intDigits = axis === 'y' ? this.fmtYInteger : this.fmtXInteger;
    const decDigits = axis === 'y' ? this.fmtYDecimal : this.fmtXDecimal;

    // Remove any negative sign for processing, remember it
    let negative = false;
    let digits = raw;
    if (digits.startsWith('-')) {
      negative = true;
      digits = digits.substring(1);
    }

    // Remove any '+' prefix
    if (digits.startsWith('+')) {
      digits = digits.substring(1);
    }

    // Remove any embedded decimal point (some files include them)
    digits = digits.replace('.', '');

    // Apply zero omission
    let padded: string;
    if (this.zeroOmission === 'leading') {
      // Leading zero omission: pad with leading zeros to fill totalDigits
      padded = digits.padStart(totalDigits, '0');
    } else {
      // Trailing zero omission: pad with trailing zeros to fill totalDigits
      padded = digits.padEnd(totalDigits, '0');
    }

    // If the raw string had fewer digits than expected, warn
    if (padded.length > totalDigits) {
      // Take the rightmost digits if we got too many
      padded = padded.substring(padded.length - totalDigits);
    }

    // Split into integer and decimal parts
    const intPart = padded.substring(0, intDigits) || '0';
    const decPart = padded.substring(intDigits) || '0';

    const value = parseFloat(`${negative ? '-' : ''}${intPart}.${decPart}`);

    if (isNaN(value)) {
      return undefined;
    }

    return value;
  }
}

// ============================================================================
// Format Specification Parser
// ============================================================================

/**
 * Parse the FS (Format Specification) command.
 *
 * Format: %FSLAX<nn>Y<nn>*% or %FSTAX<nn>Y<nn>*%
 * - 'L' = leading zero omission, 'T' = trailing zero omission
 * - 'A' = absolute coordinates, 'I' = incremental
 * - <nn> = two-digit format specifier where first digit = integer places,
 *          second digit = decimal places (e.g., 26 = 2 integer + 6 decimal)
 *
 * @param data - The FS command body (e.g., "LAX26Y26")
 * @param state - The current parser state to update
 */
function parseFormatSpecification(data: string, state: ParserState): void {
  // Remove leading 'FS' if present
  let body = data.trimStart();
  if (body.startsWith('FS')) {
    body = body.substring(2);
  }

  // Parse zero omission mode (first character)
  const zeroOmissionChar = body.charAt(0).toUpperCase();
  if (zeroOmissionChar === 'L') {
    state.zeroOmission = 'leading';
  } else if (zeroOmissionChar === 'T') {
    state.zeroOmission = 'trailing';
  } else {
    state.warnings.push(`Unknown zero omission mode '${zeroOmissionChar}', defaulting to leading`);
  }
  body = body.substring(1);

  // Parse coordinate notation (second character)
  const notationChar = body.charAt(0).toUpperCase();
  if (notationChar === 'A') {
    state.coordinateNotation = 'absolute';
  } else if (notationChar === 'I') {
    state.coordinateNotation = 'incremental';
    state.warnings.push('Incremental coordinate mode detected — interpretation may vary');
  }
  body = body.substring(1);

  // Parse X format: find X followed by two digits
  const xMatch = body.match(/X(\d)(\d)/i);
  if (xMatch) {
    state.fmtXInteger = parseInt(xMatch[1], 10);
    state.fmtXDecimal = parseInt(xMatch[2], 10);
  }

  // Parse Y format: find Y followed by two digits
  const yMatch = body.match(/Y(\d)(\d)/i);
  if (yMatch) {
    state.fmtYInteger = parseInt(yMatch[1], 10);
    state.fmtYDecimal = parseInt(yMatch[2], 10);
  }
}

// ============================================================================
// Aperture Definition Parser
// ============================================================================

/**
 * Parse a standard aperture definition command (%ADD<code><shape>,<params>*%).
 *
 * Supports:
 * - %ADD10C,0.8*%       — Circle, diameter 0.8
 * - %ADD11R,1.0X0.5*%   — Rectangle, 1.0 x 0.5
 * - %ADD12O,1.0X0.5X45*% — Obround, 1.0 x 0.5, rotated 45 degrees
 * - %ADD13C,0.8X0.2*%   — Circle with hole diameter 0.2
 * - %ADD14P,0.5X6*%     — Polygon, outer diameter 0.5, 6 vertices
 * - %ADD15CIRCLE,0.8*%  — Extended (named) circle
 * - %ADD16RECT,1.0X0.5*% — Extended (named) rectangle
 * - %ADD17ROUNDED,1.0X0.5*% — Extended (named) obround
 * - %ADD18AMMYMACRO,0.5X0.3*% — Aperture macro
 *
 * @param data - The ADD command body (after "ADD")
 * @param state - Current parser state
 */
function parseApertureDefinition(data: string, state: ParserState): void {
  let body = data.trimStart();
  if (body.startsWith('ADD')) {
    body = body.substring(3);
  }

  // Extract aperture code (digits immediately after ADD)
  const codeMatch = body.match(/^(\d+)/);
  if (!codeMatch) {
    state.warnings.push(`Malformed aperture definition: missing code in "${data}"`);
    return;
  }
  const code = parseInt(codeMatch[1], 10);
  body = body.substring(codeMatch[1].length);

  // Determine shape and parse the rest
  // Standard shapes: C (circle), R (rectangle), O (obround), P (polygon)
  // Extended shapes: CIRCLE, RECT, RECTANGLE, ROUNDED, OBROUND, POLYGON, etc.
  // Macro apertures: AM<name> or any other identifier not matching above

  const shapeMatch = body.match(/^([A-Za-z]+)/);
  if (!shapeMatch) {
    state.warnings.push(`Malformed aperture definition: missing shape in "${data}"`);
    return;
  }

  const shapeStr = shapeMatch[1].toUpperCase();
  body = body.substring(shapeMatch[1].length);

  // Skip optional comma separator (some files use it, some don't)
  if (body.startsWith(',')) {
    body = body.substring(1);
  }

  // Parse the parameter string up to the * terminator
  const paramStr = body.split('*')[0].trim();

  // Classify the shape
  let shape: ApertureShape;
  let isMacro = false;
  let macroName: string | undefined;

  switch (shapeStr) {
    case 'C':
    case 'CIRCLE':
      shape = 'circle';
      break;
    case 'R':
    case 'RECT':
    case 'RECTANGLE':
      shape = 'rectangle';
      break;
    case 'O':
    case 'ROUNDED':
    case 'OBROUND':
      shape = 'obround';
      break;
    case 'P':
    case 'POLYGON':
      shape = 'polygon';
      break;
    default:
      // Anything else is treated as an aperture macro reference
      shape = 'macro';
      isMacro = true;
      macroName = shapeStr;
      break;
  }

  const aperture: GerberAperture = {
    code,
    shape,
  };

  if (isMacro) {
    // Parse macro parameters: comma-separated values
    aperture.macroName = macroName;
    if (paramStr.length > 0) {
      const params = paramStr.split('X');
      const paramMap: Record<string, number> = {};
      params.forEach((val, idx) => {
        const num = parseFloat(val);
        if (!isNaN(num)) {
          paramMap[`$${idx + 1}`] = num;
        }
      });
      aperture.parameters = paramMap;
    }
  } else {
    // Parse standard aperture parameters: X-separated values
    // Format: size | sizeXsize | sizeXsizeXrotation | sizeXholeDiameter
    // For polygon: outerDiamXnumVerticesXrotation
    if (paramStr.length > 0) {
      const parts = paramStr.split('X');

      const firstVal = parseFloat(parts[0]);
      if (!isNaN(firstVal)) {
        if (shape === 'circle') {
          aperture.width = firstVal; // diameter
        } else {
          aperture.width = firstVal;
        }
      }

      // Second value: height for rect/obround, or vertex count for polygon
      if (parts.length >= 2) {
        const secondVal = parseFloat(parts[1]);
        if (!isNaN(secondVal)) {
          if (shape === 'polygon') {
            // For polygon, second param is vertex count — store as width/height convention
            aperture.width = firstVal; // outer diameter
            aperture.height = secondVal; // reuse height field for vertex count
          } else {
            aperture.height = secondVal;
          }
        }
      }

      // Third value: rotation (for polygon this would be rotation too)
      if (parts.length >= 3) {
        const thirdVal = parseFloat(parts[2]);
        if (!isNaN(thirdVal)) {
          if (shape === 'polygon') {
            aperture.rotation = thirdVal;
          } else {
            aperture.rotation = thirdVal;
          }
        }
      }

      // For circle with hole: C,0.8X0.2 (second value is hole diameter)
      // Check if it's a circle with only 2 params (diameter + hole, not diameter + height)
      if (shape === 'circle' && parts.length === 2 && aperture.height !== undefined) {
        // The second param could be hole diameter or a second dimension.
        // In standard Gerber, C,sizeXhole is valid.
        aperture.holeDiameter = aperture.height;
        delete aperture.height;
      }
    }
  }

  state.apertures.set(code, aperture);
}

// ============================================================================
// Coordinate Extraction
// ============================================================================

/**
 * Extract coordinate parameters from a Gerber command string.
 *
 * Gerber commands use single-letter prefixes followed by numeric values:
 *   X<value> Y<value> I<value> J<value>
 *
 * The numeric values may include signs (+/-) and may omit leading/trailing
 * zeros according to the FS specification.
 *
 * @param cmd - The command string to parse coordinates from
 * @returns An object with raw string values for x, y, i, j
 */
function extractCoordinates(cmd: string): { x?: string; y?: string; i?: string; j?: string } {
  const result: { x?: string; y?: string; i?: string; j?: string } = {};

  // Match coordinate letter followed by numeric value (including optional sign)
  // The value continues until the next letter or the end
  const coordPattern = /([XYIJ])([+-]?\d*\.?\d*)/gi;
  let match: RegExpExecArray | null;

  while ((match = coordPattern.exec(cmd)) !== null) {
    const letter = match[1].toUpperCase();
    const value = match[2];
    switch (letter) {
      case 'X':
        result.x = value;
        break;
      case 'Y':
        result.y = value;
        break;
      case 'I':
        result.i = value;
        break;
      case 'J':
        result.j = value;
        break;
    }
  }

  return result;
}

// ============================================================================
// Command Line Processing
// ============================================================================

/**
 * Process a single Gerber data block (line ending with *).
 * Data blocks may contain G-codes, D-codes, coordinates, or combinations.
 *
 * Examples:
 *   G01*              — set linear interpolation mode
 *   X12300Y45600D01*  — draw to (12300, 45600)
 *   D03*              — flash at current position
 *   G36*              — begin region
 *   M02*              — end of file
 *
 * @param block - The data block string (without the trailing *)
 * @param state - Current parser state to update
 * @param cmdIdx - Index of the current command being built (-1 if not yet)
 */
function processDataBlock(block: string, state: ParserState, _cmdIdx: number): void {
  const trimmed = block.trim().toUpperCase();
  if (trimmed === '') return;

  // ---- G-Codes (set modes — processed first, no commands generated) ----

  // G01 — Linear interpolation mode
  if (trimmed.includes('G01') || trimmed.includes('G1')) {
    state.interpolationMode = 'interpolate';
  }

  // G02 — Clockwise circular interpolation
  if (trimmed.includes('G02') || trimmed.includes('G2')) {
    state.interpolationMode = 'arc_cw';
  }

  // G03 — Counter-clockwise circular interpolation
  if (trimmed.includes('G03') || trimmed.includes('G3')) {
    state.interpolationMode = 'arc_ccw';
  }

  // G36 — Begin region mode
  if (trimmed.includes('G36')) {
    state.regionMode = true;
    state.regionStartIdx = state.commands.length;
  }

  // G37 — End region mode
  if (trimmed.includes('G37')) {
    if (state.regionMode && state.regionStartIdx !== null) {
      state.regions.push({
        startIdx: state.regionStartIdx,
        endIdx: state.commands.length,
        polarity: state.polarity,
      });
    } else {
      state.warnings.push('G37 (end region) without matching G36');
    }
    state.regionMode = false;
    state.regionStartIdx = null;
  }

  // G70 — Set units to inches
  if (trimmed.includes('G70')) {
    state.units = 'inches';
  }

  // G71 — Set units to millimeters
  if (trimmed.includes('G71')) {
    state.units = 'mm';
  }

  // G75 — Multi quadrant arc mode (default, no special handling needed)

  // ---- LP — Level Polarity ----
  if (trimmed.includes('LPD')) {
    state.polarity = 'dark';
  }
  if (trimmed.includes('LPC')) {
    state.polarity = 'clear';
  }

  // ---- D-Codes ----
  // Extract the D-code from the END of the command string.
  // In RS-274X, the D-code is always the last element: X<val>Y<val>I<val>J<val>D<nn>
  // This approach avoids the operator precedence bug with includes() substring matching.
  const dcodeMatch = trimmed.match(/D(\d{1,2})\s*$/);
  const dcode = dcodeMatch ? parseInt(dcodeMatch[1], 10) : null;

  if (dcode === 1 || dcode === 2 || dcode === 3) {
    state.lastDCode = dcode;
  }

  if (dcode === 1) {
    // D01 — Interpolate (draw with current aperture)
    const coords = extractCoordinates(block);
    const x = state.parseCoordinateValue(coords.x, 'x');
    const y = state.parseCoordinateValue(coords.y, 'y');
    const i = state.parseCoordinateValue(coords.i, 'ij');
    const j = state.parseCoordinateValue(coords.j, 'ij');

    if (x !== undefined) state.currentX = x;
    if (y !== undefined) state.currentY = y;

    // CAM350 "Assume G01" fix:
    // If the file is in arc mode but a D01 command lacks both I and J coordinates,
    // it is invalid as an arc. Treat it as a linear move (G01) and reset the mode.
    if ((state.interpolationMode === 'arc_cw' || state.interpolationMode === 'arc_ccw') &&
        i === undefined && j === undefined) {
      state.interpolationMode = 'interpolate';
      state.warnings.push('Circular interpolation lacks I and J parameters. Assuming G01 (Linear) mode for this and subsequent commands.');
    }

    state.commands.push({
      type: state.interpolationMode,
      coordinate: { x, y, i, j },
      apertureCode: state.currentAperture,
      regionMode: state.regionMode,
      polarity: state.polarity,
    });
  } else if (dcode === 2) {
    // D02 — Move (travel without drawing)
    const coords = extractCoordinates(block);
    const x = state.parseCoordinateValue(coords.x, 'x');
    const y = state.parseCoordinateValue(coords.y, 'y');

    if (x !== undefined) state.currentX = x;
    if (y !== undefined) state.currentY = y;

    state.commands.push({
      type: 'move',
      coordinate: { x, y },
      apertureCode: state.currentAperture,
      regionMode: state.regionMode,
      polarity: state.polarity,
    });
  } else if (dcode === 3) {
    // D03 — Flash (expose at current position)
    const coords = extractCoordinates(block);
    const x = state.parseCoordinateValue(coords.x, 'x');
    const y = state.parseCoordinateValue(coords.y, 'y');

    if (x !== undefined) state.currentX = x;
    if (y !== undefined) state.currentY = y;

    state.commands.push({
      type: 'flash',
      coordinate: { x, y },
      apertureCode: state.currentAperture,
      regionMode: state.regionMode,
      polarity: state.polarity,
    });
  } else if (dcode !== null && dcode >= 10) {
    // Dnn (nn >= 10) — Select aperture for future commands.
    // Per RS-274X spec, coordinates with Dnn>=10 act as a D02 (move) before selecting.
    const coords = extractCoordinates(block);
    const hasCoords = coords.x !== undefined || coords.y !== undefined;

    if (hasCoords) {
      const x = state.parseCoordinateValue(coords.x, 'x');
      const y = state.parseCoordinateValue(coords.y, 'y');
      if (x !== undefined) state.currentX = x;
      if (y !== undefined) state.currentY = y;

      // Move to the new position (per Gerber spec, coordinates with Dnn act as D02)
      state.commands.push({
        type: 'move',
        coordinate: { x, y },
        apertureCode: state.currentAperture,
        regionMode: state.regionMode,
        polarity: state.polarity,
      });
    }

    // Select the aperture for subsequent commands
    state.currentAperture = dcode;
    if (!state.apertures.has(dcode)) {
      state.warnings.push(`Aperture D${dcode} selected but not defined`);
    }
  } else if (dcode === null) {
    // Omitted D-code: inherits previous D-code (D01, D02 or D03).
    // If no D-code has been seen yet, default to D01 (Interpolate) per RS-274X.
    const coords = extractCoordinates(block);
    const hasCoords = coords.x !== undefined || coords.y !== undefined || coords.i !== undefined || coords.j !== undefined;

    if (hasCoords) {
      const activeDCode = state.lastDCode !== null ? state.lastDCode : 1;
      const x = state.parseCoordinateValue(coords.x, 'x');
      const y = state.parseCoordinateValue(coords.y, 'y');
      const i = state.parseCoordinateValue(coords.i, 'ij');
      const j = state.parseCoordinateValue(coords.j, 'ij');

      if (x !== undefined) state.currentX = x;
      if (y !== undefined) state.currentY = y;

      if (activeDCode === 1) {
        // Inherited D01 (Interpolate)
        if ((state.interpolationMode === 'arc_cw' || state.interpolationMode === 'arc_ccw') &&
            i === undefined && j === undefined) {
          state.interpolationMode = 'interpolate';
          state.warnings.push('Circular interpolation lacks I and J parameters. Assuming G01 (Linear) mode for this and subsequent commands.');
        }

        state.commands.push({
          type: state.interpolationMode,
          coordinate: { x, y, i, j },
          apertureCode: state.currentAperture,
          regionMode: state.regionMode,
          polarity: state.polarity,
        });
      } else if (activeDCode === 2) {
        // Inherited D02 (Move)
        state.commands.push({
          type: 'move',
          coordinate: { x, y },
          apertureCode: state.currentAperture,
          regionMode: state.regionMode,
          polarity: state.polarity,
        });
      } else if (activeDCode === 3) {
        // Inherited D03 (Flash)
        state.commands.push({
          type: 'flash',
          coordinate: { x, y },
          apertureCode: state.currentAperture,
          regionMode: state.regionMode,
          polarity: state.polarity,
        });
      }
    }
  }

  // ---- M-Codes ----
  // M02 — End of file (handled at the top level)
  if (trimmed.includes('M02') || trimmed.includes('M2')) {
    // EOF handled in main parser
  }
}

// ============================================================================
// Repeat (SR / X) Command Parser
// ============================================================================

/**
 * Parse the Step and Repeat (SR) command if present in a data block.
 *
 * Format: %SRX<repeat>Y<repeat>I<step>J<step>*%
 * This defines a repeating pattern. When encountered, we expand the repeated
 * commands into the command stream.
 *
 * For simplicity, this implementation records the SR parameters as a warning
 * since full expansion requires buffering of subsequent commands, which is
 * beyond the scope of a single-pass parser.
 *
 * @param data - The SR command body
 * @param state - Current parser state
 */
function parseStepRepeat(data: string, state: ParserState): void {
  const xMatch = data.match(/X(\d+)/i);
  const yMatch = data.match(/Y(\d+)/i);

  if (xMatch || yMatch) {
    const xRepeat = xMatch ? parseInt(xMatch[1], 10) : 1;
    const yRepeat = yMatch ? parseInt(yMatch[1], 10) : 1;
    state.warnings.push(
      `Step and Repeat detected (X=${xRepeat}, Y=${yRepeat}). ` +
      `SR expansion requires multi-pass support and is noted but not expanded.`
    );
  }
}

// ============================================================================
// Aperture Macro Parser
// ============================================================================

/**
 * Parse an Aperture Macro (AM) definition block.
 *
 * Aperture macros define complex shapes using a drawing language.
 * Format: %AM<name>*<variable definitions>*<primitive 1>*...*%
 *
 * This implementation extracts the macro name and content for later use.
 * Full macro expansion is not implemented (would require a macro interpreter).
 *
 * @param data - The AM command body (after %AM)
 * @param state - Current parser state
 */
function parseApertureMacro(data: string, state: ParserState): void {
  const nameMatch = data.match(/^(\w+)/);
  if (nameMatch) {
    // Store as a warning for now — full macro interpretation would be separate
    state.warnings.push(`Aperture macro "${nameMatch[1]}" defined. Macro content stored for reference.`);
  }
}

// ============================================================================
// Bounds Calculation
// ============================================================================

/**
 * Calculate the bounding box of all geometry in the Gerber layer.
 *
 * The bounds are computed from:
 * - Flash positions (X, Y of flash commands)
 * - Draw endpoints (X, Y of interpolate and move commands)
 * - For arcs, the approximate endpoint position
 *
 * @param commands - List of all draw commands
 * @param apertures - Map of aperture definitions (used for flash size consideration)
 * @returns Bounding box or null if no geometry
 */
function calculateBounds(
  commands: GerberDrawCommand[],
  apertures: Map<number, GerberAperture>
): GerberBounds | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  let hasGeometry = false;

  for (const cmd of commands) {
    const { x, y } = cmd.coordinate;
    if (x === undefined && y === undefined) continue;

    hasGeometry = true;

    if (x !== undefined) {
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
    }
    if (y !== undefined) {
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }

    // For flash commands, account for the aperture size
    if (cmd.type === 'flash' && cmd.apertureCode !== null) {
      const ap = apertures.get(cmd.apertureCode);
      if (ap && ap.width !== undefined) {
        const halfW = ap.width / 2;
        if (x !== undefined) {
          minX = Math.min(minX, x - halfW);
          maxX = Math.max(maxX, x + halfW);
        }
        if (y !== undefined) {
          minY = Math.min(minY, y - halfW);
          maxY = Math.max(maxY, y + halfW);
        }
      }
      if (ap && ap.height !== undefined) {
        const halfH = ap.height / 2;
        if (y !== undefined) {
          minY = Math.min(minY, y - halfH);
          maxY = Math.max(maxY, y + halfH);
        }
        if (x !== undefined) {
          minX = Math.min(minX, x - halfH);
          maxX = Math.max(maxX, x + halfH);
        }
      }
    }
  }

  if (!hasGeometry) {
    return null;
  }

  return { minX, minY, maxX, maxY };
}

// ============================================================================
// Main Parser Function
// ============================================================================

/**
 * Parse a complete Gerber RS-274X file into a structured GerberLayer object.
 *
 * This function processes the file line-by-line, handling:
 * - Extended commands (delimited by %...%) such as format specs, aperture
 *   definitions, aperture macros, polarity, and step-and-repeat
 * - Data blocks (terminated by *) containing G-codes, D-codes, and coordinates
 * - Comments (G04)
 * - End-of-file marker (M02)
 *
 * @param content - The raw Gerber file content as a string
 * @param fileName - The name of the source file (for reference)
 * @returns A fully parsed GerberLayer with apertures, commands, regions, and bounds
 *
 * @example
 * ```typescript
 * const layer = parseGerber(gerberContent, 'top-copper.gtl');
 * console.log(`Units: ${layer.units}`);
 * console.log(`Apertures: ${layer.apertures.size}`);
 * console.log(`Commands: ${layer.commands.length}`);
 * console.log(`Bounds:`, layer.bounds);
 * ```
 */
export function parseGerber(content: string, fileName: string): GerberLayer {
  const state = new ParserState();

  // Pre-process: normalize line endings to \n
  const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // Gerber files can have extended commands delimited by %...%
  // and data blocks terminated by *. We need to handle both.

  let i = 0;
  const len = normalized.length;

  // Track whether we are inside an extended command block (between % delimiters)
  let inExtendedBlock = false;
  let extendedBuffer = '';

  // Buffer for data block characters (between * terminators)
  let dataBuffer = '';

  while (i < len) {
    const ch = normalized[i];

    if (ch === '%') {
      // Toggle extended command mode
      if (inExtendedBlock) {
        // End of extended command — process the accumulated buffer
        processExtendedCommand(extendedBuffer, state);
        extendedBuffer = '';
        inExtendedBlock = false;
      } else {
        // Beginning of extended command — flush any pending data
        if (dataBuffer.trim().length > 0) {
          processDataBlock(dataBuffer, state, state.commands.length - 1);
          dataBuffer = '';
        }
        inExtendedBlock = true;
      }
      i++;
      continue;
    }

    if (inExtendedBlock) {
      // Accumulate characters inside extended block
      // Extended commands may be terminated by * but the % is the real delimiter
      extendedBuffer += ch;
      i++;
      continue;
    }

    if (ch === '*') {
      // End of data block — process it
      if (dataBuffer.trim().length > 0) {
        // Handle G04 comments specially — they contain text after G04
        const upper = dataBuffer.toUpperCase().trim();
        if (upper.startsWith('G04')) {
          // Comment — skip it
        } else if (upper.startsWith('M02') || upper.startsWith('M2')) {
          // End of file — stop processing
          break;
        } else {
          processDataBlock(dataBuffer, state, state.commands.length - 1);
        }
      }
      dataBuffer = '';
      i++;
      continue;
    }

    // Regular character — accumulate into data buffer
    dataBuffer += ch;
    i++;
  }

  // Process any remaining data buffer
  if (dataBuffer.trim().length > 0) {
    processDataBlock(dataBuffer, state, state.commands.length - 1);
  }

  // Handle remaining extended block (malformed file missing closing %)
  if (extendedBuffer.trim().length > 0) {
    processExtendedCommand(extendedBuffer, state);
  }

  // Close any unclosed region
  if (state.regionMode && state.regionStartIdx !== null) {
    state.warnings.push('Unclosed region at end of file (missing G37)');
    state.regions.push({
      startIdx: state.regionStartIdx,
      endIdx: state.commands.length,
      polarity: state.polarity,
    });
  }

  // Calculate bounds
  const bounds = calculateBounds(state.commands, state.apertures);

  // Build the result
  const layer: GerberLayer = {
    fileName,
    rawContent: content,
    units: state.units,
    formatX: { integer: state.fmtXInteger, decimal: state.fmtXDecimal },
    formatY: { integer: state.fmtYInteger, decimal: state.fmtYDecimal },
    apertures: state.apertures,
    commands: state.commands,
    regions: state.regions,
    bounds,
    warnings: state.warnings,
  };

  return layer;
}

// ============================================================================
// Extended Command Dispatcher
// ============================================================================

/**
 * Process an extended command block (content between % delimiters).
 *
 * Extended commands are further subdivided by * terminators. Common commands:
 * - FS — Format Specification
 * - ADD — Aperture Definition
 * - AD — Short form of ADD
 * - AM — Aperture Macro
 * - LP — Level Polarity
 * - SR — Step and Repeat
 * - TF — File attributes
 * - TA — Aperture attributes
 * - TD — Delete attribute
 * - MO — Mode (units)
 *
 * @param buffer - The accumulated text of the extended command block
 * @param state - Current parser state to update
 */
function processExtendedCommand(buffer: string, state: ParserState): void {
  // Split the extended block into individual commands by * terminator
  const commands = buffer.split('*');

  for (const cmd of commands) {
    const trimmed = cmd.trim().toUpperCase();
    if (trimmed === '') continue;

    // ---- Format Specification ----
    if (trimmed.startsWith('FS')) {
      parseFormatSpecification(cmd, state);
      continue;
    }

    // ---- Mode (Units) — MOIN / MOMM ----
    if (trimmed.startsWith('MOIN')) {
      state.units = 'inches';
      continue;
    }
    if (trimmed.startsWith('MOMM')) {
      state.units = 'mm';
      continue;
    }

    // ---- Aperture Definition ----
    if (trimmed.startsWith('ADD') || trimmed.startsWith('AD')) {
      parseApertureDefinition(cmd, state);
      continue;
    }

    // ---- Aperture Macro ----
    if (trimmed.startsWith('AM')) {
      parseApertureMacro(cmd, state);
      continue;
    }

    // ---- Level Polarity ----
    if (trimmed.startsWith('LPD')) {
      state.polarity = 'dark';
      continue;
    }
    if (trimmed.startsWith('LPC')) {
      state.polarity = 'clear';
      continue;
    }

    // ---- Step and Repeat ----
    if (trimmed.startsWith('SR')) {
      parseStepRepeat(cmd, state);
      continue;
    }

    // ---- File Attributes (TF, TA, TD, etc.) — informational, skip ----
    if (
      trimmed.startsWith('TF') ||
      trimmed.startsWith('TA') ||
      trimmed.startsWith('TD') ||
      trimmed.startsWith('TO')
    ) {
      // File attributes are informational — we skip them silently
      continue;
    }

    // ---- KO / IN (Knockout / Image Polarity) — informational ----
    if (trimmed.startsWith('KO') || trimmed.startsWith('IP')) {
      // Image polarity: IPPOS = positive, IPNEG = negative
      if (trimmed.startsWith('IPNEG')) {
        state.warnings.push('Negative image polarity (IPNEG) detected');
      }
      continue;
    }

    // Ignore unrecognized extended commands silently
    // (many CAM tools output custom extended commands)
  }
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Convert a coordinate value between units.
 *
 * @param value - The numeric value to convert
 * @param fromUnit - Source unit system
 * @param toUnit - Target unit system
 * @returns Converted value
 */
export function convertCoordinateUnits(
  value: number,
  fromUnit: GerberUnit,
  toUnit: GerberUnit
): number {
  if (fromUnit === toUnit) return value;
  if (fromUnit === 'inches' && toUnit === 'mm') {
    return value * 25.4;
  }
  // mm to inches
  return value / 25.4;
}

/**
 * Get a human-readable summary of a parsed Gerber layer.
 * Useful for debugging and display purposes.
 *
 * @param layer - The parsed Gerber layer
 * @returns A multi-line string summary
 */
export function gerberLayerSummary(layer: GerberLayer): string {
  const lines: string[] = [];
  lines.push(`=== Gerber Layer Summary ===`);
  lines.push(`File: ${layer.fileName}`);
  lines.push(`Units: ${layer.units}`);
  lines.push(`Format: X=${layer.formatX.integer}.${layer.formatX.decimal}, Y=${layer.formatY.integer}.${layer.formatY.decimal}`);
  lines.push(`Apertures: ${layer.apertures.size}`);
  lines.push(`Commands: ${layer.commands.length}`);
  lines.push(`Regions: ${layer.regions.length}`);
  lines.push(`Warnings: ${layer.warnings.length}`);

  if (layer.bounds) {
    lines.push(`Bounds:`);
    lines.push(`  X: [${layer.bounds.minX.toFixed(4)}, ${layer.bounds.maxX.toFixed(4)}]`);
    lines.push(`  Y: [${layer.bounds.minY.toFixed(4)}, ${layer.bounds.maxY.toFixed(4)}]`);
    const width = layer.bounds.maxX - layer.bounds.minX;
    const height = layer.bounds.maxY - layer.bounds.minY;
    lines.push(`  Size: ${width.toFixed(4)} x ${height.toFixed(4)} ${layer.units}`);
  } else {
    lines.push(`Bounds: (no geometry)`);
  }

  if (layer.warnings.length > 0) {
    lines.push(`Warnings:`);
    for (const w of layer.warnings) {
      lines.push(`  ⚠ ${w}`);
    }
  }

  // Aperture list
  if (layer.apertures.size > 0) {
    lines.push(`Apertures:`);
    for (const [code, ap] of Array.from(layer.apertures.entries())) {
      const size = ap.width !== undefined
        ? (ap.height !== undefined
          ? `${ap.width} x ${ap.height}`
          : `${ap.width}`)
        : 'macro';
      const rot = ap.rotation !== undefined ? ` @ ${ap.rotation}°` : '';
      const hole = ap.holeDiameter !== undefined ? ` hole=${ap.holeDiameter}` : '';
      lines.push(`  D${code}: ${ap.shape} (${size}${rot}${hole})`);
    }
  }

  return lines.join('\n');
}

/**
 * Convert all coordinates in a GerberLayer from one unit to another.
 * This is an in-place mutation of the layer's commands.
 *
 * @param layer - The parsed Gerber layer
 * @param targetUnit - The unit to convert to
 */
export function convertLayerUnits(layer: GerberLayer, targetUnit: GerberUnit): void {
  if (layer.units === targetUnit) return;

  const factor = targetUnit === 'mm' ? 25.4 : 1 / 25.4;

  // Convert all command coordinates
  for (const cmd of layer.commands) {
    if (cmd.coordinate.x !== undefined) cmd.coordinate.x *= factor;
    if (cmd.coordinate.y !== undefined) cmd.coordinate.y *= factor;
    if (cmd.coordinate.i !== undefined) cmd.coordinate.i *= factor;
    if (cmd.coordinate.j !== undefined) cmd.coordinate.j *= factor;
  }

  // Convert aperture dimensions
  for (const ap of Array.from(layer.apertures.values())) {
    if (ap.width !== undefined) ap.width *= factor;
    if (ap.height !== undefined) ap.height *= factor;
    if (ap.holeDiameter !== undefined) ap.holeDiameter *= factor;
  }

  // Recalculate bounds
  layer.bounds = calculateBounds(layer.commands, layer.apertures);

  // Update unit
  layer.units = targetUnit;
}

// ============================================================================
// Excellon Drill Parser
// ============================================================================

/**
 * Detect if the content is an Excellon drill file (not RS-274X Gerber).
 *
 * Excellon files typically start with M48 header and use T-code tool definitions
 * (T01C0.8), while Gerber files use %ADD...*% aperture definitions.
 */
export function isExcellonDrillFile(content: string): boolean {
  // 1. Binary file check: if content contains NULL bytes or Unicode replacement characters, it is binary/corrupt
  if (content.includes('\0') || content.includes('\uFFFD')) {
    return false
  }

  const stripped = content.trim()

  // 2. Structural check: a valid Excellon drill file must contain coordinates (X/Y) or tool numbers (Txx)
  const hasCoordinates = /X\s*[+-]?\d/i.test(stripped) || /Y\s*[+-]?\d/i.test(stripped)
  const hasTools = /T\d+/i.test(stripped)
  if (!hasCoordinates && !hasTools) {
    return false
  }

  // Most reliable: M48 at the start (Excellon header)
  if (stripped.startsWith('M48') || stripped.startsWith(';') && stripped.includes('M48')) {
    return true
  }
  // Check first 20 lines for Excellon indicators
  const lines = stripped.split('\n').slice(0, 20)
  for (const line of lines) {
    const upper = line.trim().toUpperCase()
    if (upper.startsWith('M48')) return true
    if (upper.startsWith(';')) {
      if (upper.includes('DRILL') || upper.includes('EXCELLON') || upper.includes('HOLE')) return true
    }
    // Tool definition pattern: T01C0.8 (Excellon style, no % delimiters)
    if (/^T\d{1,2}C/i.test(upper)) return true
  }
  // Check for FORMAT= or METRIC/INCH commands (Excellon format spec)
  if (content.includes('FORMAT=') || content.includes('FMAT,2') || content.includes('ICI,')) {
    return true
  }
  return false
}

export interface DrillFormatOverride {
  unit: GerberUnit
  integer: number
  decimal: number
  zeroSuppression: 'leading' | 'trailing'
}

/**
 * Parse an Excellon NC drill file into a GerberLayer structure.
 *
 * This parser handles:
 * - M48 header with tool definitions (T01C0.8)
 * - METRIC/INCH unit commands
 * - FORMAT= coordinate format specification
 * - METRIC,TZ / METRIC,LZ / INCH,TZ / INCH,LZ format variants
 * - G90 (absolute) / G91 (incremental) positioning
 * - G05 drill mode
 * - T-code tool selection
 * - X/Y coordinate hits
 * - M30 end program
 * - R01 repeat command (rare)
 * - Comments (;)
 *
 * The output reuses GerberLayer types: tools become circular apertures,
 * drill hits become flash commands.
 *
 * @param content - Raw Excellon drill file content
 * @param fileName - Source file name
 * @param forceFormat - Optional format override to ignore file's format declaration
 * @returns Parsed GerberLayer with drill data
 */
export function parseExcellonDrill(content: string, fileName: string, forceFormat?: DrillFormatOverride): GerberLayer {
  const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const lines = normalized.split('\n')

  const apertures = new Map<number, GerberAperture>()
  const commands: GerberDrawCommand[] = []
  const warnings: string[] = []

  let units: GerberUnit = forceFormat ? forceFormat.unit : 'inches'
  let fmtInt = forceFormat ? forceFormat.integer : 2
  let fmtDec = forceFormat ? forceFormat.decimal : 4
  let declaredZeroSuppression: 'leading' | 'trailing' = forceFormat ? forceFormat.zeroSuppression : 'leading'
  let currentTool: number | null = null
  let inBody = false
  let lastDrillX: number | null = null
  let lastDrillY: number | null = null

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) continue

    // Remove trailing * from data blocks
    const clean = line.replace(/\*$/, '').trim()

    // Skip comments
    if (clean.startsWith(';')) continue

    // M48 — Start of header
    if (clean.toUpperCase() === 'M48') {
      inBody = false
      continue
    }

    // % — End of header, start of body
    if (clean === '%') {
      inBody = true
      continue
    }

    // M30 — End program
    if (clean.toUpperCase() === 'M30') {
      break
    }

    if (!inBody) {
      // ---- HEADER PARSING ----

      // FMAT,2 — Format command (legacy)
      if (clean.toUpperCase().startsWith('FMAT')) continue

      // ICI,OFF/ON — Incremental mode for coordinates (rare, ignore)
      if (clean.toUpperCase().startsWith('ICI')) continue

      // G90 / G71 / G70 in header — treat as hints
      if (clean.toUpperCase() === 'G90') continue
      if (clean.toUpperCase() === 'G71') { units = 'mm'; continue }
      if (clean.toUpperCase() === 'G70') { units = 'inches'; continue }

      // FORMAT=/1:4 or FMT /1:4 style
      const fmtMatch = clean.match(/FORMAT\s*=\s*(\d)\s*:\s*(\d)/i) || clean.match(/FMT\s*\/(\d):(\d)/i)
      if (fmtMatch) {
        if (!forceFormat) {
          fmtInt = parseInt(fmtMatch[1], 10)
          fmtDec = parseInt(fmtMatch[2], 10)
        }
        continue
      }

      // METRIC/INCH with embedded format: METRIC,TZ,000.000 or METRIC,LZ,000.000
      const metMatch = clean.match(/^(METRIC|INCH)\s*,\s*(TZ|LZ)\s*,\s*(0+)\.(0+)/i)
      if (metMatch) {
        if (!forceFormat) {
          units = metMatch[1].toUpperCase() === 'METRIC' ? 'mm' : 'inches'
          declaredZeroSuppression = metMatch[2].toUpperCase() === 'LZ' ? 'leading' : 'trailing'
          fmtInt = metMatch[3].length
          fmtDec = metMatch[4].length
        }
        continue
      }

      // METRIC/INCH with just zero suppression: METRIC,TZ or INCH,LZ
      const unitMatch = clean.match(/^(METRIC|INCH)\s*,\s*(TZ|LZ)/i)
      if (unitMatch) {
        if (!forceFormat) {
          units = unitMatch[1].toUpperCase() === 'METRIC' ? 'mm' : 'inches'
          declaredZeroSuppression = unitMatch[2].toUpperCase() === 'LZ' ? 'leading' : 'trailing'
          if (units === 'mm') {
            fmtInt = 3
            fmtDec = 3
          } else {
            fmtInt = 2
            fmtDec = 4
          }
        }
        continue
      }

      // Bare METRIC or INCH
      if (clean.toUpperCase() === 'METRIC') {
        if (!forceFormat) {
          units = 'mm'
          fmtInt = 3
          fmtDec = 3
        }
        continue
      }
      if (clean.toUpperCase() === 'INCH') {
        if (!forceFormat) {
          units = 'inches'
          fmtInt = 2
          fmtDec = 4
        }
        continue
      }

      // Tool definition: T01C0.8 or T01C0.8F200S100
      const toolMatch = clean.match(/^T(\d{1,2})C([\d.]+)/i)
      if (toolMatch) {
        const code = parseInt(toolMatch[1], 10)
        const dia = parseFloat(toolMatch[2])
        if (dia > 0) {
          apertures.set(code, {
            code,
            shape: 'circle',
            width: dia,
          })
        }
        continue
      }

      // VER,1 / VER,2 — Version (informational)
      if (clean.toUpperCase().startsWith('VER')) continue

      // ATC / DETECT / SIGN — Autodetection commands (skip)
      if (clean.toUpperCase().startsWith('ATC') || clean.toUpperCase().startsWith('DETECT') || clean.toUpperCase().startsWith('SIGN')) continue

    } else {
      // ---- BODY PARSING ----

      // G-codes
      const upperClean = clean.toUpperCase()
      if (upperClean === 'G90') continue // Absolute positioning (default)
      if (upperClean === 'G91') { warnings.push('Incremental positioning (G91) detected — results may vary'); continue }
      if (upperClean === 'G05') continue // Drill mode on
      if (upperClean === 'G81' || upperClean === 'G82' || upperClean === 'G83') continue // Drill cycles
      if (upperClean === 'G00' || upperClean === 'G01') continue // Position/rate

      // R01 repeat (step repeat in Excellon)
      if (/^R\d{1,2}/i.test(clean)) {
        warnings.push(`Repeat command "${clean}" detected — not expanded`)
        continue
      }

      // Tool select: T01 or T01 (no C)
      const toolSelectMatch = clean.match(/^T(\d{1,2})$/i)
      if (toolSelectMatch) {
        currentTool = parseInt(toolSelectMatch[1], 10)
        continue
      }

      // Coordinate hit: X...Y...
      if (clean.includes('X') || clean.includes('Y')) {
        const coordMatch = clean.match(/X([+-]?\d*\.?\d*)Y([+-]?\d*\.?\d*)/i)
        if (coordMatch) {
          const xRaw = coordMatch[1] || ''
          const yRaw = coordMatch[2] || ''
          const x = parseExcellonCoord(xRaw, fmtInt, fmtDec, declaredZeroSuppression, units)
          const y = parseExcellonCoord(yRaw, fmtInt, fmtDec, declaredZeroSuppression, units)

          if (x !== null && y !== null) {
            // Convert to mm if needed (we store everything in mm internally)
            const xMm = units === 'mm' ? x : x * 25.4
            const yMm = units === 'mm' ? y : y * 25.4
            // Track current position for single-axis lines
            lastDrillX = xMm
            lastDrillY = yMm

            commands.push({
              type: 'flash',
              coordinate: { x: xMm, y: yMm },
              apertureCode: currentTool,
              regionMode: false,
              polarity: 'dark',
            })
          }
          continue
        }

        // Single-axis coordinate (X only or Y only — keep previous value for other axis)
        const singleXMatch = clean.match(/^X([+-]?\d*\.?\d*)$/i)
        if (singleXMatch) {
          const x = parseExcellonCoord(singleXMatch[1], fmtInt, fmtDec, declaredZeroSuppression, units)
          if (x !== null) {
            const xMm = units === 'mm' ? x : x * 25.4
            lastDrillX = xMm
            commands.push({
              type: 'flash',
              coordinate: { x: xMm, y: lastDrillY ?? undefined },
              apertureCode: currentTool,
              regionMode: false,
              polarity: 'dark',
            })
          }
          continue
        }

        const singleYMatch = clean.match(/^Y([+-]?\d*\.?\d*)$/i)
        if (singleYMatch) {
          const y = parseExcellonCoord(singleYMatch[1], fmtInt, fmtDec, declaredZeroSuppression, units)
          if (y !== null) {
            const yMm = units === 'mm' ? y : y * 25.4
            lastDrillY = yMm
            commands.push({
              type: 'flash',
              coordinate: { x: lastDrillX ?? undefined, y: yMm },
              apertureCode: currentTool,
              regionMode: false,
              polarity: 'dark',
            })
          }
          continue
        }
      }
    }
  }

  // Calculate bounds from flash commands
  const bounds = calculateBounds(commands, apertures)

  // Eagle workaround: detect Eagle-generated files that declare TZ but actually use LZ.
  // Eagle has a well-known bug where it writes METRIC,TZ but the coordinate data
  // uses leading zero omission. Detect this by checking if coordinates would be
  // wildly out of range when parsed as TZ — if so, re-parse as LZ.
  let actualZeroSuppression = declaredZeroSuppression
  if (declaredZeroSuppression === 'trailing' && commands.length > 0) {
    // Check a sample of coordinates to see if TZ interpretation gives values
    // that don't make sense for a typical PCB (anything > 500mm is suspicious).
    // Use a generous threshold to avoid false positives on large panels.
    let tzLikelyWrong = false
    const sampleSize = Math.min(commands.length, 20)
    for (let i = 0; i < sampleSize; i++) {
      const cmd = commands[i]
      if (cmd.coordinate.x !== undefined && Math.abs(cmd.coordinate.x) > 500) {
        tzLikelyWrong = true
        break
      }
      if (cmd.coordinate.y !== undefined && Math.abs(cmd.coordinate.y) > 500) {
        tzLikelyWrong = true
        break
      }
    }
    if (tzLikelyWrong) {
      // Re-parse all coordinates using LZ instead of TZ
      actualZeroSuppression = 'leading'
      warnings.push('Eagle TZ workaround: coordinates declared as TZ but actually use LZ — re-parsed')
      const newCommands: GerberDrawCommand[] = []
      // We need to re-derive from raw content, but since we already parsed once,
      // we can correct by re-interpreting: the TZ coords were padEnd, we need padStart.
      // For each command, re-extract the original coordinate from rawContent and parse as LZ.
      // Simpler: re-run body parsing with LZ suppression.
      const lzCommands = reparseExcellonBody(normalized, fmtInt, fmtDec, 'leading', units)
      if (lzCommands.length > 0) {
        newCommands.push(...lzCommands)
      }
      // Replace commands and recalculate bounds
      commands.length = 0
      commands.push(...newCommands)
    }
  }

  // Recalculate bounds after possible TZ→LZ correction
  const finalBounds = calculateBounds(commands, apertures)

  // Default format (3:3 metric) — not critical for drill layers
  const formatX: CoordinateFormat = { integer: 3, decimal: 3 }
  const formatY: CoordinateFormat = { integer: 3, decimal: 3 }

  return {
    fileName,
    rawContent: content,
    units: 'mm', // Always store in mm
    formatX,
    formatY,
    apertures,
    commands,
    regions: [],
    bounds: finalBounds,
    warnings,
  }
}

/**
 * Re-parse the Excellon body section with a specific zero suppression mode.
 * Used by the Eagle TZ workaround to re-interpret coordinates as LZ.
 */
function reparseExcellonBody(
  normalized: string,
  fmtInt: number,
  fmtDec: number,
  zeroSuppression: 'leading' | 'trailing',
  fileUnits: GerberUnit
): GerberDrawCommand[] {
  const lines = normalized.split('\n')
  const commands: GerberDrawCommand[] = []
  let inBody = false
  let currentTool: number | null = null
  let lastX: number | null = null
  let lastY: number | null = null

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) continue
    const clean = line.replace(/\*$/, '').trim()
    if (clean.startsWith(';')) continue

    if (clean.toUpperCase() === 'M48') { inBody = false; continue }
    if (clean === '%') { inBody = true; continue }
    if (clean.toUpperCase() === 'M30') break

    if (!inBody) {
      // Parse tool definitions for tool code tracking
      const toolMatch = clean.match(/^T(\d{1,2})C([\d.]+)/i)
      if (toolMatch) {
        // Tools already parsed in main pass — just skip
        continue
      }
      continue
    }

    // Body
    const upperClean = clean.toUpperCase()
    if (['G90', 'G91', 'G05', 'G81', 'G82', 'G83', 'G00', 'G01'].includes(upperClean)) continue

    // Tool select
    const toolSelectMatch = clean.match(/^T(\d{1,2})$/i)
    if (toolSelectMatch) {
      currentTool = parseInt(toolSelectMatch[1], 10)
      continue
    }

    // Coordinate hit
    if (clean.includes('X') || clean.includes('Y')) {
      const coordMatch = clean.match(/X([+-]?\d*\.?\d*)Y([+-]?\d*\.?\d*)/i)
      if (coordMatch) {
        const xRaw = coordMatch[1] || ''
        const yRaw = coordMatch[2] || ''
        const x = parseExcellonCoord(xRaw, fmtInt, fmtDec, zeroSuppression, fileUnits)
        const y = parseExcellonCoord(yRaw, fmtInt, fmtDec, zeroSuppression, fileUnits)
        if (x !== null && y !== null) {
          const xMm = fileUnits === 'mm' ? x : x * 25.4
          const yMm = fileUnits === 'mm' ? y : y * 25.4
          lastX = xMm
          lastY = yMm
          commands.push({
            type: 'flash',
            coordinate: { x: xMm, y: yMm },
            apertureCode: currentTool,
            regionMode: false,
            polarity: 'dark',
          })
        }
        continue
      }
      const singleXMatch = clean.match(/^X([+-]?\d*\.?\d*)$/i)
      if (singleXMatch) {
        const x = parseExcellonCoord(singleXMatch[1], fmtInt, fmtDec, zeroSuppression, fileUnits)
        if (x !== null) {
          const xMm = fileUnits === 'mm' ? x : x * 25.4
          lastX = xMm
          commands.push({
            type: 'flash',
            coordinate: { x: xMm, y: lastY ?? undefined },
            apertureCode: currentTool,
            regionMode: false,
            polarity: 'dark',
          })
        }
        continue
      }
      const singleYMatch = clean.match(/^Y([+-]?\d*\.?\d*)$/i)
      if (singleYMatch) {
        const y = parseExcellonCoord(singleYMatch[1], fmtInt, fmtDec, zeroSuppression, fileUnits)
        if (y !== null) {
          const yMm = fileUnits === 'mm' ? y : y * 25.4
          lastY = yMm
          commands.push({
            type: 'flash',
            coordinate: { x: lastX ?? undefined, y: yMm },
            apertureCode: currentTool,
            regionMode: false,
            polarity: 'dark',
          })
        }
        continue
      }
    }
  }

  return commands
}

/**
 * Parse a single Excellon coordinate value.
 *
 * Excellon coordinates are raw digit strings without decimal points,
 * interpreted using the format spec (integer:decimal digits) and
 * zero suppression mode (leading or trailing).
 *
 * @param raw - Raw digit string (may be empty)
 * @param intDigits - Number of integer digits in the format
 * @param decDigits - Number of decimal digits in the format
 * @param zeroSuppression - 'leading' or 'trailing'
 * @param units - 'mm' or 'inches' (for embedded-decimal detection)
 * @returns Parsed number, or null if empty/invalid
 */
function parseExcellonCoord(
  raw: string,
  intDigits: number,
  decDigits: number,
  zeroSuppression: 'leading' | 'trailing',
  units: GerberUnit
): number | null {
  if (!raw || raw.trim() === '') return null

  let digits = raw.trim()

  // Handle negative sign
  let negative = false
  if (digits.startsWith('-')) {
    negative = true
    digits = digits.substring(1)
  }
  if (digits.startsWith('+')) {
    digits = digits.substring(1)
  }

  // Handle embedded decimal point (some files include explicit decimals)
  if (digits.includes('.')) {
    const val = parseFloat(digits)
    return negative ? -val : val
  }

  const totalDigits = intDigits + decDigits

  // Apply zero suppression: pad accordingly
  let padded: string
  if (zeroSuppression === 'leading') {
    // Leading zero suppression: pad with LEADING zeros to fill totalDigits.
    // e.g. "16500" with 2:4 LZ → pad to 6 digits → "016500" → int=01, dec=6500 → 1.6500
    padded = digits.padStart(totalDigits, '0')
  } else {
    // Trailing zero suppression: pad with TRAILING zeros to fill totalDigits.
    // e.g. "16500" with 3:3 TZ → pad to 6 digits → "165000" → int=165, dec=000 → 165.000
    // NOTE: This is the standard Excellon TZ interpretation where trailing zeros
    // are removed and the remaining digits occupy the leftmost positions.
    padded = digits.padEnd(totalDigits, '0')
  }

  // Truncate if too many digits (keep most significant digits)
  if (padded.length > totalDigits) {
    padded = padded.substring(0, totalDigits)
  }

  // Split into integer and decimal parts
  const intPart = padded.substring(0, intDigits) || '0'
  const decPart = padded.substring(intDigits) || '0'

  const value = parseFloat(`${negative ? '-' : ''}${intPart}.${decPart}`)
  return isNaN(value) ? null : value
}

/**
 * Auto-detect the correct Excellon drill format by trying common format
 * combinations and selecting the one whose parsed bounds best match the
 * expected board dimensions.
 *
 * @param content - Raw Excellon file content
 * @param fileName - Source file name
 * @param boardWidth - Expected board width in mm
 * @param boardHeight - Expected board height in mm
 * @returns The best-matching DrillFormatOverride and re-parsed GerberLayer, or null if no good match
 */
export function autoDetectDrillFormat(
  content: string,
  fileName: string,
  boardWidth: number,
  boardHeight: number
): { format: DrillFormatOverride; parsed: GerberLayer } | null {
  const candidateFormats: DrillFormatOverride[] = [
    // Metric formats (most common for CAM350 bare METRIC)
    { unit: 'mm', integer: 3, decimal: 3, zeroSuppression: 'trailing' },
    { unit: 'mm', integer: 3, decimal: 3, zeroSuppression: 'leading' },
    { unit: 'mm', integer: 3, decimal: 2, zeroSuppression: 'trailing' },
    { unit: 'mm', integer: 3, decimal: 2, zeroSuppression: 'leading' },
    { unit: 'mm', integer: 3, decimal: 4, zeroSuppression: 'trailing' },
    { unit: 'mm', integer: 3, decimal: 4, zeroSuppression: 'leading' },
    { unit: 'mm', integer: 2, decimal: 3, zeroSuppression: 'trailing' },
    { unit: 'mm', integer: 2, decimal: 3, zeroSuppression: 'leading' },
    { unit: 'mm', integer: 2, decimal: 4, zeroSuppression: 'trailing' },
    { unit: 'mm', integer: 2, decimal: 4, zeroSuppression: 'leading' },
    // Inch formats
    { unit: 'inches', integer: 2, decimal: 4, zeroSuppression: 'leading' },
    { unit: 'inches', integer: 2, decimal: 4, zeroSuppression: 'trailing' },
    { unit: 'inches', integer: 2, decimal: 5, zeroSuppression: 'leading' },
    { unit: 'inches', integer: 2, decimal: 5, zeroSuppression: 'trailing' },
    { unit: 'inches', integer: 2, decimal: 3, zeroSuppression: 'leading' },
    { unit: 'inches', integer: 2, decimal: 3, zeroSuppression: 'trailing' },
  ]

  let bestFormat: DrillFormatOverride | null = null
  let bestError = Infinity
  let bestParsed: GerberLayer | null = null

  for (const fmt of candidateFormats) {
    try {
      const testParsed = parseExcellonDrill(content, fileName, fmt)
      if (!testParsed.bounds || testParsed.commands.length === 0) continue

      const b = testParsed.bounds
      // Commands are already in mm inside parseExcellonDrill
      const testWidth = b.maxX - b.minX
      const testHeight = b.maxY - b.minY

      // Skip obviously wrong interpretations (dimensions too small or too large)
      if (testWidth < 1 || testHeight < 1) continue
      if (testWidth > 2000 || testHeight > 2000) continue

      const errorX = Math.abs(testWidth - boardWidth) / boardWidth
      const errorY = Math.abs(testHeight - boardHeight) / boardHeight
      const totalError = errorX + errorY

      if (totalError < bestError) {
        bestError = totalError
        bestFormat = fmt
        bestParsed = testParsed
      }
    } catch {
      continue
    }
  }

  // Accept if total relative error is less than 50% (generous threshold to
  // allow for drill files that don't extend to the full board extents)
  if (bestFormat && bestParsed && bestError < 1.0) {
    console.log(`[autoDetectDrillFormat] Best: ${bestFormat.unit} ${bestFormat.integer}:${bestFormat.decimal} ${bestFormat.zeroSuppression} (err=${(bestError * 100).toFixed(1)}%)`)
    return { format: bestFormat, parsed: bestParsed }
  }

  return null
}

/**
 * Generate a "normalized" Excellon drill file string with explicit decimal
 * points in every coordinate. This eliminates all format ambiguity so that
 * any Excellon parser (including tracespace) can parse it correctly.
 *
 * The output always uses METRIC with explicit decimal coordinates like:
 *   X28.750Y4.250
 *
 * @param originalContent - The original raw Excellon file content
 * @param format - The detected format override that correctly interprets the coordinates
 * @returns A rewritten Excellon string with unambiguous decimal coordinates
 */
export function generateNormalizedExcellon(
  originalContent: string,
  format: DrillFormatOverride
): string {
  const normalized = originalContent.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const lines = normalized.split('\n')
  const output: string[] = []

  let inBody = false

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) { output.push(''); continue }

    const clean = line.replace(/\*$/, '').trim()

    // Skip comments
    if (clean.startsWith(';')) { output.push(clean); continue }

    // M48 header start
    if (clean.toUpperCase() === 'M48') {
      output.push('M48')
      continue
    }

    // Replace METRIC/INCH/format declarations in header with explicit METRIC
    if (!inBody) {
      const upper = clean.toUpperCase()

      // Replace any unit/format declaration with our explicit one
      if (upper === 'METRIC' || upper === 'INCH' ||
          /^(METRIC|INCH)\s*,\s*(TZ|LZ)/i.test(upper) ||
          /^(METRIC|INCH)\s*,\s*(TZ|LZ)\s*,/i.test(upper)) {
        output.push('METRIC')
        continue
      }

      // Keep tool definitions, VER, FMAT, DETECT, ATC, etc. as-is
      // Tool diameters are always in the declared unit — since the file says
      // METRIC, tool diameters are already in mm (e.g. T01C0.85 = 0.85mm)
      if (/^T\d+C/i.test(upper)) {
        // Tool definition — keep exactly as original (diameter is in file's
        // declared unit, which is the unit we'll declare in the output)
        output.push(clean)
        continue
      }

      if (upper.startsWith('VER') || upper.startsWith('FMAT') ||
          upper.startsWith('DETECT') || upper.startsWith('ATC') ||
          upper.startsWith('ICI') || upper.startsWith('G90') ||
          upper.startsWith('G70') || upper.startsWith('G71') ||
          upper.startsWith('FORMAT')) {
        // Skip format-related commands — we'll use explicit decimals
        continue
      }
    }

    // % — end of header
    if (clean === '%') {
      inBody = true
      output.push('%')
      continue
    }

    // M30 end
    if (clean.toUpperCase() === 'M30') {
      output.push('M30')
      break
    }

    if (!inBody) {
      output.push(clean)
      continue
    }

    // Body lines
    const upperClean = clean.toUpperCase()

    // Pass through G-codes, tool selects, etc.
    if (/^T\d{1,2}$/i.test(clean) || /^G\d{1,2}$/i.test(upperClean) ||
        /^R\d{1,2}/i.test(clean) || /^M\d{1,2}/i.test(clean)) {
      output.push(clean)
      continue
    }

    // Coordinate lines: rewrite X/Y values with explicit decimals
    if (clean.includes('X') || clean.includes('Y') || clean.includes('x') || clean.includes('y')) {
      let newLine = ''
      let remaining = clean

      // Process all X and Y values in the line
      const coordRegex = /([XY])([+-]?\d*\.?\d*)/gi
      let lastIndex = 0
      let match: RegExpExecArray | null

      // Reset lastIndex
      coordRegex.lastIndex = 0
      while ((match = coordRegex.exec(remaining)) !== null) {
        // Add any text before this match
        newLine += remaining.substring(lastIndex, match.index)

        const letter = match[1].toUpperCase()
        const rawValue = match[2]

        // Parse the coordinate using the detected format
        const parsed = parseExcellonCoord(rawValue, format.integer, format.decimal, format.zeroSuppression, format.unit)
        if (parsed !== null) {
          // Convert to mm if the format is inches
          const valueMm = format.unit === 'mm' ? parsed : parsed * 25.4
          // Write with explicit decimal, 4 decimal places
          newLine += `${letter}${valueMm.toFixed(4)}`
        } else {
          // Keep original if parsing failed
          newLine += match[0]
        }

        lastIndex = match.index + match[0].length
      }

      // Add any remaining text after the last match
      newLine += remaining.substring(lastIndex)
      output.push(newLine)
      continue
    }

    // Pass through anything else
    output.push(clean)
  }

  return output.join('\n')
}

/**
 * Extract unique D-code usage statistics from a GerberLayer.
 * Returns a map of aperture code to usage count.
 *
 * @param layer - The parsed Gerber layer
 * @returns Map of aperture code to number of times it was used
 */
export function getApertureUsageStats(layer: GerberLayer): Map<number, number> {
  const stats = new Map<number, number>();

  for (const cmd of layer.commands) {
    if (cmd.apertureCode !== null) {
      const current = stats.get(cmd.apertureCode) || 0;
      stats.set(cmd.apertureCode, current + 1);
    }
  }

  return stats;
}

/**
 * Count the number of commands by type in a GerberLayer.
 *
 * @param layer - The parsed Gerber layer
 * @returns An object with counts for each command type
 */
export function getCommandTypeStats(layer: GerberLayer): Record<CommandType, number> {
  const counts: Record<CommandType, number> = {
    move: 0,
    interpolate: 0,
    flash: 0,
    arc_cw: 0,
    arc_ccw: 0,
  };

  for (const cmd of layer.commands) {
    counts[cmd.type]++;
  }

  return counts;
}

/**
 * Rotates a GerberLayer by 90 degrees left (ccw) or right (cw).
 * Mutates the layer object in place.
 *
 * @param layer The layer to rotate
 * @param direction 'left' (-90) or 'right' (+90)
 */
export function rotateGerberLayer(layer: GerberLayer, direction: 'left' | 'right'): void {
  // 1. Rotate commands
  for (const cmd of layer.commands) {
    const x = cmd.coordinate.x
    const y = cmd.coordinate.y
    const i = cmd.coordinate.i
    const j = cmd.coordinate.j

    if (direction === 'right') { // Clockwise
      if (x !== undefined && y !== undefined) {
        cmd.coordinate.x = y
        cmd.coordinate.y = -x
      } else if (x !== undefined) {
        cmd.coordinate.y = -x
        cmd.coordinate.x = undefined
      } else if (y !== undefined) {
        cmd.coordinate.x = y
        cmd.coordinate.y = undefined
      }

      if (i !== undefined && j !== undefined) {
        cmd.coordinate.i = j
        cmd.coordinate.j = -i
      } else if (i !== undefined) {
        cmd.coordinate.j = -i
        cmd.coordinate.i = undefined
      } else if (j !== undefined) {
        cmd.coordinate.i = j
        cmd.coordinate.j = undefined
      }
    } else { // Counter-clockwise (left)
      if (x !== undefined && y !== undefined) {
        cmd.coordinate.x = -y
        cmd.coordinate.y = x
      } else if (x !== undefined) {
        cmd.coordinate.y = x
        cmd.coordinate.x = undefined
      } else if (y !== undefined) {
        cmd.coordinate.x = -y
        cmd.coordinate.y = undefined
      }

      if (i !== undefined && j !== undefined) {
        cmd.coordinate.i = -j
        cmd.coordinate.j = i
      } else if (i !== undefined) {
        cmd.coordinate.j = i
        cmd.coordinate.i = undefined
      } else if (j !== undefined) {
        cmd.coordinate.i = -j
        cmd.coordinate.j = undefined
      }
    }
  }

  // 2. Rotate apertures
  for (const ap of layer.apertures.values()) {
    if (ap.shape === 'rectangle' || ap.shape === 'obround') {
      // Swap width and height
      const temp = ap.width
      ap.width = ap.height
      ap.height = temp

      // Update rotation if present
      if (ap.rotation !== undefined) {
        ap.rotation = direction === 'right' ? ap.rotation - 90 : ap.rotation + 90
      }
    } else if (ap.shape === 'polygon') {
      if (ap.rotation !== undefined) {
        ap.rotation = direction === 'right' ? ap.rotation - 90 : ap.rotation + 90
      }
    }
  }

  // 3. Recompute bounds
  layer.bounds = calculateBounds(layer.commands, layer.apertures)
}

/**
 * Serialize a parsed GerberLayer (specifically a drill layer) back to a valid Excellon format.
 * The output uses explicit decimal coordinates in METRIC (millimetres), e.g. X12.3456Y78.9012.
 * This guarantees tracespace (and standard CAM tools) will parse it without scale/format ambiguity.
 */
export function serializeParsedDrillToExcellon(parsedLayer: GerberLayer): string {
  const lines: string[] = []
  lines.push('M48')
  lines.push('METRIC')

  // Collect unique tools from apertures
  const toolDefs: { code: number; diameter: number }[] = []
  for (const [code, apt] of parsedLayer.apertures.entries()) {
    // For drill layers, code is the tool number (e.g. 1, 2, 3)
    const diameter = apt.width || 0
    toolDefs.push({ code, diameter })
  }
  toolDefs.sort((a, b) => a.code - b.code)

  for (const tool of toolDefs) {
    const tCode = tool.code.toString().padStart(2, '0')
    lines.push(`T${tCode}C${tool.diameter.toFixed(4)}`)
  }

  // End of header
  lines.push('%')

  let currentTool: number | null = null

  // Emit coordinate commands
  for (const cmd of parsedLayer.commands) {
    if (cmd.apertureCode !== null && cmd.apertureCode !== currentTool) {
      currentTool = cmd.apertureCode
      const tCode = currentTool.toString().padStart(2, '0')
      lines.push(`T${tCode}`)
    }

    if (cmd.type === 'flash' && cmd.coordinate) {
      const x = cmd.coordinate.x !== undefined ? cmd.coordinate.x.toFixed(4) : ''
      const y = cmd.coordinate.y !== undefined ? cmd.coordinate.y.toFixed(4) : ''
      if (x !== '' && y !== '') {
        lines.push(`X${x}Y${y}`)
      } else if (x !== '') {
        lines.push(`X${x}`)
      } else if (y !== '') {
        lines.push(`Y${y}`)
      }
    }
  }

  // End of program
  lines.push('M30')

  return lines.join('\n')
}

