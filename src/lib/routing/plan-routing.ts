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

import type { PanelConfig, PanelResult } from '../panelization-engine'
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

/** Optional extra context the validator can use but the geometry does not need. */
export interface RoutingPlanContext {
  /** The outline layer, if one was imported — used for the
   *  rectangular-outline honesty warning AND to resolve `'auto'` mode. */
  outlineLayer?: GerberLayer | null
  /**
   * Pre-traced board profile (see `src/lib/board-contour.ts`). `planRouting`
   * never traces one itself — tracing is async and this function is
   * synchronous/pure — so contour mode with no `boardContour` supplied (or
   * one still carrying `failureReason`) raises `contour-unavailable` /
   * `contour-trace-failed` and emits no per-PCB contour paths.
   */
  boardContour?: BoardContour | null
  /**
   * Translation datum for instancing the (traced-once, file-space) contour
   * onto each panel position. ⚠ Must be the outline layer's OWN
   * `GerberLayer.bounds` (arc-blind), NOT `boardContour.boundsMm`
   * (arc-accurate) — they differ by the arc bulge, and registration with the
   * copper/mask artwork (which the exporter positions from `bounds`) matters
   * more than agreement with an idealised bbox. See `gerber-exporter.ts`'s
   * own `globalBaseOffset` for the same convention.
   */
  outlineBoundsMm?: { minX: number; minY: number } | null
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

    // --- Rib margins. Derived from pcbPositions + panel size, NEVER from
    // config.sideRib*: computePanel places PCBs using sideRibTop for the Y
    // origin but positions the tooling-hole band from sideRibBottom, so with
    // asymmetric ribs the two disagree. Measuring the real layout sidesteps it.
    const first = panel.pcbPositions[0]
    if (first) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
      for (const p of panel.pcbPositions) {
        minX = Math.min(minX, p.x)
        minY = Math.min(minY, p.y)
        maxX = Math.max(maxX, p.x + panel.pcbWidth)
        maxY = Math.max(maxY, p.y + panel.pcbHeight)
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
  if (cfg.routeIndividualPcbs && cfg.tabStyle !== 'none') {
    const pathGap = cfg.tabWidthMm + bit
    const shortest = Math.min(panel.pcbWidth, panel.pcbHeight)
    if (cfg.tabsPerEdge * pathGap >= shortest) {
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
  // this warning would be actively wrong there).
  if (ctx.outlineLayer && !isRectangularOutline(ctx.outlineLayer)) {
    const resolvedMode = resolveOutlineMode(cfg.pcbOutlineMode, ctx.outlineLayer)
    if (resolvedMode === 'bbox') {
      issues.push({
        id: 'outline-not-rectangular',
        severity: 'warning',
        title: 'Board outline is not a plain rectangle',
        detail:
          'Route paths follow each PCB’s bounding box because outline mode is set to Bounding box. A shaped ' +
          'board will be over-cut at its non-rectangular features — switch outline mode to Contour or Auto to ' +
          'follow the real board profile instead.',
      })
    }
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

  // ---- Panel perimeter -----------------------------------------------------
  // The panel is cut from a larger sheet, so it gets no tabs: one closed loop.
  if (cfg.routePanelOutline && bit > 0) {
    const corners = offsetRectOutward(0, 0, panel.panelWidth, panel.panelHeight, r)
    paths.push({
      id: 'panel-outline',
      role: 'panel-outline',
      points: [...corners, corners[0]],
      closed: true,
      toolDiameterMm: bit,
    })
  }

  // ---- Per-PCB perimeters --------------------------------------------------
  const resolvedMode = resolveOutlineMode(cfg.pcbOutlineMode, ctx.outlineLayer)

  if (cfg.routeIndividualPcbs && bit > 0 && resolvedMode === 'bbox') {
    // Collect as segments first so coincident passes along shared gaps can be
    // deduped across PCB instances before being turned into paths.
    const pending: { pcbIndex: number; edge: RouteEdge; seg: RouteSegment }[] = []

    for (const [pcbIndex, pos] of panel.pcbPositions.entries()) {
      const corners = offsetRectOutward(pos.x, pos.y, panel.pcbWidth, panel.pcbHeight, r)

      for (const { edge, a, b } of rectEdges(corners)) {
        const edgeLen = segmentLength(a, b)
        const interrupts: Span[] = []

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
        // which edge label it is.
        const isReversedEdge = edge === 'top' || edge === 'left'

        const wantTabs = cfg.tabStyle !== 'none' && edgeEnabled(edge, cfg)
        if (wantTabs && edgeLen > 0) {
          const override = parseTabPositions(cfg.tabPositionsMm, edgeLen)
          const centersAlong = override.length > 0 ? override : evenTabCenters(edgeLen, cfg.tabsPerEdge)
          const pathGap = cfg.tabWidthMm + bit

          for (const dGlobal of centersAlong) {
            const d = isReversedEdge ? edgeLen - dGlobal : dGlobal
            interrupts.push({ start: d - pathGap / 2, end: d + pathGap / 2 })

            // The tab itself lives on the BOARD edge, not this offset tool path.
            // Shift the point back inward by r along the edge's inward normal.
            const tabCenter = boardEdgePoint(pos, panel, edge, d, r)
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

        for (const span of splitEdgeByTabs(edgeLen, interrupts)) {
          pending.push({
            pcbIndex,
            edge,
            seg: { a: pointAlong(a, b, span.start), b: pointAlong(a, b, span.end) },
          })
        }
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
  } else if (cfg.routeIndividualPcbs && bit > 0 && resolvedMode === 'contour') {
    // ---- Per-PCB contours ----------------------------------------------
    // No cross-PCB pass merging here yet (unlike the bbox branch's
    // `dedupeCoincidentSegments`/wrap-around stitch above) — contour paths
    // carry far more, far shorter segments, and the existing O(n^2) dedup is
    // documented as too slow at that scale; a spatial-hash version is a
    // later stage. Each PCB's contour is routed fully independently for now.
    const contour = ctx.boardContour
    if (!contour) {
      issues.push({
        id: 'contour-unavailable',
        severity: 'error',
        title: 'No traced board outline available',
        detail: 'Outline mode is set to Contour (or resolved to it), but no traced board profile was supplied. No per-PCB contour paths were generated.',
      })
    } else if (contour.failureReason) {
      issues.push(contourFailureIssue(contour.failureReason, contour.sourceFileName))
    } else {
      if (contour.openPathCount > 0) {
        issues.push({
          id: 'contour-open-paths',
          severity: 'warning',
          title: 'Part of the outline did not close',
          detail: `${contour.openPathCount} loop(s) in the outline layer could not be closed into a region and were ignored — the traced profile may be missing part of the board edge.`,
        })
      }
      if (contour.rings.some(rg => rg.syntheticCloseCount > 0)) {
        issues.push({
          id: 'contour-gap-filled',
          severity: 'info',
          title: 'Outline tracer bridged a small gap',
          detail: 'The outline tracer inserted at least one short synthetic segment to close a loop — this is usually harmless (floating-point rounding in the source file) but can indicate a genuine small gap in the board outline.',
        })
      }

      const ambiguous = contour.rings.some(rg => rg.ambiguous)
      const outerRings = contour.rings.filter(rg => rg.depth === 0 && !rg.isHole)
      if (ambiguous) {
        issues.push({
          id: 'contour-ambiguous-nesting',
          severity: 'error',
          title: 'Could not determine the outline nesting',
          detail: 'Whether some part of the outline is the board edge or an interior cutout could not be determined robustly. No per-PCB contour paths were generated.',
        })
      } else if (outerRings.length !== 1) {
        issues.push({
          id: 'contour-multiple-outer-boundaries',
          severity: 'error',
          title: `Outline layer describes ${outerRings.length} separate boards`,
          detail: 'The outline file traces more than one outer boundary — it likely contains an entire pre-panelized layout rather than a single PCB. No per-PCB contour paths were generated.',
        })
      } else {
        const outer = outerRings[0]
        const sizeOk = checkContourSize(outer, panel, panelConfig, r, issues)
        if (sizeOk) {
          const holes = cfg.routeInteriorCutouts ? contour.rings.filter(rg => rg.isHole) : []
          const geo = computeContourGeometry(outer, holes, cfg, r, issues)
          if (geo && ctx.outlineBoundsMm) {
            const datum = ctx.outlineBoundsMm
            const instanceOffsets = panel.pcbPositions.map(pos => ({ dx: pos.x - datum.minX, dy: pos.y - datum.minY }))
            // Every instance's OWN tab centres, sampled once in file space and
            // translated once per instance — cheap, and reused below to check
            // every OTHER instance's tabs against THIS instance's own
            // boundary (see planContourPcb's "coincident-pass tab safety").
            const tabSamplesFileSpace = geo.tabPositions.map(d => sampleAt(geo.outerPts, geo.outerTable, d))
            const instanceTabAbs = instanceOffsets.map(({ dx, dy }) =>
              tabSamplesFileSpace.map(p => ({ x: p.x + dx, y: p.y + dy }))
            )
            const coincidenceToleranceMm = r + Math.max(cfg.contourToleranceMm, 0.05)

            for (const [pcbIndex] of panel.pcbPositions.entries()) {
              const { dx, dy } = instanceOffsets[pcbIndex]
              const extraSilentDs: number[] = []
              for (let other = 0; other < instanceTabAbs.length; other++) {
                if (other === pcbIndex) continue
                for (const abs of instanceTabAbs[other]) {
                  const local = { x: abs.x - dx, y: abs.y - dy }
                  const { distance, d } = nearestArcLengthOnRing(geo.outerPts, geo.outerTable, local)
                  if (distance < coincidenceToleranceMm) extraSilentDs.push(d)
                }
              }
              const inst = planContourPcb(geo, dx, dy, pcbIndex, bit, cfg, extraSilentDs)
              paths.push(...inst.paths)
              tabs.push(...inst.tabs)
            }
          } else if (geo && !ctx.outlineBoundsMm) {
            issues.push({
              id: 'contour-unavailable',
              severity: 'error',
              title: 'No outline layer bounds available for instancing',
              detail: 'The traced contour could not be positioned onto the panel because the outline layer\'s own bounds were not supplied. No per-PCB contour paths were generated.',
            })
          }
        }
      }
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
  pos: { x: number; y: number },
  panel: PanelResult,
  edge: RouteEdge,
  dAlongToolPath: number,
  r: number
): Pt {
  const x0 = pos.x
  const y0 = pos.y
  const w = panel.pcbWidth
  const h = panel.pcbHeight
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

/** Compare the traced outline's arc-accurate bbox against the panel's own
 *  (arc-blind) PCB size. Returns false (and pushes a blocking issue) when
 *  the mismatch is severe enough that contour routing shouldn't proceed. */
function checkContourSize(
  outer: ContourRing,
  panel: PanelResult,
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

  const closeToRatio = (a: number, b: number, tolPct: number) => Math.abs(a / b - 1) <= tolPct
  const ratios = [panel.pcbWidth / w, panel.pcbHeight / h]
  const unitMismatch = ratios.some(rt => closeToRatio(rt, 25.4, 0.02) || closeToRatio(rt, 1 / 25.4, 0.02))
  if (unitMismatch) {
    issues.push({
      id: 'contour-unit-mismatch',
      severity: 'error',
      title: 'Traced outline is ~25.4x off from the panel PCB size',
      detail:
        `The traced outline is ${w.toFixed(3)} x ${h.toFixed(3)} mm but the panel expects ` +
        `${panel.pcbWidth.toFixed(3)} x ${panel.pcbHeight.toFixed(3)} mm — a ratio near 25.4 usually means an ` +
        `inch/mm unit mismatch. No per-PCB contour paths were generated.`,
    })
    return false
  }

  const halfOverhangX = Math.abs(w - panel.pcbWidth) / 2
  const halfOverhangY = Math.abs(h - panel.pcbHeight) / 2
  if (halfOverhangX < 0.01 && halfOverhangY < 0.01) return true

  const severe = halfOverhangX + r > panelConfig.gapX / 2 || halfOverhangY + r > panelConfig.gapY / 2
  issues.push({
    id: 'contour-size-mismatch',
    severity: severe ? 'error' : 'warning',
    title: 'Traced outline size does not match the panel PCB size',
    detail:
      `The traced outline is ${w.toFixed(3)} x ${h.toFixed(3)} mm; the panel was built using ` +
      `${panel.pcbWidth.toFixed(3)} x ${panel.pcbHeight.toFixed(3)} mm (from the arc-blind bounding-box ` +
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
  extraSilentDs: number[]
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

  const allInterruptDs = [...geo.tabPositions, ...extraSilentDs]
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

  for (const d of geo.tabPositions) {
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
