import { NextResponse } from "next/server"
import { z } from "zod"
import { auth } from "@/lib/auth"
import { db } from "@/lib/db"
import { isStaff } from "@/lib/roles"
import { notifyUser } from "@/lib/production/notify"

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id: jobId } = await params

  const job = await db.productionJob.findUnique({
    where: { id: jobId },
    include: {
      stages: { orderBy: { sequence: "asc" }, include: { attachments: true } },
      events: { orderBy: { createdAt: "asc" } },
    },
  })
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 })

  if (session.user.role === "OPERATOR" && job.assignedToId !== session.user.id) {
    return NextResponse.json({ error: "Job not found" }, { status: 404 })
  }

  const operatorIds = Array.from(
    new Set([...job.stages.map((s) => s.assignedToId), job.assignedToId].filter(Boolean) as string[])
  )
  const operators = await db.user.findMany({
    where: { id: { in: operatorIds } },
    select: { id: true, name: true, email: true },
  })
  const operatorMap = new Map(operators.map((o) => [o.id, o.name || o.email]))

  return NextResponse.json({
    job: {
      ...job,
      // Operators never receive customer/pricing detail.
      customerName: session.user.role === "OPERATOR" ? "Customer" : job.customerName,
      panelImageUrl: job.panelImagePath ? `/api/production/panel-image/${job.id}` : null,
      assignedToName: job.assignedToId ? operatorMap.get(job.assignedToId) || null : null,
      stages: job.stages.map((s) => ({
        ...s,
        operatorName: s.assignedToId ? operatorMap.get(s.assignedToId) || null : null,
      })),
    },
  })
}

const patchSchema = z.object({
  assignedToId: z.string().min(1).optional(),
  priority: z.enum(["LOW", "NORMAL", "HIGH", "RUSH"]).optional(),
  dueDate: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  cancel: z.boolean().optional(),
  cancelReason: z.string().optional(),
})

/** Staff-only edits: reassign to another operator, change priority / due date /
 *  notes, or cancel. */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!isStaff(session.user.role)) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const { id: jobId } = await params

  let data: z.infer<typeof patchSchema>
  try {
    data = patchSchema.parse(await request.json())
  } catch (e) {
    if (e instanceof z.ZodError) {
      return NextResponse.json({ error: e.issues[0]?.message || "Invalid input" }, { status: 400 })
    }
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
  }

  const job = await db.productionJob.findUnique({ where: { id: jobId } })
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 })
  if (job.status === "DONE" || job.status === "CANCELLED") {
    return NextResponse.json({ error: `Job is already ${job.status.toLowerCase()}.` }, { status: 400 })
  }

  let newOperator: { id: string; name: string | null; email: string } | null = null
  if (data.assignedToId && data.assignedToId !== job.assignedToId) {
    newOperator = await db.user.findFirst({
      where: { id: data.assignedToId, role: "OPERATOR", isActive: true },
      select: { id: true, name: true, email: true },
    })
    if (!newOperator) {
      return NextResponse.json({ error: "That operator could not be found." }, { status: 400 })
    }
  }

  const updated = await db.$transaction(async (tx) => {
    const jobData: Record<string, unknown> = {}
    if (data.priority) jobData.priority = data.priority
    if (data.dueDate !== undefined) jobData.dueDate = data.dueDate ? new Date(data.dueDate) : null
    if (data.notes !== undefined) jobData.notes = data.notes

    if (data.cancel) {
      const reason = data.cancelReason || "Cancelled by admin"
      jobData.status = "CANCELLED"
      jobData.cancelReason = reason
      await tx.productionStage.updateMany({
        where: { jobId, status: { notIn: ["DONE", "CANCELLED"] } },
        data: { status: "CANCELLED" },
      })
      await tx.productionEvent.create({
        data: { jobId, type: "JOB_CANCELLED", actorId: session.user.id, payload: { reason } },
      })
    }

    if (newOperator) {
      jobData.assignedToId = newOperator.id
      await tx.productionStage.updateMany({
        where: { jobId, status: { notIn: ["DONE", "CANCELLED"] } },
        data: { assignedToId: newOperator.id },
      })
      await tx.productionEvent.create({
        data: {
          jobId,
          type: "JOB_REASSIGNED",
          actorId: session.user.id,
          payload: {
            fromOperatorId: job.assignedToId,
            toOperatorId: newOperator.id,
            toOperatorName: newOperator.name || newOperator.email,
          },
        },
      })
      await notifyUser(tx, newOperator.id, {
        title: `Job assigned to you: ${job.boardName ?? job.reference}`,
        body: `${job.reference} · ${job.quantity} boards.`,
        deeplink: `/production/${jobId}`,
      })
      if (job.assignedToId) {
        await notifyUser(tx, job.assignedToId, {
          title: "Job moved to someone else",
          body: `${job.reference} is no longer assigned to you.`,
          deeplink: `/production`,
        })
      }
    }

    if (Object.keys(jobData).length === 0) return job
    return tx.productionJob.update({ where: { id: jobId }, data: jobData })
  })

  return NextResponse.json({ success: true, job: updated })
}
