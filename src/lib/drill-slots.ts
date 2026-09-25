/**
 * Drill SLOTS -> rows of overlapping ROUND drill hits.
 *
 * A slot (an oval hole) is a tool of diameter `d` travelling from `start` to
 * `end`. Many shops' drilling machines can only DRILL, not mill — so instead of
 * a native slot (Excellon `G85`, or a plunge-and-lateral-cut in G-code) the
 * slot is output as a series of ordinary round hits of that same diameter,
 * spaced closely enough that neighbouring hits overlap and cut the slot out.
 *
 * Pure — no React, no store, no tracespace. Shared by the panelized Excellon
 * export (`generatePanelizedDrill`), the meta-panel drill export, and the
 * G-code drilling programs, so none of the three can disagree about where the
 * hits land.
 *
 * ── Geometry conventions ──────────────────────────────────────────────────
 * • `slot.start`/`slot.end` are the tool CENTRE positions at each end of the
 *   travel, NOT the slot's outer edge — the finished slot is `centre-to-centre
 *   + d` long and `d` wide. The hits therefore run exactly start -> end.
 * • Both endpoints are ALWAYS hit, exactly. The end caps are what give the
 *   slot its rounded ends; a hit "near" the end would leave a flat, short one.
 * • Hits are spaced UNIFORMLY (never a short remainder hit), and never further
 *   apart than `pitchRatio * d`.
 */

export interface XY { x: number; y: number }
export interface SlotSegment { start: XY; end: XY }

/** 0.5 = each hit overlaps the previous by half its diameter. Scalloping
 *  between hits is then only ~6.7% of `d` (0.057 mm on a 0.85 mm slot). */
export const DEFAULT_SLOT_DRILL_PITCH_RATIO = 0.5
/** Below this a slot explodes into an absurd number of hits; above 1.0 the
 *  hits stop overlapping at all, which no longer cuts a slot. */
export const MIN_SLOT_DRILL_PITCH_RATIO = 0.1
export const MAX_SLOT_DRILL_PITCH_RATIO = 1

export interface SlotDrillSettings {
  /** Output slots as multiple drill hits (true) or as native slots (false). */
  asDrills: boolean
  pitchRatio: number
}

/**
 * The one place the two `PanelConfig` slot fields are interpreted.
 *
 * ⚠ `undefined` -> the DEFAULT (multi-drill), never "off". A CAM job saved
 * before these fields existed carries neither, and silently falling back to
 * native G85 slots for exactly the old jobs the feature was requested for
 * would defeat it. Out-of-range / non-finite pitch is clamped rather than
 * trusted, since it comes from a user-editable field and a saved template.
 */
export function resolveSlotDrillSettings(
  config: { slotsAsDrills?: boolean; slotDrillPitchRatio?: number } | null | undefined
): SlotDrillSettings {
  const raw = config?.slotDrillPitchRatio
  const pitchRatio = typeof raw === 'number' && Number.isFinite(raw)
    ? Math.min(MAX_SLOT_DRILL_PITCH_RATIO, Math.max(MIN_SLOT_DRILL_PITCH_RATIO, raw))
    : DEFAULT_SLOT_DRILL_PITCH_RATIO
  return { asDrills: config?.slotsAsDrills !== false, pitchRatio }
}

/**
 * The drill-hit centres that cut one slot, start -> end inclusive.
 * Returns `[]` for a non-positive diameter (nothing sane to drill) and a single
 * hit for a zero-length slot (which is just a round hole).
 */
export function slotDrillPoints(slot: SlotSegment, diameterMm: number, pitchRatio: number): XY[] {
  if (!(diameterMm > 0)) return []
  const dx = slot.end.x - slot.start.x
  const dy = slot.end.y - slot.start.y
  if (![slot.start.x, slot.start.y, dx, dy].every(Number.isFinite)) return []
  const length = Math.hypot(dx, dy)
  if (length < 1e-6) return [{ x: slot.start.x, y: slot.start.y }]

  const maxPitch = Math.min(MAX_SLOT_DRILL_PITCH_RATIO, Math.max(MIN_SLOT_DRILL_PITCH_RATIO, pitchRatio)) * diameterMm
  // `- 1e-9` so a length that is an exact multiple of the pitch doesn't tip
  // into one extra interval on floating-point noise.
  const intervals = Math.max(1, Math.ceil(length / maxPitch - 1e-9))
  const points: XY[] = []
  for (let i = 0; i <= intervals; i++) {
    const t = i / intervals
    points.push({ x: slot.start.x + dx * t, y: slot.start.y + dy * t })
  }
  return points
}

export interface HoleGroup { diameterMm: number; holes: XY[] }
export interface SlotGroup { diameterMm: number; slots: SlotSegment[] }

/**
 * Expand slot groups into hole groups (same shape `collectPanelizedDrillHoles`
 * returns), so they can be merged straight into the ordinary hole list and
 * drilled with the same tool as any round hole of that diameter.
 *
 * Coincident hits within a group are dropped: a chain of routed segments shares
 * its joint points, and drilling the same spot twice is pure wasted machine
 * time (and a second plunge into an already-cut hole).
 */
export function expandSlotGroupsToHoles(slotGroups: SlotGroup[], pitchRatio: number): HoleGroup[] {
  const groups: HoleGroup[] = []
  for (const g of slotGroups) {
    const holes: XY[] = []
    const seen = new Set<string>()
    for (const slot of g.slots) {
      for (const p of slotDrillPoints(slot, g.diameterMm, pitchRatio)) {
        // 0.1 µm grid — far below any machine's resolution, well above float noise.
        const key = `${Math.round(p.x * 1e4)},${Math.round(p.y * 1e4)}`
        if (seen.has(key)) continue
        seen.add(key)
        holes.push(p)
      }
    }
    if (holes.length > 0) groups.push({ diameterMm: g.diameterMm, holes })
  }
  return groups
}

/** Merge hole groups by exact diameter, ascending — same ordering the
 *  collectors produce, so downstream tool numbering is unchanged. */
export function mergeHoleGroups(...lists: HoleGroup[][]): HoleGroup[] {
  const byDia = new Map<number, XY[]>()
  for (const list of lists) {
    for (const g of list) {
      if (!byDia.has(g.diameterMm)) byDia.set(g.diameterMm, [])
      // Loop, not `push(...g.holes)` — a large panel can exceed V8's
      // spread-argument limit (this codebase has hit that exact crash before).
      const target = byDia.get(g.diameterMm)!
      for (const h of g.holes) target.push(h)
    }
  }
  return [...byDia.entries()]
    .sort(([a], [b]) => a - b)
    .map(([diameterMm, holes]) => ({ diameterMm, holes }))
}
