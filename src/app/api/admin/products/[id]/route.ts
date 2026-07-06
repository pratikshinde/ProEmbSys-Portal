import { NextResponse } from "next/server"
import { Prisma, StockStatus } from "@prisma/client"
import { auth } from "@/lib/auth"
import { db } from "@/lib/db"

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const session = await auth()
  if (!session?.user || (session.user.role !== "ADMIN" && session.user.role !== "ENGINEER")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const { name, description, price, category, icon, stockStatus, isActive, sortOrder } = await req.json()
  if (stockStatus !== undefined && !(stockStatus in StockStatus)) {
    return NextResponse.json({ error: "Invalid stockStatus." }, { status: 400 })
  }

  const product = await db.product.update({
    where: { id },
    data: {
      ...(name !== undefined ? { name } : {}),
      ...(description !== undefined ? { description: description || null } : {}),
      ...(price !== undefined ? { price: price as Prisma.Decimal.Value } : {}),
      ...(category !== undefined ? { category } : {}),
      ...(icon !== undefined ? { icon } : {}),
      ...(stockStatus !== undefined ? { stockStatus } : {}),
      ...(isActive !== undefined ? { isActive: !!isActive } : {}),
      ...(sortOrder !== undefined ? { sortOrder: Number(sortOrder) || 0 } : {}),
    },
  })
  return NextResponse.json(product)
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const session = await auth()
  if (!session?.user || (session.user.role !== "ADMIN" && session.user.role !== "ENGINEER")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }
  await db.product.delete({ where: { id } })
  return NextResponse.json({ ok: true })
}
