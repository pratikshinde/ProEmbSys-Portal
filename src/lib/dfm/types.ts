/**
 * DFM contract — rule thresholds, the layer/context inputs a check runs over,
 * and the report shape. Deliberately engine-agnostic: the Tier-A checks in
 * run-dfm.ts produce these today, and a future geometric-DRC backend
 * (roadmap Phase 3) can produce the same findings without the UI changing.
 */

import { z } from "zod"
import type { GerberLayer } from "@/lib/gerber-parser"
import type { LayerType, LayerSide } from "@/lib/gerber-analysis"
import { FAB_CAPABILITIES } from "@/lib/fab-capabilities"

// ─── Rules ───────────────────────────────────────────────────────────────────

/** A threshold plus an optional relaxed limit. Breaching `standard` is a
 *  warning; breaching `advanced` (or `standard` when there is no advanced) is
 *  an error. All values in mm. */
export interface DfmLimit {
  standard: number
  advanced?: number
}

export interface DfmRules {
  maxBoardMm: number
  layerRange: [number, number]
  boardThicknessMm: [number, number]
  maxAspectRatio: number
  minTraceWidthMm: DfmLimit
  minDrillMm: DfmLimit
  minSilkLineWidthMm: DfmLimit
  /** Stored now, evaluated in roadmap Phase 2 (annular ring needs pad↔hole
   *  matching) — kept in the blob so saved templates don't need migrating. */
  minAnnularRingMm: DfmLimit
  /** Stored now, evaluated in roadmap Phase 3 (needs a geometry engine). */
  minMaskClearanceMm: DfmLimit
}

const limitSchema = z.object({
  standard: z.number().positive(),
  advanced: z.number().positive().optional(),
})

/** `rules` is a user-editable JSON blob persisted on DfmTemplate, so it is
 *  untrusted input on the way back in — always parse, never cast. */
export const dfmRulesSchema = z.object({
  maxBoardMm: z.number().positive(),
  layerRange: z.tuple([z.number().int().positive(), z.number().int().positive()]),
  boardThicknessMm: z.tuple([z.number().positive(), z.number().positive()]),
  maxAspectRatio: z.number().positive(),
  minTraceWidthMm: limitSchema,
  minDrillMm: limitSchema,
  minSilkLineWidthMm: limitSchema,
  minAnnularRingMm: limitSchema,
  minMaskClearanceMm: limitSchema,
})

/** Throws if the stored/submitted blob isn't a valid rule set. */
export function parseDfmRules(value: unknown): DfmRules {
  return dfmRulesSchema.parse(value) as DfmRules
}

/** Non-throwing variant for read paths where a corrupt row shouldn't take the
 *  whole page down — falls back to the shop baseline. */
export function parseDfmRulesSafe(value: unknown): DfmRules {
  const result = dfmRulesSchema.safeParse(value)
  return result.success ? (result.data as DfmRules) : DEFAULT_DFM_RULES
}

/** The shop's own envelope, used to seed the SHARED baseline template and as
 *  the starting point when a user creates a new template. */
export const DEFAULT_DFM_RULES: DfmRules = {
  maxBoardMm: FAB_CAPABILITIES.maxBoardMm,
  layerRange: FAB_CAPABILITIES.layerRange,
  boardThicknessMm: FAB_CAPABILITIES.boardThicknessMm,
  maxAspectRatio: FAB_CAPABILITIES.maxAspectRatio,
  minTraceWidthMm: FAB_CAPABILITIES.minTraceWidthMm,
  minDrillMm: FAB_CAPABILITIES.minDrillMm,
  minSilkLineWidthMm: FAB_CAPABILITIES.minSilkLineWidthMm,
  minAnnularRingMm: FAB_CAPABILITIES.minAnnularRingMm,
  minMaskClearanceMm: FAB_CAPABILITIES.minMaskClearanceMm,
}

// ─── Inputs ──────────────────────────────────────────────────────────────────

/**
 * The engine's layer input. Structurally satisfied by BOTH consumers already:
 * `DetectedLayer` (gerber-analysis.ts, used by the PCB Order flow) and
 * `LayerEntry` (store.ts, the CAM tool) each carry these four fields — so the
 * same engine serves both surfaces with no adapter.
 */
export interface DfmLayerInput {
  fileName: string
  type: LayerType
  side: LayerSide
  parsedLayer: GerberLayer
}

/**
 * Facts a Gerber set can't tell us. Board thickness is never in the files, and
 * inner copper layers aren't distinguishable from an outer-layer export, so
 * both are supplied by the caller (spec picker on the order page, manual
 * inputs in the CAM tool). Checks that need a missing value report `info`
 * rather than silently passing.
 */
export interface DfmContext {
  boardThicknessMm?: number
  layerCount?: number
  /** Panel outer size, when a panel has been computed (CAM tool only). */
  panelWidthMm?: number
  panelHeightMm?: number
}

// ─── Output ──────────────────────────────────────────────────────────────────

export type DfmSeverity = "error" | "warning" | "info" | "pass"

export interface DfmFinding {
  checkId: string
  severity: DfmSeverity
  title: string
  detail: string
  /** Measured value in mm (or a ratio/count), when the check measured one. */
  measuredValue?: number
  /** The threshold it was compared against. */
  limitValue?: number
  /** Which layer produced the measurement, when attributable. */
  layerName?: string
}

export interface DfmReport {
  findings: DfmFinding[]
  summary: { errors: number; warnings: number; infos: number; passes: number }
  ranAt: string
}
