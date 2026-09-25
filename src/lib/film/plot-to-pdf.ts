/**
 * tracespace plot tree -> PDF content stream (photo-plot film).
 *
 * The tree traversal itself lives in `../plot/plot-walker.ts`, shared with
 * the AOI raster generator — see that module's header for the four artwork
 * invariants it protects (Y handedness, arc parameterization, `erase`
 * complement-clip, and one-fill-per-graphic). This file is now only the
 * FILM-specific part: page geometry, the mm->point transform, ground fill,
 * and positive/negative ink choice.
 *
 * `PdfContentBuilder` satisfies the walker's `PathSink` structurally with no
 * adapter — the sink interface was deliberately shaped as the exact subset
 * of builder methods the traversal already used, which is what made
 * extracting it a provably output-identical move.
 */
import { PdfContentBuilder, PT_PER_MM } from './pdf-writer'
import { walkGraphic, type PolarizedImageTree } from '../plot/plot-walker'

// Re-exported so existing film importers (gerber-to-film.ts, film-types.ts,
// gerber-worker.ts) keep their current import paths — these are plot-tree
// domain types that now live with the traversal.
export type { GraphicPolarity, PolarizedGraphic, PolarizedImageTree } from '../plot/plot-walker'

/** POSITIVE = artwork opaque (black) on clear ground. NEGATIVE = ground
 *  opaque, artwork knocked out clear. User-facing choice, distinct from
 *  Gerber's own dark/clear polarity (`GraphicPolarity`) — a positive film
 *  of an all-dark-polarity layer paints dark graphics black; a negative
 *  film of the same layer paints the page black and dark graphics white. */
export type FilmPolarity = 'positive' | 'negative'

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
  // scale-and-translate. Every coordinate the walker emits is a plain mm
  // value in panel space; this single `cm` is what turns it into points,
  // INCLUDING for `strokeCurrentPath`'s width argument, which is why the
  // walker passes mm through unconverted.
  b.save()
  b.concatUniformTransform(PT_PER_MM, opts.marginMm * PT_PER_MM, opts.marginMm * PT_PER_MM)

  for (const graphic of tree.children) {
    walkGraphic(b, graphic, foreground, background, warnings)
  }

  b.restore()

  return { content: b.build(), warnings }
}
