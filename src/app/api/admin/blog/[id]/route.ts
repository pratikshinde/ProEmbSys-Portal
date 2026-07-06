import { NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { db } from "@/lib/db"

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const session = await auth()
  if (!session?.user || (session.user.role !== "ADMIN" && session.user.role !== "ENGINEER")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const { title, excerpt, content, tag, readMinutes, published } = await req.json()
  const post = await db.blogPost.update({
    where: { id },
    data: {
      ...(title !== undefined ? { title } : {}),
      ...(excerpt !== undefined ? { excerpt } : {}),
      ...(content !== undefined ? { content } : {}),
      ...(tag !== undefined ? { tag } : {}),
      ...(readMinutes !== undefined ? { readMinutes: Number(readMinutes) || 5 } : {}),
      ...(published !== undefined ? { published: !!published } : {}),
    },
  })
  return NextResponse.json(post)
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const session = await auth()
  if (!session?.user || (session.user.role !== "ADMIN" && session.user.role !== "ENGINEER")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }
  await db.blogPost.delete({ where: { id } })
  return NextResponse.json({ ok: true })
}
