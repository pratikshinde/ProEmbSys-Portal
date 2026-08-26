'use client'

import React from 'react'
import { useAppStore, type CamTab } from '@/lib/store'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Checkbox } from '@/components/ui/checkbox'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { Share2, CheckCircle2, XCircle, AlertTriangle, Send, RotateCcw, Ban, Clock, Users } from 'lucide-react'
import { toast } from '@/hooks/use-toast'
import { buildShareBundle, type ShareBundleKindLiteral } from '@/lib/share/build-bundle'
import type { ContactRecord } from './contact-list'

const sectionLabelCls = 'text-xs text-[#94b8d4] font-medium flex items-center gap-1.5'

const KIND_META: Record<ShareBundleKindLiteral, { label: string; description: string }> = {
  FILM: { label: 'Film Plotting', description: 'PDF films with per-layer positive/negative and layer info.' },
  DRILL: { label: 'Drilling', description: 'Drill + route files, plus G-Code programs when generated.' },
  TEST: { label: 'Bare-Board Test', description: 'Panelized Gerbers + drill (no IPC-D-356 netlist).' },
}

interface RecipientRow {
  id: string
  email: string
  name: string | null
  sentAt: string | null
  sendError: string | null
  attached: boolean
  firstAccessedAt: string | null
  lastAccessedAt: string | null
  accessCount: number
  revokedAt: string | null
  downloadUrl: string
}

interface BundleRow {
  id: string
  camJobId: string
  kind: ShareBundleKindLiteral
  fileName: string
  fileSize: number
  expiresAt: string
  createdAt: string
  recipients: RecipientRow[]
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export default function SharingPanel() {
  const layers = useAppStore((s) => s.layers)
  const designs = useAppStore((s) => s.designs)
  const camMode = useAppStore((s) => s.camMode)
  const activeDesignId = useAppStore((s) => s.activeDesignId)
  const panelResult = useAppStore((s) => s.panelResult)
  const panelConfig = useAppStore((s) => s.panelConfig)
  const panelInfo = useAppStore((s) => s.panelInfo)
  const outputFormat = useAppStore((s) => s.outputFormat)
  const routingResult = useAppStore((s) => s.routingResult)
  const gcodeFiles = useAppStore((s) => s.gcodeFiles)
  const filmConfig = useAppStore((s) => s.filmConfig)
  const lastSavedJobId = useAppStore((s) => s.lastSavedJobId)
  const setActiveTab = useAppStore((s) => s.setActiveTab)

  const shareLayers = React.useMemo(
    () => (camMode === 'single' && activeDesignId ? layers.filter((l) => l.designId === activeDesignId) : layers),
    [camMode, activeDesignId, layers]
  )

  const [kind, setKind] = React.useState<ShareBundleKindLiteral>('FILM')
  const [contacts, setContacts] = React.useState<ContactRecord[]>([])
  const [contactsLoaded, setContactsLoaded] = React.useState(false)
  const [selectedIds, setSelectedIds] = React.useState<string[]>([])
  const [message, setMessage] = React.useState('')
  const [sending, setSending] = React.useState(false)
  const [history, setHistory] = React.useState<BundleRow[]>([])
  const [historyLoaded, setHistoryLoaded] = React.useState(false)
  const [busyRecipientId, setBusyRecipientId] = React.useState<string | null>(null)

  React.useEffect(() => {
    fetch('/api/contacts')
      .then((res) => (res.ok ? res.json() : []))
      .then((data: ContactRecord[]) => setContacts(Array.isArray(data) ? data : []))
      .catch(() => setContacts([]))
      .finally(() => setContactsLoaded(true))
  }, [])

  const refreshHistory = React.useCallback(() => {
    if (!lastSavedJobId) {
      setHistory([])
      setHistoryLoaded(true)
      return
    }
    fetch(`/api/share/bundles?camJobId=${encodeURIComponent(lastSavedJobId)}`)
      .then((res) => (res.ok ? res.json() : { bundles: [] }))
      .then((data: { bundles: BundleRow[] }) => setHistory(data.bundles ?? []))
      .catch(() => setHistory([]))
      .finally(() => setHistoryLoaded(true))
  }, [lastSavedJobId])

  React.useEffect(() => {
    refreshHistory()
  }, [refreshHistory])

  // ------------------------------------------------------------ Readiness
  const filmLayerReady = Object.values(filmConfig.layers).some((s) => s.include && s.polarity)
  const hasDrillContent = shareLayers.some((l) => l.type === 'drill') || panelConfig.enableToolingHoles

  interface ChecklistItem { label: string; ok: boolean; jumpTab?: CamTab; required: boolean }
  const checklists: Record<ShareBundleKindLiteral, ChecklistItem[]> = {
    FILM: [
      { label: 'Panel computed', ok: !!panelResult, jumpTab: 'panel', required: true },
      { label: 'Film Plot enabled (Info & Export tab)', ok: filmConfig.enabled, jumpTab: 'export', required: true },
      { label: 'At least one layer included with Positive/Negative set', ok: filmLayerReady, jumpTab: 'export', required: true },
    ],
    DRILL: [
      { label: 'Panel computed', ok: !!panelResult, jumpTab: 'panel', required: true },
      { label: 'Drill layers loaded, or tooling holes enabled', ok: hasDrillContent, jumpTab: 'panel', required: true },
      { label: 'Routing plan generated (adds .rou + mouse bites)', ok: !!routingResult, jumpTab: 'routing', required: false },
      { label: 'G-Code generated (adds .ngc programs)', ok: !!gcodeFiles && gcodeFiles.length > 0, jumpTab: 'gcode', required: false },
    ],
    TEST: [{ label: 'Panel computed', ok: !!panelResult, jumpTab: 'panel', required: true }],
  }
  const activeChecklist = checklists[kind]
  const requiredReady = activeChecklist.filter((c) => c.required).every((c) => c.ok)

  const canSend = requiredReady && !!lastSavedJobId && selectedIds.length > 0 && !sending

  async function handleSend() {
    if (!lastSavedJobId || !panelResult) return
    setSending(true)
    try {
      const built = await buildShareBundle({
        kind,
        layers: shareLayers,
        designs,
        panelResult,
        panelConfig,
        panelInfo,
        outputFormat,
        routingResult,
        gcodeFiles,
        filmConfig,
      })
      if (!built.ok) {
        toast({ title: 'Could not build the bundle', description: built.error })
        return
      }
      if (built.warnings.length > 0) {
        console.warn('[Share]', built.warnings)
      }

      const formData = new FormData()
      formData.set('kind', kind)
      formData.set('camJobId', lastSavedJobId)
      formData.set('manifest', JSON.stringify(built.manifest))
      if (message.trim()) formData.set('message', message.trim())
      formData.set('recipients', JSON.stringify(selectedIds))
      formData.set('file', new File([built.blob], built.fileName))

      const res = await fetch('/api/share', { method: 'POST', body: formData })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        const retryAfter = res.headers.get('Retry-After')
        toast({
          title: res.status === 429 ? 'Too many shares sent' : 'Share failed',
          description: data.error ?? (retryAfter ? `Try again in ${retryAfter}s.` : 'Please try again.'),
        })
        return
      }

      const sentCount = (data.recipients ?? []).filter((r: { sent: boolean }) => r.sent).length
      const failedCount = (data.recipients ?? []).length - sentCount
      toast({
        title: 'Share sent',
        description: failedCount > 0 ? `${sentCount} sent, ${failedCount} failed to email (links still work).` : `Sent to ${sentCount} recipient${sentCount === 1 ? '' : 's'}.`,
      })
      setMessage('')
      setSelectedIds([])
      refreshHistory()
    } catch (err) {
      console.error('Share failed:', err)
      toast({ title: 'Share failed', description: err instanceof Error ? err.message : 'Please try again.' })
    } finally {
      setSending(false)
    }
  }

  async function handleResend(bundleId: string, recipientId: string) {
    setBusyRecipientId(recipientId)
    try {
      const res = await fetch(`/api/share/bundles/${bundleId}/recipients/${recipientId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resend: true }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast({ title: 'Resend failed', description: data.error ?? 'Please try again.' })
        return
      }
      toast({ title: 'Resent' })
      refreshHistory()
    } finally {
      setBusyRecipientId(null)
    }
  }

  async function handleRevokeToggle(bundleId: string, recipientId: string, revoked: boolean) {
    setBusyRecipientId(recipientId)
    try {
      const res = await fetch(`/api/share/bundles/${bundleId}/recipients/${recipientId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ revoked }),
      })
      if (!res.ok) {
        toast({ title: revoked ? 'Could not revoke' : 'Could not un-revoke' })
        return
      }
      refreshHistory()
    } finally {
      setBusyRecipientId(null)
    }
  }

  return (
    <div className="space-y-4">
      <Card className="border-[#1a3a5c] bg-[#0a1e38]/70">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold flex items-center gap-2 text-[#f0f8ff]">
            <Share2 className="w-4 h-4 text-[#0ea5e9]" />
            Sharing
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0 space-y-4">
          <p className="text-[10px] text-[#4a6f94]">
            Email a role-specific bundle (film, drill, or test files) straight from this job. The ZIP is built from
            what&apos;s currently loaded — save the job first so this send has a library record.
          </p>

          {!lastSavedJobId && (
            <div className="rounded-md p-2 border bg-yellow-950/40 border-yellow-800/40">
              <div className="flex items-start gap-1.5">
                <AlertTriangle className="w-3 h-3 mt-0.5 text-yellow-500 shrink-0" />
                <div className="text-[10px] text-yellow-300 leading-snug">
                  This job hasn&apos;t been saved this session. Save it on the Info & Export tab before sharing —
                  every share is linked to a saved job.
                  <Button
                    size="sm" variant="link"
                    className="h-auto p-0 pl-1 text-[10px] text-yellow-200 underline"
                    onClick={() => setActiveTab('export')}
                  >
                    Go to Info & Export
                  </Button>
                </div>
              </div>
            </div>
          )}

          {/* --------------------------------------------------- Kind picker */}
          <div>
            <Label className={fieldLabelCls}>Bundle type</Label>
            <div className="grid grid-cols-3 gap-1 mt-1">
              {(Object.keys(KIND_META) as ShareBundleKindLiteral[]).map((k) => (
                <Button
                  key={k}
                  size="sm"
                  variant={kind === k ? 'default' : 'outline'}
                  onClick={() => setKind(k)}
                  className={`h-7 px-2 text-xs leading-tight ${kind !== k ? 'border-[#1a3a5c] text-[#94b8d4] hover:text-white hover:bg-[#0f2848]' : 'bg-[#0ea5e9] text-white'}`}
                >
                  {KIND_META[k].label}
                </Button>
              ))}
            </div>
            <p className="text-[10px] text-[#4a6f94] mt-1.5">{KIND_META[kind].description}</p>
          </div>

          <Separator className="bg-[#1a3a5c]" />

          {/* ----------------------------------------------------- Readiness */}
          <div>
            <Label className={sectionLabelCls}>Readiness</Label>
            <div className="mt-2 space-y-1.5">
              {activeChecklist.map((item) => (
                <div key={item.label} className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5 text-xs">
                    {item.ok ? (
                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
                    ) : item.required ? (
                      <XCircle className="w-3.5 h-3.5 text-red-500 shrink-0" />
                    ) : (
                      <AlertTriangle className="w-3.5 h-3.5 text-yellow-500 shrink-0" />
                    )}
                    <span className={item.ok ? 'text-[#94b8d4]' : item.required ? 'text-red-300' : 'text-yellow-300'}>
                      {item.label}
                    </span>
                  </div>
                  {!item.ok && item.jumpTab && (
                    <Button
                      size="sm" variant="link"
                      className="h-auto p-0 text-[10px] text-[#0ea5e9]"
                      onClick={() => setActiveTab(item.jumpTab!)}
                    >
                      Fix
                    </Button>
                  )}
                </div>
              ))}
            </div>
          </div>

          <Separator className="bg-[#1a3a5c]" />

          {/* ---------------------------------------------------- Recipients */}
          <div>
            <Label className={sectionLabelCls}>
              <Users className="w-3 h-3" />
              Recipients
            </Label>
            {!contactsLoaded ? (
              <p className="text-[10px] text-[#4a6f94] mt-1.5">Loading contacts…</p>
            ) : contacts.length === 0 ? (
              <p className="text-[10px] text-[#4a6f94] mt-1.5">
                No saved contacts yet. Add film plotters, drill shops, or test houses from your Account page.
              </p>
            ) : (
              <div className="mt-2 max-h-40 overflow-y-auto space-y-1.5 bg-[#061628]/80 rounded-md p-2">
                {contacts.map((c) => (
                  <label key={c.id} className="flex items-center gap-2 text-xs text-[#94b8d4] cursor-pointer">
                    <Checkbox
                      checked={selectedIds.includes(c.id)}
                      onCheckedChange={(checked) =>
                        setSelectedIds((prev) => (checked ? [...prev, c.id] : prev.filter((id) => id !== c.id)))
                      }
                    />
                    <span className="truncate">
                      {c.name} <span className="text-[#4a6f94]">— {c.email}</span>
                      {c.role && <span className="text-[#4a6f94]"> ({c.role})</span>}
                    </span>
                    {c.scope === 'SHARED' && <Badge variant="secondary" className="text-[9px] py-0">Shared</Badge>}
                  </label>
                ))}
              </div>
            )}
          </div>

          {/* -------------------------------------------------------- Message */}
          <div>
            <Label className={fieldLabelCls}>Message (optional)</Label>
            <Textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Anything the recipient should know…"
              className="mt-1 text-xs bg-[#061628] border-[#1a3a5c] text-[#f0f8ff] min-h-16"
            />
          </div>

          <Button
            onClick={handleSend}
            disabled={!canSend}
            className="w-full bg-[#0ea5e9] hover:bg-[#0ea5e9]/80 text-white h-8 text-xs font-medium disabled:opacity-40"
          >
            <Send className="w-3 h-3 mr-1.5" />
            {sending ? 'Sending…' : `Send ${KIND_META[kind].label}`}
          </Button>
          {selectedIds.length === 0 && contactsLoaded && contacts.length > 0 && (
            <p className="text-[10px] text-[#4a6f94] text-center -mt-2">Select at least one recipient.</p>
          )}
        </CardContent>
      </Card>

      {/* --------------------------------------------------------- History */}
      <Card className="border-[#1a3a5c] bg-[#0a1e38]/70">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold flex items-center gap-2 text-[#f0f8ff]">
            <Clock className="w-4 h-4 text-[#0ea5e9]" />
            Share History (this job)
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0 space-y-3">
          {!lastSavedJobId ? (
            <p className="text-[10px] text-[#4a6f94]">Save the job to see its share history.</p>
          ) : !historyLoaded ? (
            <p className="text-[10px] text-[#4a6f94]">Loading…</p>
          ) : history.length === 0 ? (
            <p className="text-[10px] text-[#4a6f94]">No shares sent yet for this job.</p>
          ) : (
            history.map((bundle) => (
              <div key={bundle.id} className="rounded-md border border-[#1a3a5c] p-2 space-y-1.5">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5 text-xs text-[#f0f8ff] font-medium">
                    <Badge variant="secondary" className="text-[9px] py-0">{KIND_META[bundle.kind].label}</Badge>
                    {bundle.fileName}
                  </div>
                  <span className="text-[10px] text-[#4a6f94]">{formatBytes(bundle.fileSize)}</span>
                </div>
                <div className="text-[10px] text-[#4a6f94]">
                  Sent {new Date(bundle.createdAt).toLocaleDateString()} · expires{' '}
                  {new Date(bundle.expiresAt).toLocaleDateString()}
                </div>
                <div className="space-y-1">
                  {bundle.recipients.map((r) => (
                    <div key={r.id} className="flex items-center justify-between gap-2 text-[10px] bg-[#061628]/80 rounded p-1.5">
                      <div className="min-w-0">
                        <div className="text-[#94b8d4] truncate">{r.name ?? r.email} <span className="text-[#4a6f94]">— {r.email}</span></div>
                        <div className="text-[#4a6f94]">
                          {r.revokedAt ? (
                            <span className="text-red-400">Revoked</span>
                          ) : r.sendError ? (
                            <span className="text-red-400">Send failed: {r.sendError}</span>
                          ) : r.sentAt ? (
                            <span className="text-emerald-400">Sent{r.attached ? ' (attached)' : ''}</span>
                          ) : (
                            'Pending'
                          )}
                          {r.accessCount > 0 && ` · accessed ${r.accessCount}×`}
                        </div>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        <Button
                          size="sm" variant="ghost"
                          disabled={busyRecipientId === r.id || !!r.revokedAt}
                          onClick={() => handleResend(bundle.id, r.id)}
                          className="h-6 px-1.5 text-[#4a6f94] hover:text-white hover:bg-[#0f2848]"
                          title="Resend"
                        >
                          <RotateCcw className="w-3 h-3" />
                        </Button>
                        <Button
                          size="sm" variant="ghost"
                          disabled={busyRecipientId === r.id}
                          onClick={() => handleRevokeToggle(bundle.id, r.id, !r.revokedAt)}
                          className="h-6 px-1.5 text-[#4a6f94] hover:text-white hover:bg-[#0f2848]"
                          title={r.revokedAt ? 'Un-revoke' : 'Revoke'}
                        >
                          <Ban className="w-3 h-3" />
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  )
}

const fieldLabelCls = 'text-[10px] text-[#4a6f94]'
