import Link from "next/link"
import { db } from "@/lib/db"

export default async function AdminDashboardPage() {
  const [totalOrders, pendingReview, totalUsers, totalStaff, totalBlogPosts, totalProducts, totalTestimonials] = await Promise.all([
    db.order.count(),
    db.order.count({ where: { status: "PENDING_REVIEW" } }),
    db.user.count(),
    db.user.count({ where: { role: { in: ["ADMIN", "ENGINEER"] }, isActive: true } }),
    db.blogPost.count(),
    db.product.count(),
    db.testimonial.count(),
  ])

  const stats: { label: string; value: number; href?: string }[] = [
    { label: "Total orders", value: totalOrders, href: "/admin/orders" },
    { label: "Awaiting review", value: pendingReview, href: "/admin/orders?status=PENDING_REVIEW" },
    { label: "Registered users", value: totalUsers },
  ]

  const quickLinks = [
    { href: "/admin/orders", label: "Orders", count: totalOrders },
    { href: "/admin/team", label: "Team", count: totalStaff },
    { href: "/admin/blog", label: "Blog Posts", count: totalBlogPosts },
    { href: "/admin/products", label: "Shop Products", count: totalProducts },
    { href: "/admin/testimonials", label: "Testimonials", count: totalTestimonials },
  ]

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-bold text-foreground">Dashboard</h1>
      <div className="grid grid-cols-3 gap-4">
        {stats.map((s) =>
          s.href ? (
            <Link key={s.label} href={s.href} className="rounded-lg border border-border bg-card p-5 transition-colors hover:border-primary">
              <div className="text-sm text-muted-foreground">{s.label}</div>
              <div className="mt-1 text-3xl font-bold text-foreground">{s.value}</div>
            </Link>
          ) : (
            <div key={s.label} className="rounded-lg border border-border bg-card p-5">
              <div className="text-sm text-muted-foreground">{s.label}</div>
              <div className="mt-1 text-3xl font-bold text-foreground">{s.value}</div>
            </div>
          )
        )}
      </div>
      <div className="grid grid-cols-3 gap-3">
        {quickLinks.map((l) => (
          <Link
            key={l.href}
            href={l.href}
            className="flex items-center justify-between rounded-lg border border-border bg-card p-4 hover:border-primary"
          >
            <span className="text-sm font-medium text-foreground">{l.label}</span>
            <span className="text-sm text-muted-foreground">{l.count}</span>
          </Link>
        ))}
      </div>
    </div>
  )
}
