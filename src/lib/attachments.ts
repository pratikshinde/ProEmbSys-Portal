import crypto from "crypto"
import { storagePut, storageGet } from "./blob-storage"

/**
 * Message screenshot attachments, via the dual-backend abstraction in
 * blob-storage.ts (local disk in dev, Vercel Blob in production).
 */

const NAMESPACE = "messages"

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
  await storagePut(`${NAMESPACE}/${threadId}/${filename}`, Buffer.from(await file.arrayBuffer()), file.type)

  return {
    attachmentPath: `${threadId}/${filename}`,
    attachmentName: file.name,
    attachmentType: file.type,
    attachmentSize: file.size,
  }
}

/** Validates the stored-path shape before touching storage — both
 *  segments are server-generated (cuid threadId, uuid+ext filename), so
 *  anything that doesn't match this shape is rejected rather than resolved. */
const SAFE_PATH = /^[a-z0-9]+\/[a-f0-9-]+\.(png|jpg|jpeg|webp|gif)$/i

export async function readMessageAttachment(attachmentPath: string): Promise<Buffer> {
  if (!SAFE_PATH.test(attachmentPath)) {
    throw new Error("Invalid attachment path.")
  }
  return storageGet(`${NAMESPACE}/${attachmentPath}`)
}
