/**
 * One panelized Gerber string -> one film PDF. The pure pipeline function
 * `gerber-worker.ts` calls from its exposed `renderFilmPdf` — kept separate
 * from the worker file itself so it's independently testable (parse/plot
 * only needs the tracespace packages, no Worker/Comlink runtime).
 */
import { parse } from '@tracespace/parser'
import { plot } from '@tracespace/plotter'

import { normalizeGerberMacroPrimitives, normalizeFilmGerberZeroSuppression, scalePlotTreeToMm } from '../gerber-preprocess'
import { plotTreeToPdfContent, type PolarizedImageTree, type FilmPolarity } from './plot-to-pdf'
import { buildSinglePagePdf, PT_PER_MM } from './pdf-writer'

export interface GerberToFilmOptions {
  /** The already-panelized Gerber text (e.g. from generateMergedPanelizedGerber) — NOT the raw customer upload. */
  content: string
  polarity: FilmPolarity
  panelWidthMm: number
  panelHeightMm: number
  marginMm: number
  /** Prefixes every warning this run produces, e.g. "Bottom_Copper". */
  layerLabel: string
}

export interface GerberToFilmResult {
  /** null when the film could not be safely generated — see `warnings` for
   *  why. Never a best-effort/partial PDF: a film failure must either
   *  produce correct artwork or nothing at all. */
  bytes: Uint8Array | null
  warnings: string[]
}

/** How far outside the nominal panel+margin envelope plotted geometry may
 *  fall before the bounds guard rejects it — a small allowance for real
 *  floating-point rounding across mm<->native-unit conversions, NOT a
 *  tolerance for actual misdecoding (which is typically off by orders of
 *  magnitude, not fractions of a millimetre). */
const BOUNDS_EPSILON_MM = 0.5

export function gerberToFilmPdf(opts: GerberToFilmOptions): GerberToFilmResult {
  const { content, polarity, panelWidthMm, panelHeightMm, marginMm, layerLabel } = opts
  const warnings: string[] = []

  let tree
  try {
    const normalized = normalizeFilmGerberZeroSuppression(normalizeGerberMacroPrimitives(content))
    tree = parse(normalized)
  } catch (err) {
    warnings.push(`${layerLabel}: failed to parse for film generation (${errorMessage(err)}) — film skipped.`)
    return { bytes: null, warnings }
  }

  let image: PolarizedImageTree
  try {
    image = plot(tree) as unknown as PolarizedImageTree
  } catch (err) {
    warnings.push(`${layerLabel}: failed to plot for film generation (${errorMessage(err)}) — film skipped.`)
    return { bytes: null, warnings }
  }

  scalePlotTreeToMm(image)

  // Bounds guard — the single highest-value check in this pipeline. If the
  // plotted geometry doesn't land inside the panel + margin envelope,
  // something upstream decoded coordinates wrong (a zero-suppression-less
  // %FS despite the normalizer above, a unit misdetection, coordinate
  // truncation, G54 offset handling) — catches all of those at once rather
  // than trying to detect each individually. Never ship a film that might
  // be at the wrong scale; skip it and say why.
  const size = image.size
  if (Array.isArray(size) && size.length === 4) {
    const [minX, minY, maxX, maxY] = size
    const loX = -marginMm - BOUNDS_EPSILON_MM
    const loY = -marginMm - BOUNDS_EPSILON_MM
    const hiX = panelWidthMm + marginMm + BOUNDS_EPSILON_MM
    const hiY = panelHeightMm + marginMm + BOUNDS_EPSILON_MM
    if (minX < loX || minY < loY || maxX > hiX || maxY > hiY) {
      warnings.push(
        `${layerLabel}: plotted geometry (${minX.toFixed(2)}, ${minY.toFixed(2)} to ${maxX.toFixed(2)}, ${maxY.toFixed(2)} mm) ` +
          `falls outside the expected panel envelope (0, 0 to ${panelWidthMm.toFixed(2)}, ${panelHeightMm.toFixed(2)} mm + ${marginMm} mm margin) — ` +
          'film skipped rather than risk shipping wrong-scale artwork.'
      )
      return { bytes: null, warnings }
    }
  }

  const { content: pdfContent, warnings: geometryWarnings } = plotTreeToPdfContent(image, {
    polarity,
    panelWidthMm,
    panelHeightMm,
    marginMm,
  })
  for (const w of geometryWarnings) warnings.push(`${layerLabel}: ${w}`)

  const mediaWidthMm = panelWidthMm + 2 * marginMm
  const mediaHeightMm = panelHeightMm + 2 * marginMm
  const bytes = buildSinglePagePdf({
    widthPt: mediaWidthMm * PT_PER_MM,
    heightPt: mediaHeightMm * PT_PER_MM,
    content: pdfContent,
  })

  return { bytes, warnings }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
