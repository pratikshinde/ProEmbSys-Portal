import { put, get, del, list, head } from "@vercel/blob"
import { mkdir, readFile, writeFile, rm, stat as fsStat } from "fs/promises"
import { createReadStream } from "fs"
import { Readable } from "stream"
import path from "path"

/**
 * Dual-backend file storage behind one small API: local disk in dev (default,
 * zero setup — matches every upload lib's previous behavior exactly), Vercel
 * Blob in production (auto-detected via `BLOB_READ_WRITE_TOKEN`, which Vercel
 * sets automatically the moment a Blob store is linked to the project —
 * nothing to configure by hand). Local disk doesn't survive on Vercel's
 * serverless filesystem (ephemeral, effectively read-only outside /tmp,
 * possibly a different instance per request) — this is the fix for that,
 * for the five upload libs that need it (order-files, attachments,
 * cam-job-files, production/panel-files, share-files). `src/lib/email.ts`'s
 * SHARE_EMAIL_DRY_RUN scratch-file write is deliberately NOT routed through
 * this — it's a local dev debugging aid nobody sets in production.
 *
 * Every call site keeps the exact same relative-path "key" shape it always
 * used (e.g. "threadId/uuid.png", stored verbatim in the DB) — Blob's own
 * pathname addressing matches that 1:1 (`put`/`get`/`del`/`head`/`list` all
 * accept a bare pathname, not just a full URL), so swapping backends needed
 * no format/schema change anywhere upstream of this file. Each upload lib
 * still owns its own namespace prefix ("orders/", "messages/", "cam-jobs/",
 * "production/", "shares/") exactly as the old per-lib `UPLOAD_ROOT` did.
 *
 * ⚠ Blobs are always written `access: 'private'` — never a bare public URL.
 * Every file in this app is served through an existing auth-gated API route
 * (ownership/staff checks already there, unchanged); this module only
 * changes what that route reads FROM, fetching content server-side via the
 * private `get()` API and re-serving it exactly as it already re-served a
 * local file. A `put()`/`get()` mismatch on `access` throws, by design — it's
 * the one option that must never silently drift to 'public'.
 */

const useBlob = !!process.env.BLOB_READ_WRITE_TOKEN

// Not used in blob mode — UPLOADS_DIR only matters for the local-disk
// fallback (see share-files.ts's original comment on why a standalone build's
// cwd can't be trusted for a long-lived external link). Applying it uniformly
// here (previously only share-files.ts read this env var) is strictly safer
// for the other four libs too, not a behavior change any of them relied on.
const LOCAL_ROOT = process.env.UPLOADS_DIR ?? path.join(process.cwd(), "uploads")

function localPath(key: string): string {
  return path.join(LOCAL_ROOT, key)
}

export async function storagePut(key: string, data: Buffer | string, contentType?: string): Promise<void> {
  if (useBlob) {
    await put(key, data, { access: "private", addRandomSuffix: false, allowOverwrite: true, contentType })
    return
  }
  const full = localPath(key)
  await mkdir(path.dirname(full), { recursive: true })
  await writeFile(full, data)
}

export async function storageGet(key: string): Promise<Buffer> {
  if (useBlob) {
    const result = await get(key, { access: "private" })
    if (!result?.stream) throw new Error("File not found.")
    return Buffer.from(await new Response(result.stream).arrayBuffer())
  }
  return readFile(localPath(key))
}

/** Web ReadableStream either way — callers that need a Node stream (see
 *  share-files.ts's readShareBundleStream) convert at their own edge via
 *  `Readable.fromWeb`, keeping this module stream-flavor-agnostic. */
export async function storageGetStream(key: string): Promise<ReadableStream<Uint8Array>> {
  if (useBlob) {
    const result = await get(key, { access: "private" })
    if (!result?.stream) throw new Error("File not found.")
    return result.stream
  }
  return Readable.toWeb(createReadStream(localPath(key))) as ReadableStream<Uint8Array>
}

export async function storageDelete(key: string): Promise<void> {
  if (useBlob) {
    await del(key).catch(() => {}) // already-gone is fine, matches rm's `force: true` below
    return
  }
  await rm(localPath(key), { force: true })
}

/** Deletes every file under a "directory" key prefix, e.g. "cam-jobs/<jobId>/". */
export async function storageDeletePrefix(prefix: string): Promise<void> {
  if (useBlob) {
    let cursor: string | undefined
    do {
      const res = await list({ prefix, cursor, limit: 1000 })
      if (res.blobs.length > 0) await del(res.blobs.map((b) => b.pathname))
      cursor = res.hasMore ? res.cursor : undefined
    } while (cursor)
    return
  }
  await rm(localPath(prefix), { recursive: true, force: true })
}

export async function storageStat(key: string): Promise<{ size: number } | null> {
  if (useBlob) {
    try {
      const info = await head(key)
      return { size: info.size }
    } catch {
      return null
    }
  }
  try {
    const s = await fsStat(localPath(key))
    return { size: s.size }
  } catch {
    return null
  }
}
