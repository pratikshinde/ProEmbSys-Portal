/**
 * Region-Based Vector Font Engine for Gerber RS-274X Text Rendering
 *
 * Generates filled polygon regions (G36/G37) to render text as solid shapes,
 * matching CAM350's text rendering style. Characters are defined as high-fidelity
 * outlines with proper counter shapes (inner cutouts) using clear polarity.
 *
 * Architecture:
 *   - Each character has "outer" polygons (dark polarity, filled regions)
 *   - And optional "inner" polygons (clear polarity, cutout holes)
 *   - Rendering emits all dark regions first, then all clear regions
 *   - This matches CAM350's approach: LPD → outer shapes → LPC → counters → LPD
 *
 * Font design: Clean sans-serif characters in a normalized coordinate system
 * where width=0.6 and height=1.0. Curves are approximated with 8-12 line
 * segments per quarter-arc for smooth rendering matching production quality.
 */

import { InfoText, OutputFormat, formatCoordinate } from './panelization-engine'

// ============================================================================
// Font Constants
// ============================================================================

/** Normalized character cell width (fraction of character height) */
const CHAR_WIDTH = 0.6

/** Advance width between characters in character-height units */
const ADVANCE_WIDTH = 0.76

/** Stroke weight (fraction of character height) for thick-stroke outlines */
const SW = 0.12

// ============================================================================
// Geometry Helpers
// ============================================================================

/**
 * Generate points along a circular arc.
 * @param cx - Center X
 * @param cy - Center Y
 * @param r  - Radius
 * @param startDeg - Start angle in degrees (0 = right, 90 = up)
 * @param endDeg   - End angle in degrees
 * @param steps    - Number of line segments to approximate the arc
 */
function arc(
  cx: number, cy: number, r: number,
  startDeg: number, endDeg: number,
  steps: number = 8
): [number, number][] {
  const pts: [number, number][] = []
  for (let i = 0; i <= steps; i++) {
    const angle = ((startDeg + (endDeg - startDeg) * i / steps) * Math.PI) / 180
    pts.push([cx + r * Math.cos(angle), cy + r * Math.sin(angle)])
  }
  return pts
}

/**
 * Generate points along an elliptical arc.
 * @param cx - Center X
 * @param cy - Center Y
 * @param rx - Horizontal radius
 * @param ry - Vertical radius
 * @param startDeg - Start angle in degrees
 * @param endDeg   - End angle in degrees
 * @param steps    - Number of line segments
 */
function ellipseArc(
  cx: number, cy: number, rx: number, ry: number,
  startDeg: number, endDeg: number,
  steps: number = 10
): [number, number][] {
  const pts: [number, number][] = []
  for (let i = 0; i <= steps; i++) {
    const angle = ((startDeg + (endDeg - startDeg) * i / steps) * Math.PI) / 180
    pts.push([cx + rx * Math.cos(angle), cy + ry * Math.sin(angle)])
  }
  return pts
}

/**
 * Character definition with dark (filled) and clear (cutout) regions.
 */
interface CharDef {
  /** Outer boundary polygons — rendered with dark polarity (G36/G37 fill) */
  outer: [number, number][][]
  /** Inner counter polygons — rendered with clear polarity (cutout holes) */
  inner: [number, number][][]
}

// ============================================================================
// High-Fidelity Font Data
// ============================================================================

// Derived constants
const W = CHAR_WIDTH      // 0.6 — character cell width
const H = 1.0             // character cell height
const HW = W / 2          // 0.3 — horizontal center
const HH = H / 2          // 0.5 — vertical center
const S = SW              // stroke weight alias

// Common radii for rounded corners
const OR = 0.15           // outer corner radius
const IR = OR - S         // inner corner radius

/**
 * Build a full rounded-rectangle outline (outer boundary).
 * Goes counter-clockwise: bottom-left → bottom-right → top-right → top-left
 */
function roundedRect(
  x1: number, y1: number, x2: number, y2: number, r: number, steps: number = 6
): [number, number][] {
  const pts: [number, number][] = []
  // Bottom-left corner (arc from 180° to 270°)
  pts.push(...arc(x1 + r, y1 + r, r, 180, 270, steps))
  // Bottom-right corner (arc from 270° to 360°)
  pts.push(...arc(x2 - r, y1 + r, r, 270, 360, steps))
  // Top-right corner (arc from 0° to 90°)
  pts.push(...arc(x2 - r, y2 - r, r, 0, 90, steps))
  // Top-left corner (arc from 90° to 180°)
  pts.push(...arc(x1 + r, y2 - r, r, 90, 180, steps))
  return pts
}

/**
 * Build a full elliptical ring (for O, 0, D, etc.)
 */
function ellipseRing(
  cx: number, cy: number, rx: number, ry: number, steps: number = 24
): [number, number][] {
  return ellipseArc(cx, cy, rx, ry, 0, 360, steps)
}

// Build the font data programmatically for smooth curves
const REGION_FONT: Record<string, CharDef> = {} as Record<string, CharDef>

// ============================================================================
// UPPERCASE LETTERS A-Z
// ============================================================================

// --- A ---
REGION_FONT['A'] = {
  outer: [
    // Full A silhouette: two legs going up to a peak
    // Outer boundary traces: bottom-left → inner-left up to crossbar → across crossbar left →
    // up inner-left to peak → peak → down outer-right → bottom-right →
    // up inner-right to crossbar → across crossbar right → down inner-right
    [
      [0, 0], [S, 0],                                   // bottom-left outer → inner
      [HW - S * 0.3, H - S * 1.5],                      // inner left leg to near peak
      [HW, H],                                           // peak
      [HW + S * 0.3, H - S * 1.5],                      // inner right leg from peak
      [W - S, 0],                                        // inner right leg to bottom
      [W, 0],                                            // bottom-right outer
      [HW + S * 0.6, H],                                 // outer right to peak
      [HW, H + 0],                                       // peak top (same point)
      [HW - S * 0.6, H],                                 // outer left from peak
    ],
    // Crossbar
    [
      [0.12, 0.35], [0.48, 0.35], [0.48, 0.35 + S], [0.12, 0.35 + S]
    ]
  ],
  inner: [
    // Counter triangle (hole above crossbar between the legs)
    [
      [0.18, 0.35 + S],
      [HW, H - S * 2.0],
      [0.42, 0.35 + S],
    ]
  ]
}

// --- B ---
REGION_FONT['B'] = {
  outer: [
    // Left vertical + top bump + bottom bump as single outline
    [
      // Start bottom-left, go up
      [0, 0], [S, 0], [S, HH - S / 2],
      // Bottom bump inner
      ...arc(0.32, 0.13 + S, 0.13, 90, 0, 6),
      ...arc(0.32, HH - 0.13, 0.13, 0, -90, 6),
      [S, HH + S / 2],
      // Top bump inner
      ...arc(0.30, HH + 0.13 + S / 2, 0.13, 90, 0, 6),
      ...arc(0.30, H - 0.13 - S / 2, 0.13, 0, -90, 6),
      [S, H], [0, H],
      // Left side back down
      [0, 0],
    ],
    // Bottom bump outer
    [
      [S, 0], [0.35, 0],
      ...arc(0.35, 0.15, 0.15, -90, 0, 8),
      [0.50, 0.15],
      ...arc(0.35, HH - 0.15, 0.15, 0, 90, 8),
      [0.35, HH], [S, HH], [S, 0],
    ],
    // Top bump outer
    [
      [S, HH], [0.33, HH],
      ...arc(0.33, HH + 0.15, 0.15, -90, 0, 8),
      [0.48, HH + 0.15],
      ...arc(0.33, H - 0.15, 0.15, 0, 90, 8),
      [0.33, H], [S, H], [S, HH],
    ]
  ],
  inner: [
    // Bottom bump counter
    [
      [S + 0.03, S],
      [0.30, S],
      ...arc(0.30, S + 0.10, 0.10, -90, 0, 5),
      [0.40, S + 0.10],
      ...arc(0.30, HH - S - 0.10, 0.10, 0, 90, 5),
      [0.30, HH - S],
      [S + 0.03, HH - S],
    ],
    // Top bump counter
    [
      [S + 0.03, HH + S],
      [0.28, HH + S],
      ...arc(0.28, HH + S + 0.10, 0.10, -90, 0, 5),
      [0.38, HH + S + 0.10],
      ...arc(0.28, H - S - 0.10, 0.10, 0, 90, 5),
      [0.28, H - S],
      [S + 0.03, H - S],
    ]
  ]
}

// --- C ---
REGION_FONT['C'] = {
  outer: [
    [
      // Start at top-right tip of C
      ...ellipseArc(HW, HH, HW, HH, 40, 320, 24),
      // Trace inner path back up
      ...ellipseArc(HW, HH, HW - S, HH - S, 320, 40, 24),
    ]
  ],
  inner: []
}

// --- D ---
REGION_FONT['D'] = {
  outer: [
    [
      [0, 0], [0.35, 0],
      ...ellipseArc(0.35, HH, W - 0.35, HH, -90, 90, 16),
      [0.35, H], [0, H],
    ]
  ],
  inner: [
    [
      [S, S], [0.33, S],
      ...ellipseArc(0.33, HH, W - 0.33 - S, HH - S, -90, 90, 14),
      [0.33, H - S], [S, H - S],
    ]
  ]
}

// --- E ---
REGION_FONT['E'] = {
  outer: [
    [
      [0, 0], [W, 0], [W, S], [S, S],
      [S, HH - S / 2], [0.45, HH - S / 2], [0.45, HH + S / 2], [S, HH + S / 2],
      [S, H - S], [W, H - S], [W, H], [0, H],
    ]
  ],
  inner: []
}

// --- F ---
REGION_FONT['F'] = {
  outer: [
    [
      [0, 0], [S, 0], [S, HH - S / 2],
      [0.45, HH - S / 2], [0.45, HH + S / 2],
      [S, HH + S / 2], [S, H - S],
      [W, H - S], [W, H], [0, H],
    ]
  ],
  inner: []
}

// --- G ---
REGION_FONT['G'] = {
  outer: [
    [
      [W, 0.15],
      ...ellipseArc(HW, HH, HW, HH, -70, 260, 24),
      [W, 0.85], [W, HH], [0.35, HH], [0.35, HH - S],
      [W - S, HH - S], [W - S, 0.22],
      ...ellipseArc(HW, HH, HW - S, HH - S, -60, 250, 20),
      [W - S, 0.78],
    ]
  ],
  inner: []
}

// --- H ---
REGION_FONT['H'] = {
  outer: [
    // Left vertical
    [[0, 0], [S, 0], [S, H], [0, H]],
    // Right vertical
    [[W - S, 0], [W, 0], [W, H], [W - S, H]],
    // Crossbar
    [[S, HH - S / 2], [W - S, HH - S / 2], [W - S, HH + S / 2], [S, HH + S / 2]],
  ],
  inner: []
}

// --- I ---
REGION_FONT['I'] = {
  outer: [
    [[HW - S / 2, 0], [HW + S / 2, 0], [HW + S / 2, H], [HW - S / 2, H]],
    // Top serif
    [[0.12, H - S], [0.48, H - S], [0.48, H], [0.12, H]],
    // Bottom serif
    [[0.12, 0], [0.48, 0], [0.48, S], [0.12, S]],
  ],
  inner: []
}

// --- J ---
REGION_FONT['J'] = {
  outer: [
    [
      // Bottom curve
      ...arc(HW, 0.18, 0.18, 180, 360, 10),
      [HW + 0.18, H], [HW + 0.18 - S, H],
      [HW + 0.18 - S, 0.22],
      ...arc(HW, 0.18, 0.18 - S, 360, 180, 10),
      [HW - 0.18, 0.18],
    ],
    // Top serif
    [[0.15, H - S], [W - 0.05, H - S], [W - 0.05, H], [0.15, H]],
  ],
  inner: []
}

// --- K ---
REGION_FONT['K'] = {
  outer: [
    // Left vertical
    [[0, 0], [S, 0], [S, H], [0, H]],
    // Upper diagonal
    [
      [S, HH + S / 2], [S, HH - S / 2],
      [W, H], [W - S * 1.2, H],
    ],
    // Lower diagonal
    [
      [S, HH + S / 2], [S, HH - S / 2],
      [W - S * 1.2, 0], [W, 0],
    ],
  ],
  inner: []
}

// --- L ---
REGION_FONT['L'] = {
  outer: [
    [[0, 0], [W, 0], [W, S], [S, S], [S, H], [0, H]],
  ],
  inner: []
}

// --- M ---
REGION_FONT['M'] = {
  outer: [
    [
      [0, 0], [S, 0], [S, H - S * 2],
      [HW, S * 3], [W - S, H - S * 2],
      [W - S, 0], [W, 0], [W, H],
      [W - S * 0.8, H],
      [HW, S * 4 + S],
      [S * 0.8, H],
      [0, H],
    ]
  ],
  inner: []
}

// --- N ---
REGION_FONT['N'] = {
  outer: [
    [
      [0, 0], [S, 0], [S, H - S * 3],
      [W - S, S * 0.5],
      [W - S, 0], [W, 0], [W, H],
      [W - S, H], [W - S, S * 3],
      [S, H - S * 0.5],
      [S, H], [0, H],
    ]
  ],
  inner: []
}

// --- O ---
REGION_FONT['O'] = {
  outer: [
    ellipseRing(HW, HH, HW, HH, 32),
  ],
  inner: [
    ellipseRing(HW, HH, HW - S, HH - S, 28),
  ]
}

// --- P ---
REGION_FONT['P'] = {
  outer: [
    [
      [0, 0], [S, 0], [S, HH],
      [0.33, HH],
      ...ellipseArc(0.33, 0.75, W - 0.33, 0.25, -90, 90, 12),
      [0.33, H], [0, H],
    ]
  ],
  inner: [
    [
      [S, HH + S],
      [0.30, HH + S],
      ...ellipseArc(0.30, 0.75, W - 0.30 - S, 0.25 - S, -90, 90, 10),
      [0.30, H - S],
      [S, H - S],
    ]
  ]
}

// --- Q ---
REGION_FONT['Q'] = {
  outer: [
    ellipseRing(HW, HH, HW, HH, 32),
    // Tail diagonal
    [[0.35, 0.15], [0.50, 0.0], [W + 0.02, 0.0], [0.48, 0.18]],
  ],
  inner: [
    ellipseRing(HW, HH, HW - S, HH - S, 28),
  ]
}

// --- R ---
REGION_FONT['R'] = {
  outer: [
    [
      [0, 0], [S, 0], [S, HH],
      [0.33, HH],
      ...ellipseArc(0.33, 0.75, W - 0.33, 0.25, -90, 90, 12),
      [0.33, H], [0, H],
    ],
    // Leg
    [
      [0.25, HH], [0.25 + S * 1.2, HH],
      [W, 0], [W - S * 1.2, 0],
    ]
  ],
  inner: [
    [
      [S, HH + S],
      [0.30, HH + S],
      ...ellipseArc(0.30, 0.75, W - 0.30 - S, 0.25 - S, -90, 90, 10),
      [0.30, H - S],
      [S, H - S],
    ]
  ]
}

// --- S ---
REGION_FONT['S'] = {
  outer: [
    // Top C-shape (passes through left edge)
    [...ellipseArc(HW, 0.75, HW, 0.25, 45, 240, 16), ...ellipseArc(HW, 0.75, HW - S, 0.25 - S, 240, 45, 14)],
    // Bottom C-shape (passes through right edge)
    [...ellipseArc(HW, 0.25, HW, 0.25, 225, 405, 16), ...ellipseArc(HW, 0.25, HW - S, 0.25 - S, 405, 225, 14)],
    // Thick center diagonal bridge bridging top curve to bottom curve
    [[0.12, 0.48], [0.48, 0.38], [0.48, 0.52], [0.12, 0.62]]
  ],
  inner: []
}

// --- T ---
REGION_FONT['T'] = {
  outer: [
    // Top horizontal bar
    [[0, H - S], [W, H - S], [W, H], [0, H]],
    // Vertical stem
    [[HW - S / 2, 0], [HW + S / 2, 0], [HW + S / 2, H - S], [HW - S / 2, H - S]],
  ],
  inner: []
}

// --- U ---
REGION_FONT['U'] = {
  outer: [
    [
      [0, H], [0, 0.22],
      ...ellipseArc(HW, 0.22, HW, 0.22, 180, 360, 14),
      [W, H],
      [W - S, H], [W - S, 0.25],
      ...ellipseArc(HW, 0.25, HW - S, 0.22 - S + 0.03, 360, 180, 12),
      [S, H],
    ]
  ],
  inner: []
}

// --- V ---
REGION_FONT['V'] = {
  outer: [
    [
      [0, H], [S * 0.6, H],
      [HW, S * 0.5],
      [W - S * 0.6, H], [W, H],
      [HW + S * 0.6, 0],
      [HW - S * 0.6, 0],
    ]
  ],
  inner: []
}

// --- W ---
REGION_FONT['W'] = {
  outer: [
    [
      [0, H], [S * 0.5, H],
      [0.15, S * 0.5],
      [HW, H * 0.6],
      [W - 0.15, S * 0.5],
      [W - S * 0.5, H], [W, H],
      [W - 0.15 + S * 0.4, 0],
      [HW, H * 0.6 - S * 1.5],
      [0.15 - S * 0.4, 0],
    ]
  ],
  inner: []
}

// --- X ---
REGION_FONT['X'] = {
  outer: [
    // Forward diagonal (bottom-left to top-right)
    [
      [0, 0], [S * 1.0, 0],
      [W, H], [W - S * 1.0, H],
    ],
    // Backward diagonal (top-left to bottom-right)
    [
      [0, H], [S * 1.0, H],
      [W, 0], [W - S * 1.0, 0],
    ],
  ],
  inner: []
}

// --- Y ---
REGION_FONT['Y'] = {
  outer: [
    // Upper V portion
    [
      [0, H], [S * 0.7, H],
      [HW, HH + S * 0.5],
      [W - S * 0.7, H], [W, H],
      [HW + S / 2, HH - S * 0.2],
      [HW + S / 2, 0], [HW - S / 2, 0],
      [HW - S / 2, HH - S * 0.2],
    ]
  ],
  inner: []
}

// --- Z ---
REGION_FONT['Z'] = {
  outer: [
    [
      [0, 0], [W, 0], [W, S],
      [S * 1.5, H - S],
      [W, H - S], [W, H], [0, H], [0, H - S],
      [W - S * 1.5, S],
      [0, S],
    ]
  ],
  inner: []
}

// ============================================================================
// DIGITS 0-9
// ============================================================================

// --- 0 ---
REGION_FONT['0'] = {
  outer: [
    ellipseRing(HW, HH, HW, HH, 32),
  ],
  inner: [
    ellipseRing(HW, HH, HW - S, HH - S, 28),
  ]
}

// --- 1 ---
REGION_FONT['1'] = {
  outer: [
    // Vertical stem
    [[HW - S / 2, 0], [HW + S / 2, 0], [HW + S / 2, H], [HW - S / 2, H]],
    // Hook at top
    [[HW - S / 2 - 0.08, H - S * 2], [HW - S / 2, H - S * 2], [HW - S / 2, H], [HW - S / 2 - 0.08, H]],
    // Bottom base
    [[0.10, 0], [0.50, 0], [0.50, S], [0.10, S]],
  ],
  inner: []
}

// --- 2 ---
REGION_FONT['2'] = {
  outer: [
    [
      [0, 0], [W, 0], [W, S],
      [S * 1.2, S],
      // Diagonal up to right
      [W - S, HH + 0.05],
      // Upper curve outer
      ...ellipseArc(HW, H - 0.22, HW - 0.02, 0.22, 0, 180, 12),
      [0.02, H - 0.22],
      // Inner curve
      ...ellipseArc(HW, H - 0.22, HW - 0.02 - S, 0.22 - S, 180, 0, 10),
      [W - S * 1.5, HH + S],
      // Back diagonal
      [0, S + S],
      [0, 0],
    ]
  ],
  inner: []
}

// --- 3 ---
REGION_FONT['3'] = {
  outer: [
    [
      // Start bottom-left
      [0.02, 0.15],
      ...ellipseArc(HW, 0.25, HW - 0.02, 0.25, 190, 350, 10),
      [W, 0.25],
      // To middle
      ...ellipseArc(HW + 0.05, HH, 0.18, 0.12, -30, 30, 6),
      // Upper bump
      ...ellipseArc(HW, H - 0.25, HW - 0.02, 0.25, 350, 190, 10),
      // back
      [0.02, H - 0.15],
      ...ellipseArc(HW, H - 0.25, HW - 0.02 - S, 0.25 - S, 170, 350, 8),
      // Inner middle
      ...ellipseArc(HW + 0.05, HH, 0.18 - S, 0.12 - S * 0.8, 30, -30, 5),
      // Inner lower
      ...ellipseArc(HW, 0.25, HW - 0.02 - S, 0.25 - S, 350, 190, 8),
    ]
  ],
  inner: []
}

// --- 4 ---
REGION_FONT['4'] = {
  outer: [
    // Vertical stem (right)
    [[W - 0.20 - S / 2, 0], [W - 0.20 + S / 2, 0], [W - 0.20 + S / 2, H], [W - 0.20 - S / 2, H]],
    // Horizontal crossbar
    [[0, 0.35], [W, 0.35], [W, 0.35 + S], [0, 0.35 + S]],
    // Diagonal left portion
    [
      [0, 0.35 + S], [0, 0.35],
      [W - 0.20 - S / 2, H], [W - 0.20 - S / 2, H - S * 0.8],
    ],
  ],
  inner: []
}

// --- 5 ---
REGION_FONT['5'] = {
  outer: [
    [
      // Start bottom-right
      [W - 0.02, 0.12],
      // Lower bowl outer
      ...ellipseArc(HW, 0.28, HW - 0.02, 0.28, -20, 180, 14),
      // Up the left side
      [0, 0.28], [0, H], [W, H], [W, H - S], [S, H - S],
      [S, HH + S * 0.5],
      // Corner to inner bowl
      ...ellipseArc(HW, 0.28, HW - 0.02 - S, 0.28 - S, 180, -20, 12),
      [W - 0.02 - S, 0.18],
    ]
  ],
  inner: []
}

// --- 6 ---
REGION_FONT['6'] = {
  outer: [
    [
      // Full outer shape
      ...ellipseArc(HW, HH, HW, HH, 270, 270 + 360, 32),
    ]
  ],
  inner: [
    [
      // Inner cutout — only the bottom half (lower bowl)
      ...ellipseArc(HW, 0.28, HW - S, 0.28 - S, 0, 360, 20),
    ]
  ]
}

// --- 7 ---
REGION_FONT['7'] = {
  outer: [
    [
      // Top bar + diagonal
      [0, H], [W, H], [W, H - S],
      [S * 2.0, 0], [0, 0],
      [W - S * 2.0, H - S],
      [0, H - S],
    ]
  ],
  inner: []
}

// --- 8 ---
REGION_FONT['8'] = {
  outer: [
    // Upper loop
    [
      ...ellipseArc(HW, H - 0.22, HW - 0.02, 0.22, 0, 360, 20),
    ],
    // Lower loop
    [
      ...ellipseArc(HW, 0.25, HW, 0.25, 0, 360, 20),
    ],
  ],
  inner: [
    // Upper counter
    [
      ...ellipseArc(HW, H - 0.22, HW - 0.02 - S, 0.22 - S, 0, 360, 16),
    ],
    // Lower counter
    [
      ...ellipseArc(HW, 0.25, HW - S, 0.25 - S, 0, 360, 16),
    ],
  ]
}

// --- 9 ---
REGION_FONT['9'] = {
  outer: [
    [
      ...ellipseArc(HW, HH, HW, HH, 90, 90 + 360, 32),
    ]
  ],
  inner: [
    [
      // Inner cutout — only the upper half (upper bowl)
      ...ellipseArc(HW, H - 0.28, HW - S, 0.28 - S, 0, 360, 20),
    ]
  ]
}

// ============================================================================
// SYMBOLS
// ============================================================================

REGION_FONT[' '] = { outer: [], inner: [] }

REGION_FONT['-'] = {
  outer: [
    [[0.08, HH - S / 2], [W - 0.08, HH - S / 2], [W - 0.08, HH + S / 2], [0.08, HH + S / 2]],
  ],
  inner: []
}

REGION_FONT['_'] = {
  outer: [
    [[0, 0], [W, 0], [W, S], [0, S]],
  ],
  inner: []
}

REGION_FONT[' '] = { outer: [], inner: [] }
REGION_FONT['.'] = {
  outer: [
    [[HW - S / 2, 0], [HW + S / 2, 0], [HW + S / 2, S], [HW - S / 2, S]],
  ],
  inner: []
}

REGION_FONT[','] = {
  outer: [
    [
      [HW - S / 2, S], [HW + S / 2, S], [HW + S / 2, S + S],
      [HW - S / 2, S + S], [HW - S / 2, S],
    ],
    [
      [HW - S / 2, -S * 0.5], [HW + S / 2, S],
      [HW - S / 2, S],
    ],
  ],
  inner: []
}

REGION_FONT[':'] = {
  outer: [
    [[HW - S / 2, 0.15], [HW + S / 2, 0.15], [HW + S / 2, 0.15 + S], [HW - S / 2, 0.15 + S]],
    [[HW - S / 2, 0.65], [HW + S / 2, 0.65], [HW + S / 2, 0.65 + S], [HW - S / 2, 0.65 + S]],
  ],
  inner: []
}

REGION_FONT['/'] = {
  outer: [
    [[0, 0], [S * 0.8, 0], [W, H], [W - S * 0.8, H]],
  ],
  inner: []
}

REGION_FONT['('] = {
  outer: [
    [
      ...arc(0.45, HH, 0.35, 120, 240, 12),
      ...arc(0.45, HH, 0.35 - S, 240, 120, 10),
    ],
  ],
  inner: []
}

REGION_FONT[')'] = {
  outer: [
    [
      ...arc(0.15, HH, 0.35, -60, 60, 12),
      ...arc(0.15, HH, 0.35 - S, 60, -60, 10),
    ],
  ],
  inner: []
}

REGION_FONT['!'] = {
  outer: [
    // Vertical stroke
    [[HW - S / 2, S + S * 1.5], [HW + S / 2, S + S * 1.5], [HW + S / 2, H], [HW - S / 2, H]],
    // Dot at bottom
    [[HW - S / 2, 0], [HW + S / 2, 0], [HW + S / 2, S], [HW - S / 2, S]],
  ],
  inner: []
}

REGION_FONT['?'] = {
  outer: [
    [
      // Upper curve
      ...ellipseArc(HW, H - 0.25, HW - 0.02, 0.25, 190, 360, 10),
      // Down to vertical stem
      [W - 0.02, H - 0.25],
      [W - 0.02, HH + S * 1.5],
      [HW + S / 2, HH + S * 0.5],
      [HW + S / 2, S + S * 1.5],
      [HW - S / 2, S + S * 1.5],
      [HW - S / 2, HH + S * 1.5],
      [W - 0.02 - S, HH + S * 2.5],
      [W - 0.02 - S, H - 0.25],
      ...ellipseArc(HW, H - 0.25, HW - 0.02 - S, 0.25 - S, 360, 190, 8),
    ],
    // Bottom dot
    [[HW - S / 2, 0], [HW + S / 2, 0], [HW + S / 2, S], [HW - S / 2, S]],
  ],
  inner: []
}

REGION_FONT['+'] = {
  outer: [
    // Horizontal bar
    [[0.05, HH - S / 2], [W - 0.05, HH - S / 2], [W - 0.05, HH + S / 2], [0.05, HH + S / 2]],
    // Vertical bar
    [[HW - S / 2, 0.10], [HW + S / 2, 0.10], [HW + S / 2, 0.90], [HW - S / 2, 0.90]],
  ],
  inner: []
}

REGION_FONT['='] = {
  outer: [
    [[0.05, 0.35], [W - 0.05, 0.35], [W - 0.05, 0.35 + S], [0.05, 0.35 + S]],
    [[0.05, 0.55], [W - 0.05, 0.55], [W - 0.05, 0.55 + S], [0.05, 0.55 + S]],
  ],
  inner: []
}

REGION_FONT['|'] = {
  outer: [
    [[HW - S / 2, 0], [HW + S / 2, 0], [HW + S / 2, H], [HW - S / 2, H]],
  ],
  inner: []
}

REGION_FONT['#'] = {
  outer: [
    // Two vertical bars
    [[0.15, 0.05], [0.15 + S * 0.7, 0.05], [0.15 + S * 0.7, 0.95], [0.15, 0.95]],
    [[W - 0.15 - S * 0.7, 0.05], [W - 0.15, 0.05], [W - 0.15, 0.95], [W - 0.15 - S * 0.7, 0.95]],
    // Two horizontal bars
    [[0.03, 0.30], [W - 0.03, 0.30], [W - 0.03, 0.30 + S * 0.7], [0.03, 0.30 + S * 0.7]],
    [[0.03, 0.60], [W - 0.03, 0.60], [W - 0.03, 0.60 + S * 0.7], [0.03, 0.60 + S * 0.7]],
  ],
  inner: []
}

REGION_FONT['*'] = {
  outer: [
    // Vertical bar
    [[HW - S * 0.4, 0.35], [HW + S * 0.4, 0.35], [HW + S * 0.4, 0.85], [HW - S * 0.4, 0.85]],
    // Forward diagonal
    [[0.08, 0.42], [0.08 + S * 0.5, 0.38], [W - 0.08, 0.78], [W - 0.08 - S * 0.5, 0.82]],
    // Backward diagonal
    [[0.08, 0.78], [0.08 + S * 0.5, 0.82], [W - 0.08, 0.42], [W - 0.08 - S * 0.5, 0.38]],
  ],
  inner: []
}

REGION_FONT['@'] = {
  outer: [
    ellipseRing(HW, HH, HW, HH, 28),
  ],
  inner: [
    ellipseRing(HW, HH, HW - S, HH - S, 24),
  ]
}

REGION_FONT['%'] = {
  outer: [
    // Diagonal
    [[0, 0], [S * 0.8, 0], [W, H], [W - S * 0.8, H]],
    // Top circle
    arc(0.15, H - 0.18, 0.10, 0, 360, 12),
    // Bottom circle
    arc(W - 0.15, 0.18, 0.10, 0, 360, 12),
  ],
  inner: [
    arc(0.15, H - 0.18, 0.10 - S * 0.5, 0, 360, 10),
    arc(W - 0.15, 0.18, 0.10 - S * 0.5, 0, 360, 10),
  ]
}

// Lowercase aliases — map to uppercase
REGION_FONT['x'] = REGION_FONT['X']

// ============================================================================
// Text Measurement Functions
// ============================================================================

/**
 * Calculate the total width of a text string in character-height units.
 */
function measureTextWidth(text: string): number {
  if (!text || text.length === 0) return 0
  // All characters advance by ADVANCE_WIDTH, total width is (n-1)*advance + charWidth
  return (text.length - 1) * ADVANCE_WIDTH + CHAR_WIDTH
}

// ============================================================================
// Region-Based Text Generation
// ============================================================================

/**
 * Transform a local character coordinate to world coordinates.
 * Applies fontSize scaling, alignment offset, rotation, and translation.
 *
 * @param localX - Character-space X (in normalized units, 0..CHAR_WIDTH)
 * @param localY - Character-space Y (in normalized units, 0..1.0)
 * @param charXOffset - X offset for this character's position (in normalized units)
 * @param alignOffsetNorm - Alignment offset in normalized units (NOT mm)
 * @param perpOffsetNorm - Perpendicular centering offset in normalized units
 * @param fontSize - Scale factor (normalized → mm)
 * @param cosR - Precomputed cos(rotation)
 * @param sinR - Precomputed sin(rotation)
 * @param anchorX - Text anchor X in mm
 * @param anchorY - Text anchor Y in mm
 * @param mirrored - Whether to mirror the text horizontally
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
  // 1. Position in normalized coordinate space (with char offset + alignment)
  let nx = alignOffsetNorm + charXOffset + localX
  let ny = perpOffsetNorm + localY

  // 2. Mirror if needed (flip X around the center of the text)
  if (mirrored) nx = -nx

  // 3. Scale from normalized units to mm
  const mx = nx * fontSize
  const my = ny * fontSize

  // 4. Apply rotation
  const rx = mx * cosR - my * sinR
  const ry = mx * sinR + my * cosR

  // 5. Translate to world position
  return {
    x: rx + anchorX,
    y: ry + anchorY,
  }
}

/**
 * Generate Gerber region commands for text using filled polygons with
 * proper counter (cutout) support.
 *
 * Architecture matches CAM350 sample text:
 *   1. Emit all outer (dark) polygons for all characters → LPD + G36/G37
 *   2. Emit all inner (clear/counter) polygons for all characters → LPC + G36/G37
 *   3. Reset to LPD
 *
 * @param texts - Array of text items to render
 * @param fmt - Output format specification
 * @returns Array of Gerber command strings
 */
export function generateRegionTextGerberCommands(
  texts: InfoText[],
  fmt: OutputFormat
): string[] {
  const lines: string[] = []

  if (texts.length === 0) return lines

  const validTexts = texts.filter(t => t.text && t.text.length > 0)
  if (validTexts.length === 0) return lines

  const f = (v: number) => formatCoordinate(v, fmt)

  // Collect dark and clear polygons separately
  const darkPolygons: { points: { x: number; y: number }[] }[] = []
  const clearPolygons: { points: { x: number; y: number }[] }[] = []

  for (const text of validTexts) {
    const fontSize = text.fontSize
    if (fontSize <= 0) continue

    const mirrored = text.mirrored || false

    // Compute alignment offset in NORMALIZED units (not mm)
    // This ensures proper scaling when fontSize is applied
    const textWidthNorm = measureTextWidth(text.text)
    let alignOffsetNorm = 0
    if (text.align === 'center') {
      alignOffsetNorm = -textWidthNorm / 2
    } else if (text.align === 'right') {
      alignOffsetNorm = -textWidthNorm
      // For mirrored right-aligned text, flip the alignment offset sign
      // This ensures text extends in the correct direction from the anchor
      if (mirrored) {
        alignOffsetNorm = 0
      }
    }

    // Perpendicular centering offset (centers text height on anchor)
    const perpOffsetNorm = -0.5

    const rotation = text.rotation || 0
    const rotationRad = (rotation * Math.PI) / 180
    const cosR = Math.cos(rotationRad)
    const sinR = Math.sin(rotationRad)

    // Process each character
    let currentCharX = 0  // in normalized units

    for (const char of text.text) {
      const charDef = REGION_FONT[char] || REGION_FONT[char.toUpperCase()]

      if (!charDef) {
        currentCharX += ADVANCE_WIDTH
        continue
      }

      // Transform a local char point to world coordinates
      const xform = (lx: number, ly: number) =>
        transformPoint(lx, ly, currentCharX, alignOffsetNorm, perpOffsetNorm,
          fontSize, cosR, sinR, text.x, text.y, mirrored)

      // Collect dark (outer) polygons
      for (const poly of charDef.outer) {
        if (poly.length < 3) continue
        const worldPts = poly.map(([px, py]) => xform(px, py))
        darkPolygons.push({ points: worldPts })
      }

      // Collect clear (inner/counter) polygons
      for (const poly of charDef.inner) {
        if (poly.length < 3) continue
        const worldPts = poly.map(([px, py]) => xform(px, py))
        clearPolygons.push({ points: worldPts })
      }

      currentCharX += ADVANCE_WIDTH
    }
  }

  // --- Emit dark polygons ---
  if (darkPolygons.length > 0) {
    // Ensure dark polarity (usually already active, but be explicit)
    lines.push('%LPD*%')

    for (const poly of darkPolygons) {
      lines.push('G36*')
      for (let i = 0; i < poly.points.length; i++) {
        const p = poly.points[i]
        if (i === 0) {
          lines.push(`X${f(p.x)}Y${f(p.y)}D02*`)
        } else {
          lines.push(`X${f(p.x)}Y${f(p.y)}D01*`)
        }
      }
      // Close back to first point
      const first = poly.points[0]
      lines.push(`X${f(first.x)}Y${f(first.y)}D01*`)
      lines.push('G37*')
    }
  }

  // --- Emit clear counter polygons ---
  if (clearPolygons.length > 0) {
    lines.push('%LPC*%')

    for (const poly of clearPolygons) {
      lines.push('G36*')
      for (let i = 0; i < poly.points.length; i++) {
        const p = poly.points[i]
        if (i === 0) {
          lines.push(`X${f(p.x)}Y${f(p.y)}D02*`)
        } else {
          lines.push(`X${f(p.x)}Y${f(p.y)}D01*`)
        }
      }
      // Close back to first point
      const first = poly.points[0]
      lines.push(`X${f(first.x)}Y${f(first.y)}D01*`)
      lines.push('G37*')
    }

    // Reset to dark polarity
    lines.push('%LPD*%')
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
