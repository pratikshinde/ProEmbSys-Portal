'use client'

import React from 'react'
import { useSession } from 'next-auth/react'
import { useAppStore } from '@/lib/store'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ShieldCheck, AlertTriangle, XCircle, Info, CheckCircle2, Play, Save, Loader2 } from 'lucide-react'
import { toast } from '@/hooks/use-toast'
import { DEFAULT_DFM_RULES, type DfmFinding, type DfmLimit, type DfmRules } from '@/lib/dfm/types'

interface TemplateDto {
  id: string
  scope: 'PRIVATE' | 'SHARED'
  name: string
  rules: DfmRules
  isDefault: boolean
  isSystem: boolean
  editable: boolean
}

const SEVERITY_META = {
  error: { icon: XCircle, color: '#f87171', bg: 'rgba(239,68,68,0.12)', one: 'error', many: 'errors' },
  warning: { icon: AlertTriangle, color: '#fbbf24', bg: 'rgba(245,158,11,0.12)', one: 'warning', many: 'warnings' },
  info: { icon: Info, color: '#60a5fa', bg: 'rgba(59,130,246,0.12)', one: 'info', many: 'infos' },
  // "pass" doesn't pluralise by appending -s.
  pass: { icon: CheckCircle2, color: '#4ade80', bg: 'rgba(34,197,94,0.12)', one: 'pass', many: 'passes' },
} as const

/** Editable rule fields, in display order. Annular-ring and mask-clearance are
 *  stored on the template (so saved templates don't need migrating when those
 *  checks land in roadmap Phases 2/3) but aren't evaluated yet — flagged as
 *  such rather than silently implying they're being checked. */
const LIMIT_FIELDS: { key: keyof DfmRules; label: string; pending?: boolean }[] = [
  { key: 'minTraceWidthMm', label: 'Min trace width (mm)' },
  { key: 'minCopperSpacingMm', label: 'Min copper spacing (mm)' },
  { key: 'minDrillMm', label: 'Min drill diameter (mm)' },
  { key: 'minSilkLineWidthMm', label: 'Min silkscreen line (mm)' },
  { key: 'minAnnularRingMm', label: 'Min annular ring (mm)' },
  { key: 'minMaskClearanceMm', label: 'Min mask clearance (mm)', pending: true },
]

export default function DfmPanel() {
  const { status: sessionStatus } = useSession()
  const layers = useAppStore(s => s.layers)
  const dfmReport = useAppStore(s => s.dfmReport)
  const dfmRunning = useAppStore(s => s.dfmRunning)
  const runDfmCheck = useAppStore(s => s.runDfmCheck)
  const setDfmFocus = useAppStore(s => s.setDfmFocus)
  const dfmTemplateId = useAppStore(s => s.dfmTemplateId)
  const setDfmTemplateId = useAppStore(s => s.setDfmTemplateId)
  const dfmContext = useAppStore(s => s.dfmContext)
  const updateDfmContext = useAppStore(s => s.updateDfmContext)

  const [templates, setTemplates] = React.useState<TemplateDto[]>([])
  const [loading, setLoading] = React.useState(true)
  const [draftRules, setDraftRules] = React.useState<DfmRules>(DEFAULT_DFM_RULES)
  const [dirty, setDirty] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [showEditor, setShowEditor] = React.useState(false)

  // Only PERSISTING a template needs an account — /api/dfm-templates is
  // publicly readable so the CAM tool works fully logged-out (see
  // CLAUDE.md's DFM section). The rule VALUE inputs below must never be
  // gated on `signedIn`: a logged-out user editing a threshold and clicking
  // "Run check" is exactly the documented no-login flow, and the caption
  // shown when signed out ("You can still run checks against the shared
  // ones") already promises this. Only the Save/"Save as new" buttons
  // further down are conditioned on `signedIn` — that's the real
  // auth boundary; disabling the inputs themselves was a second, redundant
  // gate that silently broke the documented logged-out flow entirely.
  const signedIn = sessionStatus === 'authenticated'
  const selected = templates.find(t => t.id === dfmTemplateId) ?? null

  // Load the pickable templates (SHARED for everyone, plus own PRIVATE ones).
  React.useEffect(() => {
    let cancelled = false
    fetch('/api/dfm-templates')
      .then(res => (res.ok ? res.json() : []))
      .then((list: TemplateDto[]) => {
        if (cancelled) return
        setTemplates(list)
        setDfmTemplateId(
          useAppStore.getState().dfmTemplateId ??
            (list.find(t => t.isDefault && t.scope === 'PRIVATE')?.id ??
              list.find(t => t.isDefault)?.id ??
              list[0]?.id ??
              null)
        )
      })
      .finally(() => !cancelled && setLoading(false))
    return () => { cancelled = true }
    // sessionStatus is a dep so signing in/out refetches the visible set.
  }, [sessionStatus, setDfmTemplateId])

  // Track the selected template's rules as the editable draft.
  React.useEffect(() => {
    if (selected) {
      setDraftRules(selected.rules)
      setDirty(false)
    }
  }, [selected])

  const activeRules = dirty ? draftRules : selected?.rules ?? DEFAULT_DFM_RULES

  function setLimit(key: keyof DfmRules, field: 'standard' | 'advanced', raw: string) {
    const num = Number(raw)
    if (!Number.isFinite(num) || num <= 0) return
    setDraftRules(prev => ({ ...prev, [key]: { ...(prev[key] as DfmLimit), [field]: num } }))
    setDirty(true)
  }

  async function saveTemplate(mode: 'update' | 'new') {
    setSaving(true)
    try {
      const isUpdate = mode === 'update' && selected?.editable
      const url = isUpdate ? `/api/dfm-templates/${selected!.id}` : '/api/dfm-templates'
      const name = isUpdate
        ? selected!.name
        : `${selected?.name ?? 'Custom'} (copy)`
      const res = await fetch(url, {
        method: isUpdate ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, rules: draftRules }),
      })
      const saved = await res.json()
      if (!res.ok) {
        toast({ title: 'Could not save template', description: saved.error ?? 'Please try again.' })
        return
      }
      setTemplates(prev => (isUpdate ? prev.map(t => (t.id === saved.id ? saved : t)) : [...prev, saved]))
      setDfmTemplateId(saved.id)
      setDirty(false)
      toast({ title: isUpdate ? 'Template updated' : 'Template created', description: saved.name })
    } finally {
      setSaving(false)
    }
  }

  const grouped = React.useMemo(() => {
    const order: DfmFinding['severity'][] = ['error', 'warning', 'info', 'pass']
    const findings = dfmReport?.findings ?? []
    return order
      .map(sev => ({ sev, items: findings.filter(f => f.severity === sev) }))
      .filter(g => g.items.length > 0)
  }, [dfmReport])

  return (
    <div className="flex flex-col gap-3">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm">
            <ShieldCheck className="h-4 w-4" /> DFM Check
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div>
            <Label className="text-xs">Rule template</Label>
            <Select
              value={dfmTemplateId ?? ''}
              onValueChange={setDfmTemplateId}
              disabled={loading || templates.length === 0}
            >
              <SelectTrigger className="mt-1">
                <SelectValue placeholder={loading ? 'Loading…' : 'Select a template'} />
              </SelectTrigger>
              <SelectContent>
                {templates.map(t => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.name}
                    {t.scope === 'SHARED' ? ' (shared)' : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Facts the Gerber files can't supply. */}
          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label className="text-xs">Board thickness (mm)</Label>
              <Input
                type="number"
                step="0.1"
                min="0.1"
                className="mt-1"
                value={dfmContext.boardThicknessMm ?? ''}
                onChange={e =>
                  updateDfmContext({
                    boardThicknessMm: e.target.value === '' ? undefined : Number(e.target.value),
                  })
                }
              />
            </div>
            <div>
              <Label className="text-xs">Layer count</Label>
              <Input
                type="number"
                step="1"
                min="1"
                className="mt-1"
                placeholder="auto"
                value={dfmContext.layerCount ?? ''}
                onChange={e =>
                  updateDfmContext({
                    layerCount: e.target.value === '' ? undefined : Number(e.target.value),
                  })
                }
              />
            </div>
          </div>
          <p className="text-[11px] text-muted-foreground">
            Thickness isn&apos;t stored in Gerber data, and inner layers can&apos;t be detected from an
            outer-layer export — set them here. Leave layer count blank to use the detected copper sides.
          </p>

          <Button
            onClick={() => void runDfmCheck(activeRules)}
            disabled={layers.length === 0 || dfmRunning}
            className="w-full"
          >
            {dfmRunning ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Play className="mr-2 h-4 w-4" />
            )}
            {dfmRunning
              ? 'Checking…'
              : layers.length === 0
                ? 'Import layers to check'
                : 'Run check'}
          </Button>
        </CardContent>
      </Card>

      {/* Findings */}
      {dfmReport && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex flex-wrap items-center gap-2 text-sm">
              Results
              {(['error', 'warning', 'info', 'pass'] as const).map(sev => {
                const count = dfmReport.summary[
                  sev === 'error' ? 'errors' : sev === 'warning' ? 'warnings' : sev === 'info' ? 'infos' : 'passes'
                ]
                if (!count) return null
                const meta = SEVERITY_META[sev]
                return (
                  <span
                    key={sev}
                    className="rounded-md px-2 py-0.5 text-[11px] font-semibold"
                    style={{ backgroundColor: meta.bg, color: meta.color }}
                  >
                    {count} {count === 1 ? meta.one : meta.many}
                  </span>
                )
              })}
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {grouped.map(group => (
              <div key={group.sev} className="flex flex-col gap-2">
                {group.items.map(f => {
                  const meta = SEVERITY_META[f.severity]
                  const Icon = meta.icon
                  return (
                    <div
                      key={f.checkId}
                      className="flex gap-2 rounded-md p-2"
                      style={{ backgroundColor: meta.bg }}
                    >
                      <Icon className="mt-0.5 h-4 w-4 shrink-0" style={{ color: meta.color }} />
                      <div className="min-w-0 flex-1">
                        <div className="text-xs font-semibold text-foreground">{f.title}</div>
                        <div className="text-[11px] text-muted-foreground">{f.detail}</div>
                        {f.layerName && (
                          <div className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground">
                            {f.layerName}
                          </div>
                        )}
                        {f.locations && f.locations.length > 0 && (
                          <div className="mt-1 flex flex-wrap gap-1">
                            {f.locations.slice(0, 12).map((loc, i) => (
                              <button
                                key={`${loc.x},${loc.y},${i}`}
                                type="button"
                                onClick={() => setDfmFocus({ x: loc.x, y: loc.y })}
                                title={`Zoom to ${loc.x.toFixed(2)}, ${loc.y.toFixed(2)} mm`}
                                className="rounded border border-border bg-background/60 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground hover:border-primary hover:text-primary"
                              >
                                {loc.x.toFixed(1)}, {loc.y.toFixed(1)}
                              </button>
                            ))}
                            {f.locations.length > 12 && (
                              <span className="self-center text-[10px] text-muted-foreground">
                                +{f.locations.length - 12} more
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            ))}
            <p className="text-[11px] text-muted-foreground">
              Advisory only — findings never block an order. Copper clearance is measured between
              separate nets; solder-mask slivers and silkscreen-over-pad aren&apos;t checked yet.
            </p>
          </CardContent>
        </Card>
      )}

      {/* Rule editor */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center justify-between text-sm">
            <span>Rules</span>
            <Button variant="ghost" size="sm" onClick={() => setShowEditor(v => !v)}>
              {showEditor ? 'Hide' : 'Edit'}
            </Button>
          </CardTitle>
        </CardHeader>
        {showEditor && (
          <CardContent className="flex flex-col gap-3">
            <div className="grid grid-cols-[1fr_auto_auto] items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
              <span />
              <span className="w-16 text-center">Standard</span>
              <span className="w-16 text-center">Advanced</span>
            </div>
            {LIMIT_FIELDS.map(({ key, label, pending }) => {
              const limit = activeRules[key] as DfmLimit
              return (
                <div key={String(key)} className="grid grid-cols-[1fr_auto_auto] items-center gap-2">
                  <Label className="text-xs">
                    {label}
                    {pending && (
                      <span className="ml-1 text-[10px] text-muted-foreground">(not checked yet)</span>
                    )}
                  </Label>
                  <Input
                    type="number"
                    step="0.01"
                    className="h-8 w-16 text-xs"
                    value={limit.standard}
                    onChange={e => setLimit(key, 'standard', e.target.value)}
                  />
                  <Input
                    type="number"
                    step="0.01"
                    className="h-8 w-16 text-xs"
                    placeholder="—"
                    value={limit.advanced ?? ''}
                    onChange={e => setLimit(key, 'advanced', e.target.value)}
                  />
                </div>
              )
            })}

            <Separator />

            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label className="text-xs">Max board edge (mm)</Label>
                <Input
                  type="number"
                  className="mt-1 h-8 text-xs"
                  value={activeRules.maxBoardMm}
                  onChange={e => {
                    const n = Number(e.target.value)
                    if (!Number.isFinite(n) || n <= 0) return
                    setDraftRules(p => ({ ...p, maxBoardMm: n }))
                    setDirty(true)
                  }}
                />
              </div>
              <div>
                <Label className="text-xs">Max aspect ratio</Label>
                <Input
                  type="number"
                  className="mt-1 h-8 text-xs"
                  value={activeRules.maxAspectRatio}
                  onChange={e => {
                    const n = Number(e.target.value)
                    if (!Number.isFinite(n) || n <= 0) return
                    setDraftRules(p => ({ ...p, maxAspectRatio: n }))
                    setDirty(true)
                  }}
                />
              </div>
            </div>

            {!signedIn ? (
              <p className="text-[11px] text-muted-foreground">
                Sign in to save your own templates. You can still run checks against the shared ones.
              </p>
            ) : selected?.scope === 'SHARED' ? (
              <>
                <p className="text-[11px] text-muted-foreground">
                  Shared templates are managed by staff in the admin area. Save your changes as your own
                  template instead.
                </p>
                <Button size="sm" disabled={!dirty || saving} onClick={() => saveTemplate('new')}>
                  {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
                  Save as my template
                </Button>
              </>
            ) : (
              <div className="flex gap-2">
                <Button size="sm" className="flex-1" disabled={!dirty || saving} onClick={() => saveTemplate('update')}>
                  {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
                  Save
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="flex-1"
                  disabled={!dirty || saving}
                  onClick={() => saveTemplate('new')}
                >
                  Save as new
                </Button>
              </div>
            )}
          </CardContent>
        )}
      </Card>
    </div>
  )
}
