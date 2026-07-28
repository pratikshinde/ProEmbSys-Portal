/**
 * Stateless Gerber-set analysis for quoting — parses an uploaded file set
 * (ZIP contents or loose files) and derives board dimensions / layer count
 * without touching the Panelization Zustand store, so the Order page and the
 * Panelization tool don't share mutable layer state.
 */

import { GerberLayer, parseGerber, parseExcellonDrill, isExcellonDrillFile } from './gerber-parser'

export type LayerType = 'copper' | 'mask' | 'silk' | 'outline' | 'paste' | 'drill' | 'fab' | 'other'
export type LayerSide = 'top' | 'bottom' | 'none'

/** Files inside a Gerber export that aren't Gerber/Excellon data (job reports, panel logs, etc). */
const IGNORED_FILE_PATTERN = /\.(apr|rep|drr|gbrjob|json|pdf|zip|rar|ipc|log)$/i
const IGNORED_NAME_PATTERN = /^status/i

export function detectLayerType(fileName: string): LayerType {
  const upper = fileName.toUpperCase()
  const baseName = fileName.split('.').pop()?.toUpperCase() || ''
  const nameNoExt = fileName.replace(/\.[^.]+$/, '').toUpperCase()

  // Drill detection (before other checks — .drl, .txt drill, etc.)
  if (upper.includes('.DRL') || upper.includes('DRILL') || upper.includes('HOLE') || upper.includes('EXCELLON') || upper.includes('-XLN') || upper.includes('.XLN') || upper.includes('.TAP') || upper.includes('.CNC') || upper.includes('.NC') || upper.includes('.EXC') || upper.includes('.ROU') || upper.endsWith('.DRILL')) return 'drill'

  // PADS-style short names (extensionless or short names like "bl", "tl", "to", "bs", "ts", "ko")
  if (baseName === 'TL' || baseName === 'BL' || nameNoExt === 'TL' || nameNoExt === 'BL') return 'copper'
  if (baseName === 'TS' || baseName === 'BS' || nameNoExt === 'TS' || nameNoExt === 'BS') return 'mask'
  if (baseName === 'TO' || baseName === 'BO' || nameNoExt === 'TO' || nameNoExt === 'BO') return 'silk'
  if (baseName === 'KO' || baseName === 'OUTLINE' || nameNoExt === 'KO') return 'outline'
  if (baseName === 'DRL' || baseName === 'DRILL') return 'drill'

  // Common Gerber extensions (.cmp = component/top copper, .sol = solder/bottom copper)
  if (upper.endsWith('.CMP') || upper.endsWith('.SCMP')) return 'copper'
  if (upper.endsWith('.SOL') || upper.endsWith('.SSOL')) return 'copper'
  if (upper.endsWith('.BSLK') || upper.endsWith('.GTS') || upper.endsWith('.STS')) return 'mask'
  if (upper.endsWith('.TSLK') || upper.endsWith('.GBS') || upper.endsWith('.SBS')) return 'mask'
  if (upper.endsWith('.TSK') || upper.endsWith('.BSK')) return 'silk'

  // PADS-style naming (.pho files)
  if (baseName === 'COMPSIDE' || baseName === 'SOLDSIDE') return 'copper'
  if (baseName === 'SILKTOP' || baseName === 'SILKBOT') return 'silk'
  if (baseName === 'MASKTOP' || baseName === 'MASKBOT') return 'mask'
  if (baseName === 'PASTETOP' || baseName === 'PASTEBOT') return 'paste'
  if (baseName === 'DRILLDRAWING') return 'fab'

  // Standard KiCad/Altium naming. MASK/SILK also match their common CAM
  // abbreviations MSK/SLK (e.g. PentaLogix ViewMaster's "_MSK-TOP.art" /
  // "_SLK-BOT.art") — without this, a TOP/BOT-plus-abbreviation filename with
  // no TF.FileFunction attribute (ViewMaster emits none) fell through to the
  // bare TOP/BOT copper catch-all below, so mask and silk layers rendered as
  // copper (wrong color/opacity, and the mask/copper clip-pairing in
  // board-colors.ts silently degraded to its flat-paint fallback).
  if (upper.includes('GTL') || (upper.includes('TOP') && upper.includes('COPPER')) || upper.endsWith('.GTL')) return 'copper'
  if (upper.includes('GBL') || (upper.includes('BOT') && upper.includes('COPPER')) || upper.endsWith('.GBL')) return 'copper'
  if (upper.includes('GTS') || (upper.includes('TOP') && (upper.includes('MASK') || upper.includes('MSK'))) || upper.endsWith('.GTS') || upper.includes('SMB') || upper.includes('SMT')) return 'mask'
  if (upper.includes('GBS') || (upper.includes('BOT') && (upper.includes('MASK') || upper.includes('MSK'))) || upper.endsWith('.GBS')) return 'mask'
  if (upper.includes('GTO') || (upper.includes('TOP') && (upper.includes('SILK') || upper.includes('SLK'))) || upper.endsWith('.GTO') || upper.includes('SST') || upper.includes('SSB')) return 'silk'
  if (upper.includes('GBO') || (upper.includes('BOT') && (upper.includes('SILK') || upper.includes('SLK'))) || upper.endsWith('.GBO')) return 'silk'
  if (upper.includes('GKO') || upper.includes('OUTLINE') || upper.includes('BOARD') || upper.endsWith('.GKO') || upper.includes('EDGE') || upper.includes('PROFILE') || upper.includes('CONTOUR') || upper.includes('DIMENSION') || upper === 'MILL' || upper === 'MILLING' || upper === 'ROUTE' || upper.endsWith('.GM1') || upper.endsWith('.GML') || baseName === 'GM1' || baseName === 'GML') return 'outline'
  if (upper.includes('GTP') || upper.includes('GBP') || upper.includes('PASTE')) return 'paste'

  // Catch-all checks for bare BOT/BOTTOM/TOP copper layers (after mask/silk/etc have been checked)
  if (upper.includes('BOT') || upper.includes('BOTTOM') || baseName === 'BOT' || baseName === 'BOTTOM' || nameNoExt === 'BOT') return 'copper'
  if (upper.includes('TOP') || baseName === 'TOP' || nameNoExt === 'TOP') return 'copper'

  // Fab/mechanical layers
  if (upper.includes('GM2') || upper.includes('GM3') || upper.includes('FAB') || upper.includes('MECH') || upper.includes('DRAWING') || upper.includes('DIMENSION') || upper.includes('PLI') || upper.includes('PT')) return 'fab'
  return 'other'
}

export function detectLayerSide(fileName: string, type: LayerType): LayerSide {
  if (type === 'outline' || type === 'drill' || type === 'fab' || type === 'other') return 'none'
  const upper = fileName.toUpperCase()
  const baseName = fileName.split('.').pop()?.toUpperCase() || ''
  const nameNoExt = fileName.replace(/\.[^.]+$/, '').toUpperCase()

  // PADS-style short names (bl=bottom, tl=top, bs=bottom, ts=top, to=top, bo=bottom)
  if (baseName === 'BL' || nameNoExt === 'BL') return 'bottom'
  if (baseName === 'TL' || nameNoExt === 'TL') return 'top'
  if (baseName === 'BS' || nameNoExt === 'BS') return 'bottom'
  if (baseName === 'TS' || nameNoExt === 'TS') return 'top'
  if (baseName === 'TO' || nameNoExt === 'TO') return 'top'
  if (baseName === 'BO' || nameNoExt === 'BO') return 'bottom'

  // .cmp = component/top, .sol = solder/bottom, .tslk = top mask, .bslk = bottom mask
  if (upper.endsWith('.CMP') || upper.endsWith('.SCMP') || upper.endsWith('.TSLK') || upper.endsWith('.TSK')) return 'top'
  if (upper.endsWith('.SOL') || upper.endsWith('.SSOL') || upper.endsWith('.BSLK') || upper.endsWith('.BSK')) return 'bottom'

  // PADS-style naming
  if (baseName.includes('TOP')) return 'top'
  if (baseName.includes('BOT')) return 'bottom'
  // Bottom indicators (standard naming)
  if (upper.includes('GBL') || upper.includes('GBS') || upper.includes('GBO') || upper.includes('GBP') ||
      upper.includes('BOT') || upper.includes('BOTTOM') || upper.includes('B.') || upper.endsWith('BL') ||
      upper.endsWith('BS') || upper.endsWith('BO') || upper.endsWith('BP') ||
      upper.includes('SSB') || upper.includes('SMB')) return 'bottom'
  // Top indicators
  if (upper.includes('GTL') || upper.includes('GTS') || upper.includes('GTO') || upper.includes('GTP') ||
      upper.includes('TOP') || upper.endsWith('TL') || upper.endsWith('TS') || upper.endsWith('TO') ||
      upper.endsWith('TP') || upper.includes('SST') || upper.includes('SMT')) return 'top'
  return 'none'
}

export interface DetectedLayer {
  fileName: string
  type: LayerType
  side: LayerSide
  parsedLayer: GerberLayer
}

export interface GerberQuoteAnalysis {
  layers: DetectedLayer[]
  /** Board width in mm, or null if no outline/profile layer could be found. */
  boardWidthMm: number | null
  /** Board height in mm, or null if no outline/profile layer could be found. */
  boardHeightMm: number | null
  /** Distinct copper sides detected (0, 1, or 2) — inner layers of a 4/6/8-layer
   *  stack-up aren't distinguishable from an outer Gerber export by filename alone. */
  copperLayerCount: 0 | 1 | 2
  /** Total drill hits across all detected drill/Excellon layers. */
  holeCount: number
  warnings: string[]
}

/**
 * Analyze a flat set of Gerber/Excellon file contents (e.g. extracted from a
 * ZIP) and derive the board dimensions, copper layer count, and hole count
 * used to drive the quote calculation.
 */
export function analyzeGerberSet(files: { name: string; content: string }[]): GerberQuoteAnalysis {
  const warnings: string[] = []
  const layers: DetectedLayer[] = []

  for (const { name, content } of files) {
    const base = name.split('/').pop() || name
    if (IGNORED_FILE_PATTERN.test(base) || IGNORED_NAME_PATTERN.test(base) || !content.trim()) continue

    try {
      const isDrill = isExcellonDrillFile(content)
      const parsedLayer = isDrill ? parseExcellonDrill(content, base) : parseGerber(content, base)
      const type: LayerType = isDrill ? 'drill' : detectLayerType(base)
      const side = detectLayerSide(base, type)
      layers.push({ fileName: base, type, side, parsedLayer })
    } catch (err) {
      warnings.push(`Could not parse ${base}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // Board dimensions: explicit outline layer takes priority, else the layer
  // with the largest bounding area (mirrors the panelization engine's logic
  // for boards that use non-standard outline naming, e.g. Eagle's "profile.gbr").
  const outlineLayer = layers.find(l => l.type === 'outline' && l.parsedLayer.bounds)
  let boundsLayer = outlineLayer
  if (!boundsLayer) {
    const withBounds = layers.filter(l => l.parsedLayer.bounds)
    if (withBounds.length > 0) {
      boundsLayer = withBounds.reduce((best, l) => {
        const b = l.parsedLayer.bounds!
        const bestB = best.parsedLayer.bounds!
        const area = (b.maxX - b.minX) * (b.maxY - b.minY)
        const bestArea = (bestB.maxX - bestB.minX) * (bestB.maxY - bestB.minY)
        return area > bestArea ? l : best
      })
    }
  }

  let boardWidthMm: number | null = null
  let boardHeightMm: number | null = null
  if (boundsLayer?.parsedLayer.bounds) {
    const b = boundsLayer.parsedLayer.bounds
    const w = b.maxX - b.minX
    const h = b.maxY - b.minY
    if (w > 0 && h > 0) {
      boardWidthMm = w
      boardHeightMm = h
    }
  }
  if (boardWidthMm === null && layers.length > 0) {
    warnings.push('Could not detect board dimensions from an outline/profile layer — enter them manually.')
  }

  const copperSides = new Set(layers.filter(l => l.type === 'copper').map(l => l.side))
  const copperLayerCount: 0 | 1 | 2 =
    copperSides.size === 0 ? 0 : (copperSides.has('top') && copperSides.has('bottom')) ? 2 : 1

  const holeCount = layers
    .filter(l => l.type === 'drill')
    .reduce((sum, l) => sum + l.parsedLayer.commands.filter(c => c.type === 'flash').length, 0)

  return { layers, boardWidthMm, boardHeightMm, copperLayerCount, holeCount, warnings }
}
