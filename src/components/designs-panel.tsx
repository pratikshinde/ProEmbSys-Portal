'use client'

import React, { useMemo, useState } from 'react'
import { useAppStore } from '@/lib/store'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Boxes, Pencil, Check, Trash2, Search, CheckCircle2 } from 'lucide-react'
import type { PackCandidate } from '@/lib/packing/pack'

/** Small rectangles-only preview of a candidate layout — no Gerber content,
 *  just each placement's own design color, enough to compare candidates at
 *  a glance. Real per-design geometry rendering is a later update (once the
 *  viewer itself supports more than one design's content — see the plan). */
function CandidateMiniPreview({ candidate, colorByDesign }: { candidate: PackCandidate; colorByDesign: Map<string, string> }) {
  const pad = 4
  const scale = Math.min(120 / (candidate.panelWidthMm || 1), 80 / (candidate.panelHeightMm || 1))
  const w = candidate.panelWidthMm * scale
  const h = candidate.panelHeightMm * scale
  return (
    <svg width={w + pad * 2} height={h + pad * 2} className="flex-shrink-0">
      <rect x={0} y={0} width={w + pad * 2} height={h + pad * 2} fill="#061628" rx={3} />
      {candidate.items.map((it, i) => (
        <rect
          key={i}
          x={pad + it.x * scale}
          y={pad + (candidate.panelHeightMm - it.y - it.h) * scale}
          width={Math.max(1, it.w * scale)}
          height={Math.max(1, it.h * scale)}
          fill={colorByDesign.get(it.designId) ?? '#0ea5e9'}
          stroke="#0a1e38"
          strokeWidth={0.5}
        />
      ))}
    </svg>
  )
}

export default function DesignsPanel() {
  const designs = useAppStore(s => s.designs)
  const activeDesignId = useAppStore(s => s.activeDesignId)
  const setActiveDesignId = useAppStore(s => s.setActiveDesignId)
  const renameDesign = useAppStore(s => s.renameDesign)
  const updateDesign = useAppStore(s => s.updateDesign)
  const removeDesign = useAppStore(s => s.removeDesign)
  const layers = useAppStore(s => s.layers)

  const materialSizeMm = useAppStore(s => s.materialSizeMm)
  const updateMaterialSize = useAppStore(s => s.updateMaterialSize)
  const packCandidates = useAppStore(s => s.packCandidates)
  const packInfeasible = useAppStore(s => s.packInfeasible)
  const selectedCandidateId = useAppStore(s => s.selectedCandidateId)
  const selectPackCandidate = useAppStore(s => s.selectPackCandidate)
  const findPackCandidatesAction = useAppStore(s => s.findPackCandidatesAction)
  const applyPackCandidateAction = useAppStore(s => s.applyPackCandidateAction)
  const panelResult = useAppStore(s => s.panelResult)

  const [editingId, setEditingId] = useState<string | null>(null)
  const [draftName, setDraftName] = useState('')

  const colorByDesign = useMemo(() => new Map(designs.map(d => [d.id, d.color])), [designs])

  const startEdit = (id: string, currentName: string) => {
    setEditingId(id)
    setDraftName(currentName)
  }
  const commitEdit = () => {
    if (editingId && draftName.trim()) renameDesign(editingId, draftName.trim())
    setEditingId(null)
  }

  const selectedCandidate = packCandidates?.find(c => c.id === selectedCandidateId) ?? null

  return (
    <div className="space-y-3">
      <Card className="border-[#1a3a5c] bg-[#0a1e38]/70">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold flex items-center gap-2 text-[#f0f8ff]">
            <Boxes className="w-4 h-4 text-[#0ea5e9]" />
            Designs
            {designs.length > 0 && (
              <Badge variant="secondary" className="text-[9px] px-1.5 py-0 h-4 bg-[#0f2848] text-[#94b8d4]">
                {designs.length}
              </Badge>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-xs">
          {designs.length === 0 ? (
            <p className="text-[#4a6f94]">
              Import a Gerber ZIP/RAR or loose files on the Layers tab to create a design.
              Each archive becomes its own design; loose files join whichever design is active.
            </p>
          ) : (
            designs.map(d => {
              const count = layers.filter(l => l.designId === d.id).length
              const isActive = d.id === activeDesignId
              return (
                <div
                  key={d.id}
                  className={`rounded-md border px-2 py-1.5 space-y-1.5 ${
                    isActive ? 'border-[#0ea5e9]/50 bg-[#0ea5e9]/10' : 'border-[#1a3a5c] bg-[#0f2848]/40'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: d.color }} title={d.color} />
                    {editingId === d.id ? (
                      <div className="flex-1 flex items-center gap-1">
                        <Input
                          autoFocus
                          value={draftName}
                          onChange={e => setDraftName(e.target.value)}
                          onKeyDown={e => { if (e.key === 'Enter') commitEdit(); if (e.key === 'Escape') setEditingId(null) }}
                          className="h-6 text-xs bg-[#061628] border-[#1a3a5c]"
                        />
                        <button onClick={commitEdit} className="text-[#0ea5e9] hover:text-white flex-shrink-0" title="Save name">
                          <Check className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    ) : (
                      <>
                        <button
                          onClick={() => setActiveDesignId(d.id)}
                          className={`flex-1 text-left truncate ${isActive ? 'text-[#f0f8ff] font-medium' : 'text-[#94b8d4] hover:text-white'}`}
                          title={isActive ? 'Active design' : 'Set as active design'}
                        >
                          {d.name}
                        </button>
                        <span className="text-[#4a6f94] flex-shrink-0">{count} layer{count === 1 ? '' : 's'}</span>
                        <button onClick={() => startEdit(d.id, d.name)} className="text-[#4a6f94] hover:text-[#0ea5e9] flex-shrink-0" title="Rename design">
                          <Pencil className="w-3 h-3" />
                        </button>
                        <button
                          onClick={() => { if (confirm(`Remove "${d.name}" and its ${count} layer${count === 1 ? '' : 's'}?`)) removeDesign(d.id) }}
                          className="text-[#4a6f94] hover:text-red-400 flex-shrink-0"
                          title="Remove design"
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      </>
                    )}
                    {isActive && !editingId && (
                      <Badge variant="secondary" className="text-[8px] px-1 py-0 h-4 bg-[#0ea5e9]/20 text-[#0ea5e9] flex-shrink-0">Active</Badge>
                    )}
                  </div>
                  {/* Per-design packing parameters — read by findPackCandidatesAction */}
                  <div className="flex items-center gap-3 pl-4.5 text-[#4a6f94]">
                    <label className="flex items-center gap-1">
                      Min
                      <Input
                        type="number" min={0}
                        value={d.minCount}
                        onChange={e => updateDesign(d.id, { minCount: Math.max(0, parseInt(e.target.value) || 0) })}
                        className="h-5 w-12 text-[10px] px-1 bg-[#061628] border-[#1a3a5c]"
                      />
                    </label>
                    <label className="flex items-center gap-1">
                      Max
                      <Input
                        type="number" min={0}
                        placeholder="∞"
                        value={d.maxCount ?? ''}
                        onChange={e => {
                          const v = e.target.value.trim()
                          updateDesign(d.id, { maxCount: v === '' ? null : Math.max(0, parseInt(v) || 0) })
                        }}
                        className="h-5 w-12 text-[10px] px-1 bg-[#061628] border-[#1a3a5c]"
                      />
                    </label>
                    <label className="flex items-center gap-1 opacity-50" title="Rotated packing isn't supported yet — a rotated placement's exported Gerber content wouldn't actually be rotated to match. Designs pack at their native orientation only.">
                      Rotate
                      <Switch
                        checked={false}
                        disabled
                        onCheckedChange={() => {}}
                        className="scale-75"
                      />
                    </label>
                  </div>
                </div>
              )
            })
          )}
        </CardContent>
      </Card>

      {designs.length > 0 && (
        <Card className="border-[#1a3a5c] bg-[#0a1e38]/70">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold text-[#f0f8ff]">Multi-Design Packing</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-xs">
            <p className="text-[#4a6f94] leading-relaxed">
              Max material sheet size — the panel then shrinks to fit whatever actually gets placed.
              Per-design Min/Max/Rotate above feed the search.
            </p>
            <div className="flex items-center gap-2">
              <label className="flex-1 flex items-center gap-1.5">
                <span className="text-[#94b8d4] w-8">W</span>
                <Input
                  type="number" min={1}
                  value={materialSizeMm.widthMm}
                  onChange={e => updateMaterialSize({ widthMm: Math.max(1, parseFloat(e.target.value) || 1) })}
                  className="h-7 text-xs bg-[#061628] border-[#1a3a5c]"
                />
              </label>
              <label className="flex-1 flex items-center gap-1.5">
                <span className="text-[#94b8d4] w-8">H</span>
                <Input
                  type="number" min={1}
                  value={materialSizeMm.heightMm}
                  onChange={e => updateMaterialSize({ heightMm: Math.max(1, parseFloat(e.target.value) || 1) })}
                  className="h-7 text-xs bg-[#061628] border-[#1a3a5c]"
                />
              </label>
              <span className="text-[#4a6f94]">mm</span>
            </div>

            <Button
              onClick={findPackCandidatesAction}
              className="w-full bg-[#0ea5e9] hover:bg-[#0ea5e9]/80 text-white h-8 text-xs font-medium"
            >
              <Search className="w-3 h-3 mr-1.5" />
              Find Layouts
            </Button>

            {packCandidates !== null && packCandidates.length === 0 && (
              <div className="text-[#f59e0b] bg-[#f59e0b]/10 border border-[#f59e0b]/30 rounded-md p-2">
                No layout fits every design&apos;s minimum count into {materialSizeMm.widthMm}×{materialSizeMm.heightMm}mm.
                {packInfeasible.length > 0 && (
                  <div className="mt-1 text-[#4a6f94]">{packInfeasible[0].reason}</div>
                )}
              </div>
            )}

            {packCandidates !== null && packCandidates.length > 0 && (
              <div className="space-y-2">
                <div className="max-h-64 overflow-y-auto space-y-1.5 pr-1">
                  {packCandidates.map(c => (
                    <button
                      key={c.id}
                      onClick={() => selectPackCandidate(c.id)}
                      className={`w-full text-left rounded-md border p-2 flex items-center gap-2 transition-colors ${
                        c.id === selectedCandidateId ? 'border-[#0ea5e9] bg-[#0ea5e9]/10' : 'border-[#1a3a5c] bg-[#0f2848]/40 hover:border-[#0ea5e9]/40'
                      }`}
                    >
                      <CandidateMiniPreview candidate={c} colorByDesign={colorByDesign} />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <Badge variant="secondary" className="text-[8px] px-1 py-0 h-4 bg-[#0f2848] text-[#94b8d4]">{c.strategy}</Badge>
                          <Badge variant="secondary" className="text-[8px] px-1 py-0 h-4 bg-[#0f2848] text-[#94b8d4]">{c.fillOrder}</Badge>
                          {c.id === selectedCandidateId && <CheckCircle2 className="w-3 h-3 text-[#0ea5e9]" />}
                        </div>
                        <div className="text-[#f0f8ff] mt-1">
                          {c.panelWidthMm.toFixed(1)}×{c.panelHeightMm.toFixed(1)}mm · {c.totalBoards} boards · {(c.efficiency * 100).toFixed(0)}% used
                        </div>
                        <div className="text-[#4a6f94] mt-0.5 truncate">
                          {Object.entries(c.countsByDesign).map(([id, n]) => `${designs.find(d => d.id === id)?.name ?? id}: ${n}`).join(', ')}
                        </div>
                      </div>
                    </button>
                  ))}
                </div>

                <Button
                  onClick={() => applyPackCandidateAction()}
                  disabled={!selectedCandidate}
                  className="w-full bg-emerald-600 hover:bg-emerald-600/80 text-white h-8 text-xs font-medium disabled:opacity-40"
                >
                  <CheckCircle2 className="w-3 h-3 mr-1.5" />
                  Use This Layout
                </Button>
                {panelResult?.source === 'pack' && (
                  <p className="text-[10px] text-[#4a6f94] leading-relaxed">
                    Each design renders, exports, and routes with its own content at its own placements — including
                    depaneling routing and G-Code.
                  </p>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  )
}
