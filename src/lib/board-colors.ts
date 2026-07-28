// Soldermask color palette for the Panelization tool's Board-view preview.
// Purely cosmetic — affects only the on-screen composited render, never the
// exported Gerber files. Distinct from src/lib/solder-mask-colors.ts, which
// is a flat UI swatch used by the PCB Order flow's spec picker; this palette
// instead supplies the two shades the Board view composites to fake a real
// soldermask look: `substrate` (bare board field, no copper beneath) and
// `copperTint` (copper traces as seen through the mask). Pad-finish gold
// (#d4af37) stays constant across every color, matching real boards where
// ENIG/HASL finish is independent of soldermask color.
export type BoardColorName = 'Green' | 'Red' | 'Blue' | 'Purple' | 'Yellow' | 'Black' | 'White'

export const BOARD_COLOR_NAMES: BoardColorName[] = ['Green', 'Red', 'Blue', 'Purple', 'Yellow', 'Black', 'White']

export const BOARD_COLOR_PALETTE: Record<BoardColorName, { substrate: string; copperTint: string; swatch: string }> = {
  Green:  { substrate: '#113f1d', copperTint: '#2e9e4f', swatch: '#2e9e4f' },
  Red:    { substrate: '#3d0d10', copperTint: '#b23a3a', swatch: '#b23a3a' },
  Blue:   { substrate: '#0d1f3f', copperTint: '#2e6f9e', swatch: '#2e6f9e' },
  Purple: { substrate: '#241033', copperTint: '#7a4ea3', swatch: '#7a4ea3' },
  Yellow: { substrate: '#3f350a', copperTint: '#c9a227', swatch: '#c9a227' },
  Black:  { substrate: '#0a0a0a', copperTint: '#3a3a3a', swatch: '#3a3a3a' },
  White:  { substrate: '#d8d8d0', copperTint: '#b8b8ae', swatch: '#e8e6df' },
}

// Bare, soldermask-free FR4 laminate exposed by a genuine soldermask opening
// that has NO copper anywhere beneath it — as opposed to `substrate` above,
// which approximates the board's general background field (everywhere with
// no copper, soldermask-covered or not, used as a flat fallback). Real,
// large mask-only openings do occur (e.g. a keepout/relief area under a big
// inductor with no copper pour underneath) and are otherwise invisible in the
// composited Board view: `getMaskClipPairs`'s gold-reveal technique only ever
// shows copper *through* a mask opening, so an opening with zero underlying
// copper reveals nothing and reads as empty background — even though it's
// real, deliberate Gerber content. This color is constant across every
// soldermask choice: removing solder mask exposes the same raw fiberglass
// laminate no matter what color mask the rest of the board uses.
export const EXPOSED_SUBSTRATE_COLOR = '#c2a878'

// PCB-realistic layer colors for board-mode compositing, shared by the CAM tool's
// Board view (gerber-viewer.tsx) and the PCB Order page's read-only preview
// (board-preview.tsx) so the two never drift apart. Colors that don't depend on
// the selected soldermask (mask/outline/paste/drill/other) are static; copper and
// silk are passed in since they vary with `boardColor`.
const STATIC_PCB_COLORS: Record<string, string> = {
  'mask-top':       '#d4af37', // gold exposed pads — pad finish stays constant across mask colors
  'mask-bottom':    '#d4af37',
  'mask-none':      '#d4af37',
  'outline-none':   '#1a1a1a',
  'outline-top':    '#1a1a1a',
  'outline-bottom': '#1a1a1a',
  'paste-top':      '#aaaaaa',
  'paste-bottom':   '#aaaaaa',
  'drill-none':     '#1a1a1a', // dark grey drill hole interior
  'drill-top':      '#1a1a1a',
  'drill-bottom':   '#1a1a1a',
  'other-none':     '#888888',
}

export function getPcbColor(type: string, side: string, copperTint: string, silkColor: string): string {
  if (type === 'copper') return copperTint
  if (type === 'silk') return silkColor
  return STATIC_PCB_COLORS[`${type}-${side}`] ?? STATIC_PCB_COLORS[`${type}-none`] ?? '#888888'
}

export const PCB_OPACITY: Record<string, number> = {
  copper: 1.0,
  mask:   1.0, // 1.0 so exposed gold pads render opaque on top of the tinted copper traces
  silk:   1.0,
  outline: 1.0,
  paste:  0.7,
  drill:  1.0,
  other:  0.5,
}

// White ink is invisible on a white mask, so silkscreen prints black instead —
// matching how real white-soldermask boards are actually silkscreened.
export function silkColorFor(boardColor: BoardColorName): string {
  return boardColor === 'White' ? '#1a1a1a' : '#e8e8e8'
}

// A soldermask opening is often intentionally larger than the copper pad
// beneath it (most visibly on fiducials, which need clearance well past the
// copper dot for optical recognition) — e.g. a 1.5mm copper fiducial pad
// under a 3.0mm mask opening. Painting the mask layer's own geometry as a
// flat opaque gold fill (the simple per-fragment reading of "wherever the
// mask has an opening") is wrong there: it paints the whole opening gold,
// hiding the real annulus of bare FR4 substrate around the pad that other
// viewers (tracespace.io, delta-gerber) correctly show. Fix: don't paint the
// mask layer directly — use its geometry purely as a clip-path over a second,
// gold-colored copy of the matching copper layer, so gold only appears where
// copper *actually is*, and the substrate underneath shows through elsewhere
// in the opening. Pairs are matched by side ('top'/'bottom'), falling back to
// 'none' when a layer isn't side-specific.
export interface MaskClipPair {
  copperLayerId: string
  maskLayerId: string
}

export function getMaskClipPairs<T extends { id: string; type: string; side: string }>(layers: T[]): MaskClipPair[] {
  const sides = new Set(layers.map(l => l.side))
  const pairs: MaskClipPair[] = []
  for (const side of sides) {
    const copper = layers.find(l => l.type === 'copper' && (l.side === side || l.side === 'none'))
    const mask = layers.find(l => l.type === 'mask' && l.side === side)
    if (copper && mask) pairs.push({ copperLayerId: copper.id, maskLayerId: mask.id })
  }
  return pairs
}

// PCB stack-up draw order — outline first (bottom), drill last (holes punched
// through everything above). Shared by the CAM tool's Board view and the PCB
// Order page's preview so both stack layers identically.
export function getLayerZIndex(type: string): number {
  switch (type) {
    case 'outline': return 0
    case 'copper': return 1
    case 'mask': return 2
    case 'paste': return 3
    case 'silk': return 4
    case 'drill': return 5
    case 'fab': return 6
    default: return 1
  }
}
