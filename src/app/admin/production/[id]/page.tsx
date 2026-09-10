"use client"

import { useCallback, useEffect, useState } from "react"
import { useParams } from "next/navigation"
import Link from "next/link"
import { ArrowLeft, ChevronDown, ChevronUp, Loader2 } from "lucide-react"
import { StatusBadge } from "@/components/status-badge"
import { productionJobStatusMeta, friendlyStep } from "@/lib/production/steps"

interface Stage {
  id: string
  sequence: number
  attempt: number
  stageTypeKey: string
  label: string
  status: string
  operatorName: string | null
  qtyOut: number | null
  scrapQty: number | null
  startedAt: string | null
  completedAt: string | null
}

interface EventRow {
  id: string
  type: string
  createdAt: string
  payload: Record<string, unknown>
}

interface Job {
  id: string
  reference: string
  boardName: string | null
  customerName: string
  orderReference: string | null
  status: string
  priority: string
  quantity: number
  dueDate: string | null
  notes: string | null
  assignedToId: string | null
  assignedToName: string | null
  panelSummary: Record<string, number | string | null> | null
  panelImageUrl: string | null
  stages: Stage[]
  events: EventRow[]
}

interface OperatorOpt {
  id: string
  name: string
}

export default function AdminJobDetail() {
  const { id } = useParams<{ id: string }>()
  const [job, setJob] = useState<Job | null>(null)
  const [operators, setOperators] = useState<OperatorOpt[]>([])
  const [loading, setLoading] = useState(true)
  const [showLog, setShowLog] = useState(false)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/production/jobs/${id}`)
      if (res.ok) setJob((await res.json()).job)
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => {
    load()
    fetch("/api/production/operators")
      .then((r) => (r.ok ? r.json() : { operators: [] }))
      .then((d) => setOperators(d.operators || []))
      .catch(() => {})
    const t = setInterval(load, 10000)
    return () => clearInterval(t)
  }, [load])

  async function reassign(toId: string) {
    if (!toId || toId === job?.assignedToId) return
    setBusy(true)
    try {
      const res = await fetch(`/api/production/jobs/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assignedToId: toId }),
      })
      if (!res.ok) alert((await res.json().catch(() => ({}))).error || "Could not reassign.")
      await load()
    } finally {
      setBusy(false)
    }
  }

  if (loading) return <div className="py-16 text-center"><Loader2 className="mx-auto h-6 w-6 animate-spin text-primary" /></div>
  if (!job)
    return (
      <div className="py-16 text-center text-sm text-muted-foreground">
        Job not found. <Link href="/admin/production" className="text-primary underline">Back</Link>
      </div>
    )

  const stages = job.stages.filter((s) => s.attempt === 1)
  const done = stages.filter((s) => s.status === "DONE").length
  const total = stages.length
  const pct = total ? Math.round((done / total) * 100) : 0
  const meta = productionJobStatusMeta(job.status)
  const ps = job.panelSummary

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <Link href="/admin/production" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" /> All production
      </Link>

      <div>
        <div className="flex items-center gap-3">
          <span className="font-mono text-sm text-muted-foreground">{job.reference}</span>
          <StatusBadge label={meta.label} bg={meta.bg} text={meta.text} />
        </div>
        <h1 className="mt-1 text-2xl font-bold text-foreground">{job.boardName || "Panel job"}</h1>
        {job.orderReference && <p className="text-sm text-muted-foreground">Order {job.orderReference}</p>}

        <div className="mt-3 flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">Operator:</span>
          <select
            value={job.assignedToId || ""}
            onChange={(e) => reassign(e.target.value)}
            disabled={busy || job.status === "DONE" || job.status === "CANCELLED"}
            className="rounded-md border border-border bg-background px-2 py-1 text-sm font-medium text-foreground disabled:opacity-60"
          >
            <option value="" disabled>
              {job.assignedToName || "— unassigned —"}
            </option>
            {operators.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
        </div>

        <div className="mt-4">
          <div className="flex items-center justify-between text-sm font-semibold">
            <span className="text-foreground">{done} of {total} done</span>
            <span className="text-emerald-500">{done === total ? "Finished" : `${total - done} left`}</span>
          </div>
          <div className="mt-2 h-2.5 w-full overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
          </div>
        </div>
      </div>

      {job.panelImageUrl && (
        <a href={job.panelImageUrl} target="_blank" rel="noreferrer" className="block overflow-hidden rounded-lg border border-border bg-[#020d1f]">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={job.panelImageUrl} alt="Panel" className="h-64 w-full object-contain" />
        </a>
      )}

      {ps && (
        <div className="grid grid-cols-2 gap-3 rounded-lg border border-border bg-card p-5 text-sm sm:grid-cols-3">
          <Cell label="Panel size" value={`${fmt(ps.panelWidthMm)} × ${fmt(ps.panelHeightMm)} ${ps.unit}`} />
          <Cell label="PCB size" value={`${fmt(ps.pcbWidthMm)} × ${fmt(ps.pcbHeightMm)} ${ps.unit}`} />
          <Cell label="Total PCBs" value={String(ps.totalPcbs)} />
          <Cell label="Layout" value={ps.rows != null ? `${ps.rows} × ${ps.cols}` : "—"} />
          <Cell label="Tooling / ref holes" value={`${ps.toolingHoles} / ${ps.referenceHoles}`} />
          <Cell label="Fiducials" value={String(ps.fiducials)} />
        </div>
      )}

      {job.notes && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-sm">
          <p className="text-xs font-semibold uppercase text-amber-600 dark:text-amber-400">Notes for the operator</p>
          <p className="mt-1 whitespace-pre-wrap text-foreground">{job.notes}</p>
        </div>
      )}

      <div className="rounded-lg border border-border bg-card">
        <div className="border-b border-border px-4 py-2.5 text-sm font-semibold text-foreground">Steps</div>
        <div className="divide-y divide-border">
          {stages.map((s) => {
            const f = friendlyStep(s.stageTypeKey, s.label)
            return (
            <div key={s.id} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
              <div className="flex items-center gap-3">
                <span className="w-6 text-right text-xs text-muted-foreground">{s.sequence}</span>
                <span className={s.status === "DONE" ? "text-muted-foreground" : "font-medium text-foreground"}>
                  {f.emoji} {f.short}
                </span>
              </div>
              <div className="flex items-center gap-3 text-xs text-muted-foreground">
                {s.status === "DONE" && s.scrapQty ? <span className="text-rose-500">{s.scrapQty} scrap</span> : null}
                {s.operatorName && <span>{s.operatorName}</span>}
                {s.completedAt && (
                  <span>{new Date(s.completedAt).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" })}</span>
                )}
                <StatusBadge {...stageBadge(s.status)} />
              </div>
            </div>
            )
          })}
        </div>
      </div>

      <div className="rounded-lg border border-border bg-card">
        <button
          type="button"
          onClick={() => setShowLog(!showLog)}
          className="flex w-full items-center justify-between px-4 py-2.5 text-sm font-semibold text-foreground"
        >
          <span>Activity ({job.events.length})</span>
          {showLog ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
        </button>
        {showLog && (
          <div className="divide-y divide-border px-4 pb-2 text-xs">
            {job.events.map((e) => (
              <div key={e.id} className="flex items-start justify-between gap-4 py-2">
                <span className="font-mono font-semibold text-primary">{e.type}</span>
                <span className="text-muted-foreground">
                  {new Date(e.createdAt).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" })}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function fmt(n: unknown): string {
  return typeof n === "number" ? n.toFixed(1) : "?"
}

function Cell({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span className="text-muted-foreground">{label}</span>
      <div className="font-medium text-foreground">{value}</div>
    </div>
  )
}

function stageBadge(status: string): { label: string; bg: string; text: string } {
  switch (status) {
    case "DONE":
      return { label: "Done", bg: "rgba(34,197,94,0.15)", text: "#4ade80" }
    case "IN_PROGRESS":
      return { label: "Working", bg: "rgba(139,92,246,0.15)", text: "#a78bfa" }
    case "READY":
      return { label: "Ready", bg: "rgba(59,130,246,0.15)", text: "#60a5fa" }
    case "CANCELLED":
      return { label: "Cancelled", bg: "rgba(239,68,68,0.15)", text: "#f87171" }
    default:
      return { label: "Waiting", bg: "rgba(148,163,184,0.15)", text: "#94a3b8" }
  }
}
