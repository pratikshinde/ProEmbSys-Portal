import { NextResponse } from "next/server"
import { Prisma } from "@prisma/client"
import { auth } from "@/lib/auth"
import { db } from "@/lib/db"
import { parseDfmRules } from "@/lib/dfm/types"
import { clearOtherDefaults, toDfmTemplateDto, visibleTemplatesWhere } from "@/lib/dfm/templates"

/**
 * List templates the caller may use. Deliberately readable without a session:
 * the CAM Panelization tool is usable logged-out, and anonymous users still
 * need the SHARED templates to run a check against (they just can't save).
 */
export async function GET() {
  const session = await auth()
  const userId = session?.user?.id ?? null

  const rows = await db.dfmTemplate.findMany({
    where: visibleTemplatesWhere(userId),
    orderBy: [{ scope: "asc" }, { isDefault: "desc" }, { name: "asc" }],
  })

  return NextResponse.json(rows.map((r) => toDfmTemplateDto(r, userId)))
}

/** Create a PRIVATE template for the signed-in user. SHARED templates are
 *  created via /api/admin/dfm-templates (staff only). */
export async function POST(req: Request) {
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const userId = session.user.id

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
    if (body?.isDefault) await clearOtherDefaults(tx, "PRIVATE", userId)
    return tx.dfmTemplate.create({
      data: {
        scope: "PRIVATE",
        userId,
        name,
        rules: rules as unknown as Prisma.InputJsonValue,
        isDefault: !!body?.isDefault,
      },
    })
  })

  return NextResponse.json(toDfmTemplateDto(created, userId), { status: 201 })
}
