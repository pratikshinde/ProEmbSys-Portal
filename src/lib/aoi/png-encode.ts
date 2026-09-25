/**
 * Minimal 1-bit greyscale PNG encoder for AOI reference artwork.
 *
 * Deliberately hand-rolled rather than using `canvas.convertToBlob()`:
 *
 *  - convertToBlob gives RGBA8 (colour type 6, 8 bits/channel). For a
 *    3326x4846 panel that's ~8x the bytes for data that is, by construction,
 *    one bit per pixel.
 *  - More importantly it would be only *conventionally* binary. An
 *    inspection reference must be unambiguous: bit depth 1, colour type 0
 *    means a pixel is copper or it is not, with no room for a stray
 *    antialiased grey to be argued about downstream. Android's BitmapFactory
 *    reads this form natively.
 *
 * Output is a standard PNG (RFC 2083): signature, IHDR, IDAT, IEND, each
 * chunk CRC32'd. IDAT carries zlib-wrapped deflate — which is exactly what
 * `CompressionStream('deflate')` produces (RFC 1950, header + Adler-32);
 * `'deflate-raw'` would NOT be valid here.
 */

const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[n] = c >>> 0
  }
  return table
})()

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  }
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, data.length)
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i)
  out.set(data, 8)
  // CRC covers the type bytes AND the data, not the length.
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)))
  return out
}

/**
 * Packs a 0/1-per-byte bitmap into PNG scanlines: one filter byte (0 =
 * None) followed by ceil(width/8) packed bytes, MSB = leftmost pixel.
 */
function toScanlines(bitmap: Uint8Array, widthPx: number, heightPx: number): Uint8Array {
  const bytesPerRow = Math.ceil(widthPx / 8)
  const out = new Uint8Array(heightPx * (1 + bytesPerRow))

  for (let y = 0; y < heightPx; y++) {
    const rowStart = y * (1 + bytesPerRow)
    out[rowStart] = 0 // filter: None
    const src = y * widthPx
    for (let x = 0; x < widthPx; x++) {
      if (bitmap[src + x]) {
        out[rowStart + 1 + (x >> 3)] |= 0x80 >> (x & 7)
      }
    }
  }
  return out
}

async function deflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream('deflate'))
  const buf = await new Response(stream).arrayBuffer()
  return new Uint8Array(buf)
}

/**
 * @param bitmap one byte per pixel, 0 = black (substrate) / 1 = white (copper),
 *               row-major, length must be widthPx * heightPx
 */
export async function encodeBinaryPng(bitmap: Uint8Array, widthPx: number, heightPx: number): Promise<Uint8Array> {
  if (bitmap.length !== widthPx * heightPx) {
    throw new Error(`Bitmap length ${bitmap.length} does not match ${widthPx}x${heightPx}`)
  }

  const ihdr = new Uint8Array(13)
  const ihdrView = new DataView(ihdr.buffer)
  ihdrView.setUint32(0, widthPx)
  ihdrView.setUint32(4, heightPx)
  ihdr[8] = 1 // bit depth
  ihdr[9] = 0 // colour type: greyscale
  ihdr[10] = 0 // compression: deflate
  ihdr[11] = 0 // filter method: adaptive
  ihdr[12] = 0 // interlace: none

  const idatData = await deflate(toScanlines(bitmap, widthPx, heightPx))

  const parts = [
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', idatData),
    chunk('IEND', new Uint8Array(0)),
  ]

  const total = parts.reduce((n, p) => n + p.length, 0)
  const png = new Uint8Array(total)
  let offset = 0
  for (const p of parts) {
    png.set(p, offset)
    offset += p.length
  }
  return png
}
