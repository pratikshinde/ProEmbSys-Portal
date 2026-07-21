import { NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { db } from "@/lib/db"
import { verifyPaymentSignature } from "@/lib/razorpay"
import { markShopOrderPaid } from "@/lib/payments"

// Mirrors POST /api/orders/[id]/payment/verify for Shop purchases. Fast
// path for marking a ShopOrder paid — POST /api/webhooks/razorpay is the
// reliability fallback.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const shopOrder = await db.shopOrder.findUnique({ where: { id } })
  if (!shopOrder) return NextResponse.json({ error: "Not found" }, { status: 404 })
  if (shopOrder.userId !== session.user.id) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = await req.json()
  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
    return NextResponse.json({ error: "Missing payment details." }, { status: 400 })
  }
  if (shopOrder.razorpayOrderId !== razorpay_order_id) {
    return NextResponse.json({ error: "Payment does not match this order." }, { status: 400 })
  }
  if (!verifyPaymentSignature(razorpay_order_id, razorpay_payment_id, razorpay_signature)) {
    return NextResponse.json({ error: "Payment could not be verified." }, { status: 400 })
  }

  await markShopOrderPaid(shopOrder.id, razorpay_payment_id)

  const updated = await db.shopOrder.findUnique({ where: { id }, include: { items: true } })
  return NextResponse.json(updated)
}
