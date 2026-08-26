import { NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { db } from "@/lib/db"
import { deleteShareBundleDir } from "@/lib/share-files"
import { shareUrl } from "@/lib/share/tokens"

/** Owner-only, blanket 404 on mismatch — same convention as
 *  cam-jobs/[id]/route.ts's loadOwnCamJob. No staff bypass: a bundle is the
 *  sender's own outbox record, not shop-visible state (unlike the CamJob
 *  itself once Phase 5 lands staff visibility). */
async function loadOwnBundle(id: string, userId: string) {
  const existing = await db.shareBundle.findUnique({
    where: { id },
    include: { recipients: true, camJob: { select: { name: true } } },
  })
  if (!existing || existing.userId !== userId) return null
  return existing
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const bundle = await loadOwnBundle(id, session.user.id)
  if (!bundle) return NextResponse.json({ error: "Not found" }, { status: 404 })

  return NextResponse.json({
    id: bundle.id,
    camJobId: bundle.camJobId,
    camJobName: bundle.camJob.name,
    orderId: bundle.orderId,
    kind: bundle.kind,
    fileName: bundle.fileName,
    fileSize: bundle.fileSize,
    manifest: bundle.manifest,
    message: bundle.message,
    expiresAt: bundle.expiresAt,
    createdAt: bundle.createdAt,
    recipients: bundle.recipients.map((r) => ({
      id: r.id,
      email: r.email,
      name: r.name,
      sentAt: r.sentAt,
      sendError: r.sendError,
      attached: r.attached,
      firstAccessedAt: r.firstAccessedAt,
      lastAccessedAt: r.lastAccessedAt,
      accessCount: r.accessCount,
      revokedAt: r.revokedAt,
      downloadUrl: shareUrl(r.token),
    })),
  })
}

/** Deletes the bundle (recipients cascade) and its on-disk ZIP. Every
 *  outstanding link for every recipient stops working immediately — there
 *  is no "delete but keep links alive" middle ground, unlike per-recipient
 *  revoke (PATCH .../recipients/[rid]). */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const bundle = await loadOwnBundle(id, session.user.id)
  if (!bundle) return NextResponse.json({ error: "Not found" }, { status: 404 })

  await db.shareBundle.delete({ where: { id } })
  await deleteShareBundleDir(id).catch(() => {})
  return NextResponse.json({ ok: true })
}
