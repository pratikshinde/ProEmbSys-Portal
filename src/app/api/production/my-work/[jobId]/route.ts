import { NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { db } from "@/lib/db"
import { friendlyStep } from "@/lib/production/steps"

/** One job for the operator's job screen — same simple shape as /my-work, but
 *  for a single job of any status (so the "All done 🎉" screen still renders). */
export async function GET(_req: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { jobId } = await params

  const job = await db.productionJob.findUnique({
    where: { id: jobId },
    include: {
      stages: {
        where: { attempt: 1 },
        orderBy: { sequence: "asc" },
        select: {
          id: true,
          sequence: true,
          label: true,
          stageTypeKey: true,
          status: true,
          instruction: true,
          completedAt: true,
        },
      },
    },
  })
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 })
  if (session.user.role === "OPERATOR" && job.assignedToId !== session.user.id) {
    return NextResponse.json({ error: "Job not found" }, { status: 404 })
  }

  const order = job.orderId
    ? await db.order.findUnique({
        where: { id: job.orderId },
        select: {
          widthMm: true,
          heightMm: true,
          layers: true,
          finish: true,
          color: true,
          thickness: true,
          copperWeight: true,
          deliveryFormat: true,
        },
      })
    : null

  const total = job.stages.length
  const done = job.stages.filter((s) => s.status === "DONE").length
  const current =
    job.stages.find((s) => s.status === "IN_PROGRESS") ?? job.stages.find((s) => s.status === "READY") ?? null

  return NextResponse.json({
    job: {
      id: job.id,
      reference: job.reference,
      boardName: job.boardName || "PCB job",
      quantity: job.quantity,
      priority: job.priority,
      dueDate: job.dueDate,
      onHold: job.status === "ON_HOLD",
      cancelled: job.status === "CANCELLED",
      notes: job.notes,
      done,
      total,
      remaining: total - done,
      allDone: job.status === "DONE" || (done === total && total > 0),
      panelSummary: job.panelSummary ?? null,
      panelImageUrl: job.panelImagePath ? `/api/production/panel-image/${job.id}` : null,
      current: current
        ? {
            id: current.id,
            sequence: current.sequence,
            status: current.status,
            ...friendlyStep(current.stageTypeKey, current.label),
            instruction: current.instruction,
          }
        : null,
      steps: job.stages.map((s) => ({
        id: s.id,
        sequence: s.sequence,
        status: s.status,
        completedAt: s.completedAt,
        instruction: s.instruction,
        ...friendlyStep(s.stageTypeKey, s.label),
      })),
      specs: order
        ? {
            widthMm: Number(order.widthMm),
            heightMm: Number(order.heightMm),
            layers: order.layers,
            finish: order.finish,
            color: order.color,
            thickness: order.thickness,
            copperWeight: order.copperWeight,
            deliveryFormat: order.deliveryFormat,
          }
        : null,
    },
  })
}
