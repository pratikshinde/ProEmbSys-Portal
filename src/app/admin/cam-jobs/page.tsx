import Link from "next/link"
import { redirect } from "next/navigation"
import { auth } from "@/lib/auth"
import { listStaffVisibleCamJobs } from "@/lib/cam-job-access"
import { CAM_JOB_STATUS_META, type CamJobStatusKey } from "@/lib/cam-job-status"
import { CAM_JOB_HEALTH_META } from "@/lib/cam-job-health"
import { StatusBadge } from "@/components/status-badge"

const FILTERS: { key: string; label: string }[] = [
  { key: "ALL", label: "All" },
  ...Object.entries(CAM_JOB_STATUS_META).map(([key, meta]) => ({ key, label: meta.label })),
]

/**
 * Staff-wide CAM job visibility — deliberately NOT every job in the
 * database. listStaffVisibleCamJobs applies the same camJobVisibleWhere
 * rule the read API uses: a job shows up here only once its owner made it
 * shop business (linked to an Order, or shared to an org-wide SHARED
 * contact) — or it's the viewing staff member's own job. A customer's
 * private, unlinked, unshared scratch work stays invisible to staff, same
 * as before this page existed.
 */
export default async function AdminCamJobsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>
}) {
  const session = await auth()
  // AdminLayout already gates on session + staff role — this re-check only
  // exists to give TypeScript a non-null session.user for the query below,
  // never a real fallback path in practice.
  if (!session?.user) redirect("/login?callbackUrl=/admin/cam-jobs")

  const activeFilter = (await searchParams).status
  const filterKey = activeFilter && activeFilter in CAM_JOB_STATUS_META ? activeFilter : undefined

  const jobs = await listStaffVisibleCamJobs(session.user.id, filterKey)

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">CAM Jobs</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Jobs linked to an order, or shared to a team contact — not every customer&apos;s private CAM work.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        {FILTERS.map((f) => {
          const isActive = f.key === "ALL" ? !filterKey : filterKey === f.key
          return (
            <Link
              key={f.key}
              href={f.key === "ALL" ? "/admin/cam-jobs" : `/admin/cam-jobs?status=${f.key}`}
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

      {jobs.length === 0 ? (
        <p className="text-muted-foreground">
          {filterKey ? `No "${CAM_JOB_STATUS_META[filterKey as CamJobStatusKey].label}" jobs.` : "No CAM jobs visible yet."}
        </p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted">
              <tr>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">Job</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">Owner</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">Visible via</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">Status</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">Health</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">Saved</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((job) => {
                const statusMeta = CAM_JOB_STATUS_META[job.status as CamJobStatusKey] ?? { label: job.status, bg: "rgba(148,163,184,0.15)", text: "#94a3b8" }
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
                      </div>
                    </td>
                    <td className="px-4 py-3 text-foreground">{job.ownerName || job.ownerEmail}</td>
                    <td className="px-4 py-3">
                      {job.visibilityReason === "owner" ? (
                        <span className="text-muted-foreground">Your own job</span>
                      ) : job.visibilityReason === "order-link" && job.orderReference ? (
                        <a href={`/admin/orders/${job.orderId}`} className="text-primary hover:underline">
                          Order {job.orderReference}
                        </a>
                      ) : (
                        <span className="text-muted-foreground">Shared with your org</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge label={statusMeta.label} bg={statusMeta.bg} text={statusMeta.text} />
                    </td>
                    <td className="px-4 py-3">
                      <span title={job.health.reasons.join(" ")}>
                        <StatusBadge label={job.health.label} bg={CAM_JOB_HEALTH_META[job.health.level].bg} text={CAM_JOB_HEALTH_META[job.health.level].text} />
                      </span>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {job.updatedAt.toLocaleDateString("en-IN", { dateStyle: "medium", timeZone: "Asia/Kolkata" })}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
