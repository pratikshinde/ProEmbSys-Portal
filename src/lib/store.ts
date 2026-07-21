/**
 * Application Store — Zustand state management for the Panelization CAM Tool
 */

import { create } from 'zustand'
import JSZip from 'jszip'
import { GerberLayer, parseGerber, parseExcellonDrill, isExcellonDrillFile, convertLayerUnits, GerberUnit, rotateGerberLayer, autoDetectDrillFormat, generateNormalizedExcellon, serializeParsedDrillToExcellon, DrillZeroSuppressionMode, DrillMeta } from './gerber-parser'
import { gerberToSvg, gerberRenderBoardView, BoardView, GerberSvgResult } from './gerber-svg'
import { recoverDrillOffset, resolvedFlashCenters } from './drill-alignment'
import { PanelConfig, PanelResult, PanelInfo, DEFAULT_PANEL_CONFIG, computePanel, OutputFormat, DEFAULT_OUTPUT_FORMAT, DrillFormatConfig, DrillFormatPreset, DrillZeroSuppression, DRILL_FORMAT_PRESETS, DEFAULT_DRILL_FORMAT, generateLayerLabels, LayerLabelInfo, generatePanelizedGerber } from './panelization-engine'
import { LayerType, LayerSide, detectLayerType, detectLayerSide } from './gerber-analysis'
import { BoardColorName } from './board-colors'

export type { LayerType, LayerSide }

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
}

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

  // UI state
  activeTab: 'layers' | 'panel' | 'info' | 'export'
  setActiveTab: (tab: 'layers' | 'panel' | 'info' | 'export') => void
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

export const useAppStore = create<AppState>((set, get) => ({
  // Layers
  layers: [],

  addLayer: async (file: File) => {
    const content = await file.text()
    const fileName = file.name
    try {
      // Use Excellon parser for drill files, Gerber parser for everything else
      let parsedLayer: GerberLayer
      if (isExcellonDrillFile(content)) {
        parsedLayer = parseExcellonDrill(content, fileName)
      } else {
        parsedLayer = parseGerber(content, fileName)
      }

      // Generate SVG using server API (also extracts TF.FileFunction if present)
      let svgData: GerberSvgResult | null = null
      try {
        svgData = await gerberToSvg(content)

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
      // fall back to filename-based heuristics. Force 'drill' if content is Excellon.
      let type: LayerType, side: LayerSide
      if (isExcellonDrillFile(content)) {
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
      const targetUnit = get().targetUnit
      convertLayerUnits(parsedLayer, targetUnit)

      // Auto-detect drill format by comparing against existing board layers
      let finalContent = content
      let finalParsed = parsedLayer
      let finalSvg = svgData
      if (type === 'drill' && parsedLayer.bounds) {
        const existingLayers = get().layers
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
      }

      set(state => ({ layers: [...state.layers, entry] }))
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
    set(state => ({
      layers: state.layers.map(l => ({ ...l, visible })),
    }))
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
    set({ layers: [], panelResult: null, boardView: null })
  },

  rotateAllLayers: async (direction: 'left' | 'right') => {
    const { layers, outputFormat } = get()
    if (layers.length === 0) return

    // 1. Rotate the parsedLayer objects
    for (const layer of layers) {
      if (layer.parsedLayer) {
        rotateGerberLayer(layer.parsedLayer, direction)
      }
    }

    // 2. Find the new global base offset so all layers stay aligned
    const outlineLayer = layers.find(l => l.type === 'outline' && l.parsedLayer?.bounds)
    let globalBaseOffset: { x: number; y: number } | undefined
    if (outlineLayer?.parsedLayer?.bounds) {
      globalBaseOffset = {
        x: -outlineLayer.parsedLayer.bounds.minX,
        y: -outlineLayer.parsedLayer.bounds.minY
      }
    } else {
      let minX = Infinity
      let minY = Infinity
      for (const l of layers) {
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
    const dummyPanel: PanelResult = {
      panelWidth: 0, panelHeight: 0, pcbWidth: 0, pcbHeight: 0, totalPCBs: 1,
      pcbPositions: [{ row: 0, col: 0, x: 0, y: 0 }],
      toolingHoles: [], fiducials: [], infoTexts: []
    }
    
    const dummyConfig: PanelConfig = { 
      ...DEFAULT_PANEL_CONFIG, 
      enableLShapeMarks: false, 
      enableToolingHoles: false, 
      enableFiducials: false,
    }

    const updatedLayers = await Promise.all(layers.map(async (layer) => {
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
    
    set({ layers: updatedLayers, panelResult: null })
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
          // Use Excellon parser for drill files, Gerber parser for everything else
          let parsedLayer: GerberLayer
          if (isExcellonDrillFile(content)) {
            parsedLayer = parseExcellonDrill(content, fileName)
          } else {
            parsedLayer = parseGerber(content, fileName)
          }

          // Generate SVG using server API (also extracts TF.FileFunction if present)
          let svgData: GerberSvgResult | null = null
          try {
            svgData = await gerberToSvg(content)

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
          // fall back to filename-based heuristics. Force 'drill' if content is Excellon.
          let type: LayerType, side: LayerSide
          if (isExcellonDrillFile(content)) {
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
            rawContent: content,
            originalContent: content,
            parsedLayer,
            svgData,
            color,
            visible: true,
            opacity: getDefaultOpacityByType(type),
            type,
            side,
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
            if (layer.type !== 'drill' || !layer.parsedLayer?.bounds) continue

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

        set(state => ({ layers: [...state.layers, ...newLayers] }))
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
          
          let parsedLayer: GerberLayer
          if (isExcellonDrillFile(content)) {
            parsedLayer = parseExcellonDrill(content, fileName)
          } else {
            parsedLayer = parseGerber(content, fileName)
          }

          let svgData: GerberSvgResult | null = null
          try {
            svgData = await gerberToSvg(content)
            if (!svgData || svgData.isEmpty || svgData.error) {
              console.warn('SVG generation failed for', fileName, '- creating fallback SVG')
              svgData = createFallbackSvg(parsedLayer, fileName)
            }
          } catch (svgErr) {
            console.warn('SVG generation failed for', fileName, '- creating fallback SVG:', svgErr)
            svgData = createFallbackSvg(parsedLayer, fileName)
          }

          let type: LayerType, side: LayerSide
          if (isExcellonDrillFile(content)) {
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
            rawContent: content,
            originalContent: content,
            parsedLayer,
            svgData,
            color,
            visible: true,
            opacity: getDefaultOpacityByType(type),
            type,
            side,
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
            if (layer.type !== 'drill' || !layer.parsedLayer?.bounds) continue

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

        set(state => ({ layers: [...state.layers, ...newLayers] }))
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
    const { layers, outputFormat } = get()
    const drillLayers = layers.filter(l => l.type === 'drill' && l.parsedLayer?.bounds)
    const boardLayers = layers.filter(l => l.type !== 'drill' && l.type !== 'fab' && l.type !== 'other' && l.parsedLayer?.bounds)

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

    const dummyPanel: PanelResult = {
      panelWidth: 0, panelHeight: 0, pcbWidth: 0, pcbHeight: 0, totalPCBs: 1,
      pcbPositions: [{ row: 0, col: 0, x: 0, y: 0 }],
      toolingHoles: [], fiducials: [], infoTexts: []
    }
    
    const dummyConfig: PanelConfig = { 
      ...DEFAULT_PANEL_CONFIG, 
      enableLShapeMarks: false, 
      enableToolingHoles: false, 
      enableFiducials: false,
    }

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

    set({ layers: updatedLayers })
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
      return { panelConfig: newConfig }
    })
    // NOTE: Panel computation is now only triggered when user clicks "Create Panel" button
  },

  resetPanelConfig: () => {
    set({
      panelConfig: {
        ...DEFAULT_PANEL_CONFIG,
        drillFormat: { ...DEFAULT_PANEL_CONFIG.drillFormat },
      }
    })
    // NOTE: Panel computation is now only triggered when user clicks "Create Panel" button
  },

  // Panel info
  panelInfo: {
    pcbName: 'PCB-001',
    customerRef: 'Customer Name',
    date: new Date().toISOString().slice(0, 10),
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
    const { layers, panelConfig } = get()
    if (layers.length === 0) {
      set({ panelResult: null })
      return
    }

    // Find the outline layer for PCB dimensions.
    // Priority: 1) Explicitly typed 'outline' layer, 2) Layer with the largest bounding area
    // (the outline/profile is typically the outermost layer that encompasses all others).
    const outlineLayer = layers.find(l => l.type === 'outline' && l.visible && l.parsedLayer.bounds)
    let boundsLayer = outlineLayer
    if (!boundsLayer) {
      // Fallback: pick the visible layer with the largest bounding area as the PCB outline.
      // This handles cases where outline layers use non-standard names (e.g., Eagle's "profile.gbr").
      const visibleWithBounds = layers.filter(l => l.visible && l.parsedLayer.bounds)
      if (visibleWithBounds.length > 0) {
        boundsLayer = visibleWithBounds.reduce((best, layer) => {
          const b = layer.parsedLayer.bounds!
          const bestB = best.parsedLayer.bounds!
          const area = (b.maxX - b.minX) * (b.maxY - b.minY)
          const bestArea = (bestB.maxX - bestB.minX) * (bestB.maxY - bestB.minY)
          return area > bestArea ? layer : best
        })
      }
    }

    if (!boundsLayer || !boundsLayer.parsedLayer.bounds) {
      set({ panelResult: null })
      return
    }

    const bounds = boundsLayer.parsedLayer.bounds
    const pcbWidth = bounds.maxX - bounds.minX
    const pcbHeight = bounds.maxY - bounds.minY

    if (pcbWidth <= 0 || pcbHeight <= 0) {
      set({ panelResult: null })
      return
    }

    const panelInfo = get().panelInfo
    const result = computePanel(pcbWidth, pcbHeight, panelConfig, panelInfo)

    // Generate descriptive layer names for panel info (e.g., "Top Copper Bottom Copper Top Mask")
    const descriptiveLayerNames = layers
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
        result.pcbPositions,
        result.toolingHoles
      )

      // Append layer labels to the panel result's info texts
      result.infoTexts = [...result.infoTexts, ...labelTexts]
    }


    set({ panelResult: result })
  },

  // View state
  targetUnit: 'mm',
  setTargetUnit: (unit) => {
    set({ targetUnit: unit })
    // Convert all layers to new unit
    const { layers } = get()
    for (const layer of layers) {
      convertLayerUnits(layer.parsedLayer, unit)
    }
    // NOTE: Panel computation is now only triggered when user clicks "Create Panel" button
  },

  // Board view (composited PCB stack-up via @tracespace/core)
  boardView: null,
  boardViewSide: 'top',
  viewMode: 'board',
  setViewMode: (mode) => set({ viewMode: mode }),
  setBoardViewSide: (side) => set({ boardViewSide: side }),
  rebuildBoardView: async () => {
    const { layers } = get()
    if (layers.length === 0) {
      set({ boardView: null })
      return
    }
    const files = layers.map(l => ({ filename: l.fileName, contents: l.rawContent, type: l.type, side: l.side }))
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
    const topLayers = layers.filter(l => (l.type === 'copper' || l.type === 'silk' || l.type === 'mask') && l.side === 'top')
    const botLayers = layers.filter(l => (l.type === 'copper' || l.type === 'silk' || l.type === 'mask') && l.side === 'bottom')

    let newSide: 'top' | 'bottom' = get().boardViewSide
    if (topLayers.length === 0 && botLayers.length > 0) {
      newSide = 'bottom'
    } else if (botLayers.length === 0 && topLayers.length > 0) {
      newSide = 'top'
    }

    set({ boardView: board, boardViewSide: newSide })
  },

  hoveredLayerId: null,
  setHoveredLayerId: (id) => set({ hoveredLayerId: id }),

  boardColor: 'Green',
  setBoardColor: (color) => set({ boardColor: color }),

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
