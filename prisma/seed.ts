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

  // ── Seed Users (Admin & Operator) ──────────────────────────────────────────
  const bcrypt = await import("bcryptjs")
  const adminPasswordHash = await bcrypt.hash("admin123", 10)
  const operatorPasswordHash = await bcrypt.hash("operator123", 10)

  await db.user.upsert({
    where: { email: "admin@propcb.in" },
    update: {
      name: "Shop Owner & Admin",
      role: "ADMIN",
      passwordHash: adminPasswordHash,
      isActive: true,
    },
    create: {
      email: "admin@propcb.in",
      name: "Shop Owner & Admin",
      role: "ADMIN",
      passwordHash: adminPasswordHash,
      isActive: true,
    },
  })
  console.log("Seeded Admin user: admin@propcb.in")

  await db.user.upsert({
    where: { email: "operator@propcb.in" },
    update: {
      name: "Ramesh (CNC Operator)",
      role: "OPERATOR",
      passwordHash: operatorPasswordHash,
      isActive: true,
    },
    create: {
      email: "operator@propcb.in",
      name: "Ramesh (CNC Operator)",
      role: "OPERATOR",
      passwordHash: operatorPasswordHash,
      isActive: true,
    },
  })
  console.log("Seeded Operator user: operator@propcb.in")

  // ── Seed 15 Production Stage Types ─────────────────────────────────────────
  const stageTypes = [
    { key: "INCOMING_QC", label: "Kitting / Incoming check", icon: "clipboard-check", color: "#38bdf8", sortHint: 1 },
    { key: "PANEL_CUTTING", label: "Panel cutting / shearing", icon: "scissors", color: "#f59e0b", sortHint: 2 },
    { key: "DRILLING", label: "CNC drilling", icon: "disc", color: "#ef4444", sortHint: 3 },
    { key: "ELECTROLESS_COPPER", label: "Electroless copper / PTH", icon: "droplets", color: "#06b6d4", sortHint: 4 },
    { key: "COPPER_IMAGE", label: "Copper image transfer", icon: "film", color: "#8b5cf6", sortHint: 5 },
    { key: "PATTERN_PLATING", label: "Pattern plating (Cu + Sn)", icon: "layers", color: "#6366f1", sortHint: 6 },
    { key: "ETCH_STRIP", label: "Etch & strip", icon: "flame", color: "#f97316", sortHint: 7 },
    { key: "AOI", label: "Automated optical inspection", icon: "scan", color: "#ec4899", sortHint: 8 },
    { key: "SOLDERMASK", label: "Solder mask (LPI)", icon: "shield", color: "#10b981", sortHint: 9 },
    { key: "SILKSCREEN", label: "Legend / silkscreen", icon: "type", color: "#14b8a6", sortHint: 10 },
    { key: "SURFACE_FINISH", label: "Surface finish (HASL/ENIG)", icon: "sparkles", color: "#eab308", sortHint: 11 },
    { key: "ROUTING_DEPANEL", label: "Routing / V-score / depanel", icon: "grid", color: "#a855f7", sortHint: 12 },
    { key: "ELECTRICAL_TEST", label: "Electrical test (flying probe / BBT)", icon: "zap", color: "#0ea5e9", sortHint: 13 },
    { key: "FINAL_QC", label: "Final QC / inspection", icon: "check-circle", color: "#22c55e", sortHint: 14 },
    { key: "PACKAGING_DISPATCH", label: "Packaging & dispatch", icon: "package", color: "#64748b", sortHint: 15 },
  ]
  for (const st of stageTypes) {
    await db.productionStageType.upsert({
      where: { key: st.key },
      update: { label: st.label, icon: st.icon, color: st.color, sortHint: st.sortHint, isActive: true },
      create: { ...st, isActive: true },
    })
  }
  console.log("Seeded 15 ProductionStageType rows.")

  // ── Seed Standard Routing Template ─────────────────────────────────────────
  const TEMPLATE_ID = "cmtv5zsuq000swt409pkrib4o"
  const template = await db.routingTemplate.upsert({
    where: { id: TEMPLATE_ID },
    update: {
      name: "Standard 2-layer FR4, ENIG",
      description: "Default standard 2-layer rigid fabrication process with vendor ENIG finish.",
      isActive: true,
    },
    create: {
      id: TEMPLATE_ID,
      name: "Standard 2-layer FR4, ENIG",
      description: "Default standard 2-layer rigid fabrication process with vendor ENIG finish.",
      isActive: true,
    },
  })

  const steps = [
    { sequence: 1, stageTypeKey: "INCOMING_QC", slaHours: 4, photoRequired: false, qtyOutRequired: true, instruction: "Verify raw FR4 laminate specs, copper thickness, and CAM job checklist." },
    { sequence: 2, stageTypeKey: "PANEL_CUTTING", slaHours: 4, photoRequired: false, qtyOutRequired: true, instruction: "Cut sheet to production working panel dimensions (e.g. 12x18 inch)." },
    { sequence: 3, stageTypeKey: "DRILLING", slaHours: 8, photoRequired: false, qtyOutRequired: true, instruction: "Load CNC NC drill program from portal, inspect tool bits, drill pilot & via holes." },
    { sequence: 4, stageTypeKey: "ELECTROLESS_COPPER", slaHours: 8, photoRequired: false, qtyOutRequired: true, instruction: "Chemical copper bath deposition for through-hole conductivity (PTH)." },
    { sequence: 5, stageTypeKey: "COPPER_IMAGE", slaHours: 8, photoRequired: true, qtyOutRequired: true, instruction: "Apply dry film photoresist, align film plots, UV expose, develop circuitry image." },
    { sequence: 6, stageTypeKey: "PATTERN_PLATING", slaHours: 8, photoRequired: false, qtyOutRequired: true, instruction: "Electroplate copper traces to target weight followed by tin etch-resist coating." },
    { sequence: 7, stageTypeKey: "ETCH_STRIP", slaHours: 6, photoRequired: false, qtyOutRequired: true, instruction: "Strip dry film, alkaline etch unwanted base copper, strip tin etch-resist." },
    { sequence: 8, stageTypeKey: "AOI", slaHours: 4, photoRequired: true, qtyOutRequired: true, instruction: "Automated optical inspection against Gerber data for shorts/opens." },
    { sequence: 9, stageTypeKey: "SOLDERMASK", slaHours: 12, photoRequired: false, qtyOutRequired: true, instruction: "Apply liquid photoimageable (LPI) solder mask, expose pads, develop, thermal cure." },
    { sequence: 10, stageTypeKey: "SILKSCREEN", slaHours: 6, photoRequired: false, qtyOutRequired: true, instruction: "Print component legend/silkscreen markings on top/bottom layers and cure." },
    { sequence: 11, stageTypeKey: "SURFACE_FINISH", isOutsourced: true, slaHours: 72, photoRequired: false, qtyOutRequired: true, instruction: "Dispatch working panels to surface finish plating vendor for Electroless Nickel Immersion Gold (ENIG)." },
    { sequence: 12, stageTypeKey: "ROUTING_DEPANEL", slaHours: 6, photoRequired: false, qtyOutRequired: true, instruction: "CNC contour routing, V-scoring, and slot milling per mechanical drawing." },
    { sequence: 13, stageTypeKey: "ELECTRICAL_TEST", slaHours: 8, photoRequired: true, qtyOutRequired: true, instruction: "100% netlist electrical continuity and isolation test via flying probe machine." },
    { sequence: 14, stageTypeKey: "FINAL_QC", slaHours: 4, photoRequired: true, qtyOutRequired: true, instruction: "Final dimensional, solderability, visual quality inspection and microsection verification." },
    { sequence: 15, stageTypeKey: "PACKAGING_DISPATCH", slaHours: 4, photoRequired: true, qtyOutRequired: true, instruction: "Vacuum pack with desiccant and humidity indicator card; stamp Traveler DONE." },
  ]
  for (const s of steps) {
    await db.routingTemplateStep.upsert({
      where: { templateId_sequence: { templateId: template.id, sequence: s.sequence } },
      update: { stageTypeKey: s.stageTypeKey, slaHours: s.slaHours, photoRequired: s.photoRequired, qtyOutRequired: s.qtyOutRequired, instruction: s.instruction, isOutsourced: s.isOutsourced ?? false },
      create: { templateId: template.id, sequence: s.sequence, stageTypeKey: s.stageTypeKey, slaHours: s.slaHours, photoRequired: s.photoRequired, qtyOutRequired: s.qtyOutRequired, instruction: s.instruction, isOutsourced: s.isOutsourced ?? false },
    })
  }
  console.log("Seeded Standard Routing Template with 15 steps.")
}

main()
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
  .finally(async () => {
    await db.$disconnect()
  })
