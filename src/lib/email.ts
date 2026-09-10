import { Resend } from "resend"
import nodemailer, { type Transporter } from "nodemailer"
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

// Gmail SMTP transport — the default provider (see EMAIL_PROVIDER below).
// Adopted because Resend requires a verified sending domain to reach
// arbitrary recipients, and this project's domain (propcb.in, on Bigrock/
// cPanel) hit SPF/verification friction; Gmail SMTP with an App Password
// works immediately against any real inbox. Same lazy+memoized construction
// as getResendClient, same reason (build-time route collection must not
// throw on a missing credential). nodemailer's `service: 'gmail'` shorthand
// resolves the right SMTP host/port/TLS settings — no need to hardcode
// smtp.gmail.com here.
let gmailTransport: Transporter | null = null
function getGmailTransport(): Transporter {
  if (!gmailTransport) {
    gmailTransport = nodemailer.createTransport({
      service: "gmail",
      auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
    })
  }
  return gmailTransport
}

interface OutgoingEmail {
  to: string
  /** Gmail SMTP rewrites/rejects a From that doesn't match the
   *  authenticated account, so this is only actually honored on the Resend
   *  path — see EMAIL_FROM's own docs in .env.example. */
  from: string
  replyTo?: string
  subject: string
  html: string
  text: string
  attachments?: { filename: string; content: Buffer }[]
}

/**
 * The one place either provider is actually called — every exported
 * function below builds an OutgoingEmail and hands it here, so callers never
 * need to know which provider is live. Branches on EMAIL_PROVIDER
 * ("resend" | anything else, including unset, which defaults to Gmail —
 * see .env.example). Both branches throw on a real failure (mirroring the
 * pre-existing throwIfFailed contract) so every caller's existing
 * success/failure branching (e.g. the staff-creation emailSent flag, or
 * forgot-password's try/catch) keeps working unchanged regardless of
 * provider.
 */
async function sendEmail(email: OutgoingEmail): Promise<{ id: string | null }> {
  if (process.env.EMAIL_PROVIDER === "resend") {
    const result = await getResendClient().emails.send({
      from: email.from,
      to: email.to,
      replyTo: email.replyTo,
      subject: email.subject,
      text: email.text,
      html: email.html,
      attachments: email.attachments,
    })
    throwIfFailed(result)
    return { id: result.data?.id ?? null }
  }

  const info = await getGmailTransport().sendMail({
    from: email.from,
    to: email.to,
    replyTo: email.replyTo,
    subject: email.subject,
    text: email.text,
    html: email.html,
    attachments: email.attachments,
  })
  // nodemailer throws on a hard SMTP failure (auth rejected, connection
  // refused), unlike Resend's { data, error } shape — nothing further to
  // check here, a resolved sendMail() means Gmail accepted the message.
  return { id: info.messageId ?? null }
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
  await sendEmail({
    from: FROM,
    to,
    subject: "Reset your ProPCB password",
    text: `We received a request to reset your ProPCB account password.\n\nSet a new password: ${resetUrl}\n\nThis link expires in 1 hour. If you didn't request this, you can safely ignore this email.`,
    html: `
      <p>We received a request to reset your ProPCB account password.</p>
      <p><a href="${resetUrl}">Click here to set a new password</a> — this link expires in 1 hour.</p>
      <p>If you didn't request this, you can safely ignore this email.</p>
    `,
  })
}

/** Shop-floor operator self-registration — confirm the email address is real
 *  and belongs to them before the account can log in. */
export async function sendOperatorVerificationEmail(to: string, name: string, verifyUrl: string) {
  const safeName = escapeHtml(name)
  await sendEmail({
    from: FROM,
    to,
    subject: "Confirm your email for ProPCB shop-floor access",
    text: `Hi ${name},\n\nConfirm this email address to finish setting up your ProPCB operator account:\n${verifyUrl}\n\nThis link expires in 24 hours. If you didn't sign up, you can ignore this email.`,
    html: `
      <p>Hi ${safeName},</p>
      <p>Confirm this email address to finish setting up your ProPCB operator account.</p>
      <p><a href="${verifyUrl}">Verify my email</a> — this link expires in 24 hours.</p>
      <p>If you didn't sign up, you can ignore this email.</p>
    `,
  })
}

export async function sendStaffWelcomeEmail(to: string, role: string, setPasswordUrl: string) {
  await sendEmail({
    from: FROM,
    to,
    subject: "You've been added to the ProPCB team",
    text: `An admin has created a ProPCB staff account for you with the role ${role}.\n\nSet your password: ${setPasswordUrl}\n\nThis link expires in 1 hour.`,
    html: `
      <p>An admin has created a ProPCB staff account for you with the role <strong>${role}</strong>.</p>
      <p><a href="${setPasswordUrl}">Click here to set your password</a> — this link expires in 1 hour.</p>
    `,
  })
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
 * Set SHARE_EMAIL_DRY_RUN to skip calling either email provider for share
 * emails — writes the rendered HTML/text to disk instead, so the whole
 * POST /api/share flow (bundle creation, disk write, DB rows marked sent)
 * completes successfully without real Resend/Gmail credentials. Checked
 * BEFORE sendEmail's provider branch, so it's provider-agnostic by
 * construction — this was originally written for a placeholder
 * RESEND_API_KEY specifically, but the need (exercise sharing end-to-end
 * with no real credentials configured) is the same regardless of which
 * provider is live. Scoped to share emails only — password reset / staff
 * welcome keep their existing behavior, since dry-running an auth flow
 * isn't useful the same way.
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

  const result = await sendEmail({
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
  return { id: result.id, dryRun: false }
}
