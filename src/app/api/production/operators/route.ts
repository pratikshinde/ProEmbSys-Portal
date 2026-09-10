import { NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { db } from "@/lib/db"
import { isStaff } from "@/lib/roles"

/** Active shop-floor operators, for the "assign this job to…" picker. Staff only. */
export async function GET() {
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!isStaff(session.user.role)) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const operators = await db.user.findMany({
    where: {
      role: "OPERATOR",
      isActive: true,
      OR: [{ operatorProfile: null }, { operatorProfile: { isActive: true } }],
    },
    select: { id: true, name: true, email: true },
    orderBy: { name: "asc" },
  })

  return NextResponse.json({
    operators: operators.map((o) => ({ id: o.id, name: o.name || o.email, email: o.email })),
  })
}
