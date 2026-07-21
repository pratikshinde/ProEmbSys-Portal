import { NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { db } from "@/lib/db"
import { verifyPaymentSignature } from "@/lib/razorpay"
import { markOrderPaid } from "@/lib/payments"

// Owner-only. Called by the client once Razorpay Checkout's success handler
// fires. This is the fast path for marking an order paid — the webhook
// (POST /api/webhooks/razorpay) is the reliability fallback in case the
// customer closes the tab before this request completes.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const order = await db.order.findUnique({ where: { id } })
  if (!order) return NextResponse.json({ error: "Not found" }, { status: 404 })
  if (order.userId !== session.user.id) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = await req.json()
  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
    return NextResponse.json({ error: "Missing payment details." }, { status: 400 })
  }
  if (order.razorpayOrderId !== razorpay_order_id) {
    return NextResponse.json({ error: "Payment does not match this order." }, { status: 400 })
  }
  if (!verifyPaymentSignature(razorpay_order_id, razorpay_payment_id, razorpay_signature)) {
    return NextResponse.json({ error: "Payment could not be verified." }, { status: 400 })
  }

  await markOrderPaid(order.id, razorpay_payment_id)

  const updated = await db.order.findUnique({ where: { id } })
  return NextResponse.json(updated)
}
