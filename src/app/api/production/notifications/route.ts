import { NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { db } from "@/lib/db"

/** The current user's in-app notifications (newest first) + unread count. */
export async function GET() {
  const session = await auth()
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const [items, unread] = await Promise.all([
    db.inAppNotification.findMany({
      where: { userId: session.user.id },
      orderBy: { createdAt: "desc" },
      take: 30,
    }),
    db.inAppNotification.count({ where: { userId: session.user.id, readAt: null } }),
  ])

  return NextResponse.json({
    unread,
    items: items.map((n) => ({
      id: n.id,
      title: n.title,
      body: n.body,
      deeplink: n.deeplink,
      read: n.readAt !== null,
      createdAt: n.createdAt,
    })),
  })
}
