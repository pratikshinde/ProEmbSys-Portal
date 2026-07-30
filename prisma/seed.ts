/**
 * Seeds PricingRate rows transcribed 1:1 from the old hardcoded constants in
 * src/lib/pcb-pricing.ts, so the cutover to DB-backed rates is price-neutral.
 * SUBSTRATE_THICKNESS and QTY_SLAB are new pricing dimensions the old model
 * never had — seeded at 0 so they don't change existing prices until an
 * admin configures real values.
 */
import { PrismaClient, PricingCategory, Prisma } from "@prisma/client"
import { DEFAULT_DFM_RULES } from "../src/lib/dfm/types"
import { DEFAULT_PANEL_TEMPLATE_SETTINGS } from "../src/lib/panel-template/types"

const db = new PrismaClient()

/** Fixed id so re-seeding updates the baseline template in place rather than
 *  creating duplicates, and so it stays referentially stable for users who
 *  selected it. */
const BASELINE_DFM_TEMPLATE_ID = "dfm-tpl-proembsys-standard"
const BASELINE_PANEL_TEMPLATE_ID = "panel-tpl-proembsys-standard"

type SeedRow = { category: PricingCategory; key: string; label: string; value: number; unit: string; sortOrder: number }

const rows: SeedRow[] = [
  // TOOLING — one-time NRE/tooling fee, INR flat, by layer count
  { category: "TOOLING", key: "1", label: "1-layer tooling fee", value: 600, unit: "INR_FLAT", sortOrder: 0 },
  { category: "TOOLING", key: "2", label: "2-layer tooling fee", value: 900, unit: "INR_FLAT", sortOrder: 1 },
  { category: "TOOLING", key: "4", label: "4-layer tooling fee", value: 2200, unit: "INR_FLAT", sortOrder: 2 },
  { category: "TOOLING", key: "6", label: "6-layer tooling fee", value: 3800, unit: "INR_FLAT", sortOrder: 3 },
  { category: "TOOLING", key: "8", label: "8-layer tooling fee", value: 5600, unit: "INR_FLAT", sortOrder: 4 },

  // BASE — INR per cm² per board, by layer count
  { category: "BASE", key: "1", label: "1-layer base rate", value: 2.2, unit: "INR_PER_CM2", sortOrder: 0 },
  { category: "BASE", key: "2", label: "2-layer base rate", value: 3.5, unit: "INR_PER_CM2", sortOrder: 1 },
  { category: "BASE", key: "4", label: "4-layer base rate", value: 8, unit: "INR_PER_CM2", sortOrder: 2 },
  { category: "BASE", key: "6", label: "6-layer base rate", value: 13.5, unit: "INR_PER_CM2", sortOrder: 3 },
  { category: "BASE", key: "8", label: "8-layer base rate", value: 20, unit: "INR_PER_CM2", sortOrder: 4 },

  // SURFACE_FINISH — percent surcharge on base price
  { category: "SURFACE_FINISH", key: "HASL (Lead-free)", label: "HASL (Lead-free)", value: 0, unit: "PERCENT_SURCHARGE", sortOrder: 0 },
  { category: "SURFACE_FINISH", key: "ENIG", label: "ENIG", value: 18, unit: "PERCENT_SURCHARGE", sortOrder: 1 },
  { category: "SURFACE_FINISH", key: "OSP", label: "OSP", value: 5, unit: "PERCENT_SURCHARGE", sortOrder: 2 },
  { category: "SURFACE_FINISH", key: "Immersion Silver", label: "Immersion Silver", value: 12, unit: "PERCENT_SURCHARGE", sortOrder: 3 },
  { category: "SURFACE_FINISH", key: "Hard Gold", label: "Hard Gold", value: 35, unit: "PERCENT_SURCHARGE", sortOrder: 4 },
  { category: "SURFACE_FINISH", key: "Leaded HASL", label: "Leaded HASL", value: 0, unit: "PERCENT_SURCHARGE", sortOrder: 5 },

  // COPPER_THICKNESS — percent surcharge on base price
  { category: "COPPER_THICKNESS", key: "1 oz", label: "1 oz copper", value: 0, unit: "PERCENT_SURCHARGE", sortOrder: 0 },
  { category: "COPPER_THICKNESS", key: "2 oz", label: "2 oz copper", value: 15, unit: "PERCENT_SURCHARGE", sortOrder: 1 },
  { category: "COPPER_THICKNESS", key: "3 oz", label: "3 oz copper", value: 30, unit: "PERCENT_SURCHARGE", sortOrder: 2 },

  // LEAD_TIME — percent surcharge on base price
  { category: "LEAD_TIME", key: "standard", label: "Standard (5-7 working days)", value: 0, unit: "PERCENT_SURCHARGE", sortOrder: 0 },
  { category: "LEAD_TIME", key: "express", label: "Express (2-3 working days)", value: 20, unit: "PERCENT_SURCHARGE", sortOrder: 1 },

  // SUBSTRATE_THICKNESS — new dimension, seeded inert at 0
  { category: "SUBSTRATE_THICKNESS", key: "0.8mm", label: "0.8mm substrate", value: 0, unit: "PERCENT_SURCHARGE", sortOrder: 0 },
  { category: "SUBSTRATE_THICKNESS", key: "1.0mm", label: "1.0mm substrate", value: 0, unit: "PERCENT_SURCHARGE", sortOrder: 1 },
  { category: "SUBSTRATE_THICKNESS", key: "1.2mm", label: "1.2mm substrate", value: 0, unit: "PERCENT_SURCHARGE", sortOrder: 2 },
  { category: "SUBSTRATE_THICKNESS", key: "1.6mm", label: "1.6mm substrate", value: 0, unit: "PERCENT_SURCHARGE", sortOrder: 3 },
  { category: "SUBSTRATE_THICKNESS", key: "2.0mm", label: "2.0mm substrate", value: 0, unit: "PERCENT_SURCHARGE", sortOrder: 4 },

  // QTY_SLAB — new dimension, seeded inert at 0 (percent discount off subtotal)
  { category: "QTY_SLAB", key: "5", label: "Qty 5", value: 0, unit: "PERCENT_DISCOUNT", sortOrder: 0 },
  { category: "QTY_SLAB", key: "10", label: "Qty 10", value: 0, unit: "PERCENT_DISCOUNT", sortOrder: 1 },
  { category: "QTY_SLAB", key: "25", label: "Qty 25", value: 0, unit: "PERCENT_DISCOUNT", sortOrder: 2 },
  { category: "QTY_SLAB", key: "50", label: "Qty 50", value: 0, unit: "PERCENT_DISCOUNT", sortOrder: 3 },
  { category: "QTY_SLAB", key: "100", label: "Qty 100", value: 0, unit: "PERCENT_DISCOUNT", sortOrder: 4 },
  { category: "QTY_SLAB", key: "250", label: "Qty 250", value: 0, unit: "PERCENT_DISCOUNT", sortOrder: 5 },
  { category: "QTY_SLAB", key: "500", label: "Qty 500", value: 0, unit: "PERCENT_DISCOUNT", sortOrder: 6 },

  // PANELIZATION — flat INR fee by delivery format. Individual/customer-panelized
  // are free; ProPCB-panelized carries a fixed service charge (placeholder,
  // tune the real value at /admin/pricing).
  { category: "PANELIZATION", key: "INDIVIDUAL", label: "Individual PCBs", value: 0, unit: "INR_FLAT", sortOrder: 0 },
  { category: "PANELIZATION", key: "PANEL_BY_CUSTOMER", label: "Panel by Customer", value: 0, unit: "INR_FLAT", sortOrder: 1 },
  { category: "PANELIZATION", key: "PANEL_BY_PROPCB", label: "Panel by ProPCB (service fee)", value: 500, unit: "INR_FLAT", sortOrder: 2 },
]

async function main() {
  for (const row of rows) {
    await db.pricingRate.upsert({
      where: { category_key: { category: row.category as never, key: row.key } },
      create: { ...row, category: row.category as never },
      update: { label: row.label, value: row.value, unit: row.unit, sortOrder: row.sortOrder },
    })
  }
  console.log(`Seeded ${rows.length} pricing rates.`)

  // The SHARED baseline DFM template, built from the same FAB_CAPABILITIES
  // constant that renders /fab-capabilities — so the public spec page and the
  // default DFM ruleset can't drift. `isSystem` keeps it undeletable, which
  // guarantees every user (including logged-out ones) always has at least one
  // selectable template. `rules` is refreshed on every seed so editing the
  // constant and re-seeding propagates the change.
  await db.dfmTemplate.upsert({
    where: { id: BASELINE_DFM_TEMPLATE_ID },
    create: {
      id: BASELINE_DFM_TEMPLATE_ID,
      scope: "SHARED",
      name: "ProEmbSys Standard",
      rules: DEFAULT_DFM_RULES as unknown as Prisma.InputJsonValue,
      isDefault: true,
      isSystem: true,
    },
    update: {
      name: "ProEmbSys Standard",
      rules: DEFAULT_DFM_RULES as unknown as Prisma.InputJsonValue,
      isSystem: true,
    },
  })
  console.log("Seeded the ProEmbSys Standard DFM template.")

  // The SHARED baseline panelization template — the shop's own default
  // rib/tooling/routing/G-code/array settings, all five sections built from
  // each engine's own DEFAULT_* constant so this can never drift from what
  // "no template selected" already behaves like. `isSystem` keeps it
  // undeletable, matching the DFM baseline above.
  await db.panelTemplate.upsert({
    where: { id: BASELINE_PANEL_TEMPLATE_ID },
    create: {
      id: BASELINE_PANEL_TEMPLATE_ID,
      scope: "SHARED",
      name: "ProEmbSys Standard",
      settings: DEFAULT_PANEL_TEMPLATE_SETTINGS as unknown as Prisma.InputJsonValue,
      isDefault: true,
      isSystem: true,
    },
    update: {
      name: "ProEmbSys Standard",
      settings: DEFAULT_PANEL_TEMPLATE_SETTINGS as unknown as Prisma.InputJsonValue,
      isSystem: true,
    },
  })
  console.log("Seeded the ProEmbSys Standard panelization template.")
}

main()
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
  .finally(async () => {
    await db.$disconnect()
  })
