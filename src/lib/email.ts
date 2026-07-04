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

export async function sendPasswordResetEmail(to: string, resetUrl: string) {
  await getResendClient().emails.send({
    from: FROM,
    to,
    subject: "Reset your ProPCB password",
    html: `
      <p>We received a request to reset your ProPCB account password.</p>
      <p><a href="${resetUrl}">Click here to set a new password</a> — this link expires in 1 hour.</p>
      <p>If you didn't request this, you can safely ignore this email.</p>
    `,
  })
}
