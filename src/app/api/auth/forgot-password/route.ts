import { NextResponse } from "next/server"
import crypto from "crypto"
import { db } from "@/lib/db"
import { sendPasswordResetEmail } from "@/lib/email"

export async function POST(req: Request) {
  const { email } = await req.json()

  if (!email || typeof email !== "string") {
    return NextResponse.json({ error: "Email is required." }, { status: 400 })
  }

  const user = await db.user.findUnique({ where: { email } })

  // Always return 200 regardless of whether the account exists, to avoid
  // leaking which emails are registered.
  if (user) {
    const token = crypto.randomBytes(32).toString("hex")
    await db.passwordResetToken.create({
      data: { token, userId: user.id, expiresAt: new Date(Date.now() + 60 * 60 * 1000) },
    })
    const resetUrl = `${process.env.APP_URL ?? "http://localhost:3000"}/reset-password?token=${token}`
    // The reset token must exist regardless of whether the email actually
    // sends (e.g. RESEND_API_KEY unset in local dev) — never let a failed
    // send turn into a 500 for the user.
    try {
      await sendPasswordResetEmail(user.email, resetUrl)
    } catch {
      // Swallowed intentionally — see comment above.
    }
  }

  return NextResponse.json({ ok: true })
}
