# DFM / DRC Analysis — Roadmap

Goal: let a customer (and staff) automatically check whether an uploaded Gerber
set fits ProEmbSys manufacturing capabilities **before** an order is placed —
turning the current "if your design falls outside these specs, contact us"
disclaimer on `/fab-capabilities` into an automated, per-upload report.

This document is the plan of record. It is intentionally staged by
**feasibility against the data we already parse**, not by wishlist order — the
cheap, high-value checks come first; the geometry-heavy checks (true
copper-to-copper spacing) come last because they need infrastructure we don't
have yet.

---

## 1. DFM vs DRC — what we mean, and the guiding philosophy

- **DFM (Design for Manufacturing)** — "can *we* build this on *our* line?"
  Checks the design against **our** capability envelope (min drill, min trace,
  max board size, layer count, aspect ratio, annular ring, etc.). This is the
  primary deliverable — it's what the customer actually wants answered at
  upload time.
- **DRC (Design Rule Check)** — "is the design internally self-consistent and
  free of rule violations?" (copper-to-copper spacing, mask slivers, silk over
  pads, acid traps). Much of this overlaps DFM but requires real geometric
  analysis. We treat the geometry-heavy DRC checks as the final phase.

**Advisory, not blocking.** Findings are surfaced as a report with severities;
they never hard-block the order. Rationale: (a) our filename/geometry heuristics
are imperfect and a false "error" that blocks checkout is worse than a missed
warning; (b) the business already offers advanced specs "on request," so a
design outside *standard* capability may still be buildable. Staff get the same
report on the admin order view and make the final call. A future enhancement can
let staff mark an order "DFM-blocked" manually.

**Severity model** (three levels, mirrors the standard/advanced split already on
`/fab-capabilities`):
- `error` — outside even the *advanced* capability (very likely unbuildable).
- `warning` — outside *standard* but within *advanced* (buildable on request,
  may cost more / take longer).
- `info` — passes, or a heuristic couldn't run confidently (e.g. dimensions not
  auto-detected).

---

## 2. Current state — what we can build on

We are **not** starting from zero. The upload path already parses every file:

| Asset | Location | What it gives DFM |
|---|---|---|
| RS-274X + Excellon parsers | `src/lib/gerber-parser.ts` | Apertures (`GerberAperture.width/height/holeDiameter`), draw commands (`GerberDrawCommand` with `apertureCode`), regions, per-layer `bounds`, drill tool diameters + hole counts (`DrillMeta`) |
| Stateless set analysis | `src/lib/gerber-analysis.ts` → `analyzeGerberSet()` | Already returns board W/H (mm), copper side count, total hole count, per-file layer type/side classification, and a `warnings[]` array |
| Capability spec table | `src/app/fab-capabilities/page.tsx` → `SPEC_GROUPS` | The exact standard/advanced thresholds DFM must check against (currently **hardcoded** — see §4) |
| Concentric pad↔hole matcher | `src/lib/drill-alignment.ts` → `recoverDrillOffset()`, `resolvedFlashCenters()` | Pairs each drill hit with its copper pad — directly reusable for **annular ring** and "unlanded hole" checks |
| Order-page upload flow | `PCBOrderPage` in `src/components/portal-main.tsx` (`handleFile` → `analyzeGerberSet`, `previewEntries` state) | The natural place to run DFM client-side and show the report; files are already extracted into `{name, content}[]` here |
| Server-side file persistence | `src/lib/order-files.ts`, `Order.gerberFilePath` | Lets us (later) re-run/serve DFM server-side and store the report on the order |

**Key implication:** everything in Phase 1 below is derivable from data
`analyzeGerberSet` *already produces or trivially could*. No new parsing, no
geometry engine.

---

## 3. Feasibility tiers (the core insight)

Checks split cleanly by how much geometry they need:

- **Tier A — aperture / metadata level (no geometry engine).** The value is in
  the aperture and drill-tool *dimensions* and board *metadata* we already
  extract. Trace **width** is knowable because a track is an `interpolate`
  command whose circle aperture's diameter *is* the track width; pad/flash sizes
  come straight from aperture dimensions; drill sizes from `DrillMeta` tools.
  → **Phase 1.** Cheap, deterministic, covers most of the fab-capability table.
- **Tier B — point-set / concentric analysis (reuse existing primitives).**
  Needs relationships between features but not full polygon clipping: annular
  ring (pad Ø − hole Ø, via the existing concentric matcher), drill-to-drill
  centre spacing, holes falling outside the board outline. → **Phase 2.**
- **Tier C — true geometric DRC (needs a spatial/clipping engine we don't have).**
  Copper-to-copper *spacing* between distinct nets, solder-mask slivers &
  clearance, copper-to-board-edge clearance, silkscreen-over-pad, acid traps /
  acute angles. These require polygon offset + intersection over the whole
  layer. → **Phase 3** (the expensive one; §7).

---

## 4. Capability thresholds: user-editable DFM templates (DECIDED)

Thresholds are **not** global constants or a single shop-wide table. They live in
**user-editable, named DFM templates**, multiple per user, with an
admin-published *shared* tier. (Resolves roadmap decision #1.)

**Model** — `DfmTemplate` (Prisma), a JSON `rules` blob per template:
```
enum DfmTemplateScope { PRIVATE, SHARED }
model DfmTemplate {
  id        String @id @default(cuid())
  scope     DfmTemplateScope @default(PRIVATE)
  userId    String?          // owner (for PRIVATE templates)
  name      String           // "In-house line", "JLC economy 2-layer"
  rules     Json             // closed set: { minTraceMm, minDrillMm, minAnnularRingMm, ... }
  isDefault Boolean @default(false) // per-user default pick; one SHARED = global default
  createdAt / updatedAt
  user      User? @relation(...)
}
```
`rules` is a **JSON blob, not normalized rows** — the threshold set is small and
*closed* (a fixed ~10–12 rules), unlike `PricingRate`'s open-ended slabs. JSON is
migration-free as rules evolve and matches existing structured snapshots
(`priceBreakdown`, address snapshots). Same shape as `FAB_CAPABILITIES` below.

**Access model** — each half mirrors a pattern already in the codebase:
- **PRIVATE** — any signed-in user CRUDs their own, one flagged `isDefault` →
  the **Address book** pattern.
- **SHARED** — only ADMIN/ENGINEER create/edit, everyone (incl. anonymous)
  reads → the **Blog/Product** pattern (admin CRUD + public read-only API).
- A user's picker = their PRIVATE templates + all SHARED ones.
- **Anonymous users** (the CAM tool is usable logged-out) can *run* checks
  against SHARED templates but must sign in to save/edit — one storage path (DB),
  no localStorage. (Resolves decision, §9.)

**Still keep the constant as source of truth for the *shop's real* envelope:**
`src/lib/fab-capabilities.ts` → `FAB_CAPABILITIES` (the `/fab-capabilities`
numbers). It (a) renders the public spec page instead of the page's local
`SPEC_GROUPS`, and (b) seeds one SHARED **"ProEmbSys Standard"** template flagged
as global default — so anonymous / first-time users are checked against real
capabilities out of the box, and "New template" clones it.

---

## 5. Phased roadmap

### Phase 0 — Foundation (enables everything)  ✅ SHIPPED
- `src/lib/fab-capabilities.ts` single source of truth (§4); re-point the public
  page at it.
- Define the result contract: `DfmFinding { id, checkId, severity, title,
  detail, measuredValue?, limitValue?, layer? }` and `DfmReport { findings,
  summary: {errors, warnings, infos}, ranAt }` in `src/lib/dfm/types.ts`.
- `src/lib/dfm/run-dfm.ts` orchestrator: `runDfm(analysis: GerberQuoteAnalysis,
  specs: OrderSpecs): DfmReport` — a pure function that takes the **already
  parsed** analysis (no re-parsing) plus the customer's chosen specs (thickness,
  layer count, etc.) and returns a report. Each check is an isolated function so
  they're independently testable and phases can add checks without touching the
  orchestrator.

### Phase 1 — Tier A checks (aperture / metadata)  ✅ SHIPPED (CAM tool)
All derivable from `analyzeGerberSet` output + order specs:

| Check | Rule (from fab caps) | Data source |
|---|---|---|
| Board size within max | ≤ 500 × 500 mm | `analysis.boardWidthMm/HeightMm` |
| Layer count within range | 1–8 copper layers | `analysis.copperLayerCount` (+ chosen layer spec, since inner layers aren't filename-detectable) |
| Board thickness in range | 0.4–3.2 mm | order spec (`thickness`) |
| Min drill size | ≥ 0.3 mm (adv 0.2) | `DrillMeta` tool diameters (min over all drill layers) |
| Max aspect ratio | thickness : min-drill ≤ 10:1 | thickness spec ÷ min drill Ø |
| Min trace width | ≥ 0.1 mm (adv 0.09) | min circle-aperture Ø used by `interpolate` commands on copper layers |
| Min silkscreen line width | ≥ 0.15 mm | min aperture Ø used by draws on silk layers |
| Smallest-feature sanity | flag sub-capability flash/pad apertures | min aperture dimension per copper layer |
| Dimensions-not-detected | `info` when outline missing | existing `analysis.warnings` |

Deliverable: `runDfm` returns a real report for these; unit tests with the
`Sample/` fixtures and the Downloads test sets (SBTH, WLC_Indicator).

### Phase 2 — Tier B checks (point-set / concentric)
- **Annular ring** — for each plated hole, find its concentric copper pad
  (reuse `resolvedFlashCenters` + the matching approach in `recoverDrillOffset`),
  compute `(padØ − holeØ)/2`, flag `< 0.15 mm` (adv `0.13`). This is the single
  most-requested real DFM check and we already have the matcher.
- **Unlanded / tangent holes** — holes with no concentric pad on a copper side
  (extends the existing "plated hole missing a pad" idea already in the drill
  work).
- **Drill-to-drill spacing** — min centre distance − radii across the hole set.
- **Holes outside outline** — any drill hit outside the board `bounds`.

### Phase 3 — Tier C checks (true geometric DRC)  ← needs new infra, scope later
- Copper-to-copper spacing between distinct nets, solder-mask sliver/clearance,
  copper-to-edge clearance, silkscreen-over-pad, acid traps.
- Requires a spatial engine (§7). Treat as a separate initiative with its own
  spike; **do not block Phases 1–2 on it.**

---

## 6. Product integration (where the report shows up)

Two surfaces, built in this order (decision §9): the **CAM Panelization tool
first**, then the **PCB Order page**. Both call the same `runDfm` engine against
the selected `DfmTemplate`; only the rendering differs.

- **CAM Panelization tool (first surface):** a new **DFM tab / panel** in the
  sidebar (alongside Layers / Panel Config / Info & Export). It runs `runDfm`
  over the currently-imported layer set (already in the Zustand store), against
  the user's selected template, and lists findings — with a template picker
  (their PRIVATE templates + SHARED ones) and, for signed-in users, create/edit/
  save. Engineer-facing, purely advisory. This is where the template CRUD UI
  first lands.
- **Order page (second surface):** after `handleFile` runs `analyzeGerberSet`,
  call `runDfm(...)` and render a **DFM card** next to the existing Board Preview
  card — a summary chip (e.g. "2 warnings") expanding to the finding list, styled
  like the current spec cards. Purely advisory; the Place Order button is
  unaffected.
- **Persist on the order:** add `Order.dfmReport Json?` and snapshot the report
  at placement (same pattern as `priceBreakdown` / address snapshots — a stored
  report must not silently change if capabilities are later edited).
- **Admin order view:** show the stored report on `/admin/orders/[id]` so staff
  see findings during review (the `PENDING_REVIEW → AWAITING_PAYMENT` gate) and
  can raise issues via the existing order message thread.
- **Server-side re-run (optional, later):** because we persist the Gerber file
  (`order-files.ts`), a server route could re-run DFM authoritatively at
  placement rather than trusting the client — worth doing once the check set
  stabilises, mirroring how order pricing is recomputed server-side and never
  trusted from the client.

---

## 7. The hard problem: geometric DRC (Phase 3 options)

Copper-to-copper spacing is the classic expensive check — it needs polygon
offset + intersection over potentially thousands of features per layer. Options,
roughly in increasing cost/fidelity:

1. **Raster / image-space** — render each copper layer to a high-DPI bitmap
   (we already produce SVG per layer via the worker), dilate by half the min
   spacing, and look for overlaps between originally-separate blobs. Approximate
   but fast, no exact-geometry library, and reuses the existing render pipeline.
   Good candidate for a first pass.
2. **Vector clipping library** — a polygon-clipping lib (e.g. an offset +
   boolean-intersection engine) run in the existing Web Worker. Exact, but
   requires converting our draw-command model into filled polygons first (arcs,
   regions, stroke-to-outline conversion) — substantial work.
3. **Offload to an established engine** — e.g. an open-source CAM/DRC toolchain
   run server-side. Highest fidelity, but a new external dependency/service and
   ops burden.

Recommendation: **spike option 1 (raster)** when Phase 3 is scheduled; only move
to 2/3 if raster fidelity proves insufficient. Keep the DFM result contract
(§Phase 0) engine-agnostic so the Phase 3 backend can change without touching
the UI or report storage.

---

## 8. Suggested sequencing & rough effort

| Phase | Scope | Rough effort | Depends on |
|---|---|---|---|
| 0 | Capability SoT + result contract + orchestrator | S | — |
| 1 | Tier A checks + Order-page DFM card | M | 0 |
| 1.5 | Persist `Order.dfmReport` + admin view | S | 1 |
| 2 | Annular ring + point-set checks | M | 1 (reuses drill-alignment) |
| 3 | Geometric DRC (raster spike first) | L / open-ended | 0's contract only |

Phases 0→1→1.5→2 deliver a genuinely useful, shippable DFM feature with **no new
heavy dependencies**. Phase 3 is a separate, larger initiative.

---

## 9. Decisions

**Resolved:**
1. **Thresholds** → **user-editable DFM templates**, multiple per user, PRIVATE +
   admin-published SHARED tier; anonymous users run against SHARED templates but
   must sign in to save. Seeded from the `FAB_CAPABILITIES` constant. (§4)
2. **Build order** → **CAM Panelization tool first, then PCB Order parsing.** The
   `runDfm` engine + template CRUD are shared; only the report's render surface
   differs, so the order integration mostly reuses Phase 1's work.

**Still open:**
3. **Standard vs advanced severity split** — should "within advanced only" read to
   a *customer* as a soft warning ("buildable on request"), or be staff-only?
   (Less pressing while we build the panelization tool, which is engineer-facing.)
4. **Client-only vs server-authoritative** for any *persisted* report — for the
   panelization tool the check is purely client-side/advisory (no order to
   attach to); the server-authoritative question only matters once we reach the
   PCB-order surface.
5. **Layer-count truth** — inner copper layers aren't filename-detectable, so the
   check trusts the chosen layer spec, not the file (matches quoting). Confirm OK.
6. **Phase 3 appetite** — is true copper-spacing DRC in scope at all, or do we
   ship the DFM-envelope checks (Phases 1–2) and treat geometric DRC as a later,
   separate project?
