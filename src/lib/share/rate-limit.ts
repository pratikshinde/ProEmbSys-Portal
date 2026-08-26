/**
 * DB-backed rate limiter for POST /api/share — the app's first
 * abuse-sensitive endpoint (any signed-in user can trigger an email send +
 * disk write). Deliberately NOT generic middleware: middleware.ts only
 * matches /admin/:path*, and pulling /api/** into the Edge matcher risks
 * the documented auth.config/Prisma split (middleware must stay Edge-safe;
 * this counter needs a real DB round trip). The increment is a single
 * atomic upsert, the exact pattern generateOrderReference already
 * establishes for OrderSequence — "never derive the count by reading then
 * writing, concurrent requests would race and collide".
 */
import { db } from '@/lib/db'

const PER_USER_LIMIT = parseInt(process.env.SHARE_RATE_PER_HOUR ?? '20', 10)
// No separate env var for this — a single-instance shop app has no
// legitimate reason to send hundreds of share emails an hour; this exists
// to catch a compromised session or a runaway client loop, not to tune
// per-deployment.
const GLOBAL_LIMIT = 200

function hourKey(date: Date): string {
  const y = date.getUTCFullYear()
  const m = String(date.getUTCMonth() + 1).padStart(2, '0')
  const d = String(date.getUTCDate()).padStart(2, '0')
  const h = String(date.getUTCHours()).padStart(2, '0')
  return `${y}${m}${d}${h}`
}

export interface ShareQuotaResult {
  allowed: boolean
  /** Seconds until the current hour window rolls over — only set when
   *  `allowed` is false, for a `Retry-After` header. */
  retryAfterSeconds?: number
}

/**
 * Increments both the per-user and the global hourly counters (an attempt
 * counts against quota whether it's ultimately allowed or not — otherwise a
 * flood of already-rejected requests costs nothing) and reports whether
 * EITHER limit was exceeded.
 */
export async function consumeShareQuota(userId: string): Promise<ShareQuotaResult> {
  const now = new Date()
  const hour = hourKey(now)
  const userKey = `user:${userId}:${hour}`
  const globalKey = `global:${hour}`

  const [userCounter, globalCounter] = await db.$transaction([
    db.shareRateCounter.upsert({
      where: { key: userKey },
      create: { key: userKey, windowStart: now, count: 1 },
      update: { count: { increment: 1 } },
    }),
    db.shareRateCounter.upsert({
      where: { key: globalKey },
      create: { key: globalKey, windowStart: now, count: 1 },
      update: { count: { increment: 1 } },
    }),
  ])

  if (userCounter.count > PER_USER_LIMIT || globalCounter.count > GLOBAL_LIMIT) {
    const nextHour = new Date(now)
    nextHour.setUTCHours(nextHour.getUTCHours() + 1, 0, 0, 0)
    const retryAfterSeconds = Math.max(1, Math.ceil((nextHour.getTime() - now.getTime()) / 1000))
    return { allowed: false, retryAfterSeconds }
  }
  return { allowed: true }
}
