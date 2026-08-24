'use client'

import React from 'react'
import { useAppStore } from '@/lib/store'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { FileText, Download, Package, Settings2, RotateCcw, AlertTriangle, Wrench, Save, FolderOpen, Trash2 } from 'lucide-react'
import { exportPanelizedGerbers } from '@/lib/gerber-exporter'
import { LayerFile } from '@/lib/gerber-exporter'
import { DrillFormatPreset, DRILL_FORMAT_PRESETS, DrillCamCompatibility } from '@/lib/panelization-engine'
import { getMirroredLayers } from '@/lib/design-mirror'
import { toast } from '@/hooks/use-toast'
import type { CamJobFileMeta, CamJobSnapshot } from '@/lib/store'
import { loadCamJobById } from '@/lib/load-cam-job'

interface CamJobListItem {
  id: string
  name: string
  revision: string
  updatedAt: string
}

export default function ExportPanel() {
  const panelInfo = useAppStore(s => s.panelInfo)
  const updatePanelInfo = useAppStore(s => s.updatePanelInfo)
  const panelResult = useAppStore(s => s.panelResult)
  const panelConfig = useAppStore(s => s.panelConfig)
  const updatePanelConfig = useAppStore(s => s.updatePanelConfig)
  const allLayers = useAppStore(s => s.layers)
  const camMode = useAppStore(s => s.camMode)
  const activeDesignId = useAppStore(s => s.activeDesignId)
  // MULTI mode exports every design — `exportPanelizedGerbers` merges them by
  // (type, side) into one file per layer, which is the whole point of packing
  // several boards onto one panel. SINGLE mode exports only the ACTIVE
  // design: a design left loaded from a previous multi-mode session is hidden
  // everywhere else in the tool, so shipping its layers in the ZIP (as extra
  // drill tools and merge contributors) would be a silent surprise.
  const exportLayers = React.useMemo(
    () => (camMode === 'single' && activeDesignId ? allLayers.filter(l => l.designId === activeDesignId) : allLayers),
    [camMode, activeDesignId, allLayers]
  )
  const outputFormat = useAppStore(s => s.outputFormat)
  const updateOutputFormat = useAppStore(s => s.updateOutputFormat)
  const resetOutputFormat = useAppStore(s => s.resetOutputFormat)
  const computePanelResult = useAppStore(s => s.computePanelResult)
  // Route files ride along in the full panel export when a plan exists.
  const routingResult = useAppStore(s => s.routingResult)
  // Meta-panelization (multi-panel-array) Gerber + Excellon ride along the
  // same way, in their own Meta-Panelization/ subfolder, when generated on
  // the G-Code tab's array section.
  const panelArrayFiles = useAppStore(s => s.panelArrayFiles)
  const [exporting, setExporting] = React.useState(false)

  // Save Job — everything else this snapshot needs beyond what's already
  // selected above (allLayers, camMode, panelConfig, panelInfo,
  // outputFormat). See CamJobSnapshot's own doc comment in store.ts for
  // exactly what is (and deliberately isn't) captured.
  const activeTab = useAppStore(s => s.activeTab)
  const designs = useAppStore(s => s.designs)
  const activeDesignId2 = useAppStore(s => s.activeDesignId)
  const materialSizeMm = useAppStore(s => s.materialSizeMm)
  const targetUnit = useAppStore(s => s.targetUnit)
  const boardViewSide = useAppStore(s => s.boardViewSide)
  const viewMode = useAppStore(s => s.viewMode)
  const boardColor = useAppStore(s => s.boardColor)
  const dfmTemplateId = useAppStore(s => s.dfmTemplateId)
  const dfmContext = useAppStore(s => s.dfmContext)
  const routingConfig = useAppStore(s => s.routingConfig)
  const gcodeContext = useAppStore(s => s.gcodeContext)
  const panelArrayConfig = useAppStore(s => s.panelArrayConfig)
  const stencilConfig = useAppStore(s => s.stencilConfig)
  const panelTemplateId = useAppStore(s => s.panelTemplateId)
  const showGrid = useAppStore(s => s.showGrid)
  const showCrosshair = useAppStore(s => s.showCrosshair)

  const [saveDialogOpen, setSaveDialogOpen] = React.useState(false)
  const [jobName, setJobName] = React.useState('')
  const [savingJob, setSavingJob] = React.useState(false)

  const [loadDialogOpen, setLoadDialogOpen] = React.useState(false)
  const [jobList, setJobList] = React.useState<CamJobListItem[] | null>(null)
  const [loadingJobId, setLoadingJobId] = React.useState<string | null>(null)
  const [deletingJob, setDeletingJob] = React.useState<CamJobListItem | null>(null)

  const openLoadDialog = async () => {
    setLoadDialogOpen(true)
    setJobList(null)
    try {
      const res = await fetch('/api/cam-jobs')
      setJobList(res.ok ? await res.json() : [])
    } catch {
      setJobList([])
    }
  }

  const handleLoadJob = async (jobId: string) => {
    if (allLayers.length > 0 && !confirm('Load this saved job? Your current unsaved work will be replaced.')) return
    setLoadingJobId(jobId)
    try {
      const result = await loadCamJobById(jobId)
      if (result.ok) {
        toast({ title: 'Job loaded', description: result.name })
        setLoadDialogOpen(false)
      } else {
        toast({ title: 'Could not load job', description: result.error })
      }
    } finally {
      setLoadingJobId(null)
    }
  }

  const handleDeleteJob = async (job: CamJobListItem) => {
    const res = await fetch(`/api/cam-jobs/${job.id}`, { method: 'DELETE' })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      toast({ title: 'Could not delete job', description: err.error ?? 'Please try again.' })
      return
    }
    setJobList((prev) => (prev ? prev.filter((j) => j.id !== job.id) : prev))
    toast({ title: 'Job deleted', description: job.name })
  }

  const openSaveDialog = () => {
    setJobName(panelInfo.pcbName || 'Untitled Job')
    setSaveDialogOpen(true)
  }

  const handleSaveJob = async () => {
    if (!jobName.trim() || allLayers.length === 0) return
    setSavingJob(true)
    try {
      const files: CamJobFileMeta[] = allLayers.map(l => ({
        layerFileId: l.id,
        designId: l.designId,
        fileName: l.fileName,
        type: l.type,
        side: l.side,
        color: l.color,
        visible: l.visible,
        opacity: l.opacity,
        fileSize: l.originalContent.length,
      }))
      const snapshot: CamJobSnapshot = {
        camMode, activeTab, designs, activeDesignId: activeDesignId2, materialSizeMm,
        panelConfig, panelInfo, outputFormat, targetUnit, boardViewSide, viewMode, boardColor,
        dfmTemplateId, dfmContext, routingConfig, gcodeContext, panelArrayConfig, stencilConfig,
        panelTemplateId, showGrid, showCrosshair, files,
      }

      const formData = new FormData()
      formData.set('name', jobName.trim())
      formData.set('config', JSON.stringify(snapshot))
      for (const l of allLayers) {
        formData.set(`file_${l.id}`, new File([l.originalContent], l.fileName))
      }

      const res = await fetch('/api/cam-jobs', { method: 'POST', body: formData })
      const data = await res.json()
      if (!res.ok) {
        toast({
          title: res.status === 409 ? 'Duplicate job name + revision' : 'Could not save job',
          description: data.error ?? 'Please try again.',
        })
        return
      }
      toast({ title: 'Job saved', description: jobName.trim() })
      setSaveDialogOpen(false)
    } catch (err) {
      toast({ title: 'Could not save job', description: err instanceof Error ? err.message : 'Please try again.' })
    } finally {
      setSavingJob(false)
    }
  }

  const handleExport = async () => {
    if (!panelResult || exportLayers.length === 0) return

    setExporting(true)
    try {
      // Materialize each mirrored design's "Fix mirror" override into the
      // ACTUAL exported geometry, not just the on-screen preview transform
      // — see getMirroredLayers's own docs for why this is the ONE shared
      // point every file-producing consumer (this export, routing, G-code,
      // stencil, meta-panel array) goes through, so none of them can
      // silently disagree with a mirrored Gerber export.
      const { layers: mirroredLayers, warnings: mirrorWarnings } = getMirroredLayers(exportLayers, designs)
      for (const w of mirrorWarnings) console.warn('[Export mirror]', w)

      const layerFiles: LayerFile[] = mirroredLayers.map(l => ({
        name: l.name,
        fileName: `panel_${l.type}_${l.id}.gerber`,
        content: l.rawContent,
        parsedLayer: l.parsedLayer,
        type: l.type,
        side: l.side,
        designId: l.designId,
      }))

      const metaPanel = panelArrayFiles
        ? {
            borderMarksGerberFilename: panelArrayFiles.borderMarksGerberFilename,
            borderMarksGerber: panelArrayFiles.borderMarksGerber,
            drillFilename: panelArrayFiles.drillFilename,
            drillContent: panelArrayFiles.drillContent,
          }
        : null
      const { dcodeWarnings } = await exportPanelizedGerbers(layerFiles, panelResult, panelConfig, panelInfo, outputFormat, routingResult, metaPanel)

      // Surface aperture/D-code export problems (undefined macro references,
      // zero-size apertures) directly — these are exactly the class of bug
      // that shipped invisible pads in a real customer export (see the
      // octagon-macro unit-conversion fix) before anyone noticed in a
      // third-party viewer. mirrorWarnings share the same toast when both
      // fire, since TOAST_LIMIT=1 would otherwise silently drop one.
      const allWarnings = [...mirrorWarnings, ...dcodeWarnings]
      if (allWarnings.length > 0) {
        console.warn('[Export] D-code/aperture warnings:', dcodeWarnings)
        toast({
          title: `Exported with ${allWarnings.length} warning${allWarnings.length !== 1 ? 's' : ''}`,
          description: allWarnings.slice(0, 3).join(' · ') + (allWarnings.length > 3 ? ` · +${allWarnings.length - 3} more — see console` : ''),
          variant: 'destructive',
        })
      } else {
        toast({ title: 'Export complete', description: 'Panel exported — no aperture/D-code issues detected.' })
      }
    } catch (err) {
      console.error('Export failed:', err)
      alert('Export failed. Check console for details.')
    } finally {
      setExporting(false)
    }
  }

  // Generate preview of the FS command header
  const fsPreview = `${outputFormat.zeroOmission === 'leading' ? 'L' : outputFormat.zeroOmission === 'trailing' ? 'T' : ''}${outputFormat.notation === 'absolute' ? 'A' : 'I'}X${outputFormat.integerDigits}${outputFormat.decimalDigits}Y${outputFormat.integerDigits}${outputFormat.decimalDigits}`
  const moPreview = outputFormat.unit === 'mm' ? 'MOMM' : 'MOIN'
  const gPreview = outputFormat.unit === 'mm' ? 'G71' : 'G70'
  const formatLabel = `${outputFormat.integerDigits}.${outputFormat.decimalDigits}`

  // Auto-detect minimum integer digits from panel dimensions
  const minIntegerDigits = panelResult
    ? Math.max(3, Math.floor(Math.log10(Math.max(panelResult.panelWidth, panelResult.panelHeight, 1))) + 2)
    : 4
  const formatInsufficient = outputFormat.integerDigits < minIntegerDigits

  // Preview of what `resolveExportDrillFormat` will actually do at export
  // time (same math, mirrored here rather than calling that function
  // directly so this doesn't also fire its console.warn on every render).
  // Deliberately independent of `outputFormat.unit` — the drill unit is no
  // longer force-synced to the Gerber output unit (mixed mm-Gerber +
  // inch-drill is standard practice; see resolveExportDrillFormat's docs).
  const drillFmt = panelConfig.drillFormat
  const drillMaxCoord = panelResult ? Math.max(panelResult.panelWidth, panelResult.panelHeight) : 0
  const drillMaxCoordInUnit = drillFmt.unit === 'mm' ? drillMaxCoord : drillMaxCoord / 25.4
  const drillNeededIntDigits = drillMaxCoordInUnit <= 0 ? 3 : Math.min(Math.floor(Math.log10(drillMaxCoordInUnit)) + 2, 6)
  // Gated on panelResult too — with no panel computed yet there's nothing to
  // size against, so this must read as "no widening", not a stale 3-digit floor.
  const drillDigitsWillWiden = !!panelResult && drillFmt.integerDigits < drillNeededIntDigits

  return (
    <Card className="border-[#1a3a5c] bg-[#0a1e38]/70">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-semibold flex items-center gap-2 text-[#f0f8ff]">
            <FileText className="w-4 h-4 text-[#0ea5e9]" />
            Panel Information & Export
          </CardTitle>
        </div>
      </CardHeader>
      <CardContent className="pt-0 space-y-4">
        {/* Output Format section */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <Label className="text-xs text-[#94b8d4] font-medium flex items-center gap-1.5">
              <Settings2 className="w-3 h-3 text-[#0ea5e9]" />
              Gerber Output Format
            </Label>
            <Button
              variant="ghost"
              size="sm"
              onClick={resetOutputFormat}
              className="h-5 px-1.5 text-[10px] text-[#94b8d4] hover:text-white hover:bg-[#0f2848]"
            >
              <RotateCcw className="w-2.5 h-2.5 mr-0.5" />
              Reset
            </Button>
          </div>

          <div className="grid grid-cols-2 gap-2">
            {/* Format digits */}
            <div>
              <Label className="text-[10px] text-[#4a6f94]">Integer Digits</Label>
              <Select
                value={outputFormat.integerDigits.toString()}
                onValueChange={(v) => updateOutputFormat({ integerDigits: parseInt(v) })}
              >
                <SelectTrigger className="h-7 text-xs bg-[#061628] border-[#1a3a5c] text-[#f0f8ff]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-[#0a1e38] border-[#1a3a5c]">
                  <SelectItem value="2">2 (compact)</SelectItem>
                  <SelectItem value="3">3</SelectItem>
                  <SelectItem value="4">4 (default)</SelectItem>
                  <SelectItem value="5">5</SelectItem>
                  <SelectItem value="6">6</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-[10px] text-[#4a6f94]">Decimal Digits</Label>
              <Select
                value={outputFormat.decimalDigits.toString()}
                onValueChange={(v) => updateOutputFormat({ decimalDigits: parseInt(v) })}
              >
                <SelectTrigger className="h-7 text-xs bg-[#061628] border-[#1a3a5c] text-[#f0f8ff]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-[#0a1e38] border-[#1a3a5c]">
                  <SelectItem value="3">3 (0.001)</SelectItem>
                  <SelectItem value="4">4 (0.0001)</SelectItem>
                  <SelectItem value="5">5 (0.00001)</SelectItem>
                  <SelectItem value="6">6 (0.000001)</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Zero omission */}
            <div>
              <Label className="text-[10px] text-[#4a6f94]">Zero Omission</Label>
              <Select
                value={outputFormat.zeroOmission}
                onValueChange={(v) => updateOutputFormat({ zeroOmission: v as 'leading' | 'trailing' | 'none' })}
              >
                <SelectTrigger className="h-7 text-xs bg-[#061628] border-[#1a3a5c] text-[#f0f8ff]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-[#0a1e38] border-[#1a3a5c]">
                  <SelectItem value="leading">Leading (L)</SelectItem>
                  <SelectItem value="trailing">Trailing (T)</SelectItem>
                  <SelectItem value="none">None (NO)</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Units */}
            <div>
              <Label className="text-[10px] text-[#4a6f94]">Output Units</Label>
              <Select
                value={outputFormat.unit}
                onValueChange={(v) => updateOutputFormat({ unit: v as 'mm' | 'inches' })}
              >
                <SelectTrigger className="h-7 text-xs bg-[#061628] border-[#1a3a5c] text-[#f0f8ff]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-[#0a1e38] border-[#1a3a5c]">
                  <SelectItem value="mm">Metric (mm)</SelectItem>
                  <SelectItem value="inches">English (in)</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Notation */}
          <div className="mt-2">
            <Label className="text-[10px] text-[#4a6f94]">Coordinate Notation</Label>
            <div className="grid grid-cols-2 gap-1 mt-1">
              <Button
                size="sm"
                variant={outputFormat.notation === 'absolute' ? 'default' : 'outline'}
                onClick={() => updateOutputFormat({ notation: 'absolute' })}
                className={`h-7 px-2 text-xs leading-tight ${outputFormat.notation !== 'absolute' ? 'border-[#1a3a5c] text-[#94b8d4] hover:text-white hover:bg-[#0f2848]' : 'bg-[#0ea5e9] text-white'}`}
                title="Absolute (A) — coordinates from origin"
              >
                Absolute (A)
              </Button>
              <Button
                size="sm"
                variant={outputFormat.notation === 'incremental' ? 'default' : 'outline'}
                onClick={() => updateOutputFormat({ notation: 'incremental' })}
                className={`h-7 px-2 text-xs leading-tight ${outputFormat.notation !== 'incremental' ? 'border-[#1a3a5c] text-[#94b8d4] hover:text-white hover:bg-[#0f2848]' : 'bg-[#0ea5e9] text-white'}`}
                title="Incremental (I) — relative offsets"
              >
                Incremental (I)
              </Button>
            </div>
          </div>

          {/* Format warning */}
          {formatInsufficient && panelResult && (
            <div className="mt-2 flex items-start gap-1.5 px-2 py-1.5 rounded-md bg-yellow-950/40 border border-yellow-800/40">
              <AlertTriangle className="w-3 h-3 text-yellow-500 mt-0.5 flex-shrink-0" />
              <div className="text-[10px] text-yellow-300">
                Panel is {panelResult.panelWidth.toFixed(0)}×{panelResult.panelHeight.toFixed(0)}mm — needs ≥{minIntegerDigits} integer digits. Current {outputFormat.integerDigits} will cause coordinate truncation!
              </div>
            </div>
          )}

          {/* Format preview */}
          <div className="mt-2 bg-[#061628]/80 rounded-md p-2 text-[10px] font-mono text-[#4a6f94] space-y-0.5">
            <div className="text-[#94b8d4] font-medium">Header Preview:</div>
            <div>%FS{fsPreview}*%</div>
            <div>%{moPreview}*%</div>
            <div>{gPreview}*</div>
            <div className="mt-1">
              Resolution: {formatLabel} ({outputFormat.unit === 'mm'
                ? `${Math.pow(10, -outputFormat.decimalDigits).toFixed(outputFormat.decimalDigits)} mm`
                : `${Math.pow(10, -outputFormat.decimalDigits).toFixed(outputFormat.decimalDigits)} in`
              })
            </div>
          </div>
        </div>

        <Separator className="bg-[#1a3a5c]" />

        {/* Drill Output Format — kept in the same card as the Gerber output
            format so both can be set together (they used to live on
            separate tabs, which made it easy to change one and forget the
            other, e.g. picking Inches here while Gerber stayed mm). */}
        <div>
          <Label className="text-xs text-[#94b8d4] font-medium flex items-center gap-1.5 mb-2">
            <Wrench className="w-3 h-3 text-amber-400" />
            Drill Output Format
          </Label>

          {/* Format preset selector */}
          <div className="mb-2">
            <Label className="text-[10px] text-[#4a6f94]">Format Preset</Label>
            <Select
              value={drillFmt.preset || 'excellon-2-4'}
              onValueChange={(v) => {
                const preset = v as DrillFormatPreset
                const p = DRILL_FORMAT_PRESETS[preset]
                if (p) {
                  updatePanelConfig({
                    drillFormat: {
                      preset,
                      integerDigits: p.integerDigits,
                      decimalDigits: p.decimalDigits,
                      unit: p.unit,
                      zeroSuppression: p.zeroSuppression,
                      camCompatibility: p.camCompatibility,
                    }
                  })
                }
              }}
            >
              <SelectTrigger className="h-7 text-xs bg-[#061628] border-[#1a3a5c] text-[#f0f8ff]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="bg-[#0a1e38] border-[#1a3a5c]">
                <SelectItem value="excellon-2-4">Excellon 2:4 (inch)</SelectItem>
                <SelectItem value="excellon-3-3">Excellon 3:3 (mm)</SelectItem>
                <SelectItem value="excellon-2-5">Excellon 2:5 (inch)</SelectItem>
                <SelectItem value="excellon-3-4">Excellon 3:4 (mm)</SelectItem>
                <SelectItem value="custom">Custom</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Customizable format details */}
          <div className="grid grid-cols-2 gap-2">
            {/* Integer digits */}
            <div>
              <Label className="text-[10px] text-[#4a6f94]">Integer Digits</Label>
              <Select
                value={drillFmt.integerDigits?.toString() || '2'}
                onValueChange={(v) => {
                  updatePanelConfig({
                    drillFormat: { ...drillFmt, integerDigits: parseInt(v), preset: 'custom' }
                  })
                }}
              >
                <SelectTrigger className="h-7 text-xs bg-[#061628] border-[#1a3a5c] text-[#f0f8ff]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-[#0a1e38] border-[#1a3a5c]">
                  <SelectItem value="2">2</SelectItem>
                  <SelectItem value="3">3</SelectItem>
                  <SelectItem value="4">4</SelectItem>
                  <SelectItem value="5">5</SelectItem>
                  <SelectItem value="6">6</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Decimal digits */}
            <div>
              <Label className="text-[10px] text-[#4a6f94]">Decimal Digits</Label>
              <Select
                value={drillFmt.decimalDigits?.toString() || '4'}
                onValueChange={(v) => {
                  updatePanelConfig({
                    drillFormat: { ...drillFmt, decimalDigits: parseInt(v), preset: 'custom' }
                  })
                }}
              >
                <SelectTrigger className="h-7 text-xs bg-[#061628] border-[#1a3a5c] text-[#f0f8ff]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-[#0a1e38] border-[#1a3a5c]">
                  <SelectItem value="3">3 (0.001)</SelectItem>
                  <SelectItem value="4">4 (0.0001)</SelectItem>
                  <SelectItem value="5">5 (0.00001)</SelectItem>
                  <SelectItem value="6">6 (0.000001)</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Unit */}
            <div>
              <Label className="text-[10px] text-[#4a6f94]">Drill Units</Label>
              <Select
                value={drillFmt.unit || 'inches'}
                onValueChange={(v) => {
                  updatePanelConfig({
                    drillFormat: { ...drillFmt, unit: v as 'mm' | 'inches', preset: 'custom' }
                  })
                }}
              >
                <SelectTrigger className="h-7 text-xs bg-[#061628] border-[#1a3a5c] text-[#f0f8ff]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-[#0a1e38] border-[#1a3a5c]">
                  <SelectItem value="mm">Metric (mm)</SelectItem>
                  <SelectItem value="inches">English (inch)</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Zero suppression */}
            <div>
              <Label className="text-[10px] text-[#4a6f94]">Zero Suppression</Label>
              <Select
                value={drillFmt.zeroSuppression || 'none'}
                onValueChange={(v) => {
                  updatePanelConfig({
                    drillFormat: { ...drillFmt, zeroSuppression: v as 'none' | 'leading' | 'trailing', preset: 'custom' }
                  })
                }}
              >
                <SelectTrigger className="h-7 text-xs bg-[#061628] border-[#1a3a5c] text-[#f0f8ff]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-[#0a1e38] border-[#1a3a5c]">
                  <SelectItem value="none">None (NO)</SelectItem>
                  <SelectItem value="leading">Leading (LZ)</SelectItem>
                  <SelectItem value="trailing">Trailing (TZ)</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* CAM compatibility — only matters for leading/trailing suppression;
              'none' is unambiguous fixed-width in both conventions. */}
          {drillFmt.zeroSuppression !== 'none' && (
            <div className="mt-2">
              <Label className="text-[10px] text-[#4a6f94]">Zero-Suppression Reader</Label>
              <div className="grid grid-cols-2 gap-1 mt-1">
                <Button
                  size="sm"
                  variant={drillFmt.camCompatibility === 'cam350' ? 'default' : 'outline'}
                  onClick={() => updatePanelConfig({ drillFormat: { ...drillFmt, camCompatibility: 'cam350' as DrillCamCompatibility } })}
                  className={`h-7 px-2 text-xs leading-tight ${drillFmt.camCompatibility !== 'cam350' ? 'border-[#1a3a5c] text-[#94b8d4] hover:text-white hover:bg-[#0f2848]' : 'bg-[#0ea5e9] text-white'}`}
                  title="CAM350 reads LZ/TZ backwards from the Excellon spec — this matches that quirk"
                >
                  CAM350
                </Button>
                <Button
                  size="sm"
                  variant={drillFmt.camCompatibility === 'standard' ? 'default' : 'outline'}
                  onClick={() => updatePanelConfig({ drillFormat: { ...drillFmt, camCompatibility: 'standard' as DrillCamCompatibility } })}
                  className={`h-7 px-2 text-xs leading-tight ${drillFmt.camCompatibility !== 'standard' ? 'border-[#1a3a5c] text-[#94b8d4] hover:text-white hover:bg-[#0f2848]' : 'bg-[#0ea5e9] text-white'}`}
                  title="Standard Excellon LZ/TZ meaning — for tracespace.io, KiCad, and most other CAM tools"
                >
                  Standard
                </Button>
              </div>
              <p className="text-[10px] text-[#4a6f94] mt-1">
                {drillFmt.camCompatibility === 'standard'
                  ? 'Matches tracespace.io, KiCad, and most non-CAM350 Excellon readers.'
                  : 'Matches CAM350’s own (spec-inverted) LZ/TZ interpretation. Wrong choice here shifts every drill coordinate’s decimal point — holes land off-pad, too small or too big.'}
              </p>
            </div>
          )}

          {/* Drill digit auto-widen warning */}
          {drillDigitsWillWiden && panelResult && (
            <div className="mt-2 flex items-start gap-1.5 px-2 py-1.5 rounded-md bg-yellow-950/40 border border-yellow-800/40">
              <AlertTriangle className="w-3 h-3 text-yellow-500 mt-0.5 flex-shrink-0" />
              <div className="text-[10px] text-yellow-300">
                Panel needs ≥{drillNeededIntDigits} integer digits at this unit/size — export will widen from {drillFmt.integerDigits} to {drillNeededIntDigits} automatically.
              </div>
            </div>
          )}

          {/* Format summary */}
          <div className="mt-2 bg-[#061628]/80 rounded-md p-2 text-[10px] font-mono text-[#4a6f94] space-y-0.5">
            <div className="text-[#94b8d4] font-medium">Drill Format Preview</div>
            <div>FORMAT: {drillDigitsWillWiden ? drillNeededIntDigits : drillFmt.integerDigits}:{drillFmt.decimalDigits ?? 4}</div>
            <div>UNIT: {drillFmt.unit === 'mm' ? 'METRIC' : 'ENGLISH'}</div>
            <div>ZERO: {drillFmt.zeroSuppression === 'none' ? 'NONE' : drillFmt.zeroSuppression === 'leading' ? 'LZ' : 'TZ'}</div>
            {drillFmt.zeroSuppression !== 'none' && (
              <div>READER: {drillFmt.camCompatibility === 'standard' ? 'STANDARD' : 'CAM350'}</div>
            )}
          </div>
        </div>

        <Separator className="bg-[#1a3a5c]" />

        {/* Panel Text Font */}
        <div>
          <Label className="text-xs text-[#94b8d4] font-medium flex items-center gap-1.5 mb-2">
            <Settings2 className="w-3 h-3 text-[#0ea5e9]" />
            Panel Text Font
          </Label>
          <Select
            value={panelConfig.textFont}
            onValueChange={(v) => updatePanelConfig({ textFont: v as 'stroke' | 'region' })}
          >
            <SelectTrigger className="h-7 text-xs bg-[#061628] border-[#1a3a5c] text-[#f0f8ff]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="bg-[#0a1e38] border-[#1a3a5c]">
              <SelectItem value="region">
                Region-Based (Solid filled, recommended)
              </SelectItem>
              <SelectItem value="stroke">
                Stroke-Based (Single-line, thin)
              </SelectItem>
            </SelectContent>
          </Select>
          <p className="text-[10px] text-[#4a6f94] mt-1">
            {panelConfig.textFont === 'region'
              ? 'Solid vector shapes — robust, highly readable on all CAM tools.'
              : 'Single-stroke pen paths — thinner appearance, compatible with plotters.'}
          </p>
          <div className="grid grid-cols-2 gap-2 mt-2">
            <div>
              <Label className="text-[10px] text-[#4a6f94]">Top Rib Text Size (mm)</Label>
              <Input
                type="number" min={0.5} max={10} step={0.1}
                value={panelConfig.topRibFontSize}
                onChange={(e) => updatePanelConfig({ topRibFontSize: Math.max(0.5, parseFloat(e.target.value) || 2.8) })}
                className="h-7 text-xs bg-[#061628] border-[#1a3a5c] text-[#f0f8ff]"
              />
            </div>
            <div>
              <Label className="text-[10px] text-[#4a6f94]">Bottom Rib Text Size (mm)</Label>
              <Input
                type="number" min={0.5} max={10} step={0.1}
                value={panelConfig.bottomRibFontSize}
                onChange={(e) => updatePanelConfig({ bottomRibFontSize: Math.max(0.5, parseFloat(e.target.value) || 2.8) })}
                className="h-7 text-xs bg-[#061628] border-[#1a3a5c] text-[#f0f8ff]"
              />
            </div>
          </div>
        </div>

        <Separator className="bg-[#1a3a5c]" />

        {/* Panel info fields */}
        <div className="space-y-2">
          <Label className="text-xs text-[#94b8d4] font-medium">Panel Information</Label>
          <div>
            <Label className="text-[10px] text-[#4a6f94]">PCB Name / Part Number</Label>
            <Input
              value={panelInfo.pcbName}
              onChange={(e) => updatePanelInfo({ pcbName: e.target.value })}
              className="h-7 text-xs bg-[#061628] border-[#1a3a5c] text-[#f0f8ff] placeholder-[#4a6f94]"
              placeholder="PCB-001"
            />
          </div>
          <div>
            <Label className="text-[10px] text-[#4a6f94]">Customer Reference</Label>
            <Input
              value={panelInfo.customerRef}
              onChange={(e) => updatePanelInfo({ customerRef: e.target.value })}
              className="h-7 text-xs bg-[#061628] border-[#1a3a5c] text-[#f0f8ff] placeholder-[#4a6f94]"
              placeholder="Customer Name"
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label className="text-[10px] text-[#4a6f94]">Revision</Label>
              <Input
                value={panelInfo.revision}
                onChange={(e) => updatePanelInfo({ revision: e.target.value })}
                className="h-7 text-xs bg-[#061628] border-[#1a3a5c] text-[#f0f8ff] placeholder-[#4a6f94]"
                placeholder="1.0"
              />
            </div>
            <div>
              <Label className="text-[10px] text-[#4a6f94]">Date</Label>
              <Input
                value={panelInfo.date}
                onChange={(e) => updatePanelInfo({ date: e.target.value })}
                className="h-7 text-xs bg-[#061628] border-[#1a3a5c] text-[#f0f8ff] placeholder-[#4a6f94]"
                placeholder="29-JUL-2026"
              />
            </div>
          </div>
          <div>
            <Label className="text-[10px] text-[#4a6f94]">Layers</Label>
            <Input
              value={panelInfo.layers}
              onChange={(e) => updatePanelInfo({ layers: e.target.value })}
              className="h-7 text-xs bg-[#061628] border-[#1a3a5c] text-[#f0f8ff] placeholder-[#4a6f94]"
              placeholder="GTL GBL GTS GBS GTO GBO"
            />
          </div>
          
          <Button 
            variant="outline" 
            size="sm" 
            onClick={computePanelResult}
            className="w-full h-8 text-xs border-[#0ea5e9]/50 hover:bg-[#0ea5e9]/10 text-[#0ea5e9]"
          >
            <RotateCcw className="w-3 h-3 mr-1.5" />
            Apply Changes to Gerber
          </Button>
        </div>

        <Separator className="bg-[#1a3a5c]" />

        {/* Info preview */}
        {panelResult && (
          <div className="bg-[#061628]/80 rounded-lg p-3 text-[10px] font-mono text-[#4a6f94] space-y-1 overflow-hidden">
            <div className="text-[#94b8d4] font-medium text-xs mb-2">Panel Text Preview</div>
            <div className="break-all">PCB: {panelInfo.pcbName} | Rev: {panelInfo.revision}</div>
            <div className="break-all">Customer: {panelInfo.customerRef}</div>
            <div>Date: {panelInfo.date} | Size: {(panelResult.designs[0]?.widthMm ?? 0).toFixed(1)}×{(panelResult.designs[0]?.heightMm ?? 0).toFixed(1)}mm</div>
            <div>Panel: {panelResult.panelWidth.toFixed(1)}×{panelResult.panelHeight.toFixed(1)}mm | Qty: {panelResult.totalPCBs}</div>
            <div className="break-all">Layers: {panelInfo.layers}</div>
          </div>
        )}

        <Separator className="bg-[#1a3a5c]" />

        {/* Export buttons */}
        <div className="space-y-2">
          <Button
            onClick={handleExport}
            disabled={!panelResult || exportLayers.length === 0 || exporting}
            className="w-full h-9 bg-[#0ea5e9] hover:bg-[#0ea5e9]/80 text-white text-sm"
          >
            <Package className="w-4 h-4 mr-2" />
            {exporting ? 'Exporting...' : 'Export Panelized Gerbers (.zip)'}
          </Button>
          <p className="text-[10px] text-[#4a6f94] text-center">
            {formatLabel}, {outputFormat.unit}, {outputFormat.zeroOmission} zero omit, {outputFormat.notation} · includes outline, fiducials & README
            {panelArrayFiles && ' · includes Meta-Panelization/ (multi-panel-array Gerber + Excellon)'}
          </p>
          <div className="grid grid-cols-2 gap-2">
            <Button
              variant="outline"
              onClick={openSaveDialog}
              disabled={allLayers.length === 0}
              className="h-9 border-[#1a3a5c] text-[#94b8d4] hover:text-white hover:bg-[#0f2848] text-sm"
            >
              <Save className="w-4 h-4 mr-2" />
              Save Job
            </Button>
            <Button
              variant="outline"
              onClick={openLoadDialog}
              className="h-9 border-[#1a3a5c] text-[#94b8d4] hover:text-white hover:bg-[#0f2848] text-sm"
            >
              <FolderOpen className="w-4 h-4 mr-2" />
              Load Job
            </Button>
          </div>
          <p className="text-[10px] text-[#4a6f94] text-center">
            Saves your uploaded files and every setting — reload it later here or from My CAM Jobs. Each save creates a new job.
          </p>
        </div>
      </CardContent>

      <Dialog open={saveDialogOpen} onOpenChange={setSaveDialogOpen}>
        <DialogContent className="bg-[#0a1e38] border-[#1a3a5c] text-[#f0f8ff]">
          <DialogHeader>
            <DialogTitle className="text-[#f0f8ff]">Save CAM Job</DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <Label className="text-[10px] text-[#4a6f94]">Job Name</Label>
            <Input
              value={jobName}
              onChange={(e) => setJobName(e.target.value)}
              className="h-8 text-sm bg-[#061628] border-[#1a3a5c] text-[#f0f8ff]"
              placeholder="e.g. relay_current_monitoring rev 1.0"
              autoFocus
            />
            <p className="text-[10px] text-[#4a6f94]">
              Saved as &ldquo;{jobName.trim() || '…'}&rdquo; · Revision &ldquo;{panelInfo.revision || '(none)'}&rdquo;
              {' — '}must be unique together. Change the job name or the Revision field (Panel Information, below) to save a new version.
            </p>
          </div>
          <DialogFooter>
            <Button
              onClick={handleSaveJob}
              disabled={!jobName.trim() || savingJob}
              className="bg-[#0ea5e9] hover:bg-[#0ea5e9]/80 text-white"
            >
              {savingJob ? 'Saving...' : 'Save'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={loadDialogOpen} onOpenChange={setLoadDialogOpen}>
        <DialogContent className="bg-[#0a1e38] border-[#1a3a5c] text-[#f0f8ff]">
          <DialogHeader>
            <DialogTitle className="text-[#f0f8ff]">Load CAM Job</DialogTitle>
          </DialogHeader>
          <div className="max-h-80 overflow-y-auto space-y-1.5">
            {jobList === null ? (
              <p className="text-xs text-[#4a6f94] py-4 text-center">Loading...</p>
            ) : jobList.length === 0 ? (
              <p className="text-xs text-[#4a6f94] py-4 text-center">No saved jobs yet.</p>
            ) : (
              jobList.map(job => (
                <div
                  key={job.id}
                  className="flex items-center gap-1.5 rounded-md border border-[#1a3a5c] bg-[#061628]/80 pr-1.5 hover:border-[#0ea5e9] transition-colors"
                >
                  <button
                    onClick={() => handleLoadJob(job.id)}
                    disabled={loadingJobId !== null}
                    className="flex-1 min-w-0 text-left px-3 py-2 disabled:opacity-50"
                  >
                    <div className="text-sm text-[#f0f8ff] truncate">
                      {job.name}
                      {job.revision && <span className="text-[#4a6f94]"> · Rev {job.revision}</span>}
                    </div>
                    <div className="text-[10px] text-[#4a6f94] mt-0.5">
                      {loadingJobId === job.id ? 'Loading...' : new Date(job.updatedAt).toLocaleDateString()}
                    </div>
                  </button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={loadingJobId !== null}
                    onClick={() => setDeletingJob(job)}
                    className="h-7 w-7 p-0 text-[#4a6f94] hover:text-red-400 hover:bg-red-950/30 flex-shrink-0"
                    title="Delete job"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </Button>
                </div>
              ))
            )}
          </div>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!deletingJob} onOpenChange={(open) => !open && setDeletingJob(null)}>
        <AlertDialogContent className="bg-[#0a1e38] border-[#1a3a5c] text-[#f0f8ff]">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-[#f0f8ff]">Delete &ldquo;{deletingJob?.name}&rdquo;?</AlertDialogTitle>
            <AlertDialogDescription className="text-[#94b8d4]">
              This removes the saved job and its uploaded files. This can&apos;t be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="border-[#1a3a5c] text-[#94b8d4] hover:text-white hover:bg-[#0f2848]">
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (deletingJob) handleDeleteJob(deletingJob)
                setDeletingJob(null)
              }}
              className="bg-red-600 hover:bg-red-500 text-white"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  )
}
