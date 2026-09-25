/** Decode a 1-bit greyscale PNG by hand — no image decoder in the loop. */
import { readFileSync } from 'node:fs'
import { inflateSync, deflateSync } from 'node:zlib'

const file = process.argv[2] ?? 'C:/Users/ProEmbSys/AppData/Local/Temp/Top_Drill.png'
const b = readFileSync(file)
const width = b.readUInt32BE(16), height = b.readUInt32BE(20)
const bitDepth = b[24], colorType = b[25]

// Walk chunks, concatenate IDAT.
const idat: Buffer[] = []
let off = 8
const types: string[] = []
while (off < b.length) {
  const len = b.readUInt32BE(off)
  const type = b.toString('ascii', off + 4, off + 8)
  types.push(`${type}(${len})`)
  if (type === 'IDAT') idat.push(b.subarray(off + 8, off + 8 + len))
  off += 12 + len
  if (type === 'IEND') break
}

const raw = inflateSync(Buffer.concat(idat))
const bytesPerRow = Math.ceil((width * bitDepth) / 8)
const expected = height * (1 + bytesPerRow)

let setBits = 0
const filters = new Map<number, number>()
for (let y = 0; y < height; y++) {
  const rowStart = y * (1 + bytesPerRow)
  const f = raw[rowStart]
  filters.set(f, (filters.get(f) ?? 0) + 1)
  for (let i = 0; i < bytesPerRow; i++) {
    const v = raw[rowStart + 1 + i]
    if (v) { let t = v; while (t) { setBits += t & 1; t >>= 1 } }
  }
}

console.log(`${file.split(/[\\/]/).pop()}`)
console.log(`  ${width}x${height}  bitDepth ${bitDepth}  colorType ${colorType}`)
console.log(`  chunks: ${types.join(' ')}`)
console.log(`  inflated ${raw.length} bytes (expected ${expected}) — ${raw.length === expected ? 'OK' : 'MISMATCH'}`)
console.log(`  row filters used: ${JSON.stringify([...filters])}`)
console.log(`  SET BITS (white pixels): ${setBits} of ${width * height} (${((setBits / (width * height)) * 100).toFixed(4)}%)`)

const allZero = deflateSync(Buffer.alloc(expected)).length
console.log(`  for reference, deflate(all-zero ${expected} bytes) = ${allZero} bytes; this file's IDAT = ${idat.reduce((n, c) => n + c.length, 0)} bytes`)
