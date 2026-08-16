/**
 * V-score lines/marks → standalone RS-274X Gerber documentation layer.
 *
 * Written as its own file, so — mirroring `routing/emit-gerber.ts` — it owns
 * its aperture namespace outright: no `findMaxDCode` collision avoidance
 * needed the way the built-in copper/mask marks (`panelization-engine.ts`'s
 * step 6.7) require.
 *
 * Emits BOTH the full-length score lines (panel-wide, through the PCB area —
 * appropriate here since this is a documentation/CAM layer, not customer
 * copper/mask) and the same rib-confined marks the built-in layers get, via
 * the one shared `computeVScoreMarkStrokes` generator so this file can never
 * disagree with the preview or the built-in emission.
 */

import {
  DEFAULT_OUTPUT_FORMAT,
  computeVScoreMarkStrokes,
  formatCoordinate,
  generateFSCommand,
  generateGUnitCode,
  generateMOCommand,
  type OutputFormat,
  type PanelConfig,
  type PanelResult,
} from '../panelization-engine'

/** Aperture used for score lines and marks. Own file ⇒ no collision risk. */
const VSCORE_APERTURE_CODE = 10

export function generateVScoreGerber(
  panel: PanelResult,
  config: PanelConfig,
  outputFormat?: OutputFormat
): string {
  // Clone: exportPanelizedGerbers mutates the OutputFormat it is handed.
  const fmt: OutputFormat = { ...(outputFormat ?? DEFAULT_OUTPUT_FORMAT) }

  const lines: string[] = []
  lines.push('G04 V-Score layer — alignment reference for manual V-scoring machines*')
  lines.push('G04 Score lines run the full panel width/height (panel-through);*')
  lines.push('G04 rib marks indicate the blade entry point at each seam*')
  lines.push(generateFSCommand(fmt))
  lines.push(generateMOCommand(fmt))
  lines.push('%LNVScore*%')
  lines.push('%LPD*%')
  lines.push(`%ADD${VSCORE_APERTURE_CODE}C,${config.vScoreMarkLineWidth.toFixed(6)}*%`)
  lines.push(generateGUnitCode(fmt))
  lines.push('G01*')
  lines.push(`G54D${VSCORE_APERTURE_CODE}*`)

  const f = (v: number) => formatCoordinate(v, fmt)

  // Full-length lines, panel-wide.
  for (const line of panel.vScoreLines) {
    if (line.axis === 'x') {
      lines.push(`X${f(line.coord)}Y${f(0)}D02*`)
      lines.push(`X${f(line.coord)}Y${f(panel.panelHeight)}D01*`)
    } else {
      lines.push(`X${f(0)}Y${f(line.coord)}D02*`)
      lines.push(`X${f(panel.panelWidth)}Y${f(line.coord)}D01*`)
    }
  }

  // Rib marks — same shared geometry the built-in copper/mask layer uses.
  const strokes = computeVScoreMarkStrokes(panel.vScoreLines, panel.panelWidth, panel.panelHeight, config)
  for (const stroke of strokes) {
    stroke.forEach((pt, i) => {
      lines.push(`X${f(pt.x)}Y${f(pt.y)}D${i === 0 ? '02' : '01'}*`)
    })
  }

  lines.push('M02*')
  return lines.join('\n')
}
