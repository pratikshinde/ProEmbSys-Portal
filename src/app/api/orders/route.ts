import { NextResponse } from "next/server"
import { Prisma, DeliveryFormat } from "@prisma/client"
import { auth } from "@/lib/auth"
import { db } from "@/lib/db"
import { buildRatesMap, calculatePcbQuoteV2 } from "@/lib/pricing-engine"
import { generateOrderReference } from "@/lib/order-reference"

export async function GET() {
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const isStaff = session.user.role === "ADMIN" || session.user.role === "ENGINEER"
  const orders = await db.order.findMany({
    where: isStaff ? {} : { userId: session.user.id },
    orderBy: { createdAt: "desc" },
  })
  return NextResponse.json(orders)
}

export async function POST(req: Request) {
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const body = await req.json()
  const { fileName, widthMm, heightMm, layers, qty, finish, color, copperWeight, thickness, express, deliveryFormat, placeOrder } = body

  if (typeof widthMm !== "number" || typeof heightMm !== "number" || widthMm <= 0 || heightMm <= 0) {
    return NextResponse.json({ error: "widthMm and heightMm must be positive numbers." }, { status: 400 })
  }
  if (deliveryFormat !== undefined && !(deliveryFormat in DeliveryFormat)) {
    return NextResponse.json({ error: "Invalid deliveryFormat." }, { status: 400 })
  }
  const resolvedDeliveryFormat: DeliveryFormat = deliveryFormat ?? "INDIVIDUAL"

  // Never trust a client-sent price — recompute from the current rates so
  // the stored breakdown is a trustworthy snapshot.
  const rateRows = await db.pricingRate.findMany({ where: { isActive: true } })
  const rates = buildRatesMap(rateRows)
  const breakdown = calculatePcbQuoteV2(
    {
      widthMm,
      heightMm,
      layers: String(layers),
      qty: Number(qty) || 1,
      finish,
      copperWeight,
      thickness,
      express: !!express,
      deliveryFormat: resolvedDeliveryFormat,
    },
    rates
  )

  const order = await db.$transaction(async (tx) => {
    const reference = await generateOrderReference(tx)
    const created = await tx.order.create({
      data: {
        reference,
        userId: session.user.id,
        status: placeOrder ? "PENDING_REVIEW" : "QUOTE",
        deliveryFormat: resolvedDeliveryFormat,
        fileName: fileName ?? null,
        widthMm,
        heightMm,
        layers: String(layers),
        qty: Number(qty) || 1,
        finish,
        color,
        copperWeight,
        thickness,
        express: !!express,
        priceBreakdown: breakdown as unknown as Prisma.InputJsonValue,
        total: breakdown.total,
      },
    })
    await tx.messageThread.create({
      data: { type: "ORDER", orderId: created.id, createdById: session.user.id },
    })
    return created
  })

  return NextResponse.json(order, { status: 201 })
}
