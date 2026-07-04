import { NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { canAccessThread } from "@/lib/messaging"
import { readMessageAttachment } from "@/lib/attachments"

const CONTENT_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ threadId: string; filename: string }> }
) {
  const { threadId, filename } = await params
  const session = await auth()
  if (!session?.user) return new NextResponse(null, { status: 401 })
  if (!(await canAccessThread(threadId, session.user))) {
    return new NextResponse(null, { status: 403 })
  }

  try {
    const data = await readMessageAttachment(`${threadId}/${filename}`)
    const ext = filename.split(".").pop()?.toLowerCase() ?? ""
    return new NextResponse(new Uint8Array(data), {
      headers: {
        "Content-Type": CONTENT_TYPES[ext] ?? "application/octet-stream",
        "Cache-Control": "private, max-age=31536000, immutable",
      },
    })
  } catch {
    return new NextResponse(null, { status: 404 })
  }
}
