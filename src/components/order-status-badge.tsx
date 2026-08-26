import { orderStatusMeta } from "@/lib/order-status"
import { StatusBadge } from "@/components/status-badge"

// The only sanctioned way to render an order status to users (customer +
// admin surfaces). Thin wrapper over the shared StatusBadge primitive.
export function OrderStatusBadge({ status, className = "" }: { status: string; className?: string }) {
  const meta = orderStatusMeta(status)
  return <StatusBadge label={meta.label} bg={meta.bg} text={meta.text} className={className} />
}
