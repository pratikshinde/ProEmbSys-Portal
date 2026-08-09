import { redirect } from "next/navigation"
import { auth } from "@/lib/auth"
import { db } from "@/lib/db"
import { Navbar } from "@/components/portal-main"
import CamJobsList, { type CamJobRow } from "@/components/cam-jobs-list"
import type { CamJobSnapshot } from "@/lib/store"

export default async function CamJobsListPage() {
  const session = await auth()
  if (!session?.user) redirect("/login?callbackUrl=/cam-jobs")

  const jobs = await db.camJob.findMany({
    where: { userId: session.user.id },
    orderBy: { updatedAt: "desc" },
  })

  const rows: CamJobRow[] = jobs.map((job) => ({
    id: job.id,
    name: job.name,
    revision: job.revision,
    updatedAt: job.updatedAt.toISOString(),
    config: job.config as unknown as CamJobSnapshot,
  }))

  return (
    <div className="min-h-screen bg-background">
      <Navbar />
      <div className="mx-auto max-w-3xl px-6 py-12">
        <h1 className="mb-6 text-2xl font-bold text-foreground">My CAM Jobs</h1>
        <CamJobsList initialJobs={rows} />
      </div>
    </div>
  )
}
