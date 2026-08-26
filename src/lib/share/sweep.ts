import { db } from '@/lib/db'
import { deleteShareBundleDir } from '@/lib/share-files'

/**
 * There is no cron in this app (see the Order/DFM/routing "nothing
 * auto-computes" convention, and CLAUDE.md's own note that no queue/cron
 * exists anywhere yet) — so expiry cleanup piggybacks on the one place that's
 * guaranteed to run periodically in practice: every POST /api/share.
 *
 * Reuses ShareRateCounter as a throttle marker (key "sweep:marker") rather
 * than adding a fifth model just to remember "when did we last sweep" — the
 * table already exists for exactly this shape of data (a key + a timestamp),
 * and `windowStart` on this row means "last swept at", not "current hour
 * window" the way it does for the real rate-limit keys.
 *
 * A failed sweep must never fail a send — the caller wraps this in a
 * best-effort try/catch and logs, never awaits it as a hard precondition.
 */
const SWEEP_MARKER_KEY = 'sweep:marker'
const SWEEP_INTERVAL_MS = 60 * 60 * 1000 // at most once per hour

export async function sweepExpiredBundlesIfDue(): Promise<void> {
  const marker = await db.shareRateCounter.findUnique({ where: { key: SWEEP_MARKER_KEY } })
  const now = new Date()
  if (marker && now.getTime() - marker.windowStart.getTime() < SWEEP_INTERVAL_MS) return

  // Claim the marker first (upsert to now) so two near-simultaneous requests
  // don't both run the sweep — the loser just sees a fresh windowStart and
  // skips, same "atomic upsert as a lock" idea as the rate counters proper.
  await db.shareRateCounter.upsert({
    where: { key: SWEEP_MARKER_KEY },
    create: { key: SWEEP_MARKER_KEY, windowStart: now, count: 1 },
    update: { windowStart: now, count: { increment: 1 } },
  })

  await sweepExpiredBundles()
}

/** The actual sweep — exported separately so a future admin action or real
 *  cron job (Phase 6) can call it directly, bypassing the throttle. */
export async function sweepExpiredBundles(): Promise<{ deleted: number }> {
  const expired = await db.shareBundle.findMany({
    where: { expiresAt: { lt: new Date() } },
    select: { id: true },
  })
  if (expired.length === 0) return { deleted: 0 }

  for (const bundle of expired) {
    // Disk-then-DB, and tolerate a missing dir — a bundle can be swept twice
    // if a previous sweep died between the two steps.
    await deleteShareBundleDir(bundle.id).catch(() => {})
  }
  await db.shareBundle.deleteMany({ where: { id: { in: expired.map((b) => b.id) } } })
  return { deleted: expired.length }
}
