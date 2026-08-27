import { redirect } from "next/navigation"
import { auth } from "@/lib/auth"
import { Navbar } from "@/components/portal-main"
import CamJobsLibrary from "@/components/cam-jobs-library"
import { listCamJobSummaries, listCamJobCustomers } from "@/lib/cam-job-summary"
import { parseCamJobFilters, resolveDateWindow, camJobFiltersToParams } from "@/lib/cam-job-filters"
import type { CamJobHealthLevel } from "@/lib/cam-job-health"

const PAGE_SIZE = 20

export default async function CamJobsListPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const session = await auth()
  if (!session?.user) redirect("/login?callbackUrl=/cam-jobs")

  const filters = parseCamJobFilters(await searchParams)
  const dateWindow = resolveDateWindow(filters)
  const [{ jobs, total }, customerOptions] = await Promise.all([
    listCamJobSummaries({
      userId: session.user.id,
      status: filters.status || undefined,
      health: (filters.health || undefined) as CamJobHealthLevel | undefined,
      q: filters.q || undefined,
      customer: filters.customer || undefined,
      updatedFrom: dateWindow.gte,
      updatedBefore: dateWindow.lt,
      sort: filters.sort,
      dir: filters.dir,
      take: PAGE_SIZE,
    }),
    // Distinct customer values for the filter dropdown — deliberately its
    // own unfiltered query (see listCamJobCustomers's own docs on why a
    // self-narrowing facet list is a trap).
    listCamJobCustomers(session.user.id),
  ])
  // Dates -> ISO strings before crossing the server/client boundary, same
  // convention every other list surface in this app uses (e.g. the old
  // CamJobRow.updatedAt: string) rather than relying on RSC's Date
  // passthrough.
  const clientJobs = jobs.map((j) => ({ ...j, createdAt: j.createdAt.toISOString(), updatedAt: j.updatedAt.toISOString() }))

  return (
    <div className="min-h-screen bg-background">
      <Navbar />
      <div className="mx-auto max-w-6xl px-6 py-12">
        <h1 className="mb-6 text-2xl font-bold text-foreground">My CAM Jobs</h1>
        <CamJobsLibrary
          // Filters change via a soft navigation to this same route, which
          // preserves this client component's identity and its useState —
          // without a key tied to the filter set, the table would keep
          // showing the PREVIOUS filter's rows until an unrelated state
          // update (e.g. Load more) happened to re-run. Remounting on every
          // filter change resets jobs/total/searchInput together, correctly.
          key={camJobFiltersToParams(filters).toString()}
          initialJobs={clientJobs}
          initialTotal={total}
          initialFilters={filters}
          customerOptions={customerOptions}
          pageSize={PAGE_SIZE}
        />
      </div>
    </div>
  )
}
