/**
 * AOI (automated optical inspection) reference-generation config + manifest
 * schema. Mirrors `stencil-types.ts`'s split-out-of-store.ts precedent.
 *
 * What this feature produces: a binary copper raster per side (copper =
 * white) of ONE BOARD — the active design's own single, un-panelized
 * artwork, never the whole computed panel tiled N times — plus `aoi.json`
 * describing how to map a pixel in those images back to a millimetre on the
 * real board. Deliberately per board rather than per panel: a photograph is
 * always of one physical board at a time, and a multi-copy image is nothing
 * but noise to eyeball. An Android app photographs an etched board, diffs
 * copper presence against this reference to find opens and shorts. Defect
 * detection lives in that app; this side only ever produces the golden
 * reference.
 */

/** ⚠ DELIBERATELY FLAT — same shallow-merge discipline `StencilConfig` and
 *  `FilmConfig` document. `updateAoiConfig` shallow-merges, so a nested
 *  object here would need a manual re-spread in both it and `resetAoiConfig`. */
export interface AoiConfig {
  /** Raster resolution. Default 40 px/mm (~1016 DPI): a 0.05 mm trace — the
   *  finest feature measured on a real customer board — is 2 px wide, which
   *  is the floor for surviving rasterisation at all. 20 px/mm rendered that
   *  same trace as a single pixel, right at the vanishing threshold
   *  `measureFinestFeature` now warns about. */
  pxPerMm: number
  includeTop: boolean
  includeBottom: boolean
  /** Default (false) is copper = WHITE on black, the natural reading of a
   *  Gerber's own dark polarity. Set true for copper = BLACK, matching the
   *  photo-plot/toner-transfer convention the shop's existing artwork uses.
   *  Either way the choice is declared per-image as `copperValue` in
   *  `aoi.json`, so the inspection app never has to assume. */
  invertOutput: boolean
}

export const DEFAULT_AOI_CONFIG: AoiConfig = {
  pxPerMm: 40,
  includeTop: true,
  includeBottom: true,
  invertOutput: false,
}

export const AOI_MIN_PX_PER_MM = 2
/** Canvas ceilings. Chrome allows 2^28 (268M) px of area and 65535 per side.
 *  90M px sits well under that while still admitting the 40 px/mm default on
 *  a large panel (a 166 x 242 mm panel is 64.5 MP there). The transient RGBA
 *  buffer is 4 bytes/px — ~360 MB at this cap — which is why the worker
 *  renders one side at a time and frees each canvas before the next. */
export const AOI_MAX_CANVAS_PX = 90_000_000
export const AOI_MAX_DIM_PX = 32_000

/** A rasterised feature thinner than this many pixels is at real risk of
 *  disappearing into the antialias threshold, which the inspection app would
 *  then report as missing copper on a perfectly good board. Drives the
 *  resolution warning, not a hard failure — the user may have a good reason
 *  to accept it. */
export const AOI_MIN_FEATURE_PX = 2

export type AoiSide = 'top' | 'bottom'

/** Generated artifacts. Deliberately NOT `StencilFile` — that type's
 *  `content: string` cannot carry PNG bytes. */
export type AoiGeneratedFile =
  | { filename: string; kind: 'text'; content: string }
  | { filename: string; kind: 'binary'; bytes: Uint8Array; mime: string }

/**
 * THE transform, in one place. Panel geometry is Gerber Y-UP (origin
 * bottom-left); images are Y-DOWN (origin top-left); the bottom image is
 * additionally mirrored in X because the camera sees the board flipped.
 * The manifest, the rasteriser and any verification probe must all agree,
 * so they all call this.
 *
 *   top:    x_px = k*x_mm,      y_px = H - k*y_mm
 *   bottom: x_px = W - k*x_mm,  y_px = H - k*y_mm
 */
export function mmToPx(
  side: AoiSide,
  xMm: number,
  yMm: number,
  pxPerMm: number,
  widthPx: number,
  heightPx: number
): [number, number] {
  const y = heightPx - pxPerMm * yMm
  return side === 'bottom' ? [widthPx - pxPerMm * xMm, y] : [pxPerMm * xMm, y]
}

export type AoiImageKind = 'copper' | 'drill'

export interface AoiImageMeta {
  file: string
  /** `copper` = the artwork to inspect, already punched with every drilled
   *  hole (plated pads/vias render as real donuts — a ring of copper around
   *  a substrate-coloured hole — exactly as a camera would see them, not as
   *  solid discs). `drill` = a supplementary standalone mask of the same
   *  hole geometry, for an app that wants an unambiguous "here is exactly
   *  where every hole is" reference (e.g. for registration, or to classify
   *  a defect that sits near a hole) — not required for a plain diff, since
   *  the `copper` image already has holes accounted for. */
  kind: AoiImageKind
  side: AoiSide
  /** True for the bottom image — its X axis runs opposite to panel X. */
  mirrored: boolean
  widthPx: number
  heightPx: number
  bitDepth: 1
  colorType: 'grayscale'
  /** Pixel value that means copper (on a `copper` image) or hole (on a
   *  `drill` mask) — 1 (white) by default, 0 when `AoiConfig.invertOutput`
   *  is set. Authoritative: the app must read this rather than assume a
   *  convention. */
  copperValue: 0 | 1
  /** Forward affine as [a b c d e f]: x_px = a*x_mm + c*y_mm + e, etc. */
  mmToPx: [number, number, number, number, number, number]
  forwardFormula: string
  inverseFormula: string
}

/** ⚠ Pixel coords MUST be keyed by image: the same panel point has a
 *  different x in the mirrored bottom raster. A single flat `px` is the
 *  easiest way to get this schema subtly wrong. */
export interface AoiPointPx {
  top?: [number, number]
  bottom?: [number, number]
}

export interface AoiFeature {
  id?: string
  mm: [number, number]
  px: AoiPointPx
  diameterMm: number
  /** Fiducials only — the mask keep-out ring's outer diameter. */
  clearanceMm?: number
}

export interface AoiRectPx {
  x: number
  y: number
  w: number
  h: number
}

export interface AoiPlacement {
  designId: string
  row?: number
  col?: number
  rotationDeg: number
  mm: { x: number; y: number; w: number; h: number }
  px: { top?: AoiRectPx; bottom?: AoiRectPx }
}

export interface AoiManifest {
  schemaVersion: 1
  generator: { app: 'ProPCB'; generatedAt: string }
  job: { partNumber: string; revision: string; customer: string }
  /** ⚠ Despite the field name (kept for schema stability), this describes
   *  the SINGLE BOARD's own bounds, not a computed multi-board panel — see
   *  this module's header. */
  panel: {
    widthMm: number
    heightMm: number
    originMm: [0, 0]
    axes: { gerber: 'y-up'; image: 'y-down' }
  }
  pxPerMm: number
  images: AoiImageMeta[]
  /** Always empty — fiducials only exist on a computed panel's own ribs,
   *  which a single un-panelized board doesn't have. Kept in the schema
   *  (rather than removed) so a future panel-scoped reference, or a
   *  board whose own artwork happens to include fiducial-like copper dots,
   *  has somewhere to put them without a schema version bump. */
  fiducials: AoiFeature[]
  /** Always empty — same reasoning as `fiducials`: tooling/reference holes
   *  are panel-rib features. */
  holes: (AoiFeature & { type: 'tooling' | 'reference' })[]
  /** Exactly one entry — this one board's own bounds in both mm and px,
   *  at `{x: 0, y: 0}`. Kept as an array (rather than a single object) so
   *  the schema doesn't need to change if a future caller ever wants more
   *  than one board's worth of placements again. */
  placements: AoiPlacement[]
  warnings: string[]
}
