"use client"

import { useMemo, useState } from "react"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { Badge } from "@/components/ui/badge"
import { toast } from "@/hooks/use-toast"

export interface PricingRateRow {
  id: string
  category: string
  key: string
  label: string
  value: number
  unit: string
  isActive: boolean
}

const CATEGORY_LABELS: Record<string, string> = {
  TOOLING: "Tooling Charges",
  BASE: "Base Price",
  COPPER_THICKNESS: "Copper Thickness",
  SURFACE_FINISH: "Surface Finish",
  SUBSTRATE_THICKNESS: "Substrate Thickness",
  LEAD_TIME: "Lead Time",
  QTY_SLAB: "Quantity Slabs",
  PANELIZATION: "Panelization",
}

function RateRow({ rate }: { rate: PricingRateRow }) {
  const [value, setValue] = useState(String(rate.value))
  const [savedValue, setSavedValue] = useState(rate.value)
  const [isActive, setIsActive] = useState(rate.isActive)
  const [saving, setSaving] = useState(false)
  const dirty = Number(value) !== savedValue

  async function save() {
    const parsed = Number(value)
    if (Number.isNaN(parsed)) {
      toast({ title: "Invalid value", description: "Enter a number." })
      return
    }
    setSaving(true)
    const res = await fetch(`/api/pricing/rates/${rate.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: parsed }),
    })
    setSaving(false)
    if (!res.ok) {
      toast({ title: "Could not save", description: "Please try again." })
      return
    }
    setSavedValue(parsed)
    toast({ title: "Rate updated", description: `${rate.label} → ${parsed}` })
  }

  async function toggleActive(next: boolean) {
    setIsActive(next)
    const res = await fetch(`/api/pricing/rates/${rate.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isActive: next }),
    })
    if (!res.ok) {
      setIsActive(!next)
      toast({ title: "Could not update", description: "Please try again." })
    }
  }

  return (
    <tr className="border-t border-border">
      <td className="px-4 py-3 text-foreground">{rate.label}</td>
      <td className="px-4 py-3 text-muted-foreground">{rate.key}</td>
      <td className="px-4 py-3">
        <div className="flex items-center gap-2">
          <Input value={value} onChange={(e) => setValue(e.target.value)} className="h-8 w-24" />
          <span className="text-xs text-muted-foreground">{rate.unit}</span>
        </div>
      </td>
      <td className="px-4 py-3">
        <Switch checked={isActive} onCheckedChange={toggleActive} />
      </td>
      <td className="px-4 py-3 text-right">
        <Button size="sm" disabled={!dirty || saving} onClick={save}>
          {saving ? "Saving…" : "Save"}
        </Button>
      </td>
    </tr>
  )
}

export default function PricingRatesTable({ initialRates }: { initialRates: PricingRateRow[] }) {
  const categories = useMemo(() => Array.from(new Set(initialRates.map((r) => r.category))), [initialRates])
  const [activeCategory, setActiveCategory] = useState(categories[0] ?? "")

  return (
    <Tabs value={activeCategory} onValueChange={setActiveCategory}>
      <TabsList>
        {categories.map((c) => (
          <TabsTrigger key={c} value={c}>
            {CATEGORY_LABELS[c] ?? c}
          </TabsTrigger>
        ))}
      </TabsList>
      {categories.map((c) => {
        const rows = initialRates.filter((r) => r.category === c)
        return (
          <TabsContent key={c} value={c}>
            <div className="mb-3 flex items-center gap-2">
              <Badge>{rows.length} rates</Badge>
            </div>
            <div className="overflow-hidden rounded-lg border border-border">
              <table className="w-full text-sm">
                <thead className="bg-muted">
                  <tr>
                    <th className="px-4 py-3 text-left font-medium text-muted-foreground">Label</th>
                    <th className="px-4 py-3 text-left font-medium text-muted-foreground">Key</th>
                    <th className="px-4 py-3 text-left font-medium text-muted-foreground">Value</th>
                    <th className="px-4 py-3 text-left font-medium text-muted-foreground">Active</th>
                    <th className="px-4 py-3" />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((rate) => (
                    <RateRow key={rate.id} rate={rate} />
                  ))}
                </tbody>
              </table>
            </div>
          </TabsContent>
        )
      })}
    </Tabs>
  )
}
