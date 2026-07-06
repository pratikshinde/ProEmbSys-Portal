import { Resend } from "resend"

// Lazily constructed — the Resend SDK throws in its constructor if the key is
// missing/empty, which breaks Next.js's build-time route analysis (every
// route module gets imported to collect page data, even if it's never
// called). Constructing it inside the function means a missing key only
// fails when an email is actually sent, not at build time.
function getResendClient() {
  return new Resend(process.env.RESEND_API_KEY)
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
