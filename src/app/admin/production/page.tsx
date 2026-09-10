import Link from "next/link"
import { db } from "@/lib/db"
import { StatusBadge } from "@/components/status-badge"
import { productionJobStatusMeta, friendlyStep, friendlyStepLabel } from "@/lib/production/steps"
import { AutoRefresh } from "@/components/production/auto-refresh"

function ago(d: Date): string {
  const s = Math.floor((Date.now() - d.getTime()) / 1000)
  if (s < 45) return "just now"
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} h ago`
  return `${Math.floor(h / 24)} d ago`
}

export default async function AdminProductionPage() {
  const jobs = await db.productionJob.findMany({
    orderBy: [{ status: "asc" }, { priority: "desc" }, { createdAt: "desc" }],
    take: 200,
    include: {
      assignedTo: { select: { name: true, email: true } },
      stages: {
        where: { attempt: 1 },
        orderBy: { sequence: "asc" },
        select: { status: true, stageTypeKey: true, label: true },
      },
    },
  })

  const totalByJob = new Map(jobs.map((j) => [j.id, j.stages.length]))

  const rows = jobs.map((j) => {
    const total = j.stages.length
    const done = j.stages.filter((s) => s.status === "DONE").length
    const current =
      j.stages.find((s) => s.status === "IN_PROGRESS") ?? j.stages.find((s) => s.status === "READY") ?? null
    return {
      id: j.id,
      reference: j.reference,
      boardName: j.boardName || "Panel job",
      orderReference: j.orderReference,
      operator: j.assignedTo?.name || j.assignedTo?.email || "—",
      status: j.status,
      done,
      total,
      left: total - done,
      currentStep: current ? friendlyStepLabel(current.stageTypeKey, current.label) : j.status === "DONE" ? "Finished" : "—",
      updatedAt: j.updatedAt,
    }
  })

  const active = rows.filter((r) => r.status === "QUEUED" || r.status === "IN_PROGRESS").length

  // Recent step completions across every job — the running record of what each
  // operator has finished, updated live (AutoRefresh below).
  const recentSteps = await db.productionStage.findMany({
    where: { status: "DONE", attempt: 1, completedAt: { not: null } },
    orderBy: { completedAt: "desc" },
    take: 12,
    select: {
      id: true,
      sequence: true,
      stageTypeKey: true,
      label: true,
      scrapQty: true,
      completedAt: true,
      assignedToId: true,
      job: { select: { id: true, reference: true, boardName: true } },
    },
  })
  const opIds = Array.from(new Set(recentSteps.map((s) => s.assignedToId).filter(Boolean) as string[]))
  const ops = opIds.length
    ? await db.user.findMany({ where: { id: { in: opIds } }, select: { id: true, name: true, email: true } })
    : []
  const opName = new Map(ops.map((o) => [o.id, o.name || o.email]))

  const activity = recentSteps.map((s) => {
    const f = friendlyStep(s.stageTypeKey, s.label)
    const total = totalByJob.get(s.job.id) ?? null
    return {
      id: s.id,
      emoji: f.emoji,
      step: f.short,
      seq: s.sequence,
      total,
      jobId: s.job.id,
      reference: s.job.reference,
      boardName: s.job.boardName || "Panel job",
      operator: s.assignedToId ? opName.get(s.assignedToId) || "operator" : "operator",
      scrap: s.scrapQty || 0,
      when: s.completedAt ? ago(s.completedAt) : "",
      jobDone: total != null && s.sequence === total,
    }
  })

  return (
    <div className="flex flex-col gap-6">
      <AutoRefresh seconds={15} />
      <div>
        <h1 className="text-2xl font-bold text-foreground">Production</h1>
        <p className="text-sm text-muted-foreground">
          Panels sent to the shop floor from the CAM tool. {active} active.
        </p>
      </div>

      {rows.length === 0 ? (
        <div className="rounded-lg border border-border bg-card p-8 text-sm text-muted-foreground">
          Nothing sent to fab yet. Use <strong>Send to Fab</strong> on the CAM tool&apos;s Panel Config tab.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted">
              <tr>
                {["Job", "Operator", "Progress", "Current step", "Status", "Updated"].map((h) => (
                  <th key={h} className="px-4 py-3 text-left font-medium text-muted-foreground">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const meta = productionJobStatusMeta(r.status)
                const pct = r.total ? Math.round((r.done / r.total) * 100) : 0
                return (
                  <tr key={r.id} className="border-t border-border hover:bg-muted/50">
                    <td className="px-4 py-3">
                      <Link href={`/admin/production/${r.id}`} className="font-medium text-primary hover:underline">
                        {r.boardName}
                      </Link>
                      <div className="text-xs text-muted-foreground">
                        {r.reference}
                        {r.orderReference ? ` · ${r.orderReference}` : ""}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-foreground">{r.operator}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <div className="h-2 w-24 overflow-hidden rounded-full bg-muted">
                          <div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
                        </div>
                        <span className="whitespace-nowrap text-xs text-muted-foreground">
                          {r.done}/{r.total}
                          {r.status !== "DONE" && r.left > 0 ? ` · ${r.left} left` : ""}
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-foreground">{r.currentStep}</td>
                    <td className="px-4 py-3">
                      <StatusBadge label={meta.label} bg={meta.bg} text={meta.text} />
                    </td>
                    <td
                      className="px-4 py-3 text-muted-foreground"
                      title={new Date(r.updatedAt).toString()}
                    >
                      {new Date(r.updatedAt).toLocaleString("en-IN", {
                        dateStyle: "medium",
                        timeStyle: "short",
                        timeZone: "Asia/Kolkata",
                      })}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {activity.length > 0 && (
        <div className="rounded-lg border border-border bg-card">
          <div className="border-b border-border px-4 py-2.5 text-sm font-semibold text-foreground">
            Recent activity
          </div>
          <ul className="divide-y divide-border">
            {activity.map((a) => (
              <li key={a.id} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 px-4 py-2.5 text-sm">
                <span className="text-base leading-none">{a.emoji}</span>
                <span className="font-medium text-foreground">{a.step}</span>
                <span className="text-muted-foreground">done</span>
                {a.jobDone && <span className="font-medium text-emerald-500">· job finished 🎉</span>}
                <span className="text-muted-foreground">·</span>
                <Link href={`/admin/production/${a.jobId}`} className="text-primary hover:underline">
                  {a.boardName}
                </Link>
                <span className="text-xs text-muted-foreground">({a.reference})</span>
                <span className="text-muted-foreground">·</span>
                <span className="text-foreground">{a.operator}</span>
                {a.total != null && (
                  <span className="text-xs text-muted-foreground">
                    · step {a.seq} of {a.total}
                  </span>
                )}
                {a.scrap > 0 && <span className="text-xs text-rose-500">· {a.scrap} scrap</span>}
                <span className="ml-auto whitespace-nowrap text-xs text-muted-foreground">{a.when}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
