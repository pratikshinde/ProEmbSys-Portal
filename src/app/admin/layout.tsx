import { redirect } from "next/navigation"
import Link from "next/link"
import { auth } from "@/lib/auth"

// Coarse "must be logged in" gating for /admin/** already happens in
// middleware.ts (Edge-safe, JWT-only check). This layout is the second,
// DB-aware layer of defense — never rely on middleware alone for authorization.
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await auth()
  if (!session?.user) redirect("/login?callbackUrl=/admin")
  if (session.user.role !== "ADMIN" && session.user.role !== "ENGINEER") redirect("/")

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex max-w-5xl items-center gap-6 px-6 py-4">
          <Link href="/admin" className="font-bold text-foreground">
            ProPCB <span className="text-primary">Admin</span>
          </Link>
          <nav className="flex gap-4 text-sm">
            <Link href="/admin/orders" className="text-muted-foreground hover:text-primary">
              Orders
            </Link>
            <Link href="/admin/shop-orders" className="text-muted-foreground hover:text-primary">
              Shop Orders
            </Link>
            <Link href="/admin/blog" className="text-muted-foreground hover:text-primary">
              Blog
            </Link>
            <Link href="/admin/products" className="text-muted-foreground hover:text-primary">
              Products
            </Link>
            <Link href="/admin/testimonials" className="text-muted-foreground hover:text-primary">
              Testimonials
            </Link>
            <Link href="/admin/dfm-templates" className="text-muted-foreground hover:text-primary">
              DFM
            </Link>
            {session.user.role === "ADMIN" && (
              <>
                <Link href="/admin/team" className="text-muted-foreground hover:text-primary">
                  Team
                </Link>
                <Link href="/admin/pricing" className="text-muted-foreground hover:text-primary">
                  Pricing
                </Link>
              </>
            )}
          </nav>
          <Link href="/" className="ml-auto text-sm text-muted-foreground hover:text-primary">
            &larr; Back to site
          </Link>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-6 py-8">{children}</main>
    </div>
  )
}
