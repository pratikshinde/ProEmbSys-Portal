/**
 * Stroke-Based Vector Font Engine for Gerber RS-274X Text Rendering
 *
 * Generates line-segment commands (D01 draw) to render text as strokes,
 * matching how CAM350 renders text on PCB panel ribs. This approach uses
 * simple vector strokes rather than RS-274X text commands (rarely supported).
 *
 * Font design: Clean, single-stroke characters in a normalized coordinate
 * system where width=0.6 and height=1.0. Similar to a 5x7 dot matrix font
 * but with connected polyline strokes for efficient Gerber rendering.
 */

import { InfoText, OutputFormat, formatCoordinate } from './panelization-engine'

// ============================================================================
// Font Constants
// ============================================================================

/** Normalized character cell width (fraction of character height) */
const CHAR_WIDTH = 0.6

/** Advance width between characters in character-height units (includes kerning gap) */
const ADVANCE_WIDTH = 0.7

/** Default stroke width in mm — matches D53 aperture used for L-shapes */
const STROKE_WIDTH_MM = 0.254

// ============================================================================
// Stroke Font Data
// ============================================================================

/**
 * Vector font definitions for all supported characters.
 *
 * Each character is defined as an array of polylines (strokes).
 * Each stroke is an array of [x, y] coordinate pairs forming a polyline.
 * The pen moves to the first point (D02) then draws to subsequent points (D01).
 *
 * Coordinate system:
 *   X ∈ [0, CHAR_WIDTH]  — 0 is left edge, CHAR_WIDTH (0.6) is right edge
 *   Y ∈ [0, 1.0]         — 0 is baseline (bottom), 1.0 is top (ascent)
 *
 * All uppercase letters, digits 0–9, and common PCB text symbols.
 */
const STROKE_FONT: Record<string, [number, number][][]> = {
  // ---- Uppercase A–Z ----

  'A': [
    // Two diagonal legs meeting at peak
    [[0, 0], [0.3, 1], [0.6, 0]],
    // Crossbar
    [[0.12, 0.55], [0.48, 0.55]],
  ],

  'B': [
    // Left side + top bump
    [[0, 0], [0, 1], [0.4, 1], [0.5, 0.85], [0.5, 0.65], [0.35, 0.5], [0, 0.5]],
    // Left side + bottom bump
    [[0, 0.5], [0, 0], [0.4, 0], [0.5, 0.15], [0.5, 0.35], [0.35, 0.5]],
  ],

  'C': [
    // C-shape: open on right, curves at corners
    [[0.5, 0.85], [0.4, 1], [0.1, 1], [0, 0.85], [0, 0.15], [0.1, 0], [0.4, 0], [0.5, 0.15]],
  ],

  'D': [
    // Left vertical
    [[0, 0], [0, 1]],
    // Top arc → right side → bottom arc
    [[0, 1], [0.4, 1], [0.5, 0.8], [0.5, 0.2], [0.4, 0], [0, 0]],
  ],

  'E': [
    // C-shape + bottom horizontal
    [[0.5, 1], [0, 1], [0, 0], [0.5, 0]],
    // Middle bar
    [[0, 0.5], [0.4, 0.5]],
  ],

  'F': [
    // Left vertical + top horizontal
    [[0.5, 1], [0, 1], [0, 0]],
    // Middle bar
    [[0, 0.5], [0.4, 0.5]],
  ],

  'G': [
    // C-shape + bottom-right curve + right side up + horizontal tongue
    [[0.45, 1], [0.1, 1], [0, 0.8], [0, 0.2], [0.1, 0], [0.4, 0], [0.45, 0.2], [0.45, 0.5], [0.2, 0.5]],
  ],

  'H': [
    // Left vertical
    [[0, 0], [0, 1]],
    // Right vertical
    [[0.6, 0], [0.6, 1]],
    // Crossbar
    [[0, 0.5], [0.6, 0.5]],
  ],

  'I': [
    // Top serif
    [[0.15, 1], [0.45, 1]],
    // Vertical stem + bottom serif
    [[0.3, 1], [0.3, 0], [0.15, 0], [0.45, 0]],
  ],

  'J': [
    // Top serif
    [[0.1, 1], [0.4, 1]],
    // Vertical stem + bottom hook
    [[0.3, 1], [0.3, 0.15], [0.15, 0], [0, 0.15]],
  ],

  'K': [
    // Left vertical
    [[0, 0], [0, 1]],
    // Upper diagonal + lower diagonal (V-shape meeting at center)
    [[0.55, 1], [0, 0.45], [0.55, 0]],
  ],

  'L': [
    // Left vertical + bottom horizontal
    [[0, 1], [0, 0], [0.5, 0]],
  ],

  'M': [
    // Left up → V middle → right up → right down
    [[0, 0], [0, 1], [0.3, 0.45], [0.6, 1], [0.6, 0]],
  ],

  'N': [
    // Left up → diagonal to bottom-right → right up
    [[0, 0], [0, 1], [0.6, 0], [0.6, 1]],
  ],

  'O': [
    // Rounded rectangle / oval
    [[0.5, 0.15], [0.35, 0], [0.1, 0], [0, 0.15], [0, 0.85], [0.1, 1], [0.35, 1], [0.5, 0.85], [0.6, 0.7], [0.6, 0.3], [0.5, 0.15]],
  ],

  'P': [
    // Left vertical + top loop
    [[0, 0], [0, 1], [0.4, 1], [0.5, 0.85], [0.5, 0.65], [0.35, 0.5], [0, 0.5]],
  ],

  'Q': [
    // O-shape
    [[0.5, 0.15], [0.35, 0], [0.1, 0], [0, 0.15], [0, 0.85], [0.1, 1], [0.35, 1], [0.5, 0.85], [0.6, 0.7], [0.6, 0.3], [0.5, 0.15]],
    // Tail
    [[0.35, 0.05], [0.55, 0.2]],
  ],

  'R': [
    // Left vertical + top loop
    [[0, 0], [0, 1], [0.4, 1], [0.5, 0.85], [0.5, 0.65], [0.35, 0.5], [0, 0.5]],
    // Leg from middle to bottom-right
    [[0.3, 0.5], [0.55, 0]],
  ],

  'S': [
    // Top arc → left → middle zigzag → left → bottom arc
    [[0.5, 0.85], [0.4, 1], [0.1, 1], [0, 0.8], [0, 0.65], [0.4, 0.45], [0.5, 0.3], [0.4, 0], [0.1, 0], [0, 0.15], [0, 0.35]],
  ],

  'T': [
    // Top horizontal
    [[0, 1], [0.6, 1]],
    // Center vertical stem
    [[0.3, 1], [0.3, 0]],
  ],

  'U': [
    // Left down → bottom curve → right up
    [[0, 1], [0, 0.15], [0.1, 0], [0.5, 0], [0.6, 0.15], [0.6, 1]],
  ],

  'V': [
    // Two diagonals meeting at bottom
    [[0, 1], [0.3, 0], [0.6, 1]],
  ],

  'W': [
    // Four segments forming W: down, up, down, up
    [[0, 1], [0.15, 0], [0.3, 0.65], [0.45, 0], [0.6, 1]],
  ],

  'X': [
    // Diagonal top-left to bottom-right
    [[0, 1], [0.6, 0]],
    // Diagonal bottom-left to top-right
    [[0, 0], [0.6, 1]],
  ],

  'Y': [
    // V at top
    [[0, 1], [0.3, 0.45], [0.6, 1]],
    // Vertical stem from V intersection to bottom
    [[0.3, 0.45], [0.3, 0]],
  ],

  'Z': [
    // Top horizontal → diagonal → bottom horizontal
    [[0, 1], [0.6, 1], [0, 0], [0.6, 0]],
  ],

  // ---- Digits 0–9 ----

  '0': [
    // Oval shape (same as O but with diagonal slash to distinguish)
    [[0.5, 0.15], [0.35, 0], [0.1, 0], [0, 0.15], [0, 0.85], [0.1, 1], [0.35, 1], [0.5, 0.85], [0.6, 0.7], [0.6, 0.3], [0.5, 0.15]],
    // Diagonal slash to distinguish from letter O
    [[0.1, 0.25], [0.5, 0.75]],
  ],

  '1': [
    // Hook + full vertical stem
    [[0.15, 0.7], [0.3, 1], [0.3, 0]],
    // Bottom base serif
    [[0.1, 0], [0.5, 0]],
  ],

  '2': [
    // Top curve → right side → diagonal → bottom horizontal
    [[0, 0.85], [0.1, 1], [0.45, 1], [0.55, 0.85], [0.55, 0.7], [0.15, 0.45], [0, 0.3], [0, 0.15], [0.1, 0], [0.5, 0]],
  ],

  '3': [
    // S-shape with bumps on right: top bump, middle, bottom bump
    [[0.55, 0.85], [0.45, 1], [0.1, 1], [0, 0.8], [0, 0.65], [0.5, 0.5], [0, 0.35], [0, 0.2], [0.1, 0], [0.45, 0], [0.55, 0.15]],
  ],

  '4': [
    // Vertical stroke
    [[0.4, 0], [0.4, 1]],
    // Horizontal crossbar extending left
    [[0, 0.6], [0.6, 0.6]],
  ],

  '5': [
    // Top horizontal → left side → middle → bottom bump
    [[0.55, 1], [0.1, 1], [0, 0.8], [0, 0.5], [0.5, 0.5], [0.5, 0.2], [0.4, 0], [0.1, 0], [0, 0.15]],
  ],

  '6': [
    // Lower loop + upper bump (counterclockwise from middle-right)
    [[0.4, 0.5], [0.5, 0.3], [0.5, 0.15], [0.35, 0], [0.05, 0], [0, 0.1], [0, 0.9], [0.1, 1], [0.4, 1], [0.5, 0.8], [0.4, 0.5]],
  ],

  '7': [
    // Top horizontal → diagonal down to bottom-left
    [[0, 1], [0.6, 1], [0.15, 0]],
  ],

  '8': [
    // Figure-8 starting from center: upper loop then lower loop
    [[0.3, 0.5], [0.5, 0.65], [0.5, 0.85], [0.4, 1], [0.1, 1], [0, 0.85], [0, 0.65], [0.3, 0.5],
    // Lower loop
     [0, 0.35], [0, 0.15], [0.1, 0], [0.4, 0], [0.5, 0.15], [0.5, 0.35], [0.3, 0.5]],
  ],

  '9': [
    // Upper bump + lower loop (mirror of 6, clockwise from middle-left)
    [[0.1, 0.5], [0, 0.65], [0, 0.85], [0.1, 1], [0.4, 1], [0.5, 0.85], [0.5, 0.65], [0.4, 0.5],
    // Lower loop
     [0.5, 0.3], [0.5, 0.15], [0.35, 0], [0.05, 0], [0, 0.1], [0, 0.35], [0.1, 0.5]],
  ],

  // ---- Symbols ----

  '.': [
    // Short horizontal stroke at baseline (dot)
    [[0.25, 0], [0.35, 0]],
  ],

  ',': [
    // Vertical stroke + tail hook at baseline
    [[0.25, 0.15], [0.25, 0], [0.15, 0]],
  ],

  ':': [
    // Upper dot
    [[0.25, 0.65], [0.35, 0.65]],
    // Lower dot
    [[0.25, 0.35], [0.35, 0.35]],
  ],

  '-': [
    // Horizontal dash at mid-height
    [[0.1, 0.5], [0.5, 0.5]],
  ],

  '/': [
    // Diagonal from bottom-left to top-right
    [[0.1, 0], [0.5, 1]],
  ],

  '(': [
    // Left parenthesis curve
    [[0.5, 0.9], [0.3, 0.7], [0.3, 0.3], [0.5, 0.1]],
  ],

  ')': [
    // Right parenthesis curve
    [[0.1, 0.1], [0.3, 0.3], [0.3, 0.7], [0.1, 0.9]],
  ],

  'x': [
    // Lowercase x: two crossing diagonals (same shape as X)
    [[0.1, 1], [0.5, 0]],
    [[0.1, 0], [0.5, 1]],
  ],

  '=': [
    // Upper bar
    [[0.1, 0.6], [0.5, 0.6]],
    // Lower bar
    [[0.1, 0.4], [0.5, 0.4]],
  ],

  '|': [
    // Vertical line
    [[0.3, 1], [0.3, 0]],
  ],

  '+': [
    // Vertical bar
    [[0.3, 0], [0.3, 1]],
    // Horizontal bar
    [[0, 0.5], [0.6, 0.5]],
  ],

  ' ': [
    // Space: no strokes
    [],
  ],
}

// ============================================================================
// Font Access Functions
// ============================================================================

/**
 * Get the stroke polylines for a single character.
 *
 * Looks up the character in the font table. If not found, tries the uppercase
 * version. Returns an empty array for unsupported characters (will be skipped
 * during rendering).
 *
 * @param char - A single character (string of length 1 or more; only first char used)
 * @returns Array of polylines, each polyline is an array of [x, y] coordinate pairs
 */
export function getCharacterStrokes(char: string): [number, number][][] {
  const ch = char.length >= 1 ? char[0] : char
  if (STROKE_FONT[ch]) return STROKE_FONT[ch]
  const upper = ch.toUpperCase()
  if (STROKE_FONT[upper]) return STROKE_FONT[upper]
  return []
}

/**
 * Measure the total width of a text string in character-height units.
 *
 * The returned value is relative to the font size. Multiply by fontSize (in mm)
 * to get the actual width in millimeters.
 *
 * Width = (numChars - 1) × advanceWidth + charWidth
 * For a single character: width = CHAR_WIDTH (0.6)
 * For "AB" (2 chars):      width = ADVANCE_WIDTH + CHAR_WIDTH (1.3)
 *
 * @param text - The text string to measure
 * @returns Total width in character-height units
 */
export function measureTextWidth(text: string): number {
  if (text.length === 0) return 0
  return (text.length - 1) * ADVANCE_WIDTH + CHAR_WIDTH
}

// ============================================================================
// Layer Eligibility
// ============================================================================

/**
 * Check if a layer type should receive stroke-font text shapes.
 *
 * Text goes on copper, mask, and silkscreen layers (both top and bottom).
 * Paste layers do NOT get text (same rule as donut shapes).
 *
 * @param layerType - The layer type string ('copper', 'mask', 'silk', 'paste', etc.)
 * @returns true if the layer should have text shapes rendered
 */
export function layerNeedsTextShapes(layerType: string): boolean {
  return layerType === 'copper' || layerType === 'mask' || layerType === 'silk'
}

// ============================================================================
// Gerber Command Generation
// ============================================================================

/**
 * Transform a local coordinate point to world coordinates based on rotation.
 *
 * Uses standard 2D rotation matrix:
 *   worldX = anchorX + localX × cos(θ) - localY × sin(θ)
 *   worldY = anchorY + localX × sin(θ) + localY × cos(θ)
 *
 * Supported rotations:
 *   0°:   text reads left-to-right (horizontal)
 *   90°:  text reads bottom-to-top (vertical, left rib)
 *   -90°: text reads top-to-bottom (vertical, alternative)
 *
 * @param localX - X offset from anchor in mm (after scaling and alignment)
 * @param localY - Y offset from anchor in mm (after scaling and centering)
 * @param rotationDeg - Rotation angle in degrees
 * @param anchorX - Text anchor point X in mm
 * @param anchorY - Text anchor point Y in mm
 * @returns World coordinate [x, y] in mm
 */
function transformPoint(
  localX: number,
  localY: number,
  rotationDeg: number,
  anchorX: number,
  anchorY: number,
): [number, number] {
  if (rotationDeg === 0) {
    return [anchorX + localX, anchorY + localY]
  }
  const rad = (rotationDeg * Math.PI) / 180
  const cosR = Math.cos(rad)
  const sinR = Math.sin(rad)
  const wx = anchorX + localX * cosR - localY * sinR
  const wy = anchorY + localX * sinR + localY * cosR
  return [wx, wy]
}

/**
 * Generate Gerber RS-274X draw commands to render text using stroke font.
 *
 * This function converts InfoText items into Gerber D01/D02 draw commands,
 * rendering each character as a series of line segments using a circular
 * aperture (default D53, 0.254mm diameter — same as L-shape stroke width).
 *
 * Features:
 * - Supports rotation (0°, 90°, -90°, and arbitrary angles)
 * - Supports text alignment (left, center, right)
 * - Supports X-mirroring (for bottom layer labels on side ribs)
 * - Characters are centered perpendicular to the reading direction
 *   (vertical text centered horizontally, horizontal text centered vertically)
 * - Self-contained: includes aperture definition and selection
 *
 * Coordinate transformation pipeline for each stroke point:
 *   1. Scale stroke coordinates by fontSize (normalized → mm)
 *   2. Offset by character position (charIndex × advanceWidth × fontSize)
 *   3. Apply alignment offset along reading direction (local X)
 *   4. Apply perpendicular centering offset (local Y = -fontSize/2)
 *   5. Apply X-mirror if mirrored
 *   6. Apply rotation transform around anchor point
 *   7. Add anchor position to get world coordinates
 *
 * @param texts - Array of InfoText objects (from panelization engine)
 * @param fmt - Gerber output format specification (for coordinate formatting)
 * @param apertureCode - Aperture D-code number (default: 53, matching L-shapes)
 * @returns Array of Gerber command strings (each ending with *)
 *
 * @example
 * ```typescript
 * const commands = generateStrokeFontGerberCommands(panel.infoTexts, outputFormat)
 * // Append to Gerber file content
 * gerberLines.push(...commands)
 * ```
 */
export function generateStrokeFontGerberCommands(
  texts: InfoText[],
  fmt: OutputFormat,
  apertureCode?: number,
): string[] {
  const code = apertureCode ?? 53
  const lines: string[] = []

  if (texts.length === 0) return lines

  // Filter to only texts with non-empty content
  const validTexts = texts.filter(t => t.text && t.text.length > 0)
  if (validTexts.length === 0) return lines

  // Define the stroke aperture (circular, 0.254mm diameter)
  // Safe to redefine even if D53 already exists (RS-274X allows redefinition)
  lines.push(`%ADD${code}C,${STROKE_WIDTH_MM.toFixed(6)}*%`)

  // Select the aperture for drawing
  lines.push(`G54D${code}*`)

  // Coordinate formatter (value in mm → Gerber string)
  const f = (v: number) => formatCoordinate(v, fmt)

  // Generate draw commands for each text item
  for (const text of validTexts) {
    const fontSize = text.fontSize
    if (fontSize <= 0) continue

    const textWidthMm = measureTextWidth(text.text) * fontSize

    // Alignment offset along the text reading direction (local X axis).
    // This shifts the starting position so text is left/center/right aligned
    // relative to the anchor point along the primary reading direction.
    let alignOffsetX = 0
    if (text.align === 'center') {
      alignOffsetX = -textWidthMm / 2
    } else if (text.align === 'right') {
      alignOffsetX = -textWidthMm
    }

    // Perpendicular centering offset (local Y axis).
    // Centers the character height (ascent + descent) on the anchor point,
    // perpendicular to the reading direction. This ensures:
    // - Horizontal text (0°): centered vertically on anchor Y
    // - Vertical text (90°): centered horizontally on anchor X
    const perpOffsetY = -fontSize / 2

    const rotation = text.rotation || 0

    // Render each character
    let charIndex = 0
    for (const ch of text.text) {
      const strokes = getCharacterStrokes(ch)
      if (strokes.length === 0) {
        charIndex++
        continue
      }

      // X offset for this character position (in mm)
      const charXOffset = charIndex * ADVANCE_WIDTH * fontSize

      // Render each stroke (polyline) of this character
      for (const stroke of strokes) {
        if (stroke.length < 2) continue

        // First point: pen move (D02) — lift pen, move to start position
        const [cx0, cy0] = stroke[0]
        let lx0 = alignOffsetX + charXOffset + cx0 * fontSize
        let ly0 = perpOffsetY + cy0 * fontSize
        if (text.mirrored) lx0 = -lx0

        const [wx0, wy0] = transformPoint(lx0, ly0, rotation, text.x, text.y)
        lines.push(`X${f(wx0)}Y${f(wy0)}D02*`)

        // Remaining points: pen draw (D01) — draw line segments
        for (let i = 1; i < stroke.length; i++) {
          const [cx, cy] = stroke[i]
          let lx = alignOffsetX + charXOffset + cx * fontSize
          let ly = perpOffsetY + cy * fontSize
          if (text.mirrored) lx = -lx

          const [wx, wy] = transformPoint(lx, ly, rotation, text.x, text.y)
          lines.push(`X${f(wx)}Y${f(wy)}D01*`)
        }
      }

      charIndex++
    }
  }

  return lines
}
