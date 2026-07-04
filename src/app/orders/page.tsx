import { redirect } from "next/navigation"
import Link from "next/link"
import { auth } from "@/lib/auth"
import { db } from "@/lib/db"

export default async function OrdersListPage() {
  const session = await auth()
  if (!session?.user) redirect("/login?callbackUrl=/orders")

  const orders = await db.order.findMany({
    where: { userId: session.user.id },
    orderBy: { createdAt: "desc" },
  })

  return (
    <div className="min-h-screen bg-background px-6 py-12">
      <div className="mx-auto max-w-3xl">
        <Link href="/" className="text-sm text-muted-foreground hover:text-primary">
          &larr; Back to ProPCB
        </Link>
        <h1 className="mt-4 mb-6 text-2xl font-bold text-foreground">My Orders</h1>
        {orders.length === 0 ? (
          <p className="text-muted-foreground">You haven&apos;t placed any orders yet.</p>
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
                  </div>
                  <div className="text-right">
                    <div className="font-semibold text-foreground">₹{Number(order.total).toLocaleString()}</div>
                    <div className="text-xs text-muted-foreground">{order.status}</div>
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
