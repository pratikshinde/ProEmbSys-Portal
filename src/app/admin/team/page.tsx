import { redirect } from "next/navigation"
import { auth } from "@/lib/auth"
import { db } from "@/lib/db"
import StaffTable from "@/components/admin/staff-table"

export default async function AdminTeamPage() {
  const session = await auth()
  if (!session?.user || session.user.role !== "ADMIN") redirect("/admin")

  const staff = await db.user.findMany({
    where: { role: { in: ["ADMIN", "ENGINEER"] } },
    select: { id: true, name: true, email: true, role: true, isActive: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  })

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-bold text-foreground">Team</h1>
      <p className="text-sm text-muted-foreground">
        Manage Engineer and Admin accounts. Deactivating an account revokes login access but keeps their message
        history intact in shared order threads.
      </p>
      <StaffTable initialStaff={staff} currentUserId={session.user.id} />
    </div>
  )
}
