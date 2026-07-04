import { NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { db } from "@/lib/db"

async function requireAdmin() {
  const session = await auth()
  if (!session?.user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) }
  if (session.user.role !== "ADMIN") return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) }
  return { session }
}

export async function GET() {
  const { error } = await requireAdmin()
  if (error) return error

  const rates = await db.pricingRate.findMany({ orderBy: [{ category: "asc" }, { sortOrder: "asc" }] })
  return NextResponse.json(rates)
}

export async function POST(req: Request) {
  const { error, session } = await requireAdmin()
  if (error) return error

  const { category, key, label, value, unit, sortOrder } = await req.json()
  if (!category || !key || !label || typeof value !== "number" || !unit) {
    return NextResponse.json({ error: "category, key, label, value, unit are required." }, { status: 400 })
  }

  const rate = await db.pricingRate.create({
    data: { category, key, label, value, unit, sortOrder: sortOrder ?? 0, updatedById: session!.user.id },
  })
  return NextResponse.json(rate, { status: 201 })
}
