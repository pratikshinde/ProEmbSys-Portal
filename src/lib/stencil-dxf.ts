/**
 * Closed-ring geometry → DXF R12 ASCII.
 *
 * Deliberately R12's `POLYLINE`/`VERTEX`/`SEQEND` entity triplet, not the
 * newer `LWPOLYLINE` (DXF R14+) — R12 is the oldest, most universally
 * parsed DXF entity form, which matters here since the target is cheap
 * laser-cutter software (LightBurn, LaserGRBL, generic Ruida/Trocen
 * controllers) with uneven modern-DXF support. No DXF-writing code exists
 * anywhere else in the repo; this follows `routing/emit-gerber.ts` /
 * `emit-excellon.ts`'s plain `string[]` + push + `.join('\n')` style rather
 * than pulling in a templating or DXF library.
 */

export interface Point {
  x: number
  y: number
}

export interface DxfStencilLayer {
  /** DXF layer name, e.g. "APERTURES" or "OUTLINE". */
  name: string
  /** Each entry is one CLOSED polyline (ring). Points must NOT repeat the
   *  first point at the end — same convention as ConvexHull output / a
   *  ContourRing. */
  rings: Point[][]
}

function pushHeader(lines: string[]): void {
  lines.push('0', 'SECTION')
  lines.push('2', 'HEADER')
  // $INSUNITS 4 = millimetres.
  lines.push('9', '$INSUNITS')
  lines.push('70', '4')
  lines.push('0', 'ENDSEC')
}

function pushLayerTable(lines: string[], layerNames: string[]): void {
  lines.push('0', 'SECTION')
  lines.push('2', 'TABLES')
  lines.push('0', 'TABLE')
  lines.push('2', 'LAYER')
  lines.push('70', String(layerNames.length))
  for (const name of layerNames) {
    lines.push('0', 'LAYER')
    lines.push('2', name)
    lines.push('70', '0')
    lines.push('62', '7') // color 7 = white/black (default)
    lines.push('6', 'CONTINUOUS')
  }
  lines.push('0', 'ENDTAB')
  lines.push('0', 'ENDSEC')
}

function fmt(v: number): string {
  // 6 decimal places is far below any laser-cutter's positioning resolution;
  // trailing zeros trimmed for a smaller, more readable file.
  return v.toFixed(6).replace(/0+$/, '').replace(/\.$/, '.0')
}

function pushPolyline(lines: string[], layerName: string, ring: Point[]): void {
  if (ring.length < 3) return
  lines.push('0', 'POLYLINE')
  lines.push('8', layerName)
  lines.push('66', '1') // vertices-follow flag
  lines.push('70', '1') // closed polyline
  for (const p of ring) {
    lines.push('0', 'VERTEX')
    lines.push('8', layerName)
    lines.push('10', fmt(p.x))
    lines.push('20', fmt(p.y))
    lines.push('30', '0.0')
  }
  lines.push('0', 'SEQEND')
}

/**
 * Serialize a set of closed-ring layers into a minimal DXF R12 ASCII file:
 * HEADER ($INSUNITS=4, mm) + TABLES (one LAYER entry per input layer) +
 * ENTITIES (one POLYLINE/VERTEX.../SEQEND per ring) + EOF.
 */
export function serializeStencilDxf(layers: DxfStencilLayer[]): string {
  const lines: string[] = []
  pushHeader(lines)
  pushLayerTable(
    lines,
    layers.map((l) => l.name)
  )
  lines.push('0', 'SECTION')
  lines.push('2', 'ENTITIES')
  for (const layer of layers) {
    for (const ring of layer.rings) pushPolyline(lines, layer.name, ring)
  }
  lines.push('0', 'ENDSEC')
  lines.push('0', 'EOF')
  return lines.join('\n')
}
