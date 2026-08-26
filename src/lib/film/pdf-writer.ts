/**
 * Minimal PDF 1.4 container writer — hand-rolled, no dependency.
 *
 * Same precedent as `stencil-dxf.ts` (DXF R12, no library) and
 * `routing/emit-gerber.ts`/`emit-excellon.ts` (plain `string[]` + push):
 * a photo-plot film has a hard 1:1-scale requirement, and every PDF library
 * evaluated for this feature (jsPDF, pdf-lib, svg2pdf.js) either needs a
 * live DOM (can't run in the render worker) or has its own unit/scale
 * plumbing that is exactly where a hard 1:1 requirement dies silently. The
 * content-stream operator set this needs is tiny (path construction, fill,
 * stroke, gray, clip, save/restore) and is fully covered below.
 *
 * Deliberately produces an UNCOMPRESSED content stream by default — a
 * readable stream is a genuine verification asset (see the film
 * verification script), and JSZip DEFLATEs the file inside the export ZIP
 * anyway, so uncompressed-in-zip is not a real size cost for the common
 * case. `/FlateDecode` compression is a follow-up, not implemented here.
 */

/** Points per millimetre (PDF user space is 1/72 inch by default). */
export const PT_PER_MM = 72 / 25.4

/**
 * Format a number for a PDF content stream: fixed 4dp, trailing zeros and a
 * bare trailing "." trimmed, NEVER exponential notation (PDF content
 * streams do not accept "1e-7" — that token is invalid and would corrupt
 * every operator after it). `-0` is normalized to `0`. Non-finite input
 * (NaN/Infinity — should never happen upstream, but a single corrupt value
 * must not corrupt the whole stream) degrades to `0`.
 */
export function fmtNum(v: number): string {
  if (!Number.isFinite(v)) return '0'
  let s = v.toFixed(4)
  if (s.includes('.')) {
    s = s.replace(/0+$/, '').replace(/\.$/, '')
  }
  if (s === '-0' || s === '') s = '0'
  return s
}

/**
 * Builds one PDF content stream (the operator sequence for one page) as
 * plain text — `string[]` + push + `.join('\n')`, same style as
 * `stencil-dxf.ts`. Deliberately low-level (path construction and painting
 * are separate calls) rather than one "draw this shape" method per shape
 * type, because the caller (`plot-to-pdf.ts`) needs to compose paths for
 * both painting AND clipping (the erase/complement-clip case — see that
 * module's own docs for why a plain even-odd union across shapes is wrong).
 */
export class PdfContentBuilder {
  private ops: string[] = []

  /** Escape hatch for a raw content-stream operator line. Used sparingly —
   *  prefer a typed method below when one exists. */
  raw(op: string): void {
    this.ops.push(op)
  }

  moveTo(x: number, y: number): void {
    this.ops.push(`${fmtNum(x)} ${fmtNum(y)} m`)
  }

  lineTo(x: number, y: number): void {
    this.ops.push(`${fmtNum(x)} ${fmtNum(y)} l`)
  }

  curveTo(x1: number, y1: number, x2: number, y2: number, x3: number, y3: number): void {
    this.ops.push(`${fmtNum(x1)} ${fmtNum(y1)} ${fmtNum(x2)} ${fmtNum(y2)} ${fmtNum(x3)} ${fmtNum(y3)} c`)
  }

  closePath(): void {
    this.ops.push('h')
  }

  /** Appends a rectangle subpath (`re`) — does not paint it. A standalone
   *  4-line rectangle, not built from moveTo/lineTo, so it always closes
   *  itself cleanly regardless of what came before. */
  rectPath(x: number, y: number, w: number, h: number): void {
    this.ops.push(`${fmtNum(x)} ${fmtNum(y)} ${fmtNum(w)} ${fmtNum(h)} re`)
  }

  /** Fills every subpath accumulated since the last paint/clip operator,
   *  even-odd winding. Regions and outlines rely on even-odd for their own
   *  holes (a hole is just a subpath wound the opposite way) — but painting
   *  more than one GRAPHIC under one `f*` is a correctness trap (see
   *  `plot-to-pdf.ts`'s "one fill operator per graphic" rule): overlapping
   *  shapes from different graphics cancel under even-odd instead of
   *  unioning. Callers must call this once per graphic. */
  fillEvenOdd(): void {
    this.ops.push('f*')
  }

  /** Sets stroke width (mm, in the current CTM — the caller's `cm` scale
   *  turns this into physical mm) and round caps/joins to match Gerber trace
   *  semantics (a stroked aperture has no miter/butt concept), then strokes
   *  every subpath accumulated since the last paint operator. */
  strokeCurrentPath(widthMm: number): void {
    this.ops.push(`${fmtNum(widthMm)} w`)
    this.ops.push('1 J')
    this.ops.push('1 j')
    this.ops.push('S')
  }

  setGrayFill(g: 0 | 1): void {
    this.ops.push(`${g} g`)
  }

  setGrayStroke(g: 0 | 1): void {
    this.ops.push(`${g} G`)
  }

  save(): void {
    this.ops.push('q')
  }

  restore(): void {
    this.ops.push('Q')
  }

  /** Intersects the clip region with every subpath accumulated since the
   *  last paint/clip operator (even-odd), then discards the path without
   *  painting it (`n`). Must be called immediately before the paint
   *  operators it's meant to constrain, per PDF's clip-applies-to-next-paint
   *  semantics. */
  clipEvenOddNoPaint(): void {
    this.ops.push('W*')
    this.ops.push('n')
  }

  /** Applies a uniform scale + translation as the current transform matrix.
   *  Uniform is load-bearing — a non-uniform `cm` would distort stroke
   *  width direction-dependently, which `strokeCurrentPath`'s single-number
   *  width has no way to express. */
  concatUniformTransform(scale: number, translateX: number, translateY: number): void {
    this.ops.push(`${fmtNum(scale)} 0 0 ${fmtNum(scale)} ${fmtNum(translateX)} ${fmtNum(translateY)} cm`)
  }

  build(): string {
    return this.ops.join('\n')
  }
}

export interface BuildPdfOptions {
  /** Page width in PDF points (1/72 inch). */
  widthPt: number
  /** Page height in PDF points. */
  heightPt: number
  /** The complete content stream body (e.g. `builder.build()`). */
  content: string
}

const textEncoder = new TextEncoder()

/** Byte length of an all-ASCII string. Every string this module ever builds
 *  (PDF names, numbers, operators, dictionary syntax) is deliberately
 *  ASCII-only, so this equals `TextEncoder`'s real UTF-8 byte count — but
 *  going through the encoder rather than trusting `.length` is exactly the
 *  guard the byte-offset trap needs: the moment any future caller pushes a
 *  non-ASCII character (a µ in a warning string, a curly quote), `.length`
 *  and the real byte count silently diverge and every xref offset after it
 *  is wrong. */
function byteLength(s: string): number {
  return textEncoder.encode(s).length
}

/**
 * Assembles a single-page, single-content-stream PDF 1.4 file: Catalog →
 * Pages → Page → Contents, an xref table, and a trailer. No compression, no
 * fonts, no images, no annotations — exactly what a vector film plot needs
 * and nothing else.
 *
 * Byte-offset discipline: every object is appended as a UTF-8-encoded
 * chunk with the running offset tracked via `byteLength`, never
 * `string.length` — see that function's own docs for why the distinction
 * matters even though today's content happens to be pure ASCII.
 */
export function buildSinglePagePdf(opts: BuildPdfOptions): Uint8Array {
  const { widthPt, heightPt, content } = opts

  const chunks: string[] = []
  let offset = 0
  const objectOffsets: number[] = [] // 1-indexed; objectOffsets[n] = byte offset of "n 0 obj"

  function push(s: string): void {
    chunks.push(s)
    offset += byteLength(s)
  }

  function beginObject(n: number): void {
    objectOffsets[n] = offset
    push(`${n} 0 obj\n`)
  }

  function endObject(): void {
    push('endobj\n')
  }

  // Header. The second line is the conventional "this file is binary"
  // marker — a comment containing bytes with the high bit set, which stops
  // a naive FTP/email relay from line-ending-mangling the file (a real
  // historical PDF-in-transit corruption class). The exact byte values
  // don't matter, only that they're non-ASCII; these four JS string escapes
  // encode to UTF-8 multi-byte sequences (verified: all high-bit), not the
  // single raw bytes the escapes look like — harmless here since nothing
  // else reads this line, but worth knowing before copying this pattern
  // somewhere byte-for-byte value DOES matter.
  push('%PDF-1.4\n')
  push('%\xE2\xE3\xCF\xD3\n')

  // 1: Catalog
  beginObject(1)
  push('<< /Type /Catalog /Pages 2 0 R >>\n')
  endObject()

  // 2: Pages
  beginObject(2)
  push('<< /Type /Pages /Kids [3 0 R] /Count 1 >>\n')
  endObject()

  // 3: Page
  beginObject(3)
  push(
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${fmtNum(widthPt)} ${fmtNum(heightPt)}] ` +
      '/Resources << >> /Contents 4 0 R >>\n'
  )
  endObject()

  // 4: Contents stream. /Length is the exact byte length of the stream
  // body (between the newline after "stream" and the "endstream" keyword,
  // per PDF spec) — computed from the same byteLength() as everything else
  // here, not string.length, for the same reason.
  beginObject(4)
  const streamBody = content.endsWith('\n') ? content : content + '\n'
  push(`<< /Length ${byteLength(streamBody)} >>\nstream\n`)
  push(streamBody)
  push('endstream\n')
  endObject()

  const objectCount = 4

  // xref table. Entry 0 is the fixed free-list head; every real object
  // entry is a 10-digit zero-padded byte offset + " 00000 n " — 20 bytes
  // per line INCLUDING the trailing space, per spec (a short line here is
  // one of the most common causes of an "invalid PDF" from a hand-rolled
  // writer).
  const xrefOffset = offset
  push(`xref\n0 ${objectCount + 1}\n`)
  push('0000000000 65535 f \n')
  for (let n = 1; n <= objectCount; n++) {
    push(`${String(objectOffsets[n]).padStart(10, '0')} 00000 n \n`)
  }

  // Trailer
  push(`trailer\n<< /Size ${objectCount + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`)

  return textEncoder.encode(chunks.join(''))
}
