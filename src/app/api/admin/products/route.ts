import { NextResponse } from "next/server"
import { Prisma, StockStatus } from "@prisma/client"
import { auth } from "@/lib/auth"
import { db } from "@/lib/db"

export async function GET() {
  const session = await auth()
  if (!session?.user || (session.user.role !== "ADMIN" && session.user.role !== "ENGINEER")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }
  const products = await db.product.findMany({ orderBy: [{ sortOrder: "asc" }, { createdAt: "desc" }] })
  return NextResponse.json(products)
}

export async function POST(req: Request) {
  const session = await auth()
  if (!session?.user || (session.user.role !== "ADMIN" && session.user.role !== "ENGINEER")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const { name, description, price, category, icon, stockStatus, isActive, sortOrder } = await req.json()
  if (!name || !category || !icon || typeof price !== "number" || price < 0) {
    return NextResponse.json({ error: "name, category, icon, and a non-negative price are required." }, { status: 400 })
  }
  if (stockStatus !== undefined && !(stockStatus in StockStatus)) {
    return NextResponse.json({ error: "Invalid stockStatus." }, { status: 400 })
  }

  const product = await db.product.create({
    data: {
      name,
      description: description || null,
      price: price as Prisma.Decimal.Value,
      category,
      icon,
      stockStatus: stockStatus ?? "IN_STOCK",
      isActive: isActive !== false,
      sortOrder: Number(sortOrder) || 0,
    },
  })
  return NextResponse.json(product, { status: 201 })
}
