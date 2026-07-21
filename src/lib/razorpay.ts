import Razorpay from "razorpay"
import crypto from "crypto"

// Lazily constructed — same reasoning as getResendClient() in email.ts: building
// the client eagerly at module scope would run at next build's route-data
// collection time (every route module gets imported then, even ones never
// called), and a missing/placeholder key shouldn't break the build.
function getRazorpayClient() {
  return new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID ?? "",
    key_secret: process.env.RAZORPAY_KEY_SECRET ?? "",
  })
}

/** amountRupees is a plain rupee amount (e.g. from an Order.total Decimal) —
 *  Razorpay's API takes the amount in the smallest currency subunit (paise). */
export async function createRazorpayOrder(amountRupees: number, receipt: string) {
  const client = getRazorpayClient()
  return client.orders.create({
    amount: Math.round(amountRupees * 100),
    currency: "INR",
    receipt,
  })
}

/** Verifies the signature Razorpay Checkout hands back to the client on
 *  successful payment (razorpay_order_id + razorpay_payment_id + razorpay_signature).
 *  Per Razorpay's docs: HMAC-SHA256 of "{order_id}|{payment_id}" keyed by the
 *  account's key secret. */
export function verifyPaymentSignature(orderId: string, paymentId: string, signature: string): boolean {
  const expected = crypto
    .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET ?? "")
    .update(`${orderId}|${paymentId}`)
    .digest("hex")
  return expected === signature
}

/** Verifies the `X-Razorpay-Signature` header on an incoming webhook request.
 *  Must be checked against the *raw* request body text, before JSON.parse. */
export function verifyWebhookSignature(rawBody: string, signature: string): boolean {
  const expected = crypto
    .createHmac("sha256", process.env.RAZORPAY_WEBHOOK_SECRET ?? "")
    .update(rawBody)
    .digest("hex")
  return expected === signature
}
