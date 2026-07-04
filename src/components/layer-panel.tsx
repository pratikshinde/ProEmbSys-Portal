'use client'

import React, { useRef, useState, useCallback, useEffect } from 'react'
import { useAppStore, ZipImportResult, LayerEntry, LayerType, LayerSide, detectOriginMismatch, detectDrillScaleMismatch } from '@/lib/store'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import {
  Upload, Trash2, Eye, EyeOff, Layers, FileText, FileArchive,
  Loader2, CheckCircle2, XCircle, AlertTriangle, FolderArchive,
  HelpCircle, RotateCcw, RotateCw, EyeIcon, Settings2,
} from 'lucide-react'

// Composite key = "type-side" used in the dropdown
function makeCompositeKey(type: LayerType, side: LayerSide): string {
  return `${type}-${side}`
}

function parseCompositeKey(key: string): { type: LayerType; side: LayerSide } {
  const [type, side] = key.split('-', 2) as [LayerType, LayerSide]
  return { type, side }
}

/** Display label for a layer based on its type+side */
function getLayerLabel(type: LayerType, side: LayerSide): string {
  const prefix = side === 'top' ? 'T.' : side === 'bottom' ? 'B.' : ''
  const labels: Record<LayerType, string> = {
    copper: `${prefix}Cu`,
    mask: `${prefix}Mask`,
    silk: `${prefix}Silk`,
    outline: 'Outline',
    paste: `${prefix}Paste`,
    drill: 'Drill',
    fab: 'Fab',
    other: 'Other',
  }
  return labels[type]
}

/** Badge color for type+side */
const TYPE_SIDE_COLORS: Record<string, string> = {
  'copper-top':    'bg-orange-500/20 text-orange-300 border-orange-500/30',
  'copper-bottom': 'bg-blue-500/20 text-blue-300 border-blue-500/30',
  'copper-none':   'bg-orange-500/20 text-orange-300 border-orange-500/30',
  'mask-top':      'bg-green-500/20 text-green-300 border-green-500/30',
  'mask-bottom':   'bg-teal-500/20 text-teal-300 border-teal-500/30',
  'mask-none':     'bg-green-500/20 text-green-300 border-green-500/30',
  'silk-top':      'bg-white/15 text-white border-white/20',
  'silk-bottom':   'bg-pink-500/20 text-pink-300 border-pink-500/30',
  'silk-none':     'bg-white/15 text-white border-white/20',
  'outline-none':  'bg-yellow-500/20 text-yellow-300 border-yellow-500/30',
  'outline-top':   'bg-yellow-500/20 text-yellow-300 border-yellow-500/30',
  'outline-bottom':'bg-yellow-500/20 text-yellow-300 border-yellow-500/30',
  'paste-top':     'bg-gray-500/20 text-gray-300 border-gray-500/30',
  'paste-bottom':  'bg-gray-400/20 text-gray-300 border-gray-400/30',
  'paste-none':    'bg-gray-500/20 text-gray-300 border-gray-500/30',
  'drill-none':    'bg-red-500/20 text-red-300 border-red-500/30',
  'drill-top':     'bg-red-500/20 text-red-300 border-red-500/30',
  'drill-bottom':  'bg-red-500/20 text-red-300 border-red-500/30',
  'fab-none':      'bg-cyan-500/20 text-cyan-300 border-cyan-500/30',
  'fab-top':       'bg-cyan-500/20 text-cyan-300 border-cyan-500/30',
  'fab-bottom':    'bg-cyan-500/20 text-cyan-300 border-cyan-500/30',
  'other-none':    'bg-indigo-500/20 text-indigo-300 border-indigo-500/30',
  'other-top':     'bg-indigo-500/20 text-indigo-300 border-indigo-500/30',
  'other-bottom':  'bg-indigo-500/20 text-indigo-300 border-indigo-500/30',
}

function getBadgeColor(type: LayerType, side: LayerSide): string {
  return TYPE_SIDE_COLORS[`${type}-${side}`] || TYPE_SIDE_COLORS['other-none']
}

/** Dropdown option definition */
interface DropdownOption {
  value: string  // composite key
  label: string
  group: string
}

/** All dropdown options grouped */
const DROPDOWN_OPTIONS: DropdownOption[] = [
  // Copper
  { value: 'copper-top',    label: 'Top Copper (F.Cu, GTL)',     group: 'Copper' },
  { value: 'copper-bottom', label: 'Bottom Copper (B.Cu, GBL)',  group: 'Copper' },
  // Soldermask
  { value: 'mask-top',      label: 'Top Mask (F.Mask, GTS)',     group: 'Soldermask' },
  { value: 'mask-bottom',   label: 'Bottom Mask (B.Mask, GBS)',  group: 'Soldermask' },
  // Silkscreen
  { value: 'silk-top',      label: 'Top Silk (F.Silk, GTO)',     group: 'Silkscreen' },
  { value: 'silk-bottom',   label: 'Bottom Silk (B.Silk, GBO)',  group: 'Silkscreen' },
  // Paste
  { value: 'paste-top',     label: 'Top Paste (F.Paste, GTP)',   group: 'Paste' },
  { value: 'paste-bottom',  label: 'Bottom Paste (B.Paste, GBP)',group: 'Paste' },
  // Outline
  { value: 'outline-none',  label: 'Board Outline (Edge.Cuts, GKO)', group: 'Outline' },
  // Drill
  { value: 'drill-none',    label: 'Drill (Excellon, DRL)',      group: 'Drill' },
  // Fab / Graphic
  { value: 'fab-none',      label: 'Fab / Graphic (GM1, Drawing)', group: 'Fabrication' },
  // Other
  { value: 'other-none',    label: 'Other / Unspecified',        group: 'Other' },
]

/** Unique group names in order */
const GROUP_ORDER = ['Copper', 'Soldermask', 'Silkscreen', 'Paste', 'Outline', 'Drill', 'Fabrication', 'Other']

export default function LayerPanel() {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const zipInputRef = useRef<HTMLInputElement>(null)
  const layers = useAppStore(s => s.layers)
  const addLayer = useAppStore(s => s.addLayer)
  const addLayersFromZip = useAppStore(s => s.addLayersFromZip)
  const addLayersFromRar = useAppStore(s => s.addLayersFromRar)
  const alignDrillLayersToBoard = useAppStore(s => s.alignDrillLayersToBoard)
  const removeLayer = useAppStore(s => s.removeLayer)
  const toggleLayerVisibility = useAppStore(s => s.toggleLayerVisibility)
  const updateLayerColor = useAppStore(s => s.updateLayerColor)
  const updateLayerType = useAppStore(s => s.updateLayerType)
  const setLayerOpacity = useAppStore(s => s.setLayerOpacity)
  const clearLayers = useAppStore(s => s.clearLayers)
  const rotateAllLayers = useAppStore(s => s.rotateAllLayers)
  const setAllLayersVisibility = useAppStore(s => s.setAllLayersVisibility)
  const reapplyDrillFormat = useAppStore(s => s.reapplyDrillFormat)

  // Import & Rotate state
  const [importing, setImporting] = useState(false)
  const [rotating, setRotating] = useState(false)
  const [importResult, setImportResult] = useState<ZipImportResult | null>(null)
  const [showResult, setShowResult] = useState(false)
  const [drillFormatLayerId, setDrillFormatLayerId] = useState<string | null>(null)
  const [drillUnit, setDrillUnit] = useState<'mm' | 'inches'>('mm')
  const [drillInt, setDrillInt] = useState(3)
  const [drillDec, setDrillDec] = useState(3)
  const [drillZero, setDrillZero] = useState<'leading' | 'trailing'>('trailing')
  const [applyingDrill, setApplyingDrill] = useState(false)

  const scaleMismatchedIds = detectDrillScaleMismatch(layers)

  // Track layers needing classification (type === 'other')
  const [unclassifiedIds, setUnclassifiedIds] = useState<Set<string>>(new Set())

  // Detect new 'other' type layers after import
  useEffect(() => {
    const newUnclassified = new Set<string>()
    for (const layer of layers) {
      if (layer.type === 'other') {
        newUnclassified.add(layer.id)
      }
    }
    setUnclassifiedIds(prev => {
      const merged = new Set(prev)
      for (const id of newUnclassified) merged.add(id)
      for (const id of merged) {
        const layer = layers.find(l => l.id === id)
        if (!layer || layer.type !== 'other') merged.delete(id)
      }
      return merged
    })
  }, [layers])

  const dismissClassificationPrompt = useCallback((id: string) => {
    setUnclassifiedIds(prev => {
      const next = new Set(prev)
      next.delete(id)
      return next
    })
  }, [])

  const dismissAllPrompts = useCallback(() => {
    setUnclassifiedIds(new Set())
  }, [])

  const unclassifiedLayers = layers.filter(l => unclassifiedIds.has(l.id))

  const dismissResult = useCallback(() => {
    setShowResult(false)
    setTimeout(() => setImportResult(null), 300)
  }, [])

  const handleTypeChange = useCallback((layerId: string, compositeKey: string) => {
    const { type, side } = parseCompositeKey(compositeKey)
    updateLayerType(layerId, type, side)
    // Dismiss classification prompt if was 'other'
    dismissClassificationPrompt(layerId)
  }, [updateLayerType, dismissClassificationPrompt])

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (!files) return
    for (const file of Array.from(files)) {
      try {
        await addLayer(file)
      } catch (err) {
        console.error(`Failed to load ${file.name}:`, err)
      }
    }
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const handleArchiveSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (!files || files.length === 0) return
    const file = files[0]
    const isZip = file.name.toLowerCase().endsWith('.zip')
    const isRar = file.name.toLowerCase().endsWith('.rar')
    if (!isZip && !isRar) return

    setImporting(true)
    setShowResult(true)

    try {
      const result = isZip 
        ? await addLayersFromZip(file)
        : await addLayersFromRar(file)
      setImportResult(result)
    } catch (err) {
      console.error('Archive import error:', err)
      setImportResult({
        total: 0, imported: 0, skipped: 0,
        errors: [err instanceof Error ? err.message : String(err)],
      })
    } finally {
      setImporting(false)
      if (zipInputRef.current) zipInputRef.current.value = ''
    }
  }

  const handleRotate = async (direction: 'left' | 'right') => {
    setRotating(true)
    try {
      await rotateAllLayers(direction)
    } catch (err) {
      console.error('Failed to rotate layers:', err)
    } finally {
      setRotating(false)
    }
  }

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault()
    const files = e.dataTransfer.files
    for (const file of Array.from(files)) {
      const isZip = file.name.toLowerCase().endsWith('.zip')
      const isRar = file.name.toLowerCase().endsWith('.rar')
      if (isZip || isRar) {
        setImporting(true)
        setShowResult(true)
        try {
          const result = isZip 
            ? await addLayersFromZip(file)
            : await addLayersFromRar(file)
          setImportResult(result)
        } catch (err) {
          console.error('Archive import error:', err)
          setImportResult({
            total: 0, imported: 0, skipped: 0,
            errors: [err instanceof Error ? err.message : String(err)],
          })
        } finally {
          setImporting(false)
        }
        continue
      }
      if (file.name.match(/\.(gerber|gtl|gbl|gts|gbs|gto|gbo|gko|gtp|gbp|drl|txt|text|gbr|pho|asc)$/i)) {
        try {
          await addLayer(file)
        } catch (err) {
          console.error(`Failed to load ${file.name}:`, err)
        }
      }
    }
  }

  /** Build grouped dropdown content */
  const renderDropdownContent = (currentCompositeKey: string) => {
    const groups = new Map<string, DropdownOption[]>()
    for (const opt of DROPDOWN_OPTIONS) {
      if (!groups.has(opt.group)) groups.set(opt.group, [])
      groups.get(opt.group)!.push(opt)
    }
    return (
      <SelectContent className="bg-[#0a1e38] border-[#1a3a5c]">
        {GROUP_ORDER.map(groupName => {
          const items = groups.get(groupName)
          if (!items) return null
          return (
            <SelectGroup key={groupName}>
              <SelectLabel className="text-[10px] text-[#4a6f94] font-medium">{groupName}</SelectLabel>
              {items.map(opt => (
                <SelectItem
                  key={opt.value}
                  value={opt.value}
                  className={`text-[11px] text-[#f0f8ff] focus:bg-[#0f2848] ${opt.value === currentCompositeKey ? 'bg-[#0f2848]' : ''}`}
                >
                  {opt.label}
                </SelectItem>
              ))}
            </SelectGroup>
          )
        })}
      </SelectContent>
    )
  }

  return (
    <Card className="border-[#1a3a5c] bg-[#0a1e38]/70 h-full flex flex-col">
      <CardHeader className="pb-3">
        {/* Row 1: Title + Import buttons */}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-sm font-semibold flex items-center gap-2 text-[#f0f8ff] flex-shrink-0">
            <Layers className="w-4 h-4 text-[#0ea5e9]" />
            Gerber Layers
            {layers.length > 0 && (
              <Badge variant="secondary" className="text-[9px] px-1.5 py-0 h-4 bg-[#0f2848] text-[#94b8d4]">
                {layers.length}
              </Badge>
            )}
          </CardTitle>
          <div className="flex gap-1 flex-shrink-0">
            <Button size="sm" variant="ghost" onClick={() => zipInputRef.current?.click()}
              className="h-7 px-2 text-xs text-[#94b8d4] hover:text-white hover:bg-[#0ea5e9]/20 border border-[#1a3a5c] hover:border-[#0ea5e9]/30" disabled={importing || rotating}>
              <FileArchive className="w-3 h-3 mr-1 text-[#0ea5e9]" /> ZIP / RAR
            </Button>
            <Button size="sm" variant="ghost" onClick={() => fileInputRef.current?.click()}
              className="h-7 px-2 text-xs text-[#94b8d4] hover:text-white hover:bg-[#0ea5e9]/20 border border-[#1a3a5c] hover:border-[#0ea5e9]/30" disabled={importing || rotating}>
              <Upload className="w-3 h-3 mr-1 text-[#0ea5e9]" /> Files
            </Button>
          </div>
        </div>

        {/* Row 2: Layer tools (only when layers exist) */}
        {layers.length > 0 && (
          <div className="flex items-center gap-1 mt-2">
            <Button size="sm" variant="ghost" onClick={() => handleRotate('left')}
              className="h-6 w-6 p-0 text-[#0ea5e9] hover:text-white hover:bg-[#0f2848]" disabled={importing || rotating} title="Rotate Left 90°">
              <RotateCcw className={`w-3.5 h-3.5 ${rotating ? 'animate-spin' : ''}`} />
            </Button>
            <Button size="sm" variant="ghost" onClick={() => handleRotate('right')}
              className="h-6 w-6 p-0 text-[#0ea5e9] hover:text-white hover:bg-[#0f2848]" disabled={importing || rotating} title="Rotate Right 90°">
              <RotateCw className={`w-3.5 h-3.5 ${rotating ? 'animate-spin' : ''}`} />
            </Button>
            <div className="w-px h-4 bg-[#1a3a5c]/50 mx-0.5" />
            <Button size="sm" variant="ghost"
              onClick={() => {
                const allVisible = layers.every(l => l.visible)
                setAllLayersVisibility(!allVisible)
              }}
              className="h-6 w-6 p-0 text-[#0ea5e9] hover:text-white hover:bg-[#0f2848]"
              title={layers.every(l => l.visible) ? 'Hide All Layers' : 'Show All Layers'}
            >
              {layers.every(l => l.visible)
                ? <EyeOff className="w-3.5 h-3.5" />
                : <Eye className="w-3.5 h-3.5" />
              }
            </Button>
            <div className="flex-1" />
            <Button size="sm" variant="ghost" onClick={clearLayers}
              className="h-6 px-2 text-[10px] text-red-400 hover:text-red-300 hover:bg-red-950/20" disabled={importing || rotating}>
              <Trash2 className="w-3 h-3 mr-1" /> Clear All
            </Button>
          </div>
        )}

        <input ref={fileInputRef} type="file"
          accept=".gerber,.gtl,.gbl,.gts,.gbs,.gto,.gbo,.gko,.gtp,.gbp,.drl,.txt,.text,.gbr,.pho,.asc"
          multiple onChange={handleFileSelect} className="hidden" />
        <input ref={zipInputRef} type="file" accept=".zip,.rar" onChange={handleArchiveSelect} className="hidden" />
      </CardHeader>
      <CardContent className="pt-0 flex-1 min-h-0 flex flex-col">
        {/* Import result notification */}
        {showResult && importResult && (
          <div className={`rounded-lg border p-3 mb-3 text-xs space-y-2 transition-all duration-300 ${
            importResult.errors.length > 0 && importResult.imported === 0
              ? 'bg-red-950/50 border-red-800/50'
              : importResult.errors.length > 0
                ? 'bg-yellow-950/50 border-yellow-800/50 border-yellow-900'
                : 'bg-[#0ea5e9]/10 border-[#0ea5e9]/30'
          }`}>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                {importing ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin text-[#4a6f94]" />
                ) : importResult.errors.length > 0 && importResult.imported === 0 ? (
                  <XCircle className="w-3.5 h-3.5 text-red-400" />
                ) : importResult.errors.length > 0 ? (
                  <AlertTriangle className="w-3.5 h-3.5 text-yellow-400" />
                ) : (
                  <CheckCircle2 className="w-3.5 h-3.5 text-[#0ea5e9]" />
                )}
                <span className="font-medium text-[#f0f8ff]">
                  {importing
                    ? 'Extracting zip...'
                    : `Imported ${importResult.imported} of ${importResult.total} layer${importResult.imported !== 1 ? 's' : ''}`
                  }
                </span>
              </div>
              {!importing && (
                <button onClick={dismissResult} className="p-0.5 rounded hover:bg-[#0f2848]/50 transition-colors">
                  <XCircle className="w-3 h-3 text-[#4a6f94]" />
                </button>
              )}
            </div>
            {!importing && importResult.errors.length > 0 && (
              <div className="space-y-1 max-h-24 overflow-y-auto">
                {importResult.errors.map((err, idx) => (
                  <div key={idx} className="text-[10px] text-red-300/80 font-mono break-all">{err}</div>
                ))}
              </div>
            )}
            {!importing && importResult.imported > 0 && importResult.errors.length === 0 && (
              <div className="text-[10px] text-[#0ea5e9]/70">
                All Gerber files from the zip archive were parsed successfully.
              </div>
            )}
          </div>
        )}

        {/* Classification prompt — shown when layers have type 'other' */}
        {unclassifiedLayers.length > 0 && !importing && (
          <div className="rounded-lg border border-amber-800/50 bg-amber-950/40 p-3 mb-3 space-y-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                <HelpCircle className="w-3.5 h-3.5 text-amber-400" />
                <span className="text-xs font-medium text-amber-200">
                  {unclassifiedLayers.length} layer{unclassifiedLayers.length !== 1 ? 's' : ''} need classification
                </span>
              </div>
              <button onClick={dismissAllPrompts} className="p-0.5 rounded hover:bg-[#0f2848]/50 transition-colors"
                title="Dismiss all">
                <XCircle className="w-3 h-3 text-[#4a6f94]" />
              </button>
            </div>
            <p className="text-[10px] text-amber-300/70">
              Could not auto-detect layer type. Select the correct type and side for proper color assignment.
            </p>
            <div className="space-y-1.5">
              {unclassifiedLayers.map(layer => {
                const compositeKey = makeCompositeKey(layer.type, layer.side)
                return (
                  <div key={layer.id} className="flex items-center gap-2 bg-black/20 rounded-md px-2 py-1.5">
                    <div className="w-2.5 h-2.5 rounded-full border border-[#1a3a5c] flex-shrink-0"
                      style={{ backgroundColor: layer.color }} />
                    <span className="text-[10px] text-[#94b8d4] font-medium truncate flex-1 min-w-0"
                      title={layer.fileName}>
                      {layer.fileName}
                    </span>
                    <Select
                      value={compositeKey}
                      onValueChange={(val) => handleTypeChange(layer.id, val)}
                    >
                      <SelectTrigger className="h-6 w-[130px] flex-shrink-0 text-[10px] border-[#1a3a5c] bg-[#061628] text-[#f0f8ff] px-1.5">
                        <SelectValue />
                      </SelectTrigger>
                      {renderDropdownContent(compositeKey)}
                    </Select>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* Origin Mismatch Warning Banner */}
        {detectOriginMismatch(layers) && !importing && (
          <div className="rounded-lg border border-amber-800/50 bg-amber-950/40 p-3 mb-3 space-y-2">
            <div className="flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-amber-400 flex-shrink-0" />
              <span className="text-xs font-semibold text-amber-200">
                Drill & Gerber Origin Mismatch
              </span>
            </div>
            <p className="text-[11px] text-amber-300/80 leading-relaxed">
              We detected that your drill holes do not overlap with the board outline. This usually happens when the drill origin is set differently from the Gerber origin during export.
            </p>
            <Button
              size="sm"
              onClick={alignDrillLayersToBoard}
              className="w-full text-xs font-medium bg-[#0ea5e9] hover:bg-[#0284c7] text-white h-8 mt-1"
            >
              Align Drill to Board Center
            </Button>
          </div>
        )}

        {/* Drill Scale Mismatch Warning Banner */}
        {scaleMismatchedIds.length > 0 && !importing && (
          <div className="rounded-lg border border-red-800/50 bg-red-950/40 p-3 mb-3 space-y-2">
            <div className="flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-red-400 flex-shrink-0" />
              <span className="text-xs font-semibold text-red-200">
                Drill Scale Mismatch Detected
              </span>
            </div>
            <p className="text-[11px] text-red-300/80 leading-relaxed">
              Drill file coordinates don't align with the board size. Apply a preset below or configure manually:
            </p>
            <div className="space-y-2 mt-2">
              {scaleMismatchedIds.map(id => {
                const layer = layers.find(l => l.id === id)
                if (!layer) return null
                return (
                  <div key={id} className="border border-red-900/60 bg-black/20 rounded p-2 space-y-1.5">
                    <div className="text-[10px] text-red-300 font-mono truncate" title={layer.fileName}>
                      {layer.fileName}
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {[
                        { label: 'mm 3:3 TZ', p: { u: 'mm' as const, i: 3, d: 3, z: 'trailing' as const } },
                        { label: 'in 2:4 LZ', p: { u: 'inches' as const, i: 2, d: 4, z: 'leading' as const } },
                        { label: 'in 2:4 TZ', p: { u: 'inches' as const, i: 2, d: 4, z: 'trailing' as const } },
                      ].map(preset => (
                        <button
                          key={preset.label}
                          onClick={async () => {
                            setApplyingDrill(true)
                            await reapplyDrillFormat(layer.id, preset.p.u, preset.p.i, preset.p.d, preset.p.z)
                            setApplyingDrill(false)
                          }}
                          disabled={applyingDrill}
                          className="px-1.5 py-0.5 text-[9px] font-medium rounded border border-red-800/40 bg-red-950/30 text-red-200 hover:bg-red-900/40 disabled:opacity-50 transition-colors"
                        >
                          {preset.label}
                        </button>
                      ))}
                      <button
                        onClick={() => {
                          setDrillFormatLayerId(layer.id)
                          setDrillUnit('mm')
                          setDrillInt(3)
                          setDrillDec(3)
                          setDrillZero('trailing')
                        }}
                        className="px-1.5 py-0.5 text-[9px] font-medium rounded border border-blue-800/40 bg-blue-950/30 text-blue-200 hover:bg-blue-900/40 transition-colors"
                      >
                        Custom Format...
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* Drop zone */}
        <div
          onDrop={handleDrop}
          onDragOver={(e) => e.preventDefault()}
          onDragEnter={(e) => e.preventDefault()}
          className={`border-2 border-dashed rounded-lg p-4 text-center transition-colors ${
            importing
              ? 'border-[#0ea5e9]/40 bg-[#0ea5e9]/10'
              : layers.length === 0
                ? 'border-[#1a3a5c] hover:border-[#0ea5e9]/50 bg-[#061628]/30'
                : 'border-[#1a3a5c]'
          }`}
        >
          {importing ? (
            <div className="text-[#94b8d4] text-xs">
              <Loader2 className="w-6 h-6 mx-auto mb-2 animate-spin text-[#0ea5e9]" />
              <p>Extracting and parsing Gerber files...</p>
            </div>
          ) : layers.length === 0 ? (
            <div className="text-[#94b8d4] text-xs">
              <FolderArchive className="w-6 h-6 mx-auto mb-2 text-[#0ea5e9]/60" />
              <p>Drop <span className="text-[#0ea5e9] font-medium">.zip</span> or individual Gerber files</p>
              <p className="mt-1 text-[#4a6f94]">or click <span className="text-[#0ea5e9]/80 font-medium">ZIP</span> / <span className="text-[#0ea5e9]/80 font-medium">Files</span> to browse</p>
              <p className="mt-2 text-[10px] text-[#2a4a6a]">
                .gtl .gbl .gts .gbs .gto .gbo .gko .gtp .gbp .gbr .drl
              </p>
            </div>
          ) : (
            <p className="text-[#4a6f94] text-xs">
              Drop <span className="text-[#94b8d4]">.zip</span> or Gerber files to add layers
            </p>
          )}
        </div>

        {/* Global Show/Hide All Controls */}
        {layers.length > 0 && (
          <div className="flex items-center justify-between mt-2 px-1 text-xs text-[#94b8d4]">
            <span>Global Layer Control:</span>
            <div className="flex items-center gap-2.5">
              <button
                onClick={() => setAllLayersVisibility(true)}
                className="text-[#0ea5e9] hover:underline hover:text-white font-medium transition-colors"
              >
                Show All
              </button>
              <span className="text-[#1a3a5c]">|</span>
              <button
                onClick={() => setAllLayersVisibility(false)}
                className="text-[#0ea5e9] hover:underline hover:text-white font-medium transition-colors"
              >
                Hide All
              </button>
            </div>
          </div>
        )}

        {/* Layer list */}
        {layers.length > 0 && (
          <ScrollArea className="flex-1 min-h-0 mt-2">
            <div className="space-y-1">
              {layers.map((layer) => {
                const compositeKey = makeCompositeKey(layer.type, layer.side)
                const isOther = layer.type === 'other'
                const badgeColor = getBadgeColor(layer.type, layer.side)
                const label = getLayerLabel(layer.type, layer.side)

                return (
                  <div
                    key={layer.id}
                    className={`rounded-md transition-colors ${
                      layer.visible ? 'bg-[#0f2848]/50' : 'bg-[#061628]/30 opacity-60'
                    }`}
                  >
                    {/* Row 1: Name + type badge + controls */}
                    <div className="flex items-center gap-1.5 px-2 py-1">
                      {/* Color indicator */}
                      <div className="relative flex-shrink-0">
                        <div
                           className="w-3 h-3 rounded-full border border-[#1a3a5c]"
                          style={{ backgroundColor: layer.color }}
                        />
                        <input
                          type="color"
                          value={layer.color}
                          onChange={(e) => updateLayerColor(layer.id, e.target.value)}
                          className="absolute inset-0 w-3 h-3 opacity-0 cursor-pointer"
                        />
                      </div>

                      {/* Layer name — takes all available space */}
                      <div className="flex-1 min-w-0 truncate text-xs font-medium text-[#f0f8ff]" title={layer.fileName}>
                        {layer.name}
                      </div>

                      {/* Type + Side selector dropdown */}
                      <Select
                        value={compositeKey}
                        onValueChange={(val) => handleTypeChange(layer.id, val)}
                      >
                        <SelectTrigger
                          className={`h-5 w-[52px] flex-shrink-0 text-[9px] px-1 border rounded cursor-pointer ${
                            isOther
                              ? 'border-amber-600/50 bg-amber-950/40 text-amber-300'
                              : badgeColor
                          }`}
                        >
                          <SelectValue />
                        </SelectTrigger>
                        {renderDropdownContent(compositeKey)}
                      </Select>

                      {/* Controls */}
                      <button onClick={() => toggleLayerVisibility(layer.id)}
                        className="flex-shrink-0 p-0.5 rounded hover:bg-[#0f2848] transition-colors">
                        {layer.visible ? <Eye className="w-3 h-3 text-green-400" /> : <EyeOff className="w-3 h-3 text-[#4a6f94]" />}
                      </button>
                      <button onClick={() => removeLayer(layer.id)}
                        className="flex-shrink-0 p-0.5 rounded hover:bg-red-950/50 transition-colors">
                        <Trash2 className="w-3 h-3 text-red-400" />
                      </button>
                      {layer.type === 'drill' && (
                        <button
                          onClick={() => {
                            if (drillFormatLayerId === layer.id) {
                              setDrillFormatLayerId(null)
                            } else {
                              setDrillFormatLayerId(layer.id)
                            }
                          }}
                          className={`flex-shrink-0 p-0.5 rounded transition-colors ${
                            drillFormatLayerId === layer.id ? 'bg-[#0ea5e9]/20 text-[#0ea5e9]' : 'hover:bg-[#0f2848] text-[#4a6f94]'
                          }`}
                          title="Override drill format"
                        >
                          <Settings2 className="w-3 h-3" />
                        </button>
                      )}
                    </div>

                    {/* Row 2: Info + opacity slider */}
                    <div className="flex items-center gap-2 px-2 pb-1.5">
                      <span className="text-[10px] text-[#4a6f94] flex-shrink-0">
                        {layer.parsedLayer.commands.length} cmds
                        {layer.parsedLayer.bounds && (
                          <>
                            {' · '}
                            {((layer.parsedLayer.bounds.maxX - layer.parsedLayer.bounds.minX) * (layer.parsedLayer.units === 'mm' ? 1 : 25.4)).toFixed(1)}
                            ×
                            {((layer.parsedLayer.bounds.maxY - layer.parsedLayer.bounds.minY) * (layer.parsedLayer.units === 'mm' ? 1 : 25.4)).toFixed(1)}
                            mm
                          </>
                        )}
                      </span>
                      <input
                        type="range" min="10" max="100"
                        value={Math.round(layer.opacity * 100)}
                        onChange={(e) => setLayerOpacity(layer.id, parseInt(e.target.value) / 100)}
                        className="flex-1 h-1 bg-[#1a3a5c] rounded-full appearance-none cursor-pointer accent-[#0ea5e9]"
                      />
                      <span className="text-[9px] text-[#4a6f94] w-6 flex-shrink-0 text-right">{Math.round(layer.opacity * 100)}%</span>
                    </div>

                    {/* Row 3: Drill Format Override (only for drill layers) */}
                    {layer.type === 'drill' && drillFormatLayerId === layer.id && (
                      <div className="px-2 pb-2">
                        <div className="rounded-md border border-[#1a3a5c] bg-[#061628]/50 p-2 space-y-2">
                          <div className="flex items-center justify-between">
                            <span className="text-[10px] font-medium text-[#94b8d4]">Drill Format Override</span>
                            <button onClick={() => setDrillFormatLayerId(null)}
                              className="p-0.5 rounded hover:bg-[#0f2848]/50 transition-colors">
                              <XCircle className="w-3 h-3 text-[#4a6f94]" />
                            </button>
                          </div>
                          <div className="grid grid-cols-2 gap-1.5">
                            <div>
                              <label className="text-[9px] text-[#4a6f94] block mb-0.5">Unit</label>
                              <select value={drillUnit}
                                onChange={(e) => setDrillUnit(e.target.value as 'mm' | 'inches')}
                                className="w-full h-6 text-[10px] bg-[#0a1e38] border border-[#1a3a5c] text-[#f0f8ff] rounded px-1">
                                <option value="mm">Metric (mm)</option>
                                <option value="inches">Imperial (in)</option>
                              </select>
                            </div>
                            <div>
                              <label className="text-[9px] text-[#4a6f94] block mb-0.5">Zero Suppress</label>
                              <select value={drillZero}
                                onChange={(e) => setDrillZero(e.target.value as 'leading' | 'trailing')}
                                className="w-full h-6 text-[10px] bg-[#0a1e38] border border-[#1a3a5c] text-[#f0f8ff] rounded px-1">
                                <option value="trailing">Trailing</option>
                                <option value="leading">Leading</option>
                              </select>
                            </div>
                            <div>
                              <label className="text-[9px] text-[#4a6f94] block mb-0.5">Integer</label>
                              <select value={drillInt}
                                onChange={(e) => setDrillInt(parseInt(e.target.value))}
                                className="w-full h-6 text-[10px] bg-[#0a1e38] border border-[#1a3a5c] text-[#f0f8ff] rounded px-1">
                                <option value={2}>2</option>
                                <option value={3}>3</option>
                                <option value={4}>4</option>
                              </select>
                            </div>
                            <div>
                              <label className="text-[9px] text-[#4a6f94] block mb-0.5">Decimal</label>
                              <select value={drillDec}
                                onChange={(e) => setDrillDec(parseInt(e.target.value))}
                                className="w-full h-6 text-[10px] bg-[#0a1e38] border border-[#1a3a5c] text-[#f0f8ff] rounded px-1">
                                <option value={2}>2</option>
                                <option value={3}>3</option>
                                <option value={4}>4</option>
                                <option value={5}>5</option>
                              </select>
                            </div>
                          </div>
                          <div className="flex gap-1.5">
                            {[
                              { label: 'mm 3:3 TZ', u: 'mm' as const, i: 3, d: 3, z: 'trailing' as const },
                              { label: 'mm 3:3 LZ', u: 'mm' as const, i: 3, d: 3, z: 'leading' as const },
                              { label: 'in 2:4 LZ', u: 'inches' as const, i: 2, d: 4, z: 'leading' as const },
                              { label: 'in 2:4 TZ', u: 'inches' as const, i: 2, d: 4, z: 'trailing' as const },
                            ].map(p => (
                              <button key={p.label}
                                onClick={() => { setDrillUnit(p.u); setDrillInt(p.i); setDrillDec(p.d); setDrillZero(p.z) }}
                                className={`flex-1 h-5 text-[8px] rounded border transition-colors ${
                                  drillUnit === p.u && drillInt === p.i && drillDec === p.d && drillZero === p.z
                                    ? 'bg-[#0ea5e9]/20 border-[#0ea5e9]/50 text-[#0ea5e9]'
                                    : 'bg-[#0a1e38] border-[#1a3a5c] text-[#4a6f94] hover:text-[#94b8d4]'
                                }`}>
                                {p.label}
                              </button>
                            ))}
                          </div>
                          <button
                            onClick={async () => {
                              setApplyingDrill(true)
                              await reapplyDrillFormat(layer.id, drillUnit, drillInt, drillDec, drillZero)
                              setApplyingDrill(false)
                              setDrillFormatLayerId(null)
                            }}
                            disabled={applyingDrill}
                            className="w-full h-6 text-[10px] font-medium rounded bg-[#0ea5e9] hover:bg-[#0284c7] disabled:opacity-50 text-white transition-colors"
                          >
                            {applyingDrill ? 'Applying...' : `Apply ${drillUnit === 'mm' ? 'mm' : 'in'} ${drillInt}:${drillDec} ${drillZero === 'trailing' ? 'TZ' : 'LZ'}`}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </ScrollArea>
        )}
      </CardContent>
    </Card>
  )
}
