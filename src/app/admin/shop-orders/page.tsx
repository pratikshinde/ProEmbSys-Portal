import { db } from "@/lib/db"
import ShopOrderStatusControl from "@/components/admin/shop-order-status-control"

// Mirrors /admin/orders's list page structure, scoped down — Shop orders
// don't have a DRC-review pipeline, so a single list with an inline status
// control (no separate detail page) is enough for v1.
export default async function AdminShopOrdersPage() {
  const shopOrders = await db.shopOrder.findMany({
    include: { user: { select: { name: true, email: true } }, items: true },
    orderBy: { createdAt: "desc" },
  })

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-bold text-foreground">Shop Orders</h1>

      {shopOrders.length === 0 ? (
        <p className="text-muted-foreground">No shop orders yet.</p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted">
              <tr>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">Reference</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">Customer</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">Items</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">Placed</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">Status</th>
                <th className="px-4 py-3 text-right font-medium text-muted-foreground">Total</th>
              </tr>
            </thead>
            <tbody>
              {shopOrders.map((order) => (
                <tr key={order.id} className="border-t border-border">
                  <td className="px-4 py-3 font-medium text-foreground">{order.reference}</td>
                  <td className="px-4 py-3 text-foreground">{order.user.name || order.user.email}</td>
                  <td className="px-4 py-3 text-foreground">
                    {order.items.map((i) => `${i.name} ×${i.qty}`).join(", ")}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {order.createdAt.toLocaleDateString("en-IN", { dateStyle: "medium", timeZone: "Asia/Kolkata" })}
                  </td>
                  <td className="px-4 py-3">
                    <ShopOrderStatusControl shopOrderId={order.id} currentStatus={order.status} />
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
