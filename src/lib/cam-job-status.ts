// Shared, human-readable presentation for CamJobStatus enum values — same
// pattern as order-status.ts / shop-order-status.ts. Raw enum strings
// (SENT_TO_FAB etc.) must never be shown to users; every status display
// goes through this map.
//
// Unlike Order, CamJobStatus has no defined pipeline/timeline concept — a
// job can move DRAFT -> READY -> SENT_TO_FAB, or jump straight to ARCHIVED
// from any state (abandoning a scratch job). There's no single "next step"
// to visualize, so this file deliberately has no ORDER_PIPELINE analogue.

export type CamJobStatusKey = "DRAFT" | "READY" | "SENT_TO_FAB" | "ARCHIVED"

export const CAM_JOB_STATUS_META: Record<CamJobStatusKey, { label: string; bg: string; text: string }> = {
  DRAFT: { label: "Draft", bg: "rgba(148,163,184,0.15)", text: "#94a3b8" },
  READY: { label: "Ready", bg: "rgba(59,130,246,0.15)", text: "#60a5fa" },
  SENT_TO_FAB: { label: "Sent to fab", bg: "rgba(34,197,94,0.15)", text: "#4ade80" },
  ARCHIVED: { label: "Archived", bg: "rgba(100,116,139,0.15)", text: "#64748b" },
}

export function camJobStatusMeta(status: string) {
  return (
    CAM_JOB_STATUS_META[status as CamJobStatusKey] ?? {
      label: status,
      bg: "rgba(148,163,184,0.15)",
      text: "#94a3b8",
    }
  )
}
