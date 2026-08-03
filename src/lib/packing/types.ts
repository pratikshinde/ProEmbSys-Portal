/**
 * Multi-design panel packing — pure geometry, zero React/store/tracespace
 * imports (same discipline as `routing/geometry.ts`). See the
 * "Multi-design panelization" plan for the full design rationale.
 *
 * The packer solves ONE problem: given several rectangular designs (each with
 * a min/max instance count) and a maximum material size, find several good
 * candidate layouts ranked by area-usage efficiency. It knows nothing about
 * ribs, tooling holes, fiducials, or rib text — those are a `finishPanel()`
 * concern, applied by the caller after a candidate is chosen.
 */

export interface PackItemSpec {
  designId: string
  /** Un-rotated design dimensions in mm. */
  widthMm: number
  heightMm: number
  /** Hard minimum instance count — a candidate missing this many is infeasible. */
  minCount: number
  /** No upper bound when null. */
  maxCount: number | null
  allowRotation: boolean
  /** Lower sorts first in priority-then-area fill order; also breaks ties elsewhere. */
  priority: number
}

/** One design instance placed by the packer — panel-absolute, low-corner mm,
 *  `w`/`h` already swapped for a 90/270 rotation (never re-derive from the
 *  design's own unrotated size). Mirrors `PanelPlacement` minus row/col,
 *  which only exist in grid mode. */
export interface PackedItem {
  designId: string
  x: number
  y: number
  w: number
  h: number
  rotationDeg: 0 | 90 | 180 | 270
}

export type PackStrategy = 'shelf' | 'guillotine' | 'maxrects' | 'block-grid'
export type FillOrder = 'min-only' | 'area-desc' | 'area-asc' | 'ratio-balanced' | 'priority-then-area'
export type RotationPolicy = 'none' | 'uniform-per-design'

export interface PackConfig {
  /** Maximum material size — the panel then shrinks to the tight bbox of
   *  whatever actually got placed (see `PackCandidate.panelWidthMm/HeightMm`). */
  materialWidthMm: number
  materialHeightMm: number
  gapXMm: number
  gapYMm: number
  /** Safety cap on total instances across every design in one candidate. */
  maxPlacements: number
  /** Wall-clock budget for the whole `findPackCandidates` call, across every
   *  (strategy, fillOrder, rotation) attempt — not per-attempt. */
  timeBudgetMs: number
}

export const DEFAULT_PACK_CONFIG: Omit<PackConfig, 'materialWidthMm' | 'materialHeightMm'> = {
  gapXMm: 2,
  gapYMm: 2,
  maxPlacements: 400,
  timeBudgetMs: 200,
}

export interface PackCandidate {
  id: string
  strategy: PackStrategy
  fillOrder: FillOrder
  rotationPolicy: RotationPolicy
  /** Tight bbox of the placed items — the ACTUAL panel size, not the material max. */
  panelWidthMm: number
  panelHeightMm: number
  items: PackedItem[]
  countsByDesign: Record<string, number>
  /** sum(item areas) / (panelWidthMm * panelHeightMm), 0..1. */
  efficiency: number
  totalBoards: number
}

/** Why a candidate never got produced — for a specific (strategy, fillOrder,
 *  rotation) attempt, kept only for the caller's diagnostics; never shown as
 *  a partial/wrong candidate. */
export interface PackInfeasibility {
  strategy: PackStrategy
  fillOrder: FillOrder
  rotationPolicy: RotationPolicy
  reason: string
}

export interface PackResult {
  candidates: PackCandidate[]
  infeasible: PackInfeasibility[]
}
