"use client"

import { Suspense, useEffect, useRef, useState } from "react"
import { useSearchParams } from "next/navigation"
import Link from "next/link"
import { Loader2 } from "lucide-react"

type State =
  | { kind: "working" }
  | { kind: "done"; email: string }
  | { kind: "error"; message: string }

function VerifyInner() {
  const token = useSearchParams().get("token")
  const [state, setState] = useState<State>(
    token ? { kind: "working" } : { kind: "error", message: "This confirmation link is missing its token." }
  )
  const ran = useRef(false)

  useEffect(() => {
    if (ran.current || !token) return
    ran.current = true
    fetch("/api/production/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    })
      .then(async (res) => {
        const body = await res.json().catch(() => ({}))
        if (res.ok) setState({ kind: "done", email: body.email })
        else setState({ kind: "error", message: body.error ?? "Could not confirm your email." })
      })
      .catch(() => setState({ kind: "error", message: "Something went wrong. Try the link again." }))
  }, [token])

  return (
    <div className="flex flex-col gap-5">
      {state.kind === "working" && (
        <div className="flex items-center gap-3 text-slate-300">
          <Loader2 className="h-5 w-5 animate-spin text-emerald-400" />
          <span>Confirming your email…</span>
        </div>
      )}
      {state.kind === "done" && (
        <>
          <h1 className="text-2xl font-bold text-white">You&apos;re all set</h1>
          <p className="text-sm text-slate-300">
            <strong className="text-white">{state.email}</strong> is confirmed and your account is active.
          </p>
          <Link
            href="/operator/login?verified=1"
            className="w-fit rounded-xl bg-emerald-500 px-5 py-3 text-base font-bold text-slate-950 active:bg-emerald-400"
          >
            Sign in
          </Link>
        </>
      )}
      {state.kind === "error" && (
        <>
          <h1 className="text-2xl font-bold text-white">Couldn&apos;t confirm</h1>
          <p className="text-sm text-rose-400">{state.message}</p>
          <Link href="/operator/register" className="font-medium text-emerald-400 hover:underline">
            Register again
          </Link>
        </>
      )}
    </div>
  )
}

export default function OperatorVerifyPage() {
  return (
    <Suspense fallback={null}>
      <VerifyInner />
    </Suspense>
  )
}
