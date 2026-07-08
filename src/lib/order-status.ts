// Shared, human-readable presentation for OrderStatus enum values — same
// pattern as SOLDER_MASK_SWATCH. Raw enum strings (PENDING_REVIEW etc.) must
// never be shown to users; every status display goes through this map.

export type OrderStatusKey =
  | "QUOTE"
  | "PENDING_REVIEW"
  | "AWAITING_PAYMENT"
  | "IN_PRODUCTION"
  | "SHIPPED"
  | "COMPLETED"
  | "CANCELLED"

export const ORDER_STATUS_META: Record<OrderStatusKey, { label: string; bg: string; text: string }> = {
  QUOTE: { label: "Saved quote", bg: "rgba(148,163,184,0.15)", text: "#94a3b8" },
  PENDING_REVIEW: { label: "Under review", bg: "rgba(59,130,246,0.15)", text: "#60a5fa" },
  AWAITING_PAYMENT: { label: "Awaiting payment", bg: "rgba(245,158,11,0.15)", text: "#fbbf24" },
  IN_PRODUCTION: { label: "In production", bg: "rgba(139,92,246,0.15)", text: "#a78bfa" },
  SHIPPED: { label: "Shipped", bg: "rgba(6,182,212,0.15)", text: "#22d3ee" },
  COMPLETED: { label: "Completed", bg: "rgba(34,197,94,0.15)", text: "#4ade80" },
  CANCELLED: { label: "Cancelled", bg: "rgba(239,68,68,0.15)", text: "#f87171" },
}

export function orderStatusMeta(status: string) {
  return (
    ORDER_STATUS_META[status as OrderStatusKey] ?? {
      label: status,
      bg: "rgba(148,163,184,0.15)",
      text: "#94a3b8",
    }
  )
}

// The happy-path pipeline, in order, for the order-detail timeline.
// QUOTE (not yet an order) and CANCELLED (off-track) are not stages.
export const ORDER_PIPELINE: { status: OrderStatusKey; label: string }[] = [
  { status: "PENDING_REVIEW", label: "Review" },
  { status: "AWAITING_PAYMENT", label: "Payment" },
  { status: "IN_PRODUCTION", label: "Production" },
  { status: "SHIPPED", label: "Shipped" },
  { status: "COMPLETED", label: "Delivered" },
]

// Index of the current stage in ORDER_PIPELINE, or -1 if the status isn't on
// the pipeline (QUOTE / CANCELLED / unknown).
export function orderPipelineIndex(status: string): number {
  return ORDER_PIPELINE.findIndex((s) => s.status === status)
}
