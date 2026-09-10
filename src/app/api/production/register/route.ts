import { NextResponse } from "next/server"
import crypto from "crypto"
import bcrypt from "bcryptjs"
import { z } from "zod"
import { db } from "@/lib/db"
import { sendOperatorVerificationEmail } from "@/lib/email"

// Open operator self-registration: anyone can create an operator account with a
// real email + name + password, but the account stays inactive (can't log in --
// authorize() checks isActive) until the email is verified via the link below.
const schema = z.object({
  name: z.string().trim().min(1, "Your name is required").max(120),
  email: z.string().trim().toLowerCase().email("Enter a valid email address"),
  password: z.string().min(8, "Password must be at least 8 characters"),
})

const VERIFY_TTL_MS = 24 * 60 * 60 * 1000

export async function POST(req: Request) {
  let data: z.infer<typeof schema>
  try {
    data = schema.parse(await req.json())
  } catch (e) {
    if (e instanceof z.ZodError) {
      return NextResponse.json({ error: e.issues[0]?.message ?? "Invalid input" }, { status: 400 })
    }
    return NextResponse.json({ error: "Invalid request." }, { status: 400 })
  }

  const existing = await db.user.findUnique({ where: { email: data.email } })
  if (existing) {
    // A usable account already owns this email.
    if (existing.emailVerified || existing.isActive) {
      return NextResponse.json(
        { error: "An account with this email already exists — sign in instead." },
        { status: 409 }
      )
    }
    // An unverified row that isn't an operator (shouldn't normally happen) —
    // don't repurpose it.
    if (existing.role !== "OPERATOR") {
      return NextResponse.json({ error: "This email can't be registered here." }, { status: 409 })
    }
  }

  const passwordHash = await bcrypt.hash(data.password, 10)
  const user = existing
    ? await db.user.update({ where: { id: existing.id }, data: { name: data.name, passwordHash } })
    : await db.user.create({
        data: {
          name: data.name,
          email: data.email,
          passwordHash,
          role: "OPERATOR",
          isActive: false,
        },
      })

  const token = crypto.randomBytes(32).toString("hex")
  await db.$transaction([
    db.verificationToken.deleteMany({ where: { identifier: data.email } }),
    db.verificationToken.create({
      data: { identifier: data.email, token, expires: new Date(Date.now() + VERIFY_TTL_MS) },
    }),
  ])

  const verifyUrl = `${process.env.APP_URL ?? "http://localhost:3000"}/operator/verify?token=${token}`
  // The token must exist regardless of whether the email actually sends (e.g.
  // no mail provider configured in dev) — never turn a failed send into a 500.
  let emailSent = true
  try {
    await sendOperatorVerificationEmail(user.email, data.name, verifyUrl)
  } catch {
    emailSent = false
  }

  return NextResponse.json({ ok: true, emailSent })
}
