/**
 * Staff-only route gate — extracted from the two DFM admin routes (which had
 * it copy-pasted identically) so a third and fourth copy for the panel
 * template admin routes doesn't make four. Mirrors /api/admin/products.
 */

import { auth } from "@/lib/auth"

export async function requireStaff() {
  const session = await auth()
  if (!session?.user || (session.user.role !== "ADMIN" && session.user.role !== "ENGINEER")) return null
  return session
}
