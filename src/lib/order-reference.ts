import type { Prisma, PrismaClient } from "@prisma/client"

const IST_DATE_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Kolkata",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
})

/** "YYYYMMDD" for the given instant, in India Standard Time — the business
 *  operates out of Bangalore, so "today" for order numbering should follow
 *  IST, not the server's (likely UTC) local time or the client's timezone. */
export function istPeriod(date: Date): string {
  // en-CA locale formats as YYYY-MM-DD; strip the dashes.
  return IST_DATE_FORMATTER.format(date).replaceAll("-", "")
}

type PrismaClientOrTx = PrismaClient | Prisma.TransactionClient

/**
 * Generates the next order reference for the given day: PCB-YYYYMMDD-NNNN,
 * where NNNN resets to 0001 each new IST day. The upsert's increment is a
 * single atomic Postgres UPDATE (or INSERT..ON CONFLICT for a new day), so
 * concurrent order placements on the same day can never receive the same
 * number. Pass the transaction client (not the top-level `db`) when calling
 * this from inside an order-creation transaction, so a rollback also undoes
 * the increment instead of leaving a gap.
 */
export async function generateOrderReference(client: PrismaClientOrTx, date: Date = new Date()): Promise<string> {
  const period = istPeriod(date)
  const seq = await client.orderSequence.upsert({
    where: { period },
    create: { period, lastValue: 1 },
    update: { lastValue: { increment: 1 } },
  })
  return `PCB-${period}-${String(seq.lastValue).padStart(4, "0")}`
}
