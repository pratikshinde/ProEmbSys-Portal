import Link from "next/link"
import type { Metadata } from "next"
import { db } from "@/lib/db"
import { renderShareReadme, type FilmManifest, type DrillManifest, type TestManifest } from "@/lib/share/manifest"
import { shareRecipientProblem } from "@/lib/share/tokens"

// The only unauthenticated, externally-linkable page in the app — a plotter
// or drill shop opens this straight from an email, no ProPCB account
// involved. Deliberately does NOT import Navbar from portal-main.tsx (that
// would pull the whole marketing/tool shell and its Zustand store into a
// public page that has no business touching either) — a minimal standalone
// layout instead, mirroring (auth)/layout.tsx's own centered-card shape.
export const dynamic = "force-dynamic"

export function generateMetadata(): Metadata {
  return {
    title: "Shared Files — ProPCB",
    robots: { index: false, follow: false },
  }
}

const KIND_LABEL: Record<string, string> = {
  FILM: "Film Plot Files",
  DRILL: "Drilling Files",
  TEST: "Bare-Board Test Files",
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export default async function SharePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params

  // This GET intentionally does NOT bump ShareRecipient.accessCount — only
  // the actual file download (/api/share/download/[token]) does. A landing
  // page hit can come from a corporate link-scanner (Defender SafeLinks,
  // Proofpoint) auto-fetching the URL before any human sees it; counting
  // that here would make "accessed" an even less honest signal than it
  // already is (see ShareRecipient.firstAccessedAt's own schema comment).
  const recipient = await db.shareRecipient.findUnique({
    where: { token },
    include: { bundle: { include: { camJob: { select: { name: true } } } } },
  })

  // Expired / revoked / garbage token all render this SAME friendly shell
  // with a different one-line reason — never Next's bare not-found() page,
  // which is what a real sender/recipient would otherwise see on a
  // perfectly ordinary "the 30 days ran out" case. The check itself lives
  // in share/tokens.ts — see shareRecipientProblem's own doc comment.
  const problem = shareRecipientProblem(recipient)

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-background px-4 py-16">
      <Link href="/" className="mb-8 text-lg font-bold tracking-tight text-foreground">
        Pro<span className="text-primary">PCB</span>
      </Link>
      <div className="w-full max-w-lg">
        {problem || !recipient ? (
          <div className="rounded-lg border bg-card p-6 text-center">
            <p className="text-foreground">{problem}</p>
          </div>
        ) : (
          <div className="flex flex-col gap-4 rounded-lg border bg-card p-6">
            <div>
              <div className="text-sm text-muted-foreground">
                {KIND_LABEL[recipient.bundle.kind] ?? recipient.bundle.kind}
              </div>
              <h1 className="text-xl font-bold text-foreground">{recipient.bundle.camJob.name}</h1>
              <div className="text-sm text-muted-foreground">
                {recipient.bundle.fileName} · {formatBytes(recipient.bundle.fileSize)}
              </div>
            </div>

            {recipient.bundle.message && (
              <p className="border-l-2 border-primary/40 pl-3 text-sm whitespace-pre-wrap text-foreground">
                {recipient.bundle.message}
              </p>
            )}

            <a
              href={`/api/share/download/${token}`}
              className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
            >
              Download {recipient.bundle.fileName}
            </a>

            <div className="text-xs text-muted-foreground">
              Link expires on{" "}
              {recipient.bundle.expiresAt.toLocaleDateString("en-IN", {
                year: "numeric",
                month: "long",
                day: "numeric",
              })}
              .
            </div>

            <pre className="max-h-64 overflow-y-auto rounded-md bg-muted p-3 font-mono text-xs whitespace-pre-wrap text-muted-foreground">
              {renderShareReadme(
                recipient.bundle.kind,
                recipient.bundle.manifest as unknown as FilmManifest | DrillManifest | TestManifest
              )}
            </pre>
          </div>
        )}
      </div>
    </div>
  )
}
