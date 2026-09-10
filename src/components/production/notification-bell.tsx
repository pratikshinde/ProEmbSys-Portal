"use client"

import { useEffect, useRef, useState } from "react"
import Link from "next/link"
import { Bell } from "lucide-react"

interface Item {
  id: string
  title: string
  body: string
  deeplink: string
  read: boolean
  createdAt: string
}

export function NotificationBell() {
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<Item[]>([])
  const [unread, setUnread] = useState(0)
  const [loaded, setLoaded] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  async function load() {
    try {
      const res = await fetch("/api/production/notifications")
      if (!res.ok) return
      const data = (await res.json()) as { items?: Item[]; unread?: number }
      setItems(data.items || [])
      setUnread(data.unread || 0)
    } catch {
      /* ignore */
    } finally {
      setLoaded(true)
    }
  }

  useEffect(() => {
    load()
    const t = setInterval(() => load(), 60000)
    return () => clearInterval(t)
  }, [])

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
        className="relative flex h-10 w-10 items-center justify-center rounded-lg border border-white/10 bg-white/5 text-slate-200"
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
        <div className="absolute right-0 z-50 mt-2 w-80 max-w-[85vw] overflow-hidden rounded-xl border border-white/10 bg-[#0b1a2e] shadow-2xl">
          <div className="border-b border-white/10 px-4 py-2.5 text-sm font-semibold text-white">
            Notifications
          </div>
          <div className="max-h-96 overflow-y-auto">
            {items.length === 0 ? (
              <p className="px-4 py-6 text-center text-sm text-slate-500">
                {loaded ? "Nothing yet" : "Loading…"}
              </p>
            ) : (
              items.map((n) => (
                <Link
                  key={n.id}
                  href={n.deeplink}
                  onClick={() => setOpen(false)}
                  className={`block border-b border-white/5 px-4 py-3 transition hover:bg-white/5 ${
                    n.read ? "" : "bg-sky-500/5"
                  }`}
                >
                  <p className="text-sm font-semibold text-white">{n.title}</p>
                  <p className="text-xs text-slate-400">{n.body}</p>
                  <p className="mt-0.5 text-[11px] text-slate-600">
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
