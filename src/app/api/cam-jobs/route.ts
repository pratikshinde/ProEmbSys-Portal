import { NextResponse } from "next/server"
import { Prisma } from "@prisma/client"
import { auth } from "@/lib/auth"
import { db } from "@/lib/db"
import { saveCamJobFile, deleteCamJobDir, MAX_TOTAL_SIZE_BYTES } from "@/lib/cam-job-files"
import type { CamJobSnapshot } from "@/lib/store"

export async function GET() {
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const jobs = await db.camJob.findMany({
    where: { userId: session.user.id },
    orderBy: { updatedAt: "desc" },
  })
  return NextResponse.json(jobs)
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

  const job = await db.camJob.create({
    data: {
      userId,
      name: name.trim(),
      config: config as unknown as Prisma.InputJsonValue,
    },
  })

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
