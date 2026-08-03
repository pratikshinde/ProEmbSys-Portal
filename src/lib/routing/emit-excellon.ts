/**
 * Route paths → Excellon-format rout program, and mouse-bite holes → drill.
 *
 * ⚠ **The rout dialect here is PROVISIONAL.** Unlike the drill output — which
 * was built against real CAM350 exports (`Sample/sample panel/pinn.drl`) — there
 * is no CAM350-produced rout file in this repo to diff against. What we emit is
 * the standard Excellon-2 rout form:
 *
 *   G00 X… Y…   rapid to the start of a pass (tool up)
 *   M15         plunge (tool down)
 *   G01 X… Y…   linear cut moves
 *   M16         retract (tool up)
 *   …
 *   M17         end of rout mode
 *   M30         end of program
 *
 * Get one CAM350 rout export from the shop and diff against it before treating
 * this as production-ready.
 *
 * All coordinates go through `formatDrillCoordinate` and the header through
 * `generateDrillFormatHeader` — never hand-format an Excellon coordinate. CAM350
 * inverts the LZ/TZ zero-suppression keywords, and those two helpers are the
 * only places that inversion is correctly accounted for.
 */

import {
  emitExcellonToolBlock,
  formatDrillCoordinate,
  generateDrillFormatHeader,
  resolveExportDrillFormat,
  type DrillFormatConfig,
  type PanelResult,
} from '../panelization-engine'
import { collectMouseBiteHoles, type RoutingResult } from './types'

/**
 * Excellon rout program for every routed pass.
 *
 * @param panel Only used to widen the coordinate format for large panels, via
 *   the same `resolveExportDrillFormat` the drill files use.
 */
export function generateRoutFile(
  result: RoutingResult,
  drillFormat: DrillFormatConfig,
  panel: PanelResult
): string {
  const drillFmt = resolveExportDrillFormat(drillFormat, panel, 'Route Export')
  const bit = result.config.bitDiameterMm

  const lines: string[] = []
  lines.push(...generateDrillFormatHeader(drillFmt))
  // One tool: the router bit. Reuses the same T-code/params convention as the
  // drill files so a CAM tool reading both sees a consistent tool table.
  lines.push(...emitExcellonToolBlock([bit], drillFmt))

  const f = (v: number) => formatDrillCoordinate(v, drillFmt)

  // Select the router bit, then walk each pass: rapid to its start, plunge,
  // cut, retract. Tabs are already baked in as gaps *between* passes, so a
  // retract/rapid pair is exactly what skips over an uncut bridge.
  lines.push('T01')
  for (const path of result.paths) {
    if (path.points.length < 2) continue
    const [first, ...rest] = path.points
    lines.push(`G00X${f(first.x)}Y${f(first.y)}`)
    lines.push('M15')
    for (const pt of rest) {
      lines.push(`G01X${f(pt.x)}Y${f(pt.y)}`)
    }
    lines.push('M16')
  }

  lines.push('M17')
  lines.push('M30')
  return lines.join('\n')
}

/**
 * Mouse-bite perforations as a standalone Excellon drill program.
 *
 * Kept separate from the main panelized drill by default so the CAM350-verified
 * `_Drill.drl` output stays byte-identical, and because fabs commonly want the
 * break-away holes as their own NPTH program. Returns an empty string when there
 * are no bites, so callers can skip writing the file.
 */
export function generateMouseBiteDrill(
  result: RoutingResult,
  drillFormat: DrillFormatConfig,
  panel: PanelResult
): string {
  const holes = collectMouseBiteHoles(result)
  if (holes.length === 0) return ''

  const drillFmt = resolveExportDrillFormat(drillFormat, panel, 'MouseBite Export')

  // One tool per distinct hole diameter, sorted so T-codes are stable.
  const diameters = [...new Set(holes.map(h => h.diameter))].sort((a, b) => a - b)

  const lines: string[] = []
  lines.push(...generateDrillFormatHeader(drillFmt))
  lines.push(...emitExcellonToolBlock(diameters, drillFmt))

  const f = (v: number) => formatDrillCoordinate(v, drillFmt)

  for (const [i, dia] of diameters.entries()) {
    const tCode = `T${(i + 1).toString().padStart(2, '0')}`
    lines.push(tCode)
    for (const h of holes) {
      if (h.diameter !== dia) continue
      lines.push(`X${f(h.x)}Y${f(h.y)}`)
    }
  }

  lines.push('M30')
  return lines.join('\n')
}
