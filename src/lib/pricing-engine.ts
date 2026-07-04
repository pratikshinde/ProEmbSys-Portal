/**
 * Server-side PCB pricing engine — pure function, no DB import, so it's
 * reusable and unit-testable independent of how rates are fetched. Rates are
 * admin-editable (PricingRate table) because raw material costs change over
 * time; this function just resolves a rates snapshot into a quote.
 *
 * Formula (additive, per the business requirement): tooling charge + base
 * price + copper thickness + surface finish + substrate thickness + lead
 * time + qty slab discount. Layer count is a cost driver of both TOOLING and
 * BASE (a 4-layer board costs more to tool and more per cm² than a 2-layer
 * board) rather than a separate additive term.
 */

import type { PricingRate } from "@prisma/client"

export type PricingRatesMap = Record<string, Record<string, { value: number; unit: string }>>

/** The one Decimal -> number conversion boundary — money math elsewhere in
 *  this file works with plain numbers, never Prisma's Decimal type. */
export function buildRatesMap(rows: PricingRate[]): PricingRatesMap {
  const map: PricingRatesMap = {}
  for (const row of rows) {
    if (!row.isActive) continue
    if (!map[row.category]) map[row.category] = {}
    map[row.category][row.key] = { value: Number(row.value), unit: row.unit }
  }
  return map
}

export interface PcbQuoteInputV2 {
  widthMm: number
  heightMm: number
  layers: string
  qty: number
  finish: string
  copperWeight: string
  thickness: string
  express: boolean
}

export interface RateUsed {
  category: string
  key: string
  value: number
  unit: string
}

export interface PcbQuoteBreakdownV2 {
  areaCm2: number
  toolingCharge: number
  basePrice: number
  copperThicknessSurcharge: number
  surfaceFinishSurcharge: number
  substrateThicknessSurcharge: number
  leadTimeSurcharge: number
  qtySlabDiscount: number // negative or zero — modeled as an addend so the whole formula stays one legible sum
  total: number
  ratesUsed: RateUsed[]
}

const MIN_BILLABLE_AREA_CM2 = 1

function lookupRate(
  rates: PricingRatesMap,
  category: string,
  key: string,
  ratesUsed: RateUsed[]
): number {
  const rate = rates[category]?.[key]
  if (!rate) {
    console.warn(`[pricing-engine] Missing PricingRate for ${category}/${key} — defaulting to 0`)
    return 0
  }
  ratesUsed.push({ category, key, value: rate.value, unit: rate.unit })
  return rate.value
}

export function calculatePcbQuoteV2(input: PcbQuoteInputV2, rates: PricingRatesMap): PcbQuoteBreakdownV2 {
  const ratesUsed: RateUsed[] = []
  const areaCm2 = Math.max(MIN_BILLABLE_AREA_CM2, (input.widthMm * input.heightMm) / 100)
  const qty = Math.max(1, input.qty)

  const toolingCharge = lookupRate(rates, "TOOLING", input.layers, ratesUsed)
  const baseRatePerCm2 = lookupRate(rates, "BASE", input.layers, ratesUsed)
  const basePrice = baseRatePerCm2 * areaCm2 * qty

  const copperPct = lookupRate(rates, "COPPER_THICKNESS", input.copperWeight, ratesUsed)
  const finishPct = lookupRate(rates, "SURFACE_FINISH", input.finish, ratesUsed)
  const substratePct = lookupRate(rates, "SUBSTRATE_THICKNESS", input.thickness, ratesUsed)
  const leadTimePct = lookupRate(rates, "LEAD_TIME", input.express ? "express" : "standard", ratesUsed)
  const qtySlabPct = lookupRate(rates, "QTY_SLAB", String(qty), ratesUsed)

  const copperThicknessSurcharge = basePrice * (copperPct / 100)
  const surfaceFinishSurcharge = basePrice * (finishPct / 100)
  const substrateThicknessSurcharge = basePrice * (substratePct / 100)
  const leadTimeSurcharge = basePrice * (leadTimePct / 100)

  const subtotal =
    toolingCharge + basePrice + copperThicknessSurcharge + surfaceFinishSurcharge + substrateThicknessSurcharge + leadTimeSurcharge

  const qtySlabDiscount = -(subtotal * (qtySlabPct / 100))
  const total = Math.round(subtotal + qtySlabDiscount)

  return {
    areaCm2,
    toolingCharge,
    basePrice,
    copperThicknessSurcharge,
    surfaceFinishSurcharge,
    substrateThicknessSurcharge,
    leadTimeSurcharge,
    qtySlabDiscount,
    total,
    ratesUsed,
  }
}
