import type { Prisma } from "@prisma/client"

export interface AddressSnapshot {
  label: string | null
  line1: string
  line2: string | null
  city: string
  state: string
  postalCode: string
  country: string
  gstNumber: string | null
}

/** Order.deliveryAddress/billingAddress are typed as Prisma.JsonValue — this
 *  narrows the snapshot shape written by /api/orders back into a usable type. */
export function asAddressSnapshot(value: Prisma.JsonValue | null): AddressSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  return value as unknown as AddressSnapshot
}

export function formatAddressSnapshot(a: AddressSnapshot): string {
  return `${a.label ? a.label + " — " : ""}${a.line1}${a.line2 ? ", " + a.line2 : ""}, ${a.city}, ${a.state} ${a.postalCode}, ${a.country}`
}
