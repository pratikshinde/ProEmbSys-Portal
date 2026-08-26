import { mkdir, writeFile, readFile, rm, stat } from 'fs/promises'
import { createReadStream, type ReadStream } from 'fs'
import path from 'path'

/**
 * Local-disk storage for share-bundle ZIPs — same per-parent-subfolder shape
 * as cam-job-files.ts (uploads/shares/<bundleId>/bundle.zip), but with two
 * differences that matter specifically for this feature:
 *
 *  - `UPLOADS_ROOT` is `process.env.UPLOADS_DIR ?? path.join(process.cwd(),
 *    "uploads")`, not a bare cwd-relative constant. Every other upload lib
 *    in this repo (attachments.ts, order-files.ts, cam-job-files.ts) hard-
 *    codes cwd — survivable for those because the content is the
 *    customer's own re-uploadable input. A share bundle is different: it's
 *    a promise to an EXTERNAL third party that a link keeps working for up
 *    to 30 days. `output: "standalone"` builds can run with a different
 *    cwd than the source tree, so a hardcoded path here would turn every
 *    emailed link into a 404 in production. This is the one upload lib
 *    that needed the env override; the other three are deliberately left
 *    alone (see .env.example's own comment).
 *  - content is a binary ZIP, not UTF-8 text, so read/write work in
 *    Buffers, and the public download route needs a real stream (not the
 *    full-buffer-then-NextResponse pattern every other file route in this
 *    app uses) — see readShareBundleStream's own doc comment.
 */

const UPLOADS_ROOT = process.env.UPLOADS_DIR ?? path.join(process.cwd(), 'uploads')
const SHARE_ROOT = path.join(UPLOADS_ROOT, 'shares')

// Prisma cuid()s are lowercase-alphanumeric, same guard as cam-job-files.ts.
const SAFE_ID = /^[a-z0-9]+$/i

export const MAX_BUNDLE_SIZE_BYTES = 40 * 1024 * 1024 // 40MB per bundle

function bundleDir(bundleId: string): string {
  if (!SAFE_ID.test(bundleId)) throw new Error('Invalid bundle id.')
  return path.join(SHARE_ROOT, bundleId)
}

function bundleFilePath(bundleId: string): string {
  return path.join(bundleDir(bundleId), 'bundle.zip')
}

export async function saveShareBundleFile(bundleId: string, bytes: Uint8Array): Promise<{ size: number }> {
  const dir = bundleDir(bundleId)
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'bundle.zip'), bytes)
  return { size: bytes.byteLength }
}

/** Full-buffer read — used only for the email-attachment path (POST
 *  /api/share reads the just-written ZIP back once, and only when it's
 *  under the attach-size threshold). Never used by the public download
 *  route — see readShareBundleStream for why that one streams instead. */
export async function readShareBundleFile(bundleId: string): Promise<Buffer> {
  return readFile(bundleFilePath(bundleId))
}

export async function statShareBundleFile(bundleId: string): Promise<{ size: number } | null> {
  try {
    const s = await stat(bundleFilePath(bundleId))
    return { size: s.size }
  } catch {
    return null
  }
}

/**
 * A real Node stream, not a buffered read — deliberately breaking from
 * every other file-serving route in this app (which all do
 * `new NextResponse(new Uint8Array(await readFile(...)))`). The public
 * download route is the ONLY unauthenticated, externally-linkable,
 * repeatedly-hittable route in the app (an emailed link can be clicked any
 * number of times over 30 days, including by link-scanners that fetch it
 * automatically) — buffering a large ZIP fully into memory per request on
 * that specific route is the one place the existing precedent is actually
 * wrong to copy.
 */
export function readShareBundleStream(bundleId: string): ReadStream {
  return createReadStream(bundleFilePath(bundleId))
}

export async function deleteShareBundleDir(bundleId: string): Promise<void> {
  await rm(bundleDir(bundleId), { recursive: true, force: true })
}
