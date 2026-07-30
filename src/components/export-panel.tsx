'use client'

import React from 'react'
import { useAppStore } from '@/lib/store'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { FileText, Download, Package, Settings2, RotateCcw, AlertTriangle } from 'lucide-react'
import { exportPanelizedGerbers } from '@/lib/gerber-exporter'
import { LayerFile } from '@/lib/gerber-exporter'

export default function ExportPanel() {
  const panelInfo = useAppStore(s => s.panelInfo)
  const updatePanelInfo = useAppStore(s => s.updatePanelInfo)
  const panelResult = useAppStore(s => s.panelResult)
  const panelConfig = useAppStore(s => s.panelConfig)
  const updatePanelConfig = useAppStore(s => s.updatePanelConfig)
  const layers = useAppStore(s => s.layers)
  const outputFormat = useAppStore(s => s.outputFormat)
  const updateOutputFormat = useAppStore(s => s.updateOutputFormat)
  const resetOutputFormat = useAppStore(s => s.resetOutputFormat)
  const computePanelResult = useAppStore(s => s.computePanelResult)
  // Route files ride along in the full panel export when a plan exists.
  const routingResult = useAppStore(s => s.routingResult)
  const [exporting, setExporting] = React.useState(false)

  const handleExport = async () => {
    if (!panelResult || layers.length === 0) return

    setExporting(true)
    try {
      const layerFiles: LayerFile[] = layers.map(l => ({
        name: l.name,
        fileName: `panel_${l.type}_${l.id}.gerber`,
        content: l.rawContent,
        parsedLayer: l.parsedLayer,
        type: l.type,
        side: l.side,
      }))

      await exportPanelizedGerbers(layerFiles, panelResult, panelConfig, panelInfo, outputFormat, routingResult)
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
            <div>Date: {panelInfo.date} | Size: {panelResult.pcbWidth.toFixed(1)}×{panelResult.pcbHeight.toFixed(1)}mm</div>
            <div>Panel: {panelResult.panelWidth.toFixed(1)}×{panelResult.panelHeight.toFixed(1)}mm | Qty: {panelResult.totalPCBs}</div>
            <div className="break-all">Layers: {panelInfo.layers}</div>
          </div>
        )}

        <Separator className="bg-[#1a3a5c]" />

        {/* Export buttons */}
        <div className="space-y-2">
          <Button
            onClick={handleExport}
            disabled={!panelResult || layers.length === 0 || exporting}
            className="w-full h-9 bg-[#0ea5e9] hover:bg-[#0ea5e9]/80 text-white text-sm"
          >
            <Package className="w-4 h-4 mr-2" />
            {exporting ? 'Exporting...' : 'Export Panelized Gerbers (.zip)'}
          </Button>
          <p className="text-[10px] text-[#4a6f94] text-center">
            {formatLabel}, {outputFormat.unit}, {outputFormat.zeroOmission} zero omit, {outputFormat.notation} · includes outline, fiducials & README
          </p>
        </div>
      </CardContent>
    </Card>
  )
}
