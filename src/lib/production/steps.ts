// Plain-language names + an emoji for each manufacturing step (operator
// screens), plus the job-status presentation map. The stored stage `label` is
// the technical name ("Copper image transfer"); operators see the friendly
// one. Status map mirrors src/lib/order-status.ts — raw enum strings never
// reach a screen.

interface FriendlyStep {
  short: string
  emoji: string
}

const FRIENDLY: Record<string, FriendlyStep> = {
  INCOMING_QC: { short: "Check materials", emoji: "📋" },
  PANEL_CUTTING: { short: "Cutting", emoji: "✂️" },
  DRILLING: { short: "Drilling", emoji: "🕳️" },
  ELECTROLESS_COPPER: { short: "Hole plating", emoji: "⚗️" },
  COPPER_IMAGE: { short: "Copper printing", emoji: "🖨️" },
  PATTERN_PLATING: { short: "Copper plating", emoji: "⚡" },
  ETCH_STRIP: { short: "Etching", emoji: "🧪" },
  AOI: { short: "Photo inspection", emoji: "📷" },
  SOLDERMASK: { short: "Solder mask", emoji: "🟩" },
  SILKSCREEN: { short: "Silkscreen", emoji: "🔤" },
  SURFACE_FINISH: { short: "Surface finish", emoji: "✨" },
  ROUTING_DEPANEL: { short: "Routing / cut out", emoji: "🪚" },
  ELECTRICAL_TEST: { short: "Electrical test", emoji: "🔌" },
  FINAL_QC: { short: "Final check", emoji: "🔍" },
  PACKAGING_DISPATCH: { short: "Packing", emoji: "📦" },
}

export function friendlyStep(stageTypeKey: string, storedLabel: string): FriendlyStep {
  return FRIENDLY[stageTypeKey] ?? { short: storedLabel, emoji: "•" }
}

export function friendlyStepLabel(stageTypeKey: string, storedLabel: string): string {
  return friendlyStep(stageTypeKey, storedLabel).short
}

export type ProductionJobStatusKey = "DRAFT" | "QUEUED" | "IN_PROGRESS" | "ON_HOLD" | "DONE" | "CANCELLED"

export const PRODUCTION_JOB_STATUS_META: Record<
  ProductionJobStatusKey,
  { label: string; bg: string; text: string }
> = {
  DRAFT: { label: "Draft", bg: "rgba(148,163,184,0.15)", text: "#94a3b8" },
  QUEUED: { label: "Not started", bg: "rgba(148,163,184,0.15)", text: "#94a3b8" },
  IN_PROGRESS: { label: "In progress", bg: "rgba(139,92,246,0.15)", text: "#a78bfa" },
  ON_HOLD: { label: "On hold", bg: "rgba(245,158,11,0.15)", text: "#fbbf24" },
  DONE: { label: "Completed", bg: "rgba(34,197,94,0.15)", text: "#4ade80" },
  CANCELLED: { label: "Cancelled", bg: "rgba(239,68,68,0.15)", text: "#f87171" },
}

export function productionJobStatusMeta(status: string) {
  return (
    PRODUCTION_JOB_STATUS_META[status as ProductionJobStatusKey] ?? {
      label: status,
      bg: "rgba(148,163,184,0.15)",
      text: "#94a3b8",
    }
  )
}
