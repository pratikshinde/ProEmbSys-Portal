import { NextResponse } from "next/server"
import { Prisma } from "@prisma/client"
import { auth } from "@/lib/auth"
import { db } from "@/lib/db"
import { parsePanelTemplateSettings } from "@/lib/panel-template/types"
import { clearOtherPanelDefaults, toPanelTemplateDto } from "@/lib/panel-template/templates"

/** Loads a template only if the caller owns it as a PRIVATE one. SHARED
 *  templates are intentionally not editable here even for staff — they're
 *  managed in /admin/panel-templates, so there's exactly one edit path. */
async function loadOwnPrivate(id: string, userId: string) {
  const existing = await db.panelTemplate.findUnique({ where: { id } })
  if (!existing || existing.scope !== "PRIVATE" || existing.userId !== userId) return null
  return existing
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const userId = session.user.id

  const existing = await loadOwnPrivate(id, userId)
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 })

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
    if (body?.isDefault) await clearOtherPanelDefaults(tx, "PRIVATE", userId, id)
    return tx.panelTemplate.update({
      where: { id },
      data: {
        ...(name !== undefined ? { name } : {}),
        ...(settings !== undefined ? { settings: settings as unknown as Prisma.InputJsonValue } : {}),
        ...(body?.isDefault !== undefined ? { isDefault: !!body.isDefault } : {}),
      },
    })
  })

  return NextResponse.json(toPanelTemplateDto(updated, userId))
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const existing = await loadOwnPrivate(id, session.user.id)
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 })

  await db.panelTemplate.delete({ where: { id } })
  return NextResponse.json({ ok: true })
}
