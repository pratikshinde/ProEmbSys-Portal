/**
 * Exact drill↔Gerber origin-offset recovery.
 *
 * Some EDA tools (Protel/Altium flows especially) let the Gerber and NC-drill
 * outputs reference different origins — the Gerbers written against the
 * absolute sheet origin while the drill is written against the relative/board
 * origin (or vice versa). Nothing in the drill file records that offset, so
 * the holes land far from the copper they belong to.
 *
 * The offset is recoverable *exactly* rather than guessed: every plated hole
 * is concentric with its copper pad, so the set of (pad − hole) vectors
 * collapses onto a single translation — the origin difference between the two
 * files. We vote every hole×pad difference vector on a coarse grid; correct
 * pairings all land in one bucket while wrong pairings scatter and cannot
 * out-vote them. The winner is refined to the mean exact offset over the
 * matched pairs, and accepted only when it snaps a strong majority of holes
 * onto pads — an exact fix or none, never an approximate one.
 *
 * Algorithm ported from the delta-gerber project's DrillGerberAlignment
 * (https://github.com/Delta-Proto/delta-gerber, MIT license).
 */

export interface RecoveredDrillOffset {
  /** Millimetres to add to the drill X coordinates to align them. */
  offsetX: number
  /** Millimetres to add to the drill Y coordinates to align them. */
  offsetY: number
  /** Number of drill holes that land on a copper pad under this offset. */
  matchedHoles: number
  /** Total number of drill holes considered. */
  totalHoles: number
}

// Quantisation of the candidate (pad − hole) offset vectors when voting for
// the dominant translation. 0.05 mm is fine enough to separate genuinely
// different offsets yet coarse enough that the same physical offset,
// re-expressed across many hole/pad pairs, lands in one bucket despite
// coordinate rounding between the two files.
const VOTE_GRID_MM = 0.05
// A hole "lands on" a pad when, after the candidate offset, their centres are
// within this distance. Plated holes are concentric with their pads, so the
// true match is near-exact; this tolerance only absorbs coordinate rounding.
const MATCH_TOL_MM = 0.075
// The winning offset must map at least this fraction (and this absolute
// count) of the drill holes onto pads, otherwise it is rejected.
const MIN_SUPPORT_FRACTION = 0.5
const MIN_SUPPORT_COUNT = 3
// Backstop on the O(holes × pads) voting cost — subsample the holes so the
// product stays bounded. The dominant translation is recoverable from a
// subset because every plated hole shares the same offset.
const MAX_PAIRS = 4_000_000

export type Point = readonly [x: number, y: number]

/**
 * Resolve the centre of every flash in a parsed command stream, honouring
 * modal coordinates: RS-274X (and Excellon) omit any axis that hasn't
 * changed, and Protel-style exports routinely flash with a bare `D03*` whose
 * position comes entirely from the preceding move — so a flash command's own
 * `coordinate` can be partial or empty and must be resolved against the
 * current point.
 */
export function resolvedFlashCenters(
  commands: ReadonlyArray<{ type: string; coordinate: { x?: number; y?: number } }>,
): Point[] {
  return resolvedFlashes(commands).map(f => f.center)
}

/** A flash with the aperture that was selected when it was emitted. */
export interface ResolvedFlash {
  center: Point
  /** Aperture D-code in effect, or null if none was selected. */
  apertureCode: number | null
}

/**
 * The shared modal-coordinate walk behind `resolvedFlashCenters`, additionally
 * carrying each flash's aperture code — which the annular-ring check needs to
 * look up the pad's size, not just its position. Kept as one implementation so
 * the modal-resolution subtleties (see above) can't drift between callers.
 */
export function resolvedFlashes(
  commands: ReadonlyArray<{
    type: string
    coordinate: { x?: number; y?: number }
    apertureCode?: number | null
  }>,
): ResolvedFlash[] {
  const out: ResolvedFlash[] = []
  let curX: number | undefined
  let curY: number | undefined
  for (const cmd of commands) {
    if (cmd.coordinate.x !== undefined) curX = cmd.coordinate.x
    if (cmd.coordinate.y !== undefined) curY = cmd.coordinate.y
    if (cmd.type === 'flash' && curX !== undefined && curY !== undefined) {
      out.push({ center: [curX, curY], apertureCode: cmd.apertureCode ?? null })
    }
  }
  return out
}

/**
 * Recover the exact translation that maps `holes` onto `pads` (both in mm),
 * or `null` when no translation earns enough support. Positions must share
 * one unit (mm) — callers pass coordinates from already-normalized parsed
 * layers.
 */
export function recoverDrillOffset(
  holes: readonly Point[],
  pads: readonly Point[],
): RecoveredDrillOffset | null {
  if (pads.length === 0 || holes.length < MIN_SUPPORT_COUNT) return null

  // Bound the work by subsampling holes when holes × pads would be too large.
  let voteHoles: readonly Point[] = holes
  const pairs = holes.length * pads.length
  if (pairs > MAX_PAIRS) {
    const step = Math.ceil(pairs / MAX_PAIRS)
    voteHoles = holes.filter((_, i) => i % step === 0)
  }

  // Vote on quantised (pad − hole) offset vectors; remember the dominant bucket.
  const votes = new Map<string, number>()
  let bestKey = ''
  let bestVotes = 0
  for (const h of voteHoles) {
    for (const p of pads) {
      const gx = Math.round((p[0] - h[0]) / VOTE_GRID_MM)
      const gy = Math.round((p[1] - h[1]) / VOTE_GRID_MM)
      const key = `${gx},${gy}`
      const v = (votes.get(key) ?? 0) + 1
      votes.set(key, v)
      if (v > bestVotes) {
        bestVotes = v
        bestKey = key
      }
    }
  }
  if (bestVotes === 0) return null
  const [cgx, cgy] = bestKey.split(',').map(Number)
  const coarseX = cgx * VOTE_GRID_MM
  const coarseY = cgy * VOTE_GRID_MM

  // Refine to sub-grid precision and measure support: how many distinct holes
  // land on a pad under this offset, and the mean exact offset over matches.
  const tolSq = MATCH_TOL_MM * MATCH_TOL_MM
  let sumX = 0
  let sumY = 0
  let matchedPairs = 0
  let matchedHoles = 0
  for (const h of voteHoles) {
    let holeMatched = false
    for (const p of pads) {
      const dx = p[0] - h[0] - coarseX
      const dy = p[1] - h[1] - coarseY
      if (dx * dx + dy * dy <= tolSq) {
        sumX += p[0] - h[0]
        sumY += p[1] - h[1]
        matchedPairs++
        holeMatched = true
      }
    }
    if (holeMatched) matchedHoles++
  }

  if (matchedHoles < MIN_SUPPORT_COUNT || matchedHoles < MIN_SUPPORT_FRACTION * voteHoles.length) {
    return null
  }
  return {
    offsetX: sumX / matchedPairs,
    offsetY: sumY / matchedPairs,
    matchedHoles,
    totalHoles: holes.length,
  }
}
