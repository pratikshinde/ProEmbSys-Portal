import { mkdir, readFile, rm, writeFile } from "fs/promises"
import path from "path"

/**
 * Local-disk storage for CAM job layer files — a hybrid of the two existing
 * upload-storage patterns in this repo, since CamJob doesn't fit either one
 * cleanly:
 *  - like src/lib/attachments.ts, files live in a PER-PARENT subfolder
 *    (uploads/cam-jobs/<jobId>/...), since a CamJob row is created first and
 *    its files are written afterward (unlike an Order, which doesn't exist
 *    yet at upload time).
 *  - like src/lib/order-files.ts, content is always plain text (Gerber/
 *    Excellon), so every file is written with a fixed .txt extension and
 *    read back as UTF-8 unconditionally — the original filename/extension is
 *    metadata (stored in CamJob.config.files[]), not part of the disk path.
 *
 * The on-disk filename stem is the client's own LayerEntry.id (the store's
 * generateId(), always [a-z0-9]{7}) rather than a fresh server UUID — this
 * lets CamJob.config.files[] reference a file purely by that id, with no
 * separate stored path per entry.
 */

const UPLOAD_ROOT = path.join(process.cwd(), "uploads", "cam-jobs")

// Prisma cuid()s and the store's generateId() are both lowercase-alphanumeric
const SAFE_ID = /^[a-z0-9]+$/i

const MAX_TOTAL_SIZE_BYTES = 50 * 1024 * 1024 // 50MB total per job — a multi-design job can have many layers across several boards

export { MAX_TOTAL_SIZE_BYTES }

export async function saveCamJobFile(jobId: string, layerFileId: string, file: File): Promise<{ size: number }> {
  if (!SAFE_ID.test(jobId) || !SAFE_ID.test(layerFileId)) {
    throw new Error("Invalid job or layer id.")
  }
  const dir = path.join(UPLOAD_ROOT, jobId)
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, `${layerFileId}.txt`), Buffer.from(await file.arrayBuffer()))
  return { size: file.size }
}

export async function readCamJobFile(jobId: string, layerFileId: string): Promise<string> {
  if (!SAFE_ID.test(jobId) || !SAFE_ID.test(layerFileId)) {
    throw new Error("Invalid job or layer id.")
  }
  const buf = await readFile(path.join(UPLOAD_ROOT, jobId, `${layerFileId}.txt`))
  return buf.toString("utf-8")
}

export async function deleteCamJobDir(jobId: string): Promise<void> {
  if (!SAFE_ID.test(jobId)) {
    throw new Error("Invalid job id.")
  }
  await rm(path.join(UPLOAD_ROOT, jobId), { recursive: true, force: true })
}
