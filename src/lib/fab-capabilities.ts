/**
 * ProEmbSys' real manufacturing capability envelope — the single source of
 * truth for the numbers shown on the public /fab-capabilities page AND for the
 * seeded "ProEmbSys Standard" SHARED DfmTemplate (prisma/seed.ts).
 *
 * Keeping both consumers on this one object is the point: the marketing page
 * and the DFM baseline can't silently drift apart. Change a number here and
 * both follow (re-run `npm run db:seed` to push it into the seeded template).
 *
 * Only *checkable numeric* specs live here. Prose-y capability rows that no
 * rule can evaluate (available surface finishes, "V-scoring supported", stated
 * tolerances) stay as static content in the page — inventing a DFM rule for
 * them would produce findings we can't actually justify.
 */

/** A threshold with an optional relaxed limit available on request. Values are
 *  mm unless the field name says otherwise. */
export interface CapabilityLimit {
  standard: number
  /** Achievable on request; used to grade a violation as a warning rather than
   *  a hard error. Omitted when there is no relaxed option. */
  advanced?: number
}

export interface FabCapabilities {
  /** Max single-piece board edge, mm (applies to each of width/height). */
  maxBoardMm: number
  /** Inclusive [min, max] copper layer count. */
  layerRange: [number, number]
  /** Inclusive [min, max] finished board thickness, mm. */
  boardThicknessMm: [number, number]
  /** Max board thickness : drill diameter ratio. */
  maxAspectRatio: number
  minTraceWidthMm: CapabilityLimit
  minDrillMm: CapabilityLimit
  minAnnularRingMm: CapabilityLimit
  minSilkLineWidthMm: CapabilityLimit
  minSilkTextHeightMm: CapabilityLimit
  minMaskClearanceMm: CapabilityLimit
}

export const FAB_CAPABILITIES: FabCapabilities = {
  maxBoardMm: 500,
  layerRange: [1, 8],
  boardThicknessMm: [0.4, 3.2],
  maxAspectRatio: 10,
  minTraceWidthMm: { standard: 0.1, advanced: 0.09 },
  minDrillMm: { standard: 0.3, advanced: 0.2 },
  minAnnularRingMm: { standard: 0.15, advanced: 0.13 },
  minSilkLineWidthMm: { standard: 0.15 },
  minSilkTextHeightMm: { standard: 0.8 },
  minMaskClearanceMm: { standard: 0.05 },
}

/** "0.1mm (4 mil)" style helper so the public page can render a limit and its
 *  advanced variant consistently without hardcoding the numbers again. */
export function formatLimitMm(limit: CapabilityLimit, milsLabel?: string): string {
  const base = `${limit.standard}mm${milsLabel ? ` (${milsLabel})` : ""}`
  return base
}
