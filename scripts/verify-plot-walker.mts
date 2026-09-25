/**
 * Byte-identity gate for the plot-walker extraction (plan P0).
 *
 * `plotTreeToPdfContent` is being refactored from a self-contained walker
 * into a thin sink over the shared `plot-walker.ts`. Its output stream must
 * not change by a single byte. Run this BEFORE the refactor to capture a
 * baseline, then again after:
 *
 *   npx tsx scripts/verify-plot-walker.mts --save     # capture baseline
 *   npx tsx scripts/verify-plot-walker.mts            # compare against it
 *
 * Inputs are real customer copper (the WLC Indicator top layer is ~506 KB of
 * dense KiCad output — macros, regions, arcs, clear polarity), so this
 * exercises far more of the shape grammar than any synthetic fixture would.
 */
import { createHash } from "node:crypto"
import { readFileSync, writeFileSync, existsSync } from "node:fs"
import { parse } from "@tracespace/parser"
import { plot } from "@tracespace/plotter"

import { normalizeGerberMacroPrimitives, normalizeFilmGerberZeroSuppression, scalePlotTreeToMm } from "../src/lib/gerber-preprocess"
import { plotTreeToPdfContent, type PolarizedImageTree, type FilmPolarity } from "../src/lib/film/plot-to-pdf"

const BASELINE_PATH = "scripts/.plot-walker-baseline.json"
const save = process.argv.includes("--save")

const CASES: { file: string; label: string; polarity: FilmPolarity }[] = [
  { file: "_top_cu.gbr", label: "Top_Copper/positive", polarity: "positive" },
  { file: "_top_cu.gbr", label: "Top_Copper/negative", polarity: "negative" },
  { file: "_bot_cu.gbr", label: "Bottom_Copper/positive", polarity: "positive" },
]

const results: Record<string, { sha256: string; length: number; warnings: string[] }> = {}

for (const c of CASES) {
  if (!existsSync(c.file)) {
    console.error(`MISSING INPUT: ${c.file} — dump it from the CAM job first.`)
    process.exit(1)
  }
  const raw = readFileSync(c.file, "utf8")
  const tree = parse(normalizeFilmGerberZeroSuppression(normalizeGerberMacroPrimitives(raw)))
  const image = plot(tree) as unknown as PolarizedImageTree
  scalePlotTreeToMm(image)

  const { content, warnings } = plotTreeToPdfContent(image, {
    polarity: c.polarity,
    panelWidthMm: 200,
    panelHeightMm: 300,
    marginMm: 5,
  })

  results[c.label] = {
    sha256: createHash("sha256").update(content).digest("hex"),
    length: content.length,
    warnings,
  }
  console.log(`${c.label}: ${content.length} bytes, sha256 ${results[c.label].sha256.slice(0, 16)}…, ${warnings.length} warning(s)`)
}

if (save) {
  writeFileSync(BASELINE_PATH, JSON.stringify(results, null, 2))
  console.log(`\nBaseline saved to ${BASELINE_PATH}`)
  process.exit(0)
}

if (!existsSync(BASELINE_PATH)) {
  console.error(`\nNo baseline at ${BASELINE_PATH} — run with --save first.`)
  process.exit(1)
}

const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as typeof results
let failed = false
for (const label of Object.keys(results)) {
  const a = baseline[label]
  const b = results[label]
  if (!a) {
    console.error(`FAIL ${label}: not in baseline`)
    failed = true
    continue
  }
  if (a.sha256 !== b.sha256) {
    console.error(`FAIL ${label}: content changed (${a.length} -> ${b.length} bytes, ${a.sha256.slice(0, 16)}… -> ${b.sha256.slice(0, 16)}…)`)
    failed = true
  } else if (JSON.stringify(a.warnings) !== JSON.stringify(b.warnings)) {
    console.error(`FAIL ${label}: warnings changed`)
    failed = true
  } else {
    console.log(`PASS ${label}: byte-identical`)
  }
}
process.exit(failed ? 1 : 0)
