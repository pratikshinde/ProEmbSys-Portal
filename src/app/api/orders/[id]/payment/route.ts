import { NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { db } from "@/lib/db"
import { createRazorpayOrder } from "@/lib/razorpay"

// Owner-only. Creates a fresh Razorpay order for this PCB order's total and
// returns what the client needs to open Razorpay Checkout. Only callable
// once staff have moved the order to AWAITING_PAYMENT (see PATCH
// /api/orders/[id]) — payment happens after DRC review, not at placement.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const order = await db.order.findUnique({ where: { id } })
  if (!order) return NextResponse.json({ error: "Not found" }, { status: 404 })
  if (order.userId !== session.user.id) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  if (order.status !== "AWAITING_PAYMENT") {
    return NextResponse.json({ error: "This order is not awaiting payment." }, { status: 400 })
  }

  let razorpayOrder
  try {
    razorpayOrder = await createRazorpayOrder(Number(order.total), order.reference)
  } catch {
    return NextResponse.json({ error: "Could not start payment. Please try again shortly." }, { status: 502 })
  }

  await db.order.update({ where: { id }, data: { razorpayOrderId: razorpayOrder.id } })

  return NextResponse.json({
    razorpayOrderId: razorpayOrder.id,
    amount: razorpayOrder.amount,
    currency: razorpayOrder.currency,
    keyId: process.env.RAZORPAY_KEY_ID,
    name: "ProPCB",
    description: order.reference,
    prefill: { name: session.user.name ?? undefined, email: session.user.email ?? undefined },
  })
}
