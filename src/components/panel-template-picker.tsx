'use client'

import React from 'react'
import { useSession } from 'next-auth/react'
import { useAppStore } from '@/lib/store'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Separator } from '@/components/ui/separator'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Bookmark, Play, Save, AlertTriangle } from 'lucide-react'
import { toast } from '@/hooks/use-toast'
import {
  extractPanelTemplateSettings,
  PANEL_TEMPLATE_SECTIONS,
  PANEL_TEMPLATE_SECTION_LABELS,
  type PanelTemplateSection,
  type ResolvedPanelTemplateSettings,
} from '@/lib/panel-template/types'

interface TemplateDto {
  id: string
  scope: 'PRIVATE' | 'SHARED'
  name: string
  settings: ResolvedPanelTemplateSettings
  isDefault: boolean
  isSystem: boolean
  editable: boolean
}

const numInputCls = 'h-7 text-xs bg-[#061628] border-[#1a3a5c] text-[#f0f8ff]'
const fieldLabelCls = 'text-[10px] text-[#4a6f94]'

export default function PanelTemplatePicker() {
  const { data: session, status: sessionStatus } = useSession()
  const signedIn = sessionStatus === 'authenticated'
  const isStaff = session?.user?.role === 'ADMIN' || session?.user?.role === 'ENGINEER'

  const panelConfig = useAppStore(s => s.panelConfig)
  const outputFormat = useAppStore(s => s.outputFormat)
  const routingConfig = useAppStore(s => s.routingConfig)
  const gcodeContext = useAppStore(s => s.gcodeContext)
  const panelArrayConfig = useAppStore(s => s.panelArrayConfig)
  const panelResult = useAppStore(s => s.panelResult)
  const panelTemplateId = useAppStore(s => s.panelTemplateId)
  const setPanelTemplateId = useAppStore(s => s.setPanelTemplateId)
  const applyPanelTemplate = useAppStore(s => s.applyPanelTemplate)

  const [templates, setTemplates] = React.useState<TemplateDto[]>([])
  const [loading, setLoading] = React.useState(true)
  const [sections, setSections] = React.useState<Set<PanelTemplateSection>>(
    () => new Set(PANEL_TEMPLATE_SECTIONS)
  )
  const [saveName, setSaveName] = React.useState('')
  const [saving, setSaving] = React.useState(false)
  const [publishing, setPublishing] = React.useState(false)
  const [justApplied, setJustApplied] = React.useState(false)

  const selected = templates.find(t => t.id === panelTemplateId) ?? null

  // Load the pickable templates (SHARED for everyone, plus own PRIVATE ones).
  // Display-only: this never writes any config — see applyPanelTemplate for
  // the one place that does, and CLAUDE.md for why that differs from the DFM
  // picker's auto-apply-on-select.
  React.useEffect(() => {
    let cancelled = false
    fetch('/api/panel-templates')
      .then(res => (res.ok ? res.json() : []))
      .then((list: TemplateDto[]) => {
        if (cancelled) return
        setTemplates(list)
        setPanelTemplateId(
          useAppStore.getState().panelTemplateId ??
            (list.find(t => t.isDefault && t.scope === 'PRIVATE')?.id ??
              list.find(t => t.isDefault)?.id ??
              list[0]?.id ??
              null)
        )
      })
      .finally(() => !cancelled && setLoading(false))
    return () => { cancelled = true }
    // sessionStatus is a dep so signing in/out refetches the visible set.
  }, [sessionStatus, setPanelTemplateId])

  React.useEffect(() => {
    setSaveName(selected?.name ?? '')
  }, [selected])

  const currentSettings = React.useMemo(
    () => extractPanelTemplateSettings({ panelConfig, outputFormat, routingConfig, gcodeContext, panelArrayConfig }),
    [panelConfig, outputFormat, routingConfig, gcodeContext, panelArrayConfig]
  )

  // Compares the CURRENT (post-grid-strip) settings against the selected
  // template's own resolved settings — because both sides go through the
  // same extraction/resolution, changing rows/cols/gapX/gapY never shows as
  // a difference here.
  const isDirty = selected ? JSON.stringify(currentSettings) !== JSON.stringify({
    panel: selected.settings.panel,
    output: selected.settings.output,
    routing: selected.settings.routing,
    gcode: selected.settings.gcode,
    array: selected.settings.array,
  }) : false

  function toggleSection(section: PanelTemplateSection) {
    setSections(prev => {
      const next = new Set(prev)
      if (next.has(section)) next.delete(section)
      else next.add(section)
      return next
    })
  }

  function handleApply() {
    if (!selected) return
    applyPanelTemplate(selected.settings, [...sections])
    setJustApplied(true)
    toast({ title: 'Template applied', description: selected.name })
  }

  async function handleSave(mode: 'update' | 'new') {
    const isUpdate = mode === 'update' && selected?.editable
    const name = saveName.trim() || `${selected?.name ?? 'Custom'} (copy)`
    if (!name) {
      toast({ title: 'Name required', description: 'Give the template a name.' })
      return
    }
    setSaving(true)
    try {
      const url = isUpdate ? `/api/panel-templates/${selected!.id}` : '/api/panel-templates'
      const res = await fetch(url, {
        method: isUpdate ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, settings: currentSettings }),
      })
      const saved = await res.json()
      if (!res.ok) {
        toast({ title: 'Could not save template', description: saved.error ?? 'Please try again.' })
        return
      }
      setTemplates(prev => (isUpdate ? prev.map(t => (t.id === saved.id ? saved : t)) : [...prev, saved]))
      setPanelTemplateId(saved.id)
      toast({ title: isUpdate ? 'Template updated' : 'Template created', description: saved.name })
    } finally {
      setSaving(false)
    }
  }

  async function handlePublish() {
    const name = saveName.trim() || `${selected?.name ?? 'Custom'} (shared)`
    setPublishing(true)
    try {
      const res = await fetch('/api/admin/panel-templates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, settings: currentSettings }),
      })
      const saved = await res.json()
      if (!res.ok) {
        toast({ title: 'Could not publish template', description: saved.error ?? 'Please try again.' })
        return
      }
      setTemplates(prev => [...prev, saved])
      setPanelTemplateId(saved.id)
      toast({ title: 'Published as shared template', description: saved.name })
    } finally {
      setPublishing(false)
    }
  }

  return (
    <Card className="border-[#1a3a5c] bg-[#0a1e38]/70">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-semibold flex items-center gap-2 text-[#f0f8ff]">
          <Bookmark className="w-4 h-4 text-[#0ea5e9]" />
          Panelization Template
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0 space-y-4">
        <p className="text-[10px] text-[#4a6f94]">
          Save the current rib/hole/routing/G-code/array settings as a reusable template, or apply a
          saved one. Row/column/gap layout is never included — that stays whatever you&apos;ve already
          set for this job.
        </p>

        <div>
          <Label className={fieldLabelCls}>Template</Label>
          <Select
            value={panelTemplateId ?? ''}
            onValueChange={(v) => { setPanelTemplateId(v); setJustApplied(false) }}
            disabled={loading || templates.length === 0}
          >
            <SelectTrigger className="h-7 text-xs bg-[#061628] border-[#1a3a5c] text-[#f0f8ff] mt-1">
              <SelectValue placeholder={loading ? 'Loading…' : 'Select a template'} />
            </SelectTrigger>
            <SelectContent className="bg-[#0a1e38] border-[#1a3a5c]">
              {templates.map(t => (
                <SelectItem key={t.id} value={t.id}>
                  {t.name}
                  {t.scope === 'SHARED' ? ' (shared)' : ''}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div>
          <Label className={fieldLabelCls}>Sections to apply</Label>
          <div className="mt-1.5 grid grid-cols-2 gap-1.5">
            {PANEL_TEMPLATE_SECTIONS.map(section => (
              <label key={section} className="flex items-center gap-1.5 text-xs text-[#94b8d4] cursor-pointer">
                <Checkbox
                  checked={sections.has(section)}
                  onCheckedChange={() => toggleSection(section)}
                  className="h-3.5 w-3.5 border-[#1a3a5c] data-[state=checked]:bg-[#0ea5e9] data-[state=checked]:border-[#0ea5e9]"
                />
                {PANEL_TEMPLATE_SECTION_LABELS[section]}
              </label>
            ))}
          </div>
        </div>

        <Button
          onClick={handleApply}
          disabled={!selected || sections.size === 0}
          className="w-full bg-[#0ea5e9] hover:bg-[#0ea5e9]/80 text-white h-8 text-xs font-medium disabled:opacity-40"
        >
          <Play className="w-3 h-3 mr-1.5" />
          Apply to Settings
        </Button>

        {justApplied && sections.has('panel') && panelResult && (
          <div className="rounded-md p-2 border bg-yellow-950/40 border-yellow-800/40">
            <div className="flex items-start gap-1.5">
              <AlertTriangle className="w-3 h-3 mt-0.5 text-yellow-500 shrink-0" />
              <div className="text-[10px] text-yellow-300 leading-snug">
                Panel settings changed. Click Create Panel to rebuild with these settings.
              </div>
            </div>
          </div>
        )}

        <Separator className="bg-[#1a3a5c]" />

        {!signedIn ? (
          <p className="text-[10px] text-[#4a6f94]">
            Sign in to save your own templates. You can still apply the shared ones above.
          </p>
        ) : (
          <div className="space-y-2">
            <div>
              <Label className={fieldLabelCls}>Save current settings as</Label>
              <Input
                value={saveName}
                onChange={(e) => setSaveName(e.target.value)}
                placeholder="e.g. Standard 2-layer"
                className={`${numInputCls} mt-1`}
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Button
                variant="outline"
                onClick={() => handleSave('update')}
                disabled={saving || !selected?.editable}
                className="h-7 text-xs border-[#1a3a5c] text-[#94b8d4] hover:bg-[#0f2848] disabled:opacity-40"
              >
                <Save className="w-3 h-3 mr-1.5" />
                {saving ? 'Saving…' : 'Save'}
              </Button>
              <Button
                variant="outline"
                onClick={() => handleSave('new')}
                disabled={saving}
                className="h-7 text-xs border-[#1a3a5c] text-[#94b8d4] hover:bg-[#0f2848] disabled:opacity-40"
              >
                <Save className="w-3 h-3 mr-1.5" />
                {saving ? 'Saving…' : 'Save as New'}
              </Button>
            </div>
            {selected && !selected.editable && (
              <p className="text-[10px] text-[#4a6f94]">
                {selected.scope === 'SHARED' ? 'This is a shared template — s' : 'S'}ave as new to create
                your own editable copy.
              </p>
            )}
            {isDirty && selected && (
              <p className="text-[10px] text-amber-400">Current settings differ from &quot;{selected.name}&quot;.</p>
            )}

            {isStaff && (
              <>
                <Separator className="bg-[#1a3a5c]" />
                <Button
                  variant="outline"
                  onClick={handlePublish}
                  disabled={publishing}
                  className="w-full h-7 text-xs border-[#0ea5e9]/50 text-[#0ea5e9] hover:bg-[#0ea5e9]/10 disabled:opacity-40"
                >
                  {publishing ? 'Publishing…' : 'Publish as Shared'}
                </Button>
                <p className="text-[10px] text-[#4a6f94]">
                  Publishes the current settings as a shared template every user (including signed-out
                  visitors) can select.
                </p>
              </>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
