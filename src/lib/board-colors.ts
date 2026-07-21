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
