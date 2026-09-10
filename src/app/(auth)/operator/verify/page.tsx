"use client"

import { Suspense, useEffect, useRef, useState } from "react"
import { useSearchParams } from "next/navigation"
import Link from "next/link"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"

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
    <Card>
      <CardHeader>
        <CardTitle>Email confirmation</CardTitle>
        <CardDescription>
          {state.kind === "working" ? "Confirming your email…" : state.kind === "done" ? "You're all set." : "Couldn't confirm"}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 text-sm">
        {state.kind === "working" && <p className="text-muted-foreground">One moment…</p>}
        {state.kind === "done" && (
          <>
            <p className="text-muted-foreground">
              <strong className="text-foreground">{state.email}</strong> is confirmed. Your operator account is now
              active.
            </p>
            <Link
              href="/login?verified=1&callbackUrl=/production"
              className="inline-flex w-fit rounded-md bg-primary px-4 py-2 font-medium text-primary-foreground hover:bg-primary/90"
            >
              Sign in
            </Link>
          </>
        )}
        {state.kind === "error" && (
          <>
            <p className="text-destructive">{state.message}</p>
            <Link href="/operator/register" className="text-primary hover:underline">
              Register again
            </Link>
          </>
        )}
      </CardContent>
    </Card>
  )
}

export default function OperatorVerifyPage() {
  return (
    <Suspense fallback={null}>
      <VerifyInner />
    </Suspense>
  )
}
