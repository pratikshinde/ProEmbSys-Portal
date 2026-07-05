import { NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { db } from "@/lib/db"

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const existing = await db.address.findUnique({ where: { id } })
  if (!existing || existing.userId !== session.user.id) {
    return NextResponse.json({ error: "Not found" }, { status: 404 })
  }

  const { label, line1, line2, city, state, postalCode, country, gstNumber, isDefault } = await req.json()

  const address = await db.$transaction(async (tx) => {
    if (isDefault) {
      await tx.address.updateMany({
        where: { userId: session.user.id, type: existing.type, isDefault: true, id: { not: id } },
        data: { isDefault: false },
      })
    }
    return tx.address.update({
      where: { id },
      data: {
        ...(label !== undefined ? { label: label || null } : {}),
        ...(line1 !== undefined ? { line1 } : {}),
        ...(line2 !== undefined ? { line2: line2 || null } : {}),
        ...(city !== undefined ? { city } : {}),
        ...(state !== undefined ? { state } : {}),
        ...(postalCode !== undefined ? { postalCode } : {}),
        ...(country !== undefined ? { country } : {}),
        ...(gstNumber !== undefined ? { gstNumber: gstNumber || null } : {}),
        ...(isDefault !== undefined ? { isDefault: !!isDefault } : {}),
      },
    })
  })

  return NextResponse.json(address)
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const existing = await db.address.findUnique({ where: { id } })
  if (!existing || existing.userId !== session.user.id) {
    return NextResponse.json({ error: "Not found" }, { status: 404 })
  }

  await db.address.delete({ where: { id } })
  return NextResponse.json({ ok: true })
}
