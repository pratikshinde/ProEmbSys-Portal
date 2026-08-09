import { redirect } from "next/navigation"
import { auth } from "@/lib/auth"
import { Navbar, PanelizationPage } from "@/components/portal-main"

export default async function PanelizationRoute() {
  const session = await auth()
  if (!session?.user) redirect("/login?callbackUrl=/panelization")

  return (
    <div>
      <Navbar />
      <PanelizationPage />
    </div>
  )
}
