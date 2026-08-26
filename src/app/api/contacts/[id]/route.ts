import { NextResponse } from "next/server"
import { Prisma } from "@prisma/client"
import { auth } from "@/lib/auth"
import { db, toContactDto, canEditContact } from "@/lib/contacts"

function isStaffRole(role: string): boolean {
  return role === "ADMIN" || role === "ENGINEER"
}

/** Loads a contact only if the caller may edit it — a blanket 404 on
 *  mismatch (not 403), same convention as cam-jobs/[id]/route.ts and
 *  dfm-templates/[id]/route.ts. Covers all three rejection cases the same
 *  way: doesn't exist, PRIVATE but not the owner, or SHARED but the caller
 *  isn't staff. */
async function loadEditableContact(id: string, userId: string, isStaff: boolean) {
  const existing = await db.contact.findUnique({ where: { id } })
  if (!existing || !canEditContact(existing, userId, isStaff)) return null
  return existing
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const isStaff = isStaffRole(session.user.role)

  const existing = await loadEditableContact(id, session.user.id, isStaff)
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 })

  const { name, email, company, role, notes } = await req.json()
  if (email !== undefined && (typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()))) {
    return NextResponse.json({ error: "Enter a valid email address." }, { status: 400 })
  }
  if (name !== undefined && (typeof name !== "string" || !name.trim())) {
    return NextResponse.json({ error: "A name is required." }, { status: 400 })
  }

  try {
    const updated = await db.contact.update({
      where: { id },
      data: {
        ...(name !== undefined ? { name: name.trim() } : {}),
        ...(email !== undefined ? { email: email.trim() } : {}),
        ...(company !== undefined ? { company: company || null } : {}),
        ...(role !== undefined ? { role: role || null } : {}),
        ...(notes !== undefined ? { notes: notes || null } : {}),
      },
    })
    return NextResponse.json(toContactDto(updated, session.user.id, isStaff))
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return NextResponse.json({ error: "A contact with this email already exists." }, { status: 409 })
    }
    throw err
  }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const isStaff = isStaffRole(session.user.role)

  const existing = await loadEditableContact(id, session.user.id, isStaff)
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 })

  await db.contact.delete({ where: { id } })
  return NextResponse.json({ ok: true })
}
