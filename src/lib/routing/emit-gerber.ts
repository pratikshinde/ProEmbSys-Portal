/**
 * Route paths → RS-274X Gerber.
 *
 * A documentation/interchange layer showing where the router cuts. It is written
 * as its own file, so it owns its aperture namespace outright: there is no need
 * for `findMaxDCode` collision avoidance the way there is when overlay features
 * are injected into a customer's copper or mask layer.
 *
 * Unlike `generatePanelOutlineGerber` (which hardcodes 3.4 mm to byte-match a
 * CAM350 sample) this respects the caller's `OutputFormat`, so the route layer
 * matches the digit count of every other file in the export.
 */

import {
  DEFAULT_OUTPUT_FORMAT,
  formatCoordinate,
  generateFSCommand,
  generateGUnitCode,
  generateMOCommand,
  type OutputFormat,
} from '../panelization-engine'
import type { RoutingResult } from './types'

/** Aperture used for the route trace. Own file ⇒ no collision risk. */
const ROUTE_APERTURE_CODE = 10
/** Hairline width for documentation-style output, in mm. */
const HAIRLINE_MM = 0.1

export function generateRouteGerber(
  result: RoutingResult,
  outputFormat?: OutputFormat
): string {
  // Clone: exportPanelizedGerbers mutates the OutputFormat it is handed
  // (fmt.integerDigits = …), and that object comes straight from the store.
  const fmt: OutputFormat = { ...(outputFormat ?? DEFAULT_OUTPUT_FORMAT) }
  const cfg = result.config

  // Aperture = bit diameter so the layer shows the real cut swath; hairline is
  // opt-in for when the file is meant as a drawing rather than a swath preview.
  const apertureMm = cfg.routeGerberHairline ? HAIRLINE_MM : cfg.bitDiameterMm

  const lines: string[] = []
  lines.push('G04 Route layer — router tool paths*')
  lines.push('G04 Coordinates are TOOL-CENTER, offset outward from the finished*')
  lines.push(`G04 board edge by the bit radius (${(cfg.bitDiameterMm / 2).toFixed(4)} mm)*`)
  lines.push(generateFSCommand(fmt))
  lines.push(generateMOCommand(fmt))
  lines.push('%LNRoute*%')
  lines.push('%LPD*%')
  lines.push(`%ADD${ROUTE_APERTURE_CODE}C,${apertureMm.toFixed(6)}*%`)
  lines.push(generateGUnitCode(fmt))
  lines.push('G01*')
  lines.push(`G54D${ROUTE_APERTURE_CODE}*`)

  const f = (v: number) => formatCoordinate(v, fmt)

  for (const path of result.paths) {
    if (path.points.length < 2) continue
    const [first, ...rest] = path.points
    lines.push(`X${f(first.x)}Y${f(first.y)}D02*`)
    for (const pt of rest) {
      lines.push(`X${f(pt.x)}Y${f(pt.y)}D01*`)
    }
  }

  lines.push('M02*')
  return lines.join('\n')
}
