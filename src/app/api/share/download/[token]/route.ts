import { db } from "@/lib/db"
import { readShareBundleStream, statShareBundleFile } from "@/lib/share-files"
import { isTokenUsable } from "@/lib/share/tokens"

export const dynamic = "force-dynamic"

/**
 * The app's only unauthenticated, externally-linkable, repeatedly-hittable
 * route — an emailed link can be clicked any number of times over 30 days,
 * including by link-scanners that fetch it automatically. Streams the file
 * rather than following the existing full-buffer
 * `new NextResponse(new Uint8Array(await readFile()))` precedent every
 * other file route in this app uses — see share-files.ts's own
 * readShareBundleStream doc comment for why that precedent is wrong here
 * specifically.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params

  const recipient = await db.shareRecipient.findUnique({
    where: { token },
    include: { bundle: true },
  })
  if (!recipient) {
    return Response.json({ error: "This link is invalid." }, { status: 404 })
  }
  if (!isTokenUsable(recipient.bundle, recipient)) {
    return Response.json({ error: "This link has expired or been revoked." }, { status: 410 })
  }

  const stat = await statShareBundleFile(recipient.bundle.id)
  if (!stat) {
    return Response.json({ error: "The file for this link is no longer available." }, { status: 404 })
  }

  // Landing-page views (share/[token]/page.tsx) deliberately do NOT bump
  // this — only a real download attempt does, keeping "accessed" as close
  // to "someone actually tried to get the files" as this app can honestly
  // claim (still not proof a human saw them — see firstAccessedAt's own
  // schema comment).
  await db.shareRecipient.update({
    where: { id: recipient.id },
    data: {
      firstAccessedAt: recipient.firstAccessedAt ?? new Date(),
      lastAccessedAt: new Date(),
      accessCount: { increment: 1 },
    },
  })

  const webStream = await readShareBundleStream(recipient.bundle.id)

  return new Response(webStream, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${recipient.bundle.fileName.replace(/"/g, "")}"`,
      "Content-Length": String(stat.size),
      "Cache-Control": "no-store",
    },
  })
}
