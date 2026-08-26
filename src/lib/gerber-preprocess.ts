/**
 * Workarounds for @tracespace/parser bugs, applied before handing Gerber
 * content to `parse()`. Kept separate from gerber-parser.ts (our own
 * RS-274X/Excellon parser, used for export math) since this only exists to
 * paper over the third-party tracespace pipeline used for on-screen
 * rendering (gerber-worker.ts, gerber-svg.ts).
 */

/**
 * @tracespace/parser silently drops an aperture macro's geometry when the
 * macro's primitive statement is wrapped across multiple lines — e.g.
 * Proteus commonly exports a long outline-primitive point list as:
 *
 *   %AMDIL008*
 *   4,1,8,
 *   -1.270000,0.457200,-0.965200,0.762000,...,
 *   0.965200,-0.762000,...,
 *   0*%
 *
 * This is valid RS-274X — a data block is only terminated by `*`, and
 * whitespace/newlines inside it are legal — but tracespace's tokenizer
 * treats the embedded newline as ending the primitive early. The macro node
 * ends up with a stray `macroComment` child instead of a `macroPrimitive`,
 * so every flash of that aperture renders as nothing. Confirmed against a
 * real Proteus export where this silently dropped copper AND soldermask
 * geometry for every DIL008/DIL010/PPADxxx-apertured pad on the board.
 *
 * Fix: collapse line breaks strictly INSIDE each `%AM...%` block before
 * parsing. Nothing outside macro blocks is touched, so this is a no-op for
 * (the much more common) single-line macro definitions.
 */
export function normalizeGerberMacroPrimitives(content: string): string {
  return content.replace(/%AM[^%]*%/g, (block) =>
    block.replace(/[ \t]*(\r\n|\r|\n)[ \t]*/g, (_match, _nl, offset: number, str: string) => {
      // Trailing-comma-per-line is the common case (Proteus, and most other
      // CAM tools that wrap macro bodies) — a bare line-break removal is
      // exactly right there. Defensively insert a comma when a wrapped line
      // does NOT already end in a delimiter, so two numbers can never fuse
      // into one on an unanticipated file (e.g. "...0.4572\n0.9652..." must
      // not become "...0.45720.9652...").
      const before = str.slice(0, offset).replace(/[ \t\r\n]+$/, '')
      const lastChar = before.slice(-1)
      return lastChar === ',' || lastChar === '*' ? '' : ','
    })
  )
}

/**
 * @tracespace/core's board compositor (renderLayers → renderBoard) is
 * unit-naive: it unions per-layer plot bounds and merges per-layer geometry
 * into one shared coordinate space using each tree's RAW native numbers,
 * never converting between inch- and mm-native layers. A homogeneous file
 * set is self-consistent by luck, but the moment units mix — e.g. inch-native
 * Protel Gerbers plus a drill file our Excellon pipeline re-serialized in
 * METRIC (auto-detect, format override, or "Align Drill to Board Center") —
 * the mm layer's numbers dwarf the inch layers' and the artwork collapses
 * into a corner of a wrongly-sized substrate.
 *
 * Fix: scale every inch-native plot tree (and the boardShape derived from an
 * inch-native outline layer) to millimetres in place, immediately after
 * corePlot and before any render/composite step. The plot-tree grammar is
 * small and closed (see @tracespace/plotter's tree.d.ts), so this walk is
 * exhaustive: shapes (circle/rectangle/polygon/outline/layered), path and
 * region segments (line/arc), stroke widths, and size envelopes. Arc theta
 * values are angles and must NOT be scaled.
 */
const MM_PER_INCH = 25.4

/* eslint-disable @typescript-eslint/no-explicit-any */
function scalePosition(p: number[] | undefined, k: number): void {
  if (!Array.isArray(p)) return
  // Position is [x, y]; ArcPosition is [x, y, theta] — theta stays.
  if (typeof p[0] === 'number') p[0] *= k
  if (typeof p[1] === 'number') p[1] *= k
}

function scaleSegments(segments: any[] | undefined, k: number): void {
  if (!Array.isArray(segments)) return
  for (const seg of segments) {
    if (!seg) continue
    scalePosition(seg.start, k)
    scalePosition(seg.end, k)
    scalePosition(seg.center, k)
    if (typeof seg.radius === 'number') seg.radius *= k
  }
}

function scaleShape(shape: any, k: number): void {
  if (!shape) return
  switch (shape.type) {
    case 'circle':
      shape.cx *= k; shape.cy *= k; shape.r *= k
      break
    case 'rectangle':
      shape.x *= k; shape.y *= k; shape.xSize *= k; shape.ySize *= k
      if (typeof shape.r === 'number') shape.r *= k
      break
    case 'polygon':
      if (Array.isArray(shape.points)) for (const p of shape.points) scalePosition(p, k)
      break
    case 'outline':
      scaleSegments(shape.segments, k)
      break
    case 'layeredShape':
      if (Array.isArray(shape.shapes)) for (const s of shape.shapes) scaleShape(s, k)
      break
  }
}

function scaleSizeEnvelope(size: any, k: number): void {
  if (!Array.isArray(size)) return
  for (let i = 0; i < size.length; i++) {
    if (typeof size[i] === 'number') size[i] *= k
  }
}

function scaleImageGraphic(node: any, k: number): void {
  if (!node) return
  if (node.shape) scaleShape(node.shape, k)
  if (typeof node.width === 'number') node.width *= k
  scaleSegments(node.segments, k)
}

/**
 * Scale an @tracespace/plotter ImageTree to millimetres in place when it is
 * inch-native; a no-op for mm-native trees. Returns true if scaling happened.
 */
export function scalePlotTreeToMm(tree: any): boolean {
  if (!tree || tree.units !== 'in') return false
  for (const child of tree.children ?? []) scaleImageGraphic(child, MM_PER_INCH)
  scaleSizeEnvelope(tree.size, MM_PER_INCH)
  tree.units = 'mm'
  return true
}

/**
 * Scale an @tracespace/core BoardShape ({ size, regions, openPaths }) to
 * millimetres in place. The caller decides whether to invoke it, since a
 * BoardShape does not carry its own units — its coordinate space is that of
 * the outline layer's plot tree it was derived from.
 */
export function scaleBoardShapeToMm(boardShape: any): void {
  if (!boardShape) return
  scaleSizeEnvelope(boardShape.size, MM_PER_INCH)
  for (const region of boardShape.regions ?? []) scaleImageGraphic(region, MM_PER_INCH)
  for (const path of boardShape.openPaths ?? []) scaleImageGraphic(path, MM_PER_INCH)
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * `generateFSCommand` (panelization-engine.ts) emits `%FS<zero><notation>...`
 * where `<zero>` is `L`/`T` for leading/trailing zero omission, but is the
 * EMPTY STRING when the user's export config picks `zeroOmission: 'none'` —
 * producing e.g. `%FSAX46Y46*%` with no zero-suppression character at all.
 * `formatCoordinate` (same file) has no `'none'` branch, though: its `else`
 * arm unconditionally strips TRAILING zeros for anything that isn't
 * `'leading'`. So the coordinate VALUES in the body are trailing-suppressed
 * while the header declares no suppression — self-contradictory Gerber.
 *
 * tracespace's own zero-suppression sniffer (`getPlotOptions` in
 * @tracespace/plotter) falls back to guessing from the first body
 * coordinate when the header doesn't declare one, and frequently guesses
 * LEADING — the wrong one — which decodes every coordinate in the file by
 * roughly 10^(digit count) too small or too large. A film generated from
 * that misparse would be scrap at the wrong scale, not just wrong-looking.
 *
 * This is a real non-conformance in the exported Gerber itself (out of
 * scope to fix here — a fab-facing task on its own), but the film pipeline
 * can and must route around it deterministically, since it knows exactly
 * what the emitter actually did: rewrite a zero-suppression-less `%FS` to
 * declare `T` (trailing), matching `formatCoordinate`'s real behavior. A
 * no-op for the overwhelming majority of exports, which already declare
 * `L` or `T` explicitly.
 */
export function normalizeFilmGerberZeroSuppression(content: string): string {
  return content.replace(/%FS([AI])(X\d\dY\d\d)\*%/, '%FST$1$2*%')
}
