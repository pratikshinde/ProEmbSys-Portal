/**
 * Film Plot (PDF) export config — mirrors StencilConfig's split-out-of-
 * store.ts precedent (src/lib/stencil-types.ts). Films are generated at
 * EXPORT time and never stored (unlike stencilFiles), so this file has no
 * "generated file" type of its own — see store.ts's own comment on why
 * filmConfig needs no invalidation sites.
 */

export type { FilmPolarity } from './film/plot-to-pdf'
import type { FilmPolarity } from './film/plot-to-pdf'

export interface FilmLayerSetting {
  include: boolean
  /** null = not yet chosen. Deliberately no global default — "every
   *  filmable layer gets its own explicit Positive/Negative choice" is a
   *  user-confirmed requirement, not a placeholder waiting on a default.
   *  An included layer with polarity still null blocks FILM generation
   *  specifically (never the underlying Gerber export) until set. */
  polarity: FilmPolarity | null
}

/** ⚠ DELIBERATELY FLAT except for `layers` — same shallow-merge discipline
 *  StencilConfig documents. `updateFilmConfig` (store.ts) shallow-merges
 *  the scalar fields; `layers` is the one nested field and has its OWN
 *  action (`setFilmLayerSetting`) for exactly that reason — a shallow merge
 *  over `layers` would replace the whole map instead of patching one entry. */
export interface FilmConfig {
  enabled: boolean
  marginMm: number
  /** Keyed by the exact descriptiveName generateDescriptiveLayerName (
   *  gerber-exporter.ts) produces for that layer, e.g. "Bottom_Copper" —
   *  the same string used for the output filename, so a layer's setting
   *  and its file can never drift apart under a renaming layer type/side. */
  layers: Record<string, FilmLayerSetting>
}

export const DEFAULT_FILM_MARGIN_MM = 5

export const DEFAULT_FILM_CONFIG: FilmConfig = {
  enabled: false,
  marginMm: DEFAULT_FILM_MARGIN_MM,
  layers: {},
}

/** Default include/polarity for a layer the user hasn't touched yet.
 *  Copper/mask/silk default ON (the layers a shop actually exposes
 *  photoresist film for); drill/fab/outline/paste/other default OFF.
 *  Polarity always starts unset — see FilmLayerSetting's own docs. */
export function defaultFilmLayerSetting(layerType: string): FilmLayerSetting {
  const include = layerType === 'copper' || layerType === 'mask' || layerType === 'silk'
  return { include, polarity: null }
}
