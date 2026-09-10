"use client"

import { useEffect } from "react"
import { useRouter } from "next/navigation"

/** Soft-refreshes the server components on this route on an interval, so a
 *  server-rendered list (e.g. /admin/production) tracks operator progress live
 *  without a manual reload. Keeps client state; no loading flash. */
export function AutoRefresh({ seconds = 15 }: { seconds?: number }) {
  const router = useRouter()
  useEffect(() => {
    const t = setInterval(() => router.refresh(), seconds * 1000)
    return () => clearInterval(t)
  }, [router, seconds])
  return null
}
