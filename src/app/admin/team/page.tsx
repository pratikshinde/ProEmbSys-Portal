import { redirect } from "next/navigation"
import { auth } from "@/lib/auth"
import { db } from "@/lib/db"
import StaffTable from "@/components/admin/staff-table"
import OperatorsTable from "@/components/admin/operators-table"

export default async function AdminTeamPage() {
  const session = await auth()
  if (!session?.user || session.user.role !== "ADMIN") redirect("/admin")

  const [staff, operators] = await Promise.all([
    db.user.findMany({
      where: { role: { in: ["ADMIN", "ENGINEER"] } },
      select: { id: true, name: true, email: true, role: true, isActive: true, createdAt: true },
      orderBy: { createdAt: "asc" },
    }),
    db.user.findMany({
      where: { role: "OPERATOR" },
      select: { id: true, name: true, email: true, isActive: true, emailVerified: true, createdAt: true },
      orderBy: { createdAt: "asc" },
    }),
  ])

  return (
    <div className="flex flex-col gap-10">
      <div className="flex flex-col gap-6">
        <h1 className="text-2xl font-bold text-foreground">Team</h1>
        <p className="text-sm text-muted-foreground">
          Manage Engineer and Admin accounts. Deactivating an account revokes login access but keeps their message
          history intact in shared order threads.
        </p>
        <StaffTable initialStaff={staff} currentUserId={session.user.id} />
      </div>

      <div className="flex flex-col gap-4">
        <h2 className="text-xl font-bold text-foreground">Shop-floor operators</h2>
        <p className="text-sm text-muted-foreground">
          Operators sign themselves up at <code className="text-foreground">/operator/register</code> with their real
          email and confirm it before the account can log in. Deactivate one to block login immediately (the account
          and its production history are kept).
        </p>
        <OperatorsTable
          initialOperators={operators.map((o) => ({
            id: o.id,
            name: o.name,
            email: o.email,
            isActive: o.isActive,
            verified: o.emailVerified !== null,
            createdAt: o.createdAt.toISOString(),
          }))}
        />
      </div>
    </div>
  )
}
