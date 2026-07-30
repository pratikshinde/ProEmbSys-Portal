import { NextResponse } from "next/server"
import { Prisma } from "@prisma/client"
import { db } from "@/lib/db"
import { requireStaff } from "@/lib/require-staff"
import { parsePanelTemplateSettings } from "@/lib/panel-template/types"
import { clearOtherPanelDefaults, toPanelTemplateDto } from "@/lib/panel-template/templates"

/** Staff-only management of the SHARED template tier — the templates every
 *  user (and anonymous visitors) can select. Mirrors /api/admin/dfm-templates. */

export async function GET() {
  const session = await requireStaff()
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const rows = await db.panelTemplate.findMany({
    where: { scope: "SHARED" },
    orderBy: [{ isDefault: "desc" }, { name: "asc" }],
  })
  return NextResponse.json(rows.map((r) => toPanelTemplateDto(r, session.user.id)))
}

export async function POST(req: Request) {
  const session = await requireStaff()
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

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
    if (body?.isDefault) await clearOtherPanelDefaults(tx, "SHARED", null)
    return tx.panelTemplate.create({
      data: {
        scope: "SHARED",
        name,
        settings: settings as unknown as Prisma.InputJsonValue,
        isDefault: !!body?.isDefault,
      },
    })
  })

  return NextResponse.json(toPanelTemplateDto(created, session.user.id), { status: 201 })
}
