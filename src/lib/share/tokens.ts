import crypto from 'crypto'

/** 32 random bytes, hex — see ShareRecipient.token's own schema comment for
 *  why this is plaintext and multi-use, unlike PasswordResetToken. */
export function generateShareToken(): string {
  return crypto.randomBytes(32).toString('hex')
}

/**
 * Builds the public share-link URL for a token. Reads APP_URL directly
 * (rather than the "caller builds the URL, email.ts just takes it" pattern
 * forgot-password/staff-welcome use) because THREE call sites need this
 * exact URL — the email body, the API response (so the sender can "copy
 * link" without re-deriving it), and the resend/extend actions — and
 * repeating `${process.env.APP_URL ?? "http://localhost:3000"}/share/${token}`
 * at three call sites is exactly how the fallback value drifts.
 */
export function shareUrl(token: string): string {
  const base = process.env.APP_URL ?? 'http://localhost:3000'
  return `${base}/share/${token}`
}

/**
 * A share link is usable iff it hasn't been individually revoked AND its
 * bundle hasn't expired — the two independent ways a 30-day, multi-use link
 * stops working (see ShareBundle.expiresAt / ShareRecipient.revokedAt's own
 * comments for why there is no third, single-use "already used" state).
 */
export function isTokenUsable(bundle: { expiresAt: Date }, recipient: { revokedAt: Date | null }): boolean {
  if (recipient.revokedAt) return false
  if (bundle.expiresAt.getTime() < Date.now()) return false
  return true
}

/**
 * Per-reason version of isTokenUsable's check, for the public landing page
 * (share/[token]/page.tsx) to show a specific one-line message. Deliberately
 * lives here rather than inline in that page component — the page is a
 * React Server Component, and this project's ESLint config (react-hooks'
 * experimental purity rule) flags a bare `Date.now()` call inside any .tsx
 * component body as an impure render call, even though a Server Component
 * has no re-render lifecycle for that to actually destabilize. Isolating
 * the clock read to this plain .ts helper sidesteps the false positive
 * instead of fighting the linter.
 */
export function shareRecipientProblem(
  recipient: { revokedAt: Date | null; bundle: { expiresAt: Date } } | null
): string | null {
  if (!recipient) return "This link is invalid. Double-check the URL, or ask the sender to share again."
  if (recipient.revokedAt) return "This link has been revoked by the sender."
  if (recipient.bundle.expiresAt.getTime() < Date.now()) return "This link has expired. Ask the sender for a new one."
  return null
}
