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

/**
 * A milled slot from an Excellon G85 canned slot cycle — `X<start>Y<start>
 * G85X<end>Y<end>` mills a slot between two points at the current tool's
 * diameter (the tool IS the slot width; no separate cutter-offset math is
 * needed the way the depaneling router needs one). Kept OUT of `commands`
 * deliberately: every existing consumer that walks `commands` looking for
 * `type === 'flash'` (hole counting, drill-alignment pad matching, DFM
 * unlanded-hole checks, the panelized-drill-file/G-code hole collectors)
 * means "a single drilled point with a matching copper pad" — folding a
 * two-point slot into that stream would silently corrupt all of them rather
 * than just being ignored by ones that don't care about slots yet.
 */
export interface DrillSlot {
  start: { x: number; y: number };
  end: { x: number; y: number };
  /** Excellon tool number (T-code) this slot was cut with. */
  toolCode: number;
  /** Tool diameter in mm — the slot's width. */
  diameterMm: number;
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
  /** Resolved Excellon format + stats. Only set for drill layers. */
  drillMeta?: DrillMeta;
  /** Milled slots (Excellon G85). Only set for drill layers, and only when
   *  the file actually contains any — see `DrillSlot`'s own docs for why
   *  these are tracked separately from `commands`. */
  drillSlots?: DrillSlot[];
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

  /**
   * G74 (single-quadrant) vs G75 (multi-quadrant) arc mode. In single-
   * quadrant mode I/J are UNSIGNED magnitudes and the true center must be
   * disambiguated (see `resolveSingleQuadrantIJ`) — every arc command
   * built while this is 'single' has its i/j resolved to the canonical
   * SIGNED multi-quadrant form before being stored, so nothing downstream
   * (the exporter, which always declares G75, DFM, routing) ever needs to
   * know this mode existed. Defaults to 'multi' per the RS-274X default,
   * though real files nearly always declare one explicitly.
   */
  quadrantMode: 'single' | 'multi' = 'multi';

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

  // Aperture macro names may contain digits/underscores after the first letter
  // (e.g. KiCad's "FreePoly0") — a letters-only match truncates the name and
  // spills the trailing digit into the parameter string, corrupting $1.
  // They may also contain hyphens: CAM350/DFMSTREAM re-exports give every
  // macro-based aperture its own fully-instantiated, per-D-code macro name
  // (e.g. "RoundRect-D12", "RoundRect-D18", ... one per pad, with the
  // corner coordinates baked directly into the %AM block instead of KiCad's
  // single shared parameterized macro) — `extractMacroDefinitions` in
  // panelization-engine.ts already accepts hyphens for exactly this reason,
  // but this regex didn't, so it truncated "RoundRect-D12" down to
  // "RoundRect" here. The re-exported %ADD line then referenced a macro
  // name that was never defined (only "RoundRect-D12" etc. exist as real
  // %AM blocks) — surfacing as CAM350's own "Undefined apertures are used"
  // on re-import, confirmed on a real CAM350/DFMSTREAM V14.6 export.
  const shapeMatch = body.match(/^([A-Za-z][A-Za-z0-9_-]*)/);
  if (!shapeMatch) {
    state.warnings.push(`Malformed aperture definition: missing shape in "${data}"`);
    return;
  }

  const shapeStrRaw = shapeMatch[1];
  const shapeStr = shapeStrRaw.toUpperCase();
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
      // Anything else is treated as an aperture macro reference. Macro names are
      // case-sensitive (must match the %AM definition's name exactly) — preserve
      // the original casing here, or exported %ADD lines referencing this macro
      // silently fail to resolve in strict parsers (tracespace, CAM350) even
      // though our own AM-block extraction copies the definition verbatim.
      shape = 'macro';
      isMacro = true;
      macroName = shapeStrRaw;
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

/**
 * Resolve a G74 (single-quadrant) arc's UNSIGNED I/J into the canonical
 * SIGNED multi-quadrant form every downstream consumer (the exporter, which
 * always declares G75; DFM; routing) already assumes.
 *
 * In single-quadrant mode, I/J give only the MAGNITUDE of the center offset
 * from the arc's start point — the true signed offset is one of 4
 * candidates (±I, ±J), and per spec must be the one that (a) places the
 * center equidistant from both the start and end point (a real circle) and
 * (b) sweeps ≤90° in the command's own direction (the "single quadrant"
 * restriction). Re-emitting the raw unsigned magnitudes under a
 * self-declared G75 header — which is what this codebase's exporter always
 * does — makes a real viewer solve for the WRONG candidate (start-radius
 * only, ignoring the end point), producing a mathematically inconsistent
 * arc: confirmed on a real G74 source file where the naive (+I,+J)
 * reading gives mismatched start/end radii (944.1 vs 924.0) while the
 * correct (−I,+J) reading matches exactly (944.1 vs 944.0) — the visible
 * symptom is silkscreen/copper circles and pad fillets rendering distorted.
 *
 * @returns the resolved {i, j}, signed and ready to store as-is
 */
function resolveSingleQuadrantIJ(
  startX: number, startY: number, endX: number, endY: number,
  iMag: number, jMag: number, direction: 'arc_cw' | 'arc_ccw'
): { i: number; j: number } {
  const iAbs = Math.abs(iMag);
  const jAbs = Math.abs(jMag);
  const candidates = [
    { i: iAbs, j: jAbs },
    { i: iAbs, j: -jAbs },
    { i: -iAbs, j: jAbs },
    { i: -iAbs, j: -jAbs },
  ];

  function radiusError(c: { i: number; j: number }): number {
    const cx = startX + c.i;
    const cy = startY + c.j;
    const r1 = Math.hypot(startX - cx, startY - cy);
    const r2 = Math.hypot(endX - cx, endY - cy);
    return Math.abs(r1 - r2);
  }

  function sweepDeg(c: { i: number; j: number }): number {
    const cx = startX + c.i;
    const cy = startY + c.j;
    const a1 = Math.atan2(startY - cy, startX - cx);
    const a2 = Math.atan2(endY - cy, endX - cx);
    let sweep = direction === 'arc_ccw' ? a2 - a1 : a1 - a2;
    if (sweep < 0) sweep += 2 * Math.PI;
    return sweep * 180 / Math.PI;
  }

  // Prefer the best radius match among candidates that actually satisfy the
  // single-quadrant (≤90°) restriction; only fall back to ignoring that
  // restriction (picking the overall best radius match) on a malformed file
  // where no candidate qualifies, so a bad file still produces a plausible
  // arc rather than aborting the parse.
  let best: { i: number; j: number } | null = null;
  let bestErr = Infinity;
  for (const c of candidates) {
    if (sweepDeg(c) > 90 + 1e-6) continue;
    const err = radiusError(c);
    if (err < bestErr) { bestErr = err; best = c; }
  }
  if (!best) {
    for (const c of candidates) {
      const err = radiusError(c);
      if (err < bestErr) { bestErr = err; best = c; }
    }
  }
  return best ?? { i: iAbs, j: jAbs };
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

  // G74 — Single quadrant arc mode (I/J are unsigned; see `quadrantMode`)
  if (trimmed.includes('G74')) {
    state.quadrantMode = 'single';
  }

  // G75 — Multi quadrant arc mode (I/J are signed; the RS-274X default)
  if (trimmed.includes('G75')) {
    state.quadrantMode = 'multi';
  }

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
  // ⚠ Must NOT cap the digit count. Aperture-select D-codes routinely run into
  // 3+ digits on any real board with more than ~90 distinct apertures (a
  // `\d{1,2}` cap, as this had, silently fails to match D100+ entirely —
  // confirmed on a real customer mask layer with 546 defined apertures and
  // explicit `G54D549*`/`G54D494*` selections: those selections matched
  // nothing, fell through to the "omitted D-code" branch, and inherited
  // whatever 2-digit aperture was last correctly recognized instead —
  // collapsing dozens of intended aperture sizes down to a handful and
  // reading as "every D-code looks the same" once opened in a real viewer.
  const dcodeMatch = trimmed.match(/D(\d+)\s*$/);
  const dcode = dcodeMatch ? parseInt(dcodeMatch[1], 10) : null;

  if (dcode === 1 || dcode === 2 || dcode === 3) {
    state.lastDCode = dcode;
  }

  if (dcode === 1) {
    // D01 — Interpolate (draw with current aperture)
    const coords = extractCoordinates(block);
    const x = state.parseCoordinateValue(coords.x, 'x');
    const y = state.parseCoordinateValue(coords.y, 'y');
    let i = state.parseCoordinateValue(coords.i, 'ij');
    let j = state.parseCoordinateValue(coords.j, 'ij');

    const prevX = state.currentX;
    const prevY = state.currentY;
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

    // G74 (single-quadrant) arcs carry UNSIGNED I/J — resolve to the
    // canonical signed multi-quadrant form once, here, so every downstream
    // consumer (the exporter, which always declares G75) can treat i/j as
    // already-correct. See resolveSingleQuadrantIJ's own docs.
    if (state.quadrantMode === 'single' && i !== undefined && j !== undefined &&
        (state.interpolationMode === 'arc_cw' || state.interpolationMode === 'arc_ccw') &&
        prevX !== null && prevY !== null) {
      const resolved = resolveSingleQuadrantIJ(
        prevX, prevY, state.currentX ?? prevX, state.currentY ?? prevY,
        i, j, state.interpolationMode
      );
      i = resolved.i;
      j = resolved.j;
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
      let i = state.parseCoordinateValue(coords.i, 'ij');
      let j = state.parseCoordinateValue(coords.j, 'ij');

      const prevX = state.currentX;
      const prevY = state.currentY;
      if (x !== undefined) state.currentX = x;
      if (y !== undefined) state.currentY = y;

      if (activeDCode === 1) {
        // Inherited D01 (Interpolate)
        if ((state.interpolationMode === 'arc_cw' || state.interpolationMode === 'arc_ccw') &&
            i === undefined && j === undefined) {
          state.interpolationMode = 'interpolate';
          state.warnings.push('Circular interpolation lacks I and J parameters. Assuming G01 (Linear) mode for this and subsequent commands.');
        }

        // Same G74 single-quadrant I/J disambiguation as the explicit-D01
        // branch above — see resolveSingleQuadrantIJ's docs.
        if (state.quadrantMode === 'single' && i !== undefined && j !== undefined &&
            (state.interpolationMode === 'arc_cw' || state.interpolationMode === 'arc_ccw') &&
            prevX !== null && prevY !== null) {
          const resolved = resolveSingleQuadrantIJ(
            prevX, prevY, state.currentX ?? prevX, state.currentY ?? prevY,
            i, j, state.interpolationMode
          );
          i = resolved.i;
          j = resolved.j;
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

/**
 * Widen a bounds box to also cover a set of drill slots (start/end ± tool
 * radius each). Slots live outside `commands` (see `DrillSlot`'s own docs),
 * so `calculateBounds` never sees them on its own — every caller that
 * recomputes bounds for a drill layer with slots must fold this in, or a
 * board whose only geometry is a slot (or whose slot pokes past its other
 * holes) panelizes with a bounding box too small to actually contain it.
 */
export function expandBoundsForSlots(bounds: GerberBounds | null, slots: DrillSlot[]): GerberBounds | null {
  if (slots.length === 0) return bounds;
  let { minX, minY, maxX, maxY } = bounds ?? {
    minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity,
  };
  for (const slot of slots) {
    const r = slot.diameterMm / 2;
    for (const pt of [slot.start, slot.end]) {
      minX = Math.min(minX, pt.x - r);
      maxX = Math.max(maxX, pt.x + r);
      minY = Math.min(minY, pt.y - r);
      maxY = Math.max(maxY, pt.y + r);
    }
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

    // Macro aperture modifiers ($1, $2, ...) are NOT covered by width/height/
    // holeDiameter above — those stay undefined for a macro shape, so a
    // macro's real size lives entirely in `parameters`. Confirmed as a real,
    // shipped bug on a real EAGLE export: its octagon pad macro (`OC8`,
    // `5,1,8,0,0,1.08239x$1,22.5*`) declares `%ADD17OC8,0.052000*%` under
    // `%MOIN*%` (inches) — $1=0.052in is the pad's true width. Import
    // converts the file to mm for our internal mm-only pipeline but left $1
    // untouched, so the exported panel re-declared `%MOMM*%` while $1 was
    // still 0.052 — now read as 0.052mm, a pad 25.4x too small to see. The
    // original upload (rendered straight from its own pristine raw content,
    // never through this conversion) and our canvas (same) looked correct;
    // only the exported Gerber, serialized from this converted layer, broke.
    if (ap.shape === 'macro' && ap.parameters) {
      if (/RoundRect/i.test(ap.macroName ?? '')) {
        // $1 (corner radius) and $2..$9 (4 corner x,y pairs) are lengths and
        // must scale; a trailing $10 some KiCad versions emit is a rotation
        // angle (unit-independent) and must NOT scale — same enumeration
        // rotateGerberLayer/mirrorGerberLayerX already use for this macro.
        for (const key of ['$1', '$2', '$3', '$4', '$5', '$6', '$7', '$8', '$9']) {
          if (ap.parameters[key] !== undefined) ap.parameters[key] *= factor;
        }
      } else {
        // An arbitrary macro's modifier layout isn't known without parsing
        // its %AM body (the same documented gap the rotate/mirror code has),
        // but every real one seen so far (EAGLE's OC8 above; single- or
        // multi-modifier size macros generally) uses its modifiers purely as
        // length dimensions, never as a bare angle/count. Scaling all of
        // them is the correct fix for the confirmed bug above and the safer
        // default versus leaving them unconverted, which is guaranteed wrong
        // for this shape family.
        for (const key of Object.keys(ap.parameters)) {
          ap.parameters[key] *= factor;
        }
      }
    }
  }

  // Drill slots (Excellon G85) live outside `commands` — see `DrillSlot`'s
  // own docs — so they need their own conversion pass, or a drill layer's
  // slots would silently go stale (wrong scale) relative to its now-
  // converted holes the next time this function actually runs a real
  // conversion (normally a no-op here since drill layers are always parsed
  // straight to mm, but this must stay correct regardless of that).
  if (layer.drillSlots) {
    for (const slot of layer.drillSlots) {
      slot.start.x *= factor; slot.start.y *= factor;
      slot.end.x *= factor; slot.end.y *= factor;
      slot.diameterMm *= factor;
    }
  }

  // Recalculate bounds
  layer.bounds = expandBoundsForSlots(calculateBounds(layer.commands, layer.apertures), layer.drillSlots ?? []);

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

  // 3. Hard negative: RS-274X extended commands only ever appear in Gerber.
  // Checked before the looser positive signals below (M30/M00/G90) so a Gerber
  // layer can never be misrouted into the drill parser.
  if (/%FSLAX/i.test(stripped) || /%ADD\d/i.test(stripped) || /%MO(MM|IN)\*%/i.test(stripped)) {
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
  // Allegro/Altium drill files may omit M48 entirely. These markers are safe
  // now that the Gerber hard-negative above has run: M30 (Excellon end-of-
  // program; Gerber uses M02), M00 (manual tool change), and absolute-mode
  // G90 paired with real coordinates.
  const upperAll = stripped.toUpperCase()
  if (/^M30\b/m.test(upperAll) || /^M00\b/m.test(upperAll)) return true
  if (/^G90\b/m.test(upperAll) && hasCoordinates && hasTools) return true
  if (/^;\s*(HOLESIZE|FILE_FORMAT)/im.test(stripped)) return true
  return false
}

/**
 * How zero suppression is encoded in an Excellon coordinate field.
 *
 * - 'leading'  — leading zeros were suppressed; pad left to restore.
 * - 'trailing' — trailing zeros were suppressed; pad right to restore.
 * - 'none'     — coordinates are written full fixed-width; nothing to restore.
 *
 * NOTE: this is the *parser* convention ("which zeros were removed"). The
 * exporter's `DrillZeroSuppression` in panelization-engine.ts uses the
 * OPPOSITE convention on purpose (CAM350 inverts LZ/TZ) — see the comment on
 * `formatDrillCoordinate`. Do not unify the two without testing in CAM350.
 */
export type DrillZeroSuppressionMode = 'none' | 'leading' | 'trailing'

export interface DrillFormatOverride {
  unit: GerberUnit
  integer: number
  decimal: number
  zeroSuppression: DrillZeroSuppressionMode
}

/** Resolved Excellon format + stats for a parsed drill layer, for display in the UI. */
export interface DrillMeta {
  unit: GerberUnit
  integerDigits: number
  decimalDigits: number
  zeroSuppression: DrillZeroSuppressionMode
  /** Where the format came from. 'auto-detect' is stamped by the store, not the parser. */
  source: 'header' | 'default' | 'override' | 'auto-detect'
  toolCount: number
  hitCount: number
  /** True when the Eagle TZ→LZ workaround re-interpreted the declared suppression. */
  eagleTzCorrected?: boolean
  /**
   * True when `source: 'header'` was actually a content-shape heuristic
   * (Altium 9+-digit, Allegro "Holesize" without FILE_FORMAT) rather than a
   * real declaration in the file. store.ts's initial SVG render always feeds
   * raw upload content through tracespace's own, independent Excellon
   * parsing — tracespace has no idea about either heuristic, so it makes its
   * own (uncoordinated, possibly differently wrong) guess at the same
   * ambiguous digits. Callers that render from raw content should check this
   * flag and re-render from our own normalized, explicit-decimal
   * serialization instead of trusting tracespace's guess.
   */
  formatGuessedFromContent?: boolean
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
  let declaredZeroSuppression: DrillZeroSuppressionMode = forceFormat ? forceFormat.zeroSuppression : 'leading'
  /** True once the file's own header declared a unit/format (not just our default). */
  let formatFromHeader = false
  /**
   * True only for the two heuristics below (Altium 9+-digit, Allegro
   * "Holesize"-without-FILE_FORMAT) that infer the format from the shape of
   * the coordinate DATA itself, as opposed to an explicit declaration
   * (FORMAT=, METRIC/INCH,TZ|LZ, M71/M72, a real FILE_FORMAT comment). Both
   * also set `formatFromHeader = true` so the rest of the parser treats them
   * as settled — this flag exists purely so callers who render from raw file
   * content (tracespace has its own independent Excellon interpretation, and
   * has no idea about either heuristic) know to re-render from our own
   * corrected, explicit-decimal serialization instead of trusting tracespace's
   * uncoordinated guess at the same ambiguous digits.
   */
  let formatGuessedFromContent = false
  /** Whether an M48 header block was ever opened. */
  let sawM48 = false
  /** Collect at most one 'none'-mode width warning so a big file can't spam. */
  let widthWarningIssued = false
  const warnOnce = (msg: string) => {
    if (widthWarningIssued) return
    widthWarningIssued = true
    warnings.push(msg)
  }
  let currentTool: number | null = null
  let inBody = false
  let lastDrillX: number | null = null
  let lastDrillY: number | null = null
  const slots: DrillSlot[] = []

  // Altium: exports 9+ digit coordinates with no format declaration, which
  // would otherwise decode against the 2.4 default and land wildly off-board.
  // Detect the long fields up-front and switch to 5.5 metric. Skipped when the
  // caller forced a format — an explicit choice always wins.
  if (!forceFormat) {
    const longCoord = /[XY][+-]?(\d{9,})(?![\d.])/.exec(normalized)
    if (longCoord && fmtInt === 2 && fmtDec === 4) {
      fmtInt = 5
      fmtDec = 5
      units = 'mm'
      formatFromHeader = true
      formatGuessedFromContent = true
      warnings.push('Detected 9+ digit coordinates with no format header — assuming 5.5 metric (Altium).')
    }
  }

  // Allegro "Holesize" header dialect (PentaLogix ViewMaster/CAM350-adjacent
  // exports of a .brd design): the header lists hole sizes and declares "MM"
  // per line, but — unlike the Allegro exports this parser already handles —
  // never emits a ";FILE_FORMAT=" comment, so the digit width is never stated
  // anywhere. Observed real files always pad to 8 fixed-width digits with no
  // suppression; defaulting to 2.4 truncates the two most-significant digits
  // off every coordinate (e.g. "07587580" -> last 6 digits "587580" -> a wrong
  // 58.758mm instead of the correct 75.8758mm), silently moving every hole and
  // producing negative bounds on a board with no negative coordinates.
  // Confirmed against a real board pair (drill file + matching .rou route
  // file): the route file's own ";EXTENTS:" comment (in mils) gave a clean
  // 6.000in x 6.000in = 152.4mm square, and only a 3.5 split lands every
  // coordinate inside that footprint — 2.4 (or any split reusing the 8 raw
  // digits under a shorter total width) does not.
  if (!forceFormat && !formatFromHeader && /;\s*Holesize\s*\d+\..*MM/i.test(normalized)) {
    const eightDigit = /[XY][+-]?(\d{8})(?![\d.])/.exec(normalized)
    if (eightDigit && fmtInt === 2 && fmtDec === 4) {
      fmtInt = 3
      fmtDec = 5
      units = 'mm'
      formatFromHeader = true
      formatGuessedFromContent = true
      warnings.push('Detected Allegro "Holesize" header with 8-digit coordinates and no FILE_FORMAT comment — assuming 3.5 metric.')
    }
  }

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) continue

    // Remove trailing * from data blocks
    const clean = line.replace(/\*$/, '').trim()

    // Comments. Allegro puts its tool table and coordinate format ONLY in
    // comments, so those must be read before the rest are skipped.
    if (clean.startsWith(';')) {
      if (!forceFormat) {
        const holeSizeMatch = clean.match(/;\s*Holesize\s*(\d+)\.\s*=\s*([\d.]+)/i)
        if (holeSizeMatch) {
          const code = parseInt(holeSizeMatch[1], 10)
          const dia = parseFloat(holeSizeMatch[2])
          if (/MM/i.test(clean)) units = 'mm'
          if (dia > 0) apertures.set(code, { code, shape: 'circle', width: dia })
        }

        const fileFormatMatch = clean.match(/;\s*FILE_FORMAT\s*=\s*(\d+)\s*:\s*(\d+)/i)
        if (fileFormatMatch) {
          fmtInt = parseInt(fileFormatMatch[1], 10)
          fmtDec = parseInt(fileFormatMatch[2], 10)
          formatFromHeader = true
        }
      }
      continue
    }

    // M48 — Start of header
    if (clean.toUpperCase() === 'M48') {
      inBody = false
      sawM48 = true
      continue
    }

    // % — End of header, start of body. But some Protel/OrCAD exports (no
    // M48 at all) open the file with a bare '%' as a vestigial/placeholder
    // marker BEFORE the tool table, not after a real header — e.g.
    // "%\nT2C0.039F200S100\nX000850Y004600\n...". Treating that leading '%'
    // as end-of-header flips inBody=true before any tool def is read, so
    // every T<n>C<dia> line that follows falls into body-parsing (which
    // doesn't recognize tool defs) and is silently dropped — hole POSITIONS
    // still parse fine via the body X/Y branch, but every hole ends up with
    // no diameter (toolCount 0, apertures empty). Only honor '%' as ending a
    // real header — one that actually opened via M48 or already yielded at
    // least one tool/format token; otherwise it's a no-op and header parsing
    // (including the tool-def regex below) continues, exactly as if this
    // line were blank.
    if (clean === '%') {
      if (sawM48 || apertures.size > 0 || formatFromHeader) {
        inBody = true
      }
      continue
    }

    // M30 — End program
    if (clean.toUpperCase() === 'M30') {
      break
    }

    // Headerless drill files (Allegro, and Altium's plain .txt) carry no M48/%
    // pair, so `inBody` would never flip and every coordinate would be swallowed
    // by the header branch. Once we see a body-only command in a file that never
    // opened an M48 block, switch to body parsing.
    if (!inBody && !sawM48 && (
      /^G9[01]\b/i.test(clean) ||
      /^[XY][+-]?[\d.]/i.test(clean) ||
      /^M00\b/i.test(clean) ||
      /^R\d/i.test(clean)
    )) {
      inBody = true
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

      // M71 / M72 — metric / inch mode (may even precede M48). Declares the
      // unit only; digits and zero suppression remain assumptions, so this
      // deliberately does NOT set formatFromHeader (the suppression
      // plausibility check below must still be allowed to run).
      if (clean.toUpperCase() === 'M71') {
        if (!forceFormat) { units = 'mm'; fmtInt = 3; fmtDec = 3 }
        continue
      }
      if (clean.toUpperCase() === 'M72') {
        if (!forceFormat) { units = 'inches'; fmtInt = 2; fmtDec = 4 }
        continue
      }

      // FORMAT=/1:4 or FMT /1:4 style
      const fmtMatch = clean.match(/FORMAT\s*=\s*(\d)\s*:\s*(\d)/i) || clean.match(/FMT\s*\/(\d):(\d)/i)
      if (fmtMatch) {
        if (!forceFormat) {
          fmtInt = parseInt(fmtMatch[1], 10)
          fmtDec = parseInt(fmtMatch[2], 10)
          formatFromHeader = true
        }
        continue
      }

      // METRIC/INCH with embedded format: METRIC,TZ,000.000 or METRIC,LZ,000.000
      const metMatch = clean.match(/^(METRIC|INCH)\s*,\s*(TZ|LZ)\s*,\s*(0+)\.(0+)/i)
      if (metMatch) {
        if (!forceFormat) {
          formatFromHeader = true
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
          formatFromHeader = true
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

      // Bare METRIC or INCH — no suppression suffix means fixed-width coords.
      // ⚠ This is OUR assumption about the digit width (3:3 / 2:4), not
      // something the file actually states — a bare "METRIC"/"INCH" token
      // declares only the unit, nothing about integer/decimal digit counts
      // or suppression. Despite `formatFromHeader = true` (it settles the
      // question for OUR OWN parse), this must also set
      // `formatGuessedFromContent` so `drillSvgSourceContent` (store.ts)
      // renders the on-screen preview from our own corrected serialization
      // instead of leaving tracespace to independently guess at the same
      // ambiguous digits. Confirmed on a real CAM350/DFMSTREAM export (bare
      // METRIC, no LZ/TZ, no explicit decimals): our parse correctly landed
      // in the same coordinate range as the board's own outline layer, but
      // tracespace's own independent Excellon interpretation of the raw
      // upload put the drill holes an order of magnitude smaller and
      // shifted near the origin — a completely disjoint coordinate range
      // from every other layer. Unioning that into the Board view's overall
      // bounds (used whenever the traced outline itself is untrustworthy)
      // inflated the visible board footprint several times over, even
      // though the actual panelization math (which uses our own parse) was
      // correct the whole time.
      if (clean.toUpperCase() === 'METRIC') {
        if (!forceFormat) {
          formatFromHeader = true
          formatGuessedFromContent = true
          units = 'mm'
          fmtInt = 3
          fmtDec = 3
          declaredZeroSuppression = 'none'
        }
        continue
      }
      if (clean.toUpperCase() === 'INCH') {
        if (!forceFormat) {
          formatFromHeader = true
          formatGuessedFromContent = true
          units = 'inches'
          fmtInt = 2
          fmtDec = 4
          declaredZeroSuppression = 'none'
        }
        continue
      }

      // Tool definition: T01C0.8, T01C0.8F200S100, or T1F00S00C0.024 —
      // feed (F), speed (S), retract (B) and hit-count (H) parameters may
      // appear BEFORE the diameter. Requiring C immediately after the tool
      // number silently dropped every tool in such files (toolCount 0).
      const toolMatch = clean.match(/^T(\d{1,2})(?:[FSBH][\d.]+)*C([\d.]+)/i)
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
        // Also select it. Harmless for the standard "declare every tool in
        // the header, select by bare T<n> in the body" convention (the
        // body's own select overwrites this before any flash is emitted)
        // — but load-bearing for the interleaved definition+select dialect
        // (see the body-mode toolDefInBodyMatch below): the FIRST such line
        // in a file with no M48 is always read here, still in header mode,
        // one line before the headerless-auto-detect heuristic ever flips
        // to body parsing. Without this, that tool is never actually
        // selected, and its holes silently inherit whatever `currentTool`
        // fallback the first coordinate line defaults to instead (observed:
        // every hole of the FIRST declared tool misattributed to a
        // different tool's diameter).
        currentTool = code
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

      // M00 — manual tool change stop (Allegro). Advances to the next tool.
      if (upperClean === 'M00' || upperClean.startsWith('M00 ')) {
        currentTool = currentTool !== null ? currentTool + 1 : 1
        continue
      }

      // R<count>[X<dx>][Y<dy>] — Excellon step-and-repeat: stamp `count` more
      // hits, each offset by (dx, dy) from the previous. Used by Allegro/Altium
      // for connector rows. Previously this was warned about and skipped.
      const repeatMatch = clean.match(/^R(\d+)(.*)$/i)
      if (repeatMatch) {
        const count = parseInt(repeatMatch[1], 10)
        const rest = repeatMatch[2] || ''
        const xMatch = rest.match(/X([+-]?\d*\.?\d*)/i)
        const yMatch = rest.match(/Y([+-]?\d*\.?\d*)/i)

        const dxRaw = xMatch ? parseExcellonCoord(xMatch[1], fmtInt, fmtDec, declaredZeroSuppression, units, warnOnce) : null
        const dyRaw = yMatch ? parseExcellonCoord(yMatch[1], fmtInt, fmtDec, declaredZeroSuppression, units, warnOnce) : null
        const dx = dxRaw === null ? 0 : (units === 'mm' ? dxRaw : dxRaw * 25.4)
        const dy = dyRaw === null ? 0 : (units === 'mm' ? dyRaw : dyRaw * 25.4)

        if (count > 0 && lastDrillX !== null && lastDrillY !== null && (dx !== 0 || dy !== 0)) {
          for (let i = 1; i <= count; i++) {
            commands.push({
              type: 'flash',
              coordinate: { x: lastDrillX + i * dx, y: lastDrillY + i * dy },
              apertureCode: currentTool,
              regionMode: false,
              polarity: 'dark',
            })
          }
          lastDrillX += count * dx
          lastDrillY += count * dy
        } else {
          warnings.push(`Repeat command "${clean}" could not be expanded (no prior hit or zero step)`)
        }
        continue
      }

      // Tool select: T01 or T01 (no C)
      const toolSelectMatch = clean.match(/^T(\d{1,2})$/i)
      if (toolSelectMatch) {
        currentTool = parseInt(toolSelectMatch[1], 10)
        continue
      }

      // Tool select that ALSO (re)declares its diameter mid-body —
      // "T2C0.039F200S100" — rather than the usual header-declares-all /
      // body-selects-by-bare-number convention. Some Protel/OrCAD exports
      // (no M48 at all) interleave a full definition+select line directly
      // in front of that tool's own block of hits instead of ever using a
      // bare "T01" select. The header-side tool-def match above only runs
      // while still in header mode, so once body parsing starts (as it does
      // here, well before a later tool like T3/T4 is reached) these lines
      // would otherwise match nothing at all — silently leaving every hole
      // drilled under that tool with `apertureCode: null` (no diameter).
      const toolDefInBodyMatch = clean.match(/^T(\d{1,2})(?:[FSBH][\d.]+)*C([\d.]+)/i)
      if (toolDefInBodyMatch) {
        const code = parseInt(toolDefInBodyMatch[1], 10)
        const dia = parseFloat(toolDefInBodyMatch[2])
        if (dia > 0 && !apertures.has(code)) {
          apertures.set(code, { code, shape: 'circle', width: dia })
        }
        currentTool = code
        continue
      }

      // G85 canned slot cycle: X<start>Y<start>G85X<end>Y<end> — a slot milled
      // between two points at the current tool's diameter, not a single point
      // hole. Must be checked BEFORE the generic coordinate-hit match below,
      // which greedily captures only the digits immediately after each axis
      // letter: on a G85 line it would silently keep just the start X/Y and
      // drop everything from "G85" onward, turning a slot into a round hole
      // at the wrong (start-only) position with no warning at all.
      const slotMatch = clean.match(/X([+-]?\d*\.?\d*)Y([+-]?\d*\.?\d*)G85X([+-]?\d*\.?\d*)Y([+-]?\d*\.?\d*)/i)
      if (slotMatch) {
        if (currentTool === null) {
          currentTool = 1
          warnings.push('No tool selected before first drill slot — defaulting to T01')
        }
        const [, sx, sy, ex, ey] = slotMatch
        const startXRaw = parseExcellonCoord(sx, fmtInt, fmtDec, declaredZeroSuppression, units, warnOnce)
        const startYRaw = parseExcellonCoord(sy, fmtInt, fmtDec, declaredZeroSuppression, units, warnOnce)
        const endXRaw = parseExcellonCoord(ex, fmtInt, fmtDec, declaredZeroSuppression, units, warnOnce)
        const endYRaw = parseExcellonCoord(ey, fmtInt, fmtDec, declaredZeroSuppression, units, warnOnce)
        if (startXRaw !== null && startYRaw !== null && endXRaw !== null && endYRaw !== null) {
          const toMm = (v: number) => (units === 'mm' ? v : v * 25.4)
          const startX = toMm(startXRaw)
          const startY = toMm(startYRaw)
          const endX = toMm(endXRaw)
          const endY = toMm(endYRaw)
          // Diameter resolved after the full tool table is known (aperture
          // widths get their own inch→mm conversion pass further down) — 0
          // here is a placeholder, corrected in that same pass.
          slots.push({ start: { x: startX, y: startY }, end: { x: endX, y: endY }, toolCode: currentTool, diameterMm: 0 })
          lastDrillX = endX
          lastDrillY = endY
        }
        continue
      }

      // Coordinate hit: X...Y...
      if (clean.includes('X') || clean.includes('Y')) {
        // Some files (notably Allegro) emit hits before any T-select, relying on
        // the first tool being implicit. Default to T01 so the hits are attributed
        // to a real aperture and subsequent M00 tool changes count from there.
        if (currentTool === null) {
          currentTool = 1
          warnings.push('No tool selected before first drill hit — defaulting to T01')
        }
        const coordMatch = clean.match(/X([+-]?\d*\.?\d*)Y([+-]?\d*\.?\d*)/i)
        if (coordMatch) {
          const xRaw = coordMatch[1] || ''
          const yRaw = coordMatch[2] || ''
          const x = parseExcellonCoord(xRaw, fmtInt, fmtDec, declaredZeroSuppression, units, warnOnce)
          const y = parseExcellonCoord(yRaw, fmtInt, fmtDec, declaredZeroSuppression, units, warnOnce)

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
          const x = parseExcellonCoord(singleXMatch[1], fmtInt, fmtDec, declaredZeroSuppression, units, warnOnce)
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
          const y = parseExcellonCoord(singleYMatch[1], fmtInt, fmtDec, declaredZeroSuppression, units, warnOnce)
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

  // Eagle workaround: detect Eagle-generated files that declare TZ but actually use LZ.
  // Eagle has a well-known bug where it writes METRIC,TZ but the coordinate data
  // uses leading zero omission. Detect this by checking if coordinates would be
  // wildly out of range when parsed as TZ — if so, re-parse as LZ.
  //
  // Skipped entirely when the caller supplied `forceFormat`: an explicit user
  // override must win over this heuristic, otherwise picking "trailing" in the
  // Drill Format Override card would be silently flipped back to "leading".
  let actualZeroSuppression = declaredZeroSuppression
  let eagleTzCorrected = false
  if (!forceFormat && declaredZeroSuppression === 'trailing' && commands.length > 0) {
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
      eagleTzCorrected = true
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

  // Plausibility check for files that never declared zero suppression.
  // With no LZ/TZ keyword (and no bare METRIC/INCH, which per spec means
  // fixed-width), we default to 'leading' — but some CAM outputs (Protel /
  // older Altium inch 2.4 files, e.g. "M72 M48 T1F00S00C0.024 … X0237Y01715")
  // actually use trailing suppression without saying so. Detect this the same
  // way a human would: under the leading interpretation the whole board can
  // come out smaller than its own largest drill bit, which is physically
  // impossible. In that case re-parse as trailing and keep it if it looks sane.
  if (!forceFormat && !formatFromHeader && actualZeroSuppression === 'leading' && commands.length > 3) {
    const unitScale = units === 'inches' ? 25.4 : 1
    // Only tools actually hit count for the physical checks; the drilled area
    // is interpretation-independent (same tools, same hit count either way).
    let maxUsedDiaMm = 0
    let drilledAreaMm2 = 0
    for (const cmd of commands) {
      const apt = cmd.apertureCode !== null ? apertures.get(cmd.apertureCode) : undefined
      const diaMm = (apt?.width ?? 0) * unitScale
      if (diaMm > maxUsedDiaMm) maxUsedDiaMm = diaMm
      drilledAreaMm2 += Math.PI * (diaMm / 2) ** 2
    }
    const implausible = (b: GerberBounds | null): boolean => {
      if (!b) return true
      const w = b.maxX - b.minX
      const h = b.maxY - b.minY
      // Larger than any real panel → decoded garbage
      if (w > 1000 || h > 1000) return true
      // Board can't physically contain its own largest drill
      if (maxUsedDiaMm > 0 && (w < maxUsedDiaMm || h < maxUsedDiaMm)) return true
      // The holes themselves need more area than the whole board offers —
      // they'd have to overlap, which no real drill program does
      if (drilledAreaMm2 > w * h) return true
      // Hundreds of hits crammed into a degenerate speck
      if (commands.length > 10 && w < 1 && h < 1) return true
      return false
    }

    if (implausible(calculateBounds(commands, apertures))) {
      const tzCommands = reparseExcellonBody(normalized, fmtInt, fmtDec, 'trailing', units)
      const tzBounds = calculateBounds(tzCommands, apertures)
      if (tzCommands.length > 0 && !implausible(tzBounds)) {
        commands.length = 0
        commands.push(...tzCommands)
        actualZeroSuppression = 'trailing'
        warnings.push(
          'No zero suppression declared — the default (leading) interpretation produced an implausible board size; re-parsed as trailing.'
        )
      }
    }
  }

  // Tool diameters were stored raw in the file's units, but the returned
  // layer declares `units: 'mm'` (coordinates are converted during body
  // parsing) — so downstream `convertLayerUnits` no-ops and would leave inch
  // diameters behind forever. Convert them here to keep the whole layer in
  // one unit. Leaving them raw silently corrupted every consumer that
  // serializes apertures back out: serializeParsedDrillToExcellon (drill
  // align / rotate) wrote `T01C0.0240` under a METRIC header — 25.4×-too-
  // small holes rendered as barely-visible uniform dots. Must run AFTER the
  // plausibility block above, which still expects raw units (it applies its
  // own unitScale).
  if (units === 'inches') {
    for (const apt of Array.from(apertures.values())) {
      if (apt.width !== undefined) apt.width *= 25.4
      if (apt.height !== undefined) apt.height *= 25.4
      if (apt.holeDiameter !== undefined) apt.holeDiameter *= 25.4
    }
  }

  // Slots were pushed with a placeholder diameterMm (0) before the tool
  // table's own units were finalized above — resolve the real diameter now
  // from each slot's tool aperture, same source flash-command hole diameters
  // already use downstream.
  for (const slot of slots) {
    const apt = apertures.get(slot.toolCode)
    if (apt && apt.width !== undefined && apt.width > 0) slot.diameterMm = apt.width
  }

  // Recalculate bounds after possible suppression correction — folding in
  // slots, which live outside `commands` (see `DrillSlot`'s docs) and so
  // never reach `calculateBounds` on their own.
  const boundsWithSlots = expandBoundsForSlots(calculateBounds(commands, apertures), slots)

  // Default format (3:3 metric) — not critical for drill layers
  const formatX: CoordinateFormat = { integer: 3, decimal: 3 }
  const formatY: CoordinateFormat = { integer: 3, decimal: 3 }

  const drillMeta: DrillMeta = {
    unit: units,
    integerDigits: fmtInt,
    decimalDigits: fmtDec,
    // Report the suppression actually used to decode, not merely the declared one.
    zeroSuppression: actualZeroSuppression,
    source: forceFormat ? 'override' : formatFromHeader ? 'header' : 'default',
    toolCount: apertures.size,
    hitCount: commands.length,
    ...(eagleTzCorrected ? { eagleTzCorrected: true } : {}),
    ...(formatGuessedFromContent ? { formatGuessedFromContent: true } : {}),
  }

  return {
    fileName,
    rawContent: content,
    units: 'mm', // Always store in mm
    formatX,
    formatY,
    apertures,
    commands,
    regions: [],
    bounds: boundsWithSlots,
    warnings,
    drillMeta,
    ...(slots.length > 0 ? { drillSlots: slots } : {}),
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
  zeroSuppression: DrillZeroSuppressionMode,
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
      // Tools already parsed in main pass — header lines are skipped here
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
  zeroSuppression: DrillZeroSuppressionMode,
  units: GerberUnit,
  warn?: (msg: string) => void
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

  // Handle embedded decimal point (some files include explicit decimals).
  // These are self-describing, so zero suppression and the digit counts are
  // irrelevant — parse directly. KiCad emits coordinates this way.
  if (digits.includes('.')) {
    const val = parseFloat(digits)
    return negative ? -val : val
  }

  const totalDigits = intDigits + decDigits

  // Apply zero suppression: pad accordingly
  let padded: string
  if (zeroSuppression === 'trailing') {
    // Trailing zero suppression: pad with TRAILING zeros to fill totalDigits.
    // e.g. "16500" with 3:3 TZ → pad to 6 digits → "165000" → int=165, dec=000 → 165.000
    padded = digits.padEnd(totalDigits, '0')
  } else {
    // 'leading' — leading zeros were suppressed; pad left to restore.
    //   e.g. "16500" with 2:4 LZ → "016500" → int=01, dec=6500 → 1.6500
    // 'none'    — coordinates should already be full fixed-width, so padStart is
    //   a no-op. If the field IS short the file contradicts its own declaration;
    //   assume dropped leading zeros (the common malformation) and warn.
    if (zeroSuppression === 'none' && digits.length !== totalDigits) {
      warn?.(
        `Coordinate "${raw.trim()}" has ${digits.length} digits but format declares ${intDigits}:${decDigits} ` +
        `(${totalDigits} fixed-width digits) with no zero suppression — assuming suppressed leading zeros.`
      )
    }
    padded = digits.padStart(totalDigits, '0')
  }

  // Truncate overflow. Which end to keep depends on where the padding went:
  // for trailing suppression the leftmost digits are the significant ones;
  // for leading/none the rightmost digits are.
  if (padded.length > totalDigits) {
    padded = zeroSuppression === 'trailing'
      ? padded.substring(0, totalDigits)
      : padded.substring(padded.length - totalDigits)
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
  // The coordinate rewriter below unconditionally converts every X/Y value
  // to millimetres (see `valueMm` further down) — so the header this
  // function emits must ALWAYS declare METRIC, exactly once, regardless of
  // what unit the source file declared. Getting this wrong produces a
  // self-contradictory Excellon file (mm-valued coordinates under a stale
  // inch-mode header) that any compliant reader — including the exporter's
  // downstream CAM tooling — will scale by another 25.4x. Track whether
  // we've emitted it yet so every unit-declaration variant in the source
  // (bare METRIC/INCH, METRIC/INCH,LZ/TZ, or Excellon's M71/M72 codes) maps
  // to that single canonical declaration instead of passing through
  // untouched or being silently dropped.
  let metricDeclared = false
  // Whether we've emitted 'M48' yet. Some exporters (Protel) put a unit
  // code before M48 (e.g. "M72\nM48\n..."). Standard Excellon expects
  // METRIC right after M48, so a unit token seen before M48 is absorbed
  // silently rather than emitted early — the M48 handler below always
  // declares METRIC itself when it hasn't been declared yet, so it still
  // ends up in the output, just in the conventional position.
  let sawM48 = false

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) { output.push(''); continue }

    const clean = line.replace(/\*$/, '').trim()

    // Skip comments
    if (clean.startsWith(';')) { output.push(clean); continue }

    // M48 header start
    if (clean.toUpperCase() === 'M48') {
      output.push('M48')
      if (!metricDeclared) { output.push('METRIC'); metricDeclared = true }
      sawM48 = true
      continue
    }

    // Replace METRIC/INCH/format declarations in header with explicit METRIC
    if (!inBody) {
      const upper = clean.toUpperCase()

      // Replace any unit/format declaration — bare METRIC/INCH, with a
      // TZ/LZ suffix, or Excellon's M71 (metric)/M72 (inch) mode codes —
      // with our own canonical declaration. Only the first occurrence
      // after M48 actually emits a line; later ones (a file redeclaring
      // units mid-header, which does happen) are absorbed since we've
      // already committed to millimetres for every coordinate in this
      // output. A unit token seen before M48 is absorbed too — see sawM48.
      if (upper === 'METRIC' || upper === 'INCH' || upper === 'M71' || upper === 'M72' ||
          /^(METRIC|INCH)\s*,\s*(TZ|LZ)/i.test(upper)) {
        if (!metricDeclared && sawM48) { output.push('METRIC'); metricDeclared = true }
        continue
      }

      // Tool definition — keep the line structure but convert the
      // diameter to mm too, so it isn't left mismatched against the
      // METRIC header when the source format was inches (e.g. an inch
      // file's "T1C0.024" is a 0.024" bit, not 0.024mm). Feed/speed
      // params (F/S/B/H) may appear before OR after the diameter — e.g.
      // "T1F00S00C0.024" (this exact file) — and are preserved verbatim;
      // only the diameter itself needs unit conversion.
      const toolMatch = clean.match(/^(T\d+)((?:[FSBH][\d.]+)*)C([\d.]+)(.*)$/i)
      if (toolMatch) {
        const [, toolCode, preParams, diaStr, rest] = toolMatch
        const dia = parseFloat(diaStr)
        const diaMm = format.unit === 'mm' || isNaN(dia) ? dia : dia * 25.4
        output.push(`${toolCode}${preParams}C${diaMm.toFixed(4)}${rest}`)
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

    // % — end of header. If nothing in the header ever declared a unit
    // (a legitimate but rare bare M48...% with no METRIC/INCH/M71/M72 at
    // all), still emit our canonical declaration — every coordinate past
    // this point is unconditionally mm, so the header must say so too.
    if (clean === '%') {
      if (!metricDeclared) { output.push('METRIC'); metricDeclared = true }
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
    } else if (ap.shape === 'macro' && ap.macroName && ap.parameters && /RoundRect/i.test(ap.macroName)) {
      // KiCad's RoundRect macro (confirmed on a real customer board: SMD IC
      // pads went "merged and malformed" after rotating a layer in the
      // Layers tab) parameterizes its 4 corners directly as $2,$3 / $4,$5 /
      // $6,$7 / $8,$9 (x,y pairs), not a width/height + rotation angle like
      // the built-in shapes above — every primitive in the %AM body (the
      // box polygon, the 4 corner circles, the 4 edge vector-lines)
      // references only these corner coordinates, so rotating just the 4
      // pairs rigidly rotates the whole rendered pad. $1 (rounding radius)
      // is rotation-invariant and untouched; a trailing $10 some KiCad
      // versions emit is unreferenced by the macro body (confirmed against
      // this file's own %AM block) and left alone too.
      //
      // This does NOT generalize to other macro names — this codebase has
      // no way to know an arbitrary macro's own coordinate-parameter layout
      // without interpreting its %AM body, so anything else still falls
      // through unrotated (a real, documented gap — see CLAUDE.md's
      // `rotationBlockedReason` note). RoundRect is by far the dominant
      // real-world case: every KiCad SMD pad with rounded corners.
      const corners: [string, string][] = [['$2', '$3'], ['$4', '$5'], ['$6', '$7'], ['$8', '$9']]
      for (const [xk, yk] of corners) {
        const px = ap.parameters[xk]
        const py = ap.parameters[yk]
        if (px === undefined || py === undefined) continue
        if (direction === 'right') {
          ap.parameters[xk] = py
          ap.parameters[yk] = -px
        } else {
          ap.parameters[xk] = -py
          ap.parameters[yk] = px
        }
      }
    }
  }

  // 1b. Rotate drill slots (start/end are outside `commands` — see
  // `GerberLayer.drillSlots`'s own docs — so `calculateBounds` never sees
  // them and every geometric transform must handle them explicitly).
  for (const slot of layer.drillSlots ?? []) {
    for (const pt of [slot.start, slot.end]) {
      const x = pt.x, y = pt.y
      if (direction === 'right') { pt.x = y; pt.y = -x }
      else { pt.x = -y; pt.y = x }
    }
  }

  // 3. Recompute bounds — must fold in slots (`expandBoundsForSlots`) or a
  // board whose only geometry near an edge is a slot rotates into a bounds
  // box too small to contain it.
  layer.bounds = expandBoundsForSlots(calculateBounds(layer.commands, layer.apertures), layer.drillSlots ?? [])
}

/**
 * Mirrors a GerberLayer horizontally (reflects every X coordinate around a
 * given local axis `centerX`). Mutates the layer object in place — mirrors
 * `rotateGerberLayer`'s own shape/conventions exactly, just for a reflection
 * instead of a 90° turn.
 *
 * Used to materialize the effect of the CAM tool's per-design "Fix mirror"
 * override into REAL exported geometry — that override was originally
 * preview-only (a pure SVG transform, zero effect on `rawContent`/
 * `parsedLayer`), which is correct for a file whose raw data already matches
 * the standard "one shared top-down coordinate system, bottom layers
 * pre-mirrored in the file" Gerber convention. But for a genuinely legacy
 * file that stores bottom-side artwork already bottom-view-correct (the
 * exact case the toggle exists to diagnose), the raw data itself needs this
 * correction — otherwise the exported fabrication files ship backward
 * (confirmed live: text and copper geometry read mirrored when opened in a
 * neutral third-party Gerber viewer that applies no side-aware auto-flip).
 *
 * @param layer The layer to mirror
 * @param centerX The local (native, pre-panel-offset) X axis to reflect around
 * @returns `hasUnmirroredMacro: true` when the layer has a custom aperture
 *   macro whose local coordinate layout this function doesn't know how to
 *   mirror (anything other than KiCad's RoundRect) — that pad's FLASH
 *   POSITION is still mirrored correctly, but its own outline shape is not,
 *   same documented gap `rotateGerberLayer` has for rotation. Callers
 *   should surface this rather than silently shipping a wrong pad shape.
 */
export function mirrorGerberLayerX(layer: GerberLayer, centerX: number): { hasUnmirroredMacro: boolean } {
  // 1. Mirror commands
  for (const cmd of layer.commands) {
    if (cmd.coordinate.x !== undefined) {
      cmd.coordinate.x = 2 * centerX - cmd.coordinate.x
    }
    // I is the arc center's X offset relative to the start point — mirroring
    // the X axis flips its sign. J (the Y offset) is untouched.
    if (cmd.coordinate.i !== undefined) {
      cmd.coordinate.i = -cmd.coordinate.i
    }
    // A reflection reverses the sense of rotation, so a clockwise arc must
    // become counter-clockwise (and vice versa) to still trace the same
    // physical curve through the mirrored endpoints.
    if (cmd.type === 'arc_cw') {
      cmd.type = 'arc_ccw'
    } else if (cmd.type === 'arc_ccw') {
      cmd.type = 'arc_cw'
    }
  }

  // 1b. Mirror drill slots — same "outside `commands`, every transform must
  // handle it explicitly" reasoning as the rotate path above.
  for (const slot of layer.drillSlots ?? []) {
    slot.start.x = 2 * centerX - slot.start.x
    slot.end.x = 2 * centerX - slot.end.x
  }

  // 2. Mirror apertures. Symmetric shapes (circle/rectangle/obround) need no
  // dimension change from an X-mirror (unlike a 90° rotation, which swaps
  // width/height) — only their own rotation angle, if any, reverses sign.
  let hasUnmirroredMacro = false
  for (const ap of layer.apertures.values()) {
    if (ap.shape === 'rectangle' || ap.shape === 'obround') {
      if (ap.rotation !== undefined) {
        ap.rotation = -ap.rotation
      }
    } else if (ap.shape === 'polygon') {
      // A regular n-gon's vertices sit at rot + k*360/n; reflecting about a
      // vertical axis maps them to 180 - rot - k*360/n. That's congruent to
      // -rot (the rectangle/obround formula) only when n is EVEN — an odd
      // vertex count (triangle, pentagon, ...) needs the real 180-rot form.
      if (ap.rotation !== undefined) {
        ap.rotation = 180 - ap.rotation
      }
    } else if (ap.shape === 'macro' && ap.macroName && ap.parameters && /RoundRect/i.test(ap.macroName)) {
      // Same KiCad RoundRect special-case rotateGerberLayer documents — the
      // macro's 4 corners are parameterized directly as $2,$3/$4,$5/$6,$7/
      // $8,$9 (x,y pairs) in the aperture's own local frame around the flash
      // origin, so mirroring just the X of each pair rigidly mirrors the
      // whole rendered pad. Does not generalize to other macro names.
      const corners: [string, string][] = [['$2', '$3'], ['$4', '$5'], ['$6', '$7'], ['$8', '$9']]
      for (const [xk] of corners) {
        const px = ap.parameters[xk]
        if (px === undefined) continue
        ap.parameters[xk] = -px
      }
    } else if (ap.shape === 'macro') {
      // A macro this codebase doesn't know the coordinate layout of — its
      // flash position still mirrors correctly (step 1 above), but the
      // shape drawn at that position does not. Legacy Protel/OrCAD/CAM350
      // files (the exact vintage the mirror override targets) are the
      // heaviest real-world users of hand-rolled macros, so this is a real,
      // not theoretical, gap.
      hasUnmirroredMacro = true
    }
  }

  // 3. Recompute bounds — must fold in slots, see the rotate path above.
  layer.bounds = expandBoundsForSlots(calculateBounds(layer.commands, layer.apertures), layer.drillSlots ?? [])

  return { hasUnmirroredMacro }
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

  // Slots (Excellon G85) live outside `commands` (see `DrillSlot`'s own
  // docs) so the loop above never sees them — without this pass, every
  // caller of this function (drill align, drill rotate) would silently drop
  // slots from the regenerated file, including the on-screen re-render
  // (`gerberToSvg(newRaw)` in `alignDrillLayersToBoard`).
  for (const slot of parsedLayer.drillSlots ?? []) {
    if (slot.toolCode !== currentTool) {
      currentTool = slot.toolCode
      lines.push(`T${currentTool.toString().padStart(2, '0')}`)
    }
    lines.push(`X${slot.start.x.toFixed(4)}Y${slot.start.y.toFixed(4)}G85X${slot.end.x.toFixed(4)}Y${slot.end.y.toFixed(4)}`)
  }

  // End of program
  lines.push('M30')

  return lines.join('\n')
}

