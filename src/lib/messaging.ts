import { db } from "@/lib/db"

/** Shared by the thread API route and the attachment-serving route — both
 *  need the same "can this user see this thread" check. */
export async function canAccessThread(threadId: string, user: { id: string; role: string }): Promise<boolean> {
  if (user.role === "ADMIN" || user.role === "ENGINEER") return true
  const thread = await db.messageThread.findUnique({ where: { id: threadId }, include: { order: true } })
  if (!thread) return false
  return thread.createdById === user.id || thread.order?.userId === user.id
}
