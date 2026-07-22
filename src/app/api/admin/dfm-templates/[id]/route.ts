import { NextResponse } from "next/server"
import { Prisma } from "@prisma/client"
import { auth } from "@/lib/auth"
import { db } from "@/lib/db"
import { parseDfmRules } from "@/lib/dfm/types"
import { clearOtherDefaults, toDfmTemplateDto } from "@/lib/dfm/templates"

async function requireStaff() {
  const session = await auth()
  if (!session?.user || (session.user.role !== "ADMIN" && session.user.role !== "ENGINEER")) return null
  return session
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const session = await requireStaff()
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const existing = await db.dfmTemplate.findUnique({ where: { id } })
  if (!existing || existing.scope !== "SHARED") {
    return NextResponse.json({ error: "Not found" }, { status: 404 })
  }

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
    if (body?.isDefault) await clearOtherDefaults(tx, "SHARED", null, id)
    return tx.dfmTemplate.update({
      where: { id },
      data: {
        ...(name !== undefined ? { name } : {}),
        ...(rules !== undefined ? { rules: rules as unknown as Prisma.InputJsonValue } : {}),
        ...(body?.isDefault !== undefined ? { isDefault: !!body.isDefault } : {}),
      },
    })
  })

  return NextResponse.json(toDfmTemplateDto(updated, session.user.id))
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const session = await requireStaff()
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const existing = await db.dfmTemplate.findUnique({ where: { id } })
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

  await db.dfmTemplate.delete({ where: { id } })
  return NextResponse.json({ ok: true })
}
