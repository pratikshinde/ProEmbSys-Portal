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
  Cpu, Play, AlertTriangle, CheckCircle2, Settings2, Download, RotateCcw, FileCode,
} from 'lucide-react'
import { exportGcodeFiles } from '@/lib/gerber-exporter'

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

  const [exporting, setExporting] = React.useState(false)

  const ctx = gcodeContext
  const canGenerate = !!routingResult && routingResult.paths.length > 0

  const handleDownload = async () => {
    if (!gcodeFiles || gcodeFiles.length === 0) return
    setExporting(true)
    try {
      await exportGcodeFiles(gcodeFiles, panelInfo)
    } catch (err) {
      console.error('G-code export failed:', err)
      alert('G-code export failed. Check the console for details.')
    } finally {
      setExporting(false)
    }
  }

  return (
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
  )
}
