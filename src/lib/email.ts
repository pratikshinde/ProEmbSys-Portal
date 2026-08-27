import { Resend } from "resend"
import { mkdir, writeFile } from "fs/promises"
import path from "path"

// Lazily constructed — the Resend SDK throws in its constructor if the key is
// missing/empty, which breaks Next.js's build-time route analysis (every
// route module gets imported to collect page data, even if it's never
// called). Constructing it inside the function means a missing key only
// fails when an email is actually sent, not at build time.
//
// Memoized after first construction (added for the sharing feature, which is
// the first caller to send several emails within one request — one per
// recipient, sequentially) so a multi-recipient share doesn't re-parse
// RESEND_API_KEY and rebuild the SDK's internal HTTP client N times.
let resendClient: Resend | null = null
function getResendClient() {
  if (!resendClient) resendClient = new Resend(process.env.RESEND_API_KEY)
  return resendClient
}

/** Minimal HTML-entity escaping for user-supplied text landing in an email
 *  body. Every template below this point interpolates only enum/server-built
 *  values (role, a token-based URL) which are safe without it — the sharing
 *  feature is the first to put free-text (a job name, a sender's own message)
 *  into a template, so this becomes mandatory there. */
export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

const FROM = process.env.EMAIL_FROM ?? "ProPCB <noreply@propcb.local>"

// The Resend SDK does NOT throw on API-level failures (e.g. an invalid or
// placeholder API key) — send() resolves with { data, error } either way.
// Callers rely on a thrown error to detect "email didn't actually go out"
// (e.g. the staff-creation flow's emailSent fallback), so surface `error`
// as a real exception here rather than letting it pass silently.
function throwIfFailed(result: { error: { message: string } | null }) {
  if (result.error) throw new Error(result.error.message)
}

export async function sendPasswordResetEmail(to: string, resetUrl: string) {
  const result = await getResendClient().emails.send({
    from: FROM,
    to,
    subject: "Reset your ProPCB password",
    html: `
      <p>We received a request to reset your ProPCB account password.</p>
      <p><a href="${resetUrl}">Click here to set a new password</a> — this link expires in 1 hour.</p>
      <p>If you didn't request this, you can safely ignore this email.</p>
    `,
  })
  throwIfFailed(result)
}

export async function sendStaffWelcomeEmail(to: string, role: string, setPasswordUrl: string) {
  const result = await getResendClient().emails.send({
    from: FROM,
    to,
    subject: "You've been added to the ProPCB team",
    html: `
      <p>An admin has created a ProPCB staff account for you with the role <strong>${role}</strong>.</p>
      <p><a href="${setPasswordUrl}">Click here to set your password</a> — this link expires in 1 hour.</p>
    `,
  })
  throwIfFailed(result)
}

const SHARE_KIND_LABEL: Record<"FILM" | "DRILL" | "TEST", string> = {
  FILM: "Film Plot Files",
  DRILL: "Drilling Files",
  TEST: "Bare-Board Test Files",
}

export interface ShareBundleEmailInput {
  to: string
  /** The sending user's own address — replies must reach them, not a
   *  noreply void, since a plotter/driller genuinely will reply with a
   *  clarifying question. */
  replyTo: string
  senderName?: string | null
  kind: "FILM" | "DRILL" | "TEST"
  jobName: string
  /** Optional free-text note from the sender — escaped before use. */
  message?: string | null
  downloadUrl: string
  expiresAt: Date
  /** The rendered README text (renderFilmReadme/renderDrillReadme/
   *  renderTestReadme from share/manifest.ts) — reused verbatim as the
   *  email body's detail section so the in-ZIP README and the email can
   *  never say something different. */
  manifestText: string
  attachment?: { filename: string; content: Buffer } | null
}

/**
 * Per-recipient send for the sharing feature — the caller (POST /api/share)
 * invokes this once per recipient, sequentially, never Promise.all, so a
 * mid-list failure is attributable to one recipient and doesn't cancel the
 * rest. Unlike every other email in this file, failure here is NOT thrown
 * back to a caller that aborts the whole request — POST /api/share catches
 * per-call and records `sendError` on that one ShareRecipient row, which is
 * why this still throws (via throwIfFailed) rather than swallowing: the
 * caller's per-recipient try/catch is the actual policy, this function just
 * reports honestly.
 */
/**
 * Set SHARE_EMAIL_DRY_RUN to skip calling Resend entirely for share emails
 * — writes the rendered HTML/text to disk instead, so the whole
 * POST /api/share flow (bundle creation, disk write, DB rows marked sent)
 * completes successfully without a real Resend account. Exists specifically
 * because RESEND_API_KEY is a placeholder in most dev setups, and
 * "API key is invalid" (Resend's own error text, surfaced verbatim via
 * throwIfFailed) is otherwise the ONLY way to exercise sharing end-to-end
 * locally. Scoped to share emails only — password reset / staff welcome
 * keep their existing behavior, since dry-running an auth flow isn't useful
 * the same way.
 */
async function writeDryRunEmail(input: { to: string; subject: string; html: string; text: string }): Promise<string> {
  const dir = path.join(process.env.UPLOADS_DIR ?? path.join(process.cwd(), "uploads"), "share-dry-run")
  await mkdir(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, "-")
  const safeTo = input.to.replace(/[^a-z0-9@._-]/gi, "_")
  const base = `${stamp}-${safeTo}`
  await writeFile(path.join(dir, `${base}.html`), `<title>${input.subject}</title>\n${input.html}`, "utf8")
  await writeFile(path.join(dir, `${base}.txt`), input.text, "utf8")
  return path.join(dir, `${base}.html`)
}

export async function sendShareBundleEmail(input: ShareBundleEmailInput): Promise<{ id: string | null; dryRun: boolean }> {
  const kindLabel = SHARE_KIND_LABEL[input.kind]
  const expiresLabel = input.expiresAt.toLocaleDateString("en-IN", {
    year: "numeric",
    month: "long",
    day: "numeric",
  })
  const intro = input.senderName
    ? `${input.senderName} shared ${kindLabel.toLowerCase()} for "${input.jobName}" with you via ProPCB.`
    : `${kindLabel} for "${input.jobName}" were shared with you via ProPCB.`

  const text = [
    intro,
    input.message ? `\nMessage:\n${input.message}` : "",
    `\nDownload: ${input.downloadUrl}`,
    `This link expires on ${expiresLabel}.`,
    input.attachment ? "The files are also attached to this email." : "",
    "",
    input.manifestText,
  ]
    .filter((line) => line !== "")
    .join("\n")

  const html = `
    <p>${escapeHtml(intro)}</p>
    ${input.message ? `<p>${escapeHtml(input.message).replace(/\n/g, "<br/>")}</p>` : ""}
    <p><a href="${input.downloadUrl}">Download files</a> — this link expires on ${expiresLabel}.</p>
    ${input.attachment ? "<p>The files are also attached to this email.</p>" : ""}
    <pre style="white-space:pre-wrap;font-family:monospace;font-size:12px;background:#f5f5f5;padding:12px;border-radius:4px;">${escapeHtml(input.manifestText)}</pre>
  `

  const subject = `${kindLabel} — ${input.jobName}`

  if (process.env.SHARE_EMAIL_DRY_RUN) {
    const filePath = await writeDryRunEmail({ to: input.to, subject, html, text })
    console.log(`[share] DRY RUN — email to ${input.to} not sent (SHARE_EMAIL_DRY_RUN is set). Rendered to ${filePath}`)
    return { id: null, dryRun: true }
  }

  const result = await getResendClient().emails.send({
    from: FROM,
    to: input.to,
    replyTo: input.replyTo,
    subject,
    text,
    html,
    attachments: input.attachment
      ? [{ filename: input.attachment.filename, content: input.attachment.content }]
      : undefined,
  })
  throwIfFailed(result)
  return { id: result.data?.id ?? null, dryRun: false }
}
