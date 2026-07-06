import { NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { db } from "@/lib/db"

export async function GET() {
  const session = await auth()
  if (!session?.user || (session.user.role !== "ADMIN" && session.user.role !== "ENGINEER")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }
  const testimonials = await db.testimonial.findMany({ orderBy: [{ sortOrder: "asc" }, { createdAt: "desc" }] })
  return NextResponse.json(testimonials)
}

export async function POST(req: Request) {
  const session = await auth()
  if (!session?.user || (session.user.role !== "ADMIN" && session.user.role !== "ENGINEER")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const { customerName, customerTitle, quote, rating, isActive, sortOrder } = await req.json()
  if (!customerName || !quote) {
    return NextResponse.json({ error: "customerName and quote are required." }, { status: 400 })
  }
  const ratingNum = Number(rating) || 5
  if (ratingNum < 1 || ratingNum > 5) {
    return NextResponse.json({ error: "rating must be between 1 and 5." }, { status: 400 })
  }

  const testimonial = await db.testimonial.create({
    data: {
      customerName,
      customerTitle: customerTitle || null,
      quote,
      rating: ratingNum,
      isActive: isActive !== false,
      sortOrder: Number(sortOrder) || 0,
    },
  })
  return NextResponse.json(testimonial, { status: 201 })
}
