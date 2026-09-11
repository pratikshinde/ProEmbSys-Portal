// One-off generator for the operator PWA's home-screen icons. Run with
// `node scripts/gen-operator-icons.mjs`. Not part of the build — icons are
// checked in as static PNGs under public/icons/.
import sharp from "sharp"
import { mkdir } from "node:fs/promises"
import path from "node:path"

const OUT_DIR = path.join(process.cwd(), "public", "icons")

const BG = "#061628" // operator app's own dark navy chrome
const ACCENT = "#34d399" // emerald-400, the operator app's accent throughout

// Lucide's own "hard-hat" glyph (src/app/operator/layout.tsx's header badge
// uses the same icon) — reproduced here as raw path/rect data (24x24
// viewBox, stroke-based) so the icon matches the in-app badge exactly
// rather than inventing a new mark.
const HARDHAT_PATHS = [
  { tag: "path", d: "M10 10V5a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v5" },
  { tag: "path", d: "M14 6a6 6 0 0 1 6 6v3" },
  { tag: "path", d: "M4 15v-3a6 6 0 0 1 6-6" },
  { tag: "rect", x: 2, y: 15, width: 20, height: 4, rx: 1 },
]

function glyphMarkup(strokeWidth) {
  return HARDHAT_PATHS.map((p) =>
    p.tag === "path"
      ? `<path d="${p.d}" fill="none" stroke="${ACCENT}" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round"/>`
      : `<rect x="${p.x}" y="${p.y}" width="${p.width}" height="${p.height}" rx="${p.rx}" fill="none" stroke="${ACCENT}" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round"/>`
  ).join("")
}

/** @param {number} size canvas size in px
 *  @param {{ maskable?: boolean, rounded?: boolean }} opts */
function iconSvg(size, { maskable = false, rounded = true } = {}) {
  // The glyph's own bbox is roughly 20x19 units (2..22 x, 4..19 y) inside a
  // 24x24 viewBox. Scale it to occupy ~58% of the canvas normally, or ~40%
  // for the maskable variant so it survives an aggressive OS crop mask.
  const glyphFrac = maskable ? 0.4 : 0.58
  const scale = (size * glyphFrac) / 24
  const strokeWidth = 2 * scale
  const tx = (size - 24 * scale) / 2
  const ty = (size - 24 * scale) / 2 + size * 0.01 // nudge down slightly to visually center the asymmetric glyph
  const radius = rounded ? size * 0.22 : 0

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    <rect x="0" y="0" width="${size}" height="${size}" rx="${radius}" fill="${BG}"/>
    <circle cx="${size / 2}" cy="${size / 2}" r="${size * (maskable ? 0.3 : 0.36)}" fill="${ACCENT}" fill-opacity="0.14"/>
    <g transform="translate(${tx},${ty}) scale(${scale})">${glyphMarkup(strokeWidth / scale)}</g>
  </svg>`
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true })

  const targets = [
    { file: "operator-192.png", size: 192, opts: {} },
    { file: "operator-512.png", size: 512, opts: {} },
    { file: "operator-maskable-512.png", size: 512, opts: { maskable: true, rounded: false } },
    { file: "operator-apple-touch-180.png", size: 180, opts: { rounded: false } }, // iOS applies its own mask; opaque square in
  ]

  for (const t of targets) {
    const svg = iconSvg(t.size, t.opts)
    await sharp(Buffer.from(svg)).png().toFile(path.join(OUT_DIR, t.file))
    console.log("wrote", t.file)
  }
}

main()
