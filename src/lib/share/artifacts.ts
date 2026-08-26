/**
 * The role-tagged artifact list that sits between "an exporter generates
 * file content" and "a ZIP gets written" — the seam Phase 4's sharing
 * feature needs to build a film/drill/test bundle without re-deriving
 * geometry a second time.
 *
 * Why this exists (see the "Locked decisions" section of the sharing plan):
 * none of the three role bundles equals any of today's five exported ZIPs.
 * Film lives INSIDE the panel ZIP's Film/ subfolder; drill spans the panel
 * ZIP AND the G-Code ZIP; test is the panel ZIP minus Film/,
 * Meta-Panelization/ and route. Filtering by filename regex after the fact
 * is fragile (sanitizeForFilename mangles free-text part numbers), so
 * instead each producer tags a file with its role(s) at the exact point it
 * already knows what the file is — the only place that's actually known.
 *
 * Verified (scratch test, not kept in the repo): JSZip's path-string
 * `folder.file('Film/x.pdf', content)` produces byte-identical output,
 * same entry order, same auto-created directory entries, as the explicit
 * `folder.folder('Film').file('x.pdf', content)` calls this codebase used
 * before this refactor — so `CamArtifact.path` can freely encode subfolder
 * structure (e.g. `'Film/PartNumber_Bottom_Copper_POS.pdf'`) with zero risk
 * of a byte-level regression.
 */
import JSZip from 'jszip'

export type ArtifactRole = 'panel' | 'film' | 'drill' | 'test' | 'route' | 'gcode' | 'meta'

export interface CamArtifact {
  /** Path INSIDE the root folder — may contain '/' to place the file in a
   *  subfolder (e.g. 'Film/PartNumber_Bottom_Copper_POS.pdf'). */
  path: string
  content: string | Uint8Array
  /** Every bundle this file belongs to. A file commonly belongs to several
   *  — e.g. the main drill file is `['panel', 'test', 'drill']`. */
  roles: ArtifactRole[]
}

/** Zips a flat artifact list under one root folder — the exact shape every
 *  exporter in gerber-exporter.ts already produces, just built from a list
 *  instead of inline `folder.file(...)` calls threaded through ~300 lines
 *  of generation logic. */
export async function zipArtifacts(artifacts: CamArtifact[], rootFolder: string): Promise<Blob> {
  const zip = new JSZip()
  const folder = zip.folder(rootFolder)
  if (!folder) throw new Error('Failed to create ZIP folder')
  for (const a of artifacts) folder.file(a.path, a.content)
  return zip.generateAsync({ type: 'blob' })
}

export function filterByRole(artifacts: CamArtifact[], role: ArtifactRole): CamArtifact[] {
  return artifacts.filter((a) => a.roles.includes(role))
}

export function totalBytes(artifacts: CamArtifact[]): number {
  let total = 0
  for (const a of artifacts) {
    total += typeof a.content === 'string' ? Buffer.byteLength(a.content, 'utf8') : a.content.byteLength
  }
  return total
}
