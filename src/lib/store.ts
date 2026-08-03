/**
 * Application Store — Zustand state management for the Panelization CAM Tool
 */

import { create } from 'zustand'
import JSZip from 'jszip'
import { GerberLayer, parseGerber, parseExcellonDrill, isExcellonDrillFile, convertLayerUnits, GerberUnit, rotateGerberLayer, autoDetectDrillFormat, generateNormalizedExcellon, serializeParsedDrillToExcellon, DrillZeroSuppressionMode, DrillMeta } from './gerber-parser'
import { gerberToSvg, gerberRenderBoardView, checkCopperSpacing, BoardView, GerberSvgResult } from './gerber-svg'
import { recoverDrillOffset, resolvedFlashCenters } from './drill-alignment'
import { runDfm } from './dfm/run-dfm'
import type { DfmContext, DfmLayerInput, DfmReport, DfmRules } from './dfm/types'
import { PanelConfig, PanelResult, PanelInfo, PanelPlacement, PanelDesignSummary, DEFAULT_PANEL_CONFIG, computePanel, finishPackedPanel, OutputFormat, DEFAULT_OUTPUT_FORMAT, DrillFormatConfig, DrillFormatPreset, DrillZeroSuppression, DRILL_FORMAT_PRESETS, DEFAULT_DRILL_FORMAT, generateLayerLabels, LayerLabelInfo, generatePanelizedGerber, formatPanelDate, resolveDesignGeometry } from './panelization-engine'
import { LayerType, LayerSide, detectLayerType, detectLayerSide } from './gerber-analysis'
import { findPackCandidates, type PackCandidate, type PackInfeasibility, type PackItemSpec } from './packing/pack'
import { planRouting, resolveOutlineMode } from './routing/plan-routing'
import { DEFAULT_ROUTING_CONFIG, type BoardContour, type RoutingConfig, type RoutingResult } from './routing/types'
import { generateGcodeFiles as buildGcodeFiles, generateMetaPanelGcodeFiles, DEFAULT_GCODE_CONTEXT, type GcodeContext, type GcodeFile } from './routing/gcode'
import { isRoutGcodeFile, parseRoutSlots, routSlotsToGerber } from './routing/import-rout'
import { collectPanelizedDrillHoles, collectPanelizedDrillSlots, generateMetaPanelDrill } from './gerber-exporter'
import { traceBoardContour } from './board-contour'
import { BoardColorName } from './board-colors'
import {
  DEFAULT_PANEL_ARRAY_CONFIG,
  computePanelArray,
  generateBorderMarkPaths,
  generateBorderMarksGerber,
  tileHolesAcrossArray,
  tileSlotsAcrossArray,
  type PanelArrayConfig,
  type PanelArrayResult,
} from './panel-array'
import type { PanelTemplateSection, ResolvedPanelTemplateSettings } from './panel-template/types'

export type { LayerType, LayerSide }

/** The CAM tool's sidebar tabs. Previously this union was spelled out inline on
 *  both `activeTab` and `setActiveTab`, which meant adding a tab required
 *  editing two places that could silently drift apart. */
export type CamTab = 'layers' | 'designs' | 'dfm' | 'panel' | 'routing' | 'gcode' | 'export'

/** Tabs whose canvas shows the whole *panel* rather than the single imported
 *  PCB. `gerber-viewer.tsx` gates SIX separate things on this (bounds, the
 *  panel-overlay memo, the route-overlay memo, the two `<use>`-repeat render
 *  paths, and the status readout) — they must all agree, so the membership
 *  test lives here rather than being re-spelled as an `||` chain at each site. */
export const PANEL_VIEW_TABS: ReadonlySet<CamTab> = new Set<CamTab>(['panel', 'routing', 'gcode', 'export'])

export function isPanelViewTab(tab: CamTab): boolean {
  return PANEL_VIEW_TABS.has(tab)
}

/** Every generated meta-panelization (multi-panel-array CNC batch) output —
 *  see src/lib/panel-array.ts. Regenerated as one unit by
 *  `generatePanelArrayFilesAction`; there's no intermediate "plan" step the
 *  way routing/G-code have, since there's no per-file config to choose
 *  between planning and generating. */
export interface PanelArrayFiles {
  borderMarksGerberFilename: string
  borderMarksGerber: string
  drillFilename: string
  drillContent: string
  gcodeFiles: GcodeFile[]
}

export interface LayerEntry {
  id: string
  name: string
  fileName: string
  /**
   * Content handed to the exporter and the SVG renderer. For drill layers this
   * is the *normalized* Excellon (explicit decimal coords, bare METRIC header)
   * so downstream consumers never have to guess a format.
   */
  rawContent: string
  /**
   * The pristine bytes as uploaded, never rewritten. Drill format overrides and
   * auto-detect must always re-parse from this — re-parsing `rawContent` is a
   * no-op once it has been normalized to explicit decimals, which silently
   * froze the format after the first override.
   */
  originalContent: string
  parsedLayer: GerberLayer
  svgData: GerberSvgResult | null
  color: string
  visible: boolean
  opacity: number
  type: LayerType
  side: LayerSide
  /** Which `DesignEntry` this layer belongs to. Every import path tags this —
   *  a loose file joins the current `activeDesignId` (creating a default
   *  design on the very first import); a ZIP/RAR archive creates a new design
   *  in MULTI mode (one archive = one board) but appends to the active design
   *  in SINGLE mode once one exists — see `resolveImportDesignId`. */
  designId: string
  /** Rotation this layer's content was materialized at, relative to its
   *  design's original upload — always `0`, since rotated-variant
   *  materialization is a deliberately deferred feature (see CLAUDE.md's
   *  multi-design rotation note). Not the same as the whole-tool "Rotate
   *  Left/Right" button (`rotateAllLayers`), which rotates content in place. */
  variantRotationDeg: 0 | 90 | 180 | 270
}

/**
 * One uploaded board design. In SINGLE mode there is exactly one (every
 * import feeds it); in MULTI mode each archive becomes its own design and
 * several coexist in `layers`, tagged via `LayerEntry.designId`, so the
 * packer can place different boards on one panel.
 * `minCount`/`maxCount`/`allowRotation`/`priority` only matter in multi mode
 * — they're the packer's per-design inputs.
 */
export interface DesignEntry {
  id: string
  name: string
  color: string
  minCount: number
  maxCount: number | null
  allowRotation: boolean
  /** Non-null blocks rotation for this design (e.g. a macro aperture that
   *  `rotateGerberLayer` can't rotate) — reserved for whenever rotated-variant
   *  materialization actually ships; nothing sets it today. */
  rotationBlockedReason: string | null
  priority: number
}

/** Palette for auto-assigning a new design a distinguishing color — cycles
 *  once more designs exist than colors. Purely cosmetic (Designs tab, future
 *  packer preview), never touches exported Gerbers. */
const DESIGN_COLORS = ['#3b82f6', '#f59e0b', '#10b981', '#ef4444', '#8b5cf6', '#06b6d4', '#ec4899', '#84cc16']

/** Result of importing a zip file */
export interface ZipImportResult {
  total: number
  imported: number
  skipped: number
  errors: string[]
}

interface AppState {
  // Layers
  layers: LayerEntry[]
  addLayer: (file: File) => Promise<void>
  addLayersFromZip: (zipFile: File) => Promise<ZipImportResult>
  addLayersFromRar: (rarFile: File) => Promise<ZipImportResult>
  alignDrillLayersToBoard: () => Promise<void>

  // Designs — one per uploaded archive (or the shared default for loose
  // files).
  designs: DesignEntry[]
  activeDesignId: string | null
  setActiveDesignId: (id: string) => void
  renameDesign: (id: string, name: string) => void
  updateDesign: (id: string, updates: Partial<Pick<DesignEntry, 'minCount' | 'maxCount' | 'allowRotation' | 'priority'>>) => void
  removeDesign: (id: string) => void

  /**
   * Tool-wide mode: 'single' (default) is the classic one-board grid
   * workflow with EVERY multi-design surface hidden — no Designs tab, no
   * packing UI, archive imports append to the one active design. 'multi'
   * shows the full designs/packing workflow — one archive = one design,
   * panels come from the packer ("Use This Layout" / re-pack), never the
   * grid. `computePanelResult` branches on this, so "rebuild panel" call
   * sites (Create Panel, Apply Changes to Gerber, routing one-click fixes)
   * do the mode-correct thing instead of silently grid-panelizing a packed
   * layout. Switching modes clears the computed panel and everything
   * downstream (stale-plan discipline) but keeps layers/designs/DFM.
   */
  camMode: 'single' | 'multi'
  setCamMode: (mode: 'single' | 'multi') => void

  // Multi-design packing — material size + per-design min/max/rotation
  // (on DesignEntry) feed `findPackCandidates`; "Use this layout" commits a
  // chosen candidate through `finishPackedPanel`, the pack-mode counterpart
  // to `computePanel`.
  materialSizeMm: { widthMm: number; heightMm: number }
  updateMaterialSize: (updates: Partial<{ widthMm: number; heightMm: number }>) => void
  packCandidates: PackCandidate[] | null
  selectedCandidateId: string | null
  packInfeasible: PackInfeasibility[]
  findPackCandidatesAction: () => void
  selectPackCandidate: (id: string) => void
  applyPackCandidateAction: () => void

  removeLayer: (id: string) => void
  toggleLayerVisibility: (id: string) => void
  setAllLayersVisibility: (visible: boolean) => void
  reapplyDrillFormat: (layerId: string, unit: 'mm' | 'inches', integer: number, decimal: number, zeroSuppression: DrillZeroSuppressionMode) => Promise<void>
  updateLayerColor: (id: string, color: string) => void
  updateLayerType: (id: string, type: LayerType, side: LayerSide) => void
  setLayerOpacity: (id: string, opacity: number) => void
  clearLayers: () => void
  rotateAllLayers: (direction: 'left' | 'right') => Promise<void>

  // Panel config
  panelConfig: PanelConfig
  updatePanelConfig: (updates: Partial<PanelConfig>) => void
  resetPanelConfig: () => void

  // Panel info
  panelInfo: PanelInfo
  updatePanelInfo: (updates: Partial<PanelInfo>) => void

  // Output format
  outputFormat: OutputFormat
  updateOutputFormat: (updates: Partial<OutputFormat>) => void
  resetOutputFormat: () => void

  // Panel result
  panelResult: PanelResult | null
  computePanelResult: () => void

  // View state
  targetUnit: GerberUnit
  setTargetUnit: (unit: GerberUnit) => void

  // Board view (composited stack-up render via @tracespace/core)
  boardView: BoardView | null
  /** One composite per design, keyed by designId — `boardView` above is
   *  always `boardViewsByDesign[activeDesignId]` (kept as its own field so
   *  the single-PCB Layers/DFM Check views need no lookup). The panel view's
   *  multi-design rendering reads this map so each placement composites
   *  its OWN design's layers instead of the active design's repeated at
   *  every position. */
  boardViewsByDesign: Record<string, BoardView>
  boardViewSide: 'top' | 'bottom'
  /** 'board' = composited PCB look, 'layers' = per-layer overlay (debug/inspection) */
  viewMode: 'board' | 'layers'
  setViewMode: (mode: 'board' | 'layers') => void
  setBoardViewSide: (side: 'top' | 'bottom') => void
  rebuildBoardView: () => Promise<void>

  // Layer isolation on hover (Layers overlay mode only) — id of the layer
  // row currently hovered in the Layers panel, or null when not hovering.
  hoveredLayerId: string | null
  setHoveredLayerId: (id: string | null) => void

  // Soldermask color for the Board-view preview (cosmetic only — see board-colors.ts)
  boardColor: BoardColorName
  setBoardColor: (color: BoardColorName) => void

  // DFM
  dfmReport: DfmReport | null
  dfmRunning: boolean
  dfmTemplateId: string | null
  setDfmTemplateId: (id: string | null) => void
  dfmContext: DfmContext
  updateDfmContext: (updates: Partial<DfmContext>) => void
  runDfmCheck: (rules: DfmRules) => Promise<void>
  clearDfmReport: () => void
  /** Point the viewer should pan/zoom to, in Gerber-native Y-up mm. Set by
   *  clicking a finding location; the viewer clears it once handled. Mirrors
   *  the hoveredLayerId panel→viewer pattern. */
  dfmFocus: { x: number; y: number } | null
  setDfmFocus: (p: { x: number; y: number } | null) => void

  // Routing (depaneling router paths — see src/lib/routing/)
  routingConfig: RoutingConfig
  /** Shallow merge. `RoutingConfig` is deliberately FLAT so this is always
   *  correct — see the warning on the interface in routing/types.ts. */
  updateRoutingConfig: (updates: Partial<RoutingConfig>) => void
  resetRoutingConfig: () => void
  routingResult: RoutingResult | null
  /** Config changed since the last generate. The panel offers a regenerate
   *  prompt; nothing ever auto-recomputes (same rule as Create Panel / Run check). */
  routingStale: boolean
  /** Traced board profile for the outline layer, refreshed by `generateRouting`
   *  itself (never by `rebuildBoardView`, which is fire-and-forget and can
   *  resolve out of order — see the contour-routing plan's own rationale).
   *  `null` when the resolved outline mode is `'bbox'` or tracing failed. */
  boardContour: BoardContour | null
  /** True only while `generateRouting` is awaiting an async contour trace —
   *  bbox-mode generates stay synchronous and never set this. */
  routingGenerating: boolean
  generateRouting: () => Promise<void>
  clearRoutingResult: () => void
  /** Point the viewer should pan/zoom to, in Gerber-native Y-up mm. Shares the
   *  viewer's focus effect with `dfmFocus`. */
  routingFocus: { x: number; y: number } | null
  setRoutingFocus: (p: { x: number; y: number } | null) => void

  // G-code (LinuxCNC dialect — see src/lib/routing/gcode.ts). Deliberately its
  // own flat slice for the same reason RoutingConfig is: updateGcodeContext is
  // a shallow merge, so a nested field would need re-spreading in two places.
  gcodeContext: GcodeContext
  updateGcodeContext: (updates: Partial<GcodeContext>) => void
  resetGcodeContext: () => void
  gcodeFiles: GcodeFile[] | null
  /** Synchronous, like generateRouting — reads the current routingResult and
   *  the imported drill layers, requires a routingResult to exist. */
  generateGcodeFilesAction: () => void
  clearGcodeFiles: () => void

  // Meta-panelization (multi-panel-array CNC batch drilling — see
  // src/lib/panel-array.ts). Deliberately independent of RoutingResult: mark
  // routing and batch drilling only need a computed PanelResult, not a
  // generated routing plan — depaneling each panel copy into individual PCBs
  // is a separate, later, per-panel step through the existing Routing tab.
  panelArrayConfig: PanelArrayConfig
  /** Shallow merge — PanelArrayConfig is deliberately FLAT, same discipline
   *  as RoutingConfig/GcodeContext. */
  updatePanelArrayConfig: (updates: Partial<PanelArrayConfig>) => void
  resetPanelArrayConfig: () => void
  panelArrayResult: PanelArrayResult | null
  panelArrayFiles: PanelArrayFiles | null
  generatePanelArrayFilesAction: () => void
  clearPanelArrayFiles: () => void

  // Panelization templates (src/lib/panel-template/) — reusable "shop policy
  // and machine facts" bundles across panelConfig/outputFormat/routingConfig/
  // gcodeContext/panelArrayConfig. Deliberately does NOT include an
  // "applied settings" cache: selecting a template in the picker is
  // display-only (matches the DFM picker's non-destructive selection), and
  // `applyPanelTemplate` is the ONLY thing that ever writes — never on mount,
  // never on selection change. See CLAUDE.md for why this differs from the
  // DFM template picker's auto-apply-on-select behavior.
  panelTemplateId: string | null
  setPanelTemplateId: (id: string | null) => void
  /**
   * Writes only the selected sections from a resolved template into their
   * corresponding store slices, leaving every other slice — and always
   * `rows`/`cols`/`gapX`/`gapY`/`xyOverrides` within `panel` — untouched.
   * `panelResult` is deliberately never recomputed here ("nothing
   * auto-computes"); the caller is responsible for prompting a re-run of
   * Create Panel/Generate Routing/Generate G-Code as appropriate.
   */
  applyPanelTemplate: (settings: ResolvedPanelTemplateSettings, sections: PanelTemplateSection[]) => void

  // UI state
  activeTab: CamTab
  setActiveTab: (tab: CamTab) => void
  showGrid: boolean
  toggleGrid: () => void
  showCrosshair: boolean
  toggleCrosshair: () => void
}

/** Map layer type + side to a default color (PCB-realistic palette, matches
 *  the tones tracespace.io uses for its Layers tab so the overlay doesn't
 *  look chaotic when many layers stack). */
function getDefaultLayerColorByType(type: LayerType, side: LayerSide): string {
  const key = `${type}-${side}` as const
  const COLOR_MAP: Record<string, string> = {
    'copper-top':    '#cc9933',  // amber copper
    'copper-bottom': '#7a5c1f',  // darker amber for bottom
    'copper-none':   '#cc9933',
    'mask-top':      '#004200',  // dark green soldermask
    'mask-bottom':   '#003a1a',
    'mask-none':     '#004200',
    'silk-top':      '#ffffff',
    'silk-bottom':   '#dddddd',
    'silk-none':     '#ffffff',
    'outline-none':  '#ffff00',
    'outline-top':   '#ffff00',
    'outline-bottom':'#ffff00',
    'paste-top':     '#999999',
    'paste-bottom':  '#777777',
    'paste-none':    '#999999',
    'drill-none':    '#222222',
    'drill-top':     '#222222',
    'drill-bottom':  '#222222',
    'fab-none':      '#00cccc',
    'fab-top':       '#00cccc',
    'fab-bottom':    '#00cccc',
    'other-top':     '#6666ff',
    'other-bottom':  '#6666ff',
    'other-none':    '#6666ff',
  }
  return COLOR_MAP[key] || '#6666ff'
}

/**
 * Default opacity per layer type. Mask layers describe openings (not coverage),
 * so showing them fully opaque blocks the copper underneath — keep them faint.
 * Silk + copper sit on top at full strength.
 */
function getDefaultOpacityByType(type: LayerType): number {
  switch (type) {
    case 'mask': return 0.25
    case 'paste': return 0.35
    case 'fab': return 0.4
    case 'outline': return 0.85
    case 'drill': return 0.9
    case 'silk': return 0.95
    case 'copper': return 0.85
    default: return 0.7
  }
}

export { getLayerZIndex } from './board-colors'

/**
 * Create a fallback SVG from parsed Gerber data when Python generation fails.
 * This uses the parsed bounds and commands to create a basic SVG representation.
 */
function createFallbackSvg(parsedLayer: GerberLayer, fileName: string): GerberSvgResult {
  const bounds = parsedLayer.bounds
  if (!bounds) {
    return {
      svgFragment: '<g></g>',
      bounds: [],
      originalUnits: 'mm',
      boundsObj: null,
      isEmpty: true,
      error: 'No bounds available for fallback SVG',
    }
  }

  // Calculate SVG dimensions
  const width = bounds.maxX - bounds.minX
  const height = bounds.maxY - bounds.minY

  if (width <= 0 || height <= 0) {
    return {
      svgFragment: '<g></g>',
      bounds: [],
      originalUnits: 'mm',
      boundsObj: null,
      isEmpty: true,
      error: 'Invalid bounds for fallback SVG',
    }
  }

  // Create basic SVG showing bounds
  const svgFragment = `
    <rect
      x="${bounds.minX}" y="${-bounds.maxY}"
      width="${width}" height="${height}"
      fill="none" stroke="currentColor" stroke-width="0.1"
    />
    <text
      x="${bounds.minX + width/2}" y="${-bounds.minY - height/2}"
      fill="currentColor" font-size="2" text-anchor="middle"
      transform="rotate(180, ${bounds.minX + width/2}, ${-bounds.minY - height/2})"
    >
      ${fileName}
    </text>
  `

  // Screen-space bounds (Y-inverted)
  return {
    svgFragment,
    bounds: [bounds.minX, -bounds.maxY, bounds.maxX, -bounds.minY],
    originalUnits: 'mm',
    boundsObj: {
      minX: bounds.minX,
      minY: -bounds.maxY,
      maxX: bounds.maxX,
      maxY: -bounds.minY,
    },
    isEmpty: false,
    error: 'Using fallback SVG (Python generation unavailable)',
  }
}

function generateId(): string {
  return Math.random().toString(36).substring(2, 9)
}

/** Structural equality on the fields that actually affect export output (ignores `preset`, which is just a UI label). */
function sameDrillFormat(a: Omit<DrillFormatConfig, 'preset'>, b: Omit<DrillFormatConfig, 'preset'>): boolean {
  return a.integerDigits === b.integerDigits && a.decimalDigits === b.decimalDigits
    && a.unit === b.unit && a.zeroSuppression === b.zeroSuppression
    && a.camCompatibility === b.camCompatibility
}

/**
 * Map an imported drill layer's resolved format to the export DrillFormatConfig
 * shape. DrillMeta.zeroSuppression names which zeros were REMOVED FROM THE FILE
 * (import side); the export config is deliberately INVERTED (CAM350 reads the
 * LZ/TZ header keywords backwards — see panelization-engine.ts's
 * DrillZeroSuppression doc comment), so leading/trailing must be swapped here.
 * 'none' means fixed-width in both conventions and needs no swap.
 */
function drillFormatFromMeta(meta: DrillMeta): DrillFormatConfig {
  const zeroSuppression: DrillZeroSuppression =
    meta.zeroSuppression === 'leading' ? 'trailing'
      : meta.zeroSuppression === 'trailing' ? 'leading'
        : 'none'
  const format: Omit<DrillFormatConfig, 'preset'> = {
    integerDigits: meta.integerDigits,
    decimalDigits: meta.decimalDigits,
    unit: meta.unit,
    zeroSuppression,
    camCompatibility: 'cam350',
  }
  const matchedPreset = (Object.keys(DRILL_FORMAT_PRESETS) as DrillFormatPreset[])
    .find(p => p !== 'custom' && sameDrillFormat(DRILL_FORMAT_PRESETS[p], format))
  return { preset: matchedPreset ?? 'custom', ...format }
}

/**
 * Auto-populate the export drill format (Info & Export tab) from a
 * newly-imported drill layer's detected format — "export should default to
 * match the uploaded Gerber" — but only while the config is still untouched
 * (equal to DEFAULT_DRILL_FORMAT), so we never clobber a deliberate choice
 * the user already made there. Called from all three import entry points
 * (addLayer / addLayersFromZip / addLayersFromRar).
 */
function maybeSyncExportDrillFormat(get: () => AppState, set: (fn: (state: AppState) => Partial<AppState>) => void, meta: DrillMeta | undefined) {
  if (!meta) return
  const current = get().panelConfig.drillFormat
  if (!sameDrillFormat(current, DEFAULT_DRILL_FORMAT)) return // user (or an earlier sync) already set something
  const detected = drillFormatFromMeta(meta)
  if (sameDrillFormat(detected, current)) return
  set(state => ({ panelConfig: { ...state.panelConfig, drillFormat: detected } }))
}

/**
 * Content to feed `gerberToSvg` for a drill layer. Normally the raw upload —
 * tracespace has its own Excellon parsing and handles the well-known
 * conventions (explicit FORMAT=, METRIC/INCH,TZ|LZ, M71/M72, KiCad explicit
 * decimals, real T-code tool tables) fine, and several real fixtures were
 * verified byte-for-byte against exactly that raw-content render path.
 *
 * But when `parseExcellonDrill` only reached its format through a
 * content-shape heuristic — `DrillMeta.formatGuessedFromContent` (Altium
 * 9+-digit, or an Allegro "Holesize" header with no FILE_FORMAT comment) —
 * the file's OWN dialect is unusual enough that tracespace can't be trusted
 * with the raw text at all. Confirmed on a real customer file: the same
 * "Holesize N. = ..." dialect that forces the digit-width guess ALSO never
 * emits a single `Tnn` tool-select command anywhere in the body (tool
 * changes are implied positionally by bare `M00` markers instead — see the
 * parser's M00 handling) — so tracespace's plotter, which needs an explicit
 * tool selection to resolve a flash's diameter, silently drops every hole
 * (0 plotted children, confirmed) regardless of whether the coordinate
 * digits are re-normalized. `generateNormalizedExcellon` only rewrites the
 * ORIGINAL text line-by-line and can't invent tool-select commands that were
 * never there, so it doesn't fix this either.
 *
 * `serializeParsedDrillToExcellon` sidesteps all of it by building a
 * complete, from-scratch Excellon file (real `M48` tool table + a `Tnn`
 * select before every tool change) directly from `parsedLayer.apertures` /
 * `.commands`, which our own parser already resolved correctly independent
 * of what conventions — or omissions — the source file used.
 */
function drillSvgSourceContent(content: string, parsedLayer: GerberLayer): string {
  if (!parsedLayer.drillMeta?.formatGuessedFromContent) return content
  return serializeParsedDrillToExcellon(parsedLayer)
}

interface DrillOrRoutResult {
  parsedLayer: GerberLayer
  svgSourceContent: string
  /** 'rout' layers must skip the Excellon size-mismatch auto-detect below —
   *  their bounds are a handful of small milled slots, not the whole board,
   *  so the size ratio would look like a format error and trigger
   *  `autoDetectDrillFormat` on G-code text that was never Excellon at all. */
  kind: 'excellon' | 'rout'
}

/**
 * Recognize and parse the two non-Gerber import shapes this tool accepts:
 * genuine Excellon drill data, and incoming Excellon-2-style `.rou` rout
 * files (milling slots — see `routing/import-rout.ts`). Checked in that
 * order because a rout file's body (`G90`/`M30`/bare tool selects) also
 * satisfies `isExcellonDrillFile`'s heuristics; `isRoutGcodeFile`'s stricter
 * signature (plunge/retract + cutter comp + a tool select with NO diameter)
 * only matches real rout files. Returns null for ordinary Gerber content.
 */
function parseDrillOrRoutContent(content: string, fileName: string): DrillOrRoutResult | null {
  if (isRoutGcodeFile(content)) {
    const { polygons } = parseRoutSlots(content)
    const gerberText = routSlotsToGerber(polygons)
    return { parsedLayer: parseGerber(gerberText, fileName), svgSourceContent: gerberText, kind: 'rout' }
  }
  if (isExcellonDrillFile(content)) {
    const parsedLayer = parseExcellonDrill(content, fileName)
    return { parsedLayer, svgSourceContent: drillSvgSourceContent(content, parsedLayer), kind: 'excellon' }
  }
  return null
}

/**
 * The single canonical way to find "the outline layer" across the routing
 * and panelization codepaths — `type === 'outline'`, `visible`, and has
 * resolved bounds. Used consistently by `computePanelResult`, `generateRouting`,
 * and `generateGcodeFilesAction`.
 *
 * Before this was extracted, `computePanelResult` required `visible` and
 * `generateRouting` didn't — a hidden outline layer could silently drive
 * routing math (the outline-not-rectangular check, and now contour tracing
 * and the instancing datum) while being excluded from panel sizing. Routing
 * intentionally does NOT fall back to "largest layer" like
 * `computePanelResult`'s own `boundsLayer` does — that fallback exists for
 * dimensioning an odd export, not for deciding which file IS the board
 * outline to trace.
 */
function findOutlineBoundsLayer(layers: LayerEntry[]): LayerEntry | undefined {
  return layers.find(l => l.type === 'outline' && l.visible && l.parsedLayer?.bounds)
}

/**
 * Drill hole/slot collection, generalized across every design in the panel —
 * used by the G-code and meta-panel-array actions, which (unlike the Gerber
 * exporter's own drill file) call `collectPanelizedDrillHoles`/
 * `collectPanelizedDrillSlots` directly rather than through
 * `generatePanelizedDrill`. Each design's own drill layers are collected
 * against a SUB-PANEL restricted to that design's own placements and offset
 * by that design's own datum — the same per-design scoping
 * `generatePanelizedDrill`'s `perDesignBaseOffset` parameter gives the
 * Gerber exporter's drill file (see gerber-exporter.ts) — then merged by
 * diameter. Before this existed, G-code/array generation was unreachable
 * for a multi-design panel (routing itself refused one), so this scoping
 * was never exercised; Stage 7 lifting that refusal makes it reachable, and
 * without this fix it would silently stamp one design's own drill positions
 * at every OTHER design's placements too.
 */
function collectAllDesignsDrillHoles(
  layers: LayerEntry[],
  panelResult: PanelResult
): { diameterMm: number; holes: { x: number; y: number }[] }[] {
  const merged = new Map<number, { x: number; y: number }[]>()
  for (const design of panelResult.designs) {
    const designLayers = layers.filter(l => l.designId === design.designId)
    const globalBaseOffset = resolveDesignGeometry(designLayers)?.datum
    const drillLayers = designLayers
      .filter(l => l.type === 'drill' && l.parsedLayer?.bounds)
      .map(l => ({ name: l.name, fileName: l.fileName, content: l.rawContent, parsedLayer: l.parsedLayer, type: l.type, side: l.side }))
    const subPanel: PanelResult = { ...panelResult, placements: panelResult.placements.filter(p => p.designId === design.designId) }
    for (const g of collectPanelizedDrillHoles(drillLayers, subPanel, globalBaseOffset)) {
      if (!merged.has(g.diameterMm)) merged.set(g.diameterMm, [])
      merged.get(g.diameterMm)!.push(...g.holes)
    }
  }
  return [...merged.entries()].sort(([a], [b]) => a - b).map(([diameterMm, holes]) => ({ diameterMm, holes }))
}

/** Slot equivalent of `collectAllDesignsDrillHoles` — see its own docs. */
function collectAllDesignsDrillSlots(
  layers: LayerEntry[],
  panelResult: PanelResult
): { diameterMm: number; slots: { start: { x: number; y: number }; end: { x: number; y: number } }[] }[] {
  const merged = new Map<number, { start: { x: number; y: number }; end: { x: number; y: number } }[]>()
  for (const design of panelResult.designs) {
    const designLayers = layers.filter(l => l.designId === design.designId)
    const globalBaseOffset = resolveDesignGeometry(designLayers)?.datum
    const drillLayers = designLayers
      .filter(l => l.type === 'drill' && l.parsedLayer?.bounds)
      .map(l => ({ name: l.name, fileName: l.fileName, content: l.rawContent, parsedLayer: l.parsedLayer, type: l.type, side: l.side }))
    const subPanel: PanelResult = { ...panelResult, placements: panelResult.placements.filter(p => p.designId === design.designId) }
    for (const g of collectPanelizedDrillSlots(drillLayers, subPanel, globalBaseOffset)) {
      if (!merged.has(g.diameterMm)) merged.set(g.diameterMm, [])
      merged.get(g.diameterMm)!.push(...g.slots)
    }
  }
  return [...merged.entries()].sort(([a], [b]) => a - b).map(([diameterMm, slots]) => ({ diameterMm, slots }))
}

/**
 * A 1-position "panel" of exactly one un-panelized copy at the origin, with
 * every panel-overlay feature (L-shapes, tooling holes, fiducials) disabled —
 * used to re-run a single layer's own content through `generatePanelizedGerber`
 * as a plain coordinate-offset/re-serialize pass (rotate, drill-align) rather
 * than duplicating that function's body. `rotateAllLayers` and
 * `alignDrillLayersToBoard` both need exactly this and used to each construct
 * their own byte-identical copy of it.
 */
function identityPanelContext(): { panel: PanelResult; config: PanelConfig } {
  return {
    panel: {
      panelWidth: 0, panelHeight: 0, totalPCBs: 1,
      placements: [{ row: 0, col: 0, x: 0, y: 0, w: 0, h: 0, rotationDeg: 0, designId: 'default' }],
      designs: [],
      toolingHoles: [], fiducials: [], infoTexts: [],
      source: 'grid',
    },
    config: {
      ...DEFAULT_PANEL_CONFIG,
      enableLShapeMarks: false,
      enableToolingHoles: false,
      enableFiducials: false,
    },
  }
}

/**
 * Returns the current active design, creating a default "Design 1" entry if
 * none exists yet. Used by every loose-file import, and — in SINGLE mode —
 * by archive imports too once a design already exists, so re-importing a
 * revised ZIP of the same board appends to that board instead of silently
 * spawning a second design (see `resolveImportDesignId`).
 */
function ensureActiveDesignId(get: () => AppState, set: (fn: (s: AppState) => Partial<AppState>) => void): string {
  const { designs, activeDesignId } = get()
  if (activeDesignId && designs.some(d => d.id === activeDesignId)) return activeDesignId
  if (designs.length > 0) {
    set(() => ({ activeDesignId: designs[0].id }))
    return designs[0].id
  }
  const id = generateId()
  const entry: DesignEntry = {
    id, name: 'Design 1', color: DESIGN_COLORS[0],
    // allowRotation defaults false — rotated packing isn't materialized yet
    // (see findPackCandidatesAction's own doc). rotationBlockedReason is
    // reserved for when it is.
    minCount: 1, maxCount: null, allowRotation: false, rotationBlockedReason: null, priority: 0,
  }
  set(() => ({ designs: [entry], activeDesignId: id }))
  return id
}

/**
 * Which design an incoming ARCHIVE (ZIP/RAR) import belongs to.
 *
 * - Multi mode: one archive = one design, always. That's the whole point of
 *   the mode — each archive is a different board to pack alongside others.
 * - Single mode, no design yet: still create one from the archive name, so
 *   the design carries a meaningful label if the user later switches to
 *   multi mode.
 * - Single mode, design exists: APPEND to the active design. This is the
 *   headline fix for the reported confusion — previously every archive
 *   import spawned a new design, so a user re-importing a revised ZIP of
 *   the same board silently ended up with two, with only the newest one
 *   panelized while both boards' layers showed mixed in the Layers list.
 */
function resolveImportDesignId(
  get: () => AppState,
  set: (fn: (s: AppState) => Partial<AppState>) => void,
  archiveFileName: string
): string {
  const { camMode, designs } = get()
  return camMode === 'multi' || designs.length === 0
    ? createDesignFromArchiveName(get, set, archiveFileName)
    : ensureActiveDesignId(get, set)
}

/** One archive = one design, named from the archive and made active. */
function createDesignFromArchiveName(get: () => AppState, set: (fn: (s: AppState) => Partial<AppState>) => void, archiveFileName: string): string {
  const { designs } = get()
  const id = generateId()
  const name = archiveFileName.replace(/\.[^.]+$/, '')
  const entry: DesignEntry = {
    id, name, color: DESIGN_COLORS[designs.length % DESIGN_COLORS.length],
    minCount: 1, maxCount: null, allowRotation: false, rotationBlockedReason: null, priority: designs.length,
  }
  set(state => ({ designs: [...state.designs, entry], activeDesignId: id }))
  return id
}

/**
 * `PackItemSpec[]` from the current designs/layers — shared by
 * `findPackCandidatesAction` (the Designs tab's "Find Layouts") and
 * `computePanelResult`'s multi-mode re-pack, so the two can never drift on
 * geometry resolution or the rotation lockout.
 */
function buildPackItemSpecs(designs: DesignEntry[], layers: LayerEntry[]): PackItemSpec[] {
  const specs: PackItemSpec[] = []
  for (const d of designs) {
    const designLayers = layers.filter(l => l.designId === d.id)
    const geometry = resolveDesignGeometry(designLayers)
    if (!geometry || geometry.widthMm <= 0 || geometry.heightMm <= 0) continue
    specs.push({
      designId: d.id,
      widthMm: geometry.widthMm,
      heightMm: geometry.heightMm,
      minCount: d.minCount,
      maxCount: d.maxCount,
      // Rotation is deliberately never allowed here regardless of
      // `d.allowRotation` — the packer can propose a rotated placement,
      // but nothing downstream (export/viewer/routing) actually rotates
      // the design's own Gerber content to match, which would silently
      // stamp UNROTATED artwork at a ROTATED slot. The Designs tab's
      // Rotate toggle is disabled in the UI for the same reason; this is
      // the belt to that belt-and-suspenders, in case `d.allowRotation`
      // is ever `true` from stale state. See CLAUDE.md's multi-design
      // rotation section — materializing real rotated geometry is a
      // deliberately deferred, separate feature.
      allowRotation: false,
      priority: d.priority,
    })
  }
  return specs
}

/**
 * The packer's bin size, in mm — the configured material sheet minus the
 * side-rib margins `finishPanel` reserves for tooling holes/fiducials/rib
 * text. Grid mode's `buildGridPlacements` starts its grid at
 * `sideRibLeft`/`sideRibBottom` so PCBs never land under a rib; the packer
 * has no concept of ribs at all (`PackConfig` doc: "knows nothing about
 * ribs, tooling holes, fiducials, or rib text") and was being called with
 * the FULL, un-reduced material size, so a packed item routinely landed at
 * x=0/y=0 — exactly where the rib text goes. Subtracting the margins here,
 * before packing, keeps the packer from ever proposing a placement that
 * `buildPackedPanelResult` will then have to shift on top of a rib.
 * Floored at 0 so a rib configuration wider than the sheet reports as "no
 * layout fits" (the existing `packInfeasible` path) instead of handing the
 * packer a negative bin size.
 */
function packableMaterialSize(
  materialSizeMm: { widthMm: number; heightMm: number },
  config: PanelConfig
): { widthMm: number; heightMm: number } {
  return {
    widthMm: Math.max(0, materialSizeMm.widthMm - config.sideRibLeft - config.sideRibRight),
    heightMm: Math.max(0, materialSizeMm.heightMm - config.sideRibTop - config.sideRibBottom),
  }
}

/**
 * A chosen `PackCandidate` → a finished `PanelResult` (placements, design
 * summaries, tooling holes/fiducials/rib text via `finishPackedPanel`) —
 * shared by `applyPackCandidateAction` ("Use This Layout") and
 * `computePanelResult`'s multi-mode re-pack.
 */
function buildPackedPanelResult(
  candidate: PackCandidate,
  designs: DesignEntry[],
  layers: LayerEntry[],
  panelConfig: PanelConfig,
  panelInfo: PanelInfo
): PanelResult {
  // `candidate.items` are packed into the rib-reduced bin from
  // `packableMaterialSize`, at a 0,0-origin bbox of the items themselves
  // (see PackCandidate's own doc — "tight bbox of the placed items").
  // Shifting by sideRibLeft/sideRibBottom here is the exact analogue of
  // `buildGridPlacements`'s `x: config.sideRibLeft + …` — without it, the
  // packer's raw 0-origin coordinates were used as panel-absolute directly,
  // so the first packed item sat right where the rib text/fiducials go.
  const placements: PanelPlacement[] = candidate.items.map(it => ({
    x: it.x + panelConfig.sideRibLeft,
    y: it.y + panelConfig.sideRibBottom,
    w: it.w, h: it.h, rotationDeg: it.rotationDeg, designId: it.designId,
  }))

  const designSummaries: PanelDesignSummary[] = designs
    .filter(d => (candidate.countsByDesign[d.id] ?? 0) > 0)
    .map(d => {
      const geometry = resolveDesignGeometry(layers.filter(l => l.designId === d.id))
      return {
        designId: d.id,
        name: d.name,
        widthMm: geometry?.widthMm ?? 0,
        heightMm: geometry?.heightMm ?? 0,
        count: candidate.countsByDesign[d.id] ?? 0,
        rotationsDeg: [...new Set(candidate.items.filter(it => it.designId === d.id).map(it => it.rotationDeg))],
      }
    })

  // Mirrors buildGridPlacements' `panelWidth = sideRibLeft + gridWidth +
  // sideRibRight` exactly — candidate.panelWidthMm/HeightMm is the packed
  // items' own tight bbox (pre-rib), same role gridWidth/gridHeight play
  // in grid mode.
  const panelWidth = panelConfig.sideRibLeft + candidate.panelWidthMm + panelConfig.sideRibRight
  const panelHeight = panelConfig.sideRibBottom + candidate.panelHeightMm + panelConfig.sideRibTop

  return finishPackedPanel(placements, designSummaries, panelWidth, panelHeight, panelConfig, panelInfo)
}

export const useAppStore = create<AppState>((set, get) => ({
  // Layers
  layers: [],

  designs: [],
  activeDesignId: null,
  setActiveDesignId: (id: string) => set({ activeDesignId: id }),
  renameDesign: (id: string, name: string) =>
    set(state => ({ designs: state.designs.map(d => d.id === id ? { ...d, name } : d) })),

  updateDesign: (id, updates) =>
    set(state => ({
      designs: state.designs.map(d => d.id === id ? { ...d, ...updates } : d),
      // Min/max/rotation feed findPackCandidates directly — an existing
      // candidate list no longer reflects reality once these change.
      packCandidates: null,
      selectedCandidateId: null,
    })),

  removeDesign: (id: string) => {
    const { designs, activeDesignId } = get()
    const remaining = designs.filter(d => d.id !== id)
    const newActiveId = activeDesignId === id ? (remaining[0]?.id ?? null) : activeDesignId
    set(state => ({
      designs: remaining,
      layers: state.layers.filter(l => l.designId !== id),
      activeDesignId: newActiveId,
      packCandidates: null,
      selectedCandidateId: null,
    }))
    void get().rebuildBoardView()
  },

  camMode: 'single',
  setCamMode: (mode) => {
    if (get().camMode === mode) return
    set(state => ({
      camMode: mode,
      // A grid panel is meaningless in multi mode and a packed panel in
      // single mode — stale-plan discipline: clear, never keep (same list
      // as computePanelResult's success path, plus the pack-search state).
      // Deliberately KEPT: layers, designs, activeDesignId (multi → single
      // is non-destructive — other designs' layers stay in memory, hidden,
      // until the user switches back), dfmReport (scoped to the active
      // design, whose geometry is untouched by the switch), boardView(s),
      // every config slice, materialSizeMm.
      panelResult: null,
      routingResult: null, routingStale: false, routingFocus: null,
      gcodeFiles: null, boardContour: null,
      panelArrayResult: null, panelArrayFiles: null,
      packCandidates: null, selectedCandidateId: null, packInfeasible: [],
      // The Designs tab doesn't exist in single mode — don't strand the
      // user on a hidden tab.
      ...(mode === 'single' && state.activeTab === 'designs' ? { activeTab: 'layers' as CamTab } : {}),
    }))
  },

  materialSizeMm: { widthMm: 300, heightMm: 300 },
  updateMaterialSize: (updates) =>
    set(state => ({
      materialSizeMm: { ...state.materialSizeMm, ...updates },
      packCandidates: null,
      selectedCandidateId: null,
    })),

  packCandidates: null,
  selectedCandidateId: null,
  packInfeasible: [],

  findPackCandidatesAction: () => {
    const { designs, layers, materialSizeMm, panelConfig } = get()
    const packable = packableMaterialSize(materialSizeMm, panelConfig)
    const result = findPackCandidates(buildPackItemSpecs(designs, layers), {
      materialWidthMm: packable.widthMm,
      materialHeightMm: packable.heightMm,
      gapXMm: panelConfig.gapX,
      gapYMm: panelConfig.gapY,
    })
    set({
      packCandidates: result.candidates,
      packInfeasible: result.infeasible,
      selectedCandidateId: result.candidates[0]?.id ?? null,
    })
  },

  selectPackCandidate: (id: string) => set({ selectedCandidateId: id }),

  applyPackCandidateAction: () => {
    const { packCandidates, selectedCandidateId, designs, layers, panelConfig, panelInfo } = get()
    const candidate = packCandidates?.find(c => c.id === selectedCandidateId)
    if (!candidate) return

    const result = buildPackedPanelResult(candidate, designs, layers, panelConfig, panelInfo)

    // Same invalidation as computePanelResult: a fresh panel makes any
    // existing routing plan / G-code stale.
    set({
      panelResult: result,
      routingResult: null, routingStale: false, routingFocus: null, gcodeFiles: null, boardContour: null,
      panelArrayResult: null, panelArrayFiles: null,
    })
  },

  addLayer: async (file: File) => {
    const content = await file.text()
    const fileName = file.name
    try {
      // Use Excellon parser for drill files, the rout-slot importer for
      // incoming .rou milling files, Gerber parser for everything else
      const drillOrRout = parseDrillOrRoutContent(content, fileName)
      const parsedLayer: GerberLayer = drillOrRout ? drillOrRout.parsedLayer : parseGerber(content, fileName)

      // Generate SVG using server API (also extracts TF.FileFunction if present)
      const svgSourceContent = drillOrRout ? drillOrRout.svgSourceContent : content
      let svgData: GerberSvgResult | null = null
      try {
        svgData = await gerberToSvg(svgSourceContent)

        // If SVG generation failed (empty/error), create a fallback SVG from parsed data
        if (!svgData || svgData.isEmpty || svgData.error) {
          console.warn('SVG generation failed for', fileName, '- creating fallback SVG')
          svgData = createFallbackSvg(parsedLayer, fileName)
        }
      } catch (svgErr) {
        console.warn('SVG generation failed for', fileName, '- creating fallback SVG:', svgErr)
        svgData = createFallbackSvg(parsedLayer, fileName)
      }

      // Layer type detection: prefer TF.FileFunction (from Gerber content),
      // fall back to filename-based heuristics. Force 'drill' if content is
      // Excellon or a milling rout file (see parseDrillOrRoutContent).
      let type: LayerType, side: LayerSide
      if (drillOrRout) {
        type = 'drill'
        side = 'none'
      } else if (svgData?.layerAnalysis?.type) {
        type = svgData.layerAnalysis.type as LayerType
        side = svgData.layerAnalysis.side as LayerSide
      } else {
        type = detectLayerType(fileName)
        side = detectLayerSide(fileName, type)
      }
      const color = getDefaultLayerColorByType(type, side)

      // A loose file joins the active design (creating the default "Design 1"
      // on the very first import) — computed before the drill auto-detect
      // below so that comparison only ever looks at THIS design's own board
      // layers, never another design's.
      const designId = ensureActiveDesignId(get, set)

      // Convert to target unit if needed
      const targetUnit = get().targetUnit
      convertLayerUnits(parsedLayer, targetUnit)

      // Auto-detect drill format by comparing against existing board layers
      // — never for rout-derived layers, whose bounds are a handful of small
      // milled slots, not the whole board (see DrillOrRoutResult.kind).
      let finalContent = svgSourceContent
      let finalParsed = parsedLayer
      let finalSvg = svgData
      if (type === 'drill' && drillOrRout?.kind !== 'rout' && parsedLayer.bounds) {
        const existingLayers = get().layers.filter(l => l.designId === designId)
        const boardLayers = existingLayers.filter(l => l.type !== 'drill' && l.type !== 'fab' && l.type !== 'other' && l.parsedLayer?.bounds)
        if (boardLayers.length > 0) {
          let boardMinX = Infinity, boardMinY = Infinity, boardMaxX = -Infinity, boardMaxY = -Infinity
          for (const bl of boardLayers) {
            const b = bl.parsedLayer.bounds!
            boardMinX = Math.min(boardMinX, b.minX)
            boardMinY = Math.min(boardMinY, b.minY)
            boardMaxX = Math.max(boardMaxX, b.maxX)
            boardMaxY = Math.max(boardMaxY, b.maxY)
          }
          const boardWidth = boardMaxX - boardMinX
          const boardHeight = boardMaxY - boardMinY
          const db = finalParsed.bounds!
          const drillWidth = db.maxX - db.minX
          const drillHeight = db.maxY - db.minY
          const sizeRatioX = boardWidth > 0 ? Math.abs(drillWidth - boardWidth) / boardWidth : 0
          const sizeRatioY = boardHeight > 0 ? Math.abs(drillHeight - boardHeight) / boardHeight : 0

          if (sizeRatioX > 0.4 || sizeRatioY > 0.4) {
            console.log(`[Drill Auto-Detect] ${fileName}: drill (${drillWidth.toFixed(1)}x${drillHeight.toFixed(1)}) vs board (${boardWidth.toFixed(1)}x${boardHeight.toFixed(1)}) — auto-detecting`)
            const detected = autoDetectDrillFormat(content, fileName, boardWidth, boardHeight)
            if (detected) {
              console.log(`[Drill Auto-Detect] ${fileName}: detected ${detected.format.unit} ${detected.format.integer}:${detected.format.decimal} ${detected.format.zeroSuppression}`)
              finalContent = generateNormalizedExcellon(content, detected.format)
              finalParsed = detected.parsed
              if (finalParsed.drillMeta) finalParsed.drillMeta.source = 'auto-detect'
              convertLayerUnits(finalParsed, targetUnit)
              try {
                finalSvg = await gerberToSvg(finalContent)
                if (!finalSvg || finalSvg.isEmpty || finalSvg.error) {
                  finalSvg = createFallbackSvg(finalParsed, fileName)
                }
              } catch {
                finalSvg = createFallbackSvg(finalParsed, fileName)
              }
            }
          }
        }
      }

      const entry: LayerEntry = {
        id: generateId(),
        name: fileName.replace(/\.[^.]+$/, ''),
        fileName,
        rawContent: finalContent,
        originalContent: content,
        parsedLayer: finalParsed,
        svgData: finalSvg,
        color,
        visible: true,
        opacity: getDefaultOpacityByType(type),
        type,
        side,
        designId,
        variantRotationDeg: 0,
      }

      set(state => ({ layers: [...state.layers, entry], packCandidates: null, selectedCandidateId: null }))
      if (type === 'drill') maybeSyncExportDrillFormat(get, set, finalParsed.drillMeta)
      void get().rebuildBoardView()
      // NOTE: Panel computation is now only triggered when user clicks "Panel Config" button
      // Not automatically when layers are added
    } catch (e) {
      console.error('Failed to parse Gerber file:', e)
      throw e
    }
  },

  removeLayer: (id: string) => {
    set(state => ({ layers: state.layers.filter(l => l.id !== id) }))
    void get().rebuildBoardView()
  },

  toggleLayerVisibility: (id: string) => {
    set(state => ({
      layers: state.layers.map(l =>
        l.id === id ? { ...l, visible: !l.visible } : l
      ),
    }))
  },

  setAllLayersVisibility: (visible: boolean) => {
    set(state => {
      // In SINGLE mode the Layers panel only shows (and the viewer only
      // draws) the active design, so "Hide All"/"Show All" must not silently
      // flip a hidden design's layers the user can't see or undo. Multi mode
      // shows every design, so it stays global.
      const scoped = state.camMode === 'single' && state.activeDesignId
      return {
        layers: state.layers.map(l =>
          !scoped || l.designId === state.activeDesignId ? { ...l, visible } : l
        ),
      }
    })
  },

  reapplyDrillFormat: async (layerId: string, unit: 'mm' | 'inches', integer: number, decimal: number, zeroSuppression: DrillZeroSuppressionMode) => {
    const { layers, targetUnit } = get()
    const layer = layers.find(l => l.id === layerId)
    if (!layer || layer.type !== 'drill') return

    const format: import('./gerber-parser').DrillFormatOverride = { unit: unit === 'mm' ? 'mm' : 'inches', integer, decimal, zeroSuppression }
    try {
      // Always re-parse from the pristine upload. `rawContent` has already been
      // normalized to explicit decimal coordinates, which ignore the format.
      const source = layer.originalContent
      const reparsed = parseExcellonDrill(source, layer.fileName, format)
      convertLayerUnits(reparsed, targetUnit)

      const normalizedContent = generateNormalizedExcellon(source, format)

      let newSvgData: import('./gerber-svg').GerberSvgResult | null = null
      try {
        newSvgData = await gerberToSvg(normalizedContent)
        if (!newSvgData || newSvgData.isEmpty || newSvgData.error) {
          newSvgData = createFallbackSvg(reparsed, layer.fileName)
        }
      } catch {
        newSvgData = createFallbackSvg(reparsed, layer.fileName)
      }

      set(state => ({
        layers: state.layers.map(l =>
          l.id === layerId
            ? { ...l, rawContent: normalizedContent, parsedLayer: reparsed, svgData: newSvgData! }
            : l
        ),
      }))
      void get().rebuildBoardView()
      console.log(`[Drill Reformat] ${layer.fileName}: applied ${unit} ${integer}:${decimal} ${zeroSuppression}`)
    } catch (err) {
      console.error('Failed to reapply drill format:', err)
    }
  },

  updateLayerColor: (id: string, color: string) => {
    set(state => ({
      layers: state.layers.map(l =>
        l.id === id ? { ...l, color } : l
      ),
    }))
  },

  updateLayerType: (id: string, type: LayerType, side: LayerSide) => {
    set(state => ({
      layers: state.layers.map(l => {
        if (l.id !== id) return l
        // When changing type/side, re-apply the default color + opacity for that type
        const color = getDefaultLayerColorByType(type, side)
        const opacity = getDefaultOpacityByType(type)
        return { ...l, type, side, color, opacity }
      }),
    }))
  },

  setLayerOpacity: (id: string, opacity: number) => {
    set(state => ({
      layers: state.layers.map(l =>
        l.id === id ? { ...l, opacity: Math.max(0.1, Math.min(1, opacity)) } : l
      ),
    }))
  },

  clearLayers: () => {
    // Drop the DFM report and the routing plan too — leaving findings (and
    // their canvas markers) or router tool paths pointing at geometry that's no
    // longer loaded would be misleading, and a stale route would still export.
    set({
      layers: [], designs: [], activeDesignId: null, panelResult: null, boardView: null, boardViewsByDesign: {},
      dfmReport: null, dfmFocus: null,
      routingResult: null, routingStale: false, routingFocus: null, gcodeFiles: null, boardContour: null,
      panelArrayResult: null, panelArrayFiles: null,
      packCandidates: null, selectedCandidateId: null,
    })
  },

  rotateAllLayers: async (direction: 'left' | 'right') => {
    const { layers, outputFormat, activeDesignId } = get()
    // Scoped to the active design — "Rotate Left/Right" rotates the design
    // you're looking at, not every design ever imported into the tool.
    const targetLayers = activeDesignId ? layers.filter(l => l.designId === activeDesignId) : layers
    if (targetLayers.length === 0) return

    // 1. Rotate the parsedLayer objects
    for (const layer of targetLayers) {
      if (layer.parsedLayer) {
        rotateGerberLayer(layer.parsedLayer, direction)
      }
    }

    // 2. Find the new global base offset so all layers stay aligned
    const outlineLayer = targetLayers.find(l => l.type === 'outline' && l.parsedLayer?.bounds)
    let globalBaseOffset: { x: number; y: number } | undefined
    if (outlineLayer?.parsedLayer?.bounds) {
      globalBaseOffset = {
        x: -outlineLayer.parsedLayer.bounds.minX,
        y: -outlineLayer.parsedLayer.bounds.minY
      }
    } else {
      let minX = Infinity
      let minY = Infinity
      for (const l of targetLayers) {
        if (l.parsedLayer?.bounds) {
          minX = Math.min(minX, l.parsedLayer.bounds.minX)
          minY = Math.min(minY, l.parsedLayer.bounds.minY)
        }
      }
      if (minX !== Infinity && minY !== Infinity) {
        globalBaseOffset = { x: -minX, y: -minY }
      }
    }

    // 3. Generate new raw content and re-render SVG
    const { panel: dummyPanel, config: dummyConfig } = identityPanelContext()

    const updatedTargetLayers = await Promise.all(targetLayers.map(async (layer) => {
      if (!layer.parsedLayer) return layer

      // Generate new content for the rotated layer
      let newRaw: string
      if (layer.type === 'drill') {
        let drillToSerialize = layer.parsedLayer
        if (globalBaseOffset) {
          const shiftedCommands = layer.parsedLayer.commands.map(cmd => {
            const newCoord = { ...cmd.coordinate }
            if (newCoord.x !== undefined) newCoord.x += globalBaseOffset.x
            if (newCoord.y !== undefined) newCoord.y += globalBaseOffset.y
            return { ...cmd, coordinate: newCoord }
          })
          const shiftedBounds = layer.parsedLayer.bounds ? {
            minX: layer.parsedLayer.bounds.minX + globalBaseOffset.x,
            maxX: layer.parsedLayer.bounds.maxX + globalBaseOffset.x,
            minY: layer.parsedLayer.bounds.minY + globalBaseOffset.y,
            maxY: layer.parsedLayer.bounds.maxY + globalBaseOffset.y
          } : null
          drillToSerialize = {
            ...layer.parsedLayer,
            commands: shiftedCommands,
            bounds: shiftedBounds
          }
        }
        newRaw = serializeParsedDrillToExcellon(drillToSerialize)
      } else {
        newRaw = generatePanelizedGerber(
          layer.parsedLayer,
          layer.rawContent,
          dummyPanel,
          dummyConfig,
          outputFormat,
          globalBaseOffset,
          layer.type,
          layer.side
        )
      }
      
      // Parse the new content
      let newParsed: GerberLayer;
      try {
        if (layer.type === 'drill') {
          newParsed = parseExcellonDrill(newRaw, layer.fileName)
        } else {
          newParsed = parseGerber(newRaw, layer.fileName)
        }
      } catch(e) {
        newParsed = layer.parsedLayer
      }
      
      // Update svgData (tracespace requires a Gerber/Excellon string, which newRaw is)
      const newSvgData = await gerberToSvg(newRaw)
      
      return {
        ...layer,
        rawContent: newRaw,
        parsedLayer: newParsed,
        svgData: newSvgData
      }
    }))

    // Merge back into the full layer list — other designs' layers pass through untouched.
    const updatedById = new Map(updatedTargetLayers.map(l => [l.id, l]))
    const updatedLayers = layers.map(l => updatedById.get(l.id) ?? l)

    // Rotation changes every layer's geometry and drops the panel, so any
    // planned routing is against dimensions that no longer apply.
    set({
      layers: updatedLayers, panelResult: null,
      routingResult: null, routingStale: false, routingFocus: null, gcodeFiles: null, boardContour: null,
      panelArrayResult: null, panelArrayFiles: null,
      packCandidates: null, selectedCandidateId: null,
    })
    void get().rebuildBoardView()
  },

  addLayersFromZip: async (zipFile: File): Promise<ZipImportResult> => {
    const result: ZipImportResult = { total: 0, imported: 0, skipped: 0, errors: [] }

    try {
      const buffer = await zipFile.arrayBuffer()
      const zip = await JSZip.loadAsync(buffer)
      const targetUnit = get().targetUnit

      // Collect all Gerber-compatible files from the zip
      // Comprehensive extension list covering KiCad, Altium, Eagle, PADS, CAM350, etc.
      const gerberExtensions = /\.(gerber|gtl|gbl|gts|gbs|gto|gbo|gko|gtp|gbp|drl|txt|text|gbr|gt1|gt2|gt3|gt4|gt5|gt6|gb1|gb2|gb3|gb4|gb5|gb6|gm1|gm2|gm3|top|bot|sold|smt|smc|smb|pts|pli|pho|asc|cmp|sol|bslk|scmp|tslk|drill|cnc|xln|tap|nc|exc|rou|board|outline|silk|mask|paste|fab|mech|dim|drawing|plumbing)$/i

      // Get all entries, filter to files (not directories) with matching extensions
      const entries: { path: string; file: JSZip.JSZipObject }[] = []
      zip.forEach((relativePath, zipEntry) => {
        if (!zipEntry.dir && gerberExtensions.test(relativePath)) {
          entries.push({ path: relativePath, file: zipEntry })
        }
      })

      // FALLBACK: If no files matched by extension, try ALL non-directory files.
      // This handles extensionless files (e.g. PADS/CAM350 output like "bl", "bs", "tl", "to")
      // and any non-standard naming convention.
      // Exclude common non-Gerber files (PDFs, images, docs) from the fallback.
      const excludeExtensions = /\.(pdf|doc|docx|xls|xlsx|png|jpg|jpeg|gif|bmp|svg|html|htm|csv|md|rtf|odt|zip|rar|7z|tar|gz)$/i
      if (entries.length === 0) {
        zip.forEach((relativePath, zipEntry) => {
          if (!zipEntry.dir && !excludeExtensions.test(relativePath)) {
            entries.push({ path: relativePath, file: zipEntry })
          }
        })
      }

      result.total = entries.length

      if (entries.length === 0) {
        result.errors.push('No Gerber files found in the zip archive')
        return result
      }

      // One archive = one design, named from the archive itself.
      const designId = resolveImportDesignId(get, set, zipFile.name)

      const newLayers: LayerEntry[] = []

      for (const entry of entries) {
        try {
          const content = await entry.file.async('string')
          if (!content || content.trim().length === 0) {
            result.skipped++
            result.errors.push(`Skipped empty file: ${entry.path}`)
            continue
          }

          // For .txt files, verify they are actually Gerber/Excellon data, not reports
          const lowerPath = entry.path.toLowerCase()
          if (lowerPath.endsWith('.txt') || lowerPath.endsWith('.text')) {
            const isExcellon = isExcellonDrillFile(content)
            const looksLikeGerber = content.includes('%FS') || content.includes('%MO') || content.includes('G04') || content.includes('D01*') || content.includes('D02*')
            if (!isExcellon && !looksLikeGerber) {
              result.skipped++
              continue
            }
          }

          // Extract just the filename from the path for display
          const fileName = entry.path.split('/').pop() || entry.path
          // Use Excellon parser for drill files, the rout-slot importer for
          // incoming .rou milling files, Gerber parser for everything else
          const drillOrRout = parseDrillOrRoutContent(content, fileName)
          const parsedLayer: GerberLayer = drillOrRout ? drillOrRout.parsedLayer : parseGerber(content, fileName)

          // Generate SVG using server API (also extracts TF.FileFunction if present)
          const svgSourceContent = drillOrRout ? drillOrRout.svgSourceContent : content
          let svgData: GerberSvgResult | null = null
          try {
            svgData = await gerberToSvg(svgSourceContent)

            // If SVG generation failed (empty/error), create a fallback SVG from parsed data
            if (!svgData || svgData.isEmpty || svgData.error) {
              console.warn('SVG generation failed for', fileName, '- creating fallback SVG')
              svgData = createFallbackSvg(parsedLayer, fileName)
            }
          } catch (svgErr) {
            console.warn('SVG generation failed for', fileName, '- creating fallback SVG:', svgErr)
            svgData = createFallbackSvg(parsedLayer, fileName)
          }

          // Layer type detection: prefer TF.FileFunction (from Gerber content),
          // fall back to filename-based heuristics. Force 'drill' if content is
          // Excellon or a milling rout file (see parseDrillOrRoutContent).
          let type: LayerType, side: LayerSide
          if (drillOrRout) {
            type = 'drill'
            side = 'none'
          } else if (svgData?.layerAnalysis?.type) {
            type = svgData.layerAnalysis.type as LayerType
            side = svgData.layerAnalysis.side as LayerSide
          } else {
            type = detectLayerType(fileName)
            side = detectLayerSide(fileName, type)
          }
          const color = getDefaultLayerColorByType(type, side)

          // Convert to target unit if needed
          convertLayerUnits(parsedLayer, targetUnit)

          const layerEntry: LayerEntry = {
            id: generateId(),
            name: fileName.replace(/\.[^.]+$/, ''),
            fileName,
            rawContent: svgSourceContent,
            originalContent: content,
            parsedLayer,
            svgData,
            color,
            visible: true,
            opacity: getDefaultOpacityByType(type),
            type,
            side,
            designId,
            variantRotationDeg: 0,
          }

          newLayers.push(layerEntry)
          result.imported++
        } catch (err) {
          result.skipped++
          const errMsg = err instanceof Error ? err.message : String(err)
          result.errors.push(`Failed: ${entry.path} — ${errMsg}`)
        }
      }

      // Add all successfully parsed layers to state
      if (newLayers.length > 0) {
        // Post-import: auto-detect drill format by comparing against board layers
        const boardLayers = newLayers.filter(l => l.type !== 'drill' && l.type !== 'fab' && l.type !== 'other' && l.parsedLayer?.bounds)
        const drillLayersToFix = newLayers.filter(l => l.type === 'drill' && l.parsedLayer?.bounds)

        if (boardLayers.length > 0 && drillLayersToFix.length > 0) {
          let boardMinX = Infinity, boardMinY = Infinity, boardMaxX = -Infinity, boardMaxY = -Infinity
          for (const bl of boardLayers) {
            const b = bl.parsedLayer.bounds!
            boardMinX = Math.min(boardMinX, b.minX)
            boardMinY = Math.min(boardMinY, b.minY)
            boardMaxX = Math.max(boardMaxX, b.maxX)
            boardMaxY = Math.max(boardMaxY, b.maxY)
          }
          const boardWidth = boardMaxX - boardMinX
          const boardHeight = boardMaxY - boardMinY

          for (let i = 0; i < newLayers.length; i++) {
            const layer = newLayers[i]
            // Rout-derived slot layers go through parseGerber, which never sets
            // drillMeta — this distinguishes them from real Excellon layers
            // without needing a separate field on LayerEntry. Their bounds are
            // a handful of small milled slots, not the whole board, so they
            // must never enter the size-mismatch auto-detect below.
            if (layer.type !== 'drill' || !layer.parsedLayer?.bounds || !layer.parsedLayer?.drillMeta) continue

            const db = layer.parsedLayer.bounds!
            const drillWidth = db.maxX - db.minX
            const drillHeight = db.maxY - db.minY
            const sizeRatioX = boardWidth > 0 ? Math.abs(drillWidth - boardWidth) / boardWidth : 0
            const sizeRatioY = boardHeight > 0 ? Math.abs(drillHeight - boardHeight) / boardHeight : 0

            if (sizeRatioX > 0.4 || sizeRatioY > 0.4) {
              console.log(`[Drill Auto-Detect ZIP] ${layer.fileName}: drill (${drillWidth.toFixed(1)}x${drillHeight.toFixed(1)}) vs board (${boardWidth.toFixed(1)}x${boardHeight.toFixed(1)}) — attempting format detection`)

              const detected = autoDetectDrillFormat(layer.originalContent, layer.fileName, boardWidth, boardHeight)
              if (detected) {
                console.log(`[Drill Auto-Detect ZIP] ${layer.fileName}: detected ${detected.format.unit} ${detected.format.integer}:${detected.format.decimal} ${detected.format.zeroSuppression}`)

                const normalizedContent = generateNormalizedExcellon(layer.originalContent, detected.format)
                const correctedParsed = detected.parsed
                if (correctedParsed.drillMeta) correctedParsed.drillMeta.source = 'auto-detect'
                convertLayerUnits(correctedParsed, targetUnit)

                let newSvgData: GerberSvgResult | null = null
                try {
                  newSvgData = await gerberToSvg(normalizedContent)
                  if (!newSvgData || newSvgData.isEmpty || newSvgData.error) {
                    newSvgData = createFallbackSvg(correctedParsed, layer.fileName)
                  }
                } catch {
                  newSvgData = createFallbackSvg(correctedParsed, layer.fileName)
                }

                newLayers[i] = {
                  ...layer,
                  rawContent: normalizedContent,
                  parsedLayer: correctedParsed,
                  svgData: newSvgData,
                }
              }
            }
          }
        }

        set(state => ({ layers: [...state.layers, ...newLayers], packCandidates: null, selectedCandidateId: null }))
        const firstDrillLayer = newLayers.find(l => l.type === 'drill')
        if (firstDrillLayer) maybeSyncExportDrillFormat(get, set, firstDrillLayer.parsedLayer?.drillMeta)
        void get().rebuildBoardView()
        // NOTE: Panel computation is now only triggered when user clicks "Panel Config" button
        // Not automatically when layers are added from zip
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      result.errors.push(`Failed to read zip file: ${errMsg}`)
    }

    return result
  },

  addLayersFromRar: async (rarFile: File): Promise<ZipImportResult> => {
    const result: ZipImportResult = { total: 0, imported: 0, skipped: 0, errors: [] }

    try {
      const { createExtractorFromData } = await import('node-unrar-js')
      const buffer = await rarFile.arrayBuffer()
      
      // Fetch WASM from CDN for maximum portability & build stability
      const wasmResponse = await fetch('https://unpkg.com/node-unrar-js@2.0.2/esm/js/unrar.wasm')
      if (!wasmResponse.ok) {
        throw new Error('Failed to fetch unrar.wasm from CDN')
      }
      const wasmBinary = await wasmResponse.arrayBuffer()
      
      const extractor = await createExtractorFromData({
        data: buffer,
        wasmBinary
      })
      
      const list = extractor.getFileList()
      const fileHeaders = [...list.fileHeaders]
      
      const gerberExtensions = /\.(gerber|gtl|gbl|gts|gbs|gto|gbo|gko|gtp|gbp|drl|txt|text|gbr|gt1|gt2|gt3|gt4|gt5|gt6|gb1|gb2|gb3|gb4|gb5|gb6|gm1|gm2|gm3|top|bot|sold|smt|smc|smb|pts|pli|pho|asc|cmp|sol|bslk|scmp|tslk|drill|cnc|xln|tap|nc|exc|rou|board|outline|silk|mask|paste|fab|mech|dim|drawing|plumbing)$/i
      const excludeExtensions = /\.(pdf|doc|docx|xls|xlsx|png|jpg|jpeg|gif|bmp|svg|html|htm|csv|md|rtf|odt|zip|rar|7z|tar|gz)$/i

      // Filter entries by extension
      let entries = fileHeaders.filter(fh => !fh.flags.directory && gerberExtensions.test(fh.name))
      
      // Fallback: if none match by extension, include all non-excluded files
      if (entries.length === 0) {
        entries = fileHeaders.filter(fh => !fh.flags.directory && !excludeExtensions.test(fh.name))
      }

      result.total = entries.length
      if (entries.length === 0) {
        result.errors.push('No Gerber files found in the RAR archive')
        return result
      }

      const filesToExtract = entries.map(e => e.name)
      const extracted = extractor.extract({ files: filesToExtract })
      const extractedFiles = [...extracted.files]

      const targetUnit = get().targetUnit
      // One archive = one design, named from the archive itself.
      const designId = resolveImportDesignId(get, set, rarFile.name)
      const newLayers: LayerEntry[] = []

      for (const file of extractedFiles) {
        if (!file.extraction) continue
        const path = file.fileHeader.name
        const content = new TextDecoder('utf-8').decode(file.extraction)

        try {
          if (!content || content.trim().length === 0) {
            result.skipped++
            result.errors.push(`Skipped empty file: ${path}`)
            continue
          }

          const lowerPath = path.toLowerCase()
          if (lowerPath.endsWith('.txt') || lowerPath.endsWith('.text')) {
            const isExcellon = isExcellonDrillFile(content)
            const looksLikeGerber = content.includes('%FS') || content.includes('%MO') || content.includes('G04') || content.includes('D01*') || content.includes('D02*')
            if (!isExcellon && !looksLikeGerber) {
              result.skipped++
              continue
            }
          }

          // Extract filename from the path
          const fileName = path.split('/').pop() || path

          // Use Excellon parser for drill files, the rout-slot importer for
          // incoming .rou milling files, Gerber parser for everything else
          const drillOrRout = parseDrillOrRoutContent(content, fileName)
          const parsedLayer: GerberLayer = drillOrRout ? drillOrRout.parsedLayer : parseGerber(content, fileName)

          const svgSourceContent = drillOrRout ? drillOrRout.svgSourceContent : content
          let svgData: GerberSvgResult | null = null
          try {
            svgData = await gerberToSvg(svgSourceContent)
            if (!svgData || svgData.isEmpty || svgData.error) {
              console.warn('SVG generation failed for', fileName, '- creating fallback SVG')
              svgData = createFallbackSvg(parsedLayer, fileName)
            }
          } catch (svgErr) {
            console.warn('SVG generation failed for', fileName, '- creating fallback SVG:', svgErr)
            svgData = createFallbackSvg(parsedLayer, fileName)
          }

          let type: LayerType, side: LayerSide
          if (drillOrRout) {
            type = 'drill'
            side = 'none'
          } else if (svgData?.layerAnalysis?.type) {
            type = svgData.layerAnalysis.type as LayerType
            side = svgData.layerAnalysis.side as LayerSide
          } else {
            type = detectLayerType(fileName)
            side = detectLayerSide(fileName, type)
          }
          const color = getDefaultLayerColorByType(type, side)

          convertLayerUnits(parsedLayer, targetUnit)

          const layerEntry: LayerEntry = {
            id: generateId(),
            name: fileName.replace(/\.[^.]+$/, ''),
            fileName,
            rawContent: svgSourceContent,
            originalContent: content,
            parsedLayer,
            svgData,
            color,
            visible: true,
            opacity: getDefaultOpacityByType(type),
            type,
            side,
            designId,
            variantRotationDeg: 0,
          }

          newLayers.push(layerEntry)
          result.imported++
        } catch (err) {
          result.skipped++
          const errMsg = err instanceof Error ? err.message : String(err)
          result.errors.push(`Failed: ${path} — ${errMsg}`)
        }
      }

      if (newLayers.length > 0) {
        // Post-import: auto-detect drill format by comparing against board layers
        const boardLayers = newLayers.filter(l => l.type !== 'drill' && l.type !== 'fab' && l.type !== 'other' && l.parsedLayer?.bounds)
        const drillLayers = newLayers.filter(l => l.type === 'drill' && l.parsedLayer?.bounds)

        if (boardLayers.length > 0 && drillLayers.length > 0) {
          // Calculate combined board bounds
          let boardMinX = Infinity, boardMinY = Infinity, boardMaxX = -Infinity, boardMaxY = -Infinity
          for (const bl of boardLayers) {
            const b = bl.parsedLayer.bounds!
            boardMinX = Math.min(boardMinX, b.minX)
            boardMinY = Math.min(boardMinY, b.minY)
            boardMaxX = Math.max(boardMaxX, b.maxX)
            boardMaxY = Math.max(boardMaxY, b.maxY)
          }
          const boardWidth = boardMaxX - boardMinX
          const boardHeight = boardMaxY - boardMinY

          for (let i = 0; i < newLayers.length; i++) {
            const layer = newLayers[i]
            // Rout-derived slot layers go through parseGerber, which never sets
            // drillMeta — this distinguishes them from real Excellon layers
            // without needing a separate field on LayerEntry. Their bounds are
            // a handful of small milled slots, not the whole board, so they
            // must never enter the size-mismatch auto-detect below.
            if (layer.type !== 'drill' || !layer.parsedLayer?.bounds || !layer.parsedLayer?.drillMeta) continue

            const db = layer.parsedLayer.bounds!
            const drillWidth = db.maxX - db.minX
            const drillHeight = db.maxY - db.minY

            // Check if drill bounds are significantly different from board bounds
            const sizeRatioX = boardWidth > 0 ? Math.abs(drillWidth - boardWidth) / boardWidth : 0
            const sizeRatioY = boardHeight > 0 ? Math.abs(drillHeight - boardHeight) / boardHeight : 0

            if (sizeRatioX > 0.4 || sizeRatioY > 0.4) {
              console.log(`[Drill Auto-Detect] ${layer.fileName}: drill (${drillWidth.toFixed(1)}x${drillHeight.toFixed(1)}) vs board (${boardWidth.toFixed(1)}x${boardHeight.toFixed(1)}) — attempting format detection`)

              const detected = autoDetectDrillFormat(layer.originalContent, layer.fileName, boardWidth, boardHeight)
              if (detected) {
                console.log(`[Drill Auto-Detect] ${layer.fileName}: detected ${detected.format.unit} ${detected.format.integer}:${detected.format.decimal} ${detected.format.zeroSuppression}`)

                // Re-generate normalized Excellon with explicit decimal points
                const normalizedContent = generateNormalizedExcellon(layer.originalContent, detected.format)

                // Re-parse with our parser using the correct format
                const correctedParsed = detected.parsed
                if (correctedParsed.drillMeta) correctedParsed.drillMeta.source = 'auto-detect'
                convertLayerUnits(correctedParsed, targetUnit)

                // Re-generate SVG using normalized content (tracespace will parse decimals correctly)
                let newSvgData: GerberSvgResult | null = null
                try {
                  newSvgData = await gerberToSvg(normalizedContent)
                  if (!newSvgData || newSvgData.isEmpty || newSvgData.error) {
                    console.warn('Re-generated SVG failed for', layer.fileName, '- using fallback')
                    newSvgData = createFallbackSvg(correctedParsed, layer.fileName)
                  }
                } catch (svgErr) {
                  console.warn('Re-generated SVG failed for', layer.fileName, ':', svgErr)
                  newSvgData = createFallbackSvg(correctedParsed, layer.fileName)
                }

                newLayers[i] = {
                  ...layer,
                  rawContent: normalizedContent,
                  parsedLayer: correctedParsed,
                  svgData: newSvgData,
                }
              }
            }
          }
        }

        set(state => ({ layers: [...state.layers, ...newLayers], packCandidates: null, selectedCandidateId: null }))
        const firstDrillLayer = newLayers.find(l => l.type === 'drill')
        if (firstDrillLayer) maybeSyncExportDrillFormat(get, set, firstDrillLayer.parsedLayer?.drillMeta)
        void get().rebuildBoardView()
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      result.errors.push(`Failed to read RAR file: ${errMsg}`)
    }

    return result
  },

  alignDrillLayersToBoard: async () => {
    const { layers, outputFormat, activeDesignId } = get()
    // Scoped to the active design — the hole↔pad vector vote below assumes
    // every drill hit and copper pad belongs to the SAME board. Mixing in
    // another design's layers would either fail the ≥50% match gate or,
    // worse, land the vote on a wrong-but-plausible bucket.
    const designLayers = activeDesignId ? layers.filter(l => l.designId === activeDesignId) : layers
    const drillLayers = designLayers.filter(l => l.type === 'drill' && l.parsedLayer?.bounds)
    const boardLayers = designLayers.filter(l => l.type !== 'drill' && l.type !== 'fab' && l.type !== 'other' && l.parsedLayer?.bounds)

    if (drillLayers.length === 0 || boardLayers.length === 0) return

    // Drills register to pads, which live on copper — silkscreen or outline
    // content extending past the copper (e.g. text below the board edge)
    // would skew a whole-board bounding box and shift every hole off its
    // pad. Center on the copper layers when any exist.
    const copperLayers = boardLayers.filter(l => l.type === 'copper')
    const referenceLayers = copperLayers.length > 0 ? copperLayers : boardLayers

    // Copper pad centres (every flash on a copper layer), for exact offset
    // recovery: plated holes are concentric with their pads, so matching the
    // hole pattern against the pad pattern recovers the true origin offset
    // rather than approximating it from bounding-box centres.
    const padCenters = copperLayers.flatMap(cl => resolvedFlashCenters(cl.parsedLayer.commands))

    // Calculate combined board bounds
    let boardMinX = Infinity, boardMinY = Infinity, boardMaxX = -Infinity, boardMaxY = -Infinity
    for (const bl of referenceLayers) {
      const b = bl.parsedLayer.bounds!
      boardMinX = Math.min(boardMinX, b.minX)
      boardMinY = Math.min(boardMinY, b.minY)
      boardMaxX = Math.max(boardMaxX, b.maxX)
      boardMaxY = Math.max(boardMaxY, b.maxY)
    }
    const boardCenterX = (boardMinX + boardMaxX) / 2
    const boardCenterY = (boardMinY + boardMaxY) / 2

    const { panel: dummyPanel, config: dummyConfig } = identityPanelContext()

    const updatedLayers = [...layers]

    for (const dl of drillLayers) {
      let parsed = { ...dl.parsedLayer }
      let b = parsed.bounds!
      
      const drillWidth = b.maxX - b.minX
      const drillHeight = b.maxY - b.minY
      const boardWidth = boardMaxX - boardMinX
      const boardHeight = boardMaxY - boardMinY

      // Auto-analyze format if drill bounds are drastically different from board bounds (>40% difference)
      if (Math.abs(drillWidth - boardWidth) / boardWidth > 0.4 || Math.abs(drillHeight - boardHeight) / boardHeight > 0.4) {
        console.log(`[Drill Align] ${dl.fileName}: drill (${drillWidth.toFixed(2)}x${drillHeight.toFixed(2)}) vs board (${boardWidth.toFixed(2)}x${boardHeight.toFixed(2)}). Auto-detecting format...`)
        
        const detected = autoDetectDrillFormat(dl.originalContent, dl.fileName, boardWidth, boardHeight)
        if (detected) {
          console.log(`[Drill Align] Detected format: ${detected.format.unit} ${detected.format.integer}:${detected.format.decimal} ${detected.format.zeroSuppression}`)
          parsed = detected.parsed
          if (parsed.drillMeta) parsed.drillMeta.source = 'auto-detect'
          b = parsed.bounds!
        } else {
          console.log(`[Drill Align] No suitable format found. Keeping original.`)
        }
      }

      // Exact offset first: vote the hole pattern against the copper pad
      // pattern (see drill-alignment.ts). Falls back to bounding-box centre
      // alignment only when no translation earns enough support (e.g. an
      // NPTH-only drill whose holes have no matching pads).
      const holes = resolvedFlashCenters(parsed.commands)
      const exact = recoverDrillOffset(holes, padCenters)

      let dx: number, dy: number
      if (exact) {
        dx = exact.offsetX
        dy = exact.offsetY
        console.log(`[Drill Align] ${dl.fileName}: exact offset recovered (${dx.toFixed(3)}, ${dy.toFixed(3)}) mm — ${exact.matchedHoles}/${exact.totalHoles} holes matched to copper pads`)
      } else {
        const drillCenterX = (b.minX + b.maxX) / 2
        const drillCenterY = (b.minY + b.maxY) / 2
        dx = boardCenterX - drillCenterX
        dy = boardCenterY - drillCenterY
        console.log(`[Drill Align] ${dl.fileName}: no exact pad match — falling back to copper-bounds centre alignment (${dx.toFixed(3)}, ${dy.toFixed(3)}) mm`)
      }

      // Shift commands
      parsed.commands = parsed.commands.map(cmd => {
        const newCoord = { ...cmd.coordinate }
        if (newCoord.x !== undefined) newCoord.x += dx
        if (newCoord.y !== undefined) newCoord.y += dy
        return { ...cmd, coordinate: newCoord }
      })

      // Shift slots (Excellon G85) — live outside `commands` (see
      // `DrillSlot`'s own docs), so the map above never touches them; without
      // this a slot would stay at its pre-alignment position while every
      // hole around it moved, throwing the two out of registration.
      if (parsed.drillSlots) {
        parsed.drillSlots = parsed.drillSlots.map(slot => ({
          ...slot,
          start: { x: slot.start.x + dx, y: slot.start.y + dy },
          end: { x: slot.end.x + dx, y: slot.end.y + dy },
        }))
      }

      // Shift bounds
      parsed.bounds = {
        minX: b.minX + dx,
        maxX: b.maxX + dx,
        minY: b.minY + dy,
        maxY: b.maxY + dy
      }

      // Generate new raw
      const newRaw = serializeParsedDrillToExcellon(parsed)

      const newSvgData = await gerberToSvg(newRaw)

      const idx = updatedLayers.findIndex(l => l.id === dl.id)
      if (idx !== -1) {
        updatedLayers[idx] = {
          ...dl,
          rawContent: newRaw,
          parsedLayer: parsed,
          svgData: newSvgData
        }
      }
    }

    // Drill alignment shifts drill geometry, which mouse-bite placement and the
    // routing preview are both measured against — replan rather than keep it.
    // The meta-panel array's tiled drill positions are measured against the
    // same geometry, so they're cleared here too.
    set({
      layers: updatedLayers,
      routingResult: null, routingStale: false, routingFocus: null, gcodeFiles: null, boardContour: null,
      panelArrayFiles: null,
    })
    void get().rebuildBoardView()
  },

  // Panel config
  panelConfig: {
    ...DEFAULT_PANEL_CONFIG,
    drillFormat: { ...DEFAULT_PANEL_CONFIG.drillFormat },
  },

  updatePanelConfig: (updates) => {
    set(state => {
      const newConfig = { ...state.panelConfig, ...updates }
      // Ensure drillFormat is always present
      if (!newConfig.drillFormat) {
        newConfig.drillFormat = { ...DEFAULT_PANEL_CONFIG.drillFormat }
      }
      // Panel geometry drives routing geometry, so any config change makes an
      // existing routing plan potentially wrong — flag it rather than silently
      // keeping stale tool paths that would export as a fabrication file.
      //
      // ⚠ Gaps additionally invalidate the PACK CANDIDATES: the packer bakes
      // gapX/gapY into each placement (inflate-then-pack), so a candidate
      // found at the old gap describes spacing the new config no longer
      // asks for. Same reasoning as `updateDesign`/`updateMaterialSize`,
      // which already null these — gaps were simply missed there.
      const gapChanged =
        (updates.gapX !== undefined && updates.gapX !== state.panelConfig.gapX) ||
        (updates.gapY !== undefined && updates.gapY !== state.panelConfig.gapY)
      return {
        panelConfig: newConfig,
        routingStale: true,
        ...(gapChanged ? { packCandidates: null, selectedCandidateId: null } : {}),
      }
    })
    // NOTE: Panel computation is now only triggered when user clicks "Create Panel" button
  },

  resetPanelConfig: () => {
    set({
      panelConfig: {
        ...DEFAULT_PANEL_CONFIG,
        drillFormat: { ...DEFAULT_PANEL_CONFIG.drillFormat },
      },
      // Full reset — drop the routing plan entirely rather than mark it stale.
      routingResult: null,
      routingStale: false,
      routingFocus: null,
      gcodeFiles: null,
      boardContour: null,
      // Tooling-hole/drill-format settings changed, which the meta-panel
      // array's tiled drill file depends on — the array LAYOUT (cols/rows)
      // doesn't depend on panelConfig though, so only the generated files
      // need dropping here, not panelArrayResult itself.
      panelArrayFiles: null,
    })
    // NOTE: Panel computation is now only triggered when user clicks "Create Panel" button
  },

  // Panel info
  panelInfo: {
    pcbName: 'PCB-001',
    customerRef: 'Customer Name',
    date: formatPanelDate(),
    revision: '1.0',
    layers: 'GTL GBL GTS GBS GTO GBO',
  },

  updatePanelInfo: (updates) => {
    set(state => ({
      panelInfo: { ...state.panelInfo, ...updates },
    }))
  },

  // Output format (default 4.6 to handle boards up to 9999mm)
  outputFormat: { ...DEFAULT_OUTPUT_FORMAT },

  updateOutputFormat: (updates) => {
    set(state => ({
      outputFormat: { ...state.outputFormat, ...updates },
    }))
  },

  resetOutputFormat: () => {
    set({ outputFormat: { ...DEFAULT_OUTPUT_FORMAT } })
  },

  // Panel result
  panelResult: null,

  computePanelResult: () => {
    const { layers, panelConfig, activeDesignId, camMode } = get()

    // ⚠ MULTI MODE NEVER GRID-PANELIZES. Every "rebuild the panel" call site
    // funnels through here — Panel Config's button, Info & Export's "Apply
    // Changes to Gerber", and the Routing tab's one-click fixes that carry
    // `rebuildPanel: true`. Before this branch existed, all three silently
    // replaced a packed multi-design panel with a single-design grid panel.
    //
    // The multi-mode answer is RE-PACK, not "re-apply the stored candidate":
    // a candidate's placements have the gaps BAKED IN (the packer's
    // inflate-then-pack technique), while `validateRouting` measures gap
    // conflicts against `panelConfig.gapX/gapY`. So the routing gap fix —
    // which patches those config gaps and then rebuilds — must actually
    // re-run the packer at the new gap, or the "fixed" panel would still
    // carry the old, too-tight spacing while the pre-flight check reports
    // clean. That is a fabrication-scrap risk, not a cosmetic mismatch.
    if (camMode === 'multi') {
      const { designs, materialSizeMm, panelInfo, packCandidates, selectedCandidateId } = get()
      const clearAll = {
        panelResult: null, routingResult: null, routingStale: false, routingFocus: null,
        gcodeFiles: null, boardContour: null, panelArrayResult: null, panelArrayFiles: null,
      }

      const specs = buildPackItemSpecs(designs, layers)
      if (specs.length === 0) {
        set({ ...clearAll, packCandidates: null, selectedCandidateId: null, packInfeasible: [] })
        return
      }

      const packable = packableMaterialSize(materialSizeMm, panelConfig)
      const packed = findPackCandidates(specs, {
        materialWidthMm: packable.widthMm,
        materialHeightMm: packable.heightMm,
        gapXMm: panelConfig.gapX,
        gapYMm: panelConfig.gapY,
      })

      if (packed.candidates.length === 0) {
        // Never keep the old panel against a config the packer can no longer
        // satisfy — the Designs tab's "No layout fits" banner surfaces why.
        set({ ...clearAll, packCandidates: [], selectedCandidateId: null, packInfeasible: packed.infeasible })
        return
      }

      // Preserve the user's LAYOUT CHOICE across a re-pack, but by
      // (strategy, fillOrder) rather than raw id: `PackCandidate.id` ends in
      // a positional index that shifts as the candidate set changes, so
      // matching on it would silently pick an unrelated layout.
      const previous = packCandidates?.find(c => c.id === selectedCandidateId)
      const chosen = (previous && packed.candidates.find(c => c.strategy === previous.strategy && c.fillOrder === previous.fillOrder))
        ?? packed.candidates[0]

      set({
        ...clearAll,
        panelResult: buildPackedPanelResult(chosen, designs, layers, panelConfig, panelInfo),
        packCandidates: packed.candidates,
        selectedCandidateId: chosen.id,
        packInfeasible: packed.infeasible,
      })
      return
    }

    // --- Single mode: the classic one-board grid path, unchanged. ---
    // Always panelizes the ACTIVE design — with a hidden design still loaded
    // from a previous multi-mode session, sizing from every design's layers
    // combined would silently pick whichever design's outline `.find()`
    // happened to see first.
    const designLayers = activeDesignId ? layers.filter(l => l.designId === activeDesignId) : layers
    if (designLayers.length === 0) {
      set({ panelResult: null, routingResult: null, routingStale: false, routingFocus: null, gcodeFiles: null, boardContour: null, panelArrayResult: null, panelArrayFiles: null, packCandidates: null, selectedCandidateId: null })
      return
    }

    // Find the layer that sizes the PCB — explicit 'outline' first, else the
    // largest visible layer (handles non-standard exports like Eagle's
    // "profile.gbr" that don't declare themselves as an outline). Shared with
    // the exporter and the G-code/array actions via `resolveDesignGeometry`
    // so all four agree on the same datum — see that function's own docs.
    const geometry = resolveDesignGeometry(designLayers)

    if (!geometry) {
      set({ panelResult: null, routingResult: null, routingStale: false, routingFocus: null, gcodeFiles: null, boardContour: null, panelArrayResult: null, panelArrayFiles: null, packCandidates: null, selectedCandidateId: null })
      return
    }

    const pcbWidth = geometry.widthMm
    const pcbHeight = geometry.heightMm

    if (pcbWidth <= 0 || pcbHeight <= 0) {
      set({ panelResult: null, routingResult: null, routingStale: false, routingFocus: null, gcodeFiles: null, boardContour: null, panelArrayResult: null, panelArrayFiles: null, packCandidates: null, selectedCandidateId: null })
      return
    }

    const panelInfo = get().panelInfo
    const result = computePanel(pcbWidth, pcbHeight, panelConfig, panelInfo)
    // computePanel's 4-arg (pre-multi-design) signature always stamps the
    // internal SINGLE_DESIGN_ID sentinel on every placement/design summary —
    // it has no way to know the real design id. Grid mode always panelizes
    // exactly ONE design (the active one), so remap the sentinel to that
    // design's REAL id: `boardViewsByDesign`/`generateMergedPanelizedGerber`/
    // routing's per-design context are all keyed by real design ids, and a
    // panel still carrying the sentinel would silently match none of them —
    // confirmed live: with 2+ designs loaded, clicking "Create Panel" (or any
    // one-click fix with rebuildPanel:true) while on the Grid Layout tab
    // produced a correctly-SIZED panel that rendered as bare, contentless
    // rectangles, because no `boardViewsByDesign` entry is ever keyed
    // `'default'`. `activeDesignId` is guaranteed non-null here — `designLayers`
    // above only has entries when it is (the `layers.filter(l => l.designId
    // === activeDesignId)` scoping a few lines up).
    if (activeDesignId) {
      result.placements = result.placements.map(p => ({ ...p, designId: activeDesignId }))
      result.designs = result.designs.map(d => ({ ...d, designId: activeDesignId }))
    }

    // Generate descriptive layer names for panel info (e.g., "Top Copper Bottom Copper Top Mask")
    const descriptiveLayerNames = designLayers
      .filter(l => l.visible && l.type !== 'outline' && l.type !== 'drill' && l.type !== 'fab')
      .map(l => {
        // Generate descriptive layer name based on type and side
        if (l.type === 'copper') {
          return l.side === 'top' ? 'Top Copper' : l.side === 'bottom' ? 'Bottom Copper' : 'Copper'
        } else if (l.type === 'mask') {
          return l.side === 'top' ? 'Top Mask' : l.side === 'bottom' ? 'Bottom Mask' : 'Mask'
        } else if (l.type === 'silk') {
          return l.side === 'top' ? 'Top Silk' : l.side === 'bottom' ? 'Bottom Silk' : 'Silk'
        } else if (l.type === 'paste') {
          return l.side === 'top' ? 'Top Paste' : l.side === 'bottom' ? 'Bottom Paste' : 'Paste'
        } else {
          return l.name.toUpperCase() // Fallback to original name for other types
        }
      })
      .join(' ') // Join with spaces

    // Update panel info with descriptive layer names using set()
    if (descriptiveLayerNames) {
      set(state => ({
        panelInfo: { ...state.panelInfo, layers: descriptiveLayerNames }
      }))
    }

    // Generate layer labels for the panel bottom rib
    const layerLabels: LayerLabelInfo[] = layers
      .filter(l => l.visible && l.type !== 'outline' && l.type !== 'drill' && l.type !== 'fab')
      .map(l => {
        // Generate descriptive layer name based on type and side
        let descriptiveName: string
        if (l.type === 'copper') {
          descriptiveName = l.side === 'top' ? 'Top Copper' : l.side === 'bottom' ? 'Bottom Copper' : 'Copper'
        } else if (l.type === 'mask') {
          descriptiveName = l.side === 'top' ? 'Top Mask' : l.side === 'bottom' ? 'Bottom Mask' : 'Mask'
        } else if (l.type === 'silk') {
          descriptiveName = l.side === 'top' ? 'Top Silk' : l.side === 'bottom' ? 'Bottom Silk' : 'Silk'
        } else if (l.type === 'paste') {
          descriptiveName = l.side === 'top' ? 'Top Paste' : l.side === 'bottom' ? 'Bottom Paste' : 'Paste'
        } else {
          descriptiveName = l.name.toUpperCase()
        }

        return {
          name: descriptiveName,
          type: l.type,
          side: l.side,
        }
      })

    if (layerLabels.length > 0) {
      const labelTexts = generateLayerLabels(
        layerLabels,
        result.panelWidth,
        result.panelHeight,
        panelConfig,
        pcbWidth,
        pcbHeight,
        result.placements,
        result.toolingHoles,
        result.fiducials
      )

      // Append layer labels to the panel result's info texts
      result.infoTexts = [...result.infoTexts, ...labelTexts]
    }


    // A fresh panel invalidates any existing routing plan outright: tool paths
    // are panel-absolute, so keeping them would let a .rou export carry the
    // PREVIOUS panel's coordinates — the worst failure this feature can produce.
    set({ panelResult: result, routingResult: null, routingStale: false, routingFocus: null, gcodeFiles: null, boardContour: null, panelArrayResult: null, panelArrayFiles: null })
  },

  // View state
  targetUnit: 'mm',
  setTargetUnit: (unit) => {
    // Layer geometry is about to be rescaled in place, so any planned routing
    // is measured against dimensions that no longer exist.
    set({ targetUnit: unit, routingResult: null, routingStale: false, routingFocus: null, gcodeFiles: null, boardContour: null, panelArrayResult: null, panelArrayFiles: null })
    // Convert all layers to new unit
    const { layers } = get()
    for (const layer of layers) {
      convertLayerUnits(layer.parsedLayer, unit)
    }
    // NOTE: Panel computation is now only triggered when user clicks "Create Panel" button
  },

  // Board view (composited PCB stack-up via @tracespace/core)
  boardView: null,
  boardViewsByDesign: {},
  boardViewSide: 'top',
  viewMode: 'board',
  setViewMode: (mode) => set({ viewMode: mode }),
  setBoardViewSide: (side) => set({ boardViewSide: side }),
  rebuildBoardView: async () => {
    const { layers, activeDesignId, designs } = get()
    // Scoped to the active design — this is the single-PCB (non-panel) view,
    // so compositing every design's layers together would mix, e.g., one
    // design's copper with another's silkscreen into one nonsensical board.
    const designLayers = activeDesignId ? layers.filter(l => l.designId === activeDesignId) : layers
    if (designLayers.length === 0) {
      set({ boardView: null, boardViewsByDesign: {} })
      return
    }
    const files = designLayers.map(l => ({ filename: l.fileName, contents: l.rawContent, type: l.type, side: l.side }))
    console.log('[rebuildBoardView] files:', files.map(f => `${f.filename} type=${f.type} side=${f.side}`))
    const board = await gerberRenderBoardView(files)
    console.log('[rebuildBoardView] result:', board.error ?? `ok (top=${board.topFragment.length} bot=${board.bottomFragment.length})`)

    // Auto-switch to the side that has more meaningful content.
    // If the top fragment is tiny (just a background rect + drills) but the
    // bottom has real content, switch to Bottom view automatically.
    const topContentScore = (board.topFragment.match(/<path|<circle|<rect(?! x="|<use)/g) || []).length
    const botContentScore = (board.bottomFragment.match(/<path|<circle|<rect(?! x="|<use)/g) || []).length
    console.log('[rebuildBoardView] content score top:', topContentScore, 'bottom:', botContentScore)

    // Count top vs bottom copper/silk layers
    const topLayers = designLayers.filter(l => (l.type === 'copper' || l.type === 'silk' || l.type === 'mask') && l.side === 'top')
    const botLayers = designLayers.filter(l => (l.type === 'copper' || l.type === 'silk' || l.type === 'mask') && l.side === 'bottom')

    let newSide: 'top' | 'bottom' = get().boardViewSide
    if (topLayers.length === 0 && botLayers.length > 0) {
      newSide = 'bottom'
    } else if (botLayers.length === 0 && topLayers.length > 0) {
      newSide = 'top'
    }

    // Per-design composites for the panel view's multi-design rendering
    // (Stage 5 of the multi-design plan) — reuses the active design's
    // composite just computed above rather than rendering it twice.
    const otherDesigns = designs.filter(d => d.id !== activeDesignId)
    const otherBoards = await Promise.all(otherDesigns.map(async d => {
      const dLayers = layers.filter(l => l.designId === d.id)
      if (dLayers.length === 0) return null
      const dFiles = dLayers.map(l => ({ filename: l.fileName, contents: l.rawContent, type: l.type, side: l.side }))
      const dBoard = await gerberRenderBoardView(dFiles)
      return { designId: d.id, board: dBoard }
    }))
    const boardViewsByDesign: Record<string, BoardView> = {}
    if (activeDesignId) boardViewsByDesign[activeDesignId] = board
    for (const entry of otherBoards) {
      if (entry) boardViewsByDesign[entry.designId] = entry.board
    }

    set({ boardView: board, boardViewSide: newSide, boardViewsByDesign })
  },

  hoveredLayerId: null,
  setHoveredLayerId: (id) => set({ hoveredLayerId: id }),

  boardColor: 'Green',
  setBoardColor: (color) => set({ boardColor: color }),

  // DFM — the report lives in the store (like panelResult) so it survives tab
  // switches. Deliberately only recomputed on an explicit runDfmCheck() call,
  // never automatically on layer/config change, matching how panel computation
  // is only triggered by "Create Panel".
  dfmReport: null,
  dfmRunning: false,
  dfmTemplateId: null,
  setDfmTemplateId: (id) => set({ dfmTemplateId: id }),
  dfmContext: { boardThicknessMm: 1.6 },
  updateDfmContext: (updates) => set(state => ({ dfmContext: { ...state.dfmContext, ...updates } })),
  dfmFocus: null,
  setDfmFocus: (p) => set({ dfmFocus: p }),

  runDfmCheck: async (rules) => {
    const { layers, panelResult, dfmContext, activeDesignId } = get()
    // Scoped to the active design — DFM checks one board at a time, never an
    // aggregate across every design loaded into the tool.
    const designLayers = activeDesignId ? layers.filter(l => l.designId === activeDesignId) : layers
    // LayerEntry already carries exactly the four fields DfmLayerInput needs,
    // so no adapter is required (the order flow's DetectedLayer matches too).
    const input: DfmLayerInput[] = designLayers.map(l => ({
      fileName: l.fileName,
      type: l.type,
      side: l.side,
      parsedLayer: l.parsedLayer,
    }))
    // Panel outer size is only meaningful once a panel has been computed; a
    // panel can legitimately exceed single-board limits, so it's checked
    // separately rather than folded into the board-size check.
    const context: DfmContext = {
      ...dfmContext,
      ...(panelResult
        ? { panelWidthMm: panelResult.panelWidth, panelHeightMm: panelResult.panelHeight }
        : {}),
    }

    set({ dfmRunning: true })
    try {
      // Copper clearance is the only check that can't be computed inline — it
      // needs tracespace's plot tree and is heavy enough to belong in the
      // worker. Everything else stays synchronous inside runDfm.
      const copperLayers = designLayers.filter(l => l.type === 'copper')
      const spacing = await Promise.all(
        copperLayers.map(l =>
          checkCopperSpacing({
            layerName: l.fileName,
            contents: l.rawContent,
            minSpacingMm: rules.minCopperSpacingMm.standard,
          })
        )
      )
      set({ dfmReport: runDfm(input, context, rules, { spacing }), dfmFocus: null })
    } finally {
      set({ dfmRunning: false })
    }
  },
  clearDfmReport: () => set({ dfmReport: null, dfmFocus: null }),

  // Routing
  routingConfig: { ...DEFAULT_ROUTING_CONFIG },
  updateRoutingConfig: (updates) =>
    // Shallow merge is safe *because* RoutingConfig is flat. If you ever add a
    // nested object you must re-spread it here AND in resetRoutingConfig —
    // that is the PanelConfig.drillFormat trap. Keep the config flat instead.
    set(state => ({ routingConfig: { ...state.routingConfig, ...updates }, routingStale: true })),
  resetRoutingConfig: () =>
    set({ routingConfig: { ...DEFAULT_ROUTING_CONFIG }, routingStale: true }),
  routingResult: null,
  routingStale: false,
  boardContour: null,
  routingGenerating: false,
  generateRouting: async () => {
    const { panelResult, panelConfig, routingConfig, layers, activeDesignId } = get()
    if (!panelResult) {
      set({ routingResult: null, routingStale: false, boardContour: null, gcodeFiles: null })
      return
    }

    // One outline layer + resolved mode PER DESIGN — a multi-design panel's
    // placements are not all the same board, so tracing only the active
    // design's outline (as this action did pre-Stage-7) and applying it to
    // every OTHER design's placements too would be a real fabrication
    // defect, not a preview glitch. `panel.designs` (not `layers` grouped
    // ad hoc) is the source of truth for which designs actually have
    // placements in THIS panel.
    const designIds = panelResult.designs.map(d => d.designId)
    const outlineLayerByDesign = new Map<string, LayerEntry | undefined>()
    for (const designId of designIds) {
      outlineLayerByDesign.set(designId, findOutlineBoundsLayer(layers.filter(l => l.designId === designId)))
    }

    const needsTrace = designIds.filter(id => {
      const outlineLayer = outlineLayerByDesign.get(id)
      return outlineLayer && resolveOutlineMode(routingConfig.pcbOutlineMode, outlineLayer.parsedLayer ?? null) === 'contour'
    })

    let boardContourByDesign = new Map<string, BoardContour>()
    if (needsTrace.length > 0) {
      set({ routingGenerating: true })

      let unionMinX = Infinity, unionMinY = Infinity, unionMaxX = -Infinity, unionMaxY = -Infinity
      for (const l of layers) {
        const b = l.parsedLayer?.bounds
        if (!b) continue
        unionMinX = Math.min(unionMinX, b.minX); unionMinY = Math.min(unionMinY, b.minY)
        unionMaxX = Math.max(unionMaxX, b.maxX); unionMaxY = Math.max(unionMaxY, b.maxY)
      }
      const unionBoundsMm = Number.isFinite(unionMinX) ? { minX: unionMinX, minY: unionMinY, maxX: unionMaxX, maxY: unionMaxY } : null

      // Traced in parallel — each design's trace is fully independent.
      const traced = await Promise.all(needsTrace.map(async designId => {
        const outlineLayer = outlineLayerByDesign.get(designId)!
        const contour = await traceBoardContour(
          { fileName: outlineLayer.fileName, contents: outlineLayer.rawContent },
          { toleranceMm: routingConfig.contourToleranceMm, unionBoundsMm, sourceFileName: outlineLayer.fileName }
        )
        return [designId, contour] as const
      }))

      // Reference-identity staleness guard. Every mutating store action
      // replaces `layers`/`panelResult` wholesale (never mutates in place),
      // so if either has moved on while this awaited the traces, the layer
      // set or panel this was planned against no longer exists — discard
      // rather than plan routing against geometry that isn't current
      // anymore (the same "never keep a stale plan" discipline as every
      // other routingResult invalidation site in this file).
      if (get().layers !== layers || get().panelResult !== panelResult) {
        set({ routingGenerating: false })
        return
      }

      boardContourByDesign = new Map(traced)
    }

    const designsCtx: Record<string, { outlineLayer: GerberLayer | null; boardContour: BoardContour | null; outlineBoundsMm: { minX: number; minY: number } | null }> = {}
    for (const designId of designIds) {
      const outlineLayer = outlineLayerByDesign.get(designId)
      designsCtx[designId] = {
        outlineLayer: outlineLayer?.parsedLayer ?? null,
        boardContour: boardContourByDesign.get(designId) ?? null,
        outlineBoundsMm: outlineLayer?.parsedLayer?.bounds
          ? { minX: outlineLayer.parsedLayer.bounds.minX, minY: outlineLayer.parsedLayer.bounds.minY }
          : null,
      }
    }

    // The single `boardContour` store field only ever drove the VIEWER's
    // contour-outline-rect preview for ONE board (see gerber-viewer.tsx) —
    // kept pointed at the active design's own trace so that preview is
    // unaffected; other designs' route overlays render as plain lines
    // without the special contour clip treatment, a documented cosmetic gap
    // (routing itself is fully correct for every design regardless).
    const activeBoardContour = activeDesignId ? boardContourByDesign.get(activeDesignId) ?? null : null

    set({
      routingResult: planRouting(panelResult, panelConfig, routingConfig, { designs: designsCtx }),
      boardContour: activeBoardContour,
      routingStale: false,
      routingFocus: null,
      routingGenerating: false,
      // Any G-code already generated referred to the PREVIOUS plan — regenerating
      // routing must invalidate it exactly like the routing plan itself gets
      // invalidated by a panel change, or a download could silently carry stale
      // tool paths.
      gcodeFiles: null,
    })
  },
  clearRoutingResult: () => set({ routingResult: null, routingStale: false, routingFocus: null, gcodeFiles: null, boardContour: null }),
  routingFocus: null,
  setRoutingFocus: (p) => set({ routingFocus: p }),

  // G-code
  gcodeContext: { ...DEFAULT_GCODE_CONTEXT },
  updateGcodeContext: (updates) =>
    set(state => ({ gcodeContext: { ...state.gcodeContext, ...updates } })),
  resetGcodeContext: () => set({ gcodeContext: { ...DEFAULT_GCODE_CONTEXT } }),
  gcodeFiles: null,
  generateGcodeFilesAction: () => {
    const { routingResult, gcodeContext, layers, panelResult, panelInfo } = get()
    if (!routingResult || !panelResult) {
      set({ gcodeFiles: null })
      return
    }
    // Every design's own drill hits, each against its own datum/placements
    // then merged by diameter — panelResult.designs is the source of truth
    // for which designs actually have placements on THIS panel (matching
    // routing's own per-design scoping, not a single active design).
    const drillHoleGroups = collectAllDesignsDrillHoles(layers, panelResult)
      .map(g => ({ diameterMm: g.diameterMm, holes: g.holes }))
    const drillSlotGroups = collectAllDesignsDrillSlots(layers, panelResult)
    const partNumber = (panelInfo?.pcbName || 'PCB').replace(/[<>:"/\\|?*\s]+/g, '_')
    set({ gcodeFiles: buildGcodeFiles(routingResult, drillHoleGroups, partNumber, gcodeContext, drillSlotGroups) })
  },
  clearGcodeFiles: () => set({ gcodeFiles: null }),

  // Meta-panelization (multi-panel-array CNC batch)
  panelArrayConfig: { ...DEFAULT_PANEL_ARRAY_CONFIG },
  updatePanelArrayConfig: (updates) =>
    set(state => ({ panelArrayConfig: { ...state.panelArrayConfig, ...updates } })),
  resetPanelArrayConfig: () =>
    set({ panelArrayConfig: { ...DEFAULT_PANEL_ARRAY_CONFIG }, panelArrayResult: null, panelArrayFiles: null }),
  panelArrayResult: null,
  panelArrayFiles: null,
  generatePanelArrayFilesAction: () => {
    const { panelResult, panelArrayConfig, layers, panelConfig, gcodeContext, panelInfo, outputFormat } = get()
    if (!panelResult) {
      set({ panelArrayResult: null, panelArrayFiles: null })
      return
    }
    const array = computePanelArray(panelResult.panelWidth, panelResult.panelHeight, panelArrayConfig)
    if (!array) {
      set({ panelArrayResult: null, panelArrayFiles: null })
      return
    }

    // Every design's own drill hits, each against its own datum/placements
    // then merged by diameter — same reasoning as generateGcodeFilesAction.
    const componentHoleGroups = collectAllDesignsDrillHoles(layers, panelResult)
    const componentSlotGroups = collectAllDesignsDrillSlots(layers, panelResult)

    // Tooling/reference holes join the same {diameterMm, holes} shape so they
    // ride along in the same tiled drill program as the component holes —
    // each array copy still needs its own pinning holes for its LATER,
    // separate per-panel routing step.
    let toolingHoleGroups: { diameterMm: number; holes: { x: number; y: number }[] }[] = []
    if (panelConfig.enableToolingHoles) {
      const byDia = new Map<number, { x: number; y: number }[]>()
      for (const h of panelResult.toolingHoles) {
        if (!byDia.has(h.diameter)) byDia.set(h.diameter, [])
        byDia.get(h.diameter)!.push({ x: h.x, y: h.y })
      }
      toolingHoleGroups = [...byDia.entries()].map(([diameterMm, holes]) => ({ diameterMm, holes }))
    }

    const mergedByDia = new Map<number, { x: number; y: number }[]>()
    for (const g of [...componentHoleGroups, ...toolingHoleGroups]) {
      if (!mergedByDia.has(g.diameterMm)) mergedByDia.set(g.diameterMm, [])
      mergedByDia.get(g.diameterMm)!.push(...g.holes)
    }
    const mergedHoleGroups = [...mergedByDia.entries()]
      .sort(([a], [b]) => a - b)
      .map(([diameterMm, holes]) => ({ diameterMm, holes }))

    const tiledHoleGroups = tileHolesAcrossArray(mergedHoleGroups, array)
    const tiledSlotGroups = tileSlotsAcrossArray(componentSlotGroups, array)

    const partNumber = (panelInfo?.pcbName || 'PCB').replace(/[<>:"/\\|?*\s]+/g, '_')

    const borderMarksGerber = generateBorderMarksGerber(array, panelArrayConfig, outputFormat)
    const drillContent = generateMetaPanelDrill(
      tiledHoleGroups, tiledSlotGroups, panelConfig.drillFormat, array
    )

    const markPaths = generateBorderMarkPaths(array)
    const gcodeFiles = generateMetaPanelGcodeFiles(
      markPaths,
      tiledHoleGroups,
      partNumber,
      gcodeContext,
      panelArrayConfig.markCutDepthMm,
      tiledSlotGroups
    )

    set({
      panelArrayResult: array,
      panelArrayFiles: {
        borderMarksGerberFilename: `${partNumber}_Border_Marks.gbr`,
        borderMarksGerber,
        drillFilename: `${partNumber}_MetaPanel_Drill.drl`,
        drillContent,
        gcodeFiles,
      },
    })
  },
  clearPanelArrayFiles: () => set({ panelArrayResult: null, panelArrayFiles: null }),

  // Panelization templates
  panelTemplateId: null,
  setPanelTemplateId: (id) => set({ panelTemplateId: id }),
  applyPanelTemplate: (settings, sections) => {
    set(state => {
      const patch: Partial<AppState> = {}
      if (sections.includes('panel')) {
        // Grid layout (rows/cols/gapX/gapY) and xyOverrides are never part of
        // a template's `panel` section — spreading over the CURRENT
        // panelConfig (not a fresh default) is what preserves them.
        patch.panelConfig = { ...state.panelConfig, ...settings.panel }
        // A stale routing plan carrying the previous panel geometry is a
        // real fabrication-scrap risk — same discipline as updatePanelConfig.
        patch.routingStale = true
        // No panelArrayStale flag exists (see panel-array.ts's own docs), so
        // a stale batch-drill file has no banner warning behind it — must be
        // cleared outright rather than merely flagged.
        patch.panelArrayFiles = null
      }
      if (sections.includes('output')) {
        patch.outputFormat = { ...settings.output }
        patch.panelArrayFiles = null
      }
      if (sections.includes('routing')) {
        patch.routingConfig = { ...settings.routing }
        patch.routingStale = true
      }
      if (sections.includes('gcode')) {
        patch.gcodeContext = { ...settings.gcode }
        patch.gcodeFiles = null
      }
      if (sections.includes('array')) {
        patch.panelArrayConfig = { ...settings.array }
        patch.panelArrayResult = null
        patch.panelArrayFiles = null
      }
      return patch
    })
  },

  // UI state
  activeTab: 'layers',
  setActiveTab: (tab) => set({ activeTab: tab }),
  showGrid: true,
  toggleGrid: () => set(state => ({ showGrid: !state.showGrid })),
  showCrosshair: true,
  toggleCrosshair: () => set(state => ({ showCrosshair: !state.showCrosshair })),
}))

export function detectOriginMismatch(layers: LayerEntry[]): boolean {
  const drillLayers = layers.filter(l => l.type === 'drill' && l.parsedLayer?.bounds && l.visible && (!l.svgData || !l.svgData.isEmpty))
  const boardLayers = layers.filter(l => l.type !== 'drill' && l.type !== 'fab' && l.type !== 'other' && l.parsedLayer?.bounds && l.visible && (!l.svgData || !l.svgData.isEmpty))

  if (drillLayers.length === 0 || boardLayers.length === 0) return false

  // Compute board bounds
  let boardMinX = Infinity, boardMinY = Infinity, boardMaxX = -Infinity, boardMaxY = -Infinity
  for (const bl of boardLayers) {
    const b = bl.parsedLayer.bounds!
    boardMinX = Math.min(boardMinX, b.minX)
    boardMinY = Math.min(boardMinY, b.minY)
    boardMaxX = Math.max(boardMaxX, b.maxX)
    boardMaxY = Math.max(boardMaxY, b.maxY)
  }

  // Compute drill bounds
  let drillMinX = Infinity, drillMinY = Infinity, drillMaxX = -Infinity, drillMaxY = -Infinity
  for (const dl of drillLayers) {
    const b = dl.parsedLayer.bounds!
    drillMinX = Math.min(drillMinX, b.minX)
    drillMinY = Math.min(drillMinY, b.minY)
    drillMaxX = Math.max(drillMaxX, b.maxX)
    drillMaxY = Math.max(drillMaxY, b.maxY)
  }

  // 1. Check if they do not intersect at all
  const intersectX = !(drillMaxX < boardMinX || drillMinX > boardMaxX)
  const intersectY = !(drillMaxY < boardMinY || drillMinY > boardMaxY)
  if (!intersectX || !intersectY) return true

  // 2. Check if their centers are extremely far apart (e.g. center offset > board size * 0.7)
  const boardWidth = boardMaxX - boardMinX
  const boardHeight = boardMaxY - boardMinY
  const boardSize = Math.max(boardWidth, boardHeight)

  const boardCenterX = (boardMinX + boardMaxX) / 2
  const boardCenterY = (boardMinY + boardMaxY) / 2
  const drillCenterX = (drillMinX + drillMaxX) / 2
  const drillCenterY = (drillMinY + drillMaxY) / 2

  const dx = boardCenterX - drillCenterX
  const dy = boardCenterY - drillCenterY
  const distance = Math.sqrt(dx * dx + dy * dy)

  if (distance > boardSize * 0.7) return true

  return false
}

export function detectDrillScaleMismatch(layers: LayerEntry[]): string[] {
  const drillLayers = layers.filter(l => l.type === 'drill' && l.parsedLayer?.bounds && l.visible && (!l.svgData || !l.svgData.isEmpty))
  const boardLayers = layers.filter(l => l.type !== 'drill' && l.type !== 'fab' && l.type !== 'other' && l.parsedLayer?.bounds && l.visible && (!l.svgData || !l.svgData.isEmpty))

  if (drillLayers.length === 0 || boardLayers.length === 0) return []

  // Compute board bounds
  let boardMinX = Infinity, boardMinY = Infinity, boardMaxX = -Infinity, boardMaxY = -Infinity
  for (const bl of boardLayers) {
    const b = bl.parsedLayer.bounds!
    boardMinX = Math.min(boardMinX, b.minX)
    boardMinY = Math.min(boardMinY, b.minY)
    boardMaxX = Math.max(boardMaxX, b.maxX)
    boardMaxY = Math.max(boardMaxY, b.maxY)
  }

  const boardWidth = boardMaxX - boardMinX
  const boardHeight = boardMaxY - boardMinY

  const mismatchedIds: string[] = []

  for (const dl of drillLayers) {
    const b = dl.parsedLayer.bounds!
    const drillWidth = b.maxX - b.minX
    const drillHeight = b.maxY - b.minY

    // Mismatch conditions:
    // 1. Drill bounds are much larger than board bounds (e.g. 1.3x)
    // 2. Drill bounds are extremely small compared to board (e.g. < 0.1x) but there are multiple holes (commands.length > 5)
    const tooLarge = drillWidth > boardWidth * 1.3 || drillHeight > boardHeight * 1.3
    const tooSmall = (drillWidth < boardWidth * 0.1 && drillHeight < boardHeight * 0.1) && dl.parsedLayer.commands.length > 5

    if (tooLarge || tooSmall) {
      mismatchedIds.push(dl.id)
    }
  }

  return mismatchedIds
}
