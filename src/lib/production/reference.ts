import type { Prisma, PrismaClient } from "@prisma/client"
import { istPeriod } from "@/lib/order-reference"

type PrismaClientOrTx = PrismaClient | Prisma.TransactionClient

/**
 * Next Work Order reference: WO-YYYYMMDD-NNNN, NNNN resetting each IST day.
 *
 * Uses its own `production_daily_counters` table (kept from the earlier
 * stand-alone MES) rather than `order-reference.ts`'s `order_sequences` — the
 * WO numbers already in the database came from this counter, so switching
 * would risk a collision. The atomic upsert-increment guarantees uniqueness
 * under concurrency; pass the transaction client so a rollback undoes the
 * increment.
 */
export async function generateWorkOrderReference(
  client: PrismaClientOrTx,
  date: Date = new Date()
): Promise<string> {
  const period = istPeriod(date)
  const counter = await client.dailyCounter.upsert({
    where: { day: period },
    create: { day: period, lastValue: 1 },
    update: { lastValue: { increment: 1 } },
  })
  return `WO-${period}-${String(counter.lastValue).padStart(4, "0")}`
}
