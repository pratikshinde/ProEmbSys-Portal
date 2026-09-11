import { redirect } from "next/navigation"
import Link from "next/link"
import { auth } from "@/lib/auth"
import { Navbar } from "@/components/portal-main"

// One shared header across the whole site — /admin/** is not a separate app,
// just a set of pages behind the same login. Navbar (portal-main.tsx) already
// carries the logo, the main nav, the notification bell, and the account menu
// for every other page (Home, /orders, /account, /fab-capabilities); admin
// pages use the exact same component instead of their own look, and only add
// a slim second row underneath for the admin-only section links.
const ADMIN_LINKS: { href: string; label: string; adminOnly?: boolean }[] = [
  { href: "/admin", label: "Dashboard" },
  { href: "/admin/orders", label: "Orders" },
  { href: "/admin/production", label: "Production" },
  { href: "/admin/cam-jobs", label: "CAM Jobs" },
  { href: "/admin/shop-orders", label: "Shop Orders" },
  { href: "/admin/blog", label: "Blog" },
  { href: "/admin/products", label: "Products" },
  { href: "/admin/testimonials", label: "Testimonials" },
  { href: "/admin/dfm-templates", label: "DFM" },
  { href: "/admin/panel-templates", label: "Panel Templates" },
  { href: "/admin/team", label: "Team", adminOnly: true },
  { href: "/admin/pricing", label: "Pricing", adminOnly: true },
]

// Coarse "must be logged in" gating for /admin/** already happens in
// middleware.ts (Edge-safe, JWT-only check). This layout is the second,
// DB-aware layer of defense — never rely on middleware alone for authorization.
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await auth()
  if (!session?.user) redirect("/login?callbackUrl=/admin")
  if (session.user.role !== "ADMIN" && session.user.role !== "ENGINEER") redirect("/")

  return (
    <div className="min-h-screen bg-background">
      <Navbar />
      <div className="border-b border-border bg-card">
        <nav className="mx-auto flex max-w-5xl flex-wrap gap-x-5 gap-y-2 px-6 py-3 text-sm">
          {ADMIN_LINKS.filter((l) => !l.adminOnly || session.user.role === "ADMIN").map((l) => (
            <Link key={l.href} href={l.href} className="text-muted-foreground hover:text-primary">
              {l.label}
            </Link>
          ))}
        </nav>
      </div>
      <main className="mx-auto max-w-5xl px-6 py-8">{children}</main>
    </div>
  )
}
