import { NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { db } from "@/lib/db"

/** Mark notifications read: { all: true } or { ids: string[] }. */
export async function POST(req: Request) {
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const body = await req.json().catch(() => ({}))
  const where = body?.all
    ? { userId: session.user.id, readAt: null }
    : Array.isArray(body?.ids) && body.ids.length
    ? { userId: session.user.id, id: { in: body.ids as string[] }, readAt: null }
    : null

  if (!where) return NextResponse.json({ error: "Nothing to mark." }, { status: 400 })

  await db.inAppNotification.updateMany({ where, data: { readAt: new Date() } })
  return NextResponse.json({ success: true })
}
