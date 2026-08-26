import { NextResponse } from "next/server"
import { Prisma, CamJobStatus } from "@prisma/client"
import { auth } from "@/lib/auth"
import { db } from "@/lib/db"
import { saveCamJobFile, deleteCamJobDir, MAX_TOTAL_SIZE_BYTES } from "@/lib/cam-job-files"
import { listCamJobSummaries } from "@/lib/cam-job-summary"
import type { CamJobHealthLevel } from "@/lib/cam-job-health"
import type { CamJobSnapshot } from "@/lib/store"

export async function GET(req: Request) {
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const url = new URL(req.url)
  const result = await listCamJobSummaries({
    userId: session.user.id,
    status: url.searchParams.get("status"),
    health: url.searchParams.get("health") as CamJobHealthLevel | null,
    q: url.searchParams.get("q"),
    skip: parseInt(url.searchParams.get("skip") ?? "0", 10) || 0,
    take: parseInt(url.searchParams.get("take") ?? "20", 10) || 20,
  })
  return NextResponse.json(result)
}

export async function POST(req: Request) {
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const userId = session.user.id

  const formData = await req.formData()
  const name = formData.get("name")
  const configRaw = formData.get("config")
  if (typeof name !== "string" || !name.trim()) {
    return NextResponse.json({ error: "A job name is required." }, { status: 400 })
  }
  if (typeof configRaw !== "string") {
    return NextResponse.json({ error: "Missing config." }, { status: 400 })
  }

  let config: CamJobSnapshot
  try {
    config = JSON.parse(configRaw)
  } catch {
    return NextResponse.json({ error: "Invalid config JSON." }, { status: 400 })
  }
  if (!Array.isArray(config.files)) {
    return NextResponse.json({ error: "Invalid config: missing files list." }, { status: 400 })
  }
  const revision = typeof config.panelInfo?.revision === "string" ? config.panelInfo.revision.trim() : ""

  // Health counts — sent as ONE JSON field, deliberately separate from
  // `config` (see cam-job-health.ts / the CamJob model's own comments: what
  // gets queried needs to be a real column, not buried in the snapshot
  // blob). Malformed/absent is never a save-blocking error — worst case the
  // job just saves as "not checked", which is the honest default anyway.
  let health: Partial<{
    dfmRanAt: string | null; dfmErrors: number | null; dfmWarnings: number | null; dfmInfos: number | null
    dfmLayerCount: number | null; exportRanAt: string | null; exportWarnings: number | null; importWarnings: number
  }> = {}
  const healthRaw = formData.get("health")
  if (typeof healthRaw === "string") {
    try {
      health = JSON.parse(healthRaw)
    } catch {
      health = {}
    }
  }

  // Optional order link — validated against ownership so a job can never
  // claim to belong to someone else's order.
  const orderIdRaw = formData.get("orderId")
  const orderId = typeof orderIdRaw === "string" && orderIdRaw.trim() ? orderIdRaw.trim() : null
  if (orderId) {
    const order = await db.order.findUnique({ where: { id: orderId }, select: { userId: true } })
    if (!order || order.userId !== userId) {
      return NextResponse.json({ error: "That order could not be found." }, { status: 400 })
    }
  }

  const statusRaw = formData.get("status")
  const status = typeof statusRaw === "string" && statusRaw in CamJobStatus ? (statusRaw as CamJobStatus) : undefined

  // Collect the file parts (keyed "file_<layerFileId>", matching config.files
  // entries by layerFileId) and enforce the total-size cap before writing
  // anything to disk.
  const fileEntries: { layerFileId: string; file: File }[] = []
  let totalSize = 0
  for (const meta of config.files) {
    const part = formData.get(`file_${meta.layerFileId}`)
    if (!(part instanceof File)) {
      return NextResponse.json({ error: `Missing file for layer ${meta.layerFileId}.` }, { status: 400 })
    }
    totalSize += part.size
    fileEntries.push({ layerFileId: meta.layerFileId, file: part })
  }
  if (totalSize > MAX_TOTAL_SIZE_BYTES) {
    return NextResponse.json({ error: "This job's total file size is too large to save." }, { status: 400 })
  }

  let job
  try {
    job = await db.camJob.create({
      data: {
        userId,
        name: name.trim(),
        revision,
        config: config as unknown as Prisma.InputJsonValue,
        ...(status ? { status } : {}),
        orderId,
        dfmRanAt: health.dfmRanAt ? new Date(health.dfmRanAt) : null,
        dfmErrors: health.dfmErrors ?? null,
        dfmWarnings: health.dfmWarnings ?? null,
        dfmInfos: health.dfmInfos ?? null,
        dfmLayerCount: health.dfmLayerCount ?? null,
        exportRanAt: health.exportRanAt ? new Date(health.exportRanAt) : null,
        exportWarnings: health.exportWarnings ?? null,
        importWarnings: health.importWarnings ?? 0,
      },
    })
  } catch (err) {
    // A job with this exact name+revision already exists for this user
    // (unique(userId, name, revision)) — block rather than silently create a
    // second row that's indistinguishable in the job list from the first.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return NextResponse.json(
        {
          error: revision
            ? `A job named "${name.trim()}" with revision "${revision}" already exists. Rename the job or change the Revision field, then save again.`
            : `A job named "${name.trim()}" already exists. Rename it or set a Revision in Panel Information, then save again.`,
        },
        { status: 409 }
      )
    }
    throw err
  }

  try {
    for (const { layerFileId, file } of fileEntries) {
      await saveCamJobFile(job.id, layerFileId, file)
    }
  } catch (err) {
    // Disk I/O isn't covered by the DB write above — clean up by hand so a
    // partial save never leaves an unusable row behind.
    await deleteCamJobDir(job.id).catch(() => {})
    await db.camJob.delete({ where: { id: job.id } }).catch(() => {})
    return NextResponse.json({ error: err instanceof Error ? err.message : "Could not save job files." }, { status: 500 })
  }

  return NextResponse.json(job, { status: 201 })
}
