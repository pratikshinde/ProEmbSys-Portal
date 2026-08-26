/**
 * One structured object per share-bundle kind, rendering BOTH the in-ZIP
 * README and (in Phase 4) the email body from the same source — so the two
 * can never drift the way a hand-duplicated README + email template would.
 *
 * Text that already exists and is already correct (the routing/cutter-
 * compensation warning, the provisional-.rou-dialect note) is reused
 * verbatim from gerber-exporter.ts's routingReadmeLines rather than
 * reworded here, on the theory that a second hand-written copy of a
 * fabrication-safety sentence is exactly how the two copies eventually say
 * different things.
 */
import { z } from 'zod'
import type { PanelResult, PanelConfig } from '../panelization-engine'
import type { RoutingResult } from '../routing/types'
import { sanitizeForFilename } from '../sanitize-filename'
import type { FilmPolarity } from '../film-types'
import type { FilmRenderedFile } from '../gerber-exporter'

// ---------------------------------------------------------------------------
// Film
// ---------------------------------------------------------------------------

export interface FilmManifest {
  partNumber: string
  customerRef: string
  revision: string
  date: string
  panelWidthMm: number
  panelHeightMm: number
  marginMm: number
  scale: '1:1'
  mirrored: false
  films: { fileName: string; layerName: string; polarity: FilmPolarity }[]
  /** A layer that was requested for film but didn't make it in — no
   *  polarity chosen, or the render pipeline itself rejected/failed it
   *  (the bounds guard, a worker error). Surfaced here so the email is the
   *  last honest place to say "this layer was requested but not plotted",
   *  rather than a toast the sender may never read and the recipient never
   *  sees at all. */
  skipped: { layerName: string; reason: string }[]
}

export function buildFilmManifest(opts: {
  partNumber: string
  customerRef: string
  revision: string
  date: string
  panelWidthMm: number
  panelHeightMm: number
  marginMm: number
  files: FilmRenderedFile[]
  /** Keyed by descriptiveName, same as FilmConfig.layers. */
  layerSettings: Record<string, { include: boolean; polarity: FilmPolarity | null }>
  /** descriptiveNames that were included for film but never got a
   *  Positive/Negative choice — never reached film.render() at all (see
   *  exportPanelizedGerbers's own filtering), so they don't appear in
   *  `files` and must be passed separately. */
  unresolvedLayerNames: string[]
}): FilmManifest {
  const films: FilmManifest['films'] = []
  const skipped: FilmManifest['skipped'] = []

  for (const f of opts.files) {
    const setting = opts.layerSettings[f.descriptiveName]
    if (f.bytes && setting?.polarity) {
      const fileName = `${opts.partNumber}_${sanitizeForFilename(f.descriptiveName, 'Layer')}_${setting.polarity === 'negative' ? 'NEG' : 'POS'}.pdf`
      films.push({ fileName, layerName: f.descriptiveName, polarity: setting.polarity })
    } else {
      skipped.push({ layerName: f.descriptiveName, reason: f.warnings[0] ?? 'Film generation failed — see warnings.' })
    }
  }
  for (const name of opts.unresolvedLayerNames) {
    skipped.push({ layerName: name, reason: 'No Positive/Negative choice was made.' })
  }

  return {
    partNumber: opts.partNumber,
    customerRef: opts.customerRef,
    revision: opts.revision,
    date: opts.date,
    panelWidthMm: opts.panelWidthMm,
    panelHeightMm: opts.panelHeightMm,
    marginMm: opts.marginMm,
    scale: '1:1',
    mirrored: false,
    films,
    skipped,
  }
}

export function renderFilmReadme(m: FilmManifest): string {
  const lines: string[] = ['=== Film Plot (PDF) ===', '']
  lines.push(`Generated: ${new Date().toISOString()}`)
  lines.push('')
  const partLine = `Part: ${m.partNumber}${m.revision ? ` Rev ${m.revision}` : ''}`
  lines.push(m.customerRef ? `${partLine} — ${m.customerRef}` : partLine)
  lines.push(`Date: ${m.date}`)
  lines.push(`Panel size: ${m.panelWidthMm.toFixed(2)} x ${m.panelHeightMm.toFixed(2)} mm (+ ${m.marginMm} mm margin per side)`)
  lines.push('')
  lines.push(`Scale: ${m.scale} (no scaling applied — verify on your own printer/imagesetter before use)`)
  lines.push('Orientation: NOT mirrored — matches the panel Gerbers exactly, viewed from the top.')
  lines.push('Bottom-side layers must be flipped by the operator (emulsion-side convention varies by shop).')

  if (m.films.length > 0) {
    lines.push('')
    lines.push('--- Films ---')
    for (const f of m.films) {
      lines.push(`${f.fileName} — ${f.layerName}, ${f.polarity === 'negative' ? 'Negative' : 'Positive'}`)
    }
  }
  if (m.skipped.length > 0) {
    lines.push('')
    lines.push('--- Requested but NOT included ---')
    for (const s of m.skipped) lines.push(`${s.layerName} — ${s.reason}`)
  }
  return lines.join('\n') + '\n'
}

// ---------------------------------------------------------------------------
// Drill
// ---------------------------------------------------------------------------

export interface DrillManifest {
  partNumber: string
  panelWidthMm: number
  panelHeightMm: number
  drillFormat: { integerDigits: number; decimalDigits: number; unit: 'mm' | 'inches'; zeroSuppression: string }
  files: string[]
  /** Mouse-bite hole count, when routing produced any — undefined when no
   *  routing plan exists (distinct from 0, which would mean tabs with no
   *  mouse-bite holes). */
  mouseBiteHoleCount?: number
  /** The two load-bearing safety sentences, reused verbatim from
   *  gerber-exporter.ts's routingReadmeLines rather than reworded — see
   *  this file's own header. Empty when there's no routing plan to warn
   *  about (a drill-only bundle with no .rou file has nothing to say). */
  routingNotes: string[]
}

export function buildDrillManifest(opts: {
  partNumber: string
  panelWidthMm: number
  panelHeightMm: number
  drillFormat: DrillManifest['drillFormat']
  files: string[]
  routing?: RoutingResult | null
}): DrillManifest {
  const routingNotes: string[] = []
  let mouseBiteHoleCount: number | undefined
  if (opts.routing && opts.routing.paths.length > 0) {
    mouseBiteHoleCount = opts.routing.tabs.reduce((n, t) => n + t.holes.length, 0)
    const bitRadiusMm = opts.routing.config.bitDiameterMm / 2
    routingNotes.push(
      `Route paths are TOOL-CENTER coordinates, offset outward from the finished board edge by the bit radius (${bitRadiusMm.toFixed(4)} mm). Do not apply cutter compensation again.`
    )
    routingNotes.push(
      'The .rou dialect is provisional — it has not yet been verified against a CAM350 rout export. Please confirm it against your router before production use.'
    )
  }
  return {
    partNumber: opts.partNumber,
    panelWidthMm: opts.panelWidthMm,
    panelHeightMm: opts.panelHeightMm,
    drillFormat: opts.drillFormat,
    files: opts.files,
    mouseBiteHoleCount,
    routingNotes,
  }
}

export function renderDrillReadme(m: DrillManifest): string {
  const lines: string[] = ['=== Drilling Files ===', '']
  lines.push(`Generated: ${new Date().toISOString()}`)
  lines.push(`Panel size: ${m.panelWidthMm.toFixed(2)} x ${m.panelHeightMm.toFixed(2)} mm`)
  lines.push('')
  lines.push('--- Drill Format ---')
  lines.push(`Format: ${m.drillFormat.integerDigits}:${m.drillFormat.decimalDigits}`)
  lines.push(`Units: ${m.drillFormat.unit === 'mm' ? 'Metric (mm)' : 'English (inches)'}`)
  lines.push(`Zero Suppression: ${m.drillFormat.zeroSuppression}`)
  if (m.mouseBiteHoleCount !== undefined) {
    lines.push('')
    lines.push(`Mouse-bite holes: ${m.mouseBiteHoleCount}`)
  }
  if (m.routingNotes.length > 0) {
    lines.push('')
    for (const note of m.routingNotes) lines.push(note)
  }
  lines.push('')
  lines.push('--- Files ---')
  for (const f of m.files) lines.push(f)
  return lines.join('\n') + '\n'
}

// ---------------------------------------------------------------------------
// Test (bare-board electrical test)
// ---------------------------------------------------------------------------

export interface TestManifest {
  partNumber: string
  panelWidthMm: number
  panelHeightMm: number
  layerNames: string[]
  files: string[]
}

export function buildTestManifest(opts: {
  partNumber: string
  panelWidthMm: number
  panelHeightMm: number
  layerNames: string[]
  files: string[]
}): TestManifest {
  return { ...opts }
}

export function renderTestReadme(m: TestManifest): string {
  const lines: string[] = ['=== Electrical Test (bare-board) ===', '']
  lines.push(`Generated: ${new Date().toISOString()}`)
  lines.push(`Panel size: ${m.panelWidthMm.toFixed(2)} x ${m.panelHeightMm.toFixed(2)} mm`)
  lines.push(`Layers: ${m.layerNames.join(', ')}`)
  lines.push('')
  lines.push('NOTE: No IPC-D-356 netlist is included — please extract nets from the')
  lines.push('supplied panelized Gerbers + drill file.')
  lines.push('')
  lines.push('--- Files ---')
  for (const f of m.files) lines.push(f)
  return lines.join('\n') + '\n'
}

// ---------------------------------------------------------------------------
// Validation (POST /api/share)
// ---------------------------------------------------------------------------
//
// The manifest is BUILT client-side (buildFilmManifest/buildDrillManifest/
// buildTestManifest, from real store/panel state the server never sees —
// the whole reason the manifest exists is to describe a ZIP that was
// generated in the browser and can't be regenerated server-side), then
// uploaded as JSON alongside the bundle. The server only ever renders the
// README/email text from it, never edits it — but it's still untrusted
// input crossing a network boundary, so it's parsed through zod like every
// other JSON blob this codebase accepts from a client (DfmRules, panel
// templates), not cast straight from `unknown`.

const filmPolaritySchema = z.enum(['positive', 'negative'])

export const filmManifestSchema = z.object({
  partNumber: z.string(),
  customerRef: z.string(),
  revision: z.string(),
  date: z.string(),
  panelWidthMm: z.number(),
  panelHeightMm: z.number(),
  marginMm: z.number(),
  scale: z.literal('1:1'),
  mirrored: z.literal(false),
  films: z.array(
    z.object({
      fileName: z.string(),
      layerName: z.string(),
      polarity: filmPolaritySchema,
    })
  ),
  skipped: z.array(z.object({ layerName: z.string(), reason: z.string() })),
}) satisfies z.ZodType<FilmManifest>

export const drillManifestSchema = z.object({
  partNumber: z.string(),
  panelWidthMm: z.number(),
  panelHeightMm: z.number(),
  drillFormat: z.object({
    integerDigits: z.number(),
    decimalDigits: z.number(),
    unit: z.enum(['mm', 'inches']),
    zeroSuppression: z.string(),
  }),
  files: z.array(z.string()),
  mouseBiteHoleCount: z.number().optional(),
  routingNotes: z.array(z.string()),
}) satisfies z.ZodType<DrillManifest>

export const testManifestSchema = z.object({
  partNumber: z.string(),
  panelWidthMm: z.number(),
  panelHeightMm: z.number(),
  layerNames: z.array(z.string()),
  files: z.array(z.string()),
}) satisfies z.ZodType<TestManifest>

export type ShareBundleKindLiteral = 'FILM' | 'DRILL' | 'TEST'

/** Parses+validates the raw manifest JSON for a given bundle kind. Throws a
 *  ZodError on malformed input — the route catches this and returns 400,
 *  same as every other zod boundary in this codebase. */
export function parseShareManifest(kind: ShareBundleKindLiteral, raw: unknown): FilmManifest | DrillManifest | TestManifest {
  switch (kind) {
    case 'FILM':
      return filmManifestSchema.parse(raw)
    case 'DRILL':
      return drillManifestSchema.parse(raw)
    case 'TEST':
      return testManifestSchema.parse(raw)
  }
}

/** Renders the README/email text for whichever manifest kind was parsed —
 *  the one switch that dispatches to the three renderXReadme functions above
 *  by kind, so POST /api/share doesn't need its own copy of this dispatch. */
export function renderShareReadme(kind: ShareBundleKindLiteral, manifest: FilmManifest | DrillManifest | TestManifest): string {
  switch (kind) {
    case 'FILM':
      return renderFilmReadme(manifest as FilmManifest)
    case 'DRILL':
      return renderDrillReadme(manifest as DrillManifest)
    case 'TEST':
      return renderTestReadme(manifest as TestManifest)
  }
}

// Re-exported so callers don't need to know these types live in
// panelization-engine/routing/types — this module is the one-stop import
// for anything manifest-related.
export type { PanelResult, PanelConfig, RoutingResult }
