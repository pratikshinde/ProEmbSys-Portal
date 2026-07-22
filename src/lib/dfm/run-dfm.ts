/**
 * DFM engine — pure, side-effect free. Takes already-parsed layers (never
 * re-parses), the design facts the files can't supply, and a rule set, and
 * returns a report.
 *
 * Scope is Tier A (see DFM_DRC_ROADMAP.md §3): everything derivable from
 * aperture/drill dimensions and board metadata, with no geometry engine.
 * Annular ring and copper-spacing checks are Phases 2/3.
 *
 * Shared verbatim by the CAM Panelization tool and (next slice) the PCB Order
 * page — both can produce `DfmLayerInput[]` from what they already hold.
 */

import type { DfmContext, DfmFinding, DfmLayerInput, DfmReport, DfmLimit, DfmRules } from "./types"
import {
  boardSizeMm,
  copperSideCount,
  minDrillDiameterMm,
  minFlashedFeatureMm,
  minStrokeWidthMm,
} from "./measure"

const mm = (v: number) => `${v.toFixed(3).replace(/\.?0+$/, "")}mm`

/**
 * Grade a "must be at least X" measurement.
 * Below `advanced` (or below `standard` when no advanced option exists) is an
 * error — we can't build it. Between the two is a warning: outside our standard
 * process but achievable on request, which is exactly what /fab-capabilities
 * promises.
 *
 * `ceiling` caps how bad a breach can be graded, for rules whose consequence is
 * cosmetic rather than manufacturability. Thin silkscreen, for example, prints
 * poorly or gets dropped — it never makes a board unbuildable, so flagging it
 * as an error would cry wolf on a large share of real KiCad exports (their
 * default silk line width sits just under our 0.15mm standard).
 */
function gradeMinimum(
  measured: number,
  limit: DfmLimit,
  ceiling: "error" | "warning" = "error"
): "error" | "warning" | "pass" {
  const hardFloor = limit.advanced ?? limit.standard
  if (measured < hardFloor) return ceiling
  if (measured < limit.standard) return "warning"
  return "pass"
}

function limitDetail(limit: DfmLimit): string {
  return limit.advanced !== undefined
    ? `standard ${mm(limit.standard)}, advanced ${mm(limit.advanced)}`
    : `standard ${mm(limit.standard)}`
}

export function runDfm(layers: DfmLayerInput[], context: DfmContext, rules: DfmRules): DfmReport {
  const findings: DfmFinding[] = []

  if (layers.length === 0) {
    return emptyReport()
  }

  // ─── Board size ────────────────────────────────────────────────────────────
  const board = boardSizeMm(layers)
  if (!board) {
    findings.push({
      checkId: "board-size",
      severity: "info",
      title: "Board size not checked",
      detail: "No outline/profile layer was found, so board dimensions could not be measured.",
    })
  } else {
    const largest = Math.max(board.widthMm, board.heightMm)
    findings.push({
      checkId: "board-size",
      severity: largest > rules.maxBoardMm ? "error" : "pass",
      title: largest > rules.maxBoardMm ? "Board exceeds maximum size" : "Board size within limits",
      detail: `Board measures ${mm(board.widthMm)} × ${mm(board.heightMm)} (max ${mm(rules.maxBoardMm)} per edge).`,
      measuredValue: largest,
      limitValue: rules.maxBoardMm,
    })
  }

  // ─── Panel size (CAM tool only — a panel can legally exceed one board) ──────
  if (context.panelWidthMm !== undefined && context.panelHeightMm !== undefined) {
    const largestPanel = Math.max(context.panelWidthMm, context.panelHeightMm)
    findings.push({
      checkId: "panel-size",
      severity: largestPanel > rules.maxBoardMm ? "error" : "pass",
      title: largestPanel > rules.maxBoardMm ? "Panel exceeds maximum size" : "Panel size within limits",
      detail: `Panel measures ${mm(context.panelWidthMm)} × ${mm(context.panelHeightMm)} (max ${mm(rules.maxBoardMm)} per edge).`,
      measuredValue: largestPanel,
      limitValue: rules.maxBoardMm,
    })
  }

  // ─── Layer count ───────────────────────────────────────────────────────────
  // Prefer the caller's value: inner layers of a 4/6/8-layer stack-up are not
  // distinguishable from an outer-layer Gerber export by filename or content.
  const detectedSides = copperSideCount(layers)
  const layerCount = context.layerCount ?? (detectedSides > 0 ? detectedSides : undefined)
  if (layerCount === undefined) {
    findings.push({
      checkId: "layer-count",
      severity: "info",
      title: "Layer count not checked",
      detail: "No copper layers were detected and no layer count was supplied.",
    })
  } else {
    const [minL, maxL] = rules.layerRange
    const outside = layerCount < minL || layerCount > maxL
    findings.push({
      checkId: "layer-count",
      severity: outside ? "error" : "pass",
      title: outside ? "Layer count outside capability" : "Layer count within capability",
      detail: `${layerCount} copper layer${layerCount === 1 ? "" : "s"} (supported ${minL}–${maxL}).${
        context.layerCount === undefined ? " Detected from the uploaded files." : ""
      }`,
      measuredValue: layerCount,
    })
  }

  // ─── Board thickness ───────────────────────────────────────────────────────
  const [minT, maxT] = rules.boardThicknessMm
  if (context.boardThicknessMm === undefined) {
    findings.push({
      checkId: "board-thickness",
      severity: "info",
      title: "Board thickness not checked",
      detail: "Board thickness isn't present in Gerber data — supply it to check this rule.",
    })
  } else {
    const outside = context.boardThicknessMm < minT || context.boardThicknessMm > maxT
    findings.push({
      checkId: "board-thickness",
      severity: outside ? "error" : "pass",
      title: outside ? "Board thickness outside capability" : "Board thickness within capability",
      detail: `${mm(context.boardThicknessMm)} (supported ${mm(minT)}–${mm(maxT)}).`,
      measuredValue: context.boardThicknessMm,
    })
  }

  // ─── Minimum drill ─────────────────────────────────────────────────────────
  const drill = minDrillDiameterMm(layers)
  if (!drill) {
    findings.push({
      checkId: "min-drill",
      severity: "info",
      title: "Drill size not checked",
      detail: "No drill/Excellon layer was found in this set.",
    })
  } else {
    const severity = gradeMinimum(drill.valueMm, rules.minDrillMm)
    findings.push({
      checkId: "min-drill",
      severity,
      title: severity === "pass" ? "Drill sizes within capability" : "Drill smaller than capability",
      detail: `Smallest drill is ${mm(drill.valueMm)} (${limitDetail(rules.minDrillMm)}).`,
      measuredValue: drill.valueMm,
      limitValue: rules.minDrillMm.standard,
      layerName: drill.layerName,
    })
  }

  // ─── Aspect ratio (thickness : smallest drill) ─────────────────────────────
  if (drill && context.boardThicknessMm !== undefined) {
    const ratio = context.boardThicknessMm / drill.valueMm
    const over = ratio > rules.maxAspectRatio
    findings.push({
      checkId: "aspect-ratio",
      severity: over ? "error" : "pass",
      title: over ? "Drill aspect ratio too high" : "Drill aspect ratio within capability",
      detail: `${ratio.toFixed(1)}:1 (${mm(context.boardThicknessMm)} thickness ÷ ${mm(
        drill.valueMm
      )} drill; max ${rules.maxAspectRatio}:1).`,
      measuredValue: ratio,
      limitValue: rules.maxAspectRatio,
    })
  } else if (drill) {
    findings.push({
      checkId: "aspect-ratio",
      severity: "info",
      title: "Aspect ratio not checked",
      detail: "Needs board thickness, which isn't present in Gerber data.",
    })
  }

  // ─── Minimum trace width ───────────────────────────────────────────────────
  const copper = layers.filter((l) => l.type === "copper")
  const trace = minStrokeWidthMm(copper)
  if (!trace) {
    findings.push({
      checkId: "min-trace-width",
      severity: "info",
      title: "Trace width not checked",
      detail:
        copper.length === 0
          ? "No copper layers were found in this set."
          : "No stroked tracks with circular apertures were found on the copper layers.",
    })
  } else {
    const severity = gradeMinimum(trace.valueMm, rules.minTraceWidthMm)
    findings.push({
      checkId: "min-trace-width",
      severity,
      title: severity === "pass" ? "Trace widths within capability" : "Trace narrower than capability",
      detail: `Narrowest track is ${mm(trace.valueMm)} (${limitDetail(rules.minTraceWidthMm)}).`,
      measuredValue: trace.valueMm,
      limitValue: rules.minTraceWidthMm.standard,
      layerName: trace.layerName,
    })
  }

  // ─── Minimum silkscreen line width ─────────────────────────────────────────
  const silk = layers.filter((l) => l.type === "silk")
  const silkLine = minStrokeWidthMm(silk)
  if (silkLine) {
    // Ceiling at warning — see gradeMinimum: illegible silk is cosmetic.
    const severity = gradeMinimum(silkLine.valueMm, rules.minSilkLineWidthMm, "warning")
    findings.push({
      checkId: "min-silk-line-width",
      severity,
      title: severity === "pass" ? "Silkscreen lines within capability" : "Silkscreen line too thin",
      detail: `Thinnest silkscreen line is ${mm(silkLine.valueMm)} (${limitDetail(rules.minSilkLineWidthMm)}). Thin silk may print broken or be dropped.`,
      measuredValue: silkLine.valueMm,
      limitValue: rules.minSilkLineWidthMm.standard,
      layerName: silkLine.layerName,
    })
  } else if (silk.length > 0) {
    findings.push({
      checkId: "min-silk-line-width",
      severity: "info",
      title: "Silkscreen line width not checked",
      detail: "No stroked silkscreen lines with circular apertures were found.",
    })
  }

  // ─── Smallest copper pad (informational) ───────────────────────────────────
  // Reported, never graded: we publish no minimum pad-size spec, and inventing
  // a threshold would produce findings we couldn't justify to a customer.
  const feature = minFlashedFeatureMm(copper)
  if (feature) {
    findings.push({
      checkId: "smallest-copper-feature",
      severity: "info",
      title: "Smallest copper pad",
      detail: `${mm(feature.valueMm)}. Informational — macro-defined pads (e.g. rounded rectangles) are excluded from this measurement.`,
      measuredValue: feature.valueMm,
      layerName: feature.layerName,
    })
  }

  return buildReport(findings)
}

function buildReport(findings: DfmFinding[]): DfmReport {
  return {
    findings,
    summary: {
      errors: findings.filter((f) => f.severity === "error").length,
      warnings: findings.filter((f) => f.severity === "warning").length,
      infos: findings.filter((f) => f.severity === "info").length,
      passes: findings.filter((f) => f.severity === "pass").length,
    },
    ranAt: new Date().toISOString(),
  }
}

function emptyReport(): DfmReport {
  return buildReport([
    {
      checkId: "no-layers",
      severity: "info",
      title: "Nothing to check",
      detail: "Import Gerber layers first, then run the check.",
    },
  ])
}
