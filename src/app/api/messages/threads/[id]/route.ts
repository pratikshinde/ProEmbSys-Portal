import { NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { db } from "@/lib/db"
import { canAccessThread } from "@/lib/messaging"
import { saveMessageAttachment, type SavedAttachment } from "@/lib/attachments"

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

// Accepts multipart/form-data: "body" (text, optional if a file is attached)
// and "file" (an image screenshot, optional if body text is present).
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!(await canAccessThread(id, session.user))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const formData = await req.formData()
  const body = (formData.get("body") as string | null)?.trim() ?? ""
  const file = formData.get("file")

  if (!body && !(file instanceof File)) {
    return NextResponse.json({ error: "A message or attachment is required." }, { status: 400 })
  }

  let attachment: SavedAttachment | null = null
  if (file instanceof File && file.size > 0) {
    try {
      attachment = await saveMessageAttachment(id, file)
    } catch (err) {
      return NextResponse.json({ error: err instanceof Error ? err.message : "Could not save attachment." }, { status: 400 })
    }
  }

  const message = await db.$transaction(async (tx) => {
    const created = await tx.message.create({
      data: { threadId: id, authorId: session.user.id, body, ...attachment },
      include: { author: { select: { id: true, name: true, email: true, role: true } } },
    })
    await tx.messageThread.update({ where: { id }, data: { updatedAt: new Date() } })
    return created
  })

  return NextResponse.json(message, { status: 201 })
}
