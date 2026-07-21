import { NextResponse } from "next/server"
import { Prisma, DeliveryFormat } from "@prisma/client"
import { auth } from "@/lib/auth"
import { db } from "@/lib/db"
import { buildRatesMap, calculatePcbQuoteV2 } from "@/lib/pricing-engine"
import { generateOrderReference } from "@/lib/order-reference"
import { saveOrderFile, type SavedOrderFile } from "@/lib/order-files"
import { loadAddressSnapshot } from "@/lib/address-snapshot"

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
  const userId = session.user.id

  const formData = await req.formData()
  const getStr = (key: string) => {
    const v = formData.get(key)
    return typeof v === "string" && v.length > 0 ? v : undefined
  }

  const widthMm = Number(getStr("widthMm"))
  const heightMm = Number(getStr("heightMm"))
  const layers = getStr("layers")
  const qty = getStr("qty")
  const finish = getStr("finish")
  const color = getStr("color")
  const copperWeight = getStr("copperWeight")
  const thickness = getStr("thickness")
  const express = getStr("express") === "true"
  const deliveryFormat = getStr("deliveryFormat")
  const deliveryAddressId = getStr("deliveryAddressId")
  const billingAddressId = getStr("billingAddressId")
  const placeOrder = getStr("placeOrder") === "true"
  const file = formData.get("file")

  if (!Number.isFinite(widthMm) || !Number.isFinite(heightMm) || widthMm <= 0 || heightMm <= 0) {
    return NextResponse.json({ error: "widthMm and heightMm must be positive numbers." }, { status: 400 })
  }
  if (!layers || !finish || !color || !copperWeight || !thickness) {
    return NextResponse.json({ error: "layers, finish, color, copperWeight, and thickness are required." }, { status: 400 })
  }
  if (deliveryFormat !== undefined && !(deliveryFormat in DeliveryFormat)) {
    return NextResponse.json({ error: "Invalid deliveryFormat." }, { status: 400 })
  }
  const resolvedDeliveryFormat: DeliveryFormat = (deliveryFormat as DeliveryFormat) ?? "INDIVIDUAL"

  if (placeOrder && !deliveryAddressId) {
    return NextResponse.json({ error: "A delivery address is required to place an order." }, { status: 400 })
  }
  if (placeOrder && !(file instanceof File)) {
    return NextResponse.json({ error: "A Gerber file is required to place an order." }, { status: 400 })
  }

  let savedFile: SavedOrderFile | null = null
  if (file instanceof File && file.size > 0) {
    try {
      savedFile = await saveOrderFile(file)
    } catch (err) {
      return NextResponse.json({ error: err instanceof Error ? err.message : "Could not save Gerber file." }, { status: 400 })
    }
  }

  // Snapshot the chosen addresses now — Address rows are editable/deletable
  // by the customer, so a live foreign key would let a placed order's
  // shipping details silently change or break later.
  const deliveryAddress = await loadAddressSnapshot(userId, deliveryAddressId, "DELIVERY")
  if (deliveryAddress === undefined) {
    return NextResponse.json({ error: "Invalid delivery address." }, { status: 400 })
  }
  const billingAddress = await loadAddressSnapshot(userId, billingAddressId, "BILLING")
  if (billingAddress === undefined) {
    return NextResponse.json({ error: "Invalid billing address." }, { status: 400 })
  }

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
      express,
      deliveryFormat: resolvedDeliveryFormat,
    },
    rates
  )

  const order = await db.$transaction(async (tx) => {
    const reference = await generateOrderReference(tx)
    const created = await tx.order.create({
      data: {
        reference,
        userId,
        status: placeOrder ? "PENDING_REVIEW" : "QUOTE",
        deliveryFormat: resolvedDeliveryFormat,
        fileName: savedFile?.name ?? null,
        gerberFilePath: savedFile?.path ?? null,
        gerberFileType: savedFile?.type ?? null,
        gerberFileSize: savedFile?.size ?? null,
        widthMm,
        heightMm,
        layers: String(layers),
        qty: Number(qty) || 1,
        finish,
        color,
        copperWeight,
        thickness,
        express,
        priceBreakdown: breakdown as unknown as Prisma.InputJsonValue,
        total: breakdown.total,
        deliveryAddress: deliveryAddress as unknown as Prisma.InputJsonValue,
        billingAddress: billingAddress as unknown as Prisma.InputJsonValue,
      },
    })
    await tx.messageThread.create({
      data: { type: "ORDER", orderId: created.id, createdById: userId },
    })
    return created
  })

  return NextResponse.json(order, { status: 201 })
}
