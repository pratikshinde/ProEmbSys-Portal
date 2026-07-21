import { NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { db } from "@/lib/db"

// Mirrors GET /api/orders — customer sees own Shop orders, staff see all.
export async function GET() {
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const isStaff = session.user.role === "ADMIN" || session.user.role === "ENGINEER"
  const shopOrders = await db.shopOrder.findMany({
    where: isStaff ? {} : { userId: session.user.id },
    include: { items: true },
    orderBy: { createdAt: "desc" },
  })
  return NextResponse.json(shopOrders)
}
