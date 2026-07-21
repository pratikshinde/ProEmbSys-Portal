import { AddressType } from "@prisma/client"
import { db } from "@/lib/db"
import type { AddressSnapshot } from "@/lib/format-address"

/**
 * Loads a saved Address row and copies it into a plain JSON snapshot for
 * storing on an order — Address rows are editable/deletable by the customer,
 * so a live foreign key would let a placed order's shipping details silently
 * change or break later. Returns:
 * - `null` if no addressId was given (address optional / not selected)
 * - `undefined` if addressId was given but doesn't resolve to a real address
 *   owned by this user with the expected type (caller should treat as invalid)
 * - the snapshot otherwise
 *
 * Shared by PCB order creation (src/app/api/orders/route.ts) and Shop
 * checkout (src/app/api/shop/checkout/route.ts).
 */
export async function loadAddressSnapshot(
  userId: string,
  addressId: string | undefined,
  type: AddressType
): Promise<AddressSnapshot | null | undefined> {
  if (!addressId) return null
  const address = await db.address.findUnique({ where: { id: addressId } })
  if (!address || address.userId !== userId || address.type !== type) return undefined
  const { label, line1, line2, city, state, postalCode, country, gstNumber } = address
  return { label, line1, line2, city, state, postalCode, country, gstNumber }
}
