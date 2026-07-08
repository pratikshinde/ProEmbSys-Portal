import { redirect } from "next/navigation"
import Link from "next/link"
import { auth } from "@/lib/auth"
import { db } from "@/lib/db"
import { Navbar } from "@/components/portal-main"
import { OrderStatusBadge } from "@/components/order-status-badge"

export default async function OrdersListPage() {
  const session = await auth()
  if (!session?.user) redirect("/login?callbackUrl=/orders")

  const orders = await db.order.findMany({
    where: { userId: session.user.id },
    orderBy: { createdAt: "desc" },
  })

  return (
    <div className="min-h-screen bg-background">
      <Navbar />
      <div className="mx-auto max-w-3xl px-6 py-12">
        <h1 className="mb-6 text-2xl font-bold text-foreground">My Orders</h1>
        {orders.length === 0 ? (
          <div className="flex flex-col items-start gap-4 rounded-lg border border-border bg-card p-8">
            <p className="text-muted-foreground">You haven&apos;t placed any orders yet.</p>
            <Link
              href="/?page=order"
              className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90"
            >
              Order your first board →
            </Link>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {orders.map((order) => (
              <Link
                key={order.id}
                href={`/orders/${order.id}`}
                className="block rounded-lg border border-border bg-card p-4 transition-colors hover:border-primary"
              >
                <div className="flex items-center justify-between">
                  <div>
                    <div className="font-semibold text-foreground">{order.reference}</div>
                    <div className="text-sm text-muted-foreground">
                      {order.widthMm.toString()} × {order.heightMm.toString()} mm · {order.layers} layers · qty {order.qty}
                    </div>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      Placed on{" "}
                      {order.createdAt.toLocaleDateString("en-IN", { dateStyle: "medium", timeZone: "Asia/Kolkata" })}
                    </div>
                  </div>
                  <div className="flex flex-col items-end gap-1 text-right">
                    <div className="font-semibold text-foreground">₹{Number(order.total).toLocaleString()}</div>
                    <OrderStatusBadge status={order.status} />
                  </div>
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
