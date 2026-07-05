import { NextResponse } from "next/server"
import { AddressType } from "@prisma/client"
import { auth } from "@/lib/auth"
import { db } from "@/lib/db"

export async function GET() {
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const addresses = await db.address.findMany({
    where: { userId: session.user.id },
    orderBy: { createdAt: "asc" },
  })
  return NextResponse.json(addresses)
}

export async function POST(req: Request) {
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { type, label, line1, line2, city, state, postalCode, country, gstNumber, isDefault } = await req.json()

  if (!type || !(type in AddressType)) {
    return NextResponse.json({ error: "type must be BILLING or DELIVERY." }, { status: 400 })
  }
  if (!line1 || !city || !state || !postalCode) {
    return NextResponse.json({ error: "line1, city, state, and postalCode are required." }, { status: 400 })
  }

  const address = await db.$transaction(async (tx) => {
    if (isDefault) {
      await tx.address.updateMany({
        where: { userId: session.user.id, type, isDefault: true },
        data: { isDefault: false },
      })
    }
    return tx.address.create({
      data: {
        userId: session.user.id,
        type,
        label: label || null,
        line1,
        line2: line2 || null,
        city,
        state,
        postalCode,
        country: country || "India",
        gstNumber: gstNumber || null,
        isDefault: !!isDefault,
      },
    })
  })

  return NextResponse.json(address, { status: 201 })
}
