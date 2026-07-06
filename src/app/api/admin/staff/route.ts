import { NextResponse } from "next/server"
import crypto from "crypto"
import bcrypt from "bcryptjs"
import { Role } from "@prisma/client"
import { auth } from "@/lib/auth"
import { db } from "@/lib/db"
import { sendStaffWelcomeEmail } from "@/lib/email"

export async function GET() {
  const session = await auth()
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const staff = await db.user.findMany({
    where: { role: { in: ["ADMIN", "ENGINEER"] } },
    select: { id: true, name: true, email: true, role: true, isActive: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  })
  return NextResponse.json(staff)
}

export async function POST(req: Request) {
  const session = await auth()
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const { name, email, role } = await req.json()
  if (!name || !email || typeof email !== "string") {
    return NextResponse.json({ error: "Name and email are required." }, { status: 400 })
  }
  if (role !== "ADMIN" && role !== "ENGINEER") {
    return NextResponse.json({ error: "role must be ADMIN or ENGINEER." }, { status: 400 })
  }

  const existing = await db.user.findUnique({ where: { email } })
  if (existing) {
    return NextResponse.json({ error: "A user with that email already exists." }, { status: 409 })
  }

  // Generated so the account is usable immediately even if the welcome email
  // never arrives (e.g. RESEND_API_KEY not configured yet) — the admin can
  // share this manually as a fallback.
  const tempPassword = crypto.randomBytes(9).toString("base64").replace(/[^a-zA-Z0-9]/g, "").slice(0, 12)
  const passwordHash = await bcrypt.hash(tempPassword, 10)

  const user = await db.user.create({
    data: { name, email, role: role as Role, passwordHash },
    select: { id: true, name: true, email: true, role: true, isActive: true, createdAt: true },
  })

  const token = crypto.randomBytes(32).toString("hex")
  await db.passwordResetToken.create({
    data: { token, userId: user.id, expiresAt: new Date(Date.now() + 60 * 60 * 1000) },
  })
  const setPasswordUrl = `${process.env.APP_URL ?? "http://localhost:3000"}/reset-password?token=${token}`

  let emailSent = true
  try {
    await sendStaffWelcomeEmail(user.email, user.role, setPasswordUrl)
  } catch {
    emailSent = false
  }

  return NextResponse.json({ user, tempPassword, emailSent }, { status: 201 })
}
