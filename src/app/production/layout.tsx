import { redirect } from "next/navigation"
import Link from "next/link"
import { HardHat } from "lucide-react"
import { auth } from "@/lib/auth"
import { canAccessProduction } from "@/lib/roles"
import { NotificationBell } from "@/components/production/notification-bell"
import { SignOutButton } from "@/components/production/sign-out-button"

// The shop-floor operator app. Its own minimal chrome (no marketing navbar) —
// mobile-first, big, dark. Staff can view it too. Gated in middleware.ts;
// this is the DB-aware second layer.
export default async function ProductionLayout({ children }: { children: React.ReactNode }) {
  const session = await auth()
  if (!session?.user) redirect("/operator/login")
  if (!canAccessProduction(session.user.role)) redirect("/")

  return (
    <div className="flex min-h-screen flex-col bg-[#061628] text-slate-100">
      <header className="sticky top-0 z-40 border-b border-white/10 bg-[#0a1f38]/95 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-lg items-center justify-between px-4">
          <Link href="/production" className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-emerald-500/15 text-emerald-400">
              <HardHat className="h-5 w-5" />
            </div>
            <div>
              <div className="text-base font-bold leading-tight text-white">ProPCB Work</div>
              <div className="text-xs font-medium text-emerald-400">Shop floor</div>
            </div>
          </Link>
          <div className="flex items-center gap-2">
            <NotificationBell />
            <SignOutButton />
          </div>
        </div>
      </header>

      <div className="border-b border-white/5 bg-white/[0.02] px-4 py-2 text-sm text-slate-400">
        <div className="mx-auto max-w-lg">
          Signed in as <strong className="text-slate-200">{session.user.name || session.user.email}</strong>
        </div>
      </div>

      <main className="mx-auto w-full max-w-lg flex-1 p-4">{children}</main>
    </div>
  )
}
