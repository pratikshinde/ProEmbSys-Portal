import { NextResponse } from "next/server"
import { v4 as uuidv4 } from "uuid"
import { auth } from "@/lib/auth"
import { db } from "@/lib/db"

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id: stageId } = await params

  try {
    const body = await request.json().catch(() => ({}))
    const actionId = body.actionId || uuidv4()

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
    if (stage.job.status === "ON_HOLD") {
      return NextResponse.json({ error: "This job is paused by the office." }, { status: 400 })
    }
    if (stage.job.status === "CANCELLED" || stage.job.status === "DONE") {
      return NextResponse.json({ error: `This job is already ${stage.job.status.toLowerCase()}.` }, { status: 400 })
    }
    if (stage.status !== "READY") {
      return NextResponse.json({ error: `This step can't be started (it is ${stage.status}).` }, { status: 400 })
    }

    const updatedStage = await db.$transaction(async (tx) => {
      const now = new Date()
      const s = await tx.productionStage.update({
        where: { id: stageId },
        data: { status: "IN_PROGRESS", startedAt: now, assignedToId: session.user.id },
      })
      if (stage.job.status === "QUEUED") {
        await tx.productionJob.update({ where: { id: stage.jobId }, data: { status: "IN_PROGRESS", startedAt: now } })
      }
      await tx.productionEvent.create({
        data: {
          jobId: stage.jobId,
          stageId: stage.id,
          type: "STAGE_STARTED",
          actorId: session.user.id,
          actionId,
          payload: {
            sequence: stage.sequence,
            stageLabel: stage.label,
            startedAt: now.toISOString(),
            operatorName: session.user.name || session.user.email,
          },
        },
      })
      return s
    })

    return NextResponse.json({ success: true, stage: updatedStage })
  } catch (error) {
    console.error("Failed to start stage:", error)
    return NextResponse.json({ error: "Could not start. Try again." }, { status: 500 })
  }
}
