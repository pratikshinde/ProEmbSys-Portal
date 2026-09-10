import { NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { db } from "@/lib/db"
import { isStaff } from "@/lib/roles"

const UNDO_WINDOW_MS = 30 * 60 * 1000 // the assigned operator can undo their own step for 30 min

/** "Undo" a just-finished step: DONE → IN_PROGRESS, re-block the next step
 *  (only if it hasn't been started), reopen the job if it had just completed.
 *  Staff any time; the assigned operator within 30 minutes. */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id: stageId } = await params

  const stage = await db.productionStage.findUnique({ where: { id: stageId }, include: { job: true } })
  if (!stage) return NextResponse.json({ error: "Step not found." }, { status: 404 })

  const staff = isStaff(session.user.role)
  if (!staff && stage.assignedToId !== session.user.id) {
    return NextResponse.json({ error: "This step isn't yours to undo." }, { status: 403 })
  }
  if (stage.status !== "DONE") {
    return NextResponse.json({ error: "Only a finished step can be undone." }, { status: 400 })
  }
  if (!staff && Date.now() - (stage.completedAt?.getTime() ?? 0) > UNDO_WINDOW_MS) {
    return NextResponse.json({ error: "That step was finished too long ago to undo. Ask the office." }, { status: 400 })
  }

  const nextStage = await db.productionStage.findUnique({
    where: { jobId_sequence_attempt: { jobId: stage.jobId, sequence: stage.sequence + 1, attempt: 1 } },
  })
  if (nextStage && !["READY", "BLOCKED"].includes(nextStage.status)) {
    return NextResponse.json({ error: "The next step has already been started — can't undo this one." }, { status: 400 })
  }

  await db.$transaction(async (tx) => {
    const now = new Date()
    await tx.productionStage.update({
      where: { id: stage.id },
      data: { status: "IN_PROGRESS", completedAt: null, qtyOut: null, scrapQty: null },
    })
    if (nextStage) {
      await tx.productionStage.update({
        where: { id: nextStage.id },
        data: { status: "BLOCKED", readyAt: null, qtyIn: null },
      })
    }
    if (stage.job.status === "DONE") {
      await tx.productionJob.update({ where: { id: stage.jobId }, data: { status: "IN_PROGRESS", completedAt: null } })
    }
    await tx.productionEvent.create({
      data: {
        jobId: stage.jobId,
        stageId: stage.id,
        type: "STAGE_REOPENED",
        actorId: session.user.id,
        payload: { sequence: stage.sequence, stageLabel: stage.label, reopenedAt: now.toISOString() },
      },
    })
  })

  return NextResponse.json({ success: true })
}
