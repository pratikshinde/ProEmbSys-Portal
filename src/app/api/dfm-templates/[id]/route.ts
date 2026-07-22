import { NextResponse } from "next/server"
import { Prisma } from "@prisma/client"
import { auth } from "@/lib/auth"
import { db } from "@/lib/db"
import { parseDfmRules } from "@/lib/dfm/types"
import { clearOtherDefaults, toDfmTemplateDto } from "@/lib/dfm/templates"

/** Loads a template only if the caller owns it as a PRIVATE one. SHARED
 *  templates are intentionally not editable here even for staff — they're
 *  managed in /admin/dfm-templates, so there's exactly one edit path. */
async function loadOwnPrivate(id: string, userId: string) {
  const existing = await db.dfmTemplate.findUnique({ where: { id } })
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

  let rules
  if (body?.rules !== undefined) {
    try {
      rules = parseDfmRules(body.rules)
    } catch {
      return NextResponse.json({ error: "Invalid rule values." }, { status: 400 })
    }
  }

  const name = body?.name !== undefined ? String(body.name).trim() : undefined
  if (name !== undefined && !name) {
    return NextResponse.json({ error: "A template name is required." }, { status: 400 })
  }

  const updated = await db.$transaction(async (tx) => {
    if (body?.isDefault) await clearOtherDefaults(tx, "PRIVATE", userId, id)
    return tx.dfmTemplate.update({
      where: { id },
      data: {
        ...(name !== undefined ? { name } : {}),
        ...(rules !== undefined ? { rules: rules as unknown as Prisma.InputJsonValue } : {}),
        ...(body?.isDefault !== undefined ? { isDefault: !!body.isDefault } : {}),
      },
    })
  })

  return NextResponse.json(toDfmTemplateDto(updated, userId))
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const existing = await loadOwnPrivate(id, session.user.id)
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 })

  await db.dfmTemplate.delete({ where: { id } })
  return NextResponse.json({ ok: true })
}
