import { NextResponse } from "next/server"
import { z } from "zod"
import { db } from "@/lib/db"

// Consumes the email-verification token from the link in the operator's inbox:
// marks the email verified and flips the account to active so it can log in.
// POST (not GET) so an email scanner's link prefetch can't burn the token.
const schema = z.object({ token: z.string().min(1) })

export async function POST(req: Request) {
  let token: string
  try {
    token = schema.parse(await req.json()).token
  } catch {
    return NextResponse.json({ error: "Missing token." }, { status: 400 })
  }

  const vt = await db.verificationToken.findUnique({ where: { token } })
  if (!vt || vt.expires < new Date()) {
    if (vt) await db.verificationToken.delete({ where: { token } }).catch(() => {})
    return NextResponse.json(
      { error: "This link is invalid or has expired. Register again to get a new one." },
      { status: 400 }
    )
  }

  const user = await db.user.findUnique({ where: { email: vt.identifier } })
  if (!user) {
    await db.verificationToken.deleteMany({ where: { identifier: vt.identifier } })
    return NextResponse.json({ error: "That account no longer exists. Please register again." }, { status: 400 })
  }

  await db.$transaction([
    db.user.update({
      where: { id: user.id },
      data: { emailVerified: user.emailVerified ?? new Date(), isActive: true },
    }),
    db.verificationToken.deleteMany({ where: { identifier: vt.identifier } }),
  ])

  return NextResponse.json({ ok: true, email: user.email })
}
