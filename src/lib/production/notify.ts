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
