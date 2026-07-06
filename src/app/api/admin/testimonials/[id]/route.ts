import { NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { db } from "@/lib/db"

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const session = await auth()
  if (!session?.user || (session.user.role !== "ADMIN" && session.user.role !== "ENGINEER")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const { customerName, customerTitle, quote, rating, isActive, sortOrder } = await req.json()
  if (rating !== undefined && (Number(rating) < 1 || Number(rating) > 5)) {
    return NextResponse.json({ error: "rating must be between 1 and 5." }, { status: 400 })
  }

  const testimonial = await db.testimonial.update({
    where: { id },
    data: {
      ...(customerName !== undefined ? { customerName } : {}),
      ...(customerTitle !== undefined ? { customerTitle: customerTitle || null } : {}),
      ...(quote !== undefined ? { quote } : {}),
      ...(rating !== undefined ? { rating: Number(rating) } : {}),
      ...(isActive !== undefined ? { isActive: !!isActive } : {}),
      ...(sortOrder !== undefined ? { sortOrder: Number(sortOrder) || 0 } : {}),
    },
  })
  return NextResponse.json(testimonial)
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const session = await auth()
  if (!session?.user || (session.user.role !== "ADMIN" && session.user.role !== "ENGINEER")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }
  await db.testimonial.delete({ where: { id } })
  return NextResponse.json({ ok: true })
}
