import type { Prisma } from "@prisma/client"

type Tx = Prisma.TransactionClient

/**
 * Drop an in-app notification for a user. Call from inside the same
 * transaction as the state change it reports, so a rolled-back action never
 * leaves a phantom notification. Read back via GET /api/production/notifications.
 */
export async function notifyUser(
  tx: Tx,
  userId: string | null | undefined,
  n: { title: string; body: string; deeplink: string }
): Promise<void> {
  if (!userId) return
  await tx.inAppNotification.create({
    data: { userId, title: n.title, body: n.body, deeplink: n.deeplink },
  })
}

/**
 * Drop an in-app notification for all active staff (ADMIN and ENGINEER) plus
 * an optional creator user ID if not already included.
 */
export async function notifyStaff(
  tx: Tx,
  n: { title: string; body: string; deeplink: string },
  additionalUserId?: string | null
): Promise<void> {
  const staff = await tx.user.findMany({
    where: {
      role: { in: ["ADMIN", "ENGINEER"] },
      isActive: true,
    },
    select: { id: true },
  })
  const userIds = new Set(staff.map((s) => s.id))
  if (additionalUserId) userIds.add(additionalUserId)
  if (userIds.size === 0) return

  await tx.inAppNotification.createMany({
    data: Array.from(userIds).map((userId) => ({
      userId,
      title: n.title,
      body: n.body,
      deeplink: n.deeplink,
    })),
  })
}
