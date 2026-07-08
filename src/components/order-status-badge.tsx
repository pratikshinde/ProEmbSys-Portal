import { orderStatusMeta } from "@/lib/order-status"

// Server-safe colored status pill — the only sanctioned way to render an
// order status to users (customer + admin surfaces).
export function OrderStatusBadge({ status, className = "" }: { status: string; className?: string }) {
  const meta = orderStatusMeta(status)
  return (
    <span
      className={`inline-block rounded-md px-2 py-0.5 text-xs font-semibold ${className}`}
      style={{ backgroundColor: meta.bg, color: meta.text }}
    >
      {meta.label}
    </span>
  )
}
