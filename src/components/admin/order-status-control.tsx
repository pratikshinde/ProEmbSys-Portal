"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { toast } from "@/hooks/use-toast"
import { ORDER_STATUS_META, orderStatusMeta, type OrderStatusKey } from "@/lib/order-status"

const STATUS_OPTIONS = Object.keys(ORDER_STATUS_META) as OrderStatusKey[]

export default function OrderStatusControl({ orderId, currentStatus }: { orderId: string; currentStatus: string }) {
  const router = useRouter()
  const [status, setStatus] = useState(currentStatus)
  const [saving, setSaving] = useState(false)

  async function handleChange(next: string) {
    setSaving(true)
    const res = await fetch(`/api/orders/${orderId}`, {
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
    toast({ title: "Order status updated", description: orderStatusMeta(next).label })
    router.refresh()
  }

  return (
    <Select value={status} disabled={saving} onValueChange={handleChange}>
      <SelectTrigger className="w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {STATUS_OPTIONS.map((s) => (
          <SelectItem key={s} value={s}>
            <span className="flex items-center gap-2">
              <span className="h-2 w-2 rounded-full" style={{ backgroundColor: ORDER_STATUS_META[s].text }} />
              {ORDER_STATUS_META[s].label}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
