import { NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { db } from "@/lib/db"

export async function GET(req: Request) {
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const orderId = searchParams.get("orderId")
  const isStaff = session.user.role === "ADMIN" || session.user.role === "ENGINEER"

  const threads = await db.messageThread.findMany({
    where: {
      ...(orderId ? { orderId } : {}),
      ...(isStaff ? {} : { OR: [{ order: { userId: session.user.id } }, { createdById: session.user.id }] }),
    },
    include: { order: true, _count: { select: { messages: true } } },
    orderBy: { updatedAt: "desc" },
  })

  return NextResponse.json(threads)
}

export async function POST(req: Request) {
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { subject, message } = await req.json()
  if (!message || typeof message !== "string") {
    return NextResponse.json({ error: "message is required." }, { status: 400 })
  }

  const thread = await db.$transaction(async (tx) => {
    const created = await tx.messageThread.create({
      data: {
        type: "GENERAL_INQUIRY",
        subject: typeof subject === "string" ? subject : null,
        createdById: session.user.id,
      },
    })
    await tx.message.create({
      data: { threadId: created.id, authorId: session.user.id, body: message },
    })
    return created
  })

  return NextResponse.json(thread, { status: 201 })
}
