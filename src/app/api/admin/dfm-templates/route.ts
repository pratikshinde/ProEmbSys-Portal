import { NextResponse } from "next/server"
import { Prisma } from "@prisma/client"
import { auth } from "@/lib/auth"
import { db } from "@/lib/db"
import { parseDfmRules } from "@/lib/dfm/types"
import { clearOtherDefaults, toDfmTemplateDto } from "@/lib/dfm/templates"

/** Staff-only management of the SHARED template tier — the templates every
 *  user (and anonymous visitors) can select. Mirrors /api/admin/products. */
async function requireStaff() {
  const session = await auth()
  if (!session?.user || (session.user.role !== "ADMIN" && session.user.role !== "ENGINEER")) return null
  return session
}

export async function GET() {
  const session = await requireStaff()
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const rows = await db.dfmTemplate.findMany({
    where: { scope: "SHARED" },
    orderBy: [{ isDefault: "desc" }, { name: "asc" }],
  })
  return NextResponse.json(rows.map((r) => toDfmTemplateDto(r, session.user.id)))
}

export async function POST(req: Request) {
  const session = await requireStaff()
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const body = await req.json()
  const name = typeof body?.name === "string" ? body.name.trim() : ""
  if (!name) return NextResponse.json({ error: "A template name is required." }, { status: 400 })

  let rules
  try {
    rules = parseDfmRules(body?.rules)
  } catch {
    return NextResponse.json({ error: "Invalid rule values." }, { status: 400 })
  }

  const created = await db.$transaction(async (tx) => {
    if (body?.isDefault) await clearOtherDefaults(tx, "SHARED", null)
    return tx.dfmTemplate.create({
      data: {
        scope: "SHARED",
        name,
        rules: rules as unknown as Prisma.InputJsonValue,
        isDefault: !!body?.isDefault,
      },
    })
  })

  return NextResponse.json(toDfmTemplateDto(created, session.user.id), { status: 201 })
}
