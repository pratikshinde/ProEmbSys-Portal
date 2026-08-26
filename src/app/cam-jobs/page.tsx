import { redirect } from "next/navigation"
import { auth } from "@/lib/auth"
import { Navbar } from "@/components/portal-main"
import CamJobsLibrary from "@/components/cam-jobs-library"
import { listCamJobSummaries } from "@/lib/cam-job-summary"
import type { CamJobHealthLevel } from "@/lib/cam-job-health"

const PAGE_SIZE = 20

export default async function CamJobsListPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; health?: string; q?: string }>
}) {
  const session = await auth()
  if (!session?.user) redirect("/login?callbackUrl=/cam-jobs")

  const { status, health, q } = await searchParams
  const { jobs, total } = await listCamJobSummaries({
    userId: session.user.id,
    status,
    health: health as CamJobHealthLevel | undefined,
    q,
    take: PAGE_SIZE,
  })
  // Dates -> ISO strings before crossing the server/client boundary, same
  // convention every other list surface in this app uses (e.g. the old
  // CamJobRow.updatedAt: string) rather than relying on RSC's Date
  // passthrough.
  const clientJobs = jobs.map((j) => ({ ...j, createdAt: j.createdAt.toISOString(), updatedAt: j.updatedAt.toISOString() }))

  return (
    <div className="min-h-screen bg-background">
      <Navbar />
      <div className="mx-auto max-w-4xl px-6 py-12">
        <h1 className="mb-6 text-2xl font-bold text-foreground">My CAM Jobs</h1>
        <CamJobsLibrary
          initialJobs={clientJobs}
          initialTotal={total}
          initialFilters={{ status: status ?? "", health: health ?? "", q: q ?? "" }}
          pageSize={PAGE_SIZE}
        />
      </div>
    </div>
  )
}
