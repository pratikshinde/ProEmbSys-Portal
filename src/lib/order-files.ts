import { mkdir, readFile, writeFile } from "fs/promises"
import path from "path"
import crypto from "crypto"

/**
 * Local-disk storage for order Gerber uploads. Same reasoning and caveats as
 * src/lib/attachments.ts (fine for local/single-instance, swap for object
 * storage before scaling) — two differences suited to Gerber files:
 *  - validated by file extension, not MIME type, since browsers don't
 *    reliably report a MIME type for .gbr/.rar (often blank or
 *    application/octet-stream), unlike images.
 *  - no per-order subfolder: unlike a message thread (which always exists
 *    before an attachment is added to it), the order doesn't exist yet at
 *    upload time — it's created in the same request — so this just uses a
 *    flat, globally-unique filename directly under uploads/orders/.
 */

const UPLOAD_ROOT = path.join(process.cwd(), "uploads", "orders")

const ALLOWED_EXTENSIONS = new Set([".gbr", ".zip", ".rar"])

const MAX_SIZE_BYTES = 25 * 1024 * 1024 // 25MB — generous for a zipped multi-layer Gerber set

export interface SavedOrderFile {
  path: string
  name: string
  type: string
  size: number
}

export async function saveOrderFile(file: File): Promise<SavedOrderFile> {
  const ext = path.extname(file.name).toLowerCase()
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    throw new Error("Only .gbr, .zip, or .rar files are allowed.")
  }
  if (file.size > MAX_SIZE_BYTES) {
    throw new Error("Gerber file must be under 25MB.")
  }

  await mkdir(UPLOAD_ROOT, { recursive: true })
  const filename = `${crypto.randomUUID()}${ext}`
  await writeFile(path.join(UPLOAD_ROOT, filename), Buffer.from(await file.arrayBuffer()))

  return {
    path: filename,
    name: file.name,
    type: file.type || "application/octet-stream",
    size: file.size,
  }
}

/** Validates the stored-path shape before touching the filesystem — the
 *  filename is always server-generated (uuid + ext), so anything that
 *  doesn't match this shape is rejected rather than resolved. */
const SAFE_PATH = /^[a-f0-9-]+\.(gbr|zip|rar)$/i

export async function readOrderFile(relativePath: string): Promise<Buffer> {
  if (!SAFE_PATH.test(relativePath)) {
    throw new Error("Invalid file path.")
  }
  return readFile(path.join(UPLOAD_ROOT, relativePath))
}
