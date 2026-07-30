import { NextResponse } from "next/server"
import { Prisma } from "@prisma/client"
import { db } from "@/lib/db"
import { requireStaff } from "@/lib/require-staff"
import { parsePanelTemplateSettings } from "@/lib/panel-template/types"
import { clearOtherPanelDefaults, toPanelTemplateDto } from "@/lib/panel-template/templates"

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const session = await requireStaff()
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const existing = await db.panelTemplate.findUnique({ where: { id } })
  if (!existing || existing.scope !== "SHARED") {
    return NextResponse.json({ error: "Not found" }, { status: 404 })
  }

  const body = await req.json()

  let settings
  if (body?.settings !== undefined) {
    try {
      settings = parsePanelTemplateSettings(body.settings)
    } catch {
      return NextResponse.json({ error: "Invalid template settings." }, { status: 400 })
    }
  }

  const name = body?.name !== undefined ? String(body.name).trim() : undefined
  if (name !== undefined && !name) {
    return NextResponse.json({ error: "A template name is required." }, { status: 400 })
  }

  const updated = await db.$transaction(async (tx) => {
    if (body?.isDefault) await clearOtherPanelDefaults(tx, "SHARED", null, id)
    return tx.panelTemplate.update({
      where: { id },
      data: {
        ...(name !== undefined ? { name } : {}),
        ...(settings !== undefined ? { settings: settings as unknown as Prisma.InputJsonValue } : {}),
        ...(body?.isDefault !== undefined ? { isDefault: !!body.isDefault } : {}),
      },
    })
  })

  return NextResponse.json(toPanelTemplateDto(updated, session.user.id))
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const session = await requireStaff()
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const existing = await db.panelTemplate.findUnique({ where: { id } })
  if (!existing || existing.scope !== "SHARED") {
    return NextResponse.json({ error: "Not found" }, { status: 404 })
  }
  // The seeded baseline is undeletable so there's always at least one
  // selectable template — including for logged-out CAM tool users.
  if (existing.isSystem) {
    return NextResponse.json(
      { error: "The built-in ProEmbSys Standard template can't be deleted." },
      { status: 400 }
    )
  }

  await db.panelTemplate.delete({ where: { id } })
  return NextResponse.json({ ok: true })
}
