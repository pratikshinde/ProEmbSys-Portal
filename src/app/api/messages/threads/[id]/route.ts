import { NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { db } from "@/lib/db"

async function canAccessThread(
  threadId: string,
  user: { id: string; role: string }
): Promise<boolean> {
  if (user.role === "ADMIN" || user.role === "ENGINEER") return true
  const thread = await db.messageThread.findUnique({ where: { id: threadId }, include: { order: true } })
  if (!thread) return false
  return thread.createdById === user.id || thread.order?.userId === user.id
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!(await canAccessThread(id, session.user))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const thread = await db.messageThread.findUnique({
    where: { id },
    include: { messages: { orderBy: { createdAt: "asc" }, include: { author: { select: { id: true, name: true, email: true, role: true } } } } },
  })
  if (!thread) return NextResponse.json({ error: "Not found" }, { status: 404 })

  return NextResponse.json(thread)
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!(await canAccessThread(id, session.user))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const { body } = await req.json()
  if (!body || typeof body !== "string" || !body.trim()) {
    return NextResponse.json({ error: "body is required." }, { status: 400 })
  }

  const message = await db.$transaction(async (tx) => {
    const created = await tx.message.create({
      data: { threadId: id, authorId: session.user.id, body: body.trim() },
      include: { author: { select: { id: true, name: true, email: true, role: true } } },
    })
    await tx.messageThread.update({ where: { id }, data: { updatedAt: new Date() } })
    return created
  })

  return NextResponse.json(message, { status: 201 })
}
