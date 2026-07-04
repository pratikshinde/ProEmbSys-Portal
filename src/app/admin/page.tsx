import Link from "next/link"
import { db } from "@/lib/db"

export default async function AdminDashboardPage() {
  const [totalOrders, pendingReview, totalUsers] = await Promise.all([
    db.order.count(),
    db.order.count({ where: { status: "PENDING_REVIEW" } }),
    db.user.count(),
  ])

  const stats = [
    { label: "Total orders", value: totalOrders },
    { label: "Awaiting review", value: pendingReview },
    { label: "Registered users", value: totalUsers },
  ]

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-bold text-foreground">Dashboard</h1>
      <div className="grid grid-cols-3 gap-4">
        {stats.map((s) => (
          <div key={s.label} className="rounded-lg border border-border bg-card p-5">
            <div className="text-sm text-muted-foreground">{s.label}</div>
            <div className="mt-1 text-3xl font-bold text-foreground">{s.value}</div>
          </div>
        ))}
      </div>
      <div className="flex gap-4">
        <Link href="/admin/orders" className="text-primary hover:underline">
          View all orders &rarr;
        </Link>
      </div>
    </div>
  )
}
