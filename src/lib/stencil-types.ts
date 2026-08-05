/**
 * SMD paste-stencil DXF export config/result types — split out of store.ts
 * the same way RoutingConfig/GcodeContext live in their own files, so a
 * shallow-merge config type doesn't grow store.ts further.
 */

import type { Point } from './stencil-geometry'

/** ⚠ DELIBERATELY FLAT — same shallow-merge discipline as RoutingConfig /
 *  GcodeContext / PanelArrayConfig. `updateStencilConfig` is a shallow
 *  merge; a nested field added later needs re-spreading in both it and
 *  `resetStencilConfig`, exactly the `PanelConfig.drillFormat` trap those
 *  other configs avoid by staying flat. */
export interface StencilConfig {
  /** Whole-panel tiles every design's apertures across the computed panel's
   *  placements; single-PCB exports just the active design's own geometry,
   *  untranslated. */
  scope: 'single' | 'panel'
  includeTopPaste: boolean
  includeBottomPaste: boolean
  /** Area-based reduction, 0-100. 0 = exact match. Shrinks each aperture
   *  around its own center — see stencil-geometry.ts's shrinkRingAroundCenter. */
  reductionPct: number
  /** Ride the board/panel outline along as a scribe-line layer in the DXF. */
  includeOutline: boolean
}

export const DEFAULT_STENCIL_CONFIG: StencilConfig = {
  scope: 'panel',
  includeTopPaste: true,
  includeBottomPaste: false,
  reductionPct: 0,
  includeOutline: true,
}

export interface StencilFile {
  filename: string
  content: string
}

/**
 * Geometry backing the canvas preview — kept separate from `StencilFile`
 * (the serialized DXF text) the same way `panelArrayResult` (geometry) is
 * kept separate from `panelArrayFiles` (serialized output) for the Multi-
 * Panel Array preview. Combines every selected side's apertures into one
 * set (a physical stencil preview naturally overlays top/bottom since
 * they're separate cut sheets anyway) — `originalRings` is the true pad
 * shape before any reduction, `reducedRings` is the actual cut geometry
 * that goes into the DXF, so a canvas can show both for comparison.
 */
export interface StencilPreviewData {
  scope: 'single' | 'panel'
  originalRings: Point[][]
  reducedRings: Point[][]
  outlineRings: Point[][]
}
