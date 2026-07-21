import { NextResponse } from "next/server"
import { ShopOrderStatus } from "@prisma/client"
import { auth } from "@/lib/auth"
import { db } from "@/lib/db"

// Staff-only — mirrors PATCH /api/orders/[id]. Moves a Shop order through
// fulfillment (PAID -> SHIPPED -> COMPLETED).
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (session.user.role !== "ADMIN" && session.user.role !== "ENGINEER") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const { status } = await req.json()
  if (!status || !(status in ShopOrderStatus)) {
    return NextResponse.json({ error: "Invalid status." }, { status: 400 })
  }

  const shopOrder = await db.shopOrder.update({ where: { id }, data: { status } })
  return NextResponse.json(shopOrder)
}
