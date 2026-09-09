import { NextResponse } from "next/server"
import { Prisma, CamJobStatus } from "@prisma/client"
import { auth } from "@/lib/auth"
import { db } from "@/lib/db"
import { readCamJobFile, deleteCamJobDir } from "@/lib/cam-job-files"
import { deleteShareBundleDir } from "@/lib/share-files"
import { loadAccessibleCamJob, camJobVisibilityReason, isStaffRole } from "@/lib/cam-job-access"
import type { CamJobSnapshot } from "@/lib/store"

/** Loads a job only if the caller owns it — a blanket 404 on mismatch (not
 *  403), same convention as dfm-templates/[id]/route.ts, so a request for
 *  someone else's private job can't be distinguished from one that doesn't
 *  exist at all. Used by every WRITE (PATCH/DELETE below): staff may now
 *  READ a job they don't own (see loadAccessibleCamJob in cam-job-access.ts
 *  — visible once it's linked to an Order or shared to an org contact), but
 *  they never write, delete, or change status, so this owner-only check is
 *  deliberately unchanged and still the only path into either handler. */
async function loadOwnCamJob(id: string, userId: string) {
  const existing = await db.camJob.findUnique({ where: { id } })
  if (!existing || existing.userId !== userId) return null
  return existing
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const job = await loadAccessibleCamJob(id, session.user.id, isStaffRole(session.user.role))
  if (!job) return NextResponse.json({ error: "Not found" }, { status: 404 })

  const config = job.config as unknown as CamJobSnapshot

  // Inline every file's text content in this one response (deliberately not
  // a separate per-file download route — these are always small Gerber/
  // Excellon text files, never binary, so N round-trips would only add
  // latency). A file that fails to read (e.g. a corrupted/missing entry) is
  // skipped rather than failing the whole load — but unlike before, the
  // omission is now reported back as `missingFiles` instead of silently
  // vanishing. loadCamJobById (src/lib/load-cam-job.ts) surfaces this to
  // the user as "loaded with N layers missing" rather than a bare success
  // toast that hides real data loss.
  const missingFiles: string[] = []
  const filesWithContent = await Promise.all(
    config.files.map(async (meta) => {
      try {
        const content = await readCamJobFile(job.id, meta.layerFileId)
        return { ...meta, content }
      } catch {
        missingFiles.push(meta.fileName)
        return { ...meta, content: null }
      }
    })
  )

  // Only meaningful for a non-owner (staff) viewer — 'owner' needs no
  // explanation in a UI. Included unconditionally since it's cheap and the
  // field is simply ignored by the normal load-into-the-tool path.
  const visibility = camJobVisibilityReason(job, session.user.id)

  return NextResponse.json({
    id: job.id,
    name: job.name,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    config: { ...config, files: filesWithContent },
    missingFiles,
    visibility,
    ownerName: job.user.name,
    ownerEmail: job.user.email,
    orderReference: job.order?.reference ?? null,
    // Read by loadCamJobById (src/lib/load-cam-job.ts) to decide whether
    // reloading this job should silently regenerate routing/G-code — see
    // CamJob.routingGeneratedAt's own schema comment.
    hadRouting: job.routingGeneratedAt != null,
    hadGcode: job.gcodeGeneratedAt != null,
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

  const status = typeof body?.status === "string" ? body.status : undefined
  // Object.hasOwn, NOT `in` — `"constructor" in CamJobStatus` is true (it's
  // a plain object literal with a real prototype chain), so this guard
  // previously let `status: "constructor"` through as "valid", which then
  // threw an unhandled PrismaClientValidationError (a 500) at the update()
  // call below instead of the intended 400 here.
  if (status !== undefined && !Object.hasOwn(CamJobStatus, status)) {
    return NextResponse.json({ error: "Invalid status." }, { status: 400 })
  }

  // orderId: string links, null explicitly unlinks, undefined leaves
  // unchanged — the three-way distinction `!== undefined` below preserves.
  const orderIdProvided = Object.prototype.hasOwnProperty.call(body ?? {}, "orderId")
  let orderId: string | null | undefined
  if (orderIdProvided) {
    orderId = typeof body.orderId === "string" && body.orderId.trim() ? body.orderId.trim() : null
    if (orderId) {
      const order = await db.order.findUnique({ where: { id: orderId }, select: { userId: true } })
      if (!order || order.userId !== session.user.id) {
        return NextResponse.json({ error: "That order could not be found." }, { status: 400 })
      }
    }
  }

  if (name === undefined && status === undefined && !orderIdProvided) {
    return NextResponse.json({ error: "Nothing to update." }, { status: 400 })
  }

  try {
    const updated = await db.camJob.update({
      where: { id },
      data: {
        ...(name !== undefined ? { name } : {}),
        ...(status !== undefined ? { status: status as CamJobStatus } : {}),
        ...(orderIdProvided ? { orderId } : {}),
      },
    })
    return NextResponse.json({ id: updated.id, name: updated.name, status: updated.status, orderId: updated.orderId, updatedAt: updated.updatedAt })
  } catch (err) {
    // Renaming into an existing (userId, name, revision) collision used to
    // throw an unhandled 500 here — this route never caught P2002, unlike
    // the identical situation in POST. Same remediation message shape.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return NextResponse.json(
        { error: `A job named "${name}" with this revision already exists. Choose a different name.` },
        { status: 409 }
      )
    }
    throw err
  }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const existing = await loadOwnCamJob(id, session.user.id)
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 })

  // ShareBundle.camJob is onDelete: Cascade at the DB level, so the rows
  // disappear on their own — but that cascade knows nothing about the
  // on-disk ZIP each bundle wrote via share-files.ts. Fetch their ids
  // BEFORE deleting the job (the cascade would otherwise take the rows,
  // and their ids, with it) so every bundle's directory gets cleaned up
  // too, not just the job's own.
  const bundleIds = (await db.shareBundle.findMany({ where: { camJobId: id }, select: { id: true } })).map((b) => b.id)

  await db.camJob.delete({ where: { id } })
  await deleteCamJobDir(id).catch(() => {})
  await Promise.all(bundleIds.map((bundleId) => deleteShareBundleDir(bundleId).catch(() => {})))
  return NextResponse.json({ ok: true })
}
