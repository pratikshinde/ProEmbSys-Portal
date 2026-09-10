"use client"

import { useCallback, useEffect, useState } from "react"
import { useParams } from "next/navigation"
import Link from "next/link"
import { v4 as uuidv4 } from "uuid"
import { ArrowLeft, Check, CircleCheck, Loader2, PartyPopper, PauseCircle, X } from "lucide-react"

interface Step {
  id: string
  sequence: number
  status: "BLOCKED" | "READY" | "IN_PROGRESS" | "DONE" | "REWORK" | "SKIPPED" | "CANCELLED"
  short: string
  emoji: string
  instruction: string | null
  completedAt: string | null
}

interface PanelSummary {
  pcbWidthMm: number | null
  pcbHeightMm: number | null
  panelWidthMm: number | null
  panelHeightMm: number | null
  totalPcbs: number
  rows: number | null
  cols: number | null
  toolingHoles: number
  referenceHoles: number
  fiducials: number
  unit: string
}

interface Job {
  id: string
  reference: string
  boardName: string
  quantity: number
  onHold: boolean
  cancelled: boolean
  notes: string | null
  done: number
  total: number
  remaining: number
  allDone: boolean
  panelSummary: PanelSummary | null
  panelImageUrl: string | null
  current: {
    id: string
    status: "READY" | "IN_PROGRESS"
    short: string
    emoji: string
    instruction: string | null
  } | null
  steps: Step[]
}

export default function OperatorJobPage() {
  const params = useParams()
  const jobId = params.jobId as string

  const [job, setJob] = useState<Job | null>(null)
  const [loading, setLoading] = useState(true)
  const [gone, setGone] = useState(false)

  const [sheetOpen, setSheetOpen] = useState(false)
  const [imageOpen, setImageOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [showExtras, setShowExtras] = useState(false)
  const [scrap, setScrap] = useState("")
  const [note, setNote] = useState("")

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/production/my-work/${jobId}`)
      if (res.status === 404) {
        setGone(true)
        return
      }
      if (res.ok) setJob((await res.json()).job)
    } catch {
      /* keep last */
    } finally {
      setLoading(false)
    }
  }, [jobId])

  useEffect(() => {
    load()
    const t = setInterval(load, 15000)
    return () => clearInterval(t)
  }, [load])

  async function finishCurrentStep() {
    if (!job?.current) return
    setBusy(true)
    setErr(null)
    const stageId = job.current.id
    const actionId = uuidv4()
    try {
      if (job.current.status === "READY") {
        const s = await fetch(`/api/production/stages/${stageId}/start`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ actionId: `${actionId}-start` }),
        })
        if (!s.ok) {
          setErr((await s.json().catch(() => ({}))).error || "Could not start this step.")
          setBusy(false)
          return
        }
      }
      const body: Record<string, unknown> = { actionId }
      if (scrap.trim()) {
        const n = parseInt(scrap, 10)
        if (!Number.isNaN(n) && n > 0) body.qtyOut = Math.max(0, job.quantity - n)
      }
      if (note.trim()) body.note = note.trim()

      const c = await fetch(`/api/production/stages/${stageId}/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      if (!c.ok) {
        setErr((await c.json().catch(() => ({}))).error || "Could not save. Try again.")
        setBusy(false)
        return
      }
      setSheetOpen(false)
      setScrap("")
      setNote("")
      setShowExtras(false)
      await load()
    } catch {
      setErr("Network problem — try again.")
    } finally {
      setBusy(false)
    }
  }

  async function undoStep(stageId: string) {
    setBusy(true)
    try {
      const res = await fetch(`/api/production/stages/${stageId}/reopen`, { method: "POST" })
      if (!res.ok) alert((await res.json().catch(() => ({}))).error || "Could not undo.")
      await load()
    } finally {
      setBusy(false)
    }
  }

  if (loading) return <div className="py-16 text-center text-slate-400">Loading…</div>
  if (gone || !job)
    return (
      <div className="space-y-3 py-16 text-center">
        <p className="text-lg text-white">This job isn&apos;t available.</p>
        <Link href="/production" className="text-emerald-400 underline">
          Back to My Work
        </Link>
      </div>
    )

  const pct = job.total ? Math.round((job.done / job.total) * 100) : 0
  const lastDone = [...job.steps].reverse().find((s) => s.status === "DONE")
  const ps = job.panelSummary

  return (
    <div className="space-y-5 pb-8">
      <Link href="/production" className="inline-flex items-center gap-1.5 text-sm text-slate-400">
        <ArrowLeft className="h-4 w-4" /> My Work
      </Link>

      <div>
        <h1 className="text-2xl font-bold leading-tight text-white">{job.boardName}</h1>
        <p className="mt-1 font-mono text-xs text-slate-500">{job.reference}</p>
        <div className="mt-4 flex items-center justify-between text-base font-bold">
          <span className="text-white">
            {job.done} of {job.total} done
          </span>
          <span className="text-emerald-400">{job.allDone ? "Finished 🎉" : `${job.remaining} left`}</span>
        </div>
        <div className="mt-2 h-3.5 w-full overflow-hidden rounded-full bg-white/10">
          <div className="h-full rounded-full bg-emerald-500 transition-all" style={{ width: `${pct}%` }} />
        </div>
      </div>

      {job.allDone && (
        <div className="rounded-2xl border border-emerald-500/30 bg-emerald-500/10 p-5 text-center">
          <PartyPopper className="mx-auto h-8 w-8 text-emerald-400" />
          <p className="mt-2 text-lg font-bold text-white">All done!</p>
          <p className="text-sm text-emerald-300">Every step on this job is finished.</p>
        </div>
      )}

      {job.onHold && !job.allDone && (
        <div className="flex items-center gap-2 rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4 text-amber-300">
          <PauseCircle className="h-5 w-5" />
          <span className="font-semibold">This job is paused by the office. Please wait.</span>
        </div>
      )}

      {/* Panel image */}
      {job.panelImageUrl && (
        <button
          type="button"
          onClick={() => setImageOpen(true)}
          className="block w-full overflow-hidden rounded-2xl border border-white/10 bg-white"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={job.panelImageUrl} alt="Panel to build" className="h-64 w-full object-contain" />
        </button>
      )}

      {/* Panel summary */}
      {ps && (
        <div className="rounded-2xl border border-white/10 bg-white/5 p-5">
          <h2 className="text-sm font-bold uppercase tracking-wide text-slate-400">Panel to build</h2>
          <div className="mt-3 grid grid-cols-2 gap-4">
            <div>
              <p className="text-xs text-slate-500">Panel size</p>
              <p className="text-2xl font-bold text-white">
                {fmt(ps.panelWidthMm)} × {fmt(ps.panelHeightMm)} <span className="text-base font-semibold">{ps.unit}</span>
              </p>
            </div>
            <div>
              <p className="text-xs text-slate-500">Boards on panel</p>
              <p className="text-2xl font-bold text-white">{ps.totalPcbs}</p>
            </div>
          </div>
          <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 border-t border-white/10 pt-4 text-sm">
            <Row label="One board" value={`${fmt(ps.pcbWidthMm)} × ${fmt(ps.pcbHeightMm)} ${ps.unit}`} />
            {ps.rows != null && ps.cols != null && <Row label="Layout" value={`${ps.rows} × ${ps.cols}`} />}
            <Row label="Tooling holes" value={String(ps.toolingHoles)} />
            <Row label="Reference holes" value={String(ps.referenceHoles)} />
            <Row label="Fiducials" value={String(ps.fiducials)} />
          </div>
        </div>
      )}

      {job.notes && (
        <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4">
          <p className="text-xs font-bold uppercase tracking-wide text-amber-400">Notes from the office</p>
          <p className="mt-1.5 whitespace-pre-wrap text-sm text-amber-100">{job.notes}</p>
        </div>
      )}

      {/* Steps */}
      <div className="space-y-2.5">
        <h2 className="text-sm font-bold uppercase tracking-wide text-slate-400">Steps</h2>
        {job.steps.map((step) => {
          const isDone = step.status === "DONE"
          const isCurrent = job.current?.id === step.id
          const isLater = !isDone && !isCurrent
          const canUndo = isDone && lastDone?.id === step.id && !job.cancelled

          return (
            <div
              key={step.id}
              className={`rounded-2xl border p-4 ${
                isCurrent
                  ? "border-emerald-500/50 bg-emerald-500/10"
                  : isDone
                  ? "border-white/10 bg-white/5"
                  : "border-white/5 bg-white/[0.02]"
              }`}
            >
              <div className="flex items-center gap-3">
                <span
                  className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-lg ${
                    isDone
                      ? "bg-emerald-500 text-slate-950"
                      : isCurrent
                      ? "bg-emerald-500/20 text-emerald-300 ring-2 ring-emerald-500/40"
                      : "bg-white/10 text-slate-500"
                  }`}
                >
                  {isDone ? <Check className="h-5 w-5" /> : step.emoji}
                </span>
                <div className="min-w-0 flex-1">
                  <p className={`text-base font-bold ${isLater ? "text-slate-500" : "text-white"}`}>{step.short}</p>
                  {isDone && step.completedAt && (
                    <p className="text-xs text-slate-500">
                      done{" "}
                      {new Date(step.completedAt).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}
                    </p>
                  )}
                  {isCurrent && job.current?.instruction && (
                    <p className="text-sm text-emerald-200/80">{job.current.instruction}</p>
                  )}
                </div>
                {canUndo && (
                  <button
                    type="button"
                    onClick={() => undoStep(step.id)}
                    disabled={busy}
                    className="text-xs font-semibold text-slate-400 underline"
                  >
                    Undo
                  </button>
                )}
              </div>

              {isCurrent && !job.onHold && (
                <button
                  type="button"
                  onClick={() => {
                    setErr(null)
                    setSheetOpen(true)
                  }}
                  className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl bg-emerald-500 px-4 py-4 text-lg font-bold text-slate-950 active:bg-emerald-400"
                >
                  <CircleCheck className="h-6 w-6" />I finished this step
                </button>
              )}
            </div>
          )
        })}
      </div>

      {/* Fullscreen panel image */}
      {imageOpen && job.panelImageUrl && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 p-3"
          onClick={() => setImageOpen(false)}
        >
          <button type="button" className="absolute right-4 top-4 rounded-full bg-white/10 p-2 text-white">
            <X className="h-6 w-6" />
          </button>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={job.panelImageUrl} alt="Panel to build" className="max-h-full max-w-full rounded-lg bg-white" />
        </div>
      )}

      {/* Confirm sheet */}
      {sheetOpen && job.current && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/70">
          <div className="w-full max-w-lg space-y-4 rounded-t-3xl border-t border-white/10 bg-[#0a1f38] p-6">
            <p className="text-xl font-bold text-white">
              Finished {job.current.emoji} {job.current.short}?
            </p>

            {err && (
              <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-300">{err}</div>
            )}

            {!showExtras ? (
              <button type="button" onClick={() => setShowExtras(true)} className="text-sm text-slate-400 underline">
                Add a note or report scrapped boards
              </button>
            ) : (
              <div className="space-y-3">
                <div>
                  <label className="text-sm font-semibold text-slate-300">Boards scrapped (if any)</label>
                  <input
                    type="number"
                    inputMode="numeric"
                    min={0}
                    value={scrap}
                    onChange={(e) => setScrap(e.target.value)}
                    placeholder="0"
                    className="mt-1 w-full rounded-xl border border-white/10 bg-black/30 p-3 text-base text-white"
                  />
                </div>
                <div>
                  <label className="text-sm font-semibold text-slate-300">Note (optional)</label>
                  <input
                    type="text"
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    className="mt-1 w-full rounded-xl border border-white/10 bg-black/30 p-3 text-base text-white"
                  />
                </div>
              </div>
            )}

            <div className="flex gap-3 pt-1">
              <button
                type="button"
                onClick={() => setSheetOpen(false)}
                disabled={busy}
                className="flex-1 rounded-xl border border-white/10 py-4 text-base font-semibold text-slate-300"
              >
                Not yet
              </button>
              <button
                type="button"
                onClick={finishCurrentStep}
                disabled={busy}
                className="flex flex-[2] items-center justify-center gap-2 rounded-xl bg-emerald-500 py-4 text-lg font-bold text-slate-950 active:bg-emerald-400 disabled:opacity-60"
              >
                {busy ? <Loader2 className="h-5 w-5 animate-spin" /> : <Check className="h-5 w-5" />}
                Yes, done
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function fmt(n: number | null): string {
  return n == null ? "?" : n.toFixed(1)
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-slate-500">{label}</p>
      <p className="font-semibold text-white">{value}</p>
    </div>
  )
}
