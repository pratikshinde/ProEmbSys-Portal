import { NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { db } from "@/lib/db"
import { readShareBundleFile } from "@/lib/share-files"
import { shareUrl } from "@/lib/share/tokens"
import { renderShareReadme, type FilmManifest, type DrillManifest, type TestManifest } from "@/lib/share/manifest"
import { sendShareBundleEmail } from "@/lib/email"

const ATTACH_MAX_BYTES = parseInt(process.env.SHARE_ATTACH_MAX_BYTES ?? "6291456", 10)

/** Owner-only (the sender, never the recipient or staff) — a recipient has
 *  no login of their own to authenticate as, and revoke/resend are sender
 *  actions. Includes the bundle's own CamJob for its name (needed by resend
 *  for the email subject/intro; the bundle itself doesn't denormalize it). */
async function loadOwnRecipient(bundleId: string, recipientId: string, userId: string) {
  const recipient = await db.shareRecipient.findUnique({
    where: { id: recipientId },
    include: { bundle: { include: { camJob: { select: { name: true } } } } },
  })
  if (!recipient || recipient.bundleId !== bundleId || recipient.bundle.userId !== userId) return null
  return recipient
}

/**
 * PATCH { revoked: boolean } — flips ShareRecipient.revokedAt. Deliberately
 * NOT a single-use "usedAt" the way PasswordResetToken works: a 30-day
 * multi-use link a plotter opens on their phone and again at a shop PC must
 * keep working until the sender explicitly revokes it or it expires.
 *
 * PATCH { resend: true } — re-sends to the SAME token/link (never
 * regenerates it — a resend must reach the same URL the recipient may have
 * already bookmarked), using the bundle's own stored manifest/message, and
 * re-reading the already-saved ZIP off disk for the attachment decision
 * rather than needing the browser to re-upload anything.
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string; rid: string }> }) {
  const { id, rid } = await params
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const recipient = await loadOwnRecipient(id, rid, session.user.id)
  if (!recipient) return NextResponse.json({ error: "Not found" }, { status: 404 })

  const body = await req.json().catch(() => ({}))

  if (typeof body?.revoked === "boolean") {
    const updated = await db.shareRecipient.update({
      where: { id: rid },
      data: { revokedAt: body.revoked ? new Date() : null },
    })
    return NextResponse.json({ id: updated.id, revokedAt: updated.revokedAt })
  }

  if (body?.resend === true) {
    if (recipient.bundle.expiresAt.getTime() < Date.now()) {
      return NextResponse.json({ error: "This share has expired." }, { status: 400 })
    }
    if (recipient.revokedAt) {
      return NextResponse.json(
        { error: "This recipient's link is revoked — un-revoke it before resending." },
        { status: 400 }
      )
    }
    const senderEmail = session.user.email
    if (!senderEmail) {
      return NextResponse.json({ error: "Your account has no email on file." }, { status: 500 })
    }

    const shouldAttach = recipient.bundle.fileSize <= ATTACH_MAX_BYTES
    const attachmentBuffer = shouldAttach ? await readShareBundleFile(recipient.bundle.id).catch(() => null) : null
    const manifestText = renderShareReadme(
      recipient.bundle.kind,
      recipient.bundle.manifest as unknown as FilmManifest | DrillManifest | TestManifest
    )

    try {
      await sendShareBundleEmail({
        to: recipient.email,
        replyTo: senderEmail,
        senderName: session.user.name,
        kind: recipient.bundle.kind,
        jobName: recipient.bundle.camJob.name,
        message: recipient.bundle.message,
        downloadUrl: shareUrl(recipient.token),
        expiresAt: recipient.bundle.expiresAt,
        manifestText,
        attachment: attachmentBuffer ? { filename: recipient.bundle.fileName, content: attachmentBuffer } : null,
      })
      const updated = await db.shareRecipient.update({
        where: { id: rid },
        data: { sentAt: new Date(), sendError: null, attached: !!attachmentBuffer },
      })
      return NextResponse.json({ id: updated.id, sentAt: updated.sentAt, sendError: updated.sendError })
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Send failed."
      await db.shareRecipient.update({ where: { id: rid }, data: { sendError: errorMessage } })
      return NextResponse.json({ error: errorMessage }, { status: 502 })
    }
  }

  return NextResponse.json({ error: "Nothing to update." }, { status: 400 })
}
