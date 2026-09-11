import { storagePut, storageGet } from "../blob-storage"

/**
 * Storage for the panel image captured by "Send to Fab" — a serialized SVG
 * of the CAM tool's Board view. One file per job. Uses the dual-backend
 * abstraction in blob-storage.ts (local disk in dev, Vercel Blob in
 * production).
 */

const NAMESPACE = "production"
const SAFE_ID = /^[a-z0-9]+$/i
// 12 MB — a 4-up board-view SVG with full trace art is a few MB; anything past
// this is almost certainly a mistake, reject rather than fill storage.
export const MAX_PANEL_SVG_BYTES = 12 * 1024 * 1024

export async function savePanelSvg(jobId: string, svg: string): Promise<string> {
  if (!SAFE_ID.test(jobId)) throw new Error("Invalid job id.")
  if (Buffer.byteLength(svg, "utf8") > MAX_PANEL_SVG_BYTES) {
    throw new Error("The panel image is too large to send.")
  }
  await storagePut(`${NAMESPACE}/${jobId}/panel.svg`, svg, "image/svg+xml")
  return `${jobId}/panel.svg`
}

export async function readPanelFile(relPath: string): Promise<Buffer> {
  // Shape: "<jobId>/panel.svg"
  if (!/^[a-z0-9]+\/panel\.svg$/i.test(relPath)) throw new Error("Invalid path.")
  return storageGet(`${NAMESPACE}/${relPath}`)
}
