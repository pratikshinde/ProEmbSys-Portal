/**
 * Routing engine — rules and result contract.
 *
 * Mirrors `src/lib/dfm/types.ts` in spirit: a pure contract shared by the
 * geometry planner and every emitter, with no React and no store imports.
 *
 * Unlike `DfmRules` there is no zod schema here — routing config is client-only
 * session state that is never persisted to the database, so there is no
 * untrusted-input boundary to revalidate across.
 */

import type { PanelConfig } from '../panelization-engine'

/** The three router bits this shop actually keeps on hand. */
export const ROUTING_BIT_PRESETS = [1.0, 1.5, 2.0] as const

export type TabStyle = 'none' | 'solid' | 'mousebite'

/**
 * ⚠ DELIBERATELY FLAT — do not introduce nested objects.
 *
 * `updateRoutingConfig` is a shallow merge, exactly like `updatePanelConfig`
 * (store.ts). A nested object would need a manual re-spread in *both*
 * `updateRoutingConfig` and `resetRoutingConfig` — which is precisely the
 * `PanelConfig.drillFormat` trap that already exists in this codebase. Adding a
 * flat field is a no-op for both; adding a nested one silently drops keys.
 */
export interface RoutingConfig {
  /** Router bit diameter in mm. Tool paths are offset outward by half this. */
  bitDiameterMm: number

  // --- Scope: independent, not mutually exclusive. Panel-perimeter and
  // per-PCB perimeters are disjoint geometry and real panels often need both.
  /** Route the outside of the whole panel (cut the panel from the sheet). */
  routePanelOutline: boolean
  /** Route each PCB free of the panel, leaving tabs. */
  routeIndividualPcbs: boolean
  /**
   * Collapse the duplicate pass two neighbouring PCBs generate along a shared
   * gap into one. Only ever fires when the two passes are geometrically
   * identical, which happens exactly when `gap == bitDiameter`.
   */
  mergeCoincidentPasses: boolean

  // --- Tabs
  tabStyle: TabStyle
  /**
   * Length of the UNCUT material bridge, in mm — *not* the gap left in the tool
   * path. The path gap is `tabWidthMm + bitDiameterMm`, because the cut is the
   * path swept by a disc of radius `bitDiameterMm / 2`.
   */
  tabWidthMm: number
  /** Tabs per routed edge when `tabPositionsMm` is empty. */
  tabsPerEdge: number
  tabTop: boolean
  tabBottom: boolean
  tabLeft: boolean
  tabRight: boolean
  /**
   * Advanced override. Empty string = auto (evenly spaced). Otherwise a
   * comma-separated list of distances from each edge's start, in mm.
   */
  tabPositionsMm: string

  // --- Mouse bites (only meaningful when tabStyle === 'mousebite')
  mouseBiteHoleDiameterMm: number
  mouseBiteHolePitchMm: number
  /**
   * Clearance from the true board edge to the NEAR side of each mouse-bite
   * hole, mm — the hole row is pulled outward (into the panel scrap, away
   * from the PCB's own body) by `mouseBiteHoleDiameterMm / 2 +
   * mouseBiteEdgeClearanceMm`, so the whole hole sits outside the finished
   * board with at least this much air gap, rather than straddling the cut
   * line (half in, half out — the traditional convention, but one that
   * leaves a semicircular nub of drilled hole on the finished board edge).
   * Only offsets where the HOLES are drilled; `RouteTab.center` (the solid
   * bridge itself) stays on the true edge.
   */
  mouseBiteEdgeClearanceMm: number
  /**
   * false (default) → mouse-bite holes go in their own `_MouseBites.drl`, which
   * keeps the CAM350-verified main drill output byte-identical.
   */
  mouseBiteInMainDrill: boolean

  /**
   * false (default) → the route Gerber's aperture is the bit diameter, so the
   * layer shows the real cut swath. true → 0.1mm hairline, for documentation.
   */
  routeGerberHairline: boolean

  // --- Contour (non-rectangular) routing. See src/lib/board-contour.ts and
  // src/lib/routing/offset.ts for the tracing/offsetting machinery.
  /**
   * How to determine each PCB's routed profile.
   *  - 'bbox': always the rectangular bounding box (Phase A behaviour).
   *  - 'contour': always the traced board outline. A trace failure is a
   *    blocking error — NEVER silently falls back to bbox, which is
   *    known-wrong for a shaped board (see CLAUDE.md's fabrication-honesty
   *    rule: an error emits no per-PCB geometry, never a plausible wrong one).
   *  - 'auto': contour, EXCEPT when the outline is already a plain rectangle
   *    (`isRectangularOutline`), where bbox produces identical output for
   *    less work — see `resolveOutlineMode` in plan-routing.ts.
   */
  pcbOutlineMode: 'auto' | 'contour' | 'bbox'
  /** Contour mode only: also route interior cutouts/slots found in the
   *  traced profile, cut before the outer profile on each PCB (the board
   *  must still be fully supported by the panel when interior features are
   *  milled). */
  routeInteriorCutouts: boolean
  /** Contour mode only: tabs spread evenly by arc length around the WHOLE
   *  closed contour. Cutouts never get tabs — they're fully enclosed. */
  tabsPerContour: number
  /** Chord tolerance for flattening arcs during contour tracing and
   *  offsetting, mm. */
  contourToleranceMm: number
}

export const DEFAULT_ROUTING_CONFIG: RoutingConfig = {
  bitDiameterMm: 2.0,
  routePanelOutline: true,
  routeIndividualPcbs: false,
  mergeCoincidentPasses: true,
  tabStyle: 'mousebite',
  tabWidthMm: 3.0,
  tabsPerEdge: 2,
  tabTop: true,
  tabBottom: true,
  tabLeft: true,
  tabRight: true,
  tabPositionsMm: '',
  mouseBiteHoleDiameterMm: 0.5,
  mouseBiteHolePitchMm: 0.8,
  mouseBiteEdgeClearanceMm: 0.2,
  mouseBiteInMainDrill: false,
  routeGerberHairline: false,
  // 'auto': follow the real traced board profile by default, falling back
  // to the (identical, cheaper) bounding-box path only when the outline is
  // already a plain rectangle. Deliberately flipped from 'bbox' only once
  // the whole contour pipeline — offset engine, tab placement, store
  // wiring, UI — was built and verified end to end (Stages C0-C5); a shaped
  // board routed under the OLD default would have been silently over-cut.
  pcbOutlineMode: 'auto',
  routeInteriorCutouts: true,
  tabsPerContour: 4,
  contourToleranceMm: 0.01,
}

/** A point in panel-absolute Gerber Y-up millimetres. */
export interface Pt {
  x: number
  y: number
}

// ============================================================================
// Board contour — the real (non-rectangular) board profile, traced from the
// outline layer. See src/lib/board-contour.ts for the only code that ever
// touches a tracespace `BoardShape`; everything downstream of that adapter
// works in this file's own vocabulary.
// ============================================================================

/**
 * One closed loop of a board profile, already flattened to a polyline.
 * Gerber Y-up MILLIMETRES, in the outline FILE's own coordinate space (not yet
 * translated to any panel position). `points[0]` is NOT repeated at the end.
 */
export interface ContourRing {
  points: Pt[]
  /** Shoelace area as extracted, BEFORE orientation normalisation, mm². Sign
   *  records the source winding; used only to detect an orientation flip
   *  after offsetting (see offset.ts). */
  signedAreaMm2: number
  /** Nested inside an odd number of other rings ⇒ an interior cutout. */
  isHole: boolean
  /** Nesting depth (0 = outermost). depth >= 2 means an island inside a
   *  cutout — physically falls out of the board; flagged as an issue. */
  depth: number
  /** Arcs flattened into this ring. 0 ⇒ the source loop was polylines only
   *  (e.g. Eagle-style exports, which polygonise everything). */
  arcCount: number
  /** tracespace's gap-fill invented at least one synthetic straight bridge to
   *  close this loop — part of this geometry is not actually in the Gerber.
   *  Detection is approximate (see board-contour.ts); advisory only. */
  syntheticCloseCount: number
  /** True when nesting classification could not robustly determine whether
   *  this ring is a hole (e.g. every probe point landed on another ring's
   *  boundary). Callers must treat this as a hard error, never guess. */
  ambiguous: boolean
  boundsMm: { minX: number; minY: number; maxX: number; maxY: number }
}

export type ContourFailure =
  | 'no-outline-layer'
  | 'no-paths-in-outline'
  | 'no-closed-regions'
  | 'rejected-coverage'
  | 'degenerate'
  | 'parse-failed'

/**
 * A traced board profile: the outer boundary plus any interior cutouts,
 * still in the outline file's own coordinate space (see plan-routing.ts for
 * the per-panel-instance translation).
 */
export interface BoardContour {
  rings: ContourRing[]
  /** Arc-accurate bbox of the closed rings, mm, file coordinates. Deliberately
   *  DIFFERENT from GerberLayer.bounds, which is arc-blind (endpoint-only) —
   *  the difference between the two is exactly the arc bulge. */
  boundsMm: { minX: number; minY: number; maxX: number; maxY: number }
  toleranceMm: number
  /** Loops tracespace could not close into a region. > 0 means the profile is
   *  incomplete — some of the board edge never got picked up. */
  openPathCount: number
  failureReason?: ContourFailure
  sourceFileName: string | null
}

export type RouteRole = 'panel-outline' | 'pcb-outline' | 'pcb-cutout'
export type RouteEdge = 'top' | 'bottom' | 'left' | 'right'

/**
 * One continuous cutter pass.
 *
 * ⚠ `points` are TOOL-CENTER coordinates, already offset outward from the
 * finished board edge by the bit radius. Emitters must never offset again.
 */
export interface RoutePath {
  id: string
  role: RouteRole
  /** Index into `PanelResult.placements`; absent for the panel outline. */
  pcbIndex?: number
  points: Pt[]
  /** True only when no tab interrupts the loop. */
  closed: boolean
  toolDiameterMm: number
}

/**
 * A breakaway tab. Note a `mousebite` tab is *a solid tab plus holes* — the
 * route interruption is what makes it a tab; the holes only make it easier to
 * snap. `center`/`holes` sit on the board's own edge line, not on the tool path.
 */
export interface RouteTab {
  id: string
  style: 'solid' | 'mousebite'
  center: Pt
  /** Unit vector along the edge the tab sits on. */
  dir: Pt
  /** Length of the uncut bridge, in mm. */
  widthMm: number
  edge: RouteEdge
  pcbIndex?: number
  /** Empty for `solid`. */
  holes: Pt[]
  holeDiameterMm: number
  /** Contour mode only: arc-length distance from the offset ring's
   *  canonicalised start to this tab's centre. Absent for bbox-mode tabs,
   *  which are already fully positioned by `edge` + the edge-relative
   *  distance baked into `center`. */
  alongMm?: number
}

export interface RouteToolDef {
  index: number
  diameterMm: number
  kind: 'router' | 'drill'
}

export interface RoutingIssue {
  id: string
  severity: 'error' | 'warning' | 'info'
  title: string
  detail: string
  /**
   * One-click remedy offered in the Routing panel.
   *
   * `rebuildPanel: true` means applying the patch invalidates the current
   * `panelResult`, so the UI must also call `computePanelResult()` — otherwise
   * the user is left with routing planned against stale panel geometry.
   */
  fix?: {
    label: string
    panelConfigPatch: Partial<PanelConfig>
    rebuildPanel: boolean
  }
  locations?: Pt[]
}

export interface RoutingResult {
  paths: RoutePath[]
  tabs: RouteTab[]
  tools: RouteToolDef[]
  issues: RoutingIssue[]
  totalPathLengthMm: number
  /**
   * Snapshot of the config this result was planned with, so emitters and the
   * export README never read live store state that may have moved on.
   */
  config: RoutingConfig
  panelWidthMm: number
  panelHeightMm: number
  generatedAt: string
  /**
   * The RESOLVED per-PCB outline mode actually used — never `'auto'`, even
   * when `config.pcbOutlineMode` was `'auto'`. Emitters and the export
   * README need to know what actually happened, not what was requested; see
   * `resolveOutlineMode` in plan-routing.ts.
   */
  pcbOutlineMode: 'contour' | 'bbox'
}

/** Convenience: does this result contain any mouse-bite holes at all? */
export function hasMouseBiteHoles(result: RoutingResult): boolean {
  return result.tabs.some(t => t.holes.length > 0)
}

/** Every mouse-bite hole in the result, flattened, with its diameter. */
export function collectMouseBiteHoles(
  result: RoutingResult
): { x: number; y: number; diameter: number }[] {
  const out: { x: number; y: number; diameter: number }[] = []
  for (const tab of result.tabs) {
    for (const h of tab.holes) {
      out.push({ x: h.x, y: h.y, diameter: tab.holeDiameterMm })
    }
  }
  return out
}
