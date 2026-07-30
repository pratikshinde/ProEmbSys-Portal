/**
 * Panelization template settings — the persisted, user-editable bundle of
 * "shop policy and machine facts" a customer re-enters on every job: rib
 * widths, tooling/fiducial sizes, drill format, output format, routing
 * (bit/tabs/mouse-bites), G-code (feeds/depths/spindle), and the Multi-Panel
 * Array CNC batch settings.
 *
 * Deliberately engine-agnostic and Prisma-free (so `prisma/seed.ts` can import
 * it from a plain Node/tsx context) — mirrors `src/lib/dfm/types.ts` in shape,
 * with one structural change explained below.
 *
 * ⚠ Grid layout (`rows`/`cols`/`gapX`/`gapY`) and `xyOverrides` are NEVER part
 * of a template — see `PanelSectionSettings` below.
 */

import { z } from 'zod'
import {
  type PanelConfig,
  type OutputFormat,
  DEFAULT_PANEL_CONFIG,
  DEFAULT_OUTPUT_FORMAT,
} from '../panelization-engine'
import { type RoutingConfig, DEFAULT_ROUTING_CONFIG } from '../routing/types'
import { type GcodeContext, DEFAULT_GCODE_CONTEXT } from '../routing/gcode'
import { type PanelArrayConfig, DEFAULT_PANEL_ARRAY_CONFIG } from '../panel-array'

// ─── Sections ──────────────────────────────────────────────────────────────

/** `rows`/`cols`/`gapX`/`gapY` are the genuine per-job input (per the user's
 *  own framing: "generally a user will choose same settings often, except
 *  panel row, column and spacing options") — a template must never carry
 *  them, or loading one would silently re-grid the current job. `xyOverrides`
 *  is keyed by hole/fiducial ids generated for ONE panel's own geometry
 *  (`tooling_br`, `fid_bl`, …); applied to a different board those ids are
 *  meaningless. */
export type PanelSectionSettings = Omit<PanelConfig, 'rows' | 'cols' | 'gapX' | 'gapY' | 'xyOverrides'>

export const PANEL_TEMPLATE_SECTIONS = ['panel', 'output', 'routing', 'gcode', 'array'] as const
export type PanelTemplateSection = typeof PANEL_TEMPLATE_SECTIONS[number]

export const PANEL_TEMPLATE_SECTION_LABELS: Record<PanelTemplateSection, string> = {
  panel: 'Panel',
  output: 'Output Format',
  routing: 'Routing',
  gcode: 'G-Code',
  array: 'Multi-Panel Array',
}

/** TS's built-in `Partial<T>` is shallow — `Partial<PanelSectionSettings>`
 *  would still require `drillFormat`, when present, to be a COMPLETE
 *  `DrillFormatConfig`. This recurses into nested objects too, matching what
 *  the zod schema below actually accepts (every field, at every depth,
 *  optional) — the two must agree or `withTemplateDefaults`' merge can't be
 *  typed against both. No arrays appear anywhere in these five config types,
 *  so the array branch is unused today but kept for a future field. */
type DeepPartial<T> = T extends (infer U)[]
  ? DeepPartial<U>[]
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T

/** What's actually stored — every section, and every field within it, is
 *  optional. */
export interface PanelTemplateSettings {
  panel?: DeepPartial<PanelSectionSettings>
  output?: DeepPartial<OutputFormat>
  routing?: DeepPartial<RoutingConfig>
  gcode?: DeepPartial<GcodeContext>
  array?: DeepPartial<PanelArrayConfig>
}

/** What every consumer actually gets — fully populated, so nothing downstream
 *  ever null-checks a section or field. */
export interface ResolvedPanelTemplateSettings {
  panel: PanelSectionSettings
  output: OutputFormat
  routing: RoutingConfig
  gcode: GcodeContext
  array: PanelArrayConfig
}

// ─── Validation ──────────────────────────────────────────────────────────────
//
// `settings` is a user-editable JSON blob persisted on PanelTemplate, so it is
// untrusted input on the way back in — always parse, never cast.
//
// ⚠ Unlike `dfm/types.ts`'s `dfmRulesSchema` (~10 fields, one `.optional()`
// added by hand as each new rule shipped), this schema is ALL-optional from
// day one — every section via `.optional()`, every field within a section via
// `.partial()`. That isn't a style choice, it's what makes the DFM versioning
// trap (documented at length in dfm/types.ts:43-53: a field made required
// *after* templates existed retroactively fails validation for every saved
// row, and the non-throwing read path then SILENTLY substitutes the shop
// baseline — discarding the customer's own values with no error) structurally
// impossible here instead of merely avoided by remembering the pattern for
// ~60 fields across five types, forever. Adding a field to any of the five
// underlying config types later needs ZERO changes in this file: old rows
// simply lack the key and `withTemplateDefaults` fills it from the current
// `DEFAULT_*` constant.

const drillFormatSectionSchema = z.object({
  preset: z.enum(['excellon-2-4', 'excellon-3-3', 'excellon-2-5', 'excellon-3-4', 'custom']),
  integerDigits: z.number().int().positive(),
  decimalDigits: z.number().int().nonnegative(),
  unit: z.enum(['mm', 'inches']),
  zeroSuppression: z.enum(['none', 'leading', 'trailing']),
}).partial()

const panelSectionSchema = z.object({
  sideRibTop: z.number().nonnegative(),
  sideRibBottom: z.number().nonnegative(),
  sideRibLeft: z.number().nonnegative(),
  sideRibRight: z.number().nonnegative(),
  panelBorderWidth: z.number().nonnegative(),
  enableToolingHoles: z.boolean(),
  toolingHoleDiameter: z.number().positive(),
  referenceHoleDiameter: z.number().positive(),
  referenceHoleInset: z.number().nonnegative(),
  toolingHoleInset: z.number().nonnegative(),
  enableFiducials: z.boolean(),
  fiducialDiameter: z.number().positive(),
  fiducialClearance: z.number().positive(),
  fiducialsTop: z.boolean(),
  fiducialsBottom: z.boolean(),
  drillFormat: drillFormatSectionSchema,
  enableLShapeMarks: z.boolean(),
  lShapeArmLength: z.number().positive(),
  lShapeLineWidth: z.number().positive(),
  enablePanelBorderLShape: z.boolean(),
  panelBorderLShapeArmLength: z.number().positive(),
  panelBorderLShapeLineWidth: z.number().positive(),
  donutOuterDiameter: z.number().positive(),
  donutInnerDiameter: z.number().positive(),
  layerNamingConvention: z.enum(['top-bottom', 'comp-sold']),
  textFont: z.enum(['stroke', 'region']),
  topRibFontSize: z.number().positive(),
  bottomRibFontSize: z.number().positive(),
}).partial()

const outputSectionSchema = z.object({
  integerDigits: z.number().int().positive(),
  decimalDigits: z.number().int().nonnegative(),
  unit: z.enum(['mm', 'inches']),
  zeroOmission: z.enum(['leading', 'trailing', 'none']),
  notation: z.enum(['absolute', 'incremental']),
}).partial()

const routingSectionSchema = z.object({
  bitDiameterMm: z.number().positive(),
  routePanelOutline: z.boolean(),
  routeIndividualPcbs: z.boolean(),
  mergeCoincidentPasses: z.boolean(),
  tabStyle: z.enum(['none', 'solid', 'mousebite']),
  tabWidthMm: z.number().positive(),
  tabsPerEdge: z.number().int().nonnegative(),
  tabTop: z.boolean(),
  tabBottom: z.boolean(),
  tabLeft: z.boolean(),
  tabRight: z.boolean(),
  tabPositionsMm: z.string(),
  mouseBiteHoleDiameterMm: z.number().positive(),
  mouseBiteHolePitchMm: z.number().positive(),
  mouseBiteEdgeClearanceMm: z.number().nonnegative(),
  mouseBiteInMainDrill: z.boolean(),
  routeGerberHairline: z.boolean(),
  pcbOutlineMode: z.enum(['auto', 'contour', 'bbox']),
  routeInteriorCutouts: z.boolean(),
  tabsPerContour: z.number().int().nonnegative(),
  contourToleranceMm: z.number().positive(),
}).partial()

const gcodeSectionSchema = z.object({
  safeZmm: z.number(),
  retractZmm: z.number(),
  cutDepthMm: z.number(),
  spindleRpm: z.number().nonnegative(),
  dwellSeconds: z.number().nonnegative(),
  pathToleranceMm: z.number().nonnegative(),
  pressurePad: z.boolean(),
  workOffset: z.string(),
  routeZFeedMmPerMin: z.number().positive(),
  routeXYFeedMmPerMin: z.number().positive(),
  drillFeedMmPerMin: z.number().positive(),
  autoFeedByDiameter: z.boolean(),
}).partial()

const arraySectionSchema = z.object({
  enabled: z.boolean(),
  cncMaxXmm: z.number().positive(),
  cncMaxYmm: z.number().positive(),
  materialXmm: z.number().positive(),
  materialYmm: z.number().positive(),
  arrayGapXmm: z.number().nonnegative(),
  arrayGapYmm: z.number().nonnegative(),
  sheetMarginMm: z.number().nonnegative(),
  markArmLengthMm: z.number().nonnegative(),
  markLineWidthMm: z.number().positive(),
  markCutDepthMm: z.number(),
}).partial()

export const panelTemplateSettingsSchema = z.object({
  panel: panelSectionSchema.optional(),
  output: outputSectionSchema.optional(),
  routing: routingSectionSchema.optional(),
  gcode: gcodeSectionSchema.optional(),
  array: arraySectionSchema.optional(),
})

// ─── Defaults + merge ────────────────────────────────────────────────────────

function stripGridFields(config: PanelConfig): PanelSectionSettings {
  const rest: Partial<PanelConfig> = { ...config }
  delete rest.rows
  delete rest.cols
  delete rest.gapX
  delete rest.gapY
  delete rest.xyOverrides
  return rest as PanelSectionSettings
}

const PANEL_SECTION_DEFAULTS: PanelSectionSettings = stripGridFields(DEFAULT_PANEL_CONFIG)

/** The shop's own starting point — what a brand-new, fully-empty template
 *  resolves to. Every section here is the corresponding engine's own
 *  `DEFAULT_*` constant, so this can never drift from what "no template"
 *  already behaves like. */
export const DEFAULT_PANEL_TEMPLATE_SETTINGS: ResolvedPanelTemplateSettings = {
  panel: PANEL_SECTION_DEFAULTS,
  output: DEFAULT_OUTPUT_FORMAT,
  routing: DEFAULT_ROUTING_CONFIG,
  gcode: DEFAULT_GCODE_CONTEXT,
  array: DEFAULT_PANEL_ARRAY_CONFIG,
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Deep-merge a partial patch over a fully-populated base, recursing into
 * plain objects (so `panel.drillFormat` — the one nested object among these
 * five config types, and the documented shallow-merge trap at
 * `store.ts`'s `updatePanelConfig` — merges field-by-field instead of being
 * replaced wholesale) and skipping any `undefined` value in the patch (so an
 * absent key truly means "keep the base's value", not "set it to undefined").
 * Generic on purpose: this is what makes a NEW nested field, in any section,
 * merge correctly with no changes here.
 */
function deepMergeDefined<T>(base: T, patch: DeepPartial<T> | undefined): T {
  if (!patch) return base
  const result = { ...base } as Record<string, unknown>
  for (const key of Object.keys(patch)) {
    const patchVal = (patch as Record<string, unknown>)[key]
    if (patchVal === undefined) continue
    const baseVal = (base as Record<string, unknown>)[key]
    result[key] = isPlainObject(patchVal) && isPlainObject(baseVal)
      ? deepMergeDefined(baseVal, patchVal as DeepPartial<typeof baseVal>)
      : patchVal
  }
  return result as T
}

/** Back-fills every section/field absent from a stored template with the
 *  shop's current defaults, so every consumer sees a complete
 *  `ResolvedPanelTemplateSettings` while the customer's own saved values are
 *  preserved untouched. */
export function withTemplateDefaults(
  parsed: z.infer<typeof panelTemplateSettingsSchema>
): ResolvedPanelTemplateSettings {
  return {
    panel: deepMergeDefined(PANEL_SECTION_DEFAULTS, parsed.panel),
    output: deepMergeDefined(DEFAULT_OUTPUT_FORMAT, parsed.output),
    routing: deepMergeDefined(DEFAULT_ROUTING_CONFIG, parsed.routing),
    gcode: deepMergeDefined(DEFAULT_GCODE_CONTEXT, parsed.gcode),
    array: deepMergeDefined(DEFAULT_PANEL_ARRAY_CONFIG, parsed.array),
  }
}

/** Throws if the stored/submitted blob isn't valid — write paths. */
export function parsePanelTemplateSettings(value: unknown): ResolvedPanelTemplateSettings {
  return withTemplateDefaults(panelTemplateSettingsSchema.parse(value))
}

/** Non-throwing variant for read paths where a corrupt row shouldn't take the
 *  whole picker down — falls back to the shop baseline. */
export function parsePanelTemplateSettingsSafe(value: unknown): ResolvedPanelTemplateSettings {
  const result = panelTemplateSettingsSchema.safeParse(value)
  return result.success ? withTemplateDefaults(result.data) : DEFAULT_PANEL_TEMPLATE_SETTINGS
}

/** Pulls the five store-shaped configs into template-shaped settings, per the
 *  grid-field exclusion documented on `PanelSectionSettings`. */
export function extractPanelTemplateSettings(state: {
  panelConfig: PanelConfig
  outputFormat: OutputFormat
  routingConfig: RoutingConfig
  gcodeContext: GcodeContext
  panelArrayConfig: PanelArrayConfig
}): PanelTemplateSettings {
  return {
    panel: stripGridFields(state.panelConfig),
    output: { ...state.outputFormat },
    routing: { ...state.routingConfig },
    gcode: { ...state.gcodeContext },
    array: { ...state.panelArrayConfig },
  }
}
