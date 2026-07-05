import { NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { db } from "@/lib/db"
import { readOrderFile } from "@/lib/order-files"

const CONTENT_TYPES: Record<string, string> = {
  zip: "application/zip",
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const session = await auth()
  if (!session?.user) return new NextResponse(null, { status: 401 })

  const order = await db.order.findUnique({ where: { id } })
  if (!order) return new NextResponse(null, { status: 404 })

  const isStaff = session.user.role === "ADMIN" || session.user.role === "ENGINEER"
  if (!isStaff && order.userId !== session.user.id) {
    return new NextResponse(null, { status: 403 })
  }
  if (!order.gerberFilePath) return new NextResponse(null, { status: 404 })

  try {
    const data = await readOrderFile(order.gerberFilePath)
    const ext = order.gerberFilePath.split(".").pop()?.toLowerCase() ?? ""
    const downloadName = order.fileName ?? order.gerberFilePath
    return new NextResponse(new Uint8Array(data), {
      headers: {
        "Content-Type": CONTENT_TYPES[ext] ?? "application/octet-stream",
        "Content-Disposition": `attachment; filename="${downloadName.replace(/"/g, "")}"`,
      },
    })
  } catch {
    return new NextResponse(null, { status: 404 })
  }
}
