import { NextResponse } from "next/server"
import { Prisma } from "@prisma/client"
import { auth } from "@/lib/auth"
import { db, toContactDto, visibleContactsWhere } from "@/lib/contacts"

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function isStaffRole(role: string): boolean {
  return role === "ADMIN" || role === "ENGINEER"
}

export async function GET() {
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const isStaff = isStaffRole(session.user.role)

  const contacts = await db.contact.findMany({
    where: visibleContactsWhere(session.user.id, isStaff),
    // SHARED first (the org's own curated list), then alphabetical within
    // each group — matches the "(shared) / (mine)" grouping the picker UI
    // shows.
    orderBy: [{ scope: "asc" }, { name: "asc" }],
  })
  return NextResponse.json(contacts.map((c) => toContactDto(c, session.user.id, isStaff)))
}

export async function POST(req: Request) {
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const isStaff = isStaffRole(session.user.role)

  const { name, email, company, role, notes, scope: requestedScope } = await req.json()
  if (!name || typeof name !== "string" || !name.trim()) {
    return NextResponse.json({ error: "A name is required." }, { status: 400 })
  }
  if (!email || typeof email !== "string" || !EMAIL_RE.test(email.trim())) {
    return NextResponse.json({ error: "Enter a valid email address." }, { status: 400 })
  }

  // scope defaults to PRIVATE — a customer using the CAM tool can only ever
  // create their own contacts; only staff can explicitly opt into SHARED.
  let scope: "PRIVATE" | "SHARED" = "PRIVATE"
  let userId: string | null = session.user.id
  if (requestedScope === "SHARED") {
    if (!isStaff) return NextResponse.json({ error: "Only staff can create shared contacts." }, { status: 403 })
    scope = "SHARED"
    userId = null
  }

  try {
    const contact = await db.contact.create({
      data: {
        scope,
        userId,
        name: name.trim(),
        email: email.trim(),
        company: company || null,
        role: role || null,
        notes: notes || null,
      },
    })
    return NextResponse.json(toContactDto(contact, session.user.id, isStaff), { status: 201 })
  } catch (err) {
    // (userId, email) unique — the common case is re-adding the same
    // plotter/drill-shop contact by accident.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return NextResponse.json({ error: "A contact with this email already exists." }, { status: 409 })
    }
    throw err
  }
}
