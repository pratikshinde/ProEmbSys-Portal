// Shared, human-readable presentation for ShopOrderStatus enum values — same
// pattern as order-status.ts's ORDER_STATUS_META. Raw enum strings must
// never be shown to users.

export type ShopOrderStatusKey = "PENDING_PAYMENT" | "PAID" | "SHIPPED" | "COMPLETED" | "CANCELLED"

export const SHOP_ORDER_STATUS_META: Record<ShopOrderStatusKey, { label: string; bg: string; text: string }> = {
  PENDING_PAYMENT: { label: "Pending payment", bg: "rgba(245,158,11,0.15)", text: "#fbbf24" },
  PAID: { label: "Paid", bg: "rgba(34,197,94,0.15)", text: "#4ade80" },
  SHIPPED: { label: "Shipped", bg: "rgba(6,182,212,0.15)", text: "#22d3ee" },
  COMPLETED: { label: "Completed", bg: "rgba(139,92,246,0.15)", text: "#a78bfa" },
  CANCELLED: { label: "Cancelled", bg: "rgba(239,68,68,0.15)", text: "#f87171" },
}

export function shopOrderStatusMeta(status: string) {
  return (
    SHOP_ORDER_STATUS_META[status as ShopOrderStatusKey] ?? {
      label: status,
      bg: "rgba(148,163,184,0.15)",
      text: "#94a3b8",
    }
  )
}
