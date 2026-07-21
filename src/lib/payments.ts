import { db } from "@/lib/db"

/**
 * Marks a PCB fabrication Order as paid and advances it into production.
 * Idempotent by design — the `status: "AWAITING_PAYMENT"` guard in the
 * `where` clause means a second call (e.g. once from the client's post-
 * checkout verify request, once from the Razorpay webhook landing shortly
 * after) is a safe no-op instead of a double-transition or an error.
 * Returns true if this call was the one that actually marked it paid.
 */
export async function markOrderPaid(orderId: string, paymentId: string): Promise<boolean> {
  const result = await db.order.updateMany({
    where: { id: orderId, status: "AWAITING_PAYMENT" },
    data: { status: "IN_PRODUCTION", razorpayPaymentId: paymentId, paidAt: new Date() },
  })
  return result.count > 0
}

/** Same idea as markOrderPaid, for Shop purchases. */
export async function markShopOrderPaid(shopOrderId: string, paymentId: string): Promise<boolean> {
  const result = await db.shopOrder.updateMany({
    where: { id: shopOrderId, status: "PENDING_PAYMENT" },
    data: { status: "PAID", razorpayPaymentId: paymentId, paidAt: new Date() },
  })
  return result.count > 0
}
