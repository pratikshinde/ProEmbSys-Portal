/**
 * tracespace plot tree -> PDF content stream (photo-plot film).
 *
 * Ports the 10 shape/graphic cases from `@tracespace/renderer`'s
 * `shapeToElement`/`renderPath` (the correct reference for *structure*),
 * but THREE things there must not be copied — each would ship a real
 * artwork defect onto film:
 *
 * 1. PDF user space is Y-up — same handedness as Gerber. The renderer
 *    negates Y everywhere (`cy: -cy`, `M${x} ${-y}`, ...) because SVG is
 *    Y-down. Copying that verbatim flips the film vertically: a mirror
 *    composed with a 180 deg rotation, exactly the emulsion-side error
 *    the "never mirror" export option exists to prevent. This module
 *    never negates Y.
 * 2. Arcs are parameterized directly from `center`/`radius`/`start[2]`/
 *    `end[2]` and split at <=90 deg, not via SVG arc syntax (which needs a
 *    sweep-flag flip for Y-down and a two-arc special case for a full
 *    circle — neither applies to a Bezier-based emitter).
 * 3. `LayeredShape.erase` handling: the renderer wraps everything painted
 *    SO FAR in a `clipPath` of the erase shape, and `clipPath` INTERSECTS —
 *    the opposite of erasing. For a macro with an exposure=0 primitive
 *    (thermals, donuts) that renders only the hole and discards the pad.
 *    This module instead applies a COMPLEMENT clip (page rect + the erase
 *    subpath, even-odd) to every shape painted BEFORE that eraser, which is
 *    the correct subtraction. See `emitLayeredShape`'s own docs.
 *
 * Also: `plotRectPath` (upstream) turns a stroke made with a RECTANGULAR
 * aperture into a `LayeredShape` of one polygon per line segment, polygons
 * OVERLAPPING at the joints, none of them `erase`. Filling that under one
 * shared even-odd path would cancel every overlap and punch a hole in every
 * corner. Rule enforced throughout this file: one fill operator per
 * graphic, and one per non-erase LayeredShape sub-shape. Union comes from
 * painting independently, never from winding rules.
 *
 * Clear polarity (`%LPC*%`) and macro `erase` are DISTINCT mechanisms and
 * must not be unified: clear polarity removes from the whole image (paint
 * the background color), `erase` subtracts within one aperture's own
 * geometry (complement clip). Polarity comes from the `@tracespace/plotter`
 * patch in `patches/@tracespace+plotter+*.patch` (see that patch's own
 * comments) — the shipped `.d.ts` is deliberately left untouched, so the
 * `polarity` field is typed locally here via `PolarizedGraphic` rather than
 * patched into the package's types.
 */
import type {
  ImageTree,
  ImageGraphic,
  ImagePath,
  Shape,
  SimpleShape,
  LayeredShape,
  PathSegment,
} from '@tracespace/plotter'

import { PdfContentBuilder, PT_PER_MM } from './pdf-writer'

/** Gerber load polarity, mirroring the plotter patch's own field. Not
 *  re-exported from the patched package (see this file's header) — this is
 *  the single source of truth other film modules import from. */
export type GraphicPolarity = 'dark' | 'clear'

/** POSITIVE = artwork opaque (black) on clear ground. NEGATIVE = ground
 *  opaque, artwork knocked out clear. User-facing choice, distinct from
 *  Gerber's own dark/clear polarity (`GraphicPolarity`) — a positive film
 *  of an all-dark-polarity layer paints dark graphics black; a negative
 *  film of the same layer paints the page black and dark graphics white. */
export type FilmPolarity = 'positive' | 'negative'

export type PolarizedGraphic = ImageGraphic & { polarity?: GraphicPolarity }
export type PolarizedImageTree = Omit<ImageTree, 'children'> & {
  children: PolarizedGraphic[]
}

export interface PlotToPdfOptions {
  polarity: FilmPolarity
  panelWidthMm: number
  panelHeightMm: number
  marginMm: number
}

export interface PlotToPdfResult {
  content: string
  warnings: string[]
}

/** 4/3 * (sqrt(2) - 1) — NOT used directly (see `emitArc`'s per-segment
 *  `tan(delta/4)` formula, the general form for an arbitrary-angle arc);
 *  kept only as the well-known reference constant for the special case of
 *  a single 90 deg quadrant, which the general formula reduces to exactly. */
const QUARTER_ARC_KAPPA = 0.5522847498307936
void QUARTER_ARC_KAPPA // documentation constant; see comment above

/** Bound for a `LayeredShape` erase complement-clip's covering rectangle —
 *  generous enough to contain any real aperture's local geometry (macro
 *  coordinates are always small, single-digit-to-low-triple-digit mm) with
 *  no risk of ever clipping something it shouldn't. */
const ERASE_CLIP_BOUND_MM = 1e6

export function plotTreeToPdfContent(
  tree: PolarizedImageTree,
  opts: PlotToPdfOptions
): PlotToPdfResult {
  const warnings: string[] = []
  const b = new PdfContentBuilder()

  const mediaWidthMm = opts.panelWidthMm + 2 * opts.marginMm
  const mediaHeightMm = opts.panelHeightMm + 2 * opts.marginMm

  const foreground: 0 | 1 = opts.polarity === 'positive' ? 0 : 1 // 0 = black
  const background: 0 | 1 = opts.polarity === 'positive' ? 1 : 0

  // Ground: fill the WHOLE page (including the margin) with the background
  // color first. Every graphic after this either adds foreground ink (dark
  // polarity) or repaints background (clear polarity, i.e. "remove from the
  // image") on top.
  b.save()
  b.setGrayFill(background)
  b.rectPath(0, 0, mediaWidthMm * PT_PER_MM, mediaHeightMm * PT_PER_MM)
  b.fillEvenOdd()
  b.restore()

  // Panel-space (mm, Y-up, same as Gerber) -> PDF point space: one uniform
  // scale-and-translate. Every coordinate emitted below is a plain mm value
  // in panel space; this single `cm` is what turns it into points, INCLUDING
  // for `strokeCurrentPath`'s width argument, which is why every emit*
  // function in this file passes mm through unconverted.
  b.save()
  b.concatUniformTransform(PT_PER_MM, opts.marginMm * PT_PER_MM, opts.marginMm * PT_PER_MM)

  for (const graphic of tree.children) {
    emitGraphic(b, graphic, foreground, background, warnings)
  }

  b.restore()

  return { content: b.build(), warnings }
}

function grayForPolarity(
  graphicPolarity: GraphicPolarity | undefined,
  foreground: 0 | 1,
  background: 0 | 1
): 0 | 1 {
  // Spec default (no %LP seen yet) is dark -> foreground, matching the
  // plotter patch's own `zDarkPolarity` initial value.
  return graphicPolarity === 'clear' ? background : foreground
}

function emitGraphic(
  b: PdfContentBuilder,
  graphic: PolarizedGraphic,
  foreground: 0 | 1,
  background: 0 | 1,
  warnings: string[]
): void {
  const gray = grayForPolarity(graphic.polarity, foreground, background)

  if (graphic.type === 'imageShape') {
    emitShape(b, graphic.shape, gray)
  } else if (graphic.type === 'imagePath') {
    emitPath(b, graphic, gray, warnings)
  } else if (graphic.type === 'imageRegion') {
    if (graphic.segments.length === 0) return
    emitSegmentsPath(b, graphic.segments)
    b.closePath()
    b.setGrayFill(gray)
    b.fillEvenOdd()
  }
}

function emitShape(b: PdfContentBuilder, shape: Shape, gray: 0 | 1): void {
  if (shape.type === 'layeredShape') {
    emitLayeredShape(b, shape, gray)
    return
  }
  emitSimpleShapePath(b, shape)
  b.setGrayFill(gray)
  b.fillEvenOdd()
}

/**
 * A LayeredShape's sub-shapes paint in array order; a sub-shape flagged
 * `erase` subtracts from every sub-shape BEFORE it (matches Gerber macro
 * semantics: an exposure=0 primitive knocks a hole in what came before it
 * in the same aperture, not what comes after). Implemented as a complement
 * clip — for each non-erase sub-shape, intersect the clip region with the
 * complement (covering-rect minus subpath, even-odd) of every erase
 * sub-shape that appears LATER in the array, then paint. De Morgan's:
 * intersecting N complements equals intersecting with the complement of
 * their union, so applying them one at a time via `clipEvenOddNoPaint` is
 * exact, not an approximation.
 */
function emitLayeredShape(b: PdfContentBuilder, shape: LayeredShape, gray: 0 | 1): void {
  const subs = shape.shapes
  for (let i = 0; i < subs.length; i++) {
    const sub = subs[i]
    if (sub.erase) continue // erase sub-shapes never paint themselves

    const laterErasers = subs.slice(i + 1).filter((s) => s.erase)
    b.save()
    for (const eraser of laterErasers) {
      b.rectPath(
        -ERASE_CLIP_BOUND_MM,
        -ERASE_CLIP_BOUND_MM,
        2 * ERASE_CLIP_BOUND_MM,
        2 * ERASE_CLIP_BOUND_MM
      )
      emitSimpleShapePath(b, eraser)
      b.clipEvenOddNoPaint()
    }
    emitSimpleShapePath(b, sub)
    b.setGrayFill(gray)
    b.fillEvenOdd()
    b.restore()
  }
}

function emitPath(
  b: PdfContentBuilder,
  path: ImagePath,
  gray: 0 | 1,
  warnings: string[]
): void {
  if (path.width <= 0) {
    warnings.push(
      `Zero/negative-width stroked path skipped (width=${path.width}mm) — PDF defines 0 w as the thinnest line the device can render, a visible hairline not present in the source.`
    )
    return
  }
  if (path.segments.length === 0) return

  // A single zero-length segment (D01 to the current point) is how
  // tracespace represents a point flash drawn via a moving-tool aperture.
  // PDF's "single-point subpath with a round cap draws a dot" behavior is
  // inconsistently implemented across RIPs, so emit an explicit filled
  // circle instead of relying on it.
  if (path.segments.length === 1) {
    const seg = path.segments[0]
    if (seg.type === 'line' && seg.start[0] === seg.end[0] && seg.start[1] === seg.end[1]) {
      circlePath(b, seg.start[0], seg.start[1], path.width / 2)
      b.setGrayFill(gray)
      b.fillEvenOdd()
      return
    }
  }

  emitSegmentsPath(b, path.segments)
  b.setGrayStroke(gray)
  b.strokeCurrentPath(path.width)
}

function emitSimpleShapePath(b: PdfContentBuilder, shape: SimpleShape): void {
  switch (shape.type) {
    case 'circle':
      circlePath(b, shape.cx, shape.cy, shape.r)
      return
    case 'rectangle':
      rectanglePath(b, shape.x, shape.y, shape.xSize, shape.ySize, shape.r)
      return
    case 'polygon': {
      const pts = shape.points
      if (pts.length === 0) return
      b.moveTo(pts[0][0], pts[0][1])
      for (let i = 1; i < pts.length; i++) b.lineTo(pts[i][0], pts[i][1])
      b.closePath()
      return
    }
    case 'outline':
      emitSegmentsPath(b, shape.segments)
      b.closePath()
      return
  }
}

function circlePath(b: PdfContentBuilder, cx: number, cy: number, r: number): void {
  if (r <= 0) return
  b.moveTo(cx + r, cy)
  emitArc(b, cx, cy, r, 0, 2 * Math.PI)
  b.closePath()
}

/** Rounded-rectangle path (RectangleShape.r = corner radius, the
 *  obround/rounded-pad case) — a plain `re` would grow the pad at the
 *  corners, so this walks the 4 straight edges + 4 quarter-circle corners
 *  explicitly, CCW starting from the bottom edge. */
function rectanglePath(
  b: PdfContentBuilder,
  x: number,
  y: number,
  xSize: number,
  ySize: number,
  r: number | undefined
): void {
  if (!r || r <= 0) {
    b.rectPath(x, y, xSize, ySize)
    return
  }
  const rr = Math.min(r, xSize / 2, ySize / 2)
  const HALF_PI = Math.PI / 2

  b.moveTo(x + rr, y)
  b.lineTo(x + xSize - rr, y)
  emitArc(b, x + xSize - rr, y + rr, rr, -HALF_PI, 0)
  b.lineTo(x + xSize, y + ySize - rr)
  emitArc(b, x + xSize - rr, y + ySize - rr, rr, 0, HALF_PI)
  b.lineTo(x + rr, y + ySize)
  emitArc(b, x + rr, y + ySize - rr, rr, HALF_PI, Math.PI)
  b.lineTo(x, y + rr)
  emitArc(b, x + rr, y + rr, rr, Math.PI, 3 * HALF_PI)
  b.closePath()
}

/** Walks a plot-tree `PathSegment[]` into the content builder's current
 *  path, mirroring the renderer's own discontinuity detection (`M` only
 *  when the previous segment's end doesn't match this one's start) so a
 *  region/outline with multiple disjoint rings (a hole) becomes multiple
 *  subpaths under one even-odd fill, not one continuous (wrong) path. */
function emitSegmentsPath(b: PdfContentBuilder, segments: PathSegment[]): void {
  let prevEndX: number | null = null
  let prevEndY: number | null = null

  for (const seg of segments) {
    const [sx, sy] = seg.start
    if (prevEndX === null || prevEndX !== sx || prevEndY !== sy) {
      b.moveTo(sx, sy)
    }

    if (seg.type === 'line') {
      b.lineTo(seg.end[0], seg.end[1])
    } else {
      emitArc(b, seg.center[0], seg.center[1], seg.radius, seg.start[2], seg.end[2])
    }

    prevEndX = seg.end[0]
    prevEndY = seg.end[1]
  }
}

/**
 * Emits `curveTo` calls approximating the circular arc from `theta0` to
 * `theta1` (radians, signed — negative = clockwise) around `(cx, cy)` at
 * radius `r`. Assumes the content builder's current point is already at
 * the arc's start `(cx + r*cos(theta0), cy + r*sin(theta0))` (true for
 * every call site: either a preceding `moveTo`/`lineTo` landed there, or
 * (for `circlePath`) the caller places it there itself).
 *
 * Splits into <=90 deg sub-arcs (the standard accuracy bound for a single
 * cubic Bezier per arc) and uses the general per-segment control-point
 * formula `alpha = (4/3) * tan(delta/4)` — this is the SAME formula
 * `QUARTER_ARC_KAPPA` is the well-known special case of at exactly delta =
 * 90 deg, so no separate quadrant-specific code path is needed. A full
 * circle (delta = 2*PI) needs no special case either, unlike an SVG `A`
 * command — it simply splits into 4 exact quadrants.
 */
function emitArc(
  b: PdfContentBuilder,
  cx: number,
  cy: number,
  r: number,
  theta0: number,
  theta1: number
): void {
  const totalDelta = theta1 - theta0
  if (totalDelta === 0 || r <= 0) return

  // -1e-9 guards against a delta that's floating-point-adjacent to an exact
  // multiple of 90 deg (e.g. 2*PI computed as 6.283185307179587) rounding
  // UP into one extra, unnecessary (but still correct) sub-arc.
  const steps = Math.max(1, Math.ceil(Math.abs(totalDelta) / (Math.PI / 2) - 1e-9))
  const stepDelta = totalDelta / steps

  for (let i = 0; i < steps; i++) {
    const a0 = theta0 + stepDelta * i
    const a1 = theta0 + stepDelta * (i + 1)
    const alpha = (4 / 3) * Math.tan((a1 - a0) / 4)

    const p1x = cx + r * Math.cos(a1)
    const p1y = cy + r * Math.sin(a1)
    const c1x = cx + r * Math.cos(a0) - alpha * r * Math.sin(a0)
    const c1y = cy + r * Math.sin(a0) + alpha * r * Math.cos(a0)
    const c2x = p1x + alpha * r * Math.sin(a1)
    const c2y = p1y - alpha * r * Math.cos(a1)

    b.curveTo(c1x, c1y, c2x, c2y, p1x, p1y)
  }
}
