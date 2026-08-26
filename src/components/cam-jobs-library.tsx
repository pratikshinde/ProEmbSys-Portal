"use client"

import { useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { StatusBadge } from "@/components/status-badge"
import { toast } from "@/hooks/use-toast"
import { CAM_JOB_STATUS_META, type CamJobStatusKey } from "@/lib/cam-job-status"
import { CAM_JOB_HEALTH_META, type CamJobHealthLevel } from "@/lib/cam-job-health"

/** Client-safe projection of CamJobSummary — same fields, Dates as ISO
 *  strings (see cam-jobs/page.tsx's own comment on why). */
export interface CamJobLibraryRow {
  id: string
  name: string
  revision: string
  status: string
  orderId: string | null
  camMode: "single" | "multi"
  designCount: number
  layerCount: number
  health: { level: CamJobHealthLevel; label: string; reasons: string[] }
  createdAt: string
  updatedAt: string
}

interface Filters {
  status: string
  health: string
  q: string
}

const STATUS_FILTERS: { key: string; label: string }[] = [
  { key: "", label: "All" },
  ...Object.entries(CAM_JOB_STATUS_META).map(([key, meta]) => ({ key, label: meta.label })),
]

const HEALTH_FILTERS: { key: string; label: string }[] = [
  { key: "", label: "All" },
  ...Object.entries(CAM_JOB_HEALTH_META).map(([key, meta]) => ({ key, label: meta.label })),
]

function buildHref(filters: Filters, overrides: Partial<Filters>): string {
  const merged = { ...filters, ...overrides }
  const params = new URLSearchParams()
  if (merged.status) params.set("status", merged.status)
  if (merged.health) params.set("health", merged.health)
  if (merged.q) params.set("q", merged.q)
  const qs = params.toString()
  return qs ? `/cam-jobs?${qs}` : "/cam-jobs"
}

export default function CamJobsLibrary({
  initialJobs,
  initialTotal,
  initialFilters,
  pageSize,
}: {
  initialJobs: CamJobLibraryRow[]
  initialTotal: number
  initialFilters: Filters
  pageSize: number
}) {
  const router = useRouter()
  const [jobs, setJobs] = useState(initialJobs)
  const [total, setTotal] = useState(initialTotal)
  const [deleting, setDeleting] = useState<CamJobLibraryRow | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [searchInput, setSearchInput] = useState(initialFilters.q)

  async function handleDelete(job: CamJobLibraryRow) {
    const res = await fetch(`/api/cam-jobs/${job.id}`, { method: "DELETE" })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      toast({ title: "Could not delete", description: err.error ?? "Please try again." })
      return
    }
    setJobs((prev) => prev.filter((j) => j.id !== job.id))
    setTotal((t) => t - 1)
    toast({ title: "Job deleted", description: job.name })
  }

  async function handleLoadMore() {
    setLoadingMore(true)
    try {
      const params = new URLSearchParams()
      if (initialFilters.status) params.set("status", initialFilters.status)
      if (initialFilters.health) params.set("health", initialFilters.health)
      if (initialFilters.q) params.set("q", initialFilters.q)
      params.set("skip", String(jobs.length))
      params.set("take", String(pageSize))
      const res = await fetch(`/api/cam-jobs?${params.toString()}`)
      if (!res.ok) return
      const data: { jobs: CamJobLibraryRow[]; total: number } = await res.json()
      setJobs((prev) => [...prev, ...data.jobs])
      setTotal(data.total)
    } finally {
      setLoadingMore(false)
    }
  }

  function handleSearchSubmit(e: React.FormEvent) {
    e.preventDefault()
    router.push(buildHref(initialFilters, { q: searchInput.trim() }))
  }

  const hasActiveFilters = !!(initialFilters.status || initialFilters.health || initialFilters.q)

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <form onSubmit={handleSearchSubmit} className="flex gap-2">
          <Input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search job name…"
            className="h-9 w-56"
          />
          <Button type="submit" variant="outline" size="sm">Search</Button>
        </form>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex flex-wrap gap-1.5">
          <span className="text-xs text-muted-foreground mr-1 self-center">Status:</span>
          {STATUS_FILTERS.map((f) => {
            const isActive = initialFilters.status === f.key
            return (
              <Link
                key={f.key || "ALL"}
                href={buildHref(initialFilters, { status: f.key })}
                className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                  isActive
                    ? "border-primary bg-primary/15 text-primary"
                    : "border-border text-muted-foreground hover:border-primary/50 hover:text-foreground"
                }`}
              >
                {f.label}
              </Link>
            )
          })}
        </div>
        <div className="flex flex-wrap gap-1.5">
          <span className="text-xs text-muted-foreground mr-1 self-center">Health:</span>
          {HEALTH_FILTERS.map((f) => {
            const isActive = initialFilters.health === f.key
            return (
              <Link
                key={f.key || "ALL"}
                href={buildHref(initialFilters, { health: f.key })}
                className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                  isActive
                    ? "border-primary bg-primary/15 text-primary"
                    : "border-border text-muted-foreground hover:border-primary/50 hover:text-foreground"
                }`}
              >
                {f.label}
              </Link>
            )
          })}
        </div>
      </div>

      {jobs.length === 0 ? (
        <div className="flex flex-col items-start gap-4 rounded-lg border border-border bg-card p-8">
          <p className="text-muted-foreground">
            {hasActiveFilters ? "No jobs match these filters." : "You haven't saved any CAM jobs yet."}
          </p>
          {!hasActiveFilters && (
            <Link
              href="/panelization"
              className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90"
            >
              Open the Panelization tool →
            </Link>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {jobs.map((job) => {
            const statusMeta = CAM_JOB_STATUS_META[job.status as CamJobStatusKey] ?? { label: job.status, bg: "rgba(148,163,184,0.15)", text: "#94a3b8" }
            return (
              <div
                key={job.id}
                className="flex items-center justify-between gap-3 rounded-lg border border-border bg-card p-4 transition-colors hover:border-primary"
              >
                <Link href={`/panelization?load=${job.id}`} className="block flex-1 min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold text-foreground">
                      {job.name}
                      {job.revision && <span className="font-normal text-muted-foreground"> · Rev {job.revision}</span>}
                    </span>
                    <StatusBadge label={statusMeta.label} bg={statusMeta.bg} text={statusMeta.text} />
                    <span title={job.health.reasons.join(" ")}>
                      <StatusBadge label={job.health.label} bg={CAM_JOB_HEALTH_META[job.health.level].bg} text={CAM_JOB_HEALTH_META[job.health.level].text} />
                    </span>
                    {job.orderId && (
                      <a
                        href={`/orders/${job.orderId}`}
                        onClick={(e) => e.stopPropagation()}
                        className="rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground hover:border-primary hover:text-primary"
                      >
                        Linked order →
                      </a>
                    )}
                  </div>
                  <div className="text-sm text-muted-foreground">
                    {job.camMode === "multi" ? "Multi-Design" : "Single Design"} · {job.designCount} design
                    {job.designCount === 1 ? "" : "s"} · {job.layerCount} layer{job.layerCount === 1 ? "" : "s"}
                  </div>
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    Saved on{" "}
                    {new Date(job.updatedAt).toLocaleDateString("en-IN", { dateStyle: "medium", timeZone: "Asia/Kolkata" })}
                  </div>
                </Link>
                <Button variant="ghost" size="sm" onClick={() => setDeleting(job)}>
                  Delete
                </Button>
              </div>
            )
          })}

          {jobs.length < total && (
            <Button variant="outline" onClick={handleLoadMore} disabled={loadingMore} className="self-center">
              {loadingMore ? "Loading…" : `Load more (${total - jobs.length} remaining)`}
            </Button>
          )}
        </div>
      )}

      <AlertDialog open={!!deleting} onOpenChange={(open) => !open && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete &ldquo;{deleting?.name}&rdquo;?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the saved job and its uploaded files. This can&apos;t be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (deleting) handleDelete(deleting)
                setDeleting(null)
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
