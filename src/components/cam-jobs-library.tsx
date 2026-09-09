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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { StatusBadge } from "@/components/status-badge"
import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react"
import { toast } from "@/hooks/use-toast"
import { CAM_JOB_STATUS_META, camJobStatusMeta } from "@/lib/cam-job-status"
import { CAM_JOB_HEALTH_META, type CamJobHealthLevel } from "@/lib/cam-job-health"
import {
  type CamJobFilters,
  type CamJobSortKey,
  camJobFiltersToParams,
  buildCamJobsHref,
  CAM_JOB_SORT_NATURAL_DIR,
} from "@/lib/cam-job-filters"

/** Client-safe projection of CamJobSummary — same fields, Dates as ISO
 *  strings (see cam-jobs/page.tsx's own comment on why). */
export interface CamJobLibraryRow {
  id: string
  name: string
  revision: string
  customerRef: string
  status: string
  orderId: string | null
  camMode: "single" | "multi"
  designCount: number
  layerCount: number
  health: { level: CamJobHealthLevel; label: string; reasons: string[] }
  panelWidthMm: number | null
  panelHeightMm: number | null
  pcbWidthMm: number | null
  pcbHeightMm: number | null
  createdAt: string
  updatedAt: string
}

/** "110×160mm", or null if either dimension is missing (never panelized as
 *  of the last save). One decimal place — these are millimeters, not the
 *  4-6 digit Gerber coordinate precision. */
function formatDimensions(widthMm: number | null, heightMm: number | null): string | null {
  if (widthMm == null || heightMm == null) return null
  return `${widthMm.toFixed(1)}×${heightMm.toFixed(1)}mm`
}

const STATUS_FILTERS: { key: string; label: string }[] = [
  { key: "", label: "All" },
  ...Object.entries(CAM_JOB_STATUS_META).map(([key, meta]) => ({ key, label: meta.label })),
]

const HEALTH_FILTERS: { key: string; label: string }[] = [
  { key: "", label: "All" },
  ...Object.entries(CAM_JOB_HEALTH_META).map(([key, meta]) => ({ key, label: meta.label })),
]

const DATE_RANGE_FILTERS: { key: string; label: string }[] = [
  { key: "", label: "All time" },
  { key: "7d", label: "Last 7 days" },
  { key: "30d", label: "Last 30 days" },
  { key: "90d", label: "Last 90 days" },
]

const SORT_COLUMNS: { key: CamJobSortKey; label: string }[] = [
  { key: "name", label: "Job" },
  { key: "customer", label: "Customer" },
  { key: "status", label: "Status" },
  { key: "health", label: "Health" },
  { key: "updatedAt", label: "Saved" },
]

// Select (Radix) reserves value="" for its own "clear" semantics, so "Any
// customer" needs a real, non-empty sentinel value mapped back to "" here.
const ANY_CUSTOMER = "__any__"

function pillClassName(isActive: boolean): string {
  return `rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
    isActive
      ? "border-primary bg-primary/15 text-primary"
      : "border-border text-muted-foreground hover:border-primary/50 hover:text-foreground"
  }`
}

/** One sortable <th>, matching the house table classes exactly — see
 *  admin/cam-jobs/page.tsx's <th> for the pattern being extended here with
 *  click-to-sort (a genuinely new pattern; no other table in this app has
 *  one). First click on a column uses that column's NATURAL direction
 *  (text A-Z, dates newest-first, status pipeline-order, health worst-
 *  first) rather than always starting ascending. */
function SortableTh({ label, sortKey, filters }: { label: string; sortKey: CamJobSortKey; filters: CamJobFilters }) {
  const active = filters.sort === sortKey
  const nextDir = active ? (filters.dir === "asc" ? "desc" : "asc") : CAM_JOB_SORT_NATURAL_DIR[sortKey]
  return (
    <th
      className="px-4 py-3 text-left font-medium text-muted-foreground"
      aria-sort={active ? (filters.dir === "asc" ? "ascending" : "descending") : "none"}
    >
      <Link
        href={buildCamJobsHref(filters, { sort: sortKey, dir: nextDir })}
        scroll={false}
        className="inline-flex items-center gap-1 hover:text-foreground"
      >
        {label}
        {active ? (
          filters.dir === "asc" ? (
            <ArrowUp className="h-3.5 w-3.5" />
          ) : (
            <ArrowDown className="h-3.5 w-3.5" />
          )
        ) : (
          <ChevronsUpDown className="h-3.5 w-3.5 opacity-40" />
        )}
      </Link>
    </th>
  )
}

export default function CamJobsLibrary({
  initialJobs,
  initialTotal,
  initialFilters,
  customerOptions,
  pageSize,
}: {
  initialJobs: CamJobLibraryRow[]
  initialTotal: number
  initialFilters: CamJobFilters
  customerOptions: { value: string; count: number }[]
  pageSize: number
}) {
  const router = useRouter()
  const [jobs, setJobs] = useState(initialJobs)
  const [total, setTotal] = useState(initialTotal)
  const [deleting, setDeleting] = useState<CamJobLibraryRow | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [searchInput, setSearchInput] = useState(initialFilters.q)
  const [fromInput, setFromInput] = useState(initialFilters.from)
  const [toInput, setToInput] = useState(initialFilters.to)

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
      // camJobFiltersToParams — the SAME serializer the server page and the
      // pills below use — so "Load more" can never silently fetch from a
      // different filtered result set than the one currently rendered.
      const params = camJobFiltersToParams(initialFilters)
      params.set("skip", String(jobs.length))
      params.set("take", String(pageSize))
      const res = await fetch(`/api/cam-jobs?${params.toString()}`)
      if (!res.ok) {
        toast({ title: "Could not load more jobs", description: "Please try again." })
        return
      }
      const data: { jobs: CamJobLibraryRow[]; total: number } = await res.json()
      setJobs((prev) => [...prev, ...data.jobs])
      setTotal(data.total)
    } finally {
      setLoadingMore(false)
    }
  }

  function handleSearchSubmit(e: React.FormEvent) {
    e.preventDefault()
    router.push(buildCamJobsHref(initialFilters, { q: searchInput.trim() }))
  }

  function handleCustomerChange(value: string) {
    router.push(buildCamJobsHref(initialFilters, { customer: value === ANY_CUSTOMER ? "" : value }))
  }

  function handleApplyDateRange() {
    // Setting from/to alongside an explicit range:"" so a previously-active
    // preset is cleared, not left to silently win over the custom range
    // (camJobFiltersToParams prefers `range` when both are set).
    router.push(buildCamJobsHref(initialFilters, { range: "", from: fromInput, to: toInput }))
  }

  const hasActiveFilters = !!(
    initialFilters.status ||
    initialFilters.health ||
    initialFilters.q ||
    initialFilters.customer ||
    initialFilters.range ||
    initialFilters.from ||
    initialFilters.to
  )

  // customerOptions is unfiltered (see listCamJobCustomers), but the
  // CURRENTLY selected customer might not be in it (its last matching job
  // was just deleted/renamed) — append a synthetic entry so the Select
  // still shows the active selection instead of silently going blank while
  // the filter stays applied.
  const customerSelectOptions =
    initialFilters.customer && !customerOptions.some((c) => c.value === initialFilters.customer)
      ? [...customerOptions, { value: initialFilters.customer, count: 0 }]
      : customerOptions

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

        <Select value={initialFilters.customer || ANY_CUSTOMER} onValueChange={handleCustomerChange}>
          <SelectTrigger size="sm" className="h-9 w-48">
            <SelectValue placeholder="Any customer" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ANY_CUSTOMER}>Any customer</SelectItem>
            {customerSelectOptions.map((c) => (
              <SelectItem key={c.value} value={c.value}>
                {c.value} {c.count > 0 && <span className="text-muted-foreground">({c.count})</span>}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <div className="flex flex-wrap gap-1.5">
          {DATE_RANGE_FILTERS.map((f) => {
            const isActive = initialFilters.range === f.key && !initialFilters.from && !initialFilters.to
            return (
              <Link
                key={f.key || "ALL_TIME"}
                href={buildCamJobsHref(initialFilters, { range: f.key, from: "", to: "" })}
                className={pillClassName(isActive)}
              >
                {f.label}
              </Link>
            )
          })}
        </div>

        <div className="flex items-center gap-1.5">
          <Input
            type="date"
            value={fromInput}
            onChange={(e) => setFromInput(e.target.value)}
            className="h-9 w-36 [color-scheme:dark]"
            aria-label="From date"
          />
          <span className="text-xs text-muted-foreground">to</span>
          <Input
            type="date"
            value={toInput}
            onChange={(e) => setToInput(e.target.value)}
            className="h-9 w-36 [color-scheme:dark]"
            aria-label="To date"
          />
          <Button type="button" variant="outline" size="sm" onClick={handleApplyDateRange}>
            Apply
          </Button>
        </div>

        {hasActiveFilters && (
          <Link href="/cam-jobs" className="text-xs text-muted-foreground underline hover:text-primary">
            Clear all
          </Link>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex flex-wrap gap-1.5">
          <span className="text-xs text-muted-foreground mr-1 self-center">Status:</span>
          {STATUS_FILTERS.map((f) => (
            <Link
              key={f.key || "ALL"}
              href={buildCamJobsHref(initialFilters, { status: f.key })}
              className={pillClassName(initialFilters.status === f.key)}
            >
              {f.label}
            </Link>
          ))}
        </div>
        <div className="flex flex-wrap gap-1.5">
          <span className="text-xs text-muted-foreground mr-1 self-center">Health:</span>
          {HEALTH_FILTERS.map((f) => (
            <Link
              key={f.key || "ALL"}
              href={buildCamJobsHref(initialFilters, { health: f.key })}
              className={pillClassName(initialFilters.health === f.key)}
            >
              {f.label}
            </Link>
          ))}
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
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead className="bg-muted">
                <tr>
                  {SORT_COLUMNS.map((col) => (
                    <SortableTh key={col.key} label={col.label} sortKey={col.key} filters={initialFilters} />
                  ))}
                  <th className="px-4 py-3 text-left font-medium text-muted-foreground">Order</th>
                  <th className="px-4 py-3 text-right font-medium text-muted-foreground">Actions</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((job) => {
                  const statusMeta = camJobStatusMeta(job.status)
                  return (
                    <tr key={job.id} className="border-t border-border hover:bg-muted/50">
                      <td className="px-4 py-3">
                        <Link href={`/panelization?load=${job.id}`} className="font-medium text-primary hover:underline">
                          {job.name}
                          {job.revision && <span className="font-normal text-muted-foreground"> · Rev {job.revision}</span>}
                        </Link>
                        <div className="text-xs text-muted-foreground">
                          {job.camMode === "multi" ? "Multi-Design" : "Single Design"} · {job.designCount} design
                          {job.designCount === 1 ? "" : "s"} · {job.layerCount} layer{job.layerCount === 1 ? "" : "s"}
                          {(() => {
                            const panelDim = formatDimensions(job.panelWidthMm, job.panelHeightMm)
                            if (!panelDim) return null
                            // A multi-design panel has no single "the PCB" size — its
                            // design count above already says how many boards share it,
                            // so only single-design jobs also get a PCB dimension.
                            const pcbDim = job.designCount === 1 ? formatDimensions(job.pcbWidthMm, job.pcbHeightMm) : null
                            return (
                              <>
                                {" · Panel "}{panelDim}
                                {pcbDim && <> · PCB {pcbDim}</>}
                              </>
                            )
                          })()}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-foreground">{job.customerRef || <span className="text-muted-foreground">—</span>}</td>
                      <td className="px-4 py-3">
                        <StatusBadge label={statusMeta.label} bg={statusMeta.bg} text={statusMeta.text} />
                      </td>
                      <td className="px-4 py-3">
                        <span title={job.health.reasons.join(" ")}>
                          <StatusBadge label={job.health.label} bg={CAM_JOB_HEALTH_META[job.health.level].bg} text={CAM_JOB_HEALTH_META[job.health.level].text} />
                        </span>
                      </td>
                      <td className="px-4 py-3 text-muted-foreground" title={new Date(job.updatedAt).toString()}>
                        {new Date(job.updatedAt).toLocaleDateString("en-IN", { dateStyle: "medium", timeZone: "Asia/Kolkata" })}
                      </td>
                      <td className="px-4 py-3">
                        {job.orderId ? (
                          <Link href={`/orders/${job.orderId}`} className="text-xs text-muted-foreground hover:text-primary hover:underline">
                            Order →
                          </Link>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <Button variant="ghost" size="sm" onClick={() => setDeleting(job)}>
                          Delete
                        </Button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

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
