/**
 * Meta-panelization: tiling multiple copies of an already-computed `Panel`
 * (the existing Panel Config tab's rows x cols grid of PCBs) across a bigger
 * raw-material sheet, for a CNC workflow this shop actually uses:
 *
 *   1. Rout `Border_Marks.gbr`'s L-shape corner marks into a blank sacrificial
 *      spoiler board first — one L per corner of every panel-array cell.
 *   2. Place each already-fabricated panel copy on the bed, registering its
 *      corners against the scored marks, and tape it down.
 *   3. Run ONE batch drilling program that drills every copy's component
 *      holes (+ tooling/reference holes) in a single pass, instead of
 *      drilling each panel individually — the whole point of tiling multiple
 *      panels being that drilling only needs the panel present on the bed,
 *      not yet routed/depanelled.
 *
 * Deliberately independent of `RoutingResult`/the Routing tab: mark-routing
 * and batch drilling only need a computed `PanelResult` (for the cell size)
 * plus the customer's own drill layers — routing/depanelling each panel copy
 * into individual PCBs is a separate, later, per-panel step using the
 * existing Routing tab, not something this feature does.
 *
 * Pure functions only: no store, no React, no I/O — mirrors `routing/geometry.ts`.
 */

import type { Pt } from './routing/types'
import { formatCoordinate, generateFSCommand, generateMOCommand, type OutputFormat } from './panelization-engine'

/**
 * ⚠ DELIBERATELY FLAT, same discipline as `RoutingConfig` — `updatePanelArrayConfig`
 * is a shallow merge in the store.
 */
export interface PanelArrayConfig {
  enabled: boolean
  /** CNC machine's maximum travel, mm. A hard cap independent of the material sheet. */
  cncMaxXmm: number
  cncMaxYmm: number
  /** Raw material sheet size on hand, mm. The array must fit within BOTH this
   *  and the CNC's travel limit — whichever is smaller per axis. */
  materialXmm: number
  materialYmm: number
  /** Gap between adjacent panel-array cells, mm — needs to clear the router
   *  bit that will eventually depanel each copy individually, plus leave room
   *  for its own corner marks (see `effectiveMarkArmLengthMm` below). */
  arrayGapXmm: number
  arrayGapYmm: number
  /** Margin from the sheet/CNC-travel edge to the first row/column, mm. */
  sheetMarginMm: number
  /** L-shape corner mark arm length, mm — same convention as `PanelConfig.lShapeArmLength`. */
  markArmLengthMm: number
  markLineWidthMm: number
  /** Cut depth for milling the corner marks into the SACRIFICIAL board, mm
   *  (negative, below the work surface) — deliberately separate from
   *  `GcodeContext.cutDepthMm`, which is calibrated for cutting through the
   *  customer's own board + backer, not scoring a spoiler board. */
  markCutDepthMm: number
}

export const DEFAULT_PANEL_ARRAY_CONFIG: PanelArrayConfig = {
  enabled: false,
  cncMaxXmm: 600,
  cncMaxYmm: 500,
  materialXmm: 300,
  materialYmm: 300,
  arrayGapXmm: 10,
  arrayGapYmm: 10,
  sheetMarginMm: 5,
  markArmLengthMm: 5,
  markLineWidthMm: 0.254,
  markCutDepthMm: -1.5,
}

export interface PanelArrayCell {
  col: number
  row: number
  /** Bottom-left corner of this panel copy, sheet-absolute Gerber Y-up mm. */
  x: number
  y: number
}

export interface PanelArrayResult {
  cols: number
  rows: number
  cellWidthMm: number
  cellHeightMm: number
  /** Bounding size of the full array including margins, mm. */
  sheetWidthMm: number
  sheetHeightMm: number
  cells: PanelArrayCell[]
  totalPanels: number
  /**
   * The corner-mark arm length actually used — `config.markArmLengthMm`
   * clamped to at most half of each gap (and half of the cell's own
   * dimensions, for a degenerately small cell). This is what keeps each
   * cell's marks confined to its own corner instead of visually overlapping
   * a neighbour's: rather than special-casing "shared" T/+ mark shapes at
   * interior grid intersections, the arm is simply never allowed to reach
   * far enough to cross into the gap far enough to clutter it. Every cell
   * still gets its own independent, complete 4-corner mark set (identical
   * math to `generatePanelBorderLShapeGerberCommands`), which stays flush
   * with that panel's real corner — the whole point of a registration mark.
   */
  effectiveMarkArmLengthMm: number
}

/**
 * How many copies of a `pcbWidthMm` x `pcbHeightMm` panel fit in a grid,
 * bounded by BOTH the CNC's travel limit and the material sheet on hand
 * (whichever is smaller per axis), with `sheetMarginMm` clearance from the
 * outer edge and `arrayGapXmm`/`arrayGapYmm` between cells.
 *
 * Returns null if nothing fits (even a single copy) — callers must not guess
 * a plausible-but-wrong layout, same fabrication-honesty rule the routing
 * engine follows for a failed contour trace.
 */
export function computePanelArray(
  panelWidthMm: number,
  panelHeightMm: number,
  config: PanelArrayConfig
): PanelArrayResult | null {
  if (panelWidthMm <= 0 || panelHeightMm <= 0) return null

  const boundX = Math.min(config.cncMaxXmm, config.materialXmm)
  const boundY = Math.min(config.cncMaxYmm, config.materialYmm)

  // "n items + (n-1) gaps fit in the available span" solved for n.
  const availX = boundX - 2 * config.sheetMarginMm + config.arrayGapXmm
  const availY = boundY - 2 * config.sheetMarginMm + config.arrayGapYmm
  const cols = Math.floor(availX / (panelWidthMm + config.arrayGapXmm))
  const rows = Math.floor(availY / (panelHeightMm + config.arrayGapYmm))
  if (cols < 1 || rows < 1) return null

  const cells: PanelArrayCell[] = []
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      cells.push({
        col,
        row,
        x: config.sheetMarginMm + col * (panelWidthMm + config.arrayGapXmm),
        y: config.sheetMarginMm + row * (panelHeightMm + config.arrayGapYmm),
      })
    }
  }

  const sheetWidthMm = cols * panelWidthMm + (cols - 1) * config.arrayGapXmm + 2 * config.sheetMarginMm
  const sheetHeightMm = rows * panelHeightMm + (rows - 1) * config.arrayGapYmm + 2 * config.sheetMarginMm

  const effectiveMarkArmLengthMm = Math.max(0, Math.min(
    config.markArmLengthMm,
    config.arrayGapXmm / 2,
    config.arrayGapYmm / 2,
    panelWidthMm / 2,
    panelHeightMm / 2
  ))

  return {
    cols, rows,
    cellWidthMm: panelWidthMm, cellHeightMm: panelHeightMm,
    sheetWidthMm, sheetHeightMm,
    cells,
    totalPanels: cols * rows,
    effectiveMarkArmLengthMm,
  }
}

/**
 * One 3-point polyline per corner of every array cell, sheet-absolute mm —
 * the array-level generalisation of `generatePanelBorderLShapeGerberCommands`'s
 * per-corner pattern (bottom-left: `(arm,0) -> (0,0) -> (0,arm)`, etc.),
 * just translated to each cell's own origin instead of a single panel's.
 *
 * Returned as connected 3-point paths (not 6 loose 2-point segments) so both
 * the Gerber emitter and the mark-routing G-code can walk each corner as one
 * continuous draw/cut — one pen-down/plunge per corner, matching how a real
 * router would actually cut it.
 */
export function generateBorderMarkPaths(array: PanelArrayResult): Pt[][] {
  const arm = array.effectiveMarkArmLengthMm
  if (arm <= 0) return []
  const w = array.cellWidthMm
  const h = array.cellHeightMm

  const paths: Pt[][] = []
  for (const cell of array.cells) {
    const ox = cell.x
    const oy = cell.y
    // Bottom-left
    paths.push([{ x: ox + arm, y: oy }, { x: ox, y: oy }, { x: ox, y: oy + arm }])
    // Bottom-right
    paths.push([{ x: ox + w - arm, y: oy }, { x: ox + w, y: oy }, { x: ox + w, y: oy + arm }])
    // Top-right
    paths.push([{ x: ox + w, y: oy + h - arm }, { x: ox + w, y: oy + h }, { x: ox + w - arm, y: oy + h }])
    // Top-left
    paths.push([{ x: ox + arm, y: oy + h }, { x: ox, y: oy + h }, { x: ox, y: oy + h - arm }])
  }
  return paths
}

/** One diameter-grouped hole list, tiled across every array cell by simple translation. */
export function tileHolesAcrossArray(
  groups: { diameterMm: number; holes: { x: number; y: number }[] }[],
  array: PanelArrayResult
): { diameterMm: number; holes: { x: number; y: number }[] }[] {
  return groups.map(g => ({
    diameterMm: g.diameterMm,
    holes: array.cells.flatMap(cell => g.holes.map(h => ({ x: h.x + cell.x, y: h.y + cell.y }))),
  }))
}

/** Slot equivalent of `tileHolesAcrossArray` — both endpoints translated together. */
export function tileSlotsAcrossArray(
  groups: { diameterMm: number; slots: { start: Pt; end: Pt }[] }[],
  array: PanelArrayResult
): { diameterMm: number; slots: { start: Pt; end: Pt }[] }[] {
  return groups.map(g => ({
    diameterMm: g.diameterMm,
    slots: array.cells.flatMap(cell => g.slots.map(s => ({
      start: { x: s.start.x + cell.x, y: s.start.y + cell.y },
      end: { x: s.end.x + cell.x, y: s.end.y + cell.y },
    }))),
  }))
}

/**
 * `Border_Marks.gbr` — a standalone RS-274X file (its own %FS/%MO header, one
 * line aperture) containing every array cell's 4 corner marks. Purely a CAM
 * reference/visualization layer — the physical marks come from routing it
 * (see `generateMarkRoutingGcode` in `routing/gcode.ts`), not from this file
 * directly, but a fab or CAM tool opening the export folder should still be
 * able to see where the marks are.
 */
export function generateBorderMarksGerber(
  array: PanelArrayResult,
  config: PanelArrayConfig,
  fmt: OutputFormat
): string {
  const paths = generateBorderMarkPaths(array)
  const f = (v: number) => formatCoordinate(v, fmt)

  const lines: string[] = []
  lines.push('G04 Meta-Panelization Border Marks - CNC batch-drilling alignment marks*')
  lines.push(generateFSCommand(fmt))
  lines.push(generateMOCommand(fmt))
  lines.push('%LPD*%')
  lines.push(`%ADD10C,${config.markLineWidthMm.toFixed(6)}*%`)
  lines.push('D10*')
  for (const path of paths) {
    if (path.length === 0) continue
    lines.push(`X${f(path[0].x)}Y${f(path[0].y)}D02*`)
    for (let i = 1; i < path.length; i++) {
      lines.push(`X${f(path[i].x)}Y${f(path[i].y)}D01*`)
    }
  }
  lines.push('M02*')
  return lines.join('\n')
}
