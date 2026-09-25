/**
 * Routing planner — turns a computed panel into router tool paths.
 *
 * This is the single geometry source for every routing output: the Gerber route
 * layer, the Excellon `.rou`, and (Phase B) the G-code. Emitters format what
 * comes out of here; none of them recompute geometry, and none of them apply
 * cutter compensation a second time.
 *
 * Pure and synchronous — no store, no React, no I/O. Imports only *types* from
 * the panelization engine to keep the dependency light.
 *
 * ⚠ `planRouting` must never mutate the `PanelResult` handed to it.
 */

import type { PanelConfig, PanelPlacement, PanelResult } from '../panelization-engine'
import type { GerberLayer } from '../gerber-parser'
import { isRectangularOutline } from '../panelization-engine'
import {
  dedupeCoincidentSegments,
  evenTabCenters,
  mouseBiteHoleCenters,
  offsetRectOutward,
  parseTabPositions,
  pointAlong,
  polylineLengthMm,
  ptsClose,
  segmentLength,
  splitEdgeByTabs,
  type RouteSegment,
  type Span,
} from './geometry'
import {
  buildArcLength,
  extractArcSpan,
  findSafeTabCenter,
  offsetClosedRing,
  orientRing,
  rightNormalOf,
  sampleAt,
  splitClosedByTabs,
  tangentAt,
  type ArcLengthTable,
} from './offset'
import { dGlobalToWorldCoord, findFacingPairs, worldCoordToDGlobal, worldPointToDGlobal } from './tab-alignment'
import type {
  BoardContour,
  ContourRing,
  Pt,
  RouteEdge,
  RoutePath,
  RouteTab,
  RouteToolDef,
  RoutingConfig,
  RoutingIssue,
  RoutingResult,
} from './types'

/** One design's own outline/contour context — see `RoutingPlanContext.designs`. */
export interface DesignRoutingContext {
  /** The outline layer, if one was imported — used for the
   *  rectangular-outline honesty warning AND to resolve `'auto'` mode. */
  outlineLayer?: GerberLayer | null
  /**
   * Pre-traced board profile (see `src/lib/board-contour.ts`). `planRouting`
   * never traces one itself — tracing is async and this function is
   * synchronous/pure — so contour mode with no `boardContour` supplied (or
   * one still carrying `failureReason`) raises `contour-unavailable` /
   * `contour-trace-failed` and emits no per-PCB contour paths for that design.
   */
  boardContour?: BoardContour | null
  /**
   * Translation datum for instancing the (traced-once, file-space) contour
   * onto each of THIS design's own panel positions. ⚠ Must be the outline
   * layer's OWN `GerberLayer.bounds` (arc-blind), NOT `boardContour.boundsMm`
   * (arc-accurate) — they differ by the arc bulge, and registration with the
   * copper/mask artwork (which the exporter positions from `bounds`) matters
   * more than agreement with an idealised bbox. See `gerber-exporter.ts`'s
   * own `globalBaseOffset` for the same convention.
   */
  outlineBoundsMm?: { minX: number; minY: number } | null
}

/** Optional extra context the validator can use but the geometry does not need. */
export interface RoutingPlanContext extends DesignRoutingContext {
  /**
   * Per-design outline/contour context, keyed by `designId` — a multi-design
   * panel's placements are NOT all the same board, so `outlineLayer`/
   * `boardContour`/`outlineBoundsMm` above (which describe ONE board) can't
   * describe all of them. When a design has no entry here, it falls back to
   * this object's own singular fields — which keeps every existing
   * single-design caller (nothing here ever sets `designs`) byte-identical,
   * since a single design's own context IS "the" context those fields
   * already described. See CLAUDE.md's routing section for the full
   * per-design instancing story.
   */
  designs?: Record<string, DesignRoutingContext>
}

// Extra clearance a protective tab targets beyond the bare bit-radius +
// hole-radius minimum, so the tab is centred with a little real margin
// either side rather than exactly tangent to the danger zone.
const HOLE_TAB_PROTECTION_MARGIN_MM = 0.5

/** Resolve one design's own outline/contour context, falling back to the
 *  singular top-level fields for callers that never populated `designs`
 *  (every pre-multi-design caller, and single-design panels generally). */
function contextForDesign(ctx: RoutingPlanContext, designId: string): DesignRoutingContext {
  return ctx.designs?.[designId] ?? { outlineLayer: ctx.outlineLayer, boardContour: ctx.boardContour, outlineBoundsMm: ctx.outlineBoundsMm }
}

/** Group placements by design, preserving each placement's ORIGINAL index
 *  into `panel.placements` as `pcbIndex` — that index is only ever used
 *  internally by this file (grouping/IDs), never to look a placement back up
 *  elsewhere, but keeping it stable makes a single-design panel's output
 *  byte-identical to before this function existed (same indices, same order). */
function groupPlacementsByDesign(placements: PanelPlacement[]): Map<string, { pos: PanelPlacement; pcbIndex: number }[]> {
  const map = new Map<string, { pos: PanelPlacement; pcbIndex: number }[]>()
  placements.forEach((pos, pcbIndex) => {
    const arr = map.get(pos.designId)
    if (arr) arr.push({ pos, pcbIndex })
    else map.set(pos.designId, [{ pos, pcbIndex }])
  })
  return map
}

/**
 * Perpendicular distance from `p` to the INFINITE line through `a`→`b`, plus
 * how far along that line (from `a`, in `a`→`b` units) the perpendicular
 * foot falls. Unlike `distancePointToSegment`, this is NOT clamped to the
 * segment — callers that need the projection coordinate (to place a tab
 * along an edge) must range-check `d` against `[0, edgeLen]` themselves.
 */
function projectPointOntoLine(p: Pt, a: Pt, b: Pt, edgeLen: number): { d: number; perpDist: number } {
  const ux = (b.x - a.x) / (edgeLen || 1)
  const uy = (b.y - a.y) / (edgeLen || 1)
  const vx = p.x - a.x
  const vy = p.y - a.y
  return { d: vx * ux + vy * uy, perpDist: Math.abs(vx * uy - vy * ux) }
}

/**
 * Resolve which per-PCB outline mode is actually used. `'bbox'`/`'contour'`
 * pass through unchanged; `'auto'` prefers `'bbox'` ONLY when the outline is
 * already a plain rectangle (`isRectangularOutline`), where the two modes
 * produce identical output for less work.
 */
export function resolveOutlineMode(
  mode: RoutingConfig['pcbOutlineMode'],
  outlineLayer: GerberLayer | null | undefined
): 'contour' | 'bbox' {
  if (mode === 'bbox') return 'bbox'
  if (mode === 'contour') return 'contour'
  if (outlineLayer && isRectangularOutline(outlineLayer)) return 'bbox'
  return 'contour'
}

/** Point-to-segment distance, clamped to the segment. Small and local rather
 *  than sharing `offset.ts`'s own copy — same reasoning as that file's own
 *  comment on this exact helper: small enough that a shared import isn't
 *  worth a new cross-file dependency. */
function distancePointToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const lenSq = dx * dx + dy * dy
  if (lenSq === 0) return Math.hypot(p.x - a.x, p.y - a.y)
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq
  t = Math.max(0, Math.min(1, t))
  const cx = a.x + t * dx
  const cy = a.y + t * dy
  return Math.hypot(p.x - cx, p.y - cy)
}

/** The four edges of a rectangle, as (start, end) corner pairs plus a name. */
function rectEdges(corners: Pt[]): { edge: RouteEdge; a: Pt; b: Pt }[] {
  // corners come out of offsetRectOutward CCW from lower-left:
  //   0 = LL, 1 = LR, 2 = UR, 3 = UL
  return [
    { edge: 'bottom', a: corners[0], b: corners[1] },
    { edge: 'right', a: corners[1], b: corners[2] },
    { edge: 'top', a: corners[2], b: corners[3] },
    { edge: 'left', a: corners[3], b: corners[0] },
  ]
}

function edgeEnabled(edge: RouteEdge, cfg: RoutingConfig): boolean {
  switch (edge) {
    case 'top': return cfg.tabTop
    case 'bottom': return cfg.tabBottom
    case 'left': return cfg.tabLeft
    case 'right': return cfg.tabRight
  }
}

/**
 * Pre-flight validation. Exported separately so the Routing panel can surface
 * problems *before* the user generates anything; `planRouting` calls the same
 * function internally so the two can never disagree.
 */
export function validateRouting(
  panel: PanelResult | null,
  panelConfig: PanelConfig,
  cfg: RoutingConfig,
  ctx: RoutingPlanContext = {}
): RoutingIssue[] {
  const issues: RoutingIssue[] = []

  if (!panel) {
    issues.push({
      id: 'no-panel',
      severity: 'info',
      title: 'No panel computed yet',
      detail: 'Create a panel on the Panel Config tab first — routing is planned against the panel layout.',
    })
    return issues
  }

  if (!cfg.routePanelOutline && !cfg.routeIndividualPcbs) {
    issues.push({
      id: 'no-scope',
      severity: 'info',
      title: 'Nothing selected to route',
      detail: 'Enable panel-outline routing, individual-PCB routing, or both.',
    })
  }

  const bit = cfg.bitDiameterMm
  if (!(bit > 0)) {
    issues.push({
      id: 'bad-bit',
      severity: 'error',
      title: 'Bit diameter must be greater than zero',
      detail: 'Pick a router bit size (1.0, 1.5 and 2.0 mm are the usual choices).',
    })
    return issues
  }

  // --- Gap vs bit. The single most common real-world conflict: the default
  // panel gap is 0.5mm, which no usable router bit fits through.
  if (cfg.routeIndividualPcbs) {
    const { gapX, gapY } = panelConfig
    const tooTight = gapX < bit - 1e-9 || gapY < bit - 1e-9
    const tooWide = gapX > bit + 1e-9 || gapY > bit + 1e-9

    if (tooTight) {
      issues.push({
        id: 'gap-too-small',
        severity: 'error',
        title: `Panel gap is narrower than the ${bit} mm bit`,
        detail:
          `The gaps between PCBs are ${gapX} × ${gapY} mm, so a ${bit} mm cutter physically cannot pass ` +
          `between adjacent boards. Widen the gaps to at least the bit diameter.`,
        fix: {
          label: `Set gaps to ${bit} mm`,
          panelConfigPatch: { gapX: bit, gapY: bit },
          rebuildPanel: true,
        },
      })
    } else if (tooWide) {
      issues.push({
        id: 'gap-too-wide',
        severity: 'warning',
        title: 'Panel gap is wider than the bit',
        detail:
          `Gaps of ${gapX} × ${gapY} mm against a ${bit} mm bit leave a thin rail of scrap between boards ` +
          `after one pass. Matching the gap to the bit diameter cuts both neighbours in a single pass.`,
        fix: {
          label: `Set gaps to ${bit} mm`,
          panelConfigPatch: { gapX: bit, gapY: bit },
          rebuildPanel: true,
        },
      })
    }

    // --- Rib margins. Derived from placements + panel size, NEVER from
    // config.sideRib*: computePanel places PCBs using sideRibTop for the Y
    // origin but positions the tooling-hole band from sideRibBottom, so with
    // asymmetric ribs the two disagree. Measuring the real layout sidesteps it.
    const first = panel.placements[0]
    if (first) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
      for (const p of panel.placements) {
        minX = Math.min(minX, p.x)
        minY = Math.min(minY, p.y)
        maxX = Math.max(maxX, p.x + p.w)
        maxY = Math.max(maxY, p.y + p.h)
      }
      const margins = {
        left: minX,
        bottom: minY,
        right: panel.panelWidth - maxX,
        top: panel.panelHeight - maxY,
      }
      const tight = Object.entries(margins).filter(([, m]) => m < bit - 1e-9)
      if (tight.length > 0) {
        issues.push({
          id: 'rib-too-narrow',
          severity: 'warning',
          title: 'Panel rib narrower than the bit',
          detail:
            `Measured rib margins (mm): ${Object.entries(margins).map(([k, v]) => `${k} ${v.toFixed(2)}`).join(', ')}. ` +
            `Ribs narrower than the ${bit} mm bit leave no room for the cutter between the outer PCBs and the panel edge.`,
        })
      }
    }
  }

  // --- Tab fit. Mirrors the arm-length guards the L-shape emitters already use.
  // Worst case across every placement (not just the first) — a multi-design
  // panel's designs can be different sizes, and the SAME tabsPerEdge/tabWidthMm
  // apply panel-wide (no per-design override), so whichever design is
  // tightest is the one that could actually fail.
  if (cfg.routeIndividualPcbs && cfg.tabStyle !== 'none') {
    const pathGap = cfg.tabWidthMm + bit
    const shortest = panel.placements.reduce((min, p) => Math.min(min, p.w, p.h), Infinity)
    if (Number.isFinite(shortest) && cfg.tabsPerEdge * pathGap >= shortest) {
      issues.push({
        id: 'tabs-dont-fit',
        severity: 'error',
        title: 'Tabs do not fit on the shortest edge',
        detail:
          `${cfg.tabsPerEdge} tabs of ${cfg.tabWidthMm} mm need ${(cfg.tabsPerEdge * pathGap).toFixed(2)} mm of ` +
          `interrupted path (each tab consumes tabWidth + bit = ${pathGap.toFixed(2)} mm), but the shortest PCB edge ` +
          `is ${shortest.toFixed(2)} mm. Reduce the tab count or width.`,
      })
    }

    if (cfg.tabStyle === 'mousebite') {
      const usable = cfg.tabWidthMm - cfg.mouseBiteHoleDiameterMm
      const n = usable <= 0 ? 2 : Math.max(2, Math.floor(usable / cfg.mouseBiteHolePitchMm) + 1)
      const span = (n - 1) * cfg.mouseBiteHolePitchMm + cfg.mouseBiteHoleDiameterMm
      if (span > cfg.tabWidthMm + 1e-9) {
        issues.push({
          id: 'bites-overflow-tab',
          severity: 'warning',
          title: 'Mouse-bite row is wider than the tab',
          detail:
            `${n} holes at ${cfg.mouseBiteHolePitchMm} mm pitch span ${span.toFixed(2)} mm, but the tab is only ` +
            `${cfg.tabWidthMm} mm wide. The row will be compressed to fit; widen the tab or reduce the pitch.`,
        })
      }
    }
  }

  // --- Honesty constraint: bbox mode routes bounding boxes, not the real
  // profile. Mode-aware: only fires when bbox mode is what's ACTUALLY going
  // to run (contour/auto-resolved-to-contour follow the real outline, so
  // this warning would be actively wrong there). Checked PER DESIGN — a
  // multi-design panel can mix a plain-rectangle design with a shaped one,
  // and only the shaped one under bbox mode is actually over-cut.
  const designIdsForOutlineCheck = [...new Set(panel.placements.map(p => p.designId))]
  const offendingDesigns: string[] = []
  for (const designId of designIdsForOutlineCheck) {
    const outlineLayer = contextForDesign(ctx, designId).outlineLayer
    if (!outlineLayer || isRectangularOutline(outlineLayer)) continue
    if (resolveOutlineMode(cfg.pcbOutlineMode, outlineLayer) === 'bbox') offendingDesigns.push(designId)
  }
  if (offendingDesigns.length > 0) {
    const designSummary = panel.designs.filter(d => offendingDesigns.includes(d.designId))
    const which = designSummary.length > 1 ? ` (${designSummary.map(d => d.name).join(', ')})` : ''
    issues.push({
      id: 'outline-not-rectangular',
      severity: 'warning',
      title: 'Board outline is not a plain rectangle',
      detail:
        `Route paths follow each PCB's bounding box${which} because outline mode is set to Bounding box. A shaped ` +
        'board will be over-cut at its non-rectangular features — switch outline mode to Contour or Auto to ' +
        'follow the real board profile instead.',
    })
  }

  return issues
}

/**
 * Plan every router pass for a panel.
 *
 * All returned `points` are tool-CENTER coordinates in panel-absolute Gerber
 * Y-up mm, already offset outward by the bit radius.
 */
export function planRouting(
  panel: PanelResult,
  panelConfig: PanelConfig,
  cfg: RoutingConfig,
  ctx: RoutingPlanContext = {}
): RoutingResult {
  const issues = validateRouting(panel, panelConfig, cfg, ctx)
  const bit = cfg.bitDiameterMm
  const r = bit / 2

  const paths: RoutePath[] = []
  const tabs: RouteTab[] = []

  // ---- Per-PCB perimeters --------------------------------------------------
  // Resolved PER DESIGN — a multi-design panel's placements are not all the
  // same board, so whether contour tracing is even relevant can differ
  // design by design (e.g. a plain-rectangle design next to a shaped one).
  const placementsByDesign = groupPlacementsByDesign(panel.placements)
  const resolvedModeByDesign = new Map<string, 'contour' | 'bbox'>()
  for (const designId of placementsByDesign.keys()) {
    resolvedModeByDesign.set(designId, resolveOutlineMode(cfg.pcbOutlineMode, contextForDesign(ctx, designId).outlineLayer))
  }
  // Reported summary mode — 'contour' if ANY design actually routes as
  // contour, so the emitters/README never silently hide that at least one
  // board follows a traced profile rather than a bounding box.
  const resolvedMode: 'contour' | 'bbox' =
    [...resolvedModeByDesign.values()].some(m => m === 'contour') ? 'contour' : 'bbox'

  if (cfg.routeIndividualPcbs && bit > 0) {
    const contourDesignIds = [...resolvedModeByDesign.entries()].filter(([, m]) => m === 'contour').map(([id]) => id)

    const bboxEntries: { pos: PanelPlacement; pcbIndex: number }[] = []
    for (const [designId, entries] of placementsByDesign) {
      if (resolvedModeByDesign.get(designId) === 'bbox') bboxEntries.push(...entries)
    }

    // Contour-mode designs run FIRST so their tabs already exist in the
    // shared `tabs` array by the time the bbox pass below folds in "foreign
    // tab" protection (its own Phase 2, which scans the whole `tabs` array)
    // — that gives bbox-side protection against cutting through a contour
    // tab. The REVERSE direction (a bbox neighbor's tab surviving a
    // contour pass computed before that tab existed) is covered by handing
    // contour the bbox side's own DEFAULT tab positions up front, computed
    // here purely for that avoidance check — `runBboxModeRouting` below
    // still computes and emits its own (possibly realigned) tabs exactly as
    // before, this is a read-only preview of where they'll default to.
    const foreignTabPointsAbs =
      contourDesignIds.length > 0 && bboxEntries.length > 0
        ? bboxDefaultTabWorldPoints(computeBboxEdgeDefaults(bboxEntries, panel.toolingHoles, cfg, r), r)
        : []

    if (contourDesignIds.length > 0) {
      runContourModeRouting(contourDesignIds, placementsByDesign, ctx, panel, panelConfig, cfg, bit, r, paths, tabs, issues, foreignTabPointsAbs)
    }

    if (bboxEntries.length > 0) {
      runBboxModeRouting(bboxEntries, panel.placements, panel.toolingHoles, cfg, bit, r, paths, tabs)
    }
  }

  // ---- Panel perimeter -------------------------------------------------------
  // Generated AFTER per-PCB paths/tabs (not before, as originally written) —
  // it needs to know where those tabs landed. Ordinarily the panel is cut
  // from a larger sheet and gets no tabs of its own: one clean closed loop,
  // since that cut is physically distinct from — offset further out than —
  // any per-PCB edge (there's a rib of raw material between them). But when
  // the corresponding side rib is REMOVED (`sideRib* === 0`), the panel's
  // own outer edge and the outermost PCBs' edge on that side become the
  // SAME line (both offset outward from the same physical boundary by the
  // same bit radius) — so a panel-outline loop that's unconditionally
  // uninterrupted cuts straight through whatever tab that PCB edge already
  // has there, silently destroying it. Confirmed live: a real no-side-rib
  // panel's left-edge break tab sat directly under the (fully continuous)
  // panel-outline pass. Fixed by reusing each qualifying PCB's ALREADY-
  // COMPUTED tab positions as silent interrupts here too — same idea as the
  // contour per-instance loop's own `extraSilentDs` (a gap with no NEW
  // `RouteTab` emitted, since the owning PCB's tab already represents this
  // physical location) — rather than trying to independently re-derive tab
  // placement for an edge this loop doesn't otherwise know anything about.
  if (cfg.routePanelOutline && bit > 0) {
    const corners = offsetRectOutward(0, 0, panel.panelWidth, panel.panelHeight, r)
    const outlinePts = [...corners, corners[0]]
    const outlineTable = buildArcLength(outlinePts)
    const pathGap = cfg.tabWidthMm + bit

    const sideRibByEdge: Record<RouteEdge, number> = {
      left: panelConfig.sideRibLeft,
      right: panelConfig.sideRibRight,
      bottom: panelConfig.sideRibBottom,
      top: panelConfig.sideRibTop,
    }

    // Which tabs coincide with the panel's own outer boundary — GEOMETRIC,
    // not lattice-derived. The old test asked "is this tab's owning PCB in
    // the outermost grid row/column" (`col === 0`, `col === maxCol`, …),
    // which only means anything for a uniform `rows × cols` lattice; a
    // packed, non-uniform layout has no such column to compare against.
    // The physical fact this needs to detect — the PCB's own offset edge and
    // the panel's own offset edge are literally the same cut line — is
    // exactly what `nearestArcLengthOnRing` already measures, so ask it
    // directly instead of inferring the answer from grid position.
    //
    // ⚠ The match is `distance ≈ r`, NOT `distance ≈ 0`. `t.center` sits on
    // the true, un-offset PCB edge (RouteTab.center is deliberately the real
    // edge point — see the mouse-bite-hole convention elsewhere in this
    // file), while `outlinePts` is the panel's cut line, offset OUTWARD by
    // the bit radius `r`. A genuinely coincident tab is therefore always
    // `r` away from the ring, not 0 — confirmed live: an initial version of
    // this check used a near-zero tolerance and found ZERO matches on a real
    // no-side-rib panel where the col/row version found 8, since every real
    // edge tab sits exactly one bit-radius off the ring by construction.
    // Only reachable when `sideRibByEdge[edge] === 0` (below), so a genuine
    // coincidence lands within float noise of `r`; anything farther away is
    // a different PCB's tab on an interior edge that merely shares the same
    // `edge` label (e.g. an interior column's own 'left' edge, which is not
    // remotely close to the panel's actual left boundary).
    const boundaryToleranceMm = 0.01
    const interruptDs: number[] = []
    for (const edge of ['left', 'right', 'bottom', 'top'] as const) {
      if (sideRibByEdge[edge] > 0) continue // rib present — physically separate cut, no interruption needed
      for (const t of tabs) {
        if (t.edge !== edge) continue
        const { d, distance } = nearestArcLengthOnRing(outlinePts, outlineTable, t.center)
        if (Math.abs(distance - r) > boundaryToleranceMm) continue
        interruptDs.push(d)
      }
    }

    if (interruptDs.length === 0) {
      paths.push({ id: 'panel-outline', role: 'panel-outline', points: outlinePts, closed: true, toolDiameterMm: bit })
    } else {
      const interrupts: Span[] = interruptDs.map(d => ({ start: d - pathGap / 2, end: d + pathGap / 2 }))
      const cutSpans = splitClosedByTabs(outlineTable.perimeterMm, interrupts)
      for (const span of cutSpans) {
        paths.push({
          id: `panel-outline-${span.start.toFixed(3)}`,
          role: 'panel-outline',
          points: extractArcSpan(outlinePts, outlineTable, span.start, span.end),
          closed: false,
          toolDiameterMm: bit,
        })
      }
    }
  }

  // ---- Tooling/reference hole clearance -------------------------------------
  // A depaneling router path runs offset outward from the PCB/panel edge by
  // the bit radius, by design — so a tooling or reference hole placed too
  // close to that same edge (see panelization-engine.ts's `toolingHoleInset`,
  // which sizes the hole row's clearance from the grid edge) can end up
  // inside the swept cut. That panel-compute-time default is tuned for a
  // representative bit/hole size, but can't see the ACTUAL bit chosen here,
  // nor a custom tooling/reference hole diameter, nor the slightly different
  // corner geometry a contour-mode round join produces versus a bbox miter —
  // confirmed live: even after correcting the panel-compute-time formula,
  // one contour-routed corner still landed ~1mm inside a hole it should have
  // cleared. This check is the authoritative, bit-aware backstop: it runs
  // against the REAL computed paths (panel-outline, bbox, and contour alike,
  // generically — no per-mode branching needed) rather than trying to
  // predict geometry ahead of time.
  for (const hole of panel.toolingHoles) {
    const holeR = hole.diameter / 2
    let closestMm = Infinity
    for (const path of paths) {
      for (let i = 0; i < path.points.length - 1; i++) {
        closestMm = Math.min(closestMm, distancePointToSegment({ x: hole.x, y: hole.y }, path.points[i], path.points[i + 1]))
      }
    }
    if (closestMm < r + holeR - 1e-9) {
      issues.push({
        id: 'hole-routing-collision',
        severity: 'warning',
        title: `${hole.type === 'tooling' ? 'Tooling' : 'Reference'} hole overlaps the routed cut`,
        detail:
          `${hole.id} at (${hole.x.toFixed(2)}, ${hole.y.toFixed(2)}) is only ${closestMm.toFixed(2)} mm from the ` +
          `routed path, but the ${bit} mm bit's cut plus this ${hole.diameter} mm hole need ${(r + holeR).toFixed(2)} mm ` +
          `of clearance. The router will cut through part of the hole. Increase the panel's Pinning Inset, or ` +
          `use a smaller bit.`,
        locations: [{ x: hole.x, y: hole.y }],
      })
    }
  }

  // ---- Tools ---------------------------------------------------------------
  const tools: RouteToolDef[] = []
  if (paths.length > 0) tools.push({ index: 1, diameterMm: bit, kind: 'router' })
  const anyHoles = tabs.some(t => t.holes.length > 0)
  if (anyHoles) tools.push({ index: tools.length + 1, diameterMm: cfg.mouseBiteHoleDiameterMm, kind: 'drill' })

  const totalPathLengthMm = paths.reduce((sum, p) => sum + polylineLengthMm(p.points), 0)

  return {
    paths,
    tabs,
    tools,
    issues,
    totalPathLengthMm,
    config: { ...cfg },
    panelWidthMm: panel.panelWidth,
    panelHeightMm: panel.panelHeight,
    generatedAt: new Date().toISOString(),
    pcbOutlineMode: resolvedMode,
  }
}

/**
 * Bbox-mode routing for a set of placements (which may span several
 * designs — bbox geometry reads `pos.w`/`pos.h`/`pos.x`/`pos.y` straight off
 * each placement already, so it never needed a "the" board size or outline in
 * the first place). Mutates `paths`/`tabs` in place.
 *
 * Extracted verbatim from `planRouting`'s own bbox branch (Phase A) — no
 * behavior change, only parameterized over `entries` instead of reading
 * `panel.placements.entries()` directly, so `planRouting` can restrict it to
 * just the bbox-resolved subset of a multi-design panel while preserving
 * every placement's original global `pcbIndex`.
 */
type BboxEdgeDefault = { pcbIndex: number; edge: RouteEdge; a: Pt; b: Pt; edgeLen: number; centersAlong: number[]; isReversedEdge: boolean; pos: PanelPlacement }

/**
 * Each bbox-mode PCB's OWN default tab centers — needs nothing but that
 * PCB's own geometry, no path emission yet. Extracted out of
 * `runBboxModeRouting` (where it's still Sub-pass 1 of that function) so
 * `planRouting` can also call it standalone, EARLY, purely to learn where a
 * bbox design's tabs will default to — before contour-mode designs run —
 * so a contour instance sharing a gap with a bbox neighbor can avoid
 * cutting through a tab that doesn't exist yet. See `runContourModeRouting`'s
 * `foreignTabPointsAbs` param for why: contour runs first, so without this,
 * a bbox default tab at a position contour never independently protects
 * (no contour tab of its own nearby) gets destroyed by contour's own
 * already-finalized, unaware pass — the "reverse" half of the documented
 * one-directional cross-mode tab protection gap.
 */
function computeBboxEdgeDefaults(
  entries: { pos: PanelPlacement; pcbIndex: number }[],
  toolingHoles: PanelResult['toolingHoles'],
  cfg: RoutingConfig,
  r: number
): BboxEdgeDefault[] {
  const pathGap = cfg.tabWidthMm + r * 2
  const perEdgeInfos: BboxEdgeDefault[] = []

  for (const { pos, pcbIndex } of entries) {
    const corners = offsetRectOutward(pos.x, pos.y, pos.w, pos.h, r)

    for (const { edge, a, b } of rectEdges(corners)) {
      const edgeLen = segmentLength(a, b)

      // `rectEdges`' a->b direction is a CCW perimeter walk (bottom: LL->LR;
      // right: LR->UR; top: UR->UL; left: UL->LL) so that consecutive edges'
      // segments chain end-to-end for the wrap-around stitching below — but
      // that means 'top' and 'left' measure distance-along-edge in the
      // OPPOSITE direction from 'bottom' and 'right'. Tab positions must NOT
      // use that same reversed direction: two facing PCBs across a panel gap
      // (say, one row's top edge and the row above's bottom edge) would then
      // measure a custom tabPositionsMm value from opposite ends, landing
      // tabs at DIFFERENT absolute positions on the two boards. Symmetric
      // auto-spacing (evenTabCenters) survives this by luck — an evenly-
      // spaced-with-equal-margins set is always symmetric under reflection —
      // but a real customer file using a custom override hit exactly this:
      // with mergeCoincidentPasses sharing one pass down the gap centreline,
      // each board's own pass then cut straight through its NEIGHBOUR's
      // now-misaligned tab, silently destroying tabs on both sides with no
      // error. Canonicalise: always measure tab distance left-to-right for
      // horizontal edges and bottom-to-top for vertical edges, regardless of
      // which edge label it is. (This canonical "dGlobal" convention is also
      // exactly what `tab-alignment.ts`'s `worldPointToDGlobal`/
      // `dGlobalToWorldCoord`/`worldCoordToDGlobal` assume — no further
      // reversal correction needed when using those.)
      const isReversedEdge = edge === 'top' || edge === 'left'

      const wantTabs = cfg.tabStyle !== 'none' && edgeEnabled(edge, cfg)
      const centersAlong: number[] = []
      if (wantTabs && edgeLen > 0) {
        const override = parseTabPositions(cfg.tabPositionsMm, edgeLen)
        const autoCenters = override.length > 0 ? override : evenTabCenters(edgeLen, cfg.tabsPerEdge)
        centersAlong.push(...autoCenters)

        // ⚠ Protective tabs: a tooling/reference hole close enough to this
        // edge's routed path that a continuous cut would run through it
        // gets a forced tab instead — a tab means the cutter genuinely
        // never removes material across that span, which protects the
        // hole regardless of how tight the panel-compute-time clearance
        // margin turned out to be (a narrow rib can't always afford one).
        // Confirmed live: a real panel's bottom-left pinning hole sat
        // right against the routed edge with only the bare theoretical
        // minimum of clearance. `centersAlong` stays in the same
        // "dGlobal" convention `override`/`evenTabCenters` already use —
        // `projectPointOntoLine` is computed in the raw a→b walk
        // direction, so it needs the same `isReversedEdge` correction
        // applied everywhere else in this loop before being merged in.
        for (const hole of toolingHoles) {
          const holeR = hole.diameter / 2
          const { d, perpDist } = projectPointOntoLine(hole, a, b, edgeLen)
          if (d < 0 || d > edgeLen) continue
          if (perpDist >= r + holeR + HOLE_TAB_PROTECTION_MARGIN_MM) continue
          const dGlobalForHole = isReversedEdge ? edgeLen - d : d
          const alreadyCovered = centersAlong.some(c => Math.abs(c - dGlobalForHole) < pathGap)
          if (!alreadyCovered) centersAlong.push(dGlobalForHole)
        }
      }

      perEdgeInfos.push({ pcbIndex, edge, a, b, edgeLen, centersAlong, isReversedEdge, pos })
    }
  }

  return perEdgeInfos
}

/**
 * Flattens `computeBboxEdgeDefaults`' per-edge centers into panel-absolute
 * board-edge points (via `boardEdgePoint`, the same conversion Sub-pass 2
 * uses for real tab emission) — the shape `runContourModeRouting` needs to
 * treat them as foreign points to avoid cutting through.
 */
function bboxDefaultTabWorldPoints(perEdgeInfos: BboxEdgeDefault[], r: number): Pt[] {
  const pts: Pt[] = []
  for (const { pos, edge, edgeLen, centersAlong, isReversedEdge } of perEdgeInfos) {
    for (const dGlobal of centersAlong) {
      const d = isReversedEdge ? edgeLen - dGlobal : dGlobal
      pts.push(boardEdgePoint(pos, edge, d, r))
    }
  }
  return pts
}

function runBboxModeRouting(
  entries: { pos: PanelPlacement; pcbIndex: number }[],
  allPlacements: PanelPlacement[],
  toolingHoles: PanelResult['toolingHoles'],
  cfg: RoutingConfig,
  bit: number,
  r: number,
  paths: RoutePath[],
  tabs: RouteTab[]
): void {
  // Collect as segments first so coincident passes along shared gaps can be
  // deduped across PCB instances before being turned into paths.
  const pending: { pcbIndex: number; edge: RouteEdge; seg: RouteSegment }[] = []

  // Three sub-passes, not one — Sub-pass 1 below computes each PCB's OWN
  // default tabs (needs nothing but that PCB's own geometry, no emission
  // yet); Sub-pass 1.5 reconciles tabs on FACING edges between adjacent
  // placements (needs every PCB's defaults to already exist); Sub-pass 2
  // emits the final `RouteTab`s. Phase 2 (after all of this) then folds in
  // silent interrupts for any FOREIGN PCB's tab that physically coincides
  // with this edge, which by definition can't be known until every PCB's
  // real tabs exist. See that phase's own comment for why that's separate.
  const pathGap = cfg.tabWidthMm + bit

  // ---- Sub-pass 1: each PCB's own default tab centers ----------------------
  const perEdgeInfos = computeBboxEdgeDefaults(entries, toolingHoles, cfg, r)

  // ---- Sub-pass 1.5: align tabs on FACING edges between adjacent PCBs -----
  // Deliberately placement-geometric (AABB-based via `findFacingPairs`), not
  // grid-lattice-based — works the same for a uniform grid panel and a
  // packed, non-uniform multi-design panel. Two cases are handled; a third
  // (both sides contour-mode) is a documented, accepted v1 gap — see
  // CLAUDE.md's routing section for why that one is harder (contour tabs are
  // computed once per DESIGN in file space and shared across every instance,
  // not per placement, so "align this one instance's tab" doesn't have a
  // clean seam the way it does here).
  //
  // Confirmed on a real fabricated panel: a rounded (contour-mode) board's
  // single bottom-edge tab landed at world X≈93mm while neither rectangular
  // board below it had a tab anywhere near that X — this sub-pass is what
  // makes the bbox follower(s) grow a REAL tab at that exact position
  // instead of just silently avoiding a re-cut (which is all Phase 2 below
  // has ever done).
  //
  // ⚠ SNAP-OR-ADD, never remove. An earlier version of this pass removed
  // every one of the follower's own within-window defaults and replaced
  // them with the anchor's — correct-looking on paper, but a contour design
  // typically has far FEWER total tabs (`tabsPerContour`, spread across its
  // WHOLE perimeter) than a facing bbox edge's own `tabsPerEdge`, so
  // wholesale replacement could silently DROP tab support the follower
  // would otherwise have had (2 defaults down to 1 aligned tab, confirmed
  // live on a synthetic reproduction of the reported panel). This fix is
  // about ALIGNMENT, not about how many tabs an edge gets — so for each
  // anchor tab, the nearest follower default within `pathGap` is SNAPPED
  // onto the anchor's exact position (no count change); only when no
  // follower default is close enough is a genuinely NEW tab ADDED. Any
  // follower default not claimed by a snap is left untouched.
  {
    const edgeInfoByPcb = new Map<number, Map<RouteEdge, (typeof perEdgeInfos)[number]>>()
    for (const info of perEdgeInfos) {
      if (!edgeInfoByPcb.has(info.pcbIndex)) edgeInfoByPcb.set(info.pcbIndex, new Map())
      edgeInfoByPcb.get(info.pcbIndex)!.set(info.edge, info)
    }

    const inWindow = (worldCoord: number, pair: ReturnType<typeof findFacingPairs>[number]) =>
      worldCoord >= pair.overlapStart - 1e-6 && worldCoord <= pair.overlapEnd + 1e-6

    // Snap the nearest follower default (within pathGap, not already
    // claimed by an earlier anchor tab in this same call) onto `d`; if none
    // qualifies, add `d` as a new tab. `claimed` is per-edge so multiple
    // anchor tabs against the same follower edge don't double-claim one
    // default.
    const snapOrAdd = (follower: (typeof perEdgeInfos)[number], d: number, claimed: Set<number>) => {
      if (d < 0 || d > follower.edgeLen) return
      let nearestIdx = -1
      let nearestDist = Infinity
      follower.centersAlong.forEach((c, idx) => {
        if (claimed.has(idx)) return
        const dist = Math.abs(c - d)
        if (dist < nearestDist) { nearestDist = dist; nearestIdx = idx }
      })
      if (nearestIdx >= 0 && nearestDist < pathGap) {
        follower.centersAlong[nearestIdx] = d
        claimed.add(nearestIdx)
      } else {
        follower.centersAlong.push(d)
      }
    }

    const facingPairs = findFacingPairs(
      allPlacements.map((pos, pcbIndex) => ({ pos, pcbIndex })),
      pathGap
    )

    for (const pair of facingPairs) {
      const aInfo = edgeInfoByPcb.get(pair.aIndex)?.get(pair.aSide)
      const bInfo = edgeInfoByPcb.get(pair.bIndex)?.get(pair.bSide)

      if (aInfo && bInfo) {
        // Both sides bbox: anchor = whichever side already has more tabs in
        // the shared window (tie-break lower pcbIndex, for determinism).
        // For an already-matching pair (same edge length + position — the
        // common uniform-grid case) every anchor tab snaps onto an
        // identical follower default at distance 0, so this is a no-op.
        const aWindowCount = aInfo.centersAlong.filter(c => inWindow(dGlobalToWorldCoord(aInfo.pos, aInfo.edge, c, r), pair)).length
        const bWindowCount = bInfo.centersAlong.filter(c => inWindow(dGlobalToWorldCoord(bInfo.pos, bInfo.edge, c, r), pair)).length
        const anchorIsA = aWindowCount > bWindowCount || (aWindowCount === bWindowCount && pair.aIndex < pair.bIndex)
        const anchor = anchorIsA ? aInfo : bInfo
        const follower = anchorIsA ? bInfo : aInfo

        const anchorWorldCoords = anchor.centersAlong
          .filter(c => inWindow(dGlobalToWorldCoord(anchor.pos, anchor.edge, c, r), pair))
          .map(c => dGlobalToWorldCoord(anchor.pos, anchor.edge, c, r))

        const claimed = new Set<number>()
        for (const worldCoord of anchorWorldCoords) {
          snapOrAdd(follower, worldCoordToDGlobal(follower.pos, follower.edge, worldCoord, r), claimed)
        }
      } else if (aInfo || bInfo) {
        // One side is contour-mode (not in `entries`/`edgeInfoByPcb` at
        // all) — contour is always the anchor, since it already ran to
        // completion and its real, final tab world positions already exist
        // in `tabs`. The bbox side is always the follower here.
        //
        // A contour ring's tabs are spread by arc length across its WHOLE
        // perimeter, not confined to one edge — filtering only by the
        // perpendicular-axis window isn't enough, since a tab on the
        // contour's far side can numerically land inside that window
        // without being anywhere near this particular facing gap (caught by
        // the headless synthetic-panel check: a tab on the contour design's
        // TOP edge shared enough X-range with a bbox neighbour below its
        // BOTTOM edge to pass the window filter alone). Also require the
        // tab's SEPARATION-axis coordinate to sit close to the follower's
        // own facing edge line — real facing tabs are within the gap
        // distance of it by construction; anything farther is a different
        // part of the same ring.
        const bboxInfo = aInfo ?? bInfo!
        const contourPcbIndex = aInfo ? pair.bIndex : pair.aIndex
        const perpIsY = bboxInfo.edge === 'left' || bboxInfo.edge === 'right'
        const followerEdgeCoord =
          bboxInfo.edge === 'left' ? bboxInfo.pos.x
          : bboxInfo.edge === 'right' ? bboxInfo.pos.x + bboxInfo.pos.w
          : bboxInfo.edge === 'bottom' ? bboxInfo.pos.y
          : bboxInfo.pos.y + bboxInfo.pos.h
        const separationToleranceMm = pair.gapMm + pathGap

        const anchorWorldPts = tabs
          .filter(t => t.pcbIndex === contourPcbIndex)
          .map(t => t.center)
          .filter(p => inWindow(perpIsY ? p.y : p.x, pair))
          .filter(p => Math.abs((perpIsY ? p.x : p.y) - followerEdgeCoord) <= separationToleranceMm)

        const claimed = new Set<number>()
        for (const worldPt of anchorWorldPts) {
          snapOrAdd(bboxInfo, worldPointToDGlobal(bboxInfo.pos, bboxInfo.edge, worldPt, r), claimed)
        }
      }
      // else: both sides contour-mode — documented v1 limitation, skip.
    }
  }

  // ---- Sub-pass 2: emit tabs from the final (possibly reconciled) centers -
  for (const { pos, edge, a, b, edgeLen, centersAlong, isReversedEdge, pcbIndex } of perEdgeInfos) {
    for (const dGlobal of centersAlong) {
      const d = isReversedEdge ? edgeLen - dGlobal : dGlobal

      // The tab itself lives on the BOARD edge, not this offset tool path.
      // Shift the point back inward by r along the edge's inward normal.
      const tabCenter = boardEdgePoint(pos, edge, d, r)
      const dir = { x: (b.x - a.x) / (edgeLen || 1), y: (b.y - a.y) / (edgeLen || 1) }
      const holes =
        cfg.tabStyle === 'mousebite'
          ? mouseBiteHoleCenters(
              pullOutward(tabCenter, outwardNormalForEdge(edge), cfg.mouseBiteHoleDiameterMm, cfg.mouseBiteEdgeClearanceMm),
              dir,
              cfg.tabWidthMm,
              cfg.mouseBiteHoleDiameterMm,
              cfg.mouseBiteHolePitchMm
            )
          : []

      tabs.push({
        id: `tab-${pcbIndex}-${edge}-${dGlobal.toFixed(3)}`,
        style: cfg.tabStyle === 'mousebite' ? 'mousebite' : 'solid',
        center: tabCenter,
        dir,
        widthMm: cfg.tabWidthMm,
        edge,
        pcbIndex,
        holes,
        holeDiameterMm: cfg.mouseBiteHoleDiameterMm,
      })
    }
  }

  // ⚠ Phase 2 — fold in silent interrupts for FOREIGN tabs, mirroring the
  // contour branch's own `extraSilentDs` (see its comment for the full
  // rationale). Why this is needed even though `isReversedEdge` above
  // already canonicalises tab position measurement: that canonicalisation
  // only guarantees two FACING edges compute the SAME interrupt positions
  // when those edges also share the same length and tab layout — true for a
  // uniform grid of ONE design, but not something a panel with different-
  // sized boards facing each other (a real possibility now) could rely on.
  // Checking each tab's REAL position against THIS edge's own line — the
  // same `nearestArcLengthOnRing`-style geometric test the contour branch
  // already uses — has no such assumption baked in.
  //
  // For a uniform single-design grid this finds ZERO new interrupts: every
  // foreign tab that geometrically coincides with an edge already has an
  // OWNED interrupt covering that exact position (by the same
  // canonicalisation), so `alreadyCovered` is always true. Verified live
  // against a dedicated no-side-rib, mismatched-tab-count fixture that
  // reproduces the documented tab-destruction failure mode, and against the
  // full golden export corpus (byte-identical).
  const coincidenceToleranceMm = r + 0.05
  for (const { pcbIndex, edge, a, b, edgeLen, centersAlong, isReversedEdge } of perEdgeInfos) {
    const pathGap = cfg.tabWidthMm + bit
    const interrupts: Span[] = centersAlong.map(dGlobal => {
      const d = isReversedEdge ? edgeLen - dGlobal : dGlobal
      return { start: d - pathGap / 2, end: d + pathGap / 2 }
    })

    for (const t of tabs) {
      if (t.pcbIndex === pcbIndex) continue // this PCB's own tabs are already covered above
      const { d, perpDist } = projectPointOntoLine(t.center, a, b, edgeLen)
      if (d < 0 || d > edgeLen) continue
      if (perpDist >= coincidenceToleranceMm) continue
      const alreadyCovered = interrupts.some(iv => d >= iv.start && d <= iv.end)
      if (alreadyCovered) continue
      interrupts.push({ start: d - pathGap / 2, end: d + pathGap / 2 })
    }

    for (const span of splitEdgeByTabs(edgeLen, interrupts)) {
      pending.push({
        pcbIndex,
        edge,
        seg: { a: pointAlong(a, b, span.start), b: pointAlong(a, b, span.end) },
      })
    }
  }

  const segs = pending.map(p => p.seg)
  const kept = cfg.mergeCoincidentPasses ? dedupeCoincidentSegments(segs) : segs
  const keptSet = new Set(kept)

  // Stitch consecutive kept segments into one continuous path instead of
  // lifting the cutter at every corner. `pending` is walked in its natural
  // order — bottom → right → top → left, ascending distance within each
  // edge — which is exactly perimeter-walk order, so two segments merge
  // whenever the previous one's end meets this one's start on the SAME PCB.
  // That only fails to hold at an actual tab (by construction, tab spans on
  // one edge never touch — there's always an interrupt between them) or where
  // a dedup drop leaves a real gap for a neighbouring PCB's own pass to cover.
  //
  // A real CAM350-produced routing file confirmed this matters: the machine
  // only retracts at tabs, cutting straight through untabbed corners as one
  // continuous move (see the diagonal corner cuts in a production
  // Cutting*.NC — three chained points with no intervening lift). Lifting at
  // every corner regardless produced 2x the retract/plunge cycles a real
  // router would use for the same board.
  let current: RoutePath | null = null
  for (const p of pending) {
    if (!keptSet.has(p.seg)) {
      current = null
      continue
    }
    if (current && current.pcbIndex === p.pcbIndex && ptsClose(current.points[current.points.length - 1], p.seg.a)) {
      current.points.push(p.seg.b)
    } else {
      current = {
        id: `pcb-${p.pcbIndex}-${p.seg.a.x.toFixed(3)}-${p.seg.a.y.toFixed(3)}`,
        role: 'pcb-outline',
        pcbIndex: p.pcbIndex,
        points: [p.seg.a, p.seg.b],
        closed: false,
        toolDiameterMm: bit,
      }
      paths.push(current)
    }
  }

  // Wrap-around merge. The walk above is a linear scan (bottom → right →
  // top → left) of what is actually a CYCLE — the perimeter has no true
  // start. So it merges every non-tab corner except one: the seam between
  // the last edge processed (left) and the first (bottom), i.e. the
  // bottom-left corner. If a tab happens to sit elsewhere, that corner gets
  // treated as a false path boundary purely because of where this function's
  // own loop started, not because the real cutter would lift there. Fix it
  // by merging each PCB's first-built and last-built path when they meet.
  const pathsByPcb = new Map<number, RoutePath[]>()
  for (const p of paths) {
    if (p.role !== 'pcb-outline' || p.pcbIndex === undefined) continue
    if (!pathsByPcb.has(p.pcbIndex)) pathsByPcb.set(p.pcbIndex, [])
    pathsByPcb.get(p.pcbIndex)!.push(p)
  }
  for (const group of pathsByPcb.values()) {
    if (group.length < 2) continue
    const first = group[0]
    const last = group[group.length - 1]
    if (ptsClose(last.points[last.points.length - 1], first.points[0])) {
      // last's final point duplicates first's start point — drop it once.
      last.points = [...last.points.slice(0, -1), ...first.points]
      const firstIdx = paths.indexOf(first)
      if (firstIdx >= 0) paths.splice(firstIdx, 1)
    }
  }

  // A path that walked all the way back to its own start (every edge on
  // this PCB uncut, i.e. no tabs anywhere) is a closed loop, not an open one.
  for (const path of paths) {
    if (path.role === 'pcb-outline' && path.points.length > 2 && ptsClose(path.points[0], path.points[path.points.length - 1])) {
      path.closed = true
    }
  }
}

function outwardNormalForEdge(edge: RouteEdge): Pt {
  switch (edge) {
    case 'bottom': return { x: 0, y: -1 }
    case 'top': return { x: 0, y: 1 }
    case 'left': return { x: -1, y: 0 }
    case 'right': return { x: 1, y: 0 }
  }
}

/**
 * Shift a point outward (away from the board body, along `outward`) by
 * enough that a hole of `holeDiameterMm` centred at the result clears the
 * true edge by `clearanceMm` on its NEAR side — i.e. the whole hole sits
 * outside the finished board with at least that much air gap, rather than
 * straddling the cut line (the traditional half-in-half-out mouse-bite
 * convention, which leaves a semicircular nub of drilled hole on the
 * finished board edge after snapping).
 */
function pullOutward(p: Pt, outward: Pt, holeDiameterMm: number, clearanceMm: number): Pt {
  const offset = holeDiameterMm / 2 + clearanceMm
  return { x: p.x + outward.x * offset, y: p.y + outward.y * offset }
}

/**
 * Point on the PCB's own edge (not the offset tool path) at distance `d` along
 * that edge, measured in the same direction the tool path runs.
 *
 * The tool path is the board rectangle grown by `r`, so its edges are longer
 * than the board's by `2r` and shifted outward by `r`. Converting a distance
 * along the tool-path edge to the board edge therefore subtracts `r` from the
 * distance and pulls the point inward by `r`.
 */
function boardEdgePoint(
  pos: { x: number; y: number; w: number; h: number },
  edge: RouteEdge,
  dAlongToolPath: number,
  r: number
): Pt {
  const x0 = pos.x
  const y0 = pos.y
  const w = pos.w
  const h = pos.h
  // Distance along the BOARD edge, clamped into it.
  const d = Math.max(0, Math.min(dAlongToolPath - r, edge === 'top' || edge === 'bottom' ? w : h))

  switch (edge) {
    case 'bottom': return { x: x0 + d, y: y0 }
    case 'right': return { x: x0 + w, y: y0 + d }
    case 'top': return { x: x0 + w - d, y: y0 + h }
    case 'left': return { x: x0, y: y0 + h - d }
  }
}

// ============================================================================
// Contour (non-rectangular) per-PCB routing
// ============================================================================

function contourFailureIssue(reason: NonNullable<BoardContour['failureReason']>, sourceFileName: string | null): RoutingIssue {
  const file = sourceFileName ? ` (${sourceFileName})` : ''
  const detailByReason: Record<NonNullable<BoardContour['failureReason']>, string> = {
    'no-outline-layer': `No outline/mechanical layer${file} was found to trace. No per-PCB contour paths were generated.`,
    'no-paths-in-outline': `The outline layer${file} has no drawn paths — it may be a filled region (G36/G37) rather than lines/arcs, which the tracer can't read. No per-PCB contour paths were generated.`,
    'no-closed-regions': `The outline layer${file} never closed into a complete loop. No per-PCB contour paths were generated.`,
    'rejected-coverage': `The traced outline${file} covered too little of the board's overall content to be trusted (a common symptom of dimension-tick or fragmented mechanical layers). No per-PCB contour paths were generated.`,
    degenerate: `The traced outline${file} collapsed to a degenerate shape. No per-PCB contour paths were generated.`,
    'parse-failed': `The outline layer${file} could not be parsed. No per-PCB contour paths were generated.`,
  }
  return {
    id: reason === 'rejected-coverage' ? 'contour-rejected-coverage' : 'contour-trace-failed',
    severity: 'error',
    title: 'Board outline could not be traced',
    detail: detailByReason[reason],
  }
}

/**
 * Contour-mode routing for every design that resolved to it, in one call —
 * NOT one call per design — because cross-design tab protection (a design
 * A board's tab must not be cut through by design B's neighbouring pass)
 * needs to see every contour instance across every such design at once, the
 * same way the bbox branch's own Phase 2 scans the whole `tabs` array rather
 * than just one design's tabs. Mutates `paths`/`tabs`/`issues` in place.
 *
 * Single-design byte-identity: with exactly one contour-resolved design,
 * `geoByDesign` has one entry and `instances` is that design's own
 * placements in original order — the same geometry, same instancing order,
 * same accumulation as the pre-multi-design single global computation this
 * replaces.
 */
function runContourModeRouting(
  contourDesignIds: string[],
  placementsByDesign: Map<string, { pos: PanelPlacement; pcbIndex: number }[]>,
  ctx: RoutingPlanContext,
  panel: PanelResult,
  panelConfig: PanelConfig,
  cfg: RoutingConfig,
  bit: number,
  r: number,
  paths: RoutePath[],
  tabs: RouteTab[],
  issues: RoutingIssue[],
  // Bbox-mode designs' own DEFAULT tab positions (pre-alignment, panel-
  // absolute) — computed early by the caller, before this function runs, so
  // a contour instance sharing a gap with a bbox neighbor can silently gap
  // its own cut there too. Without this, only bbox's Phase 2 (which runs
  // after this function, once contour's real tabs already exist) can avoid
  // destroying the OTHER side's tab — a one-directional gap. Using the
  // PRE-alignment default is sufficient: if a contour tab already exists
  // near this position, Sub-pass 1.5 later snaps the bbox tab onto it
  // exactly (redundant with this, harmless); if not, the bbox tab stays at
  // this default position, which is exactly what's being protected here.
  foreignTabPointsAbs: Pt[] = []
): void {
  const multiDesign = panel.designs.length > 1
  const designName = (id: string) => panel.designs.find(d => d.designId === id)?.name ?? id

  const geoByDesign = new Map<string, { geo: ContourGeometry; datum: { minX: number; minY: number } }>()

  for (const designId of contourDesignIds) {
    const dctx = contextForDesign(ctx, designId)
    const label = multiDesign ? ` (${designName(designId)})` : ''
    const contour = dctx.boardContour

    if (!contour) {
      issues.push({
        id: 'contour-unavailable',
        severity: 'error',
        title: 'No traced board outline available',
        detail: `Outline mode is set to Contour (or resolved to it)${label}, but no traced board profile was supplied. No per-PCB contour paths were generated${label}.`,
      })
      continue
    }
    if (contour.failureReason) {
      issues.push(contourFailureIssue(contour.failureReason, contour.sourceFileName))
      continue
    }
    if (contour.openPathCount > 0) {
      issues.push({
        id: 'contour-open-paths',
        severity: 'warning',
        title: 'Part of the outline did not close',
        detail: `${contour.openPathCount} loop(s) in the outline layer${label} could not be closed into a region and were ignored — the traced profile may be missing part of the board edge.`,
      })
    }
    if (contour.rings.some(rg => rg.syntheticCloseCount > 0)) {
      issues.push({
        id: 'contour-gap-filled',
        severity: 'info',
        title: 'Outline tracer bridged a small gap',
        detail: `The outline tracer${label} inserted at least one short synthetic segment to close a loop — this is usually harmless (floating-point rounding in the source file) but can indicate a genuine small gap in the board outline.`,
      })
    }

    const ambiguous = contour.rings.some(rg => rg.ambiguous)
    const outerRings = contour.rings.filter(rg => rg.depth === 0 && !rg.isHole)
    if (ambiguous) {
      issues.push({
        id: 'contour-ambiguous-nesting',
        severity: 'error',
        title: 'Could not determine the outline nesting',
        detail: `Whether some part of the outline${label} is the board edge or an interior cutout could not be determined robustly. No per-PCB contour paths were generated${label}.`,
      })
      continue
    }
    if (outerRings.length !== 1) {
      issues.push({
        id: 'contour-multiple-outer-boundaries',
        severity: 'error',
        title: `Outline layer${label} describes ${outerRings.length} separate boards`,
        detail: `The outline file${label} traces more than one outer boundary — it likely contains an entire pre-panelized layout rather than a single PCB. No per-PCB contour paths were generated${label}.`,
      })
      continue
    }

    const outer = outerRings[0]
    const designEntries = placementsByDesign.get(designId) ?? []
    const pcbWidth = designEntries[0]?.pos.w ?? 0
    const pcbHeight = designEntries[0]?.pos.h ?? 0
    const sizeOk = checkContourSize(outer, pcbWidth, pcbHeight, panelConfig, r, issues)
    if (!sizeOk) continue

    const holes = cfg.routeInteriorCutouts ? contour.rings.filter(rg => rg.isHole) : []
    const geo = computeContourGeometry(outer, holes, cfg, r, issues)
    if (!geo) continue

    if (!dctx.outlineBoundsMm) {
      issues.push({
        id: 'contour-unavailable',
        severity: 'error',
        title: 'No outline layer bounds available for instancing',
        detail: `The traced contour${label} could not be positioned onto the panel because the outline layer's own bounds were not supplied. No per-PCB contour paths were generated${label}.`,
      })
      continue
    }

    geoByDesign.set(designId, { geo, datum: dctx.outlineBoundsMm })
  }

  if (geoByDesign.size === 0) return

  // Every instance across every valid contour design, so cross-design tab
  // protection below can see every candidate neighbour — not just
  // same-design ones. Order follows `placementsByDesign`'s own iteration
  // order (design order, then each design's original placement order),
  // which for the common single-contour-design case is exactly
  // `panel.placements`'s own order.
  interface ContourInstance { pcbIndex: number; designId: string; dx: number; dy: number; tabsAbs: Pt[] }
  const instances: ContourInstance[] = []
  for (const [designId, { geo, datum }] of geoByDesign) {
    const entries = placementsByDesign.get(designId) ?? []
    const tabSamplesFileSpace = geo.tabPositions.map(d => sampleAt(geo.outerPts, geo.outerTable, d))
    for (const { pos, pcbIndex } of entries) {
      const dx = pos.x - datum.minX
      const dy = pos.y - datum.minY
      const tabsAbs = tabSamplesFileSpace.map(p => ({ x: p.x + dx, y: p.y + dy }))
      instances.push({ pcbIndex, designId, dx, dy, tabsAbs })
    }
  }

  const coincidenceToleranceMm = r + Math.max(cfg.contourToleranceMm, 0.05)
  const pathGap = cfg.tabWidthMm + bit
  let holeTabsSkipped = 0

  for (const inst of instances) {
    const { geo } = geoByDesign.get(inst.designId)!

    // ⚠ Protective tabs from tooling/reference holes and cross-instance
    // (same- or different-design) tab coincidence — the contour
    // generalisation of the bbox loop's own hole/foreign-tab protection.
    // Computed per-instance: a hole or a neighbour's tab is only ever near
    // ONE or TWO instances (the ones at that panel corner/gap), so this
    // can't be precomputed once in file space. Routed through
    // `findSafeTabCenter` — same as the ring's own tab placement — so a hole
    // sitting right at a sharp corner still nudges to a safe nearby spot
    // rather than being silently dropped or placed across too much curvature.
    const extraSilentDs: number[] = []
    for (const other of instances) {
      if (other.pcbIndex === inst.pcbIndex) continue
      for (const abs of other.tabsAbs) {
        const local = { x: abs.x - inst.dx, y: abs.y - inst.dy }
        const { distance, d } = nearestArcLengthOnRing(geo.outerPts, geo.outerTable, local)
        if (distance < coincidenceToleranceMm) extraSilentDs.push(d)
      }
    }
    // Bbox-mode neighbors' own default tab positions — see this function's
    // `foreignTabPointsAbs` param doc for why this direction of cross-mode
    // protection would otherwise be missing.
    for (const abs of foreignTabPointsAbs) {
      const local = { x: abs.x - inst.dx, y: abs.y - inst.dy }
      const { distance, d } = nearestArcLengthOnRing(geo.outerPts, geo.outerTable, local)
      if (distance < coincidenceToleranceMm) extraSilentDs.push(d)
    }

    const holeProtectiveDs: number[] = []
    for (const hole of panel.toolingHoles) {
      const holeR = hole.diameter / 2
      const local = { x: hole.x - inst.dx, y: hole.y - inst.dy }
      const { distance, d } = nearestArcLengthOnRing(geo.outerPts, geo.outerTable, local)
      if (distance >= r + holeR + HOLE_TAB_PROTECTION_MARGIN_MM) continue
      const covered = [...geo.tabPositions, ...extraSilentDs, ...holeProtectiveDs].some(existing => {
        const raw = Math.abs(existing - d)
        return Math.min(raw, geo.outerTable.perimeterMm - raw) < pathGap
      })
      if (covered) continue
      const safe = findSafeTabCenter(geo.outerPts, geo.outerTable, d, pathGap)
      if (safe === null) holeTabsSkipped++
      else holeProtectiveDs.push(safe)
    }

    const result = planContourPcb(geo, inst.dx, inst.dy, inst.pcbIndex, bit, cfg, extraSilentDs, holeProtectiveDs)
    paths.push(...result.paths)
    tabs.push(...result.tabs)
  }

  if (holeTabsSkipped > 0) {
    issues.push({
      id: 'contour-tabs-skipped',
      severity: 'warning',
      title: `${holeTabsSkipped} protective tab${holeTabsSkipped > 1 ? 's' : ''} near a pinning/reference hole skipped`,
      detail:
        `${holeTabsSkipped} tab(s) meant to protect a tooling/reference hole sat across a corner or ` +
        `tight curve (more than 20 degrees of turning) and were skipped rather than cut across it. That ` +
        `hole may still be close to the routed path — check the panel's Pinning Inset or move the hole.`,
    })
  }
}

/** Compare the traced outline's arc-accurate bbox against that DESIGN's own
 *  (arc-blind) PCB size — `pcbWidth`/`pcbHeight` are the design's own first
 *  placement, not a panel-wide scalar (a multi-design panel has no single
 *  "the" PCB size). Returns false (and pushes a blocking issue) when the
 *  mismatch is severe enough that contour routing shouldn't proceed. */
function checkContourSize(
  outer: ContourRing,
  pcbWidth: number,
  pcbHeight: number,
  panelConfig: PanelConfig,
  r: number,
  issues: RoutingIssue[]
): boolean {
  const w = outer.boundsMm.maxX - outer.boundsMm.minX
  const h = outer.boundsMm.maxY - outer.boundsMm.minY
  if (!(w > 0) || !(h > 0)) {
    issues.push({
      id: 'contour-trace-failed',
      severity: 'error',
      title: 'Traced outline has no size',
      detail: 'The traced board outline has zero width or height. No per-PCB contour paths were generated.',
    })
    return false
  }

  const panelPcbWidth = pcbWidth
  const panelPcbHeight = pcbHeight

  const closeToRatio = (a: number, b: number, tolPct: number) => Math.abs(a / b - 1) <= tolPct
  const ratios = [panelPcbWidth / w, panelPcbHeight / h]
  const unitMismatch = ratios.some(rt => closeToRatio(rt, 25.4, 0.02) || closeToRatio(rt, 1 / 25.4, 0.02))
  if (unitMismatch) {
    issues.push({
      id: 'contour-unit-mismatch',
      severity: 'error',
      title: 'Traced outline is ~25.4x off from the panel PCB size',
      detail:
        `The traced outline is ${w.toFixed(3)} x ${h.toFixed(3)} mm but the panel expects ` +
        `${panelPcbWidth.toFixed(3)} x ${panelPcbHeight.toFixed(3)} mm — a ratio near 25.4 usually means an ` +
        `inch/mm unit mismatch. No per-PCB contour paths were generated.`,
    })
    return false
  }

  const halfOverhangX = Math.abs(w - panelPcbWidth) / 2
  const halfOverhangY = Math.abs(h - panelPcbHeight) / 2
  if (halfOverhangX < 0.01 && halfOverhangY < 0.01) return true

  const severe = halfOverhangX + r > panelConfig.gapX / 2 || halfOverhangY + r > panelConfig.gapY / 2
  issues.push({
    id: 'contour-size-mismatch',
    severity: severe ? 'error' : 'warning',
    title: 'Traced outline size does not match the panel PCB size',
    detail:
      `The traced outline is ${w.toFixed(3)} x ${h.toFixed(3)} mm; the panel was built using ` +
      `${panelPcbWidth.toFixed(3)} x ${panelPcbHeight.toFixed(3)} mm (from the arc-blind bounding-box ` +
      `calculation). ` +
      (severe
        ? 'The difference is large enough that the offset contour path may overhang into the panel gap or a neighbouring PCB. No per-PCB contour paths were generated.'
        : 'The difference is small and likely just the arc bulge the panel size calculation does not account for.'),
  })
  return !severe
}

/** Nearest point on a closed ring to `p`, returning both the distance and the
 *  corresponding arc-length position (per `table`). Used to detect when a
 *  FOREIGN PCB's tab (translated into THIS PCB's own local frame) lands on
 *  this PCB's own boundary — see the coincident-pass tab-safety note above
 *  the contour per-PCB loop in `planRouting`. */
function nearestArcLengthOnRing(ringPts: Pt[], table: ArcLengthTable, p: Pt): { distance: number; d: number } {
  let best = Infinity
  let bestD = 0
  const n = ringPts.length
  for (let i = 0; i < n; i++) {
    const a = ringPts[i]
    const b = ringPts[(i + 1) % n]
    const dx = b.x - a.x
    const dy = b.y - a.y
    const lenSq = dx * dx + dy * dy
    let t = lenSq > 0 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq : 0
    t = Math.max(0, Math.min(1, t))
    const cx = a.x + t * dx
    const cy = a.y + t * dy
    const dist = Math.hypot(p.x - cx, p.y - cy)
    if (dist < best) {
      best = dist
      const curCum = table.entries[i].cumMm
      const nextCum = i === n - 1 ? table.perimeterMm : table.entries[i + 1].cumMm
      bestD = curCum + t * (nextCum - curCum)
    }
  }
  return { distance: best, d: bestD }
}

/** File-space (untranslated) offset geometry + tab layout for a traced
 *  contour, computed ONCE and instanced per PCB position by `planContourPcb`
 *  — "trace once, offset once, tab once" (see the routing plan's own
 *  "Instancing" section). `cutSpans` is NOT precomputed here — unlike every
 *  other field, it can depend on FOREIGN tabs from neighbouring PCB
 *  instances (see `planContourPcb`), so it has to be built per instance. */
interface ContourGeometry {
  outerPts: Pt[]
  outerTable: ArcLengthTable
  tabPositions: number[]
  cutouts: Pt[][]
}

function computeContourGeometry(
  outer: ContourRing,
  holes: ContourRing[],
  cfg: RoutingConfig,
  r: number,
  issues: RoutingIssue[]
): ContourGeometry | null {
  const orientedOuter = orientRing(outer.points, true)
  const offsetOuter = offsetClosedRing(orientedOuter, r, cfg.contourToleranceMm)
  if (!offsetOuter.points) {
    issues.push({
      id: 'contour-trace-failed',
      severity: 'error',
      title: 'Board outline could not be offset',
      detail: `The traced board outline could not be safely offset by the ${cfg.bitDiameterMm} mm bit. No per-PCB contour paths were generated.`,
    })
    return null
  }
  if (offsetOuter.prunedFraction > 0.25) {
    issues.push({
      id: 'contour-prune-suspicious',
      severity: 'error',
      title: 'Too much of the offset boundary was pruned',
      detail:
        `${(offsetOuter.prunedFraction * 100).toFixed(0)}% of the raw offset boundary was within the bit ` +
        `radius of another part of the board — the traced profile is unreliable at this bit size. No per-PCB ` +
        `contour paths were generated.`,
    })
    return null
  }
  if (offsetOuter.lostFeature) {
    issues.push({
      id: 'contour-feature-lost',
      severity: 'warning',
      title: 'A board feature narrower than the bit was smoothed over',
      detail:
        `At least one concave feature on the board outline is narrower than the ${cfg.bitDiameterMm} mm bit ` +
        `and could not be reproduced exactly; the router path smooths over it.`,
    })
  }

  const outerPts = offsetOuter.points
  const outerTable = buildArcLength(outerPts)
  const bit = cfg.bitDiameterMm
  const pathGap = cfg.tabWidthMm + bit

  const tabPositions: number[] = []
  let tabsSkipped = 0
  if (cfg.tabStyle !== 'none' && cfg.tabsPerContour > 0 && outerTable.perimeterMm > 0) {
    const override = parseTabPositions(cfg.tabPositionsMm, outerTable.perimeterMm)
    const desired = override.length > 0 ? override : evenTabCenters(outerTable.perimeterMm, cfg.tabsPerContour)
    if (cfg.tabsPerContour * pathGap >= outerTable.perimeterMm) {
      issues.push({
        id: 'contour-tabs-dont-fit',
        severity: 'error',
        title: 'Tabs do not fit around the contour',
        detail:
          `${cfg.tabsPerContour} tabs of ${cfg.tabWidthMm} mm need ${(cfg.tabsPerContour * pathGap).toFixed(2)} mm ` +
          `of interrupted path, but the traced perimeter is only ${outerTable.perimeterMm.toFixed(2)} mm. Reduce ` +
          `the tab count or width.`,
      })
    } else {
      for (const d of desired) {
        const safe = findSafeTabCenter(outerPts, outerTable, d, pathGap)
        if (safe === null) tabsSkipped++
        else tabPositions.push(safe)
      }
    }
  }
  if (tabsSkipped > 0) {
    issues.push({
      id: 'contour-tabs-skipped',
      severity: 'warning',
      title: `${tabsSkipped} tab${tabsSkipped > 1 ? 's' : ''} skipped`,
      detail:
        `${tabsSkipped} tab position(s) sat across a corner or tight curve (more than 20 degrees of turning ` +
        `within the tab's footprint) and were skipped rather than cut across it. Reduce the tab count or width ` +
        `if the board needs every tab.`,
    })
  }

  const cutouts: Pt[][] = []
  for (const hole of holes) {
    if (hole.depth >= 2) {
      issues.push({
        id: 'contour-island-in-cutout',
        severity: 'warning',
        title: 'Island inside a cutout',
        detail: 'A feature is nested inside an interior cutout and will fall free of the board when the cutout is routed — it is not routed as a separate cutout.',
      })
      continue
    }
    const orientedHole = orientRing(hole.points, false)
    const offsetHole = offsetClosedRing(orientedHole, r, cfg.contourToleranceMm)
    if (!offsetHole.points) {
      const hw = hole.boundsMm.maxX - hole.boundsMm.minX
      const hh = hole.boundsMm.maxY - hole.boundsMm.minY
      issues.push({
        id: 'cutout-too-small-for-bit',
        severity: 'warning',
        title: 'A cutout is too small for the bit',
        detail: `An interior cutout (~${hw.toFixed(2)} x ${hh.toFixed(2)} mm) collapsed when offset inward by the ${cfg.bitDiameterMm} mm bit and was skipped.`,
      })
      continue
    }
    cutouts.push(offsetHole.points)
  }

  return { outerPts, outerTable, tabPositions, cutouts }
}

/**
 * Translate the once-computed file-space contour geometry onto one PCB
 * position. Cutouts are pushed before the outline — interior features must
 * be milled while the board is still fully supported by the panel.
 *
 * ⚠ **Coincident-pass tab safety.** Unlike bbox mode (which merges/dedupes
 * facing PCBs' passes when `gap == bit`, and — since the earlier
 * tab-alignment fix — guarantees their tab positions coincide too), contour
 * mode never merges passes between PCBs at all: every instance routes its
 * own COMPLETE, independent profile. That is documented as "redundant but
 * not unsafe" — true for a plain boundary or a cutout, but NOT true for a
 * tab: at `gap == bit`, two facing PCBs' offset boundaries land on the exact
 * same physical line, and since contour tabs are placed by whole-perimeter
 * arc length (no per-edge concept to keep them aligned the way bbox mode's
 * rectangle tabs are), a neighbour's tab generally does NOT fall at the same
 * spot on this PCB's own boundary. That neighbour's own pass, having no
 * interruption where THIS PCB wants a bridge, then cuts straight through it
 * — silently destroying the tab even though neither board's own geometry is
 * individually wrong. `extraSilentDs` is how the caller closes this gap: for
 * every OTHER instance's tab that lands within a bit-radius of THIS
 * instance's own boundary (a strong signal the two passes are physically
 * coincident), it contributes an extra interrupt here — same `pathGap`
 * silencing as an owned tab, but with no `RouteTab` emitted (the neighbour
 * already owns that tab's holes).
 */
function planContourPcb(
  geo: ContourGeometry,
  dx: number,
  dy: number,
  pcbIndex: number,
  bit: number,
  cfg: RoutingConfig,
  extraSilentDs: number[],
  holeProtectiveDs: number[]
): { paths: RoutePath[]; tabs: RouteTab[] } {
  const translate = (p: Pt): Pt => ({ x: p.x + dx, y: p.y + dy })
  const paths: RoutePath[] = []
  const tabs: RouteTab[] = []
  const r = bit / 2
  const pathGap = cfg.tabWidthMm + bit

  geo.cutouts.forEach((cutout, i) => {
    paths.push({
      id: `pcb-${pcbIndex}-cutout-${i}`,
      role: 'pcb-cutout',
      pcbIndex,
      points: cutout.map(translate),
      closed: true,
      toolDiameterMm: bit,
    })
  })

  // `holeProtectiveDs` gets REAL tabs emitted below (unlike `extraSilentDs`,
  // which only silently extends the cut interruption because the OWNING
  // instance already emits that tab) — there is no other instance that owns
  // a tab protecting a hole near THIS one, so this instance has to emit it.
  const allInterruptDs = [...geo.tabPositions, ...extraSilentDs, ...holeProtectiveDs]
  const interrupts: Span[] = allInterruptDs.map(d => ({ start: d - pathGap / 2, end: d + pathGap / 2 }))
  const cutSpans =
    interrupts.length > 0
      ? splitClosedByTabs(geo.outerTable.perimeterMm, interrupts)
      : [{ start: 0, end: geo.outerTable.perimeterMm }]

  const wholeLoop = cutSpans.length === 1 && allInterruptDs.length === 0
  for (const span of cutSpans) {
    const spanPts = extractArcSpan(geo.outerPts, geo.outerTable, span.start, span.end).map(translate)
    paths.push({
      id: `pcb-${pcbIndex}-outline-${span.start.toFixed(3)}`,
      role: 'pcb-outline',
      pcbIndex,
      points: spanPts,
      closed: wholeLoop,
      toolDiameterMm: bit,
    })
  }

  for (const d of [...geo.tabPositions, ...holeProtectiveDs]) {
    const offsetPt = translate(sampleAt(geo.outerPts, geo.outerTable, d))
    const tangent = tangentAt(geo.outerPts, geo.outerTable, d)
    const outwardNormal = rightNormalOf(tangent)
    // Pull the offset (tool-path) point back to the board's own edge by r —
    // the contour generalisation of boardEdgePoint's inward pull.
    const boardCenter: Pt = { x: offsetPt.x - r * outwardNormal.x, y: offsetPt.y - r * outwardNormal.y }
    const edge: RouteEdge =
      Math.abs(outwardNormal.y) >= Math.abs(outwardNormal.x)
        ? outwardNormal.y > 0 ? 'top' : 'bottom'
        : outwardNormal.x > 0 ? 'right' : 'left'
    const holes =
      cfg.tabStyle === 'mousebite'
        ? mouseBiteHoleCenters(
            pullOutward(boardCenter, outwardNormal, cfg.mouseBiteHoleDiameterMm, cfg.mouseBiteEdgeClearanceMm),
            tangent,
            cfg.tabWidthMm,
            cfg.mouseBiteHoleDiameterMm,
            cfg.mouseBiteHolePitchMm
          )
        : []

    tabs.push({
      id: `tab-${pcbIndex}-contour-${d.toFixed(3)}`,
      style: cfg.tabStyle === 'mousebite' ? 'mousebite' : 'solid',
      center: boardCenter,
      dir: tangent,
      widthMm: cfg.tabWidthMm,
      edge,
      pcbIndex,
      holes,
      holeDiameterMm: cfg.mouseBiteHoleDiameterMm,
      alongMm: d,
    })
  }

  return { paths, tabs }
}
