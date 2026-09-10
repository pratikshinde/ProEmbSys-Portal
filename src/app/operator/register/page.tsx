"use client"

import { useState } from "react"
import Link from "next/link"
import { Loader2 } from "lucide-react"

const field =
  "w-full rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-base text-white outline-none placeholder:text-slate-500 focus:border-emerald-500/60"

export default function OperatorRegisterPage() {
  const [name, setName] = useState("")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState<{ email: string; emailSent: boolean } | null>(null)

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    const res = await fetch("/api/production/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name.trim(), email: email.trim(), password }),
    })
    setBusy(false)
    const body = await res.json().catch(() => ({}))
    if (!res.ok) {
      setError(body.error ?? "Could not create your account.")
      return
    }
    setSent({ email: email.trim(), emailSent: body.emailSent !== false })
  }

  if (sent) {
    return (
      <div className="flex flex-col gap-5">
        <h1 className="text-2xl font-bold text-white">Check your email</h1>
        {sent.emailSent ? (
          <p className="text-sm text-slate-300">
            We sent a confirmation link to <strong className="text-white">{sent.email}</strong>. Open it to activate
            your account, then come back and sign in. The link works for 24 hours.
          </p>
        ) : (
          <p className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-300">
            Your account was created, but the confirmation email couldn&apos;t be sent right now. Ask the office to
            activate it for you, or try again in a few minutes.
          </p>
        )}
        <Link
          href="/operator/login"
          className="w-fit rounded-xl bg-emerald-500 px-5 py-3 text-base font-bold text-slate-950 active:bg-emerald-400"
        >
          Go to sign in
        </Link>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold text-white">Create your account</h1>
        <p className="mt-1 text-sm text-slate-400">
          Use your real email — you&apos;ll confirm it before you can sign in.
        </p>
      </div>

      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="name" className="text-sm font-medium text-slate-300">
            Your name
          </label>
          <input id="name" autoComplete="name" className={field} value={name} onChange={(e) => setName(e.target.value)} required />
        </div>
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
            autoComplete="new-password"
            className={field}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={8}
          />
          <p className="text-xs text-slate-500">At least 8 characters.</p>
        </div>
        {error && <p className="text-sm text-rose-400">{error}</p>}
        <button
          type="submit"
          disabled={busy}
          className="mt-1 flex items-center justify-center gap-2 rounded-xl bg-emerald-500 px-4 py-3.5 text-base font-bold text-slate-950 active:bg-emerald-400 disabled:opacity-60"
        >
          {busy && <Loader2 className="h-5 w-5 animate-spin" />}
          Create account
        </button>
      </form>

      <p className="text-center text-sm text-slate-400">
        Already have an account?{" "}
        <Link href="/operator/login" className="font-medium text-emerald-400 hover:underline">
          Sign in
        </Link>
      </p>
    </div>
  )
}
