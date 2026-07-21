import { NextResponse } from "next/server"
import { Prisma } from "@prisma/client"
import { auth } from "@/lib/auth"
import { db } from "@/lib/db"
import { loadAddressSnapshot } from "@/lib/address-snapshot"
import { generateOrderReference } from "@/lib/order-reference"
import { createRazorpayOrder } from "@/lib/razorpay"

interface CheckoutItem {
  productId: string
  qty: number
}

// Creates a ShopOrder (+ items) from the cart and starts a Razorpay payment
// for it. Payment happens immediately at checkout for Shop purchases (no
// DRC-equivalent review step, unlike PCB orders). Never trusts client-sent
// prices — the total is recomputed from live Product rows, same principle as
// PCB order creation in src/app/api/orders/route.ts.
export async function POST(req: Request) {
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const userId = session.user.id

  const { items, deliveryAddressId } = (await req.json()) as {
    items?: CheckoutItem[]
    deliveryAddressId?: string
  }

  if (!Array.isArray(items) || items.length === 0) {
    return NextResponse.json({ error: "Cart is empty." }, { status: 400 })
  }
  if (!deliveryAddressId) {
    return NextResponse.json({ error: "A delivery address is required." }, { status: 400 })
  }

  const deliveryAddress = await loadAddressSnapshot(userId, deliveryAddressId, "DELIVERY")
  if (!deliveryAddress) {
    return NextResponse.json({ error: "Invalid delivery address." }, { status: 400 })
  }

  const productIds = items.map((i) => i.productId)
  const products = await db.product.findMany({ where: { id: { in: productIds } } })
  const productsById = new Map(products.map((p) => [p.id, p]))

  const lineItems: { productId: string; name: string; price: Prisma.Decimal; qty: number }[] = []
  for (const item of items) {
    const qty = Math.floor(Number(item.qty))
    if (!Number.isFinite(qty) || qty <= 0) {
      return NextResponse.json({ error: "Invalid item quantity." }, { status: 400 })
    }
    const product = productsById.get(item.productId)
    if (!product || !product.isActive) {
      return NextResponse.json({ error: "One or more items are no longer available." }, { status: 400 })
    }
    if (product.stockStatus === "OUT_OF_STOCK") {
      return NextResponse.json({ error: `${product.name} is out of stock.` }, { status: 400 })
    }
    lineItems.push({ productId: product.id, name: product.name, price: product.price, qty })
  }

  const total = lineItems.reduce((sum, li) => sum + Number(li.price) * li.qty, 0)
  if (total <= 0) {
    return NextResponse.json({ error: "Cart total must be greater than zero." }, { status: 400 })
  }

  const shopOrder = await db.$transaction(async (tx) => {
    const reference = await generateOrderReference(tx, "SHOP")
    const created = await tx.shopOrder.create({
      data: {
        reference,
        userId,
        total,
        deliveryAddress: deliveryAddress as unknown as Prisma.InputJsonValue,
        items: {
          create: lineItems.map((li) => ({
            productId: li.productId,
            name: li.name,
            price: li.price,
            qty: li.qty,
          })),
        },
      },
    })
    return created
  })

  let razorpayOrder
  try {
    razorpayOrder = await createRazorpayOrder(total, shopOrder.reference)
  } catch {
    return NextResponse.json({ error: "Could not start payment. Please try again shortly." }, { status: 502 })
  }

  await db.shopOrder.update({ where: { id: shopOrder.id }, data: { razorpayOrderId: razorpayOrder.id } })

  return NextResponse.json({
    shopOrderId: shopOrder.id,
    reference: shopOrder.reference,
    razorpayOrderId: razorpayOrder.id,
    amount: razorpayOrder.amount,
    currency: razorpayOrder.currency,
    keyId: process.env.RAZORPAY_KEY_ID,
    name: "ProPCB Shop",
    description: shopOrder.reference,
    prefill: { name: session.user.name ?? undefined, email: session.user.email ?? undefined },
  })
}
