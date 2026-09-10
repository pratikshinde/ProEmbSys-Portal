"use client"

import { Suspense, useState } from "react"
import { signIn } from "next-auth/react"
import { useRouter, useSearchParams } from "next/navigation"
import Link from "next/link"
import { Loader2 } from "lucide-react"

const field =
  "w-full rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-base text-white outline-none placeholder:text-slate-500 focus:border-emerald-500/60"

function OperatorLoginForm() {
  const router = useRouter()
  const params = useSearchParams()
  const justVerified = params.get("verified") === "1"
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    const res = await signIn("credentials", { email: email.trim(), password, redirect: false })
    setBusy(false)
    if (res?.error) {
      setError("Wrong email or password — or your email isn't confirmed yet.")
      return
    }
    router.push("/production")
    router.refresh()
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold text-white">Sign in</h1>
        <p className="mt-1 text-sm text-slate-400">Shop-floor operators only.</p>
      </div>

      {justVerified && (
        <p className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-300">
          Email confirmed — sign in to start.
        </p>
      )}

      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="email" className="text-sm font-medium text-slate-300">
            Email
          </label>
          <input
            id="email"
            type="email"
            autoComplete="email"
            className={field}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="password" className="text-sm font-medium text-slate-300">
            Password
          </label>
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            className={field}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </div>
        {error && <p className="text-sm text-rose-400">{error}</p>}
        <button
          type="submit"
          disabled={busy}
          className="mt-1 flex items-center justify-center gap-2 rounded-xl bg-emerald-500 px-4 py-3.5 text-base font-bold text-slate-950 active:bg-emerald-400 disabled:opacity-60"
        >
          {busy && <Loader2 className="h-5 w-5 animate-spin" />}
          Sign in
        </button>
      </form>

      <div className="flex flex-col gap-1 text-center text-sm text-slate-400">
        <p>
          New here?{" "}
          <Link href="/operator/register" className="font-medium text-emerald-400 hover:underline">
            Create your account
          </Link>
        </p>
        <p>
          <Link href="/forgot-password" className="text-slate-500 hover:text-slate-300">
            Forgot your password?
          </Link>
        </p>
      </div>
    </div>
  )
}

export default function OperatorLoginPage() {
  return (
    <Suspense fallback={null}>
      <OperatorLoginForm />
    </Suspense>
  )
}
