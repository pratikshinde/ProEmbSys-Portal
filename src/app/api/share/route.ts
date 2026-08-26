import { NextResponse } from "next/server"
import { Prisma, ShareBundleKind } from "@prisma/client"
import { auth } from "@/lib/auth"
import { db } from "@/lib/db"
import { saveShareBundleFile, readShareBundleFile, deleteShareBundleDir, MAX_BUNDLE_SIZE_BYTES } from "@/lib/share-files"
import { generateShareToken, shareUrl } from "@/lib/share/tokens"
import { consumeShareQuota } from "@/lib/share/rate-limit"
import { sweepExpiredBundlesIfDue } from "@/lib/share/sweep"
import { parseShareManifest, renderShareReadme } from "@/lib/share/manifest"
import { sendShareBundleEmail } from "@/lib/email"
import { visibleContactsWhere } from "@/lib/contacts"

const ATTACH_MAX_BYTES = parseInt(process.env.SHARE_ATTACH_MAX_BYTES ?? "6291456", 10)
const DEFAULT_EXPIRY_DAYS = 30

function isStaffRole(role: string): boolean {
  return role === "ADMIN" || role === "ENGINEER"
}

/** Same blanket-404, owner-only convention as cam-jobs/[id]/route.ts's own
 *  loadOwnCamJob — duplicated locally rather than exported, since that file
 *  never exports it either (matching this codebase's existing precedent of
 *  small per-route ownership helpers, e.g. contacts/[id]/route.ts's own
 *  loadEditableContact). */
async function loadOwnCamJob(id: string, userId: string) {
  const existing = await db.camJob.findUnique({ where: { id } })
  if (!existing || existing.userId !== userId) return null
  return existing
}

/**
 * Creates a ShareBundle + its ShareRecipients, stores the client-generated
 * ZIP to disk, and emails each recipient sequentially. The ZIP itself is
 * NEVER regenerated here — CAM outputs (including film PDFs, which only
 * render in a browser Web Worker) don't exist server-side, so the browser
 * uploads the exact bytes it already built for download; this route's job
 * is to store, link, and mail those bytes, never to reconstruct them.
 */
export async function POST(req: Request) {
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const userId = session.user.id
  const isStaff = isStaffRole(session.user.role)
  const senderEmail = session.user.email
  if (!senderEmail) {
    return NextResponse.json({ error: "Your account has no email on file." }, { status: 500 })
  }

  // Piggybacks expiry cleanup on this request — there is no cron anywhere in
  // this app. A failed sweep must never fail a send.
  await sweepExpiredBundlesIfDue().catch((err) => console.error("share sweep failed:", err))

  const formData = await req.formData()

  const kindRaw = formData.get("kind")
  if (typeof kindRaw !== "string" || !(kindRaw in ShareBundleKind)) {
    return NextResponse.json({ error: "Invalid share kind." }, { status: 400 })
  }
  const kind = kindRaw as ShareBundleKind

  const camJobIdRaw = formData.get("camJobId")
  if (typeof camJobIdRaw !== "string" || !camJobIdRaw) {
    return NextResponse.json({ error: "A saved job is required before sharing." }, { status: 400 })
  }
  const camJob = await loadOwnCamJob(camJobIdRaw, userId)
  if (!camJob) return NextResponse.json({ error: "Not found" }, { status: 404 })

  const orderIdRaw = formData.get("orderId")
  const orderId = typeof orderIdRaw === "string" && orderIdRaw.trim() ? orderIdRaw.trim() : null
  if (orderId) {
    const order = await db.order.findUnique({ where: { id: orderId }, select: { userId: true } })
    if (!order || order.userId !== userId) {
      return NextResponse.json({ error: "That order could not be found." }, { status: 400 })
    }
  }

  const manifestRaw = formData.get("manifest")
  if (typeof manifestRaw !== "string") {
    return NextResponse.json({ error: "Missing manifest." }, { status: 400 })
  }
  let manifest
  try {
    manifest = parseShareManifest(kind, JSON.parse(manifestRaw))
  } catch {
    return NextResponse.json({ error: "Invalid manifest." }, { status: 400 })
  }

  const messageRaw = formData.get("message")
  const message = typeof messageRaw === "string" && messageRaw.trim() ? messageRaw.trim() : null

  // Recipients are ALWAYS resolved through a saved Contact the sender can
  // actually see — never a raw client-supplied email/name — matching the
  // locked decision "any signed-in user may send, but only to their own
  // saved contacts (staff also see org-wide SHARED)". An id that doesn't
  // resolve is a 400, never a silently-dropped recipient.
  const recipientsRaw = formData.get("recipients")
  let recipientIds: string[] = []
  if (typeof recipientsRaw === "string") {
    try {
      const parsed = JSON.parse(recipientsRaw)
      if (Array.isArray(parsed)) {
        recipientIds = Array.from(new Set(parsed.filter((v): v is string => typeof v === "string" && v.length > 0)))
      }
    } catch {
      recipientIds = []
    }
  }
  if (recipientIds.length === 0) {
    return NextResponse.json({ error: "At least one recipient is required." }, { status: 400 })
  }

  const contacts = await db.contact.findMany({
    where: { id: { in: recipientIds }, ...visibleContactsWhere(userId, isStaff) },
  })
  const contactsById = new Map(contacts.map((c) => [c.id, c]))
  if (contactsById.size !== recipientIds.length) {
    return NextResponse.json({ error: "One or more recipients could not be found." }, { status: 400 })
  }

  const file = formData.get("file")
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Missing bundle file." }, { status: 400 })
  }
  if (file.size > MAX_BUNDLE_SIZE_BYTES) {
    return NextResponse.json({ error: "This bundle is too large to share." }, { status: 400 })
  }

  const quota = await consumeShareQuota(userId)
  if (!quota.allowed) {
    return NextResponse.json(
      { error: "Too many shares sent recently. Please try again later." },
      { status: 429, headers: { "Retry-After": String(quota.retryAfterSeconds) } }
    )
  }

  const expiresAt = new Date(Date.now() + DEFAULT_EXPIRY_DAYS * 24 * 60 * 60 * 1000)

  const bundle = await db.$transaction(async (tx) => {
    const created = await tx.shareBundle.create({
      data: {
        userId,
        camJobId: camJob.id,
        orderId,
        kind,
        fileName: file.name || `${camJob.name}.zip`,
        fileSize: file.size,
        manifest: manifest as unknown as Prisma.InputJsonValue,
        message,
        expiresAt,
      },
    })
    await tx.shareRecipient.createMany({
      data: recipientIds.map((contactId) => {
        const c = contactsById.get(contactId)!
        return {
          bundleId: created.id,
          contactId: c.id,
          email: c.email,
          name: c.name,
          token: generateShareToken(),
        }
      }),
    })
    return created
  })

  // Disk I/O isn't covered by the transaction above — same compensating-
  // rollback shape as POST /api/cam-jobs: a write failure deletes the DB
  // rows (recipients cascade with the bundle) rather than leaving an
  // unusable bundle behind.
  try {
    const bytes = new Uint8Array(await file.arrayBuffer())
    await saveShareBundleFile(bundle.id, bytes)
  } catch (err) {
    await deleteShareBundleDir(bundle.id).catch(() => {})
    await db.shareBundle.delete({ where: { id: bundle.id } }).catch(() => {})
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Could not save the bundle file." },
      { status: 500 }
    )
  }

  const recipients = await db.shareRecipient.findMany({ where: { bundleId: bundle.id } })

  const shouldAttach = file.size <= ATTACH_MAX_BYTES
  const attachmentBuffer = shouldAttach ? await readShareBundleFile(bundle.id) : null
  const manifestText = renderShareReadme(kind, manifest)

  const results: { recipientId: string; email: string; sent: boolean; error?: string; downloadUrl: string }[] = []

  // Sequential, never Promise.all — Resend rate-limits sends, and a
  // mid-list failure must be attributable to exactly one recipient rather
  // than an ambiguous aggregate rejection (the "per-recipient partial
  // success" policy documented in email.ts).
  for (const r of recipients) {
    const downloadUrl = shareUrl(r.token)
    try {
      await sendShareBundleEmail({
        to: r.email,
        replyTo: senderEmail,
        senderName: session.user.name,
        kind,
        jobName: camJob.name,
        message,
        downloadUrl,
        expiresAt,
        manifestText,
        attachment: attachmentBuffer ? { filename: bundle.fileName, content: attachmentBuffer } : null,
      })
      await db.shareRecipient.update({
        where: { id: r.id },
        data: { sentAt: new Date(), sendError: null, attached: shouldAttach },
      })
      results.push({ recipientId: r.id, email: r.email, sent: true, downloadUrl })
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Send failed."
      await db.shareRecipient.update({ where: { id: r.id }, data: { sendError: errorMessage } })
      results.push({ recipientId: r.id, email: r.email, sent: false, error: errorMessage, downloadUrl })
    }
  }

  return NextResponse.json(
    {
      id: bundle.id,
      kind: bundle.kind,
      fileName: bundle.fileName,
      fileSize: bundle.fileSize,
      expiresAt: bundle.expiresAt,
      recipients: results,
    },
    { status: 201 }
  )
}
