import { NextResponse } from "next/server"
import { Role } from "@prisma/client"
import { auth } from "@/lib/auth"
import { db } from "@/lib/db"

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const session = await auth()
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const { name, role, isActive } = await req.json()
  if (role !== undefined && role !== "ADMIN" && role !== "ENGINEER") {
    return NextResponse.json({ error: "role must be ADMIN or ENGINEER." }, { status: 400 })
  }
  if (id === session.user.id && (isActive === false || (role !== undefined && role !== "ADMIN"))) {
    return NextResponse.json({ error: "You cannot deactivate or demote your own account." }, { status: 400 })
  }

  const user = await db.user.update({
    where: { id },
    data: {
      ...(name !== undefined ? { name } : {}),
      ...(role !== undefined ? { role: role as Role } : {}),
      ...(isActive !== undefined ? { isActive: !!isActive } : {}),
    },
    select: { id: true, name: true, email: true, role: true, isActive: true, createdAt: true },
  })
  return NextResponse.json(user)
}

// Deactivates rather than hard-deletes — a staff account's sent messages are
// shared with customers in order threads, and Message.authorId cascades on
// delete. Hard-deleting would silently erase their side of past
// conversations. See prisma/schema.prisma's User.isActive comment.
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const session = await auth()
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }
  if (id === session.user.id) {
    return NextResponse.json({ error: "You cannot deactivate your own account." }, { status: 400 })
  }

  const user = await db.user.update({
    where: { id },
    data: { isActive: false },
    select: { id: true, name: true, email: true, role: true, isActive: true, createdAt: true },
  })
  return NextResponse.json(user)
}
