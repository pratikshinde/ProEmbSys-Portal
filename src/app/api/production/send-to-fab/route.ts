import { NextResponse } from "next/server"
import { z } from "zod"
import { auth } from "@/lib/auth"
import { db } from "@/lib/db"
import { isStaff } from "@/lib/roles"
import { generateWorkOrderReference } from "@/lib/production/reference"
import { notifyUser } from "@/lib/production/notify"
import { friendlyStepLabel } from "@/lib/production/steps"
import { savePanelSvg } from "@/lib/production/panel-files"

const bodySchema = z.object({
  operatorId: z.string().min(1, "Choose an operator"),
  templateId: z.string().optional().nullable(),
  priority: z.enum(["LOW", "NORMAL", "HIGH", "RUSH"]).default("NORMAL"),
  dueDate: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
  boardName: z.string().optional().nullable(),
  orderId: z.string().optional().nullable(),
  orderReference: z.string().optional().nullable(),
  camJobId: z.string().optional().nullable(),
  quantity: z.coerce.number().int().positive().default(1),
  // The Panel Summary numbers, straight from panelResult / panelConfig.
  panelSummary: z.object({
    pcbWidthMm: z.number().nullable(),
    pcbHeightMm: z.number().nullable(),
    panelWidthMm: z.number().nullable(),
    panelHeightMm: z.number().nullable(),
    totalPcbs: z.number(),
    rows: z.number().nullable(),
    cols: z.number().nullable(),
    toolingHoles: z.number(),
    referenceHoles: z.number(),
    fiducials: z.number(),
    unit: z.string(),
  }),
  // Serialized SVG of the Board view.
  panelSvg: z.string().min(1, "Missing panel image"),
})

/**
 * "Send to Fab" — the CAM Panel Config tab hands a finished panel to a shop-floor
 * operator. Creates a ProductionJob (steps from the chosen routing template, or
 * the first active one), stores the panel summary + image, assigns everything to
 * the operator, and notifies them.
 */
export async function POST(request: Request) {
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!isStaff(session.user.role)) return NextResponse.json({ error: "Staff only." }, { status: 403 })

  let data: z.infer<typeof bodySchema>
  try {
    data = bodySchema.parse(await request.json())
  } catch (e) {
    if (e instanceof z.ZodError) {
      return NextResponse.json({ error: e.issues[0]?.message || "Invalid input" }, { status: 400 })
    }
    return NextResponse.json({ error: "Invalid request." }, { status: 400 })
  }

  const operator = await db.user.findFirst({
    where: { id: data.operatorId, role: "OPERATOR", isActive: true },
    select: { id: true, name: true, email: true },
  })
  if (!operator) return NextResponse.json({ error: "That operator could not be found." }, { status: 400 })

  const template = data.templateId
    ? await db.routingTemplate.findUnique({
        where: { id: data.templateId },
        include: { steps: { orderBy: { sequence: "asc" } } },
      })
    : await db.routingTemplate.findFirst({
        where: { isActive: true },
        orderBy: { name: "asc" },
        include: { steps: { orderBy: { sequence: "asc" } } },
      })
  if (!template || template.steps.length === 0) {
    return NextResponse.json({ error: "No routing template with steps is set up." }, { status: 400 })
  }

  const stageTypes = await db.productionStageType.findMany()
  const stageTypeMap = new Map(stageTypes.map((st) => [st.key, st.label]))

  const boardName =
    data.boardName?.trim() ||
    data.orderReference?.trim() ||
    `Panel ${data.panelSummary.panelWidthMm ?? "?"}×${data.panelSummary.panelHeightMm ?? "?"}mm`

  try {
    const job = await db.$transaction(async (tx) => {
      const reference = await generateWorkOrderReference(tx)
      const created = await tx.productionJob.create({
        data: {
          reference,
          boardName,
          customerName: data.orderReference?.trim() || "Panel",
          quantity: data.quantity,
          priority: data.priority,
          dueDate: data.dueDate ? new Date(data.dueDate) : null,
          notes: data.notes || null,
          templateId: template.id,
          orderId: data.orderId || null,
          orderReference: data.orderReference || null,
          camJobId: data.camJobId || null,
          createdById: session.user.id,
          assignedToId: operator.id,
          status: "QUEUED",
          panelSummary: data.panelSummary,
        },
      })

      for (const step of template.steps) {
        const isFirst = step.sequence === 1
        await tx.productionStage.create({
          data: {
            jobId: created.id,
            sequence: step.sequence,
            attempt: 1,
            stageTypeKey: step.stageTypeKey,
            label: stageTypeMap.get(step.stageTypeKey) || step.stageTypeKey,
            status: isFirst ? "READY" : "BLOCKED",
            isOutsourced: step.isOutsourced,
            stationId: step.defaultStationId,
            assignedToId: operator.id,
            slaHours: step.slaHours,
            photoRequired: step.photoRequired,
            qtyOutRequired: step.qtyOutRequired,
            instruction: step.instruction,
            qtyIn: isFirst ? data.quantity : null,
            readyAt: isFirst ? new Date() : null,
          },
        })
      }

      const firstStageLabel = stageTypeMap.get(template.steps[0].stageTypeKey) || template.steps[0].stageTypeKey
      await tx.productionEvent.create({
        data: {
          jobId: created.id,
          type: "JOB_CREATED",
          actorId: session.user.id,
          payload: {
            reference: created.reference,
            boardName,
            via: "send-to-fab",
            templateName: template.name,
            totalStages: template.steps.length,
            panelSummary: data.panelSummary,
          },
        },
      })
      await tx.productionEvent.create({
        data: {
          jobId: created.id,
          type: "JOB_ASSIGNED",
          actorId: session.user.id,
          payload: { operatorId: operator.id, operatorName: operator.name || operator.email, firstStage: firstStageLabel },
        },
      })

      // Save the panel image, then record its path on the job.
      const panelImagePath = await savePanelSvg(created.id, data.panelSvg)
      const withImage = await tx.productionJob.update({
        where: { id: created.id },
        data: { panelImagePath },
      })

      await notifyUser(tx, operator.id, {
        title: `New panel to build: ${boardName}`,
        body: `${created.reference} · ${data.panelSummary.totalPcbs} PCBs · ${template.steps.length} steps. First: ${friendlyStepLabel(
          template.steps[0].stageTypeKey,
          firstStageLabel
        )}.`,
        deeplink: `/production/${created.id}`,
      })

      if (data.orderId) {
        await tx.order.updateMany({
          where: { id: data.orderId, status: { in: ["PENDING_REVIEW", "AWAITING_PAYMENT"] } },
          data: { status: "IN_PRODUCTION" },
        })
      }

      return withImage
    })

    return NextResponse.json({ success: true, jobId: job.id, reference: job.reference })
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Could not send to fab."
    console.error("send-to-fab failed:", error)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
