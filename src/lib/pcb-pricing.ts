/**
 * SUPERSEDED — replaced by src/lib/pricing-engine.ts, which resolves quotes
 * from admin-editable PricingRate rows in the DB instead of the hardcoded
 * constants below. Kept in the tree (unused) rather than deleted mid-migration;
 * remove once the new flow has been confirmed solid in production.
 *
 * PCB fabrication pricing — replaces a flat per-layer lookup with a
 * per-unit-area model so the quote actually reflects board size, not just
 * the layer count pill the customer clicked.
 */

export type PcbLayerOption = '1' | '2' | '4' | '6' | '8'

export interface PcbQuoteInput {
  widthMm: number
  heightMm: number
  layers: PcbLayerOption
  qty: number
  finish: string
  copperWeight: string
  express: boolean
}

export interface PcbQuoteBreakdown {
  areaCm2: number
  setupFee: number
  perBoardCost: number
  boardSubtotal: number
  finishSurchargePct: number
  copperSurchargePct: number
  expressSurchargePct: number
  total: number
}

/** One-time tooling/NRE fee per layer count, amortized across the order. */
const LAYER_SETUP_FEE: Record<PcbLayerOption, number> = { '1': 600, '2': 900, '4': 2200, '6': 3800, '8': 5600 }

/** INR per cm² per board — scales with layer count since more layers means more processing steps. */
const LAYER_RATE_PER_CM2: Record<PcbLayerOption, number> = { '1': 2.2, '2': 3.5, '4': 8, '6': 13.5, '8': 20 }

const FINISH_SURCHARGE_PCT: Record<string, number> = {
  'HASL (Lead-free)': 0,
  'ENIG': 18,
  'OSP': 5,
  'Immersion Silver': 12,
  'Hard Gold': 35,
}

const COPPER_SURCHARGE_PCT: Record<string, number> = { '1 oz': 0, '2 oz': 15, '3 oz': 30 }

const EXPRESS_SURCHARGE_PCT = 20

/** Floor so a tiny or unset board area doesn't produce a near-zero quote. */
const MIN_BILLABLE_AREA_CM2 = 1

export function calculatePcbQuote(input: PcbQuoteInput): PcbQuoteBreakdown {
  const areaCm2 = Math.max(MIN_BILLABLE_AREA_CM2, (input.widthMm * input.heightMm) / 100)
  const setupFee = LAYER_SETUP_FEE[input.layers]
  const perBoardCost = LAYER_RATE_PER_CM2[input.layers] * areaCm2
  const boardSubtotal = perBoardCost * Math.max(1, input.qty)

  const finishSurchargePct = FINISH_SURCHARGE_PCT[input.finish] ?? 0
  const copperSurchargePct = COPPER_SURCHARGE_PCT[input.copperWeight] ?? 0
  const expressSurchargePct = input.express ? EXPRESS_SURCHARGE_PCT : 0

  const surchargeMultiplier = 1 + (finishSurchargePct + copperSurchargePct) / 100
  const preExpress = (setupFee + boardSubtotal) * surchargeMultiplier
  const total = Math.round(preExpress * (1 + expressSurchargePct / 100))

  return {
    areaCm2,
    setupFee,
    perBoardCost,
    boardSubtotal,
    finishSurchargePct,
    copperSurchargePct,
    expressSurchargePct,
    total,
  }
}
