/**
 * tracespace plot tree -> binary copper raster (AOI reference artwork).
 *
 * The raster sibling of `film/plot-to-pdf.ts`: both drive the SAME traversal
 * (`../plot/plot-walker.ts`), so an AOI reference and a photo-plot film can
 * never disagree about what the copper actually is. Everything specific to
 * rasterising lives here — the device transform, the ground fill, the
 * antialias threshold, and the two canvas-vs-PDF semantic gaps below.
 *
 * ── Two places canvas differs from PDF, both correctness-critical ─────────
 *
 * 1. PAINT OPERATORS DO NOT CONSUME THE PATH. In PDF, `f*`/`S`/`W* n` each
 *    clear the current path, so the next construction starts clean. Canvas
 *    keeps accumulating into the same path until `beginPath()`. Left
 *    unhandled, every fill would re-paint every earlier subpath too — which
 *    also silently violates the walker's one-fill-per-graphic invariant by
 *    merging graphics under one even-odd rule (the exact `plotRectPath`
 *    corner-cancellation bug that invariant exists to prevent). `pathOpen`
 *    below restores PDF's semantics exactly: every paint ends the path,
 *    every construction after a paint starts a new one.
 *
 * 2. ANTIALIASING CANNOT BE DISABLED. Canvas always antialiases edges, so
 *    two copper shapes abutting on a pixel boundary each land ~50% coverage
 *    and composite to grey, not white. The fix is a THRESHOLD pass, not
 *    supersampling: render RGBA, then `>= 128` -> 1. Two shapes at >=30%
 *    coverage each composite above the threshold, so abutting copper stays
 *    connected — and the output is genuinely binary, which is what an
 *    inspection reference has to be.
 *
 * ⚠ Sub-pixel features are the real hazard for AOI specifically. A trace
 * thinner than ~1 device pixel antialiases to below-threshold grey and
 * DISAPPEARS — which the inspection app would report as a phantom open on a
 * perfectly good board. `minStrokeWidthMm` clamps stroke width to a ~1.5px
 * floor and reports how often it engaged, so the caller can warn loudly
 * rather than ship a reference with missing conductors.
 */
import { walkGraphic, type PathSink, type PolarizedImageTree } from '../plot/plot-walker'

/** The structural subset of `CanvasRenderingContext2D` this module needs —
 *  satisfied by the browser's `OffscreenCanvasRenderingContext2D` and by
 *  `@napi-rs/canvas`'s context (used by the headless verification script),
 *  so the sink runs unmodified in both. */
export interface Canvas2DLike {
  fillStyle: string
  strokeStyle: string
  lineWidth: number
  lineCap: string
  lineJoin: string
  globalAlpha: number
  globalCompositeOperation: string
  save(): void
  restore(): void
  beginPath(): void
  moveTo(x: number, y: number): void
  lineTo(x: number, y: number): void
  bezierCurveTo(x1: number, y1: number, x2: number, y2: number, x3: number, y3: number): void
  closePath(): void
  rect(x: number, y: number, w: number, h: number): void
  fill(rule: 'evenodd' | 'nonzero'): void
  stroke(): void
  clip(rule: 'evenodd' | 'nonzero'): void
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void
  fillRect(x: number, y: number, w: number, h: number): void
}

const GRAY_CSS = ['#000000', '#ffffff'] as const

/** Device-pixel floor for a stroked conductor — see this module's header.
 *  1.5 px guarantees the centre pixel row clears the 128 threshold even
 *  when the stroke straddles a pixel boundary. */
const MIN_STROKE_DEVICE_PX = 1.5

export interface CanvasSinkOptions {
  /** Stroke widths below this are clamped up to it. Normally
   *  `MIN_STROKE_DEVICE_PX / pxPerMm`. */
  minStrokeWidthMm: number
}

/**
 * `PathSink` over a 2D context. One instance per rasterised layer; not
 * reusable across canvases.
 */
export class CanvasSink implements PathSink {
  private pathOpen = false
  /** How many strokes hit the sub-pixel clamp, and the thinnest seen —
   *  surfaced by the caller as a warning (a reference that silently lost
   *  conductors is worse than no reference). */
  clampedStrokeCount = 0
  thinnestStrokeMm = Infinity

  constructor(
    private readonly ctx: Canvas2DLike,
    private readonly opts: CanvasSinkOptions
  ) {}

  /** PDF's implicit "a paint operator consumes the path" — see header note 1. */
  private ensurePath(): void {
    if (!this.pathOpen) {
      this.ctx.beginPath()
      this.pathOpen = true
    }
  }

  moveTo(x: number, y: number): void {
    this.ensurePath()
    this.ctx.moveTo(x, y)
  }

  lineTo(x: number, y: number): void {
    this.ensurePath()
    this.ctx.lineTo(x, y)
  }

  curveTo(x1: number, y1: number, x2: number, y2: number, x3: number, y3: number): void {
    this.ensurePath()
    this.ctx.bezierCurveTo(x1, y1, x2, y2, x3, y3)
  }

  closePath(): void {
    this.ensurePath()
    this.ctx.closePath()
  }

  rectPath(x: number, y: number, w: number, h: number): void {
    this.ensurePath()
    this.ctx.rect(x, y, w, h)
  }

  fillEvenOdd(): void {
    if (!this.pathOpen) return
    this.ctx.fill('evenodd')
    this.pathOpen = false
  }

  strokeCurrentPath(widthMm: number): void {
    if (!this.pathOpen) return
    this.thinnestStrokeMm = Math.min(this.thinnestStrokeMm, widthMm)
    if (widthMm < this.opts.minStrokeWidthMm) {
      this.clampedStrokeCount++
      this.ctx.lineWidth = this.opts.minStrokeWidthMm
    } else {
      this.ctx.lineWidth = widthMm
    }
    // Round caps/joins, matching `PdfContentBuilder.strokeCurrentPath`'s
    // `1 J`/`1 j` — a stroked Gerber aperture has no miter/butt concept.
    this.ctx.lineCap = 'round'
    this.ctx.lineJoin = 'round'
    this.ctx.stroke()
    this.pathOpen = false
  }

  setGrayFill(g: 0 | 1): void {
    this.ctx.fillStyle = GRAY_CSS[g]
  }

  setGrayStroke(g: 0 | 1): void {
    this.ctx.strokeStyle = GRAY_CSS[g]
  }

  save(): void {
    this.ctx.save()
  }

  restore(): void {
    this.ctx.restore()
    // A restored clip/state invalidates any path built under it.
    this.pathOpen = false
  }

  clipEvenOddNoPaint(): void {
    if (!this.pathOpen) return
    this.ctx.clip('evenodd')
    this.pathOpen = false
  }
}

export interface RasterizeOptions {
  pxPerMm: number
  panelWidthMm: number
  panelHeightMm: number
  /** Mirror horizontally — the bottom side, as a camera sees it with the
   *  board flipped over. Applied in the TRANSFORM, never as a second pass
   *  over the pixels (no extra full-size buffer, no resampling risk). */
  mirror: boolean
  /** Copper = black instead of white. Swaps the ink pair only — clear
   *  polarity still means "remove copper", since `grayForPolarity` picks
   *  background either way. */
  invert?: boolean
}

export interface RasterizeResult {
  widthPx: number
  heightPx: number
  warnings: string[]
}

/** Pixel dimensions for a panel at a given scale — the single definition,
 *  so the manifest, the canvas allocation and the caller's size estimate can
 *  never disagree by a rounding step. */
export function rasterDimensions(panelWidthMm: number, panelHeightMm: number, pxPerMm: number): { widthPx: number; heightPx: number } {
  return {
    widthPx: Math.round(panelWidthMm * pxPerMm),
    heightPx: Math.round(panelHeightMm * pxPerMm),
  }
}

/**
 * Paints the whole plot tree onto `ctx`, which must already be sized to
 * `rasterDimensions(...)`. Copper is WHITE (1) on a BLACK (0) ground —
 * clear-polarity graphics repaint black, i.e. remove copper, exactly as
 * `grayForPolarity` intends.
 */
export function rasterizePlotTree(
  tree: PolarizedImageTree,
  ctx: Canvas2DLike,
  opts: RasterizeOptions
): RasterizeResult {
  const warnings: string[] = []
  const { widthPx, heightPx } = rasterDimensions(opts.panelWidthMm, opts.panelHeightMm, opts.pxPerMm)
  const k = opts.pxPerMm

  // Every paint is opaque and simply overpaints what's beneath. Compositing
  // tricks (destination-out for clear polarity / erase) would punch through
  // unrelated geometry already painted below; the walker's complement-clip
  // handles erase correctly without them.
  ctx.globalAlpha = 1
  ctx.globalCompositeOperation = 'source-over'

  const copperInk: 0 | 1 = opts.invert ? 0 : 1
  const substrateInk: 0 | 1 = opts.invert ? 1 : 0

  // Ground, in device space.
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.fillStyle = GRAY_CSS[substrateInk]
  ctx.fillRect(0, 0, widthPx, heightPx)

  // Panel mm (Y-UP, Gerber handedness) -> device px (Y-DOWN). The walker
  // never negates Y (see its header, invariant 1) — the entire flip lives
  // in this one matrix, and the mirror is folded into the same place.
  //   top:    x_px = k*x_mm,      y_px = H - k*y_mm
  //   bottom: x_px = W - k*x_mm,  y_px = H - k*y_mm
  if (opts.mirror) {
    ctx.setTransform(-k, 0, 0, -k, widthPx, heightPx)
  } else {
    ctx.setTransform(k, 0, 0, -k, 0, heightPx)
  }

  const sink = new CanvasSink(ctx, { minStrokeWidthMm: MIN_STROKE_DEVICE_PX / k })
  // Covering rectangle for erase complement-clips: big enough to be
  // "everything" at this scale, without the 1e6 mm default becoming ~10^7
  // device px (which some rasterisers handle poorly).
  const eraseClipBoundMm = 4 * Math.max(opts.panelWidthMm, opts.panelHeightMm)

  for (const graphic of tree.children) {
    walkGraphic(sink, graphic, copperInk, substrateInk, warnings, { eraseClipBoundMm })
  }

  ctx.setTransform(1, 0, 0, 1, 0, 0)

  if (sink.clampedStrokeCount > 0) {
    warnings.push(
      `${sink.clampedStrokeCount} stroked conductor(s) were thinner than ${MIN_STROKE_DEVICE_PX} device px at ${k} px/mm ` +
        `(thinnest ${sink.thinnestStrokeMm.toFixed(4)} mm) and were widened to keep them visible. ` +
        `Raise the resolution to at least ${Math.ceil(MIN_STROKE_DEVICE_PX / sink.thinnestStrokeMm)} px/mm for a faithful reference.`
    )
  }

  return { widthPx, heightPx, warnings }
}

export interface DrillHoleGroup {
  diameterMm: number
  holes: { x: number; y: number }[]
}

export interface DrillSlotGroup {
  diameterMm: number
  slots: { start: { x: number; y: number }; end: { x: number; y: number } }[]
}

/**
 * Drill mask: every drilled hole painted solid, everything else ground.
 *
 * Deliberately drawn from the collected hole/slot GEOMETRY rather than by
 * rasterising the panelized Excellon text through the plot-tree walker. The
 * hole positions are already available in panel-absolute millimetres (the
 * same ones the G-code and meta-panel drill exports consume), so going back
 * out to Excellon text and re-parsing it would add a second, independently
 * fallible interpretation of the same data for no gain — and Excellon's
 * format/zero-suppression handling is the single most bug-prone corner of
 * this codebase to route a new consumer through.
 *
 * A slot is drawn as a capsule (round-capped line of the tool's diameter),
 * which is exactly what the tool physically removes.
 */
interface HolePaintCounts {
  holeCount: number
  slotCount: number
  nonFinite: number
  badDiameter: number
}

/**
 * Draws every hole (as an exact disc via a zero-length round-capped stroke)
 * and every slot (as a round-capped capsule) in `inkCss`, onto whatever is
 * already on `ctx` under the CURRENT transform. Shared by `rasterizeDrillMask`
 * (which clears to ground first, painting a standalone mask) and
 * `punchDrillHoles` (which paints straight over an already-rasterised copper
 * layer, so a flashed pad or via reads as a real donut — a copper ring
 * around a substrate-coloured hole — instead of the solid disc a bare Gerber
 * flash describes). The two callers differ only in what's already on the
 * canvas and which ink they paint with; the geometry and validation must
 * never drift between them, so they share this one implementation.
 *
 * ⚠ Non-finite coordinates must be rejected BEFORE they reach the path.
 * `moveTo(NaN, NaN)` does not throw — it silently invalidates the path, so
 * `stroke()` becomes a no-op while a naive counter happily reports the hole
 * as drawn. That combination is indistinguishable from success from the
 * outside, which is exactly how a blank mask was once produced from
 * valid-looking input. Skipped features are counted and reported by the
 * caller instead.
 */
function paintHoleGeometry(
  holeGroups: DrillHoleGroup[],
  slotGroups: DrillSlotGroup[],
  ctx: Canvas2DLike,
  inkCss: string
): HolePaintCounts {
  ctx.fillStyle = inkCss
  ctx.strokeStyle = inkCss
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'

  let holeCount = 0
  let nonFinite = 0
  let badDiameter = 0
  for (const group of holeGroups) {
    const r = group.diameterMm / 2
    if (!(r > 0)) { badDiameter += group.holes.length; continue }
    for (const h of group.holes) {
      if (!Number.isFinite(h.x) || !Number.isFinite(h.y)) { nonFinite++; continue }
      ctx.beginPath()
      // A circle as four arc-ish segments would need the walker; a filled
      // rect-free path is simplest via the canvas arc primitive, which this
      // sink's Canvas2DLike does not expose — so stroke a zero-length line
      // with a round cap of the hole's diameter, which paints an exact disc.
      ctx.lineWidth = group.diameterMm
      ctx.moveTo(h.x, h.y)
      ctx.lineTo(h.x, h.y)
      ctx.stroke()
      holeCount++
    }
  }

  let slotCount = 0
  for (const group of slotGroups) {
    if (!(group.diameterMm > 0)) { badDiameter += group.slots.length; continue }
    ctx.lineWidth = group.diameterMm
    for (const s of group.slots) {
      if (![s.start.x, s.start.y, s.end.x, s.end.y].every(Number.isFinite)) { nonFinite++; continue }
      ctx.beginPath()
      ctx.moveTo(s.start.x, s.start.y)
      ctx.lineTo(s.end.x, s.end.y)
      ctx.stroke()
      slotCount++
    }
  }

  return { holeCount, slotCount, nonFinite, badDiameter }
}

export function rasterizeDrillMask(
  holeGroups: DrillHoleGroup[],
  slotGroups: DrillSlotGroup[],
  ctx: Canvas2DLike,
  opts: RasterizeOptions
): RasterizeResult {
  const warnings: string[] = []
  const { widthPx, heightPx } = rasterDimensions(opts.panelWidthMm, opts.panelHeightMm, opts.pxPerMm)
  const k = opts.pxPerMm

  const holeInk: 0 | 1 = opts.invert ? 0 : 1
  const groundInk: 0 | 1 = opts.invert ? 1 : 0

  ctx.globalAlpha = 1
  ctx.globalCompositeOperation = 'source-over'

  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.fillStyle = GRAY_CSS[groundInk]
  ctx.fillRect(0, 0, widthPx, heightPx)

  // Identical transform to the copper raster — the two must land in the same
  // pixel space or a consumer using this mask on its own would misregister.
  if (opts.mirror) {
    ctx.setTransform(-k, 0, 0, -k, widthPx, heightPx)
  } else {
    ctx.setTransform(k, 0, 0, -k, 0, heightPx)
  }

  const { holeCount, slotCount, nonFinite, badDiameter } = paintHoleGeometry(holeGroups, slotGroups, ctx, GRAY_CSS[holeInk])

  ctx.setTransform(1, 0, 0, 1, 0, 0)

  if (nonFinite > 0) {
    warnings.push(
      `${nonFinite} drilled feature(s) had non-finite (NaN/Infinity) coordinates and were skipped — ` +
        'their positions could not be resolved from the drill layer, so those holes are missing from the mask.'
    )
  }
  if (badDiameter > 0) {
    warnings.push(`${badDiameter} drilled feature(s) had a non-positive diameter and were skipped.`)
  }
  if (holeCount === 0 && slotCount === 0) {
    warnings.push('No drilled holes found for this panel — the drill mask is empty.')
  }

  return { widthPx, heightPx, warnings }
}

/**
 * Punches every drilled hole/slot out of an ALREADY-RASTERISED copper layer,
 * in place, on the SAME canvas `rasterizePlotTree` just painted for this
 * side — so a flashed pad or via renders as a real donut (a ring of copper
 * around a substrate-coloured hole) instead of the solid disc a bare Gerber
 * flash describes. This is what a camera actually sees on a fabricated board
 * (confirmed against a real customer photo — every through-hole pad is
 * visibly a ring, never a filled dot). Before this, the AOI copper reference
 * and a real photo disagreed on every single plated hole, which is not a
 * cosmetic gap: an app diffing a photo against a solid-disc reference would
 * read the real board's own holes as defects on every good board.
 *
 * ⚠ MUST be called with the IDENTICAL `opts` (mirror, pxPerMm, panel size)
 * `rasterizePlotTree` used for this same canvas — any difference punches
 * holes in the wrong place relative to the copper already painted. Both
 * derive the device transform from the same `RasterizeOptions` shape for
 * exactly this reason, so passing the same object through is enough.
 *
 * Zero holes/slots is not a warning-worthy condition here (unlike the
 * standalone drill mask) — some panel/side combinations legitimately have
 * none, and this function's only job is to modify what's already on the
 * canvas, not to assert that a drill layer exists.
 */
export function punchDrillHoles(
  holeGroups: DrillHoleGroup[],
  slotGroups: DrillSlotGroup[],
  ctx: Canvas2DLike,
  opts: RasterizeOptions
): RasterizeResult {
  const warnings: string[] = []
  const { widthPx, heightPx } = rasterDimensions(opts.panelWidthMm, opts.panelHeightMm, opts.pxPerMm)
  const k = opts.pxPerMm

  // Same substrate ink `rasterizePlotTree` used for its ground fill — a
  // punched hole must read exactly like the bare substrate around it.
  const substrateInk: 0 | 1 = opts.invert ? 1 : 0

  ctx.globalAlpha = 1
  ctx.globalCompositeOperation = 'source-over'

  // No fillRect here — deliberately. Clearing to ground would erase the
  // copper this function exists to punch holes INTO.
  if (opts.mirror) {
    ctx.setTransform(-k, 0, 0, -k, widthPx, heightPx)
  } else {
    ctx.setTransform(k, 0, 0, -k, 0, heightPx)
  }

  const { nonFinite, badDiameter } = paintHoleGeometry(holeGroups, slotGroups, ctx, GRAY_CSS[substrateInk])

  ctx.setTransform(1, 0, 0, 1, 0, 0)

  if (nonFinite > 0) {
    warnings.push(
      `${nonFinite} drilled feature(s) had non-finite (NaN/Infinity) coordinates and were skipped while punching ` +
        'holes into the copper raster — those pads render as solid discs instead of donuts.'
    )
  }
  if (badDiameter > 0) {
    warnings.push(
      `${badDiameter} drilled feature(s) had a non-positive diameter and were skipped while punching holes into the copper raster.`
    )
  }

  return { widthPx, heightPx, warnings }
}

interface ScanRun {
  /** Inclusive start, exclusive end, along the scan axis. */
  start: number
  end: number
  v: number
}

function runsAlong(get: (i: number) => number, length: number): ScanRun[] {
  const runs: ScanRun[] = []
  let s = 0
  for (let i = 1; i <= length; i++) {
    if (i < length && get(i) === get(s)) continue
    runs.push({ start: s, end: i, v: get(s) })
    s = i
  }
  return runs
}

/** `out[i]` = length of the run containing position `i`. */
function fillRunWidths(get: (i: number) => number, length: number, out: Int32Array): void {
  let s = 0
  for (let i = 1; i <= length; i++) {
    if (i < length && get(i) === get(s)) continue
    const w = i - s
    out.fill(w, s, i)
    s = i
  }
}

/** Half-width of the sustain band, in scan lines. ⚠ Must be >1: integer
 *  quantisation puts TWO-line ties on a curved taper (a 100 px disc has
 *  consecutive rows of chord width 151, 151), so checking only the immediate
 *  neighbours accepts a taper as a plateau. Measured on a disc, ±1 reported
 *  151 px for a 201 px pad; ±4 reports the true 201. A real conductor's
 *  plateau runs for hundreds of lines, so this costs nothing against real
 *  geometry — it only rejects features shorter than 9 lines, which errs
 *  toward staying quiet. */
const SUSTAIN_HALF_BAND = 4

/**
 * Narrowest SUSTAINED copper width and gap width, in pixels, measured by
 * run-length scanning the finished bitmap along both axes.
 *
 * ⚠ "Sustained" is the whole point, and the naive version of this function was
 * wrong in a way that looked right. Taking the minimum run over every scan
 * line measures the tapering chords of any curved or diagonal boundary, not
 * conductor width: the topmost row of a filled circular pad is a ONE-PIXEL
 * run no matter how large the pad is. Verified — a solid 200 px disc reported
 * a 1 px "finest feature". Since every real board has round pads, that made
 * the resolution warning fire at every resolution, each time recommending
 * double the current one, forever.
 *
 * So a run's width counts only when NO scan line within ±SUSTAIN_HALF_BAND
 * widens at that location — i.e. the width is sustained across a band, never
 * a point on a taper. A constant-width trace is sustained over its whole
 * length and is measured exactly; a round pad is measured at its equator (its
 * true diameter); a curved boundary's tapering chords are all rejected.
 *
 * Both axes are scanned: a horizontal trace is narrow in the column direction
 * and long in the row direction. Runs touching an image edge are skipped —
 * they're truncated by the border, not by real geometry.
 *
 * Known, accepted conservatism: a momentary pinch (two pads tangent at a
 * single point) is a one-line local minimum and is NOT reported, and a 45°
 * trace reads as its axis-aligned chord rather than its perpendicular width.
 * Both err toward not warning, which is the right direction for an advisory
 * check whose false positives are what made the first version useless.
 *
 * ⚠ Real limit: this measures what IS in the raster, so it cannot see what the
 * raster LOST. Verified on a real board whose 0.05 mm clearance survives as
 * 2 px at 40 px/mm but closes to solid copper at 20 px/mm (1 px of antialiased
 * gap thresholds to copper) — at which point this reports the NEXT-narrowest
 * gap, 0.30 mm, and stays quiet. Vanished thin STROKES are covered separately
 * by `CanvasSink`'s own clamped-stroke warning; vanished thin GAPS are not
 * covered by anything today. Don't read a silent result as proof the
 * resolution is sufficient.
 */
export function measureFinestFeature(
  bitmap: Uint8Array,
  widthPx: number,
  heightPx: number
): { minCopperPx: number; minGapPx: number } {
  let minCopper = Infinity
  let minGap = Infinity

  const K = SUSTAIN_HALF_BAND
  // Reused across every band — one allocation per axis, not per line.
  const scratch: Int32Array[] = Array.from({ length: 2 * K }, () => new Int32Array(Math.max(widthPx, heightPx)))

  /**
   * One band: `lineAt(d)` reads the line `d` away from the band's centre.
   * A run of the centre line is recorded only when every other line in the
   * band has, somewhere under that run, same-value material no wider than it.
   */
  const foldBand = (lineAt: (d: number) => (i: number) => number, length: number) => {
    const mid = runsAlong(lineAt(0), length)
    let s = 0
    for (let d = -K; d <= K; d++) {
      if (d === 0) continue
      fillRunWidths(lineAt(d), length, scratch[s++])
    }

    for (const r of mid) {
      // Skip runs that touch either end — truncated by the border, not real.
      if (r.start === 0 || r.end === length) continue
      const w = r.end - r.start

      let sustained = true
      let si = 0
      for (let d = -K; d <= K && sustained; d++) {
        if (d === 0) continue
        const widths = scratch[si++]
        const get = lineAt(d)
        let found = false
        for (let i = r.start; i < r.end; i++) {
          if (get(i) === r.v && widths[i] <= w) { found = true; break }
        }
        sustained = found
      }
      if (!sustained) continue

      if (r.v) minCopper = Math.min(minCopper, w)
      else minGap = Math.min(minGap, w)
    }
  }

  // Sampling stride: enough bands to reliably catch the finest feature
  // without walking all ~65 MP of a high-resolution panel. A real thin
  // conductor spans hundreds of lines, so any sampled band crossing it finds
  // it — density matters far less than the sustain rule above.
  const rowStep = Math.max(1, Math.floor(heightPx / 400))
  for (let y = K; y < heightPx - K; y += rowStep) {
    foldBand(d => { const base = (y + d) * widthPx; return i => bitmap[base + i] }, widthPx)
  }
  const colStep = Math.max(1, Math.floor(widthPx / 400))
  for (let x = K; x < widthPx - K; x += colStep) {
    foldBand(d => { const col = x + d; return i => bitmap[i * widthPx + col] }, heightPx)
  }

  return {
    minCopperPx: Number.isFinite(minCopper) ? minCopper : 0,
    minGapPx: Number.isFinite(minGap) ? minGap : 0,
  }
}

/**
 * RGBA -> 1 bit per pixel, via the >=128 threshold described in this
 * module's header. Reads the red channel only: every colour painted here is
 * pure black or pure white, so R carries the full signal.
 */
export function thresholdToBitmap(rgba: Uint8ClampedArray | Uint8Array, widthPx: number, heightPx: number): Uint8Array {
  const out = new Uint8Array(widthPx * heightPx)
  for (let i = 0; i < out.length; i++) {
    out[i] = rgba[i * 4] >= 128 ? 1 : 0
  }
  return out
}
