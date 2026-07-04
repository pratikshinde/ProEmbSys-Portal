import { mkdir, readFile, writeFile } from "fs/promises"
import path from "path"
import crypto from "crypto"

/**
 * Local-disk storage for message screenshot attachments. Fine for local/
 * single-instance deployment; won't survive container restarts or scale to
 * multiple instances — swap for S3-compatible object storage before a real
 * production deploy.
 */

const UPLOAD_ROOT = path.join(process.cwd(), "uploads", "messages")

const ALLOWED_TYPES: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
}

const MAX_SIZE_BYTES = 5 * 1024 * 1024 // 5MB — generous for a screenshot

export interface SavedAttachment {
  attachmentPath: string
  attachmentName: string
  attachmentType: string
  attachmentSize: number
}

export async function saveMessageAttachment(threadId: string, file: File): Promise<SavedAttachment> {
  const ext = ALLOWED_TYPES[file.type]
  if (!ext) {
    throw new Error("Only image attachments (PNG, JPEG, WebP, GIF) are allowed.")
  }
  if (file.size > MAX_SIZE_BYTES) {
    throw new Error("Attachment must be under 5MB.")
  }

  const filename = `${crypto.randomUUID()}${ext}`
  const dir = path.join(UPLOAD_ROOT, threadId)
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, filename), Buffer.from(await file.arrayBuffer()))

  return {
    attachmentPath: `${threadId}/${filename}`,
    attachmentName: file.name,
    attachmentType: file.type,
    attachmentSize: file.size,
  }
}

/** Validates the stored-path shape before touching the filesystem — both
 *  segments are server-generated (cuid threadId, uuid+ext filename), so
 *  anything that doesn't match this shape is rejected rather than resolved. */
const SAFE_PATH = /^[a-z0-9]+\/[a-f0-9-]+\.(png|jpg|jpeg|webp|gif)$/i

export async function readMessageAttachment(attachmentPath: string): Promise<Buffer> {
  if (!SAFE_PATH.test(attachmentPath)) {
    throw new Error("Invalid attachment path.")
  }
  return readFile(path.join(UPLOAD_ROOT, attachmentPath))
}
