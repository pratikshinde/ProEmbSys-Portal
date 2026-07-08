import Link from "next/link"
import { db } from "@/lib/db"
import { OrderStatusBadge } from "@/components/order-status-badge"
import { ORDER_STATUS_META, type OrderStatusKey } from "@/lib/order-status"

const FILTERS: { key: string; label: string }[] = [
  { key: "ALL", label: "All" },
  ...Object.entries(ORDER_STATUS_META).map(([key, meta]) => ({ key, label: meta.label })),
]

export default async function AdminOrdersPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>
}) {
  const { status } = await searchParams
  const activeFilter = status && status in ORDER_STATUS_META ? (status as OrderStatusKey) : undefined

  const orders = await db.order.findMany({
    where: activeFilter ? { status: activeFilter } : undefined,
    include: { user: { select: { name: true, email: true } } },
    orderBy: { createdAt: "desc" },
  })

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-bold text-foreground">Orders</h1>

      <div className="flex flex-wrap gap-2">
        {FILTERS.map((f) => {
          const isActive = f.key === "ALL" ? !activeFilter : activeFilter === f.key
          return (
            <Link
              key={f.key}
              href={f.key === "ALL" ? "/admin/orders" : `/admin/orders?status=${f.key}`}
              className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                isActive
                  ? "border-primary bg-primary/15 text-primary"
                  : "border-border text-muted-foreground hover:border-primary/50 hover:text-foreground"
              }`}
            >
              {f.label}
            </Link>
          )
        })}
      </div>

      {orders.length === 0 ? (
        <p className="text-muted-foreground">
          {activeFilter ? `No “${ORDER_STATUS_META[activeFilter].label}” orders.` : "No orders yet."}
        </p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted">
              <tr>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">Reference</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">Customer</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">Board</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">Placed</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">Status</th>
                <th className="px-4 py-3 text-right font-medium text-muted-foreground">Total</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((order) => (
                <tr key={order.id} className="border-t border-border hover:bg-muted/50">
                  <td className="px-4 py-3">
                    <Link href={`/admin/orders/${order.id}`} className="font-medium text-primary hover:underline">
                      {order.reference}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-foreground">{order.user.name || order.user.email}</td>
                  <td className="px-4 py-3 text-foreground">
                    {order.widthMm.toString()}×{order.heightMm.toString()}mm · {order.layers}L · qty {order.qty}
                    {order.deliveryFormat === "PANEL_BY_PROPCB" && (
                      <span className="ml-2 rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-600 dark:text-amber-400">
                        Panelize
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {order.createdAt.toLocaleDateString("en-IN", { dateStyle: "medium", timeZone: "Asia/Kolkata" })}
                  </td>
                  <td className="px-4 py-3">
                    <OrderStatusBadge status={order.status} />
                  </td>
                  <td className="px-4 py-3 text-right font-medium text-foreground">
                    ₹{Number(order.total).toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
