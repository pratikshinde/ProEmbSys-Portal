'use client'

import React from 'react'
import { useAppStore } from '@/lib/store'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Separator } from '@/components/ui/separator'
import { Stamp, Play, AlertTriangle, CheckCircle2, Download, RotateCcw, FileCode } from 'lucide-react'
import { exportStencilFiles } from '@/lib/gerber-exporter'

const numInputCls = 'h-7 text-xs bg-[#061628] border-[#1a3a5c] text-[#f0f8ff]'
const fieldLabelCls = 'text-[10px] text-[#4a6f94]'
const sectionLabelCls = 'text-xs text-[#94b8d4] font-medium flex items-center gap-1.5'

export default function StencilPanel() {
  const stencilConfig = useAppStore(s => s.stencilConfig)
  const updateStencilConfig = useAppStore(s => s.updateStencilConfig)
  const resetStencilConfig = useAppStore(s => s.resetStencilConfig)
  const stencilFiles = useAppStore(s => s.stencilFiles)
  const stencilGenerating = useAppStore(s => s.stencilGenerating)
  const generateStencilFilesAction = useAppStore(s => s.generateStencilFilesAction)
  const panelResult = useAppStore(s => s.panelResult)
  const panelInfo = useAppStore(s => s.panelInfo)
  const activeDesignId = useAppStore(s => s.activeDesignId)
  const layers = useAppStore(s => s.layers)

  const [exporting, setExporting] = React.useState(false)

  const hasTopPaste = layers.some(l => l.type === 'paste' && l.side === 'top')
  const hasBottomPaste = layers.some(l => l.type === 'paste' && l.side === 'bottom')
  const noSideSelected = !stencilConfig.includeTopPaste && !stencilConfig.includeBottomPaste
  const scopeReady = stencilConfig.scope === 'panel' ? !!panelResult : !!activeDesignId
  const canGenerate = scopeReady && !noSideSelected && !stencilGenerating

  const handleDownload = async () => {
    if (!stencilFiles || stencilFiles.length === 0) return
    setExporting(true)
    try {
      await exportStencilFiles(stencilFiles, panelInfo)
    } catch (err) {
      console.error('Stencil export failed:', err)
      alert('Stencil export failed. Check the console for details.')
    } finally {
      setExporting(false)
    }
  }

  return (
    <div className="space-y-4">
      <Card className="border-[#1a3a5c] bg-[#0a1e38]/70">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm font-semibold flex items-center gap-2 text-[#f0f8ff]">
              <Stamp className="w-4 h-4 text-[#0ea5e9]" />
              Stencil
            </CardTitle>
            <Button
              size="sm"
              variant="ghost"
              onClick={resetStencilConfig}
              className="h-6 px-2 text-[10px] text-[#4a6f94] hover:text-white hover:bg-[#0f2848]"
            >
              <RotateCcw className="w-3 h-3 mr-1" />
              Reset
            </Button>
          </div>
        </CardHeader>

        <CardContent className="pt-0 space-y-4">
          <p className="text-[10px] text-[#4a6f94]">
            Exports a DXF of the solder-paste apertures for laser-cutting your own stencil on
            0.15mm/0.25mm Mylar. Rounded/macro pad shapes are reproduced as the convex hull of
            their real geometry.
          </p>

          {/* -------------------------------------------------------- Scope */}
          <div>
            <Label className={fieldLabelCls}>Scope</Label>
            <div className="grid grid-cols-2 gap-1 mt-1">
              <Button
                size="sm"
                variant={stencilConfig.scope === 'single' ? 'default' : 'outline'}
                onClick={() => updateStencilConfig({ scope: 'single' })}
                className={`h-7 px-2 text-xs leading-tight ${stencilConfig.scope !== 'single' ? 'border-[#1a3a5c] text-[#94b8d4] hover:text-white hover:bg-[#0f2848]' : 'bg-[#0ea5e9] text-white'}`}
                title="Single PCB — just the active design's own geometry"
              >
                Single PCB
              </Button>
              <Button
                size="sm"
                variant={stencilConfig.scope === 'panel' ? 'default' : 'outline'}
                onClick={() => updateStencilConfig({ scope: 'panel' })}
                disabled={!panelResult}
                className={`h-7 px-2 text-xs leading-tight disabled:opacity-40 ${stencilConfig.scope !== 'panel' ? 'border-[#1a3a5c] text-[#94b8d4] hover:text-white hover:bg-[#0f2848]' : 'bg-[#0ea5e9] text-white'}`}
                title="Whole Panel — tiled across every computed placement"
              >
                Whole Panel
              </Button>
            </div>
            {stencilConfig.scope === 'panel' && !panelResult && (
              <p className="text-[10px] text-[#4a6f94] mt-1.5">
                Create a panel on the Panel Config tab first.
              </p>
            )}
          </div>

          <Separator className="bg-[#1a3a5c]" />

          {/* --------------------------------------------------- Layer source */}
          <div>
            <Label className={sectionLabelCls}>Paste Layer Source</Label>
            <div className="mt-2 space-y-2">
              <div className="flex items-center justify-between">
                <Label className="text-xs text-[#94b8d4]">
                  Include Top Paste{!hasTopPaste && ' (not loaded)'}
                </Label>
                <Switch
                  checked={stencilConfig.includeTopPaste}
                  onCheckedChange={v => updateStencilConfig({ includeTopPaste: v })}
                  className="scale-75"
                />
              </div>
              <div className="flex items-center justify-between">
                <Label className="text-xs text-[#94b8d4]">
                  Include Bottom Paste{!hasBottomPaste && ' (not loaded)'}
                </Label>
                <Switch
                  checked={stencilConfig.includeBottomPaste}
                  onCheckedChange={v => updateStencilConfig({ includeBottomPaste: v })}
                  className="scale-75"
                />
              </div>
            </div>
            {noSideSelected && (
              <p className="text-[10px] text-[#4a6f94] mt-1.5">
                Select at least one side to generate a stencil.
              </p>
            )}
          </div>

          <Separator className="bg-[#1a3a5c]" />

          {/* ------------------------------------------------------ Reduction */}
          <div>
            <Label className={fieldLabelCls}>Aperture reduction (%)</Label>
            <Input
              type="number" min={0} max={90} step={1}
              value={stencilConfig.reductionPct}
              onChange={e => updateStencilConfig({ reductionPct: Math.max(0, Math.min(90, parseFloat(e.target.value) || 0)) })}
              className={numInputCls}
            />
            <p className="text-[10px] text-[#4a6f94] mt-1.5">
              Shrinks each pad opening around its own center — 0 cuts the exact pad size; a
              small reduction (e.g. 10-20%) helps prevent solder bridging on fine-pitch parts.
            </p>
          </div>

          <Separator className="bg-[#1a3a5c]" />

          {/* -------------------------------------------------------- Outline */}
          <div className="flex items-center justify-between">
            <Label className="text-xs text-[#94b8d4]">Include board/panel outline (scribe line)</Label>
            <Switch
              checked={stencilConfig.includeOutline}
              onCheckedChange={v => updateStencilConfig({ includeOutline: v })}
              className="scale-75"
            />
          </div>

          {/* ---------------------------------------------------- Generate */}
          <Separator className="bg-[#1a3a5c]" />
          <Button
            onClick={generateStencilFilesAction}
            disabled={!canGenerate}
            className="w-full bg-[#0ea5e9] hover:bg-[#0ea5e9]/80 text-white h-8 text-xs font-medium disabled:opacity-40"
          >
            <Play className="w-3 h-3 mr-1.5" />
            {stencilGenerating ? 'Generating…' : stencilFiles ? 'Regenerate Stencil' : 'Generate Stencil'}
          </Button>
          {!scopeReady && (
            <p className="text-[10px] text-[#4a6f94] text-center -mt-2">
              {stencilConfig.scope === 'panel'
                ? 'Create a panel on the Panel Config tab first.'
                : 'Import a board first.'}
            </p>
          )}

          {/* ------------------------------------------------------ File list */}
          {stencilFiles && stencilFiles.length > 0 && (
            <>
              <Separator className="bg-[#1a3a5c]" />
              <div>
                <Label className={sectionLabelCls}>
                  <CheckCircle2 className="w-3 h-3 text-[#0ea5e9]" />
                  Files
                </Label>
                <div className="mt-2 bg-[#061628]/80 rounded-md p-2 space-y-1 max-h-40 overflow-y-auto">
                  {stencilFiles.map(f => (
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
                {exporting ? 'Preparing…' : 'Download Stencil Files'}
              </Button>
              <p className="text-[10px] text-[#4a6f94] text-center -mt-2">
                DXF R12, millimetres. No CAD viewer is available here to preview the file
                visually — open it in your own laser-cutter software or a DXF viewer before
                cutting real Mylar.
              </p>
            </>
          )}

          {(stencilConfig.includeTopPaste && !hasTopPaste) || (stencilConfig.includeBottomPaste && !hasBottomPaste) ? (
            <div className="rounded-md p-2 border bg-yellow-950/40 border-yellow-800/40">
              <div className="flex items-start gap-1.5">
                <AlertTriangle className="w-3 h-3 mt-0.5 text-yellow-500 shrink-0" />
                <div className="text-[10px] text-yellow-300 leading-snug">
                  A selected side has no matching paste layer loaded — that side&apos;s DXF will
                  come out empty.
                </div>
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  )
}
