import { NextResponse } from "next/server"
import { db } from "@/lib/db"
import { verifyWebhookSignature } from "@/lib/razorpay"
import { markOrderPaid, markShopOrderPaid } from "@/lib/payments"

// No session auth — this is Razorpay calling us, authenticated only by the
// HMAC signature. Reliability fallback for the client-side verify routes:
// if a customer pays and closes the tab before the browser can POST to
// /payment/verify, this webhook is what still marks the order paid.
// Must be verified against the *raw* request body, before JSON.parse.
export async function POST(req: Request) {
  const rawBody = await req.text()
  const signature = req.headers.get("x-razorpay-signature")
  if (!signature || !verifyWebhookSignature(rawBody, signature)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 })
  }

  const event = JSON.parse(rawBody)
  if (event.event !== "payment.captured") {
    return NextResponse.json({ ok: true }) // ignore events we don't act on
  }

  const payment = event.payload?.payment?.entity
  const razorpayOrderId: string | undefined = payment?.order_id
  const razorpayPaymentId: string | undefined = payment?.id
  if (!razorpayOrderId || !razorpayPaymentId) {
    return NextResponse.json({ ok: true })
  }

  // razorpayOrderId could belong to either a PCB order or a Shop order —
  // there's no way to tell from the payload alone, so check both.
  const pcbOrder = await db.order.findUnique({ where: { razorpayOrderId } })
  if (pcbOrder) {
    await markOrderPaid(pcbOrder.id, razorpayPaymentId)
    return NextResponse.json({ ok: true })
  }

  const shopOrder = await db.shopOrder.findUnique({ where: { razorpayOrderId } })
  if (shopOrder) {
    await markShopOrderPaid(shopOrder.id, razorpayPaymentId)
    return NextResponse.json({ ok: true })
  }

  return NextResponse.json({ ok: true })
}
