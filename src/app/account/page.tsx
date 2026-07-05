import { redirect } from "next/navigation"
import { auth } from "@/lib/auth"
import { db } from "@/lib/db"
import { Navbar } from "@/components/portal-main"
import AccountClient from "@/components/account/account-client"

export default async function AccountPage() {
  const session = await auth()
  if (!session?.user) redirect("/login?callbackUrl=/account")

  const user = await db.user.findUnique({
    where: { id: session.user.id },
    select: { name: true, email: true, addresses: { orderBy: { createdAt: "asc" } } },
  })
  if (!user) redirect("/login?callbackUrl=/account")

  return (
    <div className="min-h-screen bg-background">
      <Navbar />
      <div className="mx-auto max-w-2xl px-6 py-12">
        <h1 className="mb-6 text-2xl font-bold text-foreground">My Account</h1>
        <AccountClient initialName={user.name ?? ""} email={user.email} initialAddresses={user.addresses} />
      </div>
    </div>
  )
}
