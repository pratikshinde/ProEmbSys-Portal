// Derives a CamJob's health from counts captured at SAVE time — never
// hand-maintained, so it can't go stale the way a manually-set "erroneous"
// flag would the moment someone edits the job.
//
// Three independent axes feed this, all captured once in handleSaveJob
// (export-panel.tsx) from live store state at the moment of save:
//   - DFM: only runs on an explicit "Run check" click, so `dfmRanAt` is
//     frequently null — most jobs have simply never been checked. That is
//     NOT the same fact as "checked and clean", and this file must never
//     conflate the two: an unchecked job shows `unknown`, never `clean`.
//   - Staleness: dfmReport is NOT cleared by addLayer/removeLayer (only by
//     clearLayers/loadCamJobSnapshot), so a report captured at save time can
//     legitimately predate the layer set it was saved alongside. There is
//     no dfmReport diff to compare against after the fact, so this is
//     approximated by comparing the layer COUNT the report ran against
//     (dfmLayerCount) to the file count actually saved (fileCount) — a
//     cheap fingerprint, not a guarantee of no false negatives, but it
//     catches the common case (a layer added/removed after the last check).
//   - Import/export warnings: transient today (a toast, then discarded);
//     the store now carries importWarnings/lastExport so a count of each
//     survives to save time.

export type CamJobHealthLevel = "unknown" | "clean" | "warnings" | "errors"

export interface CamJobHealthCounts {
  dfmRanAt: string | Date | null
  dfmErrors: number | null
  dfmWarnings: number | null
  dfmLayerCount: number | null
  exportRanAt: string | Date | null
  exportWarnings: number | null
  importWarnings: number
  /** The number of layer files actually saved alongside this job —
   *  CamJobSnapshot.files.length. Compared against dfmLayerCount to detect
   *  staleness. */
  fileCount: number
}

export interface CamJobHealth {
  level: CamJobHealthLevel
  label: string
  /** Human-readable reason(s) for this level, most specific first — shown
   *  in a tooltip/expansion, not just the badge. */
  reasons: string[]
}

export const CAM_JOB_HEALTH_META: Record<CamJobHealthLevel, { label: string; bg: string; text: string }> = {
  unknown: { label: "Not checked", bg: "rgba(148,163,184,0.15)", text: "#94a3b8" },
  clean: { label: "Clean", bg: "rgba(34,197,94,0.15)", text: "#4ade80" },
  warnings: { label: "Warnings", bg: "rgba(245,158,11,0.15)", text: "#fbbf24" },
  errors: { label: "Errors", bg: "rgba(239,68,68,0.15)", text: "#f87171" },
}

/**
 * Derive a CamJob's health from its stored counts, in strict precedence
 * order (first match wins — never combine branches):
 *   1. Never checked (no DFM run AND no export run) -> unknown
 *   2. Any DFM error -> errors
 *   3. DFM ran, but against a different layer count than what was saved -> unknown (stale)
 *   4. Any warning (DFM/import/export) -> warnings
 *   5. Otherwise -> clean
 */
export function deriveCamJobHealth(c: CamJobHealthCounts): CamJobHealth {
  const neverChecked = c.dfmRanAt == null && c.exportRanAt == null
  if (neverChecked) {
    return { level: "unknown", label: CAM_JOB_HEALTH_META.unknown.label, reasons: ["DFM check and export have not been run for this job."] }
  }

  const dfmErrors = c.dfmErrors ?? 0
  if (dfmErrors > 0) {
    return { level: "errors", label: CAM_JOB_HEALTH_META.errors.label, reasons: [`${dfmErrors} DFM error${dfmErrors !== 1 ? "s" : ""} at save time.`] }
  }

  const dfmStale = c.dfmRanAt != null && c.dfmLayerCount != null && c.dfmLayerCount !== c.fileCount
  if (dfmStale) {
    return {
      level: "unknown",
      label: CAM_JOB_HEALTH_META.unknown.label,
      reasons: [`DFM ran against ${c.dfmLayerCount} layer${c.dfmLayerCount !== 1 ? "s" : ""}, but ${c.fileCount} layer${c.fileCount !== 1 ? "s" : ""} were saved — re-run the check.`],
    }
  }

  const reasons: string[] = []
  const dfmWarnings = c.dfmWarnings ?? 0
  if (dfmWarnings > 0) reasons.push(`${dfmWarnings} DFM warning${dfmWarnings !== 1 ? "s" : ""}.`)
  if (c.importWarnings > 0) reasons.push(`${c.importWarnings} import warning${c.importWarnings !== 1 ? "s" : ""}.`)
  const exportWarnings = c.exportWarnings ?? 0
  if (exportWarnings > 0) reasons.push(`${exportWarnings} export warning${exportWarnings !== 1 ? "s" : ""}.`)
  if (reasons.length > 0) {
    return { level: "warnings", label: CAM_JOB_HEALTH_META.warnings.label, reasons }
  }

  return { level: "clean", label: CAM_JOB_HEALTH_META.clean.label, reasons: ["No issues at save time."] }
}
