/**
 * The ONE shared derivation point for "what does this design's geometry
 * look like once its per-design 'Fix mirror' override is applied."
 *
 * `DesignEntry.mirrorBottomOverride` used to be purely cosmetic — a pure
 * SVG transform in the viewer, zero effect on `rawContent`/`parsedLayer`
 * (correct for a file already in the standard top-down Gerber convention).
 * `mirrorGerberLayerX` (gerber-parser.ts) later materialized a real mirror
 * for the panelized Gerber/Excellon export specifically — but that left
 * every OTHER file-producing consumer (routing, G-code, stencil, the
 * meta-panel array) reading the unmirrored store layers, so their output
 * silently disagreed with a mirrored Gerber export: a real scrap risk.
 *
 * Every file-producing consumer must go through `getMirroredLayers`
 * instead of reading `layers` directly. Deliberately NOT expected to be
 * called by DFM (`runDfmCheck` — every measurement is a distance, and
 * reflection is an isometry, so results are identical either way),
 * `computePanelResult`/`rebuildBoardView` (bounds-driven / display-only —
 * the viewer keeps its own separate on-screen counter-mirror), or the
 * board-view preview.
 */

import { mirrorGerberLayerX, type GerberLayer } from './gerber-parser'
import { resolveDesignGeometry } from './panelization-engine'

export interface MirrorableDesign {
  id: string
  mirrorBottomOverride: boolean
}

export interface MirrorableLayer {
  id: string
  name: string
  designId: string
  type: string
  visible?: boolean
  side?: 'top' | 'bottom' | 'none'
  /** The full parsed layer — deliberately not narrowed to just `{bounds}`
   *  (unlike `resolveDesignGeometry`'s own `DesignGeometrySource`), since
   *  mirroring needs the whole thing. Still structurally satisfies
   *  `DesignGeometrySource` at the `resolveDesignGeometry` call below. */
  parsedLayer: GerberLayer | null
}

/**
 * Mirrors a set of closed-ring point arrays about a local X axis — the same
 * primitive `mirrorGerberLayerX` applies to a full `GerberLayer`, but for
 * consumers that only ever see already-derived point geometry (stencil
 * aperture hulls and outline scribe lines from the worker) rather than raw
 * parsed commands. Mirroring reverses a ring's winding order, which is
 * harmless for the fill/stroke-only consumers this feeds (DXF export,
 * Gerber region fill), so winding is left as-is rather than reversed.
 */
export function mirrorRingsX<P extends { x: number; y: number }>(rings: P[][], centerX: number): P[][] {
  return rings.map(ring => ring.map(pt => ({ ...pt, x: 2 * centerX - pt.x })))
}

/**
 * Mirrors a traced `BoardContour` (routing's contour-mode board profile)
 * about a local X axis. Unlike `mirrorRingsX`, this ALSO fixes up the two
 * fields a plain point-reflection invalidates:
 *  - `signedAreaMm2` — a reflection reverses shoelace winding sign, and
 *    `offset.ts` depends on this to detect an orientation flip after
 *    offsetting; leaving it stale would misjudge every ring's orientation.
 *  - `boundsMm` (both the ring-level and contour-level copies) —
 *    recomputed directly from the mirrored points rather than assumed
 *    symmetric around `centerX`, since `BoardContour.boundsMm` is the
 *    arc-accurate bbox (deliberately different from the endpoint-only
 *    `GerberLayer.bounds` `centerX` is derived from) and isn't guaranteed
 *    centred on the same axis.
 * Everything else (`isHole`/`depth`/`arcCount`/`syntheticCloseCount`/
 * `ambiguous`/`toleranceMm`/`openPathCount`/`failureReason`/
 * `sourceFileName`) is topology, not position, and is unaffected by a
 * reflection.
 */
export function mirrorBoardContourX<C extends {
  rings: { points: { x: number; y: number }[]; signedAreaMm2: number; boundsMm: { minX: number; minY: number; maxX: number; maxY: number } }[]
  boundsMm: { minX: number; minY: number; maxX: number; maxY: number }
}>(contour: C, centerX: number): C {
  function boundsOf(points: { x: number; y: number }[]) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const p of points) {
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x)
      minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y)
    }
    return { minX, minY, maxX, maxY }
  }

  const rings = contour.rings.map(ring => {
    const points = ring.points.map(pt => ({ ...pt, x: 2 * centerX - pt.x }))
    return { ...ring, points, signedAreaMm2: -ring.signedAreaMm2, boundsMm: boundsOf(points) }
  })

  let overall = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
  for (const r of rings) {
    overall = {
      minX: Math.min(overall.minX, r.boundsMm.minX), minY: Math.min(overall.minY, r.boundsMm.minY),
      maxX: Math.max(overall.maxX, r.boundsMm.maxX), maxY: Math.max(overall.maxY, r.boundsMm.maxY),
    }
  }

  return { ...contour, rings, boundsMm: rings.length > 0 ? overall : contour.boundsMm }
}

export interface MirroredLayersResult<T> {
  layers: T[]
  /** Human-readable, ready to `console.warn` as-is. Empty when nothing
   *  needed flagging (the overwhelmingly common case — no design mirrored,
   *  or every mirrored design mirrored cleanly). */
  warnings: string[]
}

/**
 * Clones and mirrors the `parsedLayer` of every layer belonging to a
 * design with `mirrorBottomOverride` set, about that design's own bounds
 * centre (via `resolveDesignGeometry` — the same reference point the
 * viewer's panel-view counter-mirror uses). Layers belonging to an
 * unmirrored design pass through by reference, unchanged.
 *
 * Refuses to mirror (and warns instead) a design that has real TOP-side
 * geometry — mirroring is only correct for a design whose layers are ALL
 * stored in the legacy bottom-view-correct convention; a genuinely
 * two-sided board would have its top artwork flipped too, which is worse
 * than leaving it unmirrored and reporting why.
 */
export function getMirroredLayers<T extends MirrorableLayer>(
  layers: T[],
  designs: MirrorableDesign[]
): MirroredLayersResult<T> {
  const mirroredDesignIds = new Set(designs.filter(d => d.mirrorBottomOverride).map(d => d.id))
  if (mirroredDesignIds.size === 0) return { layers, warnings: [] }

  const warnings: string[] = []
  const mirroredParsedById = new Map<string, GerberLayer>()

  for (const designId of mirroredDesignIds) {
    const designLayers = layers.filter(l => l.designId === designId)
    const hasTopGeometry = designLayers.some(l => l.side === 'top' && l.parsedLayer?.bounds)
    if (hasTopGeometry) {
      warnings.push(
        `Design "${designId}" has "Fix mirror" enabled but also has TOP-side geometry — ` +
        `mirroring only makes sense for a design stored entirely in the legacy bottom-view ` +
        `convention. Skipped mirroring this design; its output will NOT match the corrected preview.`
      )
      continue
    }

    const geometry = resolveDesignGeometry(designLayers)
    if (!geometry) continue
    const centerX = -geometry.datum.x + geometry.widthMm / 2

    for (const l of designLayers) {
      if (!l.parsedLayer) continue
      const cloned = structuredClone(l.parsedLayer)
      const { hasUnmirroredMacro } = mirrorGerberLayerX(cloned, centerX)
      if (hasUnmirroredMacro) {
        warnings.push(
          `Layer "${l.name}" in design "${designId}" has a custom aperture macro this tool can't ` +
          `mirror the shape of (only KiCad RoundRect is supported) — that pad's position mirrors ` +
          `correctly but its own outline does not.`
        )
      }
      mirroredParsedById.set(l.id, cloned)
    }
  }

  if (mirroredParsedById.size === 0) return { layers, warnings }

  return {
    layers: layers.map(l => {
      const mirrored = mirroredParsedById.get(l.id)
      return mirrored ? { ...l, parsedLayer: mirrored } : l
    }),
    warnings,
  }
}
