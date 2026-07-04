import { NextResponse } from "next/server"
import { OrderStatus } from "@prisma/client"
import { auth } from "@/lib/auth"
import { db } from "@/lib/db"

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const order = await db.order.findUnique({ where: { id }, include: { messageThread: true } })
  if (!order) return NextResponse.json({ error: "Not found" }, { status: 404 })

  const isStaff = session.user.role === "ADMIN" || session.user.role === "ENGINEER"
  if (!isStaff && order.userId !== session.user.id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  return NextResponse.json(order)
}

// Staff-only — moves an order through production (e.g. PENDING_REVIEW ->
// AWAITING_PAYMENT -> IN_PRODUCTION -> SHIPPED -> COMPLETED).
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (session.user.role !== "ADMIN" && session.user.role !== "ENGINEER") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const { status } = await req.json()
  if (!status || !(status in OrderStatus)) {
    return NextResponse.json({ error: "Invalid status." }, { status: 400 })
  }

  const order = await db.order.update({ where: { id }, data: { status } })
  return NextResponse.json(order)
}
