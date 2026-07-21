"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { toast } from "@/hooks/use-toast"
import { SHOP_ORDER_STATUS_META, shopOrderStatusMeta, type ShopOrderStatusKey } from "@/lib/shop-order-status"

const STATUS_OPTIONS = Object.keys(SHOP_ORDER_STATUS_META) as ShopOrderStatusKey[]

// Mirrors order-status-control.tsx for Shop orders.
export default function ShopOrderStatusControl({ shopOrderId, currentStatus }: { shopOrderId: string; currentStatus: string }) {
  const router = useRouter()
  const [status, setStatus] = useState(currentStatus)
  const [saving, setSaving] = useState(false)

  async function handleChange(next: string) {
    setSaving(true)
    const res = await fetch(`/api/shop/orders/${shopOrderId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: next }),
    })
    setSaving(false)
    if (!res.ok) {
      toast({ title: "Could not update status", description: "Please try again." })
      return
    }
    setStatus(next)
    toast({ title: "Order status updated", description: shopOrderStatusMeta(next).label })
    router.refresh()
  }

  return (
    <Select value={status} disabled={saving} onValueChange={handleChange}>
      <SelectTrigger className="w-[160px]">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {STATUS_OPTIONS.map((s) => (
          <SelectItem key={s} value={s}>
            <span className="flex items-center gap-2">
              <span className="h-2 w-2 rounded-full" style={{ backgroundColor: SHOP_ORDER_STATUS_META[s].text }} />
              {SHOP_ORDER_STATUS_META[s].label}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
