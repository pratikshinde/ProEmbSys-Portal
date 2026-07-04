import { NextResponse } from "next/server"
import { db } from "@/lib/db"
import { buildRatesMap, calculatePcbQuoteV2, type PcbQuoteInputV2 } from "@/lib/pricing-engine"

export async function POST(req: Request) {
  const input = (await req.json()) as PcbQuoteInputV2

  if (
    typeof input?.widthMm !== "number" ||
    typeof input?.heightMm !== "number" ||
    input.widthMm <= 0 ||
    input.heightMm <= 0
  ) {
    return NextResponse.json({ error: "widthMm and heightMm must be positive numbers." }, { status: 400 })
  }

  const rows = await db.pricingRate.findMany({ where: { isActive: true } })
  const rates = buildRatesMap(rows)
  const breakdown = calculatePcbQuoteV2(input, rates)

  return NextResponse.json(breakdown)
}
