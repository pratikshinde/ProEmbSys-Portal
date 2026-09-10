import { NextResponse } from "next/server"
import { z } from "zod"
import { auth } from "@/lib/auth"
import { db } from "@/lib/db"
import { isStaff } from "@/lib/roles"

// Staff-only: turn a self-registered operator account on or off. Deactivating
// blocks login (authorize() checks isActive) but keeps the account + its
// production history — never a hard delete.
const schema = z.object({ isActive: z.boolean() })

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!isStaff(session.user.role)) return NextResponse.json({ error: "Staff only." }, { status: 403 })

  const { id } = await params
  let isActiveNext: boolean
  try {
    isActiveNext = schema.parse(await req.json()).isActive
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 })
  }

  const target = await db.user.findUnique({ where: { id }, select: { id: true, role: true } })
  if (!target || target.role !== "OPERATOR") {
    return NextResponse.json({ error: "Operator not found." }, { status: 404 })
  }

  const user = await db.user.update({
    where: { id },
    data: { isActive: isActiveNext },
    select: { id: true, name: true, email: true, isActive: true, emailVerified: true, createdAt: true },
  })
  return NextResponse.json({
    ...user,
    verified: user.emailVerified !== null,
    createdAt: user.createdAt.toISOString(),
  })
}
