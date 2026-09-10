"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { RefreshCw, ChevronRight, PartyPopper, PauseCircle } from "lucide-react"

interface Job {
  id: string
  reference: string
  boardName: string
  quantity: number
  priority: "LOW" | "NORMAL" | "HIGH" | "RUSH"
  dueDate: string | null
  onHold: boolean
  done: number
  total: number
  remaining: number
  allDone: boolean
  current: { short: string; emoji: string } | null
  specs: { widthMm: number; heightMm: number } | null
}

export default function MyWorkPage() {
  const [jobs, setJobs] = useState<Job[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)

  async function load(showSpinner = false) {
    if (showSpinner) setRefreshing(true)
    try {
      const res = await fetch("/api/production/my-work")
      if (res.ok) setJobs((await res.json()).jobs || [])
    } catch {
      /* keep last data */
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }

  useEffect(() => {
    load()
    const t = setInterval(() => load(), 15000)
    return () => clearInterval(t)
  }, [])

  if (loading) {
    return <div className="py-16 text-center text-base text-slate-400">Loading your work…</div>
  }

  if (jobs.length === 0) {
    return (
      <div className="space-y-3 py-16 text-center">
        <div className="text-5xl">👍</div>
        <p className="text-lg font-semibold text-white">No work assigned right now</p>
        <p className="text-sm text-slate-400">New jobs will show up here automatically.</p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold text-white">My Work</h2>
        <button
          type="button"
          onClick={() => load(true)}
          className="flex h-11 w-11 items-center justify-center rounded-xl border border-white/10 bg-white/5 text-slate-300"
          aria-label="Refresh"
        >
          <RefreshCw className={`h-5 w-5 ${refreshing ? "animate-spin" : ""}`} />
        </button>
      </div>

      {jobs.map((job) => {
        const pct = job.total ? Math.round((job.done / job.total) * 100) : 0
        return (
          <Link
            key={job.id}
            href={`/production/${job.id}`}
            className="block rounded-2xl border border-white/10 bg-white/5 p-5 transition active:bg-white/10"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h3 className="text-xl font-bold leading-snug text-white">{job.boardName}</h3>
                <p className="mt-0.5 font-mono text-xs text-slate-500">{job.reference}</p>
              </div>
              {job.priority === "RUSH" || job.priority === "HIGH" ? (
                <span className="shrink-0 rounded-full bg-amber-500/15 px-2.5 py-1 text-xs font-bold text-amber-300">
                  {job.priority === "RUSH" ? "Rush" : "Urgent"}
                </span>
              ) : null}
            </div>

            <p className="mt-2 text-sm text-slate-400">
              {job.quantity} boards
              {job.specs ? ` · ${job.specs.widthMm} × ${job.specs.heightMm} mm` : ""}
            </p>

            <div className="mt-4">
              <div className="flex items-center justify-between text-sm font-semibold">
                <span className="text-white">
                  {job.done} of {job.total} done
                </span>
                <span className="text-emerald-400">{job.allDone ? "Finished" : `${job.remaining} left`}</span>
              </div>
              <div className="mt-2 h-3 w-full overflow-hidden rounded-full bg-white/10">
                <div className="h-full rounded-full bg-emerald-500 transition-all" style={{ width: `${pct}%` }} />
              </div>
            </div>

            <div className="mt-4 flex items-center justify-between">
              {job.allDone ? (
                <span className="flex items-center gap-2 text-base font-bold text-emerald-400">
                  <PartyPopper className="h-5 w-5" /> All done
                </span>
              ) : job.onHold ? (
                <span className="flex items-center gap-2 text-base font-semibold text-amber-400">
                  <PauseCircle className="h-5 w-5" /> On hold
                </span>
              ) : (
                <span className="text-lg font-bold text-white">
                  Next: {job.current?.emoji} {job.current?.short}
                </span>
              )}
              <ChevronRight className="h-6 w-6 shrink-0 text-slate-500" />
            </div>
          </Link>
        )
      })}
    </div>
  )
}
