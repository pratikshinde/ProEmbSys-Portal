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
  /**
   * Gap between adjacent panel-array cells, mm. Not exposed in the UI —
   * defaults to 0 and is normally left there. When `materialCellWidthMm`/
   * `materialCellHeightMm` are set, the spacing between panels is already
   * baked into the difference between the material cell size and the panel's
   * own size (each panel sits centered in its own cell, so two adjacent
   * cells' panels are separated by both cells' margins combined), so an
   * ADDITIONAL gap on top of that is rarely wanted. Kept as a real field
   * (rather than deleted) for the no-material-cell case and for panel
   * templates saved before this existed — still fully functional, just no
   * longer surfaced as its own input.
   */
  arrayGapXmm: number
  arrayGapYmm: number
  /** Margin from the sheet/CNC-travel edge to the first row/column, mm. Same
   *  no-longer-a-UI-field status as `arrayGapXmm`/`arrayGapYmm` above, same
   *  reason — defaults to 0 (cells tile flush from the sheet edge). */
  sheetMarginMm: number
  /** L-shape corner mark arm length, mm — same convention as `PanelConfig.lShapeArmLength`. */
  markArmLengthMm: number
  markLineWidthMm: number
  /** Cut depth for milling the corner marks into the SACRIFICIAL board, mm
   *  (negative, below the work surface) — deliberately separate from
   *  `GcodeContext.cutDepthMm`, which is calibrated for cutting through the
   *  customer's own board + backer, not scoring a spoiler board. */
  markCutDepthMm: number
  /**
   * Place each panel copy rotated 90° on the sheet — swaps the effective
   * cell footprint (width/height) used for fitting AND rotates every hole/
   * slot/mark coordinate to match, via `rotateHoleGroupsForArray`/
   * `rotateSlotGroupsForArray`. Off by default (no rotation support existed
   * at all before a real job needed it: a 100×191mm panel doesn't fit
   * 2 columns on a 115mm-wide sheet upright, but does once rotated so its
   * 191mm side lies along the sheet's 200mm side).
   */
  rotatePanel90: boolean
  /**
   * Force an exact column/row count instead of auto-fitting from
   * CNC/material bounds — `null` (either field) means "auto-fit", matching
   * today's default behaviour exactly. Both must be set (and positive) to
   * activate manual mode; a lone `manualCols` with `manualRows: null` is
   * still auto-fit. Unlike auto-fit, a manual layout that exceeds the
   * CNC/material bound is NOT silently rejected (`computePanelArray` still
   * returns null only for cols/rows < 1) — it's the shop's own explicit
   * choice, so the result is returned with `PanelArrayResult.exceedsBounds`
   * set, for the UI to warn rather than block. Auto-fit can never trigger
   * that flag: it only ever proposes layouts that fit by construction.
   */
  manualCols: number | null
  manualRows: number | null
  /**
   * Size of the ONE physical material/backing block that holds a single
   * panel copy, mm — e.g. a pre-cut MDF or FR4 blank sized a bit larger than
   * the panel itself. This is the PRIMARY way to control spacing: `null`
   * (either field) means "no material cell" — the array tiles the panel's
   * own raw footprint directly (the original, still-default behaviour,
   * governed by `arrayGapXmm`/`arrayGapYmm`/`sheetMarginMm`). Set BOTH to a
   * size ≥ the panel's own footprint and the array instead:
   *   - Tiles these CELLS edge-to-edge (no additional gap needed — the
   *     margin between two panels is already the sum of each cell's own
   *     margin around its panel).
   *   - Centers the panel within each cell (`PanelArrayResult.panelOffsetXMm`/
   *     `panelOffsetYMm` — see there for the exact formula), so its holes and
   *     the border marks land at the right place relative to the physical
   *     block, not the panel's own smaller footprint.
   *   - Points the border marks at the CELL's own outer corners (via
   *     `PanelArrayResult.cellWidthMm`/`cellHeightMm` becoming the material
   *     size once this is set — `generateBorderMarkPaths` needs no separate
   *     handling for this), so the marks show exactly where to align the
   *     physical block being placed, not just the panel glued to it.
   * Confirmed against a real job: a 100×191mm panel on a 115×200mm material
   * block reads as a 7.5mm/4.5mm margin per side on X/Y — computed
   * automatically here, not something the shop has to enter as a separate
   * gap number.
   */
  materialCellWidthMm: number | null
  materialCellHeightMm: number | null
  /**
   * Mirror every hole/slot in X before tiling — for a single-sided PCB that
   * must be drilled with copper facing UP on the CNC (the panel is
   * physically flipped over first, so every hole's X position mirrors
   * within its own panel). Drilling-only: the border marks (which the
   * operator registers the panel's physical corners against) are unchanged
   * either way, since a rectangle's 4-corner L-mark set maps onto itself
   * under reflection — see `computePanelArray`'s own docs for why neither
   * this flag nor `rotatePanel90` needs any change there. Deliberately
   * doesn't touch the cutting/routing program, which is a separate setup
   * step; the UI label makes this explicit. Off by default — flipping the
   * drill program without the operator's explicit intent is a real scrap
   * risk.
   */
  mirrorX: boolean
}

export const DEFAULT_PANEL_ARRAY_CONFIG: PanelArrayConfig = {
  enabled: false,
  cncMaxXmm: 600,
  cncMaxYmm: 500,
  materialXmm: 300,
  materialYmm: 300,
  arrayGapXmm: 0,
  arrayGapYmm: 0,
  sheetMarginMm: 0,
  markArmLengthMm: 5,
  markLineWidthMm: 0.254,
  markCutDepthMm: -1.5,
  rotatePanel90: false,
  manualCols: null,
  manualRows: null,
  materialCellWidthMm: null,
  materialCellHeightMm: null,
  mirrorX: false,
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
   * clamped to at most half of each gap the array actually HAS a neighbour
   * across (and half of the cell's own dimensions, for a degenerately small
   * cell). This is what keeps each cell's marks confined to its own corner
   * instead of visually overlapping a neighbour's: rather than
   * special-casing "shared" T/+ mark shapes at interior grid intersections,
   * the arm is simply never allowed to reach far enough to cross into the
   * gap far enough to clutter it. Every cell still gets its own independent,
   * complete 4-corner mark set (identical math to
   * `generatePanelBorderLShapeGerberCommands`), which stays flush with that
   * panel's real corner — the whole point of a registration mark.
   *
   * ⚠ Only capped by `arrayGapXmm`/`arrayGapYmm` on an axis that actually has
   * more than one cell (`cols > 1` / `rows > 1`) — a 1-column or 1-row array
   * has no neighbour on that axis at all, so there is nothing to protect
   * against overlapping. Confirmed as a real bug on a genuine 1×1 array
   * (only one copy fit the configured sheet): with the gap cap applied
   * unconditionally, `arrayGapXmm/2` and `arrayGapYmm/2` both apply even
   * though there is exactly one cell in both directions, and if either gap
   * is small the arm — and therefore every mark on the whole sheet — silently
   * collapses to 0, producing a `Border_Marks.gbr` with a header and zero
   * mark paths (`generateBorderMarkPaths` returns `[]` whenever the arm is
   * `<= 0`). No warning, no error — just an empty file.
   */
  effectiveMarkArmLengthMm: number
  /**
   * True when this layout's own computed sheet size exceeds the CNC travel
   * or material bound on at least one axis. Only reachable via
   * `manualCols`/`manualRows` — auto-fit derives cols/rows FROM those same
   * bounds via `Math.floor`, so it can never produce a layout that overflows
   * them. Advisory, not blocking (matches this codebase's other
   * exceeds-bound checks, e.g. routing's `rib-too-narrow`): a shop entering
   * an explicit layout knows their own setup better than this heuristic, but
   * still deserves a visible warning before cutting scrap.
   */
  exceedsBounds: boolean
  /**
   * Offset from a cell's own bottom-left corner to the (rotation-adjusted)
   * panel's bottom-left corner, mm — half the leftover space on each axis
   * once `config.materialCellWidthMm`/`materialCellHeightMm` are larger than
   * the panel: `(cellWidthMm − effectivePanelWidthMm) / 2`, floored at 0.
   * Zero whenever there's no material cell (the panel fills the cell
   * exactly, same as before this existed). `tileHolesAcrossArray`/
   * `tileSlotsAcrossArray` add this on top of each cell's own `x`/`y` so a
   * hole/slot lands centered within its physical material block, not
   * flush with its corner.
   */
  panelOffsetXMm: number
  panelOffsetYMm: number
}

/**
 * How many copies of a `pcbWidthMm` x `pcbHeightMm` panel fit in a grid,
 * bounded by BOTH the CNC's travel limit and the material sheet on hand
 * (whichever is smaller per axis), with `sheetMarginMm` clearance from the
 * outer edge and `arrayGapXmm`/`arrayGapYmm` between cells.
 *
 * `config.rotatePanel90` swaps the effective PANEL footprint used for
 * fitting/centering math. `config.materialCellWidthMm`/`materialCellHeightMm`
 * (when both set) replace that (rotated) panel footprint as the actual CELL
 * tiled across the sheet — the panel then centers within its own cell
 * (`PanelArrayResult.panelOffsetXMm`/`panelOffsetYMm`) rather than filling it
 * exactly. Either way, `PanelArrayResult.cellWidthMm`/`cellHeightMm` ends up
 * holding whatever the TILED footprint actually is, so `generateBorderMarkPaths`
 * needs no separate handling for either feature. The hole/slot coordinates
 * themselves are NOT rotated here; that's `rotateHoleGroupsForArray`/
 * `rotateSlotGroupsForArray`'s job, applied by the caller before tiling (the
 * centering offset, by contrast, IS applied here as part of the result, and
 * consumed by `tileHolesAcrossArray`/`tileSlotsAcrossArray`).
 *
 * `config.manualCols`/`manualRows` (both positive) skip the auto-fit floor
 * division entirely and use the given count directly — see their own doc
 * comments on `PanelArrayConfig` for why that path can set
 * `exceedsBounds: true` instead of returning null.
 *
 * Returns null only when cols/rows come out below 1 — callers must not guess
 * a plausible-but-wrong layout, same fabrication-honesty rule the routing
 * engine follows for a failed contour trace. (A manual layout can still hit
 * this: e.g. `manualCols: 0` isn't meaningfully "3 columns forced".)
 */
export function computePanelArray(
  panelWidthMm: number,
  panelHeightMm: number,
  config: PanelArrayConfig
): PanelArrayResult | null {
  if (panelWidthMm <= 0 || panelHeightMm <= 0) return null

  const effPanelWidthMm = config.rotatePanel90 ? panelHeightMm : panelWidthMm
  const effPanelHeightMm = config.rotatePanel90 ? panelWidthMm : panelHeightMm

  const hasMaterialCell = !!config.materialCellWidthMm && config.materialCellWidthMm > 0
    && !!config.materialCellHeightMm && config.materialCellHeightMm > 0
  const cellWidthMm = hasMaterialCell ? (config.materialCellWidthMm as number) : effPanelWidthMm
  const cellHeightMm = hasMaterialCell ? (config.materialCellHeightMm as number) : effPanelHeightMm

  // Centers the panel within its own material cell. Zero whenever there's no
  // material cell (the panel fills the cell exactly, matching pre-existing
  // behaviour), or the cell happens to equal the panel's own size.
  const panelOffsetXMm = Math.max(0, (cellWidthMm - effPanelWidthMm) / 2)
  const panelOffsetYMm = Math.max(0, (cellHeightMm - effPanelHeightMm) / 2)

  // Material-cell mode FORCES gap/margin to 0, regardless of whatever
  // `config.arrayGapXmm`/`arrayGapYmm`/`sheetMarginMm` happen to hold —
  // confirmed necessary on a real job: a config still carrying the old
  // pre-material-cell defaults (10/10/5, before those fields were dropped
  // from the UI) silently added 20mm/30mm onto what should have been an
  // exact 400×345mm sheet, producing 420×375mm instead, with no visible
  // field left to notice or fix it from. The whole point of a material cell
  // is that the shop's own spacing is already baked into cell-vs-panel size
  // — "ignore whatever gap/margin config exists" is the only version of this
  // that can't be silently wrong from stale state (an old template, an
  // un-refreshed session, anything). Only the NON-material-cell path still
  // honors those fields, for shops that genuinely want gap-based tiling of
  // the raw panel.
  const effGapXmm = hasMaterialCell ? 0 : config.arrayGapXmm
  const effGapYmm = hasMaterialCell ? 0 : config.arrayGapYmm
  const effMarginMm = hasMaterialCell ? 0 : config.sheetMarginMm

  // A material cell already IS the shop's own material, one block per panel
  // — there's no separate "bigger sheet" to bound against, so only the CNC's
  // own travel limit applies. `materialXmm`/`materialYmm` still bound the
  // non-material-cell path (tiling the raw panel across a sheet on hand).
  const boundX = hasMaterialCell ? config.cncMaxXmm : Math.min(config.cncMaxXmm, config.materialXmm)
  const boundY = hasMaterialCell ? config.cncMaxYmm : Math.min(config.cncMaxYmm, config.materialYmm)

  const manual = !!config.manualCols && config.manualCols > 0 && !!config.manualRows && config.manualRows > 0
  let cols: number
  let rows: number
  if (manual) {
    cols = Math.floor(config.manualCols as number)
    rows = Math.floor(config.manualRows as number)
  } else {
    // "n items + (n-1) gaps fit in the available span" solved for n.
    const availX = boundX - 2 * effMarginMm + effGapXmm
    const availY = boundY - 2 * effMarginMm + effGapYmm
    cols = Math.floor(availX / (cellWidthMm + effGapXmm))
    rows = Math.floor(availY / (cellHeightMm + effGapYmm))
  }
  if (cols < 1 || rows < 1) return null

  const cells: PanelArrayCell[] = []
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      cells.push({
        col,
        row,
        x: effMarginMm + col * (cellWidthMm + effGapXmm),
        y: effMarginMm + row * (cellHeightMm + effGapYmm),
      })
    }
  }

  const sheetWidthMm = cols * cellWidthMm + (cols - 1) * effGapXmm + 2 * effMarginMm
  const sheetHeightMm = rows * cellHeightMm + (rows - 1) * effGapYmm + 2 * effMarginMm
  // Epsilon guard against float noise on an auto-fit layout that lands
  // exactly on the boundary — auto-fit must never read as exceeding.
  const exceedsBounds = sheetWidthMm > boundX + 1e-6 || sheetHeightMm > boundY + 1e-6

  // Only cap by half the gap when there's BOTH a real neighbour on that axis
  // (cols/rows > 1) AND a real gap to protect (> 0). With gap defaulting to
  // 0 (and forced to 0 in material-cell mode), capping unconditionally on
  // `cols > 1` alone would collapse the arm to 0 for every multi-cell array
  // — reproducing the exact empty-Border_Marks.gbr bug this replaced, just
  // via a zero-gap-by-design path instead of a zero-gap-by-accident one. Two
  // adjacent cells drawing the same line at their shared (zero-gap) boundary
  // is harmless — routing it twice, not routing something that shouldn't be
  // routed.
  const effectiveMarkArmLengthMm = Math.max(0, Math.min(
    config.markArmLengthMm,
    cols > 1 && effGapXmm > 0 ? effGapXmm / 2 : Infinity,
    rows > 1 && effGapYmm > 0 ? effGapYmm / 2 : Infinity,
    cellWidthMm / 2,
    cellHeightMm / 2
  ))

  return {
    cols, rows,
    cellWidthMm, cellHeightMm,
    sheetWidthMm, sheetHeightMm,
    cells,
    totalPanels: cols * rows,
    effectiveMarkArmLengthMm,
    exceedsBounds,
    panelOffsetXMm,
    panelOffsetYMm,
  }
}

/**
 * Rotates a hole/slot's LOCAL panel-space coordinate 90° CCW, for placing
 * that panel copy rotated on the array sheet — pairs with
 * `config.rotatePanel90` in `computePanelArray`, which only swaps the
 * FOOTPRINT used for fitting/positioning; the actual point data must be
 * rotated separately, before `tileHolesAcrossArray`/`tileSlotsAcrossArray`
 * translate it by each cell's offset.
 *
 * `origHeightMm` is the panel's own real, UN-rotated height (i.e.
 * `PanelResult.panelHeight`, not `PanelArrayResult.cellHeightMm`, which is
 * already the post-swap value once `rotatePanel90` is on).
 *
 * Convention: a point (x, y) in [0, W] × [0, H] maps to (H − y, x) in the
 * rotated [0, H] × [0, W] frame — verified against all four corners: (0,0) →
 * (H,0), (W,0) → (H,W), (0,H) → (0,0), (W,H) → (0,W). That takes what was the
 * LEFT edge (x=0) to the BOTTOM edge (y=0), i.e. rotating the panel 90°
 * counter-clockwise into place. `W` itself never appears in the formula —
 * only `H` — so this is well-defined per-point without needing the full
 * panel width passed in.
 */
function rotatePoint90(p: Pt, origHeightMm: number): Pt {
  return { x: origHeightMm - p.y, y: p.x }
}

/** `rotatePoint90` applied to every hole in every diameter group. */
export function rotateHoleGroupsForArray(
  groups: { diameterMm: number; holes: Pt[] }[],
  origHeightMm: number
): { diameterMm: number; holes: Pt[] }[] {
  return groups.map(g => ({
    diameterMm: g.diameterMm,
    holes: g.holes.map(h => rotatePoint90(h, origHeightMm)),
  }))
}

/** `rotatePoint90` applied to both endpoints of every slot in every diameter group. */
export function rotateSlotGroupsForArray(
  groups: { diameterMm: number; slots: { start: Pt; end: Pt }[] }[],
  origHeightMm: number
): { diameterMm: number; slots: { start: Pt; end: Pt }[] }[] {
  return groups.map(g => ({
    diameterMm: g.diameterMm,
    slots: g.slots.map(s => ({
      start: rotatePoint90(s.start, origHeightMm),
      end: rotatePoint90(s.end, origHeightMm),
    })),
  }))
}

/**
 * Mirrors a point's X within a panel of the given (already rotation-
 * adjusted, if applicable) width — `PanelArrayConfig.mirrorX`'s per-point
 * primitive, same convention as `rotatePoint90`: takes the panel's own
 * effective width so it's well-defined per-point without the caller
 * threading anything else through.
 */
function mirrorPointX(p: Pt, effWidthMm: number): Pt {
  return { x: effWidthMm - p.x, y: p.y }
}

/** `mirrorPointX` applied to every hole in every diameter group. */
export function mirrorHoleGroupsForArray(
  groups: { diameterMm: number; holes: Pt[] }[],
  effWidthMm: number
): { diameterMm: number; holes: Pt[] }[] {
  return groups.map(g => ({
    diameterMm: g.diameterMm,
    holes: g.holes.map(h => mirrorPointX(h, effWidthMm)),
  }))
}

/** `mirrorPointX` applied to both endpoints of every slot in every diameter group. */
export function mirrorSlotGroupsForArray(
  groups: { diameterMm: number; slots: { start: Pt; end: Pt }[] }[],
  effWidthMm: number
): { diameterMm: number; slots: { start: Pt; end: Pt }[] }[] {
  return groups.map(g => ({
    diameterMm: g.diameterMm,
    slots: g.slots.map(s => ({
      start: mirrorPointX(s.start, effWidthMm),
      end: mirrorPointX(s.end, effWidthMm),
    })),
  }))
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

/**
 * One diameter-grouped hole list, tiled across every array cell — translated
 * by each cell's own sheet position PLUS `array.panelOffsetXMm`/`panelOffsetYMm`
 * (zero unless a material cell centers the panel within a bigger block; see
 * `computePanelArray`).
 */
export function tileHolesAcrossArray(
  groups: { diameterMm: number; holes: { x: number; y: number }[] }[],
  array: PanelArrayResult
): { diameterMm: number; holes: { x: number; y: number }[] }[] {
  return groups.map(g => ({
    diameterMm: g.diameterMm,
    holes: array.cells.flatMap(cell => g.holes.map(h => ({
      x: h.x + cell.x + array.panelOffsetXMm,
      y: h.y + cell.y + array.panelOffsetYMm,
    }))),
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
      start: { x: s.start.x + cell.x + array.panelOffsetXMm, y: s.start.y + cell.y + array.panelOffsetYMm },
      end: { x: s.end.x + cell.x + array.panelOffsetXMm, y: s.end.y + cell.y + array.panelOffsetYMm },
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
