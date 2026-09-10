import { mkdir, readFile, writeFile } from "fs/promises"
import path from "path"

/**
 * On-disk storage for the panel image captured by "Send to Fab" — a serialized
 * SVG of the CAM tool's Board view. One file per job. Same local-disk caveat as
 * src/lib/attachments.ts (move to object storage before running >1 instance).
 */

const ROOT = path.join(process.cwd(), "uploads", "production")
const SAFE_ID = /^[a-z0-9]+$/i
// 12 MB — a 4-up board-view SVG with full trace art is a few MB; anything past
// this is almost certainly a mistake, reject rather than fill the disk.
export const MAX_PANEL_SVG_BYTES = 12 * 1024 * 1024

export async function savePanelSvg(jobId: string, svg: string): Promise<string> {
  if (!SAFE_ID.test(jobId)) throw new Error("Invalid job id.")
  if (Buffer.byteLength(svg, "utf8") > MAX_PANEL_SVG_BYTES) {
    throw new Error("The panel image is too large to send.")
  }
  const dir = path.join(ROOT, jobId)
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, "panel.svg"), svg, "utf8")
  return `${jobId}/panel.svg`
}

export async function readPanelFile(relPath: string): Promise<Buffer> {
  // Shape: "<jobId>/panel.svg"
  if (!/^[a-z0-9]+\/panel\.svg$/i.test(relPath)) throw new Error("Invalid path.")
  return readFile(path.join(ROOT, relPath))
}
