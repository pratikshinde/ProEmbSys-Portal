import { storagePut, storageGet, storageGetStream, storageStat, storageDeletePrefix } from "./blob-storage"

/**
 * Share-bundle ZIP storage, via the dual-backend abstraction in
 * blob-storage.ts (local disk in dev, Vercel Blob in production) — same
 * per-parent-namespace shape as cam-job-files.ts (shares/<bundleId>/bundle.zip),
 * but with one difference that matters specifically for this feature: content
 * is a binary ZIP, not UTF-8 text, so read/write work in Buffers, and the
 * public download route needs a real stream (not the full-buffer-then-
 * NextResponse pattern every other file route in this app uses) — see
 * readShareBundleStream's own doc comment.
 *
 * A share bundle is a promise to an EXTERNAL third party that a link keeps
 * working for up to 30 days — unlike the other upload libs' content (the
 * customer's own re-uploadable input), this is the reason `blob-storage.ts`
 * unified `UPLOADS_DIR` handling across all five libs: an `output:
 * "standalone"` build can run with a different cwd than the source tree, and
 * an emailed link must not turn into a 404 in production.
 */

const NAMESPACE = "shares"

// Prisma cuid()s are lowercase-alphanumeric, same guard as cam-job-files.ts.
const SAFE_ID = /^[a-z0-9]+$/i

export const MAX_BUNDLE_SIZE_BYTES = 40 * 1024 * 1024 // 40MB per bundle

function bundleKey(bundleId: string): string {
  if (!SAFE_ID.test(bundleId)) throw new Error("Invalid bundle id.")
  return `${NAMESPACE}/${bundleId}/bundle.zip`
}

export async function saveShareBundleFile(bundleId: string, bytes: Uint8Array): Promise<{ size: number }> {
  await storagePut(bundleKey(bundleId), Buffer.from(bytes), "application/zip")
  return { size: bytes.byteLength }
}

/** Full-buffer read — used only for the email-attachment path (POST
 *  /api/share reads the just-written ZIP back once, and only when it's
 *  under the attach-size threshold). Never used by the public download
 *  route — see readShareBundleStream for why that one streams instead. */
export async function readShareBundleFile(bundleId: string): Promise<Buffer> {
  return storageGet(bundleKey(bundleId))
}

export async function statShareBundleFile(bundleId: string): Promise<{ size: number } | null> {
  return storageStat(bundleKey(bundleId))
}

/**
 * A real stream, not a buffered read — deliberately breaking from every
 * other file-serving route in this app (which all do `new
 * NextResponse(new Uint8Array(await readFile(...)))`). The public download
 * route is the ONLY unauthenticated, externally-linkable, repeatedly-
 * hittable route in the app (an emailed link can be clicked any number of
 * times over 30 days, including by link-scanners that fetch it
 * automatically) — buffering a large ZIP fully into memory per request on
 * that specific route is the one place the existing precedent is actually
 * wrong to copy. Returns a Web ReadableStream directly (async, since Blob's
 * own `get()` is) — the route hands it straight to `Response` with no
 * further conversion.
 */
export async function readShareBundleStream(bundleId: string): Promise<ReadableStream<Uint8Array>> {
  return storageGetStream(bundleKey(bundleId))
}

export async function deleteShareBundleDir(bundleId: string): Promise<void> {
  await storageDeletePrefix(`${NAMESPACE}/${bundleId}/`)
}
