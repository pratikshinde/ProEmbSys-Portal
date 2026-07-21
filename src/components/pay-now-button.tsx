"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "@/hooks/use-toast"
import { loadRazorpayScript } from "@/lib/load-razorpay-script"

export default function PayNowButton({
  orderId,
  amount,
  reference,
}: {
  orderId: string
  amount: number
  reference: string
}) {
  const router = useRouter()
  const [paying, setPaying] = useState(false)

  async function handlePay() {
    setPaying(true)
    try {
      const scriptLoaded = await loadRazorpayScript()
      if (!scriptLoaded) {
        toast({ title: "Could not load payment gateway", description: "Please check your connection and try again." })
        return
      }

      const createRes = await fetch(`/api/orders/${orderId}/payment`, { method: "POST" })
      const created = await createRes.json()
      if (!createRes.ok) {
        toast({ title: "Could not start payment", description: created.error ?? "Please try again." })
        return
      }

      const razorpay = new window.Razorpay({
        key: created.keyId,
        amount: created.amount,
        currency: created.currency,
        name: created.name,
        description: created.description,
        order_id: created.razorpayOrderId,
        prefill: created.prefill,
        handler: async (response: {
          razorpay_order_id: string
          razorpay_payment_id: string
          razorpay_signature: string
        }) => {
          const verifyRes = await fetch(`/api/orders/${orderId}/payment/verify`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(response),
          })
          if (!verifyRes.ok) {
            const err = await verifyRes.json().catch(() => ({}))
            toast({ title: "Payment could not be verified", description: err.error ?? "Please contact us with your payment ID." })
            return
          }
          toast({ title: "Payment received", description: `Order ${reference} is now in production.` })
          router.refresh()
        },
        modal: {
          ondismiss: () => setPaying(false),
        },
      })
      razorpay.open()
    } catch {
      toast({ title: "Something went wrong", description: "Please try again shortly." })
    } finally {
      setPaying(false)
    }
  }

  return (
    <div className="flex items-center justify-between rounded-lg border border-amber-500/30 bg-amber-500/10 p-5">
      <div>
        <div className="text-sm font-semibold text-foreground">Payment required</div>
        <div className="text-sm text-muted-foreground">₹{amount.toLocaleString("en-IN")} due to start production</div>
      </div>
      <button
        onClick={handlePay}
        disabled={paying}
        className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-60"
      >
        {paying ? "Opening payment…" : "Pay Now"}
      </button>
    </div>
  )
}
