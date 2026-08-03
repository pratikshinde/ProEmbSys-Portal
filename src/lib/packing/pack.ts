/**
 * Multi-design panel packing — main entry point. Pure and synchronous, no
 * store/React/tracespace imports (mirrors `routing/plan-routing.ts`'s
 * discipline). See the "Multi-design panelization" plan for full rationale;
 * this file implements its "Packing engine" section.
 */

import { computeCompactGrid } from './geometry'
import { packGuillotine, packMaxRects, packShelf, type PlaceRequest, type PlacedPos } from './strategies'
import {
  DEFAULT_PACK_CONFIG,
  type FillOrder,
  type PackCandidate,
  type PackConfig,
  type PackInfeasibility,
  type PackItemSpec,
  type PackResult,
  type PackStrategy,
  type PackedItem,
  type RotationPolicy,
} from './types'

export * from './types'

const STRATEGIES: PackStrategy[] = ['shelf', 'guillotine', 'maxrects', 'block-grid']
const FILL_ORDERS: FillOrder[] = ['min-only', 'area-desc', 'area-asc', 'ratio-balanced', 'priority-then-area']

/** Cross-product cap — see the plan's "Enumerate → dedupe → rank". */
const MAX_ATTEMPTS = 120
/** "enumerate 2^n orientations for n ≤ 4" — beyond that, rotation enumeration
 *  is skipped entirely for this call (every design stays at 0°) rather than
 *  either exploding attempt count or guessing which subset to enumerate. */
const MAX_ROTATION_DESIGNS = 4
const MAX_RETURNED_CANDIDATES = 8

function designArea(s: PackItemSpec): number {
  return s.widthMm * s.heightMm
}

interface FillRequest {
  designId: string
  mandatory: boolean
}

/**
 * Phase 1 (mandatory): every design's `minCount`, ordered by priority then
 * area-descending — fixed and independent of `fillOrder`, since these must
 * all appear regardless of the fill mix policy.
 *
 * Phase 2 (fill): repeated passes, one item per eligible design per pass (in
 * `fillOrder`'s priority order for that pass), until a whole pass places
 * nothing new or `maxPlacements` is hit. `'min-only'` skips phase 2 entirely.
 */
function buildFillSequence(specs: PackItemSpec[], fillOrder: FillOrder, maxPlacements: number): FillRequest[] {
  const counts = new Map<string, number>(specs.map(s => [s.designId, 0]))
  const requests: FillRequest[] = []

  const mandatoryOrder = [...specs].sort((a, b) => a.priority - b.priority || designArea(b) - designArea(a))
  for (const spec of mandatoryOrder) {
    for (let i = 0; i < spec.minCount; i++) {
      requests.push({ designId: spec.designId, mandatory: true })
      counts.set(spec.designId, counts.get(spec.designId)! + 1)
    }
  }

  if (fillOrder === 'min-only') return requests

  let progressed = true
  while (progressed && requests.length < maxPlacements) {
    progressed = false
    const eligible = specs.filter(s => s.maxCount === null || counts.get(s.designId)! < s.maxCount)
    const ordered = sortByFillOrder(eligible, fillOrder, counts)
    for (const spec of ordered) {
      if (requests.length >= maxPlacements) break
      if (spec.maxCount !== null && counts.get(spec.designId)! >= spec.maxCount) continue
      requests.push({ designId: spec.designId, mandatory: false })
      counts.set(spec.designId, counts.get(spec.designId)! + 1)
      progressed = true
    }
  }

  return requests
}

function sortByFillOrder(specs: PackItemSpec[], fillOrder: FillOrder, counts: Map<string, number>): PackItemSpec[] {
  const withKey = [...specs]
  switch (fillOrder) {
    case 'area-desc':
      return withKey.sort((a, b) => designArea(b) - designArea(a))
    case 'area-asc':
      return withKey.sort((a, b) => designArea(a) - designArea(b))
    case 'ratio-balanced':
      return withKey.sort((a, b) => {
        const ra = counts.get(a.designId)! / Math.max(a.minCount, 1)
        const rb = counts.get(b.designId)! / Math.max(b.minCount, 1)
        return ra - rb
      })
    case 'priority-then-area':
      return withKey.sort((a, b) => a.priority - b.priority || designArea(b) - designArea(a))
    default:
      return withKey
  }
}

/** `'uniform-per-design'` enumerates every design either at 0° or 90°,
 *  applied uniformly across ALL of that design's instances in one candidate
 *  — never mixed per-instance. Always includes the all-0° assignment first
 *  (used directly by `'none'`). */
function rotationAssignments(specs: PackItemSpec[]): Map<string, 0 | 90>[] {
  const identity = new Map<string, 0 | 90>(specs.map(s => [s.designId, 0]))
  const rotatable = specs.filter(s => s.allowRotation)
  if (rotatable.length === 0 || rotatable.length > MAX_ROTATION_DESIGNS) return [identity]

  const n = rotatable.length
  const out: Map<string, 0 | 90>[] = []
  for (let mask = 0; mask < (1 << n); mask++) {
    const m = new Map<string, 0 | 90>(specs.map(s => [s.designId, 0]))
    for (let i = 0; i < n; i++) {
      if (mask & (1 << i)) m.set(rotatable[i].designId, 90)
    }
    out.push(m)
  }
  return out
}

function rotatedSize(spec: PackItemSpec, rot: 0 | 90): { w: number; h: number } {
  return rot === 90 ? { w: spec.heightMm, h: spec.widthMm } : { w: spec.widthMm, h: spec.heightMm }
}

interface BlockPlan {
  designId: string
  n: number
  rows: number
  cols: number
  cellW: number
  cellH: number
  rotationDeg: 0 | 90
  inflatedW: number
  inflatedH: number
}

/**
 * `block-grid` operates at coarser (per-design block) granularity than the
 * other three strategies, so it lives here rather than in `strategies.ts` —
 * it needs design identity, not just anonymous rectangles.
 */
function placeBlockGrid(
  specs: PackItemSpec[],
  sequence: FillRequest[],
  rotation: Map<string, 0 | 90>,
  cfg: PackConfig
): Map<string, PackedItem[]> {
  const requestedCounts = new Map<string, number>()
  for (const r of sequence) requestedCounts.set(r.designId, (requestedCounts.get(r.designId) ?? 0) + 1)

  const gapX = cfg.gapXMm
  const gapY = cfg.gapYMm
  const binW = cfg.materialWidthMm + gapX
  const binH = cfg.materialHeightMm + gapY

  function planFor(spec: PackItemSpec, n: number): BlockPlan | null {
    if (n <= 0) return null
    const rot = rotation.get(spec.designId) ?? 0
    const { w: cellW, h: cellH } = rotatedSize(spec, rot)
    const grid = computeCompactGrid(n, cellW + gapX, cellH + gapY, 0, 0)
    return { designId: spec.designId, n, rows: grid.rows, cols: grid.cols, cellW, cellH, rotationDeg: rot, inflatedW: grid.blockW, inflatedH: grid.blockH }
  }

  // Try the full requested block first; if it can never fit the material
  // bin at all, fall back to just the hard minimum before giving up.
  const plans: BlockPlan[] = []
  for (const spec of specs) {
    const requested = requestedCounts.get(spec.designId) ?? 0
    let plan = planFor(spec, requested)
    if (plan && (plan.inflatedW > binW || plan.inflatedH > binH)) {
      plan = planFor(spec, spec.minCount)
    }
    if (plan) plans.push(plan)
  }

  // Shelf-pack the blocks themselves, biggest first — fixed and
  // deterministic, independent of `fillOrder` (which already decided the
  // per-design counts; this only orders the resulting handful of blocks).
  const ordered = [...plans].sort((a, b) => b.inflatedW * b.inflatedH - a.inflatedW * a.inflatedH)
  const blockRequests: PlaceRequest[] = ordered.map(p => ({ w: p.inflatedW, h: p.inflatedH }))
  const blockPositions = packShelf(blockRequests, binW, binH)

  const itemsByDesign = new Map<string, PackedItem[]>()
  ordered.forEach((plan, i) => {
    const pos = blockPositions[i]
    if (!pos) return
    const items: PackedItem[] = []
    let placed = 0
    for (let row = 0; row < plan.rows && placed < plan.n; row++) {
      for (let col = 0; col < plan.cols && placed < plan.n; col++) {
        items.push({
          designId: plan.designId,
          x: pos.x + col * (plan.cellW + gapX),
          y: pos.y + row * (plan.cellH + gapY),
          w: plan.cellW,
          h: plan.cellH,
          rotationDeg: plan.rotationDeg,
        })
        placed++
      }
    }
    itemsByDesign.set(plan.designId, items)
  })

  return itemsByDesign
}

function placeGeneric(strategy: 'shelf' | 'guillotine' | 'maxrects', requests: PlaceRequest[], binW: number, binH: number): (PlacedPos | null)[] {
  if (strategy === 'shelf') return packShelf(requests, binW, binH)
  if (strategy === 'guillotine') return packGuillotine(requests, binW, binH)
  return packMaxRects(requests, binW, binH)
}

function attemptCandidate(
  specs: PackItemSpec[],
  strategy: PackStrategy,
  fillOrder: FillOrder,
  rotationPolicy: RotationPolicy,
  rotation: Map<string, 0 | 90>,
  cfg: PackConfig
): Omit<PackCandidate, 'id'> | { infeasible: string } {
  const sequence = buildFillSequence(specs, fillOrder, cfg.maxPlacements)
  if (sequence.length === 0) return { infeasible: 'no items requested (every design has minCount 0)' }

  const specById = new Map(specs.map(s => [s.designId, s]))
  let finalItems: PackedItem[]

  if (strategy === 'block-grid') {
    const itemsByDesign = placeBlockGrid(specs, sequence, rotation, cfg)
    for (const spec of specs) {
      const got = itemsByDesign.get(spec.designId)?.length ?? 0
      if (spec.minCount > 0 && got < spec.minCount) {
        return { infeasible: `${spec.designId}: only fit ${got}/${spec.minCount} mandatory boards` }
      }
    }
    finalItems = [...itemsByDesign.values()].flat()
  } else {
    const gapX = cfg.gapXMm
    const gapY = cfg.gapYMm
    const requests: PlaceRequest[] = sequence.map(r => {
      const spec = specById.get(r.designId)!
      const rot = rotation.get(r.designId) ?? 0
      const { w, h } = rotatedSize(spec, rot)
      return { w: w + gapX, h: h + gapY }
    })
    const binW = cfg.materialWidthMm + gapX
    const binH = cfg.materialHeightMm + gapY
    const positions = placeGeneric(strategy, requests, binW, binH)

    const totalMandatory = sequence.filter(r => r.mandatory).length
    const placedMandatory = sequence.filter((r, i) => r.mandatory && positions[i]).length
    if (placedMandatory < totalMandatory) {
      return { infeasible: `only fit ${placedMandatory}/${totalMandatory} mandatory boards` }
    }

    finalItems = sequence
      .map((r, i): PackedItem | null => {
        const pos = positions[i]
        if (!pos) return null
        const spec = specById.get(r.designId)!
        const rot = rotation.get(r.designId) ?? 0
        const { w, h } = rotatedSize(spec, rot)
        return { designId: r.designId, x: pos.x, y: pos.y, w, h, rotationDeg: rot }
      })
      .filter((it): it is PackedItem => it !== null)
  }

  if (finalItems.length === 0) return { infeasible: 'nothing could be placed' }

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const it of finalItems) {
    minX = Math.min(minX, it.x)
    minY = Math.min(minY, it.y)
    maxX = Math.max(maxX, it.x + it.w)
    maxY = Math.max(maxY, it.y + it.h)
  }
  const items = finalItems.map(it => ({ ...it, x: it.x - minX, y: it.y - minY }))
  const panelWidthMm = maxX - minX
  const panelHeightMm = maxY - minY

  const countsByDesign: Record<string, number> = {}
  for (const it of items) countsByDesign[it.designId] = (countsByDesign[it.designId] ?? 0) + 1

  const placedArea = items.reduce((sum, it) => sum + it.w * it.h, 0)
  const panelArea = panelWidthMm * panelHeightMm
  const efficiency = panelArea > 0 ? placedArea / panelArea : 0

  return { strategy, fillOrder, rotationPolicy, panelWidthMm, panelHeightMm, items, countsByDesign, efficiency, totalBoards: items.length }
}

function placementSignature(c: PackCandidate): string {
  return c.items.map(it => `${it.designId}:${it.x.toFixed(2)}:${it.y.toFixed(2)}:${it.rotationDeg}`).sort().join('|')
}

function nearSignature(c: PackCandidate): string {
  const counts = Object.entries(c.countsByDesign).sort(([a], [b]) => a.localeCompare(b)).map(([id, n]) => `${id}=${n}`).join(',')
  return `${counts}@${c.panelWidthMm.toFixed(1)}x${c.panelHeightMm.toFixed(1)}`
}

/**
 * Rank: efficiency desc → totalBoards desc → panel area asc → id asc. Dedupe
 * exact (placement signature) then near (same counts vector + panel size to
 * 0.1mm) before ranking. Always keeps a `min-only` and a `ratio-balanced`
 * candidate in the final set even when outranked — see the "known ranking
 * degeneracy" note in types.ts.
 */
function rankAndDedupe(candidates: PackCandidate[]): PackCandidate[] {
  const seenExact = new Set<string>()
  const seenNear = new Set<string>()
  const deduped: PackCandidate[] = []
  for (const c of candidates) {
    const exact = placementSignature(c)
    if (seenExact.has(exact)) continue
    seenExact.add(exact)
    const near = nearSignature(c)
    if (seenNear.has(near)) continue
    seenNear.add(near)
    deduped.push(c)
  }

  const ranked = [...deduped].sort((a, b) =>
    b.efficiency - a.efficiency ||
    b.totalBoards - a.totalBoards ||
    (a.panelWidthMm * a.panelHeightMm) - (b.panelWidthMm * b.panelHeightMm) ||
    a.id.localeCompare(b.id)
  )

  const top = ranked.slice(0, MAX_RETURNED_CANDIDATES)
  for (const fo of ['min-only', 'ratio-balanced'] as const) {
    if (top.some(c => c.fillOrder === fo)) continue
    const found = ranked.find(c => c.fillOrder === fo)
    if (!found) continue
    if (top.length < MAX_RETURNED_CANDIDATES) top.push(found)
    else top[top.length - 1] = found
  }

  return top
}

/**
 * Find several candidate panel layouts for the given designs, ranked by
 * area-usage efficiency. Deterministic (no `Math.random`) — the same inputs
 * always produce the same ordered candidate list, so a UI can safely persist
 * just a `selectedCandidateId` and recompute rather than storing the whole list.
 */
export function findPackCandidates(specs: PackItemSpec[], config: Partial<PackConfig> & { materialWidthMm: number; materialHeightMm: number }): PackResult {
  const cfg: PackConfig = { ...DEFAULT_PACK_CONFIG, ...config }
  if (specs.length === 0 || cfg.materialWidthMm <= 0 || cfg.materialHeightMm <= 0) {
    return { candidates: [], infeasible: [] }
  }

  const candidates: PackCandidate[] = []
  const infeasible: PackInfeasibility[] = []
  const startTime = Date.now()
  let attempts = 0
  const rotations = rotationAssignments(specs)

  outer:
  for (const strategy of STRATEGIES) {
    for (const fillOrder of FILL_ORDERS) {
      const attemptsThisCombo: { policy: RotationPolicy; rotation: Map<string, 0 | 90> }[] =
        rotations.length === 1
          ? [{ policy: 'none', rotation: rotations[0] }]
          : [{ policy: 'none', rotation: rotations[0] }, ...rotations.slice(1).map(r => ({ policy: 'uniform-per-design' as const, rotation: r }))]

      for (const { policy, rotation } of attemptsThisCombo) {
        if (attempts >= MAX_ATTEMPTS || Date.now() - startTime >= cfg.timeBudgetMs) break outer
        attempts++
        const result = attemptCandidate(specs, strategy, fillOrder, policy, rotation, cfg)
        if ('infeasible' in result) {
          infeasible.push({ strategy, fillOrder, rotationPolicy: policy, reason: result.infeasible })
        } else {
          candidates.push({ ...result, id: `${strategy}-${fillOrder}-${policy}-${candidates.length}` })
        }
      }
    }
  }

  return { candidates: rankAndDedupe(candidates), infeasible }
}
