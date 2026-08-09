import { NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { db } from "@/lib/db"
import { readCamJobFile, deleteCamJobDir } from "@/lib/cam-job-files"
import type { CamJobSnapshot } from "@/lib/store"

/** Loads a job only if the caller owns it — a blanket 404 on mismatch
 *  (not 403), same convention as dfm-templates/[id]/route.ts, so a request
 *  for someone else's private job can't be distinguished from one that
 *  doesn't exist at all. No staff bypass — unlike Order, nobody but the
 *  owner has a legitimate reason to read a CamJob. */
async function loadOwnCamJob(id: string, userId: string) {
  const existing = await db.camJob.findUnique({ where: { id } })
  if (!existing || existing.userId !== userId) return null
  return existing
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const job = await loadOwnCamJob(id, session.user.id)
  if (!job) return NextResponse.json({ error: "Not found" }, { status: 404 })

  const config = job.config as unknown as CamJobSnapshot

  // Inline every file's text content in this one response (deliberately not
  // a separate per-file download route — these are always small Gerber/
  // Excellon text files, never binary, so N round-trips would only add
  // latency). A file that fails to read (e.g. a corrupted/missing entry) is
  // just skipped rather than failing the whole load.
  const filesWithContent = await Promise.all(
    config.files.map(async (meta) => {
      try {
        const content = await readCamJobFile(job.id, meta.layerFileId)
        return { ...meta, content }
      } catch {
        return { ...meta, content: null }
      }
    })
  )

  return NextResponse.json({
    id: job.id,
    name: job.name,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    config: { ...config, files: filesWithContent },
  })
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const existing = await loadOwnCamJob(id, session.user.id)
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 })

  const body = await req.json()
  const name = typeof body?.name === "string" ? body.name.trim() : undefined
  if (name !== undefined && !name) {
    return NextResponse.json({ error: "A job name is required." }, { status: 400 })
  }
  if (name === undefined) {
    return NextResponse.json({ error: "Nothing to update." }, { status: 400 })
  }

  const updated = await db.camJob.update({ where: { id }, data: { name } })
  return NextResponse.json({ id: updated.id, name: updated.name, updatedAt: updated.updatedAt })
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const existing = await loadOwnCamJob(id, session.user.id)
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 })

  await db.camJob.delete({ where: { id } })
  await deleteCamJobDir(id).catch(() => {})
  return NextResponse.json({ ok: true })
}
