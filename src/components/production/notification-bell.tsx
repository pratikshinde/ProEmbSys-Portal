"use client"

import { useEffect, useRef, useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { Bell } from "lucide-react"
import { toast } from "@/hooks/use-toast"
import { ToastAction } from "@/components/ui/toast"

interface Item {
  id: string
  title: string
  body: string
  deeplink: string
  read: boolean
  createdAt: string
}

// Two chromes: the operator app is a hardcoded dark shell (theme tokens there
// don't resolve to dark), the admin area is theme-aware.
const TONE = {
  operator: {
    button: "border-white/10 bg-white/5 text-slate-200",
    panel: "border-white/10 bg-[#0b1a2e]",
    headerBorder: "border-white/10",
    headerText: "text-white",
    empty: "text-slate-500",
    itemBorder: "border-white/5",
    itemHover: "hover:bg-white/5",
    unread: "bg-sky-500/5",
    title: "text-white",
    body: "text-slate-400",
    time: "text-slate-600",
  },
  admin: {
    button: "border-border bg-card text-foreground hover:bg-muted",
    panel: "border-border bg-popover",
    headerBorder: "border-border",
    headerText: "text-foreground",
    empty: "text-muted-foreground",
    itemBorder: "border-border",
    itemHover: "hover:bg-muted",
    unread: "bg-primary/5",
    title: "text-foreground",
    body: "text-muted-foreground",
    time: "text-muted-foreground",
  },
} as const

export function NotificationBell({ variant = "operator" }: { variant?: "operator" | "admin" }) {
  const router = useRouter()
  const t = TONE[variant]
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<Item[]>([])
  const [unread, setUnread] = useState(0)
  const [loaded, setLoaded] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const seenIds = useRef<Set<string>>(new Set())
  const initialLoaded = useRef(false)

  async function load() {
    try {
      const res = await fetch("/api/production/notifications")
      if (!res.ok) return
      const data = (await res.json()) as { items?: Item[]; unread?: number }
      const newItems = data.items || []

      const freshUnread = newItems.filter((i) => !i.read && !seenIds.current.has(i.id))
      if (initialLoaded.current) {
        for (const n of freshUnread) {
          toast({
            title: n.title,
            description: n.body,
            action: n.deeplink ? (
              <ToastAction altText="View" onClick={() => router.push(n.deeplink)}>
                View
              </ToastAction>
            ) : undefined,
          })
        }
      } else {
        const twoMinAgo = Date.now() - 2 * 60 * 1000
        for (const n of freshUnread) {
          if (new Date(n.createdAt).getTime() > twoMinAgo) {
            toast({
              title: n.title,
              description: n.body,
              action: n.deeplink ? (
                <ToastAction altText="View" onClick={() => router.push(n.deeplink)}>
                  View
                </ToastAction>
              ) : undefined,
            })
          }
        }
      }

      for (const n of newItems) {
        seenIds.current.add(n.id)
      }
      initialLoaded.current = true

      setItems(newItems)
      setUnread(data.unread || 0)
    } catch {
      /* ignore */
    } finally {
      setLoaded(true)
    }
  }

  useEffect(() => {
    load()
    // Poll every 6 seconds for admin, 15 seconds for operator
    const every = variant === "admin" ? 6000 : 15000
    const timer = setInterval(() => load(), every)
    return () => clearInterval(timer)
  }, [variant])

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener("mousedown", onDoc)
    return () => document.removeEventListener("mousedown", onDoc)
  }, [])

  async function toggle() {
    const next = !open
    setOpen(next)
    if (next && unread > 0) {
      setUnread(0)
      setItems((prev) => prev.map((i) => ({ ...i, read: true })))
      await fetch("/api/production/notifications/read", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ all: true }),
      }).catch(() => {})
    }
  }

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={toggle}
        className={`relative flex h-10 w-10 items-center justify-center rounded-lg border ${t.button}`}
        aria-label="Notifications"
      >
        <Bell className="h-5 w-5" />
        {unread > 0 && (
          <span className="absolute -right-1 -top-1 flex h-5 min-w-[20px] items-center justify-center rounded-full bg-rose-500 px-1 text-[11px] font-bold text-white">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>

      {open && (
        <div className={`absolute right-0 z-50 mt-2 w-80 max-w-[85vw] overflow-hidden rounded-xl border shadow-2xl ${t.panel}`}>
          <div className={`border-b px-4 py-2.5 text-sm font-semibold ${t.headerBorder} ${t.headerText}`}>
            Notifications
          </div>
          <div className="max-h-96 overflow-y-auto">
            {items.length === 0 ? (
              <p className={`px-4 py-6 text-center text-sm ${t.empty}`}>
                {loaded ? "Nothing yet" : "Loading…"}
              </p>
            ) : (
              items.map((n) => (
                <Link
                  key={n.id}
                  href={n.deeplink}
                  onClick={() => setOpen(false)}
                  className={`block border-b px-4 py-3 transition ${t.itemBorder} ${t.itemHover} ${
                    n.read ? "" : t.unread
                  }`}
                >
                  <p className={`text-sm font-semibold ${t.title}`}>{n.title}</p>
                  <p className={`text-xs ${t.body}`}>{n.body}</p>
                  <p className={`mt-0.5 text-[11px] ${t.time}`}>
                    {new Date(n.createdAt).toLocaleString("en-IN", {
                      day: "numeric",
                      month: "short",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </p>
                </Link>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  )
}
