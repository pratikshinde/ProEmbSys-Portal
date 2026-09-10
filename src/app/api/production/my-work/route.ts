import { NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { db } from "@/lib/db"
import { friendlyStep } from "@/lib/production/steps"

/**
 * The operator's "My Work" feed — one entry per assigned job that isn't
 * finished or cancelled, shaped for a dead-simple screen: progress, the next
 * step, plain board specs. Never price / customer contact. Staff see every
 * active job (for support).
 */
export async function GET() {
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const isOperator = session.user.role === "OPERATOR"

  const jobs = await db.productionJob.findMany({
    where: {
      status: { in: ["QUEUED", "IN_PROGRESS", "ON_HOLD"] },
      ...(isOperator ? { assignedToId: session.user.id } : {}),
    },
    include: {
      stages: {
        where: { attempt: 1 },
        orderBy: { sequence: "asc" },
        select: { id: true, sequence: true, label: true, stageTypeKey: true, status: true, instruction: true },
      },
    },
    orderBy: [{ priority: "desc" }, { dueDate: "asc" }, { createdAt: "asc" }],
  })

  const orderIds = jobs.map((j) => j.orderId).filter(Boolean) as string[]
  const orders = orderIds.length
    ? await db.order.findMany({
        where: { id: { in: orderIds } },
        select: {
          id: true,
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
    : []
  const orderMap = new Map(orders.map((o) => [o.id, o]))

  const items = jobs.map((job) => {
    const total = job.stages.length
    const done = job.stages.filter((s) => s.status === "DONE").length
    const current =
      job.stages.find((s) => s.status === "IN_PROGRESS") ?? job.stages.find((s) => s.status === "READY") ?? null
    const order = job.orderId ? orderMap.get(job.orderId) : undefined

    return {
      id: job.id,
      reference: job.reference,
      boardName: job.boardName || "PCB job",
      quantity: job.quantity,
      priority: job.priority,
      dueDate: job.dueDate,
      onHold: job.status === "ON_HOLD",
      notes: job.notes,
      done,
      total,
      remaining: total - done,
      allDone: done === total && total > 0,
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
    }
  })

  const priorityWeight: Record<string, number> = { RUSH: 3, HIGH: 2, NORMAL: 1, LOW: 0 }
  items.sort((a, b) => {
    if (a.allDone !== b.allDone) return a.allDone ? 1 : -1
    const pw = (priorityWeight[b.priority] ?? 1) - (priorityWeight[a.priority] ?? 1)
    if (pw !== 0) return pw
    const ad = a.dueDate ? new Date(a.dueDate).getTime() : Infinity
    const bd = b.dueDate ? new Date(b.dueDate).getTime() : Infinity
    return ad - bd
  })

  return NextResponse.json({ jobs: items })
}
