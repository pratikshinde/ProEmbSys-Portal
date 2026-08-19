'use client'

import React from 'react'
import { useAppStore } from '@/lib/store'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Separator } from '@/components/ui/separator'
import {
  Cpu, Play, AlertTriangle, CheckCircle2, Settings2, Download, RotateCcw, FileCode, Grid3x3,
} from 'lucide-react'
import { exportGcodeFiles, exportMetaPanelFiles } from '@/lib/gerber-exporter'

const numInputCls = 'h-7 text-xs bg-[#061628] border-[#1a3a5c] text-[#f0f8ff]'
const fieldLabelCls = 'text-[10px] text-[#4a6f94]'
const sectionLabelCls = 'text-xs text-[#94b8d4] font-medium flex items-center gap-1.5'

export default function GcodePanel() {
  const routingResult = useAppStore(s => s.routingResult)
  const routingStale = useAppStore(s => s.routingStale)
  const panelInfo = useAppStore(s => s.panelInfo)
  const gcodeContext = useAppStore(s => s.gcodeContext)
  const updateGcodeContext = useAppStore(s => s.updateGcodeContext)
  const resetGcodeContext = useAppStore(s => s.resetGcodeContext)
  const gcodeFiles = useAppStore(s => s.gcodeFiles)
  const generateGcodeFilesAction = useAppStore(s => s.generateGcodeFilesAction)

  const panelResult = useAppStore(s => s.panelResult)
  const panelArrayConfig = useAppStore(s => s.panelArrayConfig)
  const updatePanelArrayConfig = useAppStore(s => s.updatePanelArrayConfig)
  const resetPanelArrayConfig = useAppStore(s => s.resetPanelArrayConfig)
  const panelArrayResult = useAppStore(s => s.panelArrayResult)
  const panelArrayFiles = useAppStore(s => s.panelArrayFiles)
  const generatePanelArrayFilesAction = useAppStore(s => s.generatePanelArrayFilesAction)

  const [exporting, setExporting] = React.useState(false)
  const [exportingArray, setExportingArray] = React.useState(false)
  // Distinguishes "never generated yet" from "generated and nothing fit" —
  // panelArrayResult is null in both cases, but only the second is a real
  // failure worth a warning banner. Reset whenever the panel itself changes,
  // so a stale failure from a previous panel doesn't reappear immediately
  // for a brand new one.
  const [arrayAttempted, setArrayAttempted] = React.useState(false)
  React.useEffect(() => { setArrayAttempted(false) }, [panelResult])

  const ctx = gcodeContext
  const canGenerate = !!routingResult && routingResult.paths.length > 0
  const hasMaterialCell = !!panelArrayConfig.materialCellWidthMm && !!panelArrayConfig.materialCellHeightMm

  const handleDownload = async () => {
    if (!gcodeFiles || gcodeFiles.length === 0) return
    setExporting(true)
    try {
      await exportGcodeFiles(gcodeFiles, panelInfo, panelArrayFiles?.gcodeFiles)
    } catch (err) {
      console.error('G-code export failed:', err)
      alert('G-code export failed. Check the console for details.')
    } finally {
      setExporting(false)
    }
  }

  const handleDownloadArray = async () => {
    if (!panelArrayFiles) return
    setExportingArray(true)
    try {
      await exportMetaPanelFiles(panelArrayFiles, panelInfo)
    } catch (err) {
      console.error('Meta-panel export failed:', err)
      alert('Meta-panel export failed. Check the console for details.')
    } finally {
      setExportingArray(false)
    }
  }

  return (
    <div className="space-y-4">
    <Card className="border-[#1a3a5c] bg-[#0a1e38]/70">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-semibold flex items-center gap-2 text-[#f0f8ff]">
            <Cpu className="w-4 h-4 text-[#0ea5e9]" />
            G-Code
          </CardTitle>
          <Button
            size="sm"
            variant="ghost"
            onClick={resetGcodeContext}
            className="h-6 px-2 text-[10px] text-[#4a6f94] hover:text-white hover:bg-[#0f2848]"
          >
            <RotateCcw className="w-3 h-3 mr-1" />
            Reset
          </Button>
        </div>
      </CardHeader>

      <CardContent className="pt-0 space-y-4">
        {!routingResult && (
          <p className="text-[10px] text-[#4a6f94]">
            Generate a routing plan on the Routing tab first — G-code sequencing follows the
            planned tool paths exactly (a path boundary is a retract, a point-to-point move
            within a path is a continuous cut).
          </p>
        )}

        {/* -------------------------------------------------------- Z / feeds */}
        <div>
          <Label className={sectionLabelCls}>
            <Settings2 className="w-3 h-3 text-[#0ea5e9]" />
            Heights &amp; Depth
          </Label>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <div>
              <Label className={fieldLabelCls}>Safe Z (mm)</Label>
              <Input
                type="number" step={0.1}
                value={ctx.safeZmm}
                onChange={e => updateGcodeContext({ safeZmm: parseFloat(e.target.value) || 0 })}
                className={numInputCls}
              />
            </div>
            <div>
              <Label className={fieldLabelCls}>Retract Z (mm)</Label>
              <Input
                type="number" step={0.1}
                value={ctx.retractZmm}
                onChange={e => updateGcodeContext({ retractZmm: parseFloat(e.target.value) || 0 })}
                className={numInputCls}
              />
            </div>
            <div>
              <Label className={fieldLabelCls}>Cut/drill depth (mm)</Label>
              <Input
                type="number" step={0.1}
                value={ctx.cutDepthMm}
                onChange={e => updateGcodeContext({ cutDepthMm: parseFloat(e.target.value) || 0 })}
                className={numInputCls}
              />
            </div>
            <div>
              <Label className={fieldLabelCls}>Spindle RPM</Label>
              <Input
                type="number" step={1000}
                value={ctx.spindleRpm}
                onChange={e => updateGcodeContext({ spindleRpm: parseInt(e.target.value) || 0 })}
                className={numInputCls}
              />
            </div>
          </div>
        </div>

        <Separator className="bg-[#1a3a5c]" />

        {/* -------------------------------------------------------------- Feeds */}
        <div>
          <Label className={sectionLabelCls}>Feed Rates</Label>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <div>
              <Label className={fieldLabelCls}>Route Z feed (mm/min)</Label>
              <Input
                type="number" step={10}
                value={ctx.routeZFeedMmPerMin}
                onChange={e => updateGcodeContext({ routeZFeedMmPerMin: parseFloat(e.target.value) || 0 })}
                className={numInputCls}
              />
            </div>
            <div>
              <Label className={fieldLabelCls}>Route XY feed (mm/min)</Label>
              <Input
                type="number" step={10}
                value={ctx.routeXYFeedMmPerMin}
                onChange={e => updateGcodeContext({ routeXYFeedMmPerMin: parseFloat(e.target.value) || 0 })}
                className={numInputCls}
              />
            </div>
            <div>
              <Label className={fieldLabelCls}>
                {ctx.autoFeedByDiameter ? 'Drill feed fallback (mm/min)' : 'Drill feed (mm/min)'}
              </Label>
              <Input
                type="number" step={10}
                value={ctx.drillFeedMmPerMin}
                onChange={e => updateGcodeContext({ drillFeedMmPerMin: parseFloat(e.target.value) || 0 })}
                className={numInputCls}
              />
            </div>
            <div>
              <Label className={fieldLabelCls}>Dwell after spindle start (s)</Label>
              <Input
                type="number" step={1}
                value={ctx.dwellSeconds}
                onChange={e => updateGcodeContext({ dwellSeconds: parseFloat(e.target.value) || 0 })}
                className={numInputCls}
              />
            </div>
          </div>
          <div className="flex items-center justify-between mt-2">
            <Label className="text-xs text-[#94b8d4]" title="Looks up each tool's feed from real shop measurements (2000 down to 500 mm/min across seven real diameters), interpolated between them. Off uses the fallback rate above for every diameter.">
              Auto feed by diameter
            </Label>
            <Switch
              checked={ctx.autoFeedByDiameter}
              onCheckedChange={v => updateGcodeContext({ autoFeedByDiameter: v })}
              className="scale-75"
            />
          </div>
          <p className="text-[10px] text-[#4a6f94] mt-1.5">
            {ctx.autoFeedByDiameter
              ? 'Each drilling program uses a feed rate interpolated from real shop measurements (smaller bits faster, larger bits slower) instead of one flat rate for every diameter.'
              : 'Drill feed applies uniformly to every tool diameter — adjust per your own feeds-and-speeds chart if a bit needs a different rate.'}
          </p>
          <div className="flex items-center justify-between mt-2">
            <Label className="text-xs text-[#94b8d4]" title="Reorders each drilling program's holes (and slots) by nearest-neighbor travel instead of raw file order, to cut down on wasted rapid moves between holes. Turn off to compare against a raw-order sample file, or if your own post-processor already optimizes travel.">
              Optimize drill order (nearest-first)
            </Label>
            <Switch
              checked={ctx.optimizeDrillOrder}
              onCheckedChange={v => updateGcodeContext({ optimizeDrillOrder: v })}
              className="scale-75"
            />
          </div>
          <div className="flex items-center justify-between mt-2">
            <Label className="text-xs text-[#94b8d4]" title="Single-sided boards are drilled with copper facing UP — mirrors every hole/slot X to match the physically flipped panel. Drilling only; the cutting/routing program is unaffected.">
              Mirror drilling (copper-up drilling)
            </Label>
            <Switch
              checked={ctx.mirrorX}
              onCheckedChange={v => updateGcodeContext({ mirrorX: v })}
              className="scale-75"
            />
          </div>
        </div>

        <Separator className="bg-[#1a3a5c]" />

        {/* --------------------------------------------------------- Advanced */}
        <div>
          <Label className={sectionLabelCls}>Advanced</Label>
          <div className="mt-2 space-y-2">
            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label className={fieldLabelCls}>Path tolerance, G64 P (mm)</Label>
                <Input
                  type="number" step={0.001}
                  value={ctx.pathToleranceMm}
                  onChange={e => updateGcodeContext({ pathToleranceMm: parseFloat(e.target.value) || 0 })}
                  className={numInputCls}
                />
              </div>
              <div>
                <Label className={fieldLabelCls}>Work offset</Label>
                <Input
                  type="text"
                  value={ctx.workOffset}
                  onChange={e => updateGcodeContext({ workOffset: e.target.value })}
                  className={numInputCls}
                />
              </div>
            </div>
            <div className="flex items-center justify-between">
              <Label className="text-xs text-[#94b8d4]" title="Emits M64/M65 P0 hold-down pad commands">
                Pressure pad (M64/M65 P0)
              </Label>
              <Switch
                checked={ctx.pressurePad}
                onCheckedChange={v => updateGcodeContext({ pressurePad: v })}
                className="scale-75"
              />
            </div>
          </div>
        </div>

        {/* ---------------------------------------------------- Generate */}
        <Separator className="bg-[#1a3a5c]" />
        <Button
          onClick={generateGcodeFilesAction}
          disabled={!canGenerate}
          className="w-full bg-[#0ea5e9] hover:bg-[#0ea5e9]/80 text-white h-8 text-xs font-medium disabled:opacity-40"
        >
          <Play className="w-3 h-3 mr-1.5" />
          {gcodeFiles ? 'Regenerate G-Code' : 'Generate G-Code'}
        </Button>
        {!canGenerate && (
          <p className="text-[10px] text-[#4a6f94] text-center -mt-2">
            Generate a routing plan on the Routing tab first.
          </p>
        )}

        {routingStale && gcodeFiles && (
          <div className="rounded-md p-2 border bg-yellow-950/40 border-yellow-800/40">
            <div className="flex items-start gap-1.5">
              <AlertTriangle className="w-3 h-3 mt-0.5 text-yellow-500 shrink-0" />
              <div className="text-[10px] text-yellow-300 leading-snug">
                The routing plan changed since this G-code was generated. Regenerate routing,
                then regenerate G-code, before using these files.
              </div>
            </div>
          </div>
        )}

        {/* ------------------------------------------------------ File list */}
        {gcodeFiles && gcodeFiles.length > 0 && (
          <>
            <Separator className="bg-[#1a3a5c]" />
            <div>
              <Label className={sectionLabelCls}>
                <CheckCircle2 className="w-3 h-3 text-[#0ea5e9]" />
                Files
              </Label>
              <div className="mt-2 bg-[#061628]/80 rounded-md p-2 space-y-1 max-h-40 overflow-y-auto">
                {gcodeFiles.map(f => (
                  <div key={f.filename} className="flex items-center gap-1.5 text-[10px] font-mono text-[#94b8d4]">
                    <FileCode className="w-3 h-3 text-[#2d5578] shrink-0" />
                    {f.filename}
                  </div>
                ))}
              </div>
            </div>

            <Button
              onClick={handleDownload}
              disabled={exporting}
              className="w-full h-9 bg-[#0ea5e9] hover:bg-[#0ea5e9]/80 text-white text-sm disabled:opacity-40"
            >
              <Download className="w-4 h-4 mr-1.5" />
              {exporting ? 'Preparing…' : 'Download G-Code Files'}
            </Button>
            <p className="text-[10px] text-[#4a6f94] text-center -mt-2">
              LinuxCNC RS274NGC dialect, verified byte-for-byte against real shop files. One
              cutting program per bit diameter, one drilling program per hole diameter.
            </p>
          </>
        )}
      </CardContent>
    </Card>

    <Card className="border-[#1a3a5c] bg-[#0a1e38]/70">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-semibold flex items-center gap-2 text-[#f0f8ff]">
            <Grid3x3 className="w-4 h-4 text-[#0ea5e9]" />
            Multi-Panel Array (CNC Batch)
          </CardTitle>
          <Button
            size="sm"
            variant="ghost"
            onClick={resetPanelArrayConfig}
            className="h-6 px-2 text-[10px] text-[#4a6f94] hover:text-white hover:bg-[#0f2848]"
          >
            <RotateCcw className="w-3 h-3 mr-1" />
            Reset
          </Button>
        </div>
      </CardHeader>

      <CardContent className="pt-0 space-y-4">
        <p className="text-[10px] text-[#4a6f94]">
          Tile copies of this panel across a bigger raw-material sheet to batch-drill several
          panels in one CNC run. Rout the corner marks into a blank sacrificial board first,
          register each already-fabricated panel copy against them and tape it down, then run
          the batch drilling program. Depaneling each copy is still a separate, later, per-panel
          step through the Routing tab above.
        </p>

        {!panelResult && (
          <p className="text-[10px] text-[#4a6f94]">
            Create a panel on the Panel Config tab first — the array tiles copies of that
            panel&apos;s own size.
          </p>
        )}

        <div className="flex items-center justify-between">
          <Label className="text-xs text-[#94b8d4]">Enable</Label>
          <Switch
            checked={panelArrayConfig.enabled}
            onCheckedChange={v => updatePanelArrayConfig({ enabled: v })}
            className="scale-75"
          />
        </div>

        {panelArrayConfig.enabled && (
          <>
            <Separator className="bg-[#1a3a5c]" />
            <div>
              <Label className={sectionLabelCls}>CNC{!hasMaterialCell && ' & Material'}</Label>
              <div className="mt-2 grid grid-cols-2 gap-2">
                <div>
                  <Label className={fieldLabelCls}>CNC Max X (mm)</Label>
                  <Input
                    type="number" step={10}
                    value={panelArrayConfig.cncMaxXmm}
                    onChange={e => updatePanelArrayConfig({ cncMaxXmm: parseFloat(e.target.value) || 0 })}
                    className={numInputCls}
                  />
                </div>
                <div>
                  <Label className={fieldLabelCls}>CNC Max Y (mm)</Label>
                  <Input
                    type="number" step={10}
                    value={panelArrayConfig.cncMaxYmm}
                    onChange={e => updatePanelArrayConfig({ cncMaxYmm: parseFloat(e.target.value) || 0 })}
                    className={numInputCls}
                  />
                </div>
                {!hasMaterialCell && (
                  <>
                    <div>
                      <Label className={fieldLabelCls}>Material X (mm)</Label>
                      <Input
                        type="number" step={10}
                        value={panelArrayConfig.materialXmm}
                        onChange={e => updatePanelArrayConfig({ materialXmm: parseFloat(e.target.value) || 0 })}
                        className={numInputCls}
                      />
                    </div>
                    <div>
                      <Label className={fieldLabelCls}>Material Y (mm)</Label>
                      <Input
                        type="number" step={10}
                        value={panelArrayConfig.materialYmm}
                        onChange={e => updatePanelArrayConfig({ materialYmm: parseFloat(e.target.value) || 0 })}
                        className={numInputCls}
                      />
                    </div>
                  </>
                )}
              </div>
              <p className="text-[10px] text-[#4a6f94] mt-1.5">
                {hasMaterialCell
                  ? 'A material cell IS your material — one physical block per panel — so only the CNC’s own travel limit bounds the array.'
                  : 'The array fits within whichever is smaller per axis — the CNC’s own travel limit or the material sheet on hand.'}
              </p>
            </div>

            <Separator className="bg-[#1a3a5c]" />

            <div>
              <Label className={sectionLabelCls}>Orientation &amp; Manual Layout</Label>
              <div className="mt-2 flex items-center justify-between">
                <div>
                  <Label className={fieldLabelCls}>Rotate panel 90° on sheet</Label>
                  <p className="text-[9px] text-[#4a6f94] mt-0.5 max-w-[220px]">
                    Swaps the panel&apos;s width/height for fitting and rotates every hole,
                    slot, and mark to match — use when the panel fits the sheet sideways
                    but not upright.
                  </p>
                </div>
                <Switch
                  checked={panelArrayConfig.rotatePanel90}
                  onCheckedChange={v => updatePanelArrayConfig({ rotatePanel90: v })}
                  className="scale-75"
                />
              </div>
              <div className="mt-2 flex items-center justify-between">
                <div>
                  <Label className={fieldLabelCls}>Mirror drilling for copper-up drilling</Label>
                  <p className="text-[9px] text-[#4a6f94] mt-0.5 max-w-[220px]">
                    Single-sided boards are drilled with copper facing UP — mirrors every
                    hole/slot X to match the physically flipped panel. Drilling only; the
                    routing/cutting program and the corner marks are unaffected.
                  </p>
                </div>
                <Switch
                  checked={panelArrayConfig.mirrorX}
                  onCheckedChange={v => updatePanelArrayConfig({ mirrorX: v })}
                  className="scale-75"
                />
              </div>
              <div className="mt-2 grid grid-cols-2 gap-2">
                <div>
                  <Label className={fieldLabelCls}>Manual columns (blank = auto)</Label>
                  <Input
                    type="number" min={0} step={1}
                    value={panelArrayConfig.manualCols ?? ''}
                    onChange={e => {
                      const v = e.target.value.trim()
                      updatePanelArrayConfig({ manualCols: v === '' ? null : Math.max(0, parseInt(v, 10) || 0) })
                    }}
                    placeholder="Auto"
                    className={numInputCls}
                  />
                </div>
                <div>
                  <Label className={fieldLabelCls}>Manual rows (blank = auto)</Label>
                  <Input
                    type="number" min={0} step={1}
                    value={panelArrayConfig.manualRows ?? ''}
                    onChange={e => {
                      const v = e.target.value.trim()
                      updatePanelArrayConfig({ manualRows: v === '' ? null : Math.max(0, parseInt(v, 10) || 0) })
                    }}
                    placeholder="Auto"
                    className={numInputCls}
                  />
                </div>
              </div>
              <p className="text-[10px] text-[#4a6f94] mt-1.5">
                Both fields must be set (and &gt; 0) to force an exact layout — leave either
                blank to auto-fit from CNC/material bounds as usual. A forced layout that
                exceeds those bounds still generates (it&apos;s your explicit call), but shows
                a warning below rather than silently producing scrap tool paths.
              </p>
            </div>

            <Separator className="bg-[#1a3a5c]" />

            <div>
              <Label className={sectionLabelCls}>Material Cell Size</Label>
              <p className="text-[10px] text-[#4a6f94] mt-1 mb-2">
                The size of the physical block (MDF backing, pre-cut blank, etc.) that holds
                ONE panel copy — e.g. a 100×191mm panel on a 115×200mm block. The panel is
                centered inside it automatically; blocks tile edge-to-edge with no extra gap
                needed, since the spacing between panels is already the two blocks&apos; own
                margins combined. Leave both blank to tile the panel&apos;s own raw size directly.
              </p>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <Label className={fieldLabelCls}>Material cell width (mm)</Label>
                  <Input
                    type="number" min={0} step={1}
                    value={panelArrayConfig.materialCellWidthMm ?? ''}
                    onChange={e => {
                      const v = e.target.value.trim()
                      updatePanelArrayConfig({ materialCellWidthMm: v === '' ? null : parseFloat(v) || null })
                    }}
                    placeholder="Panel width"
                    className={numInputCls}
                  />
                </div>
                <div>
                  <Label className={fieldLabelCls}>Material cell height (mm)</Label>
                  <Input
                    type="number" min={0} step={1}
                    value={panelArrayConfig.materialCellHeightMm ?? ''}
                    onChange={e => {
                      const v = e.target.value.trim()
                      updatePanelArrayConfig({ materialCellHeightMm: v === '' ? null : parseFloat(v) || null })
                    }}
                    placeholder="Panel height"
                    className={numInputCls}
                  />
                </div>
              </div>
              {panelResult && panelArrayConfig.materialCellWidthMm && panelArrayConfig.materialCellHeightMm && (() => {
                const effW = panelArrayConfig.rotatePanel90 ? panelResult.panelHeight : panelResult.panelWidth
                const effH = panelArrayConfig.rotatePanel90 ? panelResult.panelWidth : panelResult.panelHeight
                const marginX = Math.max(0, (panelArrayConfig.materialCellWidthMm - effW) / 2)
                const marginY = Math.max(0, (panelArrayConfig.materialCellHeightMm - effH) / 2)
                return (
                  <p className="text-[10px] text-[#4a6f94] mt-1.5">
                    Panel centered with {marginX.toFixed(2)}mm / {marginY.toFixed(2)}mm margin per side on X/Y.
                  </p>
                )
              })()}
            </div>

            <Separator className="bg-[#1a3a5c]" />

            <div>
              <Label className={sectionLabelCls}>Corner Marks</Label>
              <div className="mt-2 grid grid-cols-2 gap-2">
                <div>
                  <Label className={fieldLabelCls}>Arm length (mm)</Label>
                  <Input
                    type="number" step={0.5}
                    value={panelArrayConfig.markArmLengthMm}
                    onChange={e => updatePanelArrayConfig({ markArmLengthMm: parseFloat(e.target.value) || 0 })}
                    className={numInputCls}
                  />
                </div>
                <div>
                  <Label className={fieldLabelCls}>Line width (mm)</Label>
                  <Input
                    type="number" step={0.01}
                    value={panelArrayConfig.markLineWidthMm}
                    onChange={e => updatePanelArrayConfig({ markLineWidthMm: parseFloat(e.target.value) || 0 })}
                    className={numInputCls}
                  />
                </div>
                <div className="col-span-2">
                  <Label className={fieldLabelCls}>Mark routing cut depth (mm)</Label>
                  <Input
                    type="number" step={0.1}
                    value={panelArrayConfig.markCutDepthMm}
                    onChange={e => updatePanelArrayConfig({ markCutDepthMm: parseFloat(e.target.value) || 0 })}
                    className={numInputCls}
                  />
                </div>
              </div>
              <p className="text-[10px] text-[#4a6f94] mt-1.5">
                Separate from the routing depth above — these marks cut into a blank sacrificial
                board, not the customer&apos;s own board. The arm length is automatically capped to at
                most half of the smaller gap, so one panel&apos;s marks can never overlap a neighbour&apos;s.
              </p>
            </div>

            <Separator className="bg-[#1a3a5c]" />
            <Button
              onClick={() => { setArrayAttempted(true); generatePanelArrayFilesAction() }}
              disabled={!panelResult}
              className="w-full bg-[#0ea5e9] hover:bg-[#0ea5e9]/80 text-white h-8 text-xs font-medium disabled:opacity-40"
            >
              <Play className="w-3 h-3 mr-1.5" />
              {panelArrayFiles ? 'Regenerate Array Files' : 'Generate Array Files'}
            </Button>
            {!panelResult && (
              <p className="text-[10px] text-[#4a6f94] text-center -mt-2">
                Create a panel on the Panel Config tab first.
              </p>
            )}

            {/* Only shown after an actual attempt — panelArrayResult being
                null also describes the "never generated yet" state, which
                must not read as a failure. */}
            {arrayAttempted && panelResult && !panelArrayResult && panelArrayFiles === null && (
              <div className="rounded-md p-2 border bg-yellow-950/40 border-yellow-800/40">
                <div className="flex items-start gap-1.5">
                  <AlertTriangle className="w-3 h-3 mt-0.5 text-yellow-500 shrink-0" />
                  <div className="text-[10px] text-yellow-300 leading-snug">
                    Nothing fits — the panel ({panelResult.panelWidth.toFixed(0)}×{panelResult.panelHeight.toFixed(0)}mm)
                    is too big for the CNC/material bound with the current gaps and margin.
                  </div>
                </div>
              </div>
            )}

            {panelArrayResult && (
              <div className="bg-[#061628]/80 rounded-md p-2 text-[10px] font-mono text-[#94b8d4] space-y-0.5">
                <div>Layout: {panelArrayResult.cols} × {panelArrayResult.rows} = {panelArrayResult.totalPanels} panels{panelArrayConfig.rotatePanel90 ? ' (rotated 90°)' : ''}{panelArrayConfig.mirrorX ? ' (mirrored)' : ''}</div>
                <div>Cell footprint: {panelArrayResult.cellWidthMm.toFixed(1)} × {panelArrayResult.cellHeightMm.toFixed(1)}mm</div>
                <div>Sheet size: {panelArrayResult.sheetWidthMm.toFixed(1)} × {panelArrayResult.sheetHeightMm.toFixed(1)}mm</div>
                <div>Mark arm (effective): {panelArrayResult.effectiveMarkArmLengthMm.toFixed(2)}mm</div>
              </div>
            )}

            {panelArrayResult?.exceedsBounds && (
              <div className="rounded-md p-2 border bg-yellow-950/40 border-yellow-800/40">
                <div className="flex items-start gap-1.5">
                  <AlertTriangle className="w-3 h-3 mt-0.5 text-yellow-500 shrink-0" />
                  <div className="text-[10px] text-yellow-300 leading-snug">
                    This manual layout&apos;s sheet ({panelArrayResult.sheetWidthMm.toFixed(1)}×{panelArrayResult.sheetHeightMm.toFixed(1)}mm)
                    exceeds the CNC/material bound. Generated as requested, but confirm this
                    actually fits your setup before cutting.
                  </div>
                </div>
              </div>
            )}

            {panelArrayFiles && (
              <>
                <Separator className="bg-[#1a3a5c]" />
                <div>
                  <Label className={sectionLabelCls}>
                    <CheckCircle2 className="w-3 h-3 text-[#0ea5e9]" />
                    Files
                    {panelArrayFiles.mirroredX && (
                      <span className="text-[9px] font-normal text-yellow-400">(drilling mirrored — copper-up)</span>
                    )}
                  </Label>
                  <div className="mt-2 bg-[#061628]/80 rounded-md p-2 space-y-1 max-h-40 overflow-y-auto">
                    <div className="flex items-center gap-1.5 text-[10px] font-mono text-[#94b8d4]">
                      <FileCode className="w-3 h-3 text-[#2d5578] shrink-0" />
                      {panelArrayFiles.borderMarksGerberFilename}
                    </div>
                    <div className="flex items-center gap-1.5 text-[10px] font-mono text-[#94b8d4]">
                      <FileCode className="w-3 h-3 text-[#2d5578] shrink-0" />
                      {panelArrayFiles.drillFilename}
                    </div>
                    {panelArrayFiles.gcodeFiles.map(f => (
                      <div key={f.filename} className="flex items-center gap-1.5 text-[10px] font-mono text-[#94b8d4]">
                        <FileCode className="w-3 h-3 text-[#2d5578] shrink-0" />
                        {f.filename}
                      </div>
                    ))}
                  </div>
                </div>

                <Button
                  onClick={handleDownloadArray}
                  disabled={exportingArray}
                  className="w-full h-9 bg-[#0ea5e9] hover:bg-[#0ea5e9]/80 text-white text-sm disabled:opacity-40"
                >
                  <Download className="w-4 h-4 mr-1.5" />
                  {exportingArray ? 'Preparing…' : 'Download Meta-Panel Files'}
                </Button>
                <p className="text-[10px] text-[#4a6f94] text-center -mt-2">
                  Gerber + Excellon + G-code for this array. The Gerber and Excellon files also
                  ride along in the main &quot;Export Panelized Gerbers&quot; ZIP on the Info &amp; Export
                  tab, under a Meta-Panelization/ subfolder.
                </p>
              </>
            )}
          </>
        )}
      </CardContent>
    </Card>
    </div>
  )
}
