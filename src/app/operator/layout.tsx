import type { Metadata, Viewport } from "next"
import Link from "next/link"
import { HardHat } from "lucide-react"

// Scoped to /operator/** only — Next.js only allows one special app/manifest.ts
// file, which would apply site-wide (see the "PWA install manifest" note in
// CLAUDE.md's production-tracker section). Setting `manifest` per-segment
// metadata instead keeps "Add to Home Screen" giving the operator app its own
// name/icon/standalone display without touching the main site's own tab icon.
export const metadata: Metadata = {
  title: "ProPCB Work",
  manifest: "/operator-manifest.webmanifest",
  icons: {
    icon: "/icons/operator-192.png",
    apple: "/icons/operator-apple-touch-180.png",
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "ProPCB Work",
  },
}

export const viewport: Viewport = {
  themeColor: "#061628",
}

// The operator app's own sign-in / sign-up chrome — dark and mobile-first,
// completely separate from the main site's /login. Public (not gated by
// middleware — /operator/* isn't in the matcher).
export default function OperatorAuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-[#061628] text-slate-100">
      <header className="border-b border-white/10 bg-[#0a1f38]">
        <div className="mx-auto flex h-16 max-w-md items-center gap-2.5 px-4">
          <Link href="/operator/login" className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-emerald-500/15 text-emerald-400">
              <HardHat className="h-5 w-5" />
            </div>
            <div>
              <div className="text-base font-bold leading-tight text-white">ProPCB Work</div>
              <div className="text-xs font-medium text-emerald-400">Shop floor</div>
            </div>
          </Link>
        </div>
      </header>
      <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center p-4">{children}</main>
    </div>
  )
}
