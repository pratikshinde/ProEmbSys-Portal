import { db } from "@/lib/db"
import PricingRatesTable from "@/components/admin/pricing-rates-table"

export default async function AdminPricingPage() {
  const rows = await db.pricingRate.findMany({ orderBy: [{ category: "asc" }, { sortOrder: "asc" }] })
  const rates = rows.map((r) => ({
    id: r.id,
    category: r.category,
    key: r.key,
    label: r.label,
    value: Number(r.value),
    unit: r.unit,
    isActive: r.isActive,
  }))

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-bold text-foreground">Pricing Rates</h1>
      <p className="text-sm text-muted-foreground">
        Edit rates here as material costs change — new quotes always use the latest values, but orders already
        placed keep the price snapshot from when they were quoted.
      </p>
      <PricingRatesTable initialRates={rates} />
    </div>
  )
}
