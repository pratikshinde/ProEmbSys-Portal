import { NextResponse } from "next/server"
import { Prisma } from "@prisma/client"
import { auth } from "@/lib/auth"
import { db } from "@/lib/db"
import { parsePanelTemplateSettings } from "@/lib/panel-template/types"
import { clearOtherPanelDefaults, toPanelTemplateDto, visiblePanelTemplatesWhere } from "@/lib/panel-template/templates"

/**
 * List templates the caller may use. Deliberately readable without a session:
 * the CAM Panelization tool is usable logged-out, and anonymous users still
 * need the SHARED templates to apply (they just can't save their own).
 */
export async function GET() {
  const session = await auth()
  const userId = session?.user?.id ?? null

  const rows = await db.panelTemplate.findMany({
    where: visiblePanelTemplatesWhere(userId),
    orderBy: [{ scope: "asc" }, { isDefault: "desc" }, { name: "asc" }],
  })

  return NextResponse.json(rows.map((r) => toPanelTemplateDto(r, userId)))
}

/** Create a PRIVATE template for the signed-in user. SHARED templates are
 *  created via /api/admin/panel-templates (staff only). */
export async function POST(req: Request) {
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const userId = session.user.id

  const body = await req.json()
  const name = typeof body?.name === "string" ? body.name.trim() : ""
  if (!name) return NextResponse.json({ error: "A template name is required." }, { status: 400 })

  let settings
  try {
    settings = parsePanelTemplateSettings(body?.settings)
  } catch {
    return NextResponse.json({ error: "Invalid template settings." }, { status: 400 })
  }

  const created = await db.$transaction(async (tx) => {
    if (body?.isDefault) await clearOtherPanelDefaults(tx, "PRIVATE", userId)
    return tx.panelTemplate.create({
      data: {
        scope: "PRIVATE",
        userId,
        name,
        settings: settings as unknown as Prisma.InputJsonValue,
        isDefault: !!body?.isDefault,
      },
    })
  })

  return NextResponse.json(toPanelTemplateDto(created, userId), { status: 201 })
}
