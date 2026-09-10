import { NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { db } from "@/lib/db"
import { isStaff } from "@/lib/roles"
import { readPanelFile } from "@/lib/production/panel-files"

/** Serves the panel image (SVG) for a job — staff, or the assigned operator. */
export async function GET(_req: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { jobId } = await params
  const job = await db.productionJob.findUnique({
    where: { id: jobId },
    select: { panelImagePath: true, assignedToId: true },
  })
  if (!job?.panelImagePath) return NextResponse.json({ error: "No panel image" }, { status: 404 })
  if (!isStaff(session.user.role) && job.assignedToId !== session.user.id) {
    return NextResponse.json({ error: "Not found" }, { status: 404 })
  }

  try {
    const buf = await readPanelFile(job.panelImagePath)
    let svg = buf.toString("utf8")
    // The CAM viewer draws light-grey rib text ("customer : board name") for a
    // dark UI; on a transparent background it's invisible on a white page.
    // Older captures have no backdrop — inject the viewer's dark one so the
    // text stays readable everywhere, including when opened on its own.
    if (svg.includes("<svg") && !svg.includes("data-panel-bg")) {
      svg = svg.replace(
        /(<svg\b[^>]*>)/,
        `$1<rect data-panel-bg="1" x="-100000" y="-100000" width="200000" height="200000" fill="#020d1f"/>`
      )
    }
    return new NextResponse(svg, {
      headers: {
        "Content-Type": "image/svg+xml",
        "Cache-Control": "private, max-age=86400",
      },
    })
  } catch {
    return NextResponse.json({ error: "Not found" }, { status: 404 })
  }
}
