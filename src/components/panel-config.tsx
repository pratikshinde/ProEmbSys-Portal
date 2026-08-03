'use client'

import React from 'react'
import { useAppStore } from '@/lib/store'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Separator } from '@/components/ui/separator'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { Grid3x3, Crosshair, LayoutGrid, Settings2, RotateCcw, FileDown, Wrench, Play } from 'lucide-react'
import { DrillFormatPreset, DRILL_FORMAT_PRESETS } from '@/lib/panelization-engine'
import PanelTemplatePicker from './panel-template-picker'

export default function PanelConfigPanel() {
  const panelConfig = useAppStore(s => s.panelConfig)
  const updatePanelConfig = useAppStore(s => s.updatePanelConfig)
  const resetPanelConfig = useAppStore(s => s.resetPanelConfig)
  const panelResult = useAppStore(s => s.panelResult)
  const targetUnit = useAppStore(s => s.targetUnit)
  const setTargetUnit = useAppStore(s => s.setTargetUnit)
  const showGrid = useAppStore(s => s.showGrid)
  const toggleGrid = useAppStore(s => s.toggleGrid)
  const showCrosshair = useAppStore(s => s.showCrosshair)
  const toggleCrosshair = useAppStore(s => s.toggleCrosshair)
  const computePanelResult = useAppStore(s => s.computePanelResult)
  const setActiveTab = useAppStore(s => s.setActiveTab)
  const camMode = useAppStore(s => s.camMode)
  const designs = useAppStore(s => s.designs)
  const isMulti = camMode === 'multi'

  return (
    <div className="space-y-4">
    <PanelTemplatePicker />
    <Card className="border-[#1a3a5c] bg-[#0a1e38]/70">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-semibold flex items-center gap-2 text-[#f0f8ff]">
            <LayoutGrid className="w-4 h-4 text-[#0ea5e9]" />
            Panel Configuration
          </CardTitle>
          <Button
            size="sm"
            variant="ghost"
            onClick={resetPanelConfig}
            className="h-7 px-2 text-xs text-[#94b8d4] hover:text-white hover:bg-[#0f2848]/50"
          >
            <RotateCcw className="w-3 h-3 mr-1" />
            Reset
          </Button>
        </div>
      </CardHeader>
      <CardContent className="pt-0 space-y-4">
        {/* Create Panel Button - Top. In multi mode this re-runs the PACKER
            (with whatever gaps/material are set now) rather than building a
            grid — see computePanelResult's own doc for why re-applying the
            stored candidate instead would be unsafe after a gap change. */}
        <Button
          onClick={computePanelResult}
          className="w-full bg-[#0ea5e9] hover:bg-[#0ea5e9]/80 text-white h-8 text-xs font-medium"
        >
          <Play className="w-3 h-3 mr-1.5" />
          {isMulti ? 'Re-pack & Rebuild Panel' : 'Create Panel'}
        </Button>
        {isMulti && (
          <p className="text-[10px] text-[#4a6f94] -mt-2 leading-relaxed">
            {designs.length === 0
              ? <>Import each board as its own archive, then set quantities and find a layout on the{' '}
                  <button onClick={() => setActiveTab('designs')} className="text-[#0ea5e9] hover:underline">Designs</button> tab.</>
              : <>Re-runs the packer at the current gaps and material size. Pick a specific layout on the{' '}
                  <button onClick={() => setActiveTab('designs')} className="text-[#0ea5e9] hover:underline">Designs</button> tab.</>}
          </p>
        )}
        {/* View settings */}
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <Grid3x3 className="w-3 h-3 text-[#4a6f94]" />
            <Label className="text-xs text-[#94b8d4]">Grid</Label>
            <Switch checked={showGrid} onCheckedChange={toggleGrid} className="scale-75" />
          </div>
          <div className="flex items-center gap-2">
            <Crosshair className="w-3 h-3 text-[#4a6f94]" />
            <Label className="text-xs text-[#94b8d4]">Crosshair</Label>
            <Switch checked={showCrosshair} onCheckedChange={toggleCrosshair} className="scale-75" />
          </div>
        </div>

        {/* Unit selection */}
        <div className="flex items-center gap-2">
          <Settings2 className="w-3 h-3 text-[#4a6f94]" />
          <Label className="text-xs text-[#94b8d4]">Units:</Label>
          <div className="flex gap-1">
            <Button
              size="sm"
              variant={targetUnit === 'mm' ? 'default' : 'outline'}
              onClick={() => setTargetUnit('mm')}
              className={`h-6 px-2 text-xs ${targetUnit === 'mm' ? 'bg-[#0ea5e9] text-white hover:bg-[#0ea5e9]/80' : 'border-[#1a3a5c] text-[#94b8d4] hover:bg-[#0f2848]'}`}
            >
              mm
            </Button>
            <Button
              size="sm"
              variant={targetUnit === 'inches' ? 'default' : 'outline'}
              onClick={() => setTargetUnit('inches')}
              className={`h-6 px-2 text-xs ${targetUnit === 'inches' ? 'bg-[#0ea5e9] text-white hover:bg-[#0ea5e9]/80' : 'border-[#1a3a5c] text-[#94b8d4] hover:bg-[#0f2848]'}`}
            >
              inch
            </Button>
          </div>
        </div>

        <Separator className="bg-[#1a3a5c]" />

        <Tabs defaultValue="layout" className="w-full">
          <TabsList className="grid grid-cols-3 w-full bg-[#020d1f]/80 p-0.5 border border-[#1a3a5c] rounded-lg h-9">
            <TabsTrigger value="layout" className="text-[11px] py-1 text-[#94b8d4] data-[state=active]:bg-[#0f2848] data-[state=active]:text-[#0ea5e9]">
              Layout &amp; Ribs
            </TabsTrigger>
            <TabsTrigger value="holes" className="text-[11px] py-1 text-[#94b8d4] data-[state=active]:bg-[#0f2848] data-[state=active]:text-[#0ea5e9]">
              Holes &amp; Fids
            </TabsTrigger>
            <TabsTrigger value="drill" className="text-[11px] py-1 text-[#94b8d4] data-[state=active]:bg-[#0f2848] data-[state=active]:text-[#0ea5e9]">
              Drill &amp; Marks
            </TabsTrigger>
          </TabsList>

          <TabsContent value="layout" className="space-y-4 pt-2">
            {/* Grid layout. Rows/Columns only drive the SINGLE-mode grid
                path — the packer derives its own arrangement — but the gaps
                feed both, so they stay visible in either mode. */}
            <div>
              <Label className="text-xs text-[#94b8d4] mb-2 block">{isMulti ? 'Board Spacing' : 'Grid Layout'}</Label>
              <div className="grid grid-cols-2 gap-2">
                {!isMulti && (
                  <>
                    <div>
                      <Label className="text-[10px] text-[#4a6f94]">Rows</Label>
                      <Input
                        type="number"
                        min={1}
                        max={20}
                        value={panelConfig.rows}
                        onChange={(e) => updatePanelConfig({ rows: Math.max(1, parseInt(e.target.value) || 1) })}
                        className="h-7 text-xs bg-[#061628] border-[#1a3a5c] text-[#f0f8ff]"
                      />
                    </div>
                    <div>
                      <Label className="text-[10px] text-[#4a6f94]">Columns</Label>
                      <Input
                        type="number"
                        min={1}
                        max={20}
                        value={panelConfig.cols}
                        onChange={(e) => updatePanelConfig({ cols: Math.max(1, parseInt(e.target.value) || 1) })}
                        className="h-7 text-xs bg-[#061628] border-[#1a3a5c] text-[#f0f8ff]"
                      />
                    </div>
                  </>
                )}
                <div>
                  <Label className="text-[10px] text-[#4a6f94]">X Gap ({targetUnit})</Label>
                  <Input
                    type="number"
                    min={0}
                    step={0.1}
                    value={panelConfig.gapX}
                    onChange={(e) => updatePanelConfig({ gapX: Math.max(0, parseFloat(e.target.value) || 0) })}
                    className="h-7 text-xs bg-[#061628] border-[#1a3a5c] text-[#f0f8ff]"
                  />
                </div>
                <div>
                  <Label className="text-[10px] text-[#4a6f94]">Y Gap ({targetUnit})</Label>
                  <Input
                    type="number"
                    min={0}
                    step={0.1}
                    value={panelConfig.gapY}
                    onChange={(e) => updatePanelConfig({ gapY: Math.max(0, parseFloat(e.target.value) || 0) })}
                    className="h-7 text-xs bg-[#061628] border-[#1a3a5c] text-[#f0f8ff]"
                  />
                </div>
              </div>
            </div>

            <Separator className="bg-[#1a3a5c]" />

            {/* Side ribs */}
            <div>
              <Label className="text-xs text-[#94b8d4] mb-2 block">Side Ribs ({targetUnit})</Label>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <Label className="text-[10px] text-[#4a6f94]">Top</Label>
                  <Input
                    type="number" min={0} step={0.5}
                    value={panelConfig.sideRibTop}
                    onChange={(e) => updatePanelConfig({ sideRibTop: Math.max(0, parseFloat(e.target.value) || 0) })}
                    className="h-7 text-xs bg-[#061628] border-[#1a3a5c] text-[#f0f8ff]"
                  />
                </div>
                <div>
                  <Label className="text-[10px] text-[#4a6f94]">Bottom</Label>
                  <Input
                    type="number" min={0} step={0.5}
                    value={panelConfig.sideRibBottom}
                    onChange={(e) => updatePanelConfig({ sideRibBottom: Math.max(0, parseFloat(e.target.value) || 0) })}
                    className="h-7 text-xs bg-[#061628] border-[#1a3a5c] text-[#f0f8ff]"
                  />
                </div>
                <div>
                  <Label className="text-[10px] text-[#4a6f94]">Left</Label>
                  <Input
                    type="number" min={0} step={0.5}
                    value={panelConfig.sideRibLeft}
                    onChange={(e) => updatePanelConfig({ sideRibLeft: Math.max(0, parseFloat(e.target.value) || 0) })}
                    className="h-7 text-xs bg-[#061628] border-[#1a3a5c] text-[#f0f8ff]"
                  />
                </div>
                <div>
                  <Label className="text-[10px] text-[#4a6f94]">Right</Label>
                  <Input
                    type="number" min={0} step={0.5}
                    value={panelConfig.sideRibRight}
                    onChange={(e) => updatePanelConfig({ sideRibRight: Math.max(0, parseFloat(e.target.value) || 0) })}
                    className="h-7 text-xs bg-[#061628] border-[#1a3a5c] text-[#f0f8ff]"
                  />
                </div>
              </div>
            </div>

          </TabsContent>

          <TabsContent value="holes" className="space-y-4 pt-2">
            {/* Tooling holes */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <Label className="text-xs text-[#94b8d4] font-medium">Tooling & Reference Holes</Label>
                <Switch
                  checked={panelConfig.enableToolingHoles}
                  onCheckedChange={(checked) => updatePanelConfig({ enableToolingHoles: checked })}
                  className="scale-75 text-[#0ea5e9]"
                />
              </div>
              {panelConfig.enableToolingHoles && (
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <Label className="text-[10px] text-[#4a6f94]">Pinning ⌀ ({targetUnit})</Label>
                    <Input
                      type="number" min={0.5} step={0.1}
                      value={panelConfig.toolingHoleDiameter}
                      onChange={(e) => updatePanelConfig({ toolingHoleDiameter: Math.max(0.5, parseFloat(e.target.value) || 2) })}
                      className="h-7 text-xs bg-[#061628] border-[#1a3a5c] text-[#f0f8ff]"
                    />
                  </div>
                  <div>
                    <Label className="text-[10px] text-[#4a6f94]">Reference ⌀ ({targetUnit})</Label>
                    <Input
                      type="number" min={0.3} step={0.1}
                      value={panelConfig.referenceHoleDiameter}
                      onChange={(e) => updatePanelConfig({ referenceHoleDiameter: Math.max(0.3, parseFloat(e.target.value) || 1) })}
                      className="h-7 text-xs bg-[#061628] border-[#1a3a5c] text-[#f0f8ff]"
                    />
                  </div>
                  <div>
                    <Label className="text-[10px] text-[#4a6f94]">Pinning Inset ({targetUnit})</Label>
                    <Input
                      type="number" min={3} step={0.5}
                      value={panelConfig.toolingHoleInset}
                      onChange={(e) => updatePanelConfig({ toolingHoleInset: Math.max(3, parseFloat(e.target.value) || 5) })}
                      className="h-7 text-xs bg-[#061628] border-[#1a3a5c] text-[#f0f8ff]"
                    />
                  </div>
                  <div>
                    <Label className="text-[10px] text-[#4a6f94]">Ref Hole Inset ({targetUnit})</Label>
                    <Input
                      type="number" min={1} step={0.5}
                      value={panelConfig.referenceHoleInset}
                      onChange={(e) => updatePanelConfig({ referenceHoleInset: Math.max(1, parseFloat(e.target.value) || 3) })}
                      className="h-7 text-xs bg-[#061628] border-[#1a3a5c] text-[#f0f8ff]"
                    />
                  </div>
                </div>
              )}
            </div>

            {/* Donut / Annular Rings around reference holes */}
            {panelConfig.enableToolingHoles && (
              <div className="bg-[#061628]/50 rounded-lg p-3 border border-[#1a3a5c]">
                <Label className="text-xs font-medium text-[#94b8d4] flex items-center gap-1.5">
                  Annular Rings (Donuts)
                </Label>
                <p className="text-[9px] text-[#4a6f94] mt-0.5 mb-2">
                  Ring marks on copper, mask &amp; silkscreen layers around reference holes
                </p>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <Label className="text-[10px] text-[#4a6f94]">Outer ⌀ ({targetUnit})</Label>
                    <Input
                      type="number" min={1} step={0.05}
                      value={panelConfig.donutOuterDiameter}
                      onChange={(e) => updatePanelConfig({ donutOuterDiameter: Math.max(1, parseFloat(e.target.value) || 2.25) })}
                      className="h-7 text-xs bg-[#061628] border-[#1a3a5c] text-[#f0f8ff]"
                    />
                  </div>
                  <div>
                    <Label className="text-[10px] text-[#4a6f94]">Inner ⌀ ({targetUnit})</Label>
                    <Input
                      type="number" min={0.3} step={0.05}
                      value={panelConfig.donutInnerDiameter}
                      onChange={(e) => updatePanelConfig({ donutInnerDiameter: Math.max(0.3, parseFloat(e.target.value) || 1.25) })}
                      className="h-7 text-xs bg-[#061628] border-[#1a3a5c] text-[#f0f8ff]"
                    />
                  </div>
                </div>
              </div>
            )}

            <Separator className="bg-[#1a3a5c]" />

            {/* Fiducials */}
            <div>
              <div className="text-xs text-[#94b8d4] font-medium mb-2">Copper Fiducials</div>
              <div className="flex items-center gap-4 mb-2.5">
                <label className="flex items-center gap-1.5 cursor-pointer text-xs text-[#94b8d4]">
                  <input
                    type="checkbox"
                    checked={panelConfig.fiducialsTop !== false}
                    onChange={(e) => {
                      const val = e.target.checked
                      updatePanelConfig({
                        fiducialsTop: val,
                        enableFiducials: val || (panelConfig.fiducialsBottom !== false)
                      })
                    }}
                    className="w-3.5 h-3.5 rounded border-[#1a3a5c] bg-[#061628] text-[#0ea5e9] focus:ring-[#0ea5e9] accent-[#0ea5e9]"
                  />
                  Top Layer
                </label>
                <label className="flex items-center gap-1.5 cursor-pointer text-xs text-[#94b8d4]">
                  <input
                    type="checkbox"
                    checked={panelConfig.fiducialsBottom !== false}
                    onChange={(e) => {
                      const val = e.target.checked
                      updatePanelConfig({
                        fiducialsBottom: val,
                        enableFiducials: (panelConfig.fiducialsTop !== false) || val
                      })
                    }}
                    className="w-3.5 h-3.5 rounded border-[#1a3a5c] bg-[#061628] text-[#0ea5e9] focus:ring-[#0ea5e9] accent-[#0ea5e9]"
                  />
                  Bottom Layer
                </label>
              </div>
              {((panelConfig.fiducialsTop !== false) || (panelConfig.fiducialsBottom !== false)) && (
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <Label className="text-[10px] text-[#4a6f94]">⌀ Copper ({targetUnit})</Label>
                    <Input
                      type="number" min={0.3} step={0.1}
                      value={panelConfig.fiducialDiameter}
                      onChange={(e) => updatePanelConfig({ fiducialDiameter: Math.max(0.3, parseFloat(e.target.value) || 1) })}
                      className="h-7 text-xs bg-[#061628] border-[#1a3a5c] text-[#f0f8ff]"
                    />
                  </div>
                  <div>
                    <Label className="text-[10px] text-[#4a6f94]">⌀ Mask ({targetUnit})</Label>
                    <Input
                      type="number" min={0.5} step={0.1}
                      value={panelConfig.fiducialClearance}
                      onChange={(e) => updatePanelConfig({ fiducialClearance: Math.max(0.5, parseFloat(e.target.value) || 2) })}
                      className="h-7 text-xs bg-[#061628] border-[#1a3a5c] text-[#f0f8ff]"
                    />
                  </div>
                </div>
              )}
            </div>

            {panelResult && (
              <div className="bg-[#061628]/40 border border-[#1a3a5c] rounded-lg p-3 space-y-3 mt-4">
                <div className="flex items-center justify-between">
                  <div>
                    <h4 className="text-xs font-semibold text-[#f0f8ff]">Fine-Tune Positions</h4>
                    <p className="text-[10px] text-[#4a6f94] mt-0.5">Slightly adjust X/Y coordinates of holes &amp; fiducials</p>
                  </div>
                  {panelConfig.xyOverrides && Object.keys(panelConfig.xyOverrides).length > 0 && (
                    <Button
                      variant="ghost"
                      onClick={() => updatePanelConfig({ xyOverrides: {} })}
                      className="h-6 text-[10px] px-2 text-rose-400 hover:text-rose-300 hover:bg-rose-950/20"
                    >
                      Reset All
                    </Button>
                  )}
                </div>

                {/* Tooling / Pinning Holes positions */}
                {panelConfig.enableToolingHoles && (panelResult.toolingHoles || []).filter(h => h.type === 'tooling').length > 0 && (
                  <div className="space-y-1.5">
                    <div className="text-[10px] font-bold text-[#0ea5e9] uppercase tracking-wider">Pinning Holes</div>
                    {(panelResult.toolingHoles || []).filter(h => h.type === 'tooling').map(hole => (
                      <div key={hole.id} className="flex items-center justify-between bg-[#020d1f]/40 p-2 rounded border border-[#1a3a5c]/60 gap-2">
                        <span className="text-[10.5px] text-[#94b8d4] font-medium truncate flex-1">
                          {hole.id === 'tooling_tl' ? 'Top-Left' : hole.id === 'tooling_tr' ? 'Top-Right' : hole.id === 'tooling_bl' ? 'Bottom-Left' : 'Bottom-Right'} (⌀{hole.diameter}mm)
                        </span>
                        <div className="flex items-center gap-1.5 shrink-0 font-mono">
                          <div className="flex items-center gap-1">
                            <span className="text-[9px] text-[#4a6f94]">X</span>
                            <Input
                              type="number"
                              step={0.1}
                              value={panelConfig.xyOverrides?.[hole.id]?.x !== undefined ? panelConfig.xyOverrides[hole.id].x : hole.x.toFixed(2)}
                              onChange={(e) => {
                                const val = e.target.value === '' ? undefined : parseFloat(e.target.value)
                                const current = panelConfig.xyOverrides?.[hole.id] || {}
                                updatePanelConfig({
                                  xyOverrides: {
                                    ...panelConfig.xyOverrides,
                                    [hole.id]: { ...current, x: val }
                                  }
                                })
                              }}
                              className="h-6 w-16 text-center text-[10.5px] bg-[#061628] border-[#1a3a5c] px-1 py-0 text-[#f0f8ff]"
                            />
                          </div>
                          <div className="flex items-center gap-1">
                            <span className="text-[9px] text-[#4a6f94]">Y</span>
                            <Input
                              type="number"
                              step={0.1}
                              value={panelConfig.xyOverrides?.[hole.id]?.y !== undefined ? panelConfig.xyOverrides[hole.id].y : hole.y.toFixed(2)}
                              onChange={(e) => {
                                const val = e.target.value === '' ? undefined : parseFloat(e.target.value)
                                const current = panelConfig.xyOverrides?.[hole.id] || {}
                                updatePanelConfig({
                                  xyOverrides: {
                                    ...panelConfig.xyOverrides,
                                    [hole.id]: { ...current, y: val }
                                  }
                                })
                              }}
                              className="h-6 w-16 text-center text-[10.5px] bg-[#061628] border-[#1a3a5c] px-1 py-0 text-[#f0f8ff]"
                            />
                          </div>
                          {panelConfig.xyOverrides?.[hole.id] && (
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => {
                                const next = { ...panelConfig.xyOverrides }
                                delete next[hole.id]
                                updatePanelConfig({ xyOverrides: next })
                              }}
                              className="h-6 w-6 text-[#4a6f94] hover:text-white hover:bg-[#0f2848]"
                            >
                              <RotateCcw className="w-3 h-3" />
                            </Button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {/* Reference Holes positions */}
                {panelConfig.enableToolingHoles && (panelResult.toolingHoles || []).filter(h => h.type === 'reference').length > 0 && (
                  <div className="space-y-1.5">
                    <div className="text-[10px] font-bold text-amber-400 uppercase tracking-wider">Reference Holes</div>
                    {(panelResult.toolingHoles || []).filter(h => h.type === 'reference').map(hole => (
                      <div key={hole.id} className="flex items-center justify-between bg-[#020d1f]/40 p-2 rounded border border-[#1a3a5c]/60 gap-2">
                        <span className="text-[10.5px] text-[#94b8d4] font-medium truncate flex-1">
                          {hole.id === 'ref_bl' ? 'Bottom-Left' : hole.id === 'ref_br' ? 'Bottom-Right' : hole.id === 'ref_tr' ? 'Top-Right' : hole.id === 'ref_tl1' ? 'Top-Left 1' : 'Top-Left 2'} (⌀{hole.diameter}mm)
                        </span>
                        <div className="flex items-center gap-1.5 shrink-0 font-mono">
                          <div className="flex items-center gap-1">
                            <span className="text-[9px] text-[#4a6f94]">X</span>
                            <Input
                              type="number"
                              step={0.1}
                              value={panelConfig.xyOverrides?.[hole.id]?.x !== undefined ? panelConfig.xyOverrides[hole.id].x : hole.x.toFixed(2)}
                              onChange={(e) => {
                                const val = e.target.value === '' ? undefined : parseFloat(e.target.value)
                                const current = panelConfig.xyOverrides?.[hole.id] || {}
                                updatePanelConfig({
                                  xyOverrides: {
                                    ...panelConfig.xyOverrides,
                                    [hole.id]: { ...current, x: val }
                                  }
                                })
                              }}
                              className="h-6 w-16 text-center text-[10.5px] bg-[#061628] border-[#1a3a5c] px-1 py-0 text-[#f0f8ff]"
                            />
                          </div>
                          <div className="flex items-center gap-1">
                            <span className="text-[9px] text-[#4a6f94]">Y</span>
                            <Input
                              type="number"
                              step={0.1}
                              value={panelConfig.xyOverrides?.[hole.id]?.y !== undefined ? panelConfig.xyOverrides[hole.id].y : hole.y.toFixed(2)}
                              onChange={(e) => {
                                const val = e.target.value === '' ? undefined : parseFloat(e.target.value)
                                const current = panelConfig.xyOverrides?.[hole.id] || {}
                                updatePanelConfig({
                                  xyOverrides: {
                                    ...panelConfig.xyOverrides,
                                    [hole.id]: { ...current, y: val }
                                  }
                                })
                              }}
                              className="h-6 w-16 text-center text-[10.5px] bg-[#061628] border-[#1a3a5c] px-1 py-0 text-[#f0f8ff]"
                            />
                          </div>
                          {panelConfig.xyOverrides?.[hole.id] && (
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => {
                                const next = { ...panelConfig.xyOverrides }
                                delete next[hole.id]
                                updatePanelConfig({ xyOverrides: next })
                              }}
                              className="h-6 w-6 text-[#4a6f94] hover:text-white hover:bg-[#0f2848]"
                            >
                              <RotateCcw className="w-3 h-3" />
                            </Button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {/* Fiducials positions */}
                {panelConfig.enableFiducials && (panelResult.fiducials || []).length > 0 && (
                  <div className="space-y-1.5">
                    <div className="text-[10px] font-bold text-blue-400 uppercase tracking-wider">Fiducials</div>
                    {(panelResult.fiducials || []).map(fid => (
                      <div key={fid.id} className="flex items-center justify-between bg-[#020d1f]/40 p-2 rounded border border-[#1a3a5c]/60 gap-2">
                        <span className="text-[10.5px] text-[#94b8d4] font-medium truncate flex-1 font-sans">
                          {fid.id === 'fid_bl' ? 'Bottom-Left' : fid.id === 'fid_br' ? 'Bottom-Right' : 'Top-Right'} (⌀{fid.diameter}mm)
                        </span>
                        <div className="flex items-center gap-1.5 shrink-0 font-mono">
                          <div className="flex items-center gap-1">
                            <span className="text-[9px] text-[#4a6f94]">X</span>
                            <Input
                              type="number"
                              step={0.1}
                              value={panelConfig.xyOverrides?.[fid.id]?.x !== undefined ? panelConfig.xyOverrides[fid.id].x : fid.x.toFixed(2)}
                              onChange={(e) => {
                                const val = e.target.value === '' ? undefined : parseFloat(e.target.value)
                                const current = panelConfig.xyOverrides?.[fid.id] || {}
                                updatePanelConfig({
                                  xyOverrides: {
                                    ...panelConfig.xyOverrides,
                                    [fid.id]: { ...current, x: val }
                                  }
                                })
                              }}
                              className="h-6 w-16 text-center text-[10.5px] bg-[#061628] border-[#1a3a5c] px-1 py-0 text-[#f0f8ff]"
                            />
                          </div>
                          <div className="flex items-center gap-1">
                            <span className="text-[9px] text-[#4a6f94]">Y</span>
                            <Input
                              type="number"
                              step={0.1}
                              value={panelConfig.xyOverrides?.[fid.id]?.y !== undefined ? panelConfig.xyOverrides[fid.id].y : fid.y.toFixed(2)}
                              onChange={(e) => {
                                const val = e.target.value === '' ? undefined : parseFloat(e.target.value)
                                const current = panelConfig.xyOverrides?.[fid.id] || {}
                                updatePanelConfig({
                                  xyOverrides: {
                                    ...panelConfig.xyOverrides,
                                    [fid.id]: { ...current, y: val }
                                  }
                                })
                              }}
                              className="h-6 w-16 text-center text-[10.5px] bg-[#061628] border-[#1a3a5c] px-1 py-0 text-[#f0f8ff]"
                            />
                          </div>
                          {panelConfig.xyOverrides?.[fid.id] && (
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => {
                                const next = { ...panelConfig.xyOverrides }
                                delete next[fid.id]
                                updatePanelConfig({ xyOverrides: next })
                              }}
                              className="h-6 w-6 text-[#4a6f94] hover:text-white hover:bg-[#0f2848]"
                            >
                              <RotateCcw className="w-3 h-3" />
                            </Button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </TabsContent>

          <TabsContent value="drill" className="space-y-4 pt-2">
            {/* Drill output format */}
            <div>
              <Label className="text-xs text-[#94b8d4] mb-2 flex items-center gap-1.5">
                <Wrench className="w-3 h-3 text-amber-400" />
                Drill Output Format
              </Label>

              {/* Format preset selector */}
              <div className="mb-2">
                <Label className="text-[10px] text-[#4a6f94]">Format Preset</Label>
                <Select
                  value={panelConfig.drillFormat?.preset || 'excellon-2-4'}
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
                    value={panelConfig.drillFormat?.integerDigits?.toString() || '2'}
                    onValueChange={(v) => {
                      const intD = parseInt(v)
                      if (panelConfig.drillFormat) {
                        updatePanelConfig({
                          drillFormat: {
                            ...panelConfig.drillFormat,
                            integerDigits: intD,
                            preset: 'custom',
                          }
                        })
                      }
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
                    value={panelConfig.drillFormat?.decimalDigits?.toString() || '4'}
                    onValueChange={(v) => {
                      const decD = parseInt(v)
                      if (panelConfig.drillFormat) {
                        updatePanelConfig({
                          drillFormat: {
                            ...panelConfig.drillFormat,
                            decimalDigits: decD,
                            preset: 'custom',
                          }
                        })
                      }
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
                    value={panelConfig.drillFormat?.unit || 'inches'}
                    onValueChange={(v) => {
                      if (panelConfig.drillFormat) {
                        updatePanelConfig({
                          drillFormat: {
                            ...panelConfig.drillFormat,
                            unit: v as 'mm' | 'inches',
                            preset: 'custom',
                          }
                        })
                      }
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
                    value={panelConfig.drillFormat?.zeroSuppression || 'none'}
                    onValueChange={(v) => {
                      if (panelConfig.drillFormat) {
                        updatePanelConfig({
                          drillFormat: {
                            ...panelConfig.drillFormat,
                            zeroSuppression: v as 'none' | 'leading' | 'trailing',
                            preset: 'custom',
                          }
                        })
                      }
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

              {/* Format summary */}
              <div className="mt-2 bg-[#061628]/80 rounded-md p-2 text-[10px] font-mono text-[#4a6f94] space-y-0.5">
                <div className="text-[#94b8d4] font-medium">Drill Format Preview</div>
                <div>FORMAT: {panelConfig.drillFormat?.integerDigits ?? 2}:{panelConfig.drillFormat?.decimalDigits ?? 4}</div>
                <div>UNIT: {panelConfig.drillFormat?.unit === 'mm' ? 'METRIC' : 'ENGLISH'}</div>
                <div>ZERO: {panelConfig.drillFormat?.zeroSuppression === 'none' ? 'NONE' : panelConfig.drillFormat?.zeroSuppression === 'leading' ? 'LZ' : 'TZ'}</div>
              </div>
            </div>

            {/* L-Shape Marks */}
            <div className="bg-[#061628]/50 rounded-lg p-3 border border-[#1a3a5c]">
              <Label className="text-xs font-medium text-[#94b8d4] flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={panelConfig.enableLShapeMarks}
                  onChange={(e) => updatePanelConfig({ enableLShapeMarks: e.target.checked })}
                  className="h-3.5 w-3.5 rounded border-[#1a3a5c] bg-[#061628] text-[#0ea5e9] focus:ring-[#0ea5e9] accent-[#0ea5e9]"
                />
                L-Shape Corner Marks On PCB
              </Label>
              {panelConfig.enableLShapeMarks && (
                <div className="mt-2 grid grid-cols-2 gap-2">
                  <div>
                    <Label className="text-[10px] text-[#4a6f94]">Arm Length (mm)</Label>
                    <Input
                      type="number"
                      value={panelConfig.lShapeArmLength}
                      onChange={(e) => updatePanelConfig({ lShapeArmLength: parseFloat(e.target.value) || 5 })}
                      min={1}
                      max={50}
                      step={0.5}
                      className="h-7 text-xs bg-[#061628] border-[#1a3a5c] text-[#f0f8ff]"
                    />
                  </div>
                  <div>
                    <Label className="text-[10px] text-[#4a6f94]">Line Width (mm)</Label>
                    <Input
                      type="number"
                      value={panelConfig.lShapeLineWidth}
                      onChange={(e) => updatePanelConfig({ lShapeLineWidth: parseFloat(e.target.value) || 0.254 })}
                      min={0.1}
                      max={2}
                      step={0.01}
                      className="h-7 text-xs bg-[#061628] border-[#1a3a5c] text-[#f0f8ff]"
                    />
                  </div>
                </div>
              )}
              <p className="text-[9px] text-[#4a6f94] mt-1.5">
                L-marks on copper &amp; mask layers at PCB corners on individual PCBs (rectangle PCBs only)
              </p>
            </div>

            {/* Panel Border L-Shape Marks */}
            <div className="bg-[#061628]/50 rounded-lg p-3 border border-[#1a3a5c]">
              <Label className="text-xs font-medium text-[#94b8d4] flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={panelConfig.enablePanelBorderLShape}
                  onChange={(e) => updatePanelConfig({ enablePanelBorderLShape: e.target.checked })}
                  className="h-3.5 w-3.5 rounded border-[#1a3a5c] bg-[#061628] text-[#0ea5e9] focus:ring-[#0ea5e9] accent-[#0ea5e9]"
                />
                L-Shape Corner Marks On Panel Border
              </Label>
              {panelConfig.enablePanelBorderLShape && (
                <div className="mt-2 grid grid-cols-2 gap-2">
                  <div>
                    <Label className="text-[10px] text-[#4a6f94]">Arm Length (mm)</Label>
                    <Input
                      type="number"
                      value={panelConfig.panelBorderLShapeArmLength}
                      onChange={(e) => updatePanelConfig({ panelBorderLShapeArmLength: parseFloat(e.target.value) || 5 })}
                      min={1}
                      max={50}
                      step={0.5}
                      className="h-7 text-xs bg-[#061628] border-[#1a3a5c] text-[#f0f8ff]"
                    />
                  </div>
                  <div>
                    <Label className="text-[10px] text-[#4a6f94]">Line Width (mm)</Label>
                    <Input
                      type="number"
                      value={panelConfig.panelBorderLShapeLineWidth}
                      onChange={(e) => updatePanelConfig({ panelBorderLShapeLineWidth: parseFloat(e.target.value) || 0.254 })}
                      min={0.1}
                      max={2}
                      step={0.01}
                      className="h-7 text-xs bg-[#061628] border-[#1a3a5c] text-[#f0f8ff]"
                    />
                  </div>
                </div>
              )}
              <p className="text-[9px] text-[#4a6f94] mt-1.5">
                L-marks on copper &amp; mask layers at panel border/outline corners
              </p>
            </div>

          </TabsContent>
        </Tabs>

        {/* Panel result summary */}
        {panelResult && (
          <div className="bg-[#061628]/80 rounded-lg p-3 text-xs">
            <div className="text-[#94b8d4] font-medium mb-2">Panel Summary</div>
            <div className="grid grid-cols-2 gap-1 text-[#4a6f94]">
              <span>PCB Size:</span>
              <span className="text-[#f0f8ff]">{panelResult.designs[0]?.widthMm?.toFixed(1) ?? 'N/A'} × {panelResult.designs[0]?.heightMm?.toFixed(1) ?? 'N/A'} {targetUnit}</span>
              <span>Panel Size:</span>
              <span className="text-emerald-400">{panelResult.panelWidth?.toFixed(1) ?? 'N/A'} × {panelResult.panelHeight?.toFixed(1) ?? 'N/A'} {targetUnit}</span>
              <span>Total PCBs:</span>
              <span className="text-yellow-400">{panelResult.totalPCBs ?? 0}</span>
              <span>Layout:</span>
              <span className="text-[#f0f8ff]">{panelConfig.rows ?? 2} × {panelConfig.cols ?? 3}</span>
              <span>Tooling Holes:</span>
              <span className="text-[#f0f8ff]">{panelResult.toolingHoles?.filter(h => h.type === 'tooling').length ?? 0}</span>
              <span>Reference Holes:</span>
              <span className="text-[#f0f8ff]">{panelResult.toolingHoles?.filter(h => h.type === 'reference').length ?? 0}</span>
              <span>Fiducials:</span>
              <span className="text-[#f0f8ff]">{panelResult.fiducials?.length ?? 0}</span>
            </div>
          </div>
        )}

        {/* Create Panel Button - Bottom */}
        <Button
          onClick={computePanelResult}
          className="w-full bg-[#0ea5e9] hover:bg-[#0ea5e9]/80 text-white h-8 text-xs font-medium"
        >
          <Play className="w-3 h-3 mr-1.5" />
          Create Panel
        </Button>
      </CardContent>
    </Card>
    </div>
  )
}
