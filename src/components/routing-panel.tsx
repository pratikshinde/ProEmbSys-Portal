'use client'

import React from 'react'
import { useAppStore } from '@/lib/store'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Separator } from '@/components/ui/separator'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  Scissors, Play, AlertTriangle, Info, CheckCircle2, Settings2, Download, Wrench, RotateCcw, Shapes,
} from 'lucide-react'
import { validateRouting } from '@/lib/routing/plan-routing'
import { ROUTING_BIT_PRESETS, type TabStyle } from '@/lib/routing/types'
import { exportRoutingFiles } from '@/lib/gerber-exporter'

const SEVERITY_STYLE = {
  error: { icon: AlertTriangle, color: '#f87171', bg: 'rgba(248,113,113,0.12)', border: 'rgba(248,113,113,0.3)' },
  warning: { icon: AlertTriangle, color: '#fbbf24', bg: 'rgba(251,191,36,0.12)', border: 'rgba(251,191,36,0.3)' },
  info: { icon: Info, color: '#60a5fa', bg: 'rgba(96,165,250,0.12)', border: 'rgba(96,165,250,0.3)' },
} as const

const numInputCls = 'h-7 text-xs bg-[#061628] border-[#1a3a5c] text-[#f0f8ff]'
const fieldLabelCls = 'text-[10px] text-[#4a6f94]'
const sectionLabelCls = 'text-xs text-[#94b8d4] font-medium flex items-center gap-1.5'

export default function RoutingPanel() {
  const panelResult = useAppStore(s => s.panelResult)
  const panelConfig = useAppStore(s => s.panelConfig)
  const updatePanelConfig = useAppStore(s => s.updatePanelConfig)
  const computePanelResult = useAppStore(s => s.computePanelResult)
  const layers = useAppStore(s => s.layers)
  const routingConfig = useAppStore(s => s.routingConfig)
  const updateRoutingConfig = useAppStore(s => s.updateRoutingConfig)
  const resetRoutingConfig = useAppStore(s => s.resetRoutingConfig)
  const routingResult = useAppStore(s => s.routingResult)
  const routingStale = useAppStore(s => s.routingStale)
  const routingGenerating = useAppStore(s => s.routingGenerating)
  const generateRouting = useAppStore(s => s.generateRouting)
  const setRoutingFocus = useAppStore(s => s.setRoutingFocus)
  const panelInfo = useAppStore(s => s.panelInfo)
  const outputFormat = useAppStore(s => s.outputFormat)

  const [exporting, setExporting] = React.useState(false)

  const cfg = routingConfig

  // Pre-flight issues, computed live so problems surface BEFORE generating.
  // planRouting calls the same validator internally, so the two cannot diverge.
  const preflight = React.useMemo(() => {
    const outlineLayer = layers.find(l => l.type === 'outline' && l.parsedLayer?.bounds)
    return validateRouting(panelResult, panelConfig, cfg, {
      outlineLayer: outlineLayer?.parsedLayer ?? null,
    })
  }, [panelResult, panelConfig, cfg, layers])

  // Show the live pre-flight list until a plan exists; afterwards show the
  // plan's own snapshot, so the list matches the file you would download.
  const issues = routingResult && !routingStale ? routingResult.issues : preflight

  const applyFix = (issue: (typeof issues)[number]) => {
    if (!issue.fix) return
    updatePanelConfig(issue.fix.panelConfigPatch)
    // A patch that changes panel geometry invalidates the current panelResult,
    // so rebuild it rather than leaving routing planned against stale layout.
    if (issue.fix.rebuildPanel) computePanelResult()
  }

  const handleDownload = async () => {
    if (!routingResult) return
    setExporting(true)
    try {
      await exportRoutingFiles(routingResult, panelConfig, panelResult!, panelInfo, outputFormat)
    } catch (err) {
      console.error('Route export failed:', err)
      alert('Route export failed. Check the console for details.')
    } finally {
      setExporting(false)
    }
  }

  const bitIsPreset = (v: number) => ROUTING_BIT_PRESETS.some(p => Math.abs(p - v) < 1e-9)
  const showBiteFields = cfg.tabStyle === 'mousebite'
  const holeCount = routingResult?.tabs.reduce((n, t) => n + t.holes.length, 0) ?? 0

  return (
    <Card className="border-[#1a3a5c] bg-[#0a1e38]/70">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-semibold flex items-center gap-2 text-[#f0f8ff]">
            <Scissors className="w-4 h-4 text-[#0ea5e9]" />
            Routing
          </CardTitle>
          <Button
            size="sm"
            variant="ghost"
            onClick={resetRoutingConfig}
            className="h-6 px-2 text-[10px] text-[#4a6f94] hover:text-white hover:bg-[#0f2848]"
          >
            <RotateCcw className="w-3 h-3 mr-1" />
            Reset
          </Button>
        </div>
      </CardHeader>

      <CardContent className="pt-0 space-y-4">
        {/* ---------------------------------------------------- Bit size */}
        <div>
          <Label className={sectionLabelCls}>
            <Wrench className="w-3 h-3 text-[#0ea5e9]" />
            Router Bit
          </Label>
          <div className="mt-2 space-y-2">
            <div className="flex gap-1">
              {ROUTING_BIT_PRESETS.map(preset => {
                const active = Math.abs(cfg.bitDiameterMm - preset) < 1e-9
                return (
                  <Button
                    key={preset}
                    size="sm"
                    variant={active ? 'default' : 'outline'}
                    onClick={() => updateRoutingConfig({ bitDiameterMm: preset })}
                    className={`h-7 px-2 text-xs flex-1 ${
                      active
                        ? 'bg-[#0ea5e9] text-white'
                        : 'border-[#1a3a5c] text-[#94b8d4] hover:text-white hover:bg-[#0f2848]'
                    }`}
                  >
                    {preset.toFixed(1)} mm
                  </Button>
                )
              })}
            </div>
            <div>
              <Label className={fieldLabelCls}>
                Diameter (mm){!bitIsPreset(cfg.bitDiameterMm) && ' — custom'}
              </Label>
              <Input
                type="number"
                min={0.1}
                max={10}
                step={0.1}
                value={cfg.bitDiameterMm}
                onChange={e =>
                  updateRoutingConfig({ bitDiameterMm: Math.max(0.1, parseFloat(e.target.value) || 2.0) })
                }
                className={numInputCls}
              />
            </div>
          </div>
        </div>

        <Separator className="bg-[#1a3a5c]" />

        {/* ------------------------------------------------------- Scope */}
        <div>
          <Label className={sectionLabelCls}>
            <Settings2 className="w-3 h-3 text-[#0ea5e9]" />
            What to Route
          </Label>
          <div className="mt-2 space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-xs text-[#94b8d4]">Panel outline</Label>
              <Switch
                checked={cfg.routePanelOutline}
                onCheckedChange={v => updateRoutingConfig({ routePanelOutline: v })}
                className="scale-75"
              />
            </div>
            <div className="flex items-center justify-between">
              <Label className="text-xs text-[#94b8d4]">Individual PCBs</Label>
              <Switch
                checked={cfg.routeIndividualPcbs}
                onCheckedChange={v => updateRoutingConfig({ routeIndividualPcbs: v })}
                className="scale-75"
              />
            </div>
            {cfg.routeIndividualPcbs && (
              <div className="flex items-center justify-between">
                <Label className="text-xs text-[#94b8d4]" title="When the gap equals the bit diameter, one pass down the gap centre cuts both neighbours.">
                  Share cuts in common gaps
                </Label>
                <Switch
                  checked={cfg.mergeCoincidentPasses}
                  onCheckedChange={v => updateRoutingConfig({ mergeCoincidentPasses: v })}
                  className="scale-75"
                />
              </div>
            )}
          </div>
        </div>

        {/* --------------------------------------------------- PCB Outline */}
        {cfg.routeIndividualPcbs && (
          <>
            <Separator className="bg-[#1a3a5c]" />
            <div>
              <Label className={sectionLabelCls}>
                <Shapes className="w-3 h-3 text-[#0ea5e9]" />
                PCB Outline
              </Label>
              <div className="mt-2 space-y-2">
                <div className="flex gap-1">
                  {([
                    ['auto', 'Auto'], ['contour', 'Contour'], ['bbox', 'Bounding box'],
                  ] as const).map(([value, label]) => {
                    const active = cfg.pcbOutlineMode === value
                    return (
                      <Button
                        key={value}
                        size="sm"
                        variant={active ? 'default' : 'outline'}
                        onClick={() => updateRoutingConfig({ pcbOutlineMode: value })}
                        className={`h-7 px-2 text-xs flex-1 ${
                          active
                            ? 'bg-[#0ea5e9] text-white'
                            : 'border-[#1a3a5c] text-[#94b8d4] hover:text-white hover:bg-[#0f2848]'
                        }`}
                      >
                        {label}
                      </Button>
                    )
                  })}
                </div>
                <p className="text-[10px] text-[#4a6f94] leading-snug">
                  {cfg.pcbOutlineMode === 'bbox'
                    ? 'Routes each PCB as a rectangle — a shaped board is over-cut at non-rectangular features.'
                    : cfg.pcbOutlineMode === 'contour'
                    ? 'Routes the real traced board profile, including interior cutouts. A trace failure blocks generation rather than falling back to a rectangle.'
                    : 'Follows the real board profile, unless it is already a plain rectangle (identical output, less work).'}
                </p>

                {cfg.pcbOutlineMode !== 'bbox' && (
                  <>
                    <div className="flex items-center justify-between">
                      <Label className="text-xs text-[#94b8d4]">Route interior cutouts</Label>
                      <Switch
                        checked={cfg.routeInteriorCutouts}
                        onCheckedChange={v => updateRoutingConfig({ routeInteriorCutouts: v })}
                        className="scale-75"
                      />
                    </div>
                    <div>
                      <Label className={fieldLabelCls}>Contour trace tolerance (mm)</Label>
                      <Input
                        type="number" min={0.001} max={0.5} step={0.001}
                        value={cfg.contourToleranceMm}
                        onChange={e => updateRoutingConfig({ contourToleranceMm: Math.max(0.001, parseFloat(e.target.value) || 0.01) })}
                        className={numInputCls}
                      />
                    </div>
                  </>
                )}
              </div>
            </div>
          </>
        )}

        {/* -------------------------------------------------------- Tabs */}
        {cfg.routeIndividualPcbs && (
          <>
            <Separator className="bg-[#1a3a5c]" />
            <div>
              <Label className={sectionLabelCls}>
                <Scissors className="w-3 h-3 text-[#0ea5e9]" />
                Breakaway Tabs
              </Label>
              <div className="mt-2 space-y-2">
                <div>
                  <Label className={fieldLabelCls}>Style</Label>
                  <Select
                    value={cfg.tabStyle}
                    onValueChange={(v: TabStyle) => updateRoutingConfig({ tabStyle: v })}
                  >
                    <SelectTrigger className="h-7 text-xs bg-[#061628] border-[#1a3a5c] text-[#f0f8ff]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="bg-[#0a1e38] border-[#1a3a5c]">
                      <SelectItem value="mousebite" className="text-xs">Mouse bites (perforated)</SelectItem>
                      <SelectItem value="solid" className="text-xs">Solid tabs</SelectItem>
                      <SelectItem value="none" className="text-xs">None (fully cut through)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {cfg.tabStyle !== 'none' && (
                  <>
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <Label className={fieldLabelCls}>Tab width (mm)</Label>
                        <Input
                          type="number" min={0.5} max={20} step={0.5}
                          value={cfg.tabWidthMm}
                          onChange={e => updateRoutingConfig({ tabWidthMm: Math.max(0.5, parseFloat(e.target.value) || 3) })}
                          className={numInputCls}
                        />
                      </div>
                      <div>
                        <Label className={fieldLabelCls}>
                          {cfg.pcbOutlineMode === 'bbox' ? 'Tabs per edge' : 'Tabs around contour'}
                        </Label>
                        <Input
                          type="number" min={1} max={cfg.pcbOutlineMode === 'bbox' ? 10 : 24} step={1}
                          value={cfg.pcbOutlineMode === 'bbox' ? cfg.tabsPerEdge : cfg.tabsPerContour}
                          onChange={e => {
                            const fallback = cfg.pcbOutlineMode === 'bbox' ? 2 : 4
                            const n = Math.max(1, parseInt(e.target.value) || fallback)
                            updateRoutingConfig(cfg.pcbOutlineMode === 'bbox' ? { tabsPerEdge: n } : { tabsPerContour: n })
                          }}
                          className={numInputCls}
                        />
                      </div>
                    </div>

                    {cfg.pcbOutlineMode === 'bbox' && (
                      <div>
                        <Label className={fieldLabelCls}>Tabs on edges</Label>
                        <div className="flex gap-1 mt-1">
                          {([
                            ['tabTop', 'Top'], ['tabBottom', 'Bottom'],
                            ['tabLeft', 'Left'], ['tabRight', 'Right'],
                          ] as const).map(([key, label]) => {
                            const active = cfg[key]
                            return (
                              <Button
                                key={key}
                                size="sm"
                                variant={active ? 'default' : 'outline'}
                                onClick={() => updateRoutingConfig({ [key]: !active })}
                                className={`h-7 px-2 text-xs flex-1 ${
                                  active
                                    ? 'bg-[#0ea5e9] text-white'
                                    : 'border-[#1a3a5c] text-[#94b8d4] hover:text-white hover:bg-[#0f2848]'
                                }`}
                              >
                                {label}
                              </Button>
                            )
                          })}
                        </div>
                      </div>
                    )}

                    {showBiteFields && (
                      <>
                        <div className="grid grid-cols-2 gap-2">
                          <div>
                            <Label className={fieldLabelCls}>Bite hole Ø (mm)</Label>
                            <Input
                              type="number" min={0.2} max={2} step={0.1}
                              value={cfg.mouseBiteHoleDiameterMm}
                              onChange={e => updateRoutingConfig({ mouseBiteHoleDiameterMm: Math.max(0.2, parseFloat(e.target.value) || 0.5) })}
                              className={numInputCls}
                            />
                          </div>
                          <div>
                            <Label className={fieldLabelCls}>Hole pitch (mm)</Label>
                            <Input
                              type="number" min={0.3} max={3} step={0.1}
                              value={cfg.mouseBiteHolePitchMm}
                              onChange={e => updateRoutingConfig({ mouseBiteHolePitchMm: Math.max(0.3, parseFloat(e.target.value) || 0.8) })}
                              className={numInputCls}
                            />
                          </div>
                        </div>
                        <div>
                          <Label className={fieldLabelCls} title="Distance from the true board edge to the near side of each hole. The hole row is pulled outward (into the panel scrap) by this much plus the hole radius, so holes clear the finished board instead of straddling the cut line.">
                            Edge clearance (mm)
                          </Label>
                          <Input
                            type="number" min={0} max={1} step={0.05}
                            value={cfg.mouseBiteEdgeClearanceMm}
                            onChange={e => updateRoutingConfig({ mouseBiteEdgeClearanceMm: Math.max(0, parseFloat(e.target.value) || 0) })}
                            className={numInputCls}
                          />
                        </div>
                        <div className="flex items-center justify-between">
                          <Label className="text-xs text-[#94b8d4]" title="Off (default) writes the holes to their own _MouseBites.drl, leaving the main drill file untouched.">
                            Holes in main drill file
                          </Label>
                          <Switch
                            checked={cfg.mouseBiteInMainDrill}
                            onCheckedChange={v => updateRoutingConfig({ mouseBiteInMainDrill: v })}
                            className="scale-75"
                          />
                        </div>
                      </>
                    )}
                  </>
                )}
              </div>
            </div>
          </>
        )}

        {/* ---------------------------------------------------- Advanced */}
        <Separator className="bg-[#1a3a5c]" />
        <div>
          <Label className={sectionLabelCls}>
            <Settings2 className="w-3 h-3 text-[#0ea5e9]" />
            Advanced
          </Label>
          <div className="mt-2 space-y-2">
            {cfg.routeIndividualPcbs && cfg.tabStyle !== 'none' && (
              <div>
                <Label className={fieldLabelCls}>
                  Tab positions (mm from {cfg.pcbOutlineMode === 'bbox' ? 'edge' : 'contour'} start, comma-separated — blank = auto)
                </Label>
                <Input
                  type="text"
                  value={cfg.tabPositionsMm}
                  placeholder="auto"
                  onChange={e => updateRoutingConfig({ tabPositionsMm: e.target.value })}
                  className={numInputCls}
                />
              </div>
            )}
            <div className="flex items-center justify-between">
              <Label className="text-xs text-[#94b8d4]" title="Off draws the route at the real bit width so the layer shows the cut swath.">
                Hairline route Gerber
              </Label>
              <Switch
                checked={cfg.routeGerberHairline}
                onCheckedChange={v => updateRoutingConfig({ routeGerberHairline: v })}
                className="scale-75"
              />
            </div>
          </div>
        </div>

        {/* ------------------------------------------------------ Issues */}
        {issues.length > 0 && (
          <>
            <Separator className="bg-[#1a3a5c]" />
            <div className="space-y-1.5">
              {issues.map(issue => {
                const s = SEVERITY_STYLE[issue.severity]
                const Icon = s.icon
                return (
                  <div
                    key={issue.id}
                    className="rounded-md p-2 border"
                    style={{ background: s.bg, borderColor: s.border }}
                  >
                    <div className="flex items-start gap-1.5">
                      <Icon className="w-3 h-3 mt-0.5 shrink-0" style={{ color: s.color }} />
                      <div className="min-w-0 flex-1">
                        <div className="text-[11px] font-medium" style={{ color: s.color }}>
                          {issue.title}
                        </div>
                        <div className="text-[10px] text-[#94b8d4] mt-0.5 leading-snug">
                          {issue.detail}
                        </div>
                        {issue.fix && (
                          <Button
                            size="sm"
                            onClick={() => applyFix(issue)}
                            className="mt-1.5 h-6 px-2 text-[10px] bg-[#0ea5e9] hover:bg-[#0ea5e9]/80 text-white"
                          >
                            {issue.fix.label}
                            {issue.fix.rebuildPanel && ' + rebuild panel'}
                          </Button>
                        )}
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          </>
        )}

        {/* ---------------------------------------------------- Generate */}
        <Separator className="bg-[#1a3a5c]" />
        <Button
          onClick={() => { void generateRouting() }}
          disabled={!panelResult || routingGenerating}
          className="w-full bg-[#0ea5e9] hover:bg-[#0ea5e9]/80 text-white h-8 text-xs font-medium disabled:opacity-40"
        >
          <Play className="w-3 h-3 mr-1.5" />
          {routingGenerating ? 'Tracing outline…' : routingResult ? 'Regenerate Routing' : 'Generate Routing'}
        </Button>
        {!panelResult && (
          <p className="text-[10px] text-[#4a6f94] text-center -mt-2">
            Create a panel first on the Panel Config tab.
          </p>
        )}

        {routingStale && routingResult && (
          <div className="rounded-md p-2 border bg-yellow-950/40 border-yellow-800/40">
            <div className="flex items-start gap-1.5">
              <AlertTriangle className="w-3 h-3 mt-0.5 text-yellow-500 shrink-0" />
              <div className="text-[10px] text-yellow-300 leading-snug">
                Settings changed since this plan was generated. The paths below — and any file you
                download — still reflect the <strong>previous</strong> settings. Regenerate to update.
              </div>
            </div>
          </div>
        )}

        {/* ----------------------------------------------------- Summary */}
        {routingResult && (
          <>
            <Separator className="bg-[#1a3a5c]" />
            <div>
              <Label className={sectionLabelCls}>
                <CheckCircle2 className="w-3 h-3 text-[#0ea5e9]" />
                Plan
              </Label>
              <div className="mt-2 bg-[#061628]/80 rounded-md p-2 text-[10px] font-mono text-[#4a6f94] space-y-0.5">
                <div>
                  Outline: {routingResult.pcbOutlineMode === 'contour' ? 'traced contour' : 'bounding box'}
                  {cfg.pcbOutlineMode === 'auto' && ` (auto → ${routingResult.pcbOutlineMode})`}
                </div>
                <div>Passes: {routingResult.paths.length}</div>
                {routingResult.pcbOutlineMode === 'contour' && (
                  <div>Cutouts: {routingResult.paths.filter(p => p.role === 'pcb-cutout').length}</div>
                )}
                <div>Cut length: {routingResult.totalPathLengthMm.toFixed(1)} mm</div>
                <div>Tabs: {routingResult.tabs.length}</div>
                {holeCount > 0 && <div>Mouse-bite holes: {holeCount}</div>}
                <div>
                  Tools:{' '}
                  {routingResult.tools
                    .map(t => `T${t.index.toString().padStart(2, '0')} ${t.diameterMm}mm ${t.kind}`)
                    .join(', ') || '—'}
                </div>
                <div className="text-[#2d5578]">
                  Paths are tool-center, offset {(routingResult.config.bitDiameterMm / 2).toFixed(3)}mm outward
                </div>
              </div>

              {routingResult.tabs.length > 0 && (
                <div className="mt-2 max-h-32 overflow-y-auto space-y-0.5">
                  {routingResult.tabs.slice(0, 40).map(tab => (
                    <button
                      key={tab.id}
                      onClick={() => setRoutingFocus({ x: tab.center.x, y: tab.center.y })}
                      className="w-full text-left text-[10px] font-mono px-1.5 py-0.5 rounded text-[#94b8d4] hover:bg-[#0f2848] hover:text-white transition-colors"
                    >
                      {tab.edge.padEnd(6)} @ {tab.center.x.toFixed(2)}, {tab.center.y.toFixed(2)}
                      {tab.holes.length > 0 && ` · ${tab.holes.length} holes`}
                    </button>
                  ))}
                  {routingResult.tabs.length > 40 && (
                    <div className="text-[10px] text-[#2d5578] px-1.5">
                      …and {routingResult.tabs.length - 40} more
                    </div>
                  )}
                </div>
              )}
            </div>

            <Button
              onClick={handleDownload}
              disabled={exporting || routingResult.paths.length === 0 || routingResult.issues.some(i => i.severity === 'error')}
              className="w-full h-9 bg-[#0ea5e9] hover:bg-[#0ea5e9]/80 text-white text-sm disabled:opacity-40"
            >
              <Download className="w-4 h-4 mr-1.5" />
              {exporting ? 'Preparing…' : 'Download Route Files'}
            </Button>
            <p className="text-[10px] text-[#4a6f94] text-center -mt-2">
              {routingResult.issues.some(i => i.severity === 'error')
                ? 'Resolve the error(s) above before downloading.'
                : 'Route files are also included in the full panel export.'}
            </p>
          </>
        )}
      </CardContent>
    </Card>
  )
}
