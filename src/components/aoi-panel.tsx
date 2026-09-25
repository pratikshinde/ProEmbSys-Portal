'use client'

import React from 'react'
import { useAppStore } from '@/lib/store'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Separator } from '@/components/ui/separator'
import { ScanEye, Play, AlertTriangle, CheckCircle2, Download, RotateCcw, FileImage, FileJson } from 'lucide-react'
import { exportAoiFiles } from '@/lib/gerber-exporter'
import { rasterDimensions } from '@/lib/aoi/plot-to-raster'
import { AOI_MIN_PX_PER_MM, AOI_MAX_CANVAS_PX, AOI_MAX_DIM_PX, type AoiManifest } from '@/lib/aoi/types'
import { resolveDesignGeometry } from '@/lib/panelization-engine'

const numInputCls = 'h-7 text-xs bg-[#061628] border-[#1a3a5c] text-[#f0f8ff]'
const fieldLabelCls = 'text-[10px] text-[#4a6f94]'
const sectionLabelCls = 'text-xs text-[#94b8d4] font-medium flex items-center gap-1.5'

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

export default function AoiPanel() {
  const aoiConfig = useAppStore(s => s.aoiConfig)
  const updateAoiConfig = useAppStore(s => s.updateAoiConfig)
  const resetAoiConfig = useAppStore(s => s.resetAoiConfig)
  const aoiFiles = useAppStore(s => s.aoiFiles)
  const aoiGenerating = useAppStore(s => s.aoiGenerating)
  const generateAoiFilesAction = useAppStore(s => s.generateAoiFilesAction)
  const panelInfo = useAppStore(s => s.panelInfo)
  const layers = useAppStore(s => s.layers)
  const designs = useAppStore(s => s.designs)
  const activeDesignId = useAppStore(s => s.activeDesignId)

  const [exporting, setExporting] = React.useState(false)

  const hasTopCopper = layers.some(l => l.type === 'copper' && l.side === 'top')
  const hasBottomCopper = layers.some(l => l.type === 'copper' && l.side === 'bottom')
  const noSideSelected = !aoiConfig.includeTop && !aoiConfig.includeBottom

  // The SAME "which design" resolution `generateAoiFilesAction` uses — AOI
  // always exports one board's own artwork, never the whole tiled panel, so
  // the live size estimate has to be sized off THAT board, not the panel.
  const designId = activeDesignId ?? designs[0]?.id ?? layers[0]?.designId ?? null
  const designGeometry = React.useMemo(() => {
    if (!designId) return null
    // Resolved as if every layer were visible — same reasoning as
    // generateAoiFilesAction's own comment: hide/show in the Layers panel is
    // a viewer-only convenience and must never change whether AOI generation
    // is even possible, or the board size it reports here.
    const designLayers = layers.filter(l => l.designId === designId).map(l => ({ ...l, visible: true }))
    return resolveDesignGeometry(designLayers)
  }, [layers, designId])

  // Deliberately NOT gated on a computed panel — AOI exports one board's own
  // artwork and never reads panel geometry at all (see generateAoiFilesAction's
  // own comment on this), so requiring "Create Panel" first was pure friction.
  const scopeReady = !!designGeometry

  const { widthPx, heightPx } = designGeometry
    ? rasterDimensions(designGeometry.widthMm, designGeometry.heightMm, aoiConfig.pxPerMm)
    : { widthPx: 0, heightPx: 0 }
  const areaPx = widthPx * heightPx
  const sizeTooLarge = scopeReady && (widthPx > AOI_MAX_DIM_PX || heightPx > AOI_MAX_DIM_PX || areaPx > AOI_MAX_CANVAS_PX)
  // Ballpark real-world PNG sizes — not exact (they depend on how much of the
  // board is actually copper), just enough to warn before a multi-minute
  // generate on an oversized image. A drill mask is mostly empty ground with a
  // sparse scatter of discs, so it deflates far harder than copper artwork.
  const estimatedCopperBytes = Math.round(areaPx / 8 / 6)
  const estimatedDrillBytes = Math.round(areaPx / 8 / 60)
  const sidesCount = (aoiConfig.includeTop ? 1 : 0) + (aoiConfig.includeBottom ? 1 : 0)
  const imageCount = sidesCount * 2
  const estimatedTotalBytes = sidesCount * (estimatedCopperBytes + estimatedDrillBytes)

  const canGenerate = scopeReady && !noSideSelected && !sizeTooLarge && !aoiGenerating

  const manifest = React.useMemo(() => {
    const f = aoiFiles?.find(f => f.filename === 'aoi.json')
    if (!f || f.kind !== 'text') return null
    try {
      return JSON.parse(f.content) as AoiManifest
    } catch {
      return null
    }
  }, [aoiFiles])

  const handleDownload = async () => {
    if (!aoiFiles || aoiFiles.length === 0) return
    setExporting(true)
    try {
      await exportAoiFiles(aoiFiles, panelInfo)
    } catch (err) {
      console.error('AOI export failed:', err)
      alert('AOI export failed. Check the console for details.')
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
              <ScanEye className="w-4 h-4 text-[#0ea5e9]" />
              AOI Reference
            </CardTitle>
            <Button
              size="sm"
              variant="ghost"
              onClick={resetAoiConfig}
              className="h-6 px-2 text-[10px] text-[#4a6f94] hover:text-white hover:bg-[#0f2848]"
            >
              <RotateCcw className="w-3 h-3 mr-1" />
              Reset
            </Button>
          </div>
        </CardHeader>

        <CardContent className="pt-0 space-y-4">
          <p className="text-[10px] text-[#4a6f94]">
            Generates a binary copper reference (with every drilled hole already punched out,
            so plated pads render as real donuts) plus a supplementary drill mask per side
            (PNGs + a JSON sidecar) of the active design&apos;s own single board — never the
            whole panel tiled — for an external optical-inspection app to compare a
            photographed board against. Bottom images are mirrored to match how a camera sees
            the board once flipped over.
          </p>

          {/* --------------------------------------------------- Layer source */}
          <div>
            <Label className={sectionLabelCls}>Copper Source</Label>
            <div className="mt-2 space-y-2">
              <div className="flex items-center justify-between">
                <Label className="text-xs text-[#94b8d4]">
                  Include Top Copper{!hasTopCopper && ' (not loaded)'}
                </Label>
                <Switch
                  checked={aoiConfig.includeTop}
                  onCheckedChange={v => updateAoiConfig({ includeTop: v })}
                  className="scale-75"
                />
              </div>
              <div className="flex items-center justify-between">
                <Label className="text-xs text-[#94b8d4]">
                  Include Bottom Copper{!hasBottomCopper && ' (not loaded)'}
                </Label>
                <Switch
                  checked={aoiConfig.includeBottom}
                  onCheckedChange={v => updateAoiConfig({ includeBottom: v })}
                  className="scale-75"
                />
              </div>
            </div>
            {noSideSelected && (
              <p className="text-[10px] text-[#4a6f94] mt-1.5">
                Select at least one side to generate a reference.
              </p>
            )}
          </div>

          <Separator className="bg-[#1a3a5c]" />

          {/* ----------------------------------------------------- Resolution */}
          <div>
            <Label className={fieldLabelCls}>Resolution (px/mm)</Label>
            <Input
              type="number" min={AOI_MIN_PX_PER_MM} max={60} step={1}
              value={aoiConfig.pxPerMm}
              onChange={e => updateAoiConfig({ pxPerMm: Math.max(AOI_MIN_PX_PER_MM, Math.min(60, parseFloat(e.target.value) || AOI_MIN_PX_PER_MM)) })}
              className={numInputCls}
            />
            {scopeReady ? (
              <p className={`text-[10px] mt-1.5 ${sizeTooLarge ? 'text-red-400' : 'text-[#4a6f94]'}`}>
                {widthPx.toLocaleString()} × {heightPx.toLocaleString()} px per image · {imageCount} image
                {imageCount === 1 ? '' : 's'} (copper + drill mask per side) · ~{formatBytes(estimatedTotalBytes)} total
                {sizeTooLarge && ' — too large, lower the resolution'}
              </p>
            ) : layers.length === 0 ? (
              <p className="text-[10px] text-[#4a6f94] mt-1.5">Import Gerber files first.</p>
            ) : (
              <p className="text-[10px] text-[#4a6f94] mt-1.5">
                The active design has no layer with usable bounds (e.g. an outline or copper
                layer) — cannot size an AOI reference for it.
              </p>
            )}
          </div>

          <Separator className="bg-[#1a3a5c]" />

          {/* -------------------------------------------------------- Invert */}
          <div className="flex items-center justify-between">
            <Label className="text-xs text-[#94b8d4]">Copper = black (invert)</Label>
            <Switch
              checked={aoiConfig.invertOutput}
              onCheckedChange={v => updateAoiConfig({ invertOutput: v })}
              className="scale-75"
            />
          </div>
          <p className="text-[10px] text-[#4a6f94] -mt-2">
            Default is copper = white on black. Either way, aoi.json declares the actual
            copper pixel value per image — the app should read it, not assume.
          </p>

          {/* ---------------------------------------------------- Generate */}
          <Separator className="bg-[#1a3a5c]" />
          <Button
            onClick={generateAoiFilesAction}
            disabled={!canGenerate}
            className="w-full bg-[#0ea5e9] hover:bg-[#0ea5e9]/80 text-white h-8 text-xs font-medium disabled:opacity-40"
          >
            <Play className="w-3 h-3 mr-1.5" />
            {aoiGenerating ? 'Generating…' : aoiFiles ? 'Regenerate Reference' : 'Generate Reference'}
          </Button>

          {/* ------------------------------------------------------ File list */}
          {aoiFiles && aoiFiles.length > 0 && (
            <>
              <Separator className="bg-[#1a3a5c]" />
              <div>
                <Label className={sectionLabelCls}>
                  <CheckCircle2 className="w-3 h-3 text-[#0ea5e9]" />
                  Files
                </Label>
                <div className="mt-2 bg-[#061628]/80 rounded-md p-2 space-y-1 max-h-40 overflow-y-auto">
                  {aoiFiles.map(f => (
                    <div key={f.filename} className="flex items-center gap-1.5 text-[10px] font-mono text-[#94b8d4]">
                      {f.kind === 'binary'
                        ? <FileImage className="w-3 h-3 text-[#2d5578] shrink-0" />
                        : <FileJson className="w-3 h-3 text-[#2d5578] shrink-0" />}
                      {f.filename}
                      <span className="text-[#4a6f94] ml-auto">
                        {formatBytes(f.kind === 'binary' ? f.bytes.length : f.content.length)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              {manifest && manifest.warnings.length > 0 && (
                <div className="rounded-md p-2 border bg-yellow-950/40 border-yellow-800/40">
                  <div className="flex items-start gap-1.5">
                    <AlertTriangle className="w-3 h-3 mt-0.5 text-yellow-500 shrink-0" />
                    <div className="text-[10px] text-yellow-300 leading-snug space-y-1">
                      {manifest.warnings.map((w, i) => <div key={i}>{w}</div>)}
                    </div>
                  </div>
                </div>
              )}

              <Button
                onClick={handleDownload}
                disabled={exporting}
                className="w-full h-9 bg-[#0ea5e9] hover:bg-[#0ea5e9]/80 text-white text-sm disabled:opacity-40"
              >
                <Download className="w-4 h-4 mr-1.5" />
                {exporting ? 'Preparing…' : 'Download AOI Reference'}
              </Button>
              <p className="text-[10px] text-[#4a6f94] text-center -mt-2">
                Reference for automated optical inspection only — never send these files to a
                fab.
              </p>
            </>
          )}

          {(aoiConfig.includeTop && !hasTopCopper) || (aoiConfig.includeBottom && !hasBottomCopper) ? (
            <div className="rounded-md p-2 border bg-yellow-950/40 border-yellow-800/40">
              <div className="flex items-start gap-1.5">
                <AlertTriangle className="w-3 h-3 mt-0.5 text-yellow-500 shrink-0" />
                <div className="text-[10px] text-yellow-300 leading-snug">
                  A selected side has no matching copper layer loaded — that side will be
                  skipped.
                </div>
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  )
}
