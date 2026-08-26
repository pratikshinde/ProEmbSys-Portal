'use client'

import React from 'react'
import { useAppStore, type LayerEntry } from '@/lib/store'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { Film, AlertTriangle, RotateCcw } from 'lucide-react'
import { generateDescriptiveLayerName } from '@/lib/gerber-exporter'
import { defaultFilmLayerSetting } from '@/lib/film-types'

const fieldLabelCls = 'text-[10px] text-[#4a6f94]'
const sectionLabelCls = 'text-xs text-[#94b8d4] font-medium flex items-center gap-1.5'
const numInputCls = 'h-7 text-xs bg-[#061628] border-[#1a3a5c] text-[#f0f8ff]'

interface FilmExportCardProps {
  /** The same layer set the panel export will actually use (already scoped
   *  to single/multi mode by the caller) — a film row list built from
   *  anything else could silently disagree with what actually exports. */
  layers: LayerEntry[]
}

/**
 * "Film Plot (PDF)" section for the Info & Export tab — a flat section
 * (label row + content), matching how this tab already organizes Output
 * Format / Panel Information / Export as sections under ONE Card, not a
 * nested Card of its own. Deliberately has NO Generate button — films are
 * generated as part of the normal panel export (exportPanelizedGerbers),
 * landing in the ZIP's Film/ subfolder, exactly the Meta-Panelization/
 * precedent. This component only edits `filmConfig`; export-panel.tsx's
 * handleExport is what actually triggers rendering.
 */
export default function FilmExportCard({ layers }: FilmExportCardProps) {
  const filmConfig = useAppStore((s) => s.filmConfig)
  const updateFilmConfig = useAppStore((s) => s.updateFilmConfig)
  const setFilmLayerSetting = useAppStore((s) => s.setFilmLayerSetting)
  const resetFilmConfig = useAppStore((s) => s.resetFilmConfig)

  // One row per (type, side) — the export MERGES same-type-same-side layers
  // from every contributing design into ONE output Gerber, so film
  // generation is one-per-merge-group too, never one per raw imported
  // layer. Drill is Excellon, not a phototool, and is already excluded from
  // the merge groups upstream (gerber-exporter.ts) — omit its row entirely
  // rather than show a permanently-unchecked one.
  const rows = React.useMemo(() => {
    const seen = new Map<string, { descriptiveName: string; layerType: string }>()
    for (const l of layers) {
      if (l.type === 'drill') continue
      const descriptiveName = generateDescriptiveLayerName({
        name: l.name,
        fileName: l.fileName,
        content: '',
        parsedLayer: null,
        type: l.type,
        side: l.side,
      })
      if (!seen.has(descriptiveName)) seen.set(descriptiveName, { descriptiveName, layerType: l.type })
    }
    return Array.from(seen.values())
  }, [layers])

  const unresolved = rows.filter((r) => {
    const setting = filmConfig.layers[r.descriptiveName] ?? defaultFilmLayerSetting(r.layerType)
    return setting.include && !setting.polarity
  })

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <Label className={sectionLabelCls}>
          <Film className="w-3 h-3 text-[#0ea5e9]" />
          Film Plot (PDF)
        </Label>
        <Button
          variant="ghost"
          size="sm"
          onClick={resetFilmConfig}
          className="h-5 px-1.5 text-[10px] text-[#94b8d4] hover:text-white hover:bg-[#0f2848]"
        >
          <RotateCcw className="w-2.5 h-2.5 mr-0.5" />
          Reset
        </Button>
      </div>

      <div className="space-y-3">
        <p className="text-[10px] text-[#4a6f94]">
          Generates a 1:1-scale photo-plot film PDF for each selected layer, delivered inside the
          panel export ZIP under <span className="font-mono">Film/</span>. Never mirrored — every
          film matches the exported Gerber&apos;s own orientation exactly; flip bottom-side layers
          yourself at print time if your process needs it.
        </p>

        <div className="flex items-center justify-between">
          <Label className="text-xs text-[#94b8d4]">Generate film PDFs with this export</Label>
          <Switch
            checked={filmConfig.enabled}
            onCheckedChange={(v) => updateFilmConfig({ enabled: v })}
            className="scale-75"
          />
        </div>

        {filmConfig.enabled && (
          <>
            <Separator className="bg-[#1a3a5c]" />

            <div>
              <Label className={fieldLabelCls}>Margin around panel (mm)</Label>
              <Input
                type="number"
                min={0}
                max={50}
                step={1}
                value={filmConfig.marginMm}
                onChange={(e) => updateFilmConfig({ marginMm: Math.max(0, Math.min(50, parseFloat(e.target.value) || 0)) })}
                className={numInputCls}
              />
            </div>

            <Separator className="bg-[#1a3a5c]" />

            {rows.length === 0 ? (
              <p className="text-[10px] text-[#4a6f94]">No filmable layers loaded yet.</p>
            ) : (
              <div className="space-y-2">
                {rows.map((r) => {
                  const setting = filmConfig.layers[r.descriptiveName] ?? defaultFilmLayerSetting(r.layerType)
                  return (
                    <div key={r.descriptiveName} className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <Switch
                          checked={setting.include}
                          onCheckedChange={(v) => setFilmLayerSetting(r.descriptiveName, r.layerType, { include: v })}
                          className="scale-75 shrink-0"
                        />
                        <Label className="text-xs text-[#94b8d4] truncate">
                          {r.descriptiveName.replace(/_/g, ' ')}
                        </Label>
                      </div>
                      {setting.include && (
                        <Select
                          value={setting.polarity ?? undefined}
                          onValueChange={(v) => setFilmLayerSetting(r.descriptiveName, r.layerType, { polarity: v as 'positive' | 'negative' })}
                        >
                          <SelectTrigger
                            className={`h-6 w-28 text-[10px] shrink-0 bg-[#061628] text-[#f0f8ff] ${setting.polarity ? 'border-[#1a3a5c]' : 'border-red-800/60'}`}
                          >
                            <SelectValue placeholder="Choose…" />
                          </SelectTrigger>
                          <SelectContent className="bg-[#0a1e38] border-[#1a3a5c]">
                            <SelectItem value="positive" className="text-[11px] text-[#f0f8ff] focus:bg-[#0f2848]">Positive</SelectItem>
                            <SelectItem value="negative" className="text-[11px] text-[#f0f8ff] focus:bg-[#0f2848]">Negative</SelectItem>
                          </SelectContent>
                        </Select>
                      )}
                    </div>
                  )
                })}
              </div>
            )}

            {unresolved.length > 0 && (
              <div className="rounded-md p-2 border bg-red-950/40 border-red-800/40">
                <div className="flex items-start gap-1.5">
                  <AlertTriangle className="w-3 h-3 mt-0.5 text-red-400 shrink-0" />
                  <div className="text-[10px] text-red-300 leading-snug">
                    {unresolved.length} layer{unresolved.length !== 1 ? 's' : ''} still need a
                    Positive/Negative choice before film can be generated for {unresolved.length !== 1 ? 'them' : 'it'}:{' '}
                    {unresolved.map((r) => r.descriptiveName.replace(/_/g, ' ')).join(', ')}. The rest of the export is
                    unaffected — only these film(s) will be skipped.
                  </div>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
