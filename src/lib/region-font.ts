/**
 * Region-Based Vector Font Engine for Gerber RS-274X Text Rendering
 *
 * Renders panel legend text as filled polygon regions (G36/G37), matching
 * CAM350's solid-text style. Glyph outlines are extracted at runtime from a
 * real vector typeface (a subset of Geist Regular embedded in
 * `region-font-data.ts`) via opentype.js, flattened to polylines, and split
 * into dark (outer) and clear (counter) contours by nesting depth.
 *
 * Emission (unchanged, CAM350-style):
 *   1. All outer contours   → %LPD% + G36/G37  (solid fills)
 *   2. All counter contours → %LPC% + G36/G37  (cutout holes)
 *   3. Reset to %LPD%
 *
 * The same laid-out polygons feed the on-screen preview (`getRegionTextPolygons`)
 * so the panel view is WYSIWYG with the exported Gerber.
 */

import * as opentype from 'opentype.js'
import { InfoText, OutputFormat, formatCoordinate } from './panelization-engine'
import { REGION_FONT_TTF_BASE64 } from './region-font-data'

// ============================================================================
// Font Metrics
// ============================================================================

/**
 * Advance used for characters the embedded subset does not contain (drawn as a
 * blank gap). In character-height (cap-height) units, matching the normalized
 * glyph coordinate space where cap height = 1.0.
 */
const FALLBACK_ADVANCE = 0.6

/** Bézier flattening tolerance, in normalized (cap-height = 1.0) units. */
const FLATTEN_TOL_NORM = 0.02

// ============================================================================
// Font Loading (memoized, synchronous)
// ============================================================================

type Pt = [number, number]

interface RegionGlyph {
  /** Outer boundary contours — dark polarity (solid fill). */
  outer: Pt[][]
  /** Counter contours — clear polarity (cutout). */
  inner: Pt[][]
  /** Advance width in normalized (cap-height) units. */
  advance: number
}

let _font: opentype.Font | null = null
let _scale = 1
const _glyphCache = new Map<string, RegionGlyph>()

function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes.buffer
}

/** Parse the embedded font once and cache it plus the cap-height scale. */
function getFont(): opentype.Font {
  if (_font) return _font
  _font = opentype.parse(base64ToArrayBuffer(REGION_FONT_TTF_BASE64))
  // Normalize so cap height maps to 1.0 (uppercase fills [0,1], as the old
  // hand-authored font did — preserves fontSize semantics and vertical
  // centering). Cap height comes from the 'H' glyph's bounding box top.
  const capBox = _font.charToGlyph('H').getBoundingBox()
  const capHeight = capBox.y2 || _font.unitsPerEm * 0.7
  _scale = 1 / capHeight
  return _font
}

// ============================================================================
// Bézier Flattening
// ============================================================================

/** Perpendicular distance² from point p to the line through a→b. */
function distSqToLine(p: Pt, a: Pt, b: Pt): number {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const len2 = dx * dx + dy * dy
  if (len2 === 0) return (p[0] - a[0]) ** 2 + (p[1] - a[1]) ** 2
  const cross = (p[0] - a[0]) * dy - (p[1] - a[1]) * dx
  return (cross * cross) / len2
}

function flattenQuad(p0: Pt, c: Pt, p1: Pt, tol2: number, out: Pt[], depth = 0): void {
  if (depth >= 12 || distSqToLine(c, p0, p1) <= tol2) {
    out.push(p1)
    return
  }
  const p01: Pt = [(p0[0] + c[0]) / 2, (p0[1] + c[1]) / 2]
  const p12: Pt = [(c[0] + p1[0]) / 2, (c[1] + p1[1]) / 2]
  const mid: Pt = [(p01[0] + p12[0]) / 2, (p01[1] + p12[1]) / 2]
  flattenQuad(p0, p01, mid, tol2, out, depth + 1)
  flattenQuad(mid, p12, p1, tol2, out, depth + 1)
}

function flattenCubic(p0: Pt, c1: Pt, c2: Pt, p1: Pt, tol2: number, out: Pt[], depth = 0): void {
  const flat = distSqToLine(c1, p0, p1) <= tol2 && distSqToLine(c2, p0, p1) <= tol2
  if (depth >= 12 || flat) {
    out.push(p1)
    return
  }
  const p01: Pt = [(p0[0] + c1[0]) / 2, (p0[1] + c1[1]) / 2]
  const p12: Pt = [(c1[0] + c2[0]) / 2, (c1[1] + c2[1]) / 2]
  const p23: Pt = [(c2[0] + p1[0]) / 2, (c2[1] + p1[1]) / 2]
  const p012: Pt = [(p01[0] + p12[0]) / 2, (p01[1] + p12[1]) / 2]
  const p123: Pt = [(p12[0] + p23[0]) / 2, (p12[1] + p23[1]) / 2]
  const mid: Pt = [(p012[0] + p123[0]) / 2, (p012[1] + p123[1]) / 2]
  flattenCubic(p0, p01, p012, mid, tol2, out, depth + 1)
  flattenCubic(mid, p123, p23, p1, tol2, out, depth + 1)
}

// ============================================================================
// Contour Classification (outer vs counter)
// ============================================================================

/** Even-odd point-in-polygon test. */
function pointInPolygon(pt: Pt, poly: Pt[]): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1]
    const xj = poly[j][0], yj = poly[j][1]
    const intersect = (yi > pt[1]) !== (yj > pt[1]) &&
      pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi
    if (intersect) inside = !inside
  }
  return inside
}

/**
 * Split flattened contours into outer (dark) and counter (clear) by nesting
 * depth: a contour nested inside an odd number of others is a hole. Handles
 * every Latin counter (O, A, B, D, P, Q, R, 0, 4, 6, 8, 9, …).
 */
function classifyContours(contours: Pt[][]): { outer: Pt[][]; inner: Pt[][] } {
  const outer: Pt[][] = []
  const inner: Pt[][] = []
  for (let i = 0; i < contours.length; i++) {
    const probe = contours[i][0]
    let depth = 0
    for (let j = 0; j < contours.length; j++) {
      if (i === j) continue
      if (pointInPolygon(probe, contours[j])) depth++
    }
    if (depth % 2 === 0) outer.push(contours[i])
    else inner.push(contours[i])
  }
  return { outer, inner }
}

// ============================================================================
// Glyph Extraction (memoized per character)
// ============================================================================

function buildGlyph(char: string): RegionGlyph {
  const font = getFont()
  const glyph = font.charToGlyph(char)

  // .notdef (index 0) — character not in the subset: blank gap, stable advance.
  if (!glyph || glyph.index === 0) {
    return { outer: [], inner: [], advance: FALLBACK_ADVANCE }
  }

  const advance = (glyph.advanceWidth ?? 0) * _scale
  const tolFont = FLATTEN_TOL_NORM / _scale
  const tol2 = tolFont * tolFont

  // Flatten the glyph outline (font units, y-up) into contours.
  const contours: Pt[][] = []
  let cur: Pt[] = []
  let start: Pt = [0, 0]
  let pen: Pt = [0, 0]
  for (const cmd of glyph.path.commands) {
    switch (cmd.type) {
      case 'M':
        if (cur.length >= 3) contours.push(cur)
        cur = [[cmd.x, cmd.y]]
        start = [cmd.x, cmd.y]
        pen = [cmd.x, cmd.y]
        break
      case 'L':
        cur.push([cmd.x, cmd.y])
        pen = [cmd.x, cmd.y]
        break
      case 'Q':
        flattenQuad(pen, [cmd.x1!, cmd.y1!], [cmd.x, cmd.y], tol2, cur)
        pen = [cmd.x, cmd.y]
        break
      case 'C':
        flattenCubic(pen, [cmd.x1!, cmd.y1!], [cmd.x2!, cmd.y2!], [cmd.x, cmd.y], tol2, cur)
        pen = [cmd.x, cmd.y]
        break
      case 'Z':
        if (cur.length >= 3) contours.push(cur)
        cur = []
        pen = start
        break
    }
  }
  if (cur.length >= 3) contours.push(cur)

  // Scale font units → normalized (cap height = 1.0).
  const scaled = contours.map(c => c.map(([x, y]): Pt => [x * _scale, y * _scale]))
  const { outer, inner } = classifyContours(scaled)
  return { outer, inner, advance }
}

function getRegionGlyph(char: string): RegionGlyph {
  let g = _glyphCache.get(char)
  if (!g) {
    g = buildGlyph(char)
    _glyphCache.set(char, g)
  }
  return g
}

// ============================================================================
// Text Measurement
// ============================================================================

/**
 * Total advance width of a string in normalized (cap-height) units. Multiply
 * by fontSize (mm) for the physical width. This is the single source of region
 * text metrics — shared by the Gerber emitter, panel-label positioning
 * (panelization-engine), and the preview (gerber-viewer).
 */
export function measureRegionText(text: string): number {
  if (!text) return 0
  let w = 0
  for (const ch of text) w += getRegionGlyph(ch).advance
  return w
}

// ============================================================================
// Text Layout (shared by Gerber emit + preview)
// ============================================================================

interface WorldPoly {
  points: { x: number; y: number }[]
}

interface LaidOutText {
  dark: WorldPoly[]
  clear: WorldPoly[]
}

/**
 * Transform a normalized character point to world (Gerber Y-up, mm) coordinates.
 * Applies alignment/char offset, mirroring, fontSize scaling, rotation, and
 * translation to the anchor — identical for export and preview.
 */
function transformPoint(
  localX: number,
  localY: number,
  charXOffset: number,
  alignOffsetNorm: number,
  perpOffsetNorm: number,
  fontSize: number,
  cosR: number,
  sinR: number,
  anchorX: number,
  anchorY: number,
  mirrored: boolean,
): { x: number; y: number } {
  let nx = alignOffsetNorm + charXOffset + localX
  const ny = perpOffsetNorm + localY
  if (mirrored) nx = -nx
  const mx = nx * fontSize
  const my = ny * fontSize
  const rx = mx * cosR - my * sinR
  const ry = mx * sinR + my * cosR
  return { x: rx + anchorX, y: ry + anchorY }
}

/** Lay out one or more InfoTexts into world-space dark/clear polygons. */
function layoutTexts(texts: InfoText[]): LaidOutText {
  const dark: WorldPoly[] = []
  const clear: WorldPoly[] = []

  for (const text of texts) {
    if (!text.text || text.text.length === 0) continue
    const fontSize = text.fontSize
    if (fontSize <= 0) continue

    const mirrored = text.mirrored || false

    // Alignment offset in normalized units (scaled with fontSize later).
    const textWidthNorm = measureRegionText(text.text)
    let alignOffsetNorm = 0
    if (text.align === 'center') {
      alignOffsetNorm = -textWidthNorm / 2
    } else if (text.align === 'right') {
      alignOffsetNorm = mirrored ? 0 : -textWidthNorm
    }

    // Center the cap height on the anchor perpendicular to reading direction.
    const perpOffsetNorm = -0.5

    const rotationRad = ((text.rotation || 0) * Math.PI) / 180
    const cosR = Math.cos(rotationRad)
    const sinR = Math.sin(rotationRad)

    let charX = 0
    for (const char of text.text) {
      const glyph = getRegionGlyph(char)
      const xform = (lx: number, ly: number) =>
        transformPoint(lx, ly, charX, alignOffsetNorm, perpOffsetNorm,
          fontSize, cosR, sinR, text.x, text.y, mirrored)

      for (const poly of glyph.outer) {
        if (poly.length < 3) continue
        dark.push({ points: poly.map(([px, py]) => xform(px, py)) })
      }
      for (const poly of glyph.inner) {
        if (poly.length < 3) continue
        clear.push({ points: poly.map(([px, py]) => xform(px, py)) })
      }
      charX += glyph.advance
    }
  }

  return { dark, clear }
}

/**
 * World-space (Gerber Y-up, mm) region polygons for a single InfoText — used by
 * the on-screen preview so it renders the exact glyphs that export. `outer`
 * fills solid; `inner` are counters to cut out (render with fill-rule evenodd).
 */
export function getRegionTextPolygons(text: InfoText): {
  outer: { x: number; y: number }[][]
  inner: { x: number; y: number }[][]
} {
  const { dark, clear } = layoutTexts([text])
  return {
    outer: dark.map(p => p.points),
    inner: clear.map(p => p.points),
  }
}

// ============================================================================
// Gerber Region Command Generation
// ============================================================================

/**
 * Generate Gerber region commands (G36/G37) for filled text with proper
 * counter (cutout) support via dark/clear polarity.
 */
export function generateRegionTextGerberCommands(
  texts: InfoText[],
  fmt: OutputFormat,
): string[] {
  const lines: string[] = []

  const validTexts = texts.filter(t => t.text && t.text.length > 0)
  if (validTexts.length === 0) return lines

  const f = (v: number) => formatCoordinate(v, fmt)
  const { dark, clear } = layoutTexts(validTexts)

  const emit = (poly: WorldPoly) => {
    lines.push('G36*')
    for (let i = 0; i < poly.points.length; i++) {
      const p = poly.points[i]
      lines.push(`X${f(p.x)}Y${f(p.y)}D0${i === 0 ? 2 : 1}*`)
    }
    const first = poly.points[0]
    lines.push(`X${f(first.x)}Y${f(first.y)}D01*`)
    lines.push('G37*')
  }

  // --- Dark (outer) fills ---
  if (dark.length > 0) {
    lines.push('%LPD*%')
    for (const poly of dark) emit(poly)
  }

  // --- Clear (counter) cutouts ---
  if (clear.length > 0) {
    lines.push('%LPC*%')
    for (const poly of clear) emit(poly)
    lines.push('%LPD*%') // reset to dark
  }

  return lines
}

/**
 * Check if a layer type should receive text shapes.
 * Copper, mask, and silkscreen layers get text. Paste layers do NOT.
 */
export function layerNeedsRegionText(layerType: string): boolean {
  return layerType === 'copper' || layerType === 'mask' || layerType === 'silk'
}
