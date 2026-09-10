import { NextResponse } from "next/server"
import { z } from "zod"
import { v4 as uuidv4 } from "uuid"
import { auth } from "@/lib/auth"
import { db } from "@/lib/db"
import { notifyUser } from "@/lib/production/notify"
import { friendlyStepLabel } from "@/lib/production/steps"

// qtyOut is OPTIONAL — the simple operator flow ("I finished this step") never
// asks for it; it defaults to the stage's qtyIn (nothing scrapped). Only the
// "some boards were scrapped" path sends a number.
const completeSchema = z.object({
  qtyOut: z.coerce.number().int().min(0).optional(),
  scrapQty: z.coerce.number().int().min(0).optional(),
  note: z.string().optional().nullable(),
  actionId: z.string().optional(),
})

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id: stageId } = await params

  try {
    const data = completeSchema.parse(await request.json().catch(() => ({})))
    const actionId = data.actionId || uuidv4()

    // Idempotency: replaying an actionId is a no-op that returns the prior result.
    const existingEvent = await db.productionEvent.findUnique({ where: { actionId } })
    if (existingEvent) {
      const stage = await db.productionStage.findUnique({ where: { id: stageId } })
      return NextResponse.json({ success: true, stage, idempotentReplay: true })
    }

    const stage = await db.productionStage.findUnique({ where: { id: stageId }, include: { job: true } })
    if (!stage) return NextResponse.json({ error: "Step not found." }, { status: 404 })

    if (session.user.role === "OPERATOR" && stage.assignedToId !== session.user.id) {
      return NextResponse.json({ error: "This step isn't assigned to you." }, { status: 403 })
    }
    if (stage.status !== "IN_PROGRESS") {
      return NextResponse.json(
        { error: `Step must be started before it can be finished (it is ${stage.status}).` },
        { status: 400 }
      )
    }

    const qtyOut = data.qtyOut ?? stage.qtyIn ?? stage.job.quantity
    const [totalSteps, doneBefore] = await Promise.all([
      db.productionStage.count({ where: { jobId: stage.jobId, attempt: 1 } }),
      db.productionStage.count({ where: { jobId: stage.jobId, attempt: 1, status: "DONE" } }),
    ])
    const friendlyLabel = friendlyStepLabel(stage.stageTypeKey, stage.label)
    const operatorName = session.user.name || session.user.email || "an operator"
    const calculatedScrap =
      data.scrapQty !== undefined
        ? data.scrapQty
        : stage.qtyIn !== null
        ? Math.max(0, stage.qtyIn - qtyOut)
        : 0

    const result = await db.$transaction(async (tx) => {
      const now = new Date()

      const completedStage = await tx.productionStage.update({
        where: { id: stageId },
        data: { status: "DONE", completedAt: now, qtyOut, scrapQty: calculatedScrap },
      })

      await tx.productionEvent.create({
        data: {
          jobId: stage.jobId,
          stageId: stage.id,
          type: "STAGE_COMPLETED",
          actorId: session.user.id,
          actionId,
          payload: {
            sequence: stage.sequence,
            stageLabel: stage.label,
            qtyIn: stage.qtyIn,
            qtyOut,
            scrapQty: calculatedScrap,
            operatorNote: data.note || null,
            completedAt: now.toISOString(),
          },
        },
      })

      const nextStage = await tx.productionStage.findUnique({
        where: { jobId_sequence_attempt: { jobId: stage.jobId, sequence: stage.sequence + 1, attempt: 1 } },
      })

      let jobCompleted = false

      if (nextStage) {
        await tx.productionStage.update({
          where: { id: nextStage.id },
          data: { status: "READY", readyAt: now, qtyIn: qtyOut },
        })
        await tx.productionEvent.create({
          data: {
            jobId: stage.jobId,
            stageId: nextStage.id,
            type: "STAGE_READY",
            payload: {
              sequence: nextStage.sequence,
              stageLabel: nextStage.label,
              readyAt: now.toISOString(),
              qtyIn: qtyOut,
            },
          },
        })
      } else {
        jobCompleted = true
        await tx.productionJob.update({ where: { id: stage.jobId }, data: { status: "DONE", completedAt: now } })
        await tx.productionEvent.create({
          data: {
            jobId: stage.jobId,
            type: "JOB_DONE",
            actorId: session.user.id,
            payload: { completedAt: now.toISOString(), finalQtyOut: qtyOut },
          },
        })
        await notifyUser(tx, stage.job.createdById, {
          title: `Job finished: ${stage.job.boardName ?? stage.job.reference}`,
          body: `${stage.job.reference} — all ${totalSteps} steps done.`,
          deeplink: `/admin/production/${stage.jobId}`,
        })
        // The portal admin owns "shipped"/"completed" — the order status is
        // deliberately NOT changed on job completion.
      }

      if (!jobCompleted) {
        await notifyUser(tx, stage.job.createdById, {
          title: `${friendlyLabel} done`,
          body: `${stage.job.reference} · by ${operatorName} · ${doneBefore + 1} of ${totalSteps} steps.`,
          deeplink: `/admin/production/${stage.jobId}`,
        })
      }

      return { completedStage, nextStage, jobCompleted }
    })

    return NextResponse.json({ success: true, ...result })
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: error.issues[0]?.message || "Validation error" }, { status: 400 })
    }
    console.error("Failed to complete stage:", error)
    return NextResponse.json({ error: "Could not save. Try again." }, { status: 500 })
  }
}
