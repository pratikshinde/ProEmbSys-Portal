import { NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { db } from "@/lib/db"
import { shareUrl } from "@/lib/share/tokens"

/**
 * A job's (or the signed-in user's whole) share history — the "outbox" the
 * Sharing tab reads to show past sends alongside the compose form. Scoped
 * to the sender only; recipients never get a list view, only their own
 * token's landing page (/share/[token]).
 *
 * Deliberately lean, same "don't over-fetch" fix Phase 1 applied to
 * GET /api/cam-jobs — the full `manifest` JSON is left to the [id] detail
 * route, since a history list only needs enough to render one row per send.
 */
export async function GET(req: Request) {
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const url = new URL(req.url)
  const camJobId = url.searchParams.get("camJobId")

  const bundles = await db.shareBundle.findMany({
    where: { userId: session.user.id, ...(camJobId ? { camJobId } : {}) },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      camJobId: true,
      orderId: true,
      kind: true,
      fileName: true,
      fileSize: true,
      expiresAt: true,
      createdAt: true,
      recipients: {
        select: {
          id: true,
          email: true,
          name: true,
          sentAt: true,
          sendError: true,
          attached: true,
          firstAccessedAt: true,
          lastAccessedAt: true,
          accessCount: true,
          revokedAt: true,
          token: true,
        },
      },
    },
  })

  return NextResponse.json({
    bundles: bundles.map((b) => ({
      id: b.id,
      camJobId: b.camJobId,
      orderId: b.orderId,
      kind: b.kind,
      fileName: b.fileName,
      fileSize: b.fileSize,
      expiresAt: b.expiresAt,
      createdAt: b.createdAt,
      recipients: b.recipients.map((r) => ({
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
    })),
  })
}
