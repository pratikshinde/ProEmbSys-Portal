# Routing & G-code — Roadmap

Companion to `DFM_DRC_ROADMAP.md`, same idea: record the phased plan and the
reasoning, so the unshipped parts stay honest about what they need.

---

## 1. Why

The CAM Panelization tool could lay out a panel and export Gerber/drill, but it
produced nothing for **depaneling** — no router tool paths, no breakaway tabs, no
mouse bites, no CNC G-code. Meanwhile `/fab-capabilities` advertised "Tab routing
/ mousebites: Supported" and the marketing copy promised V-score and mousebites.
Phase A closes the routing half of that gap.

## 2. Phase A — SHIPPED

A shared geometry engine (`src/lib/routing/`) plus a **Routing** tab, producing
two file formats from one geometry source.

- `types.ts` — `RoutingConfig` (flat, see §5) + the result contract.
- `geometry.ts` — the only place offset/edge-split conventions live.
- `plan-routing.ts` — `planRouting()` (pure) + `validateRouting()` (pre-flight).
- `emit-gerber.ts` — Gerber route layer, respects `OutputFormat`.
- `emit-excellon.ts` — Excellon `.rou` + `_MouseBites.drl`.

**Scope:** panel-outline and/or per-PCB perimeters, independently toggleable.
**Tabs:** solid bridges or mouse bites, per-edge, auto-spaced or explicitly
positioned. **Bit:** free number entry plus 1.0 / 1.5 / 2.0 mm presets.

### Conventions that must not be broken
1. **Cutter compensation is applied exactly once**, in `offsetRectOutward`, and
   every `RoutePath.points` is already tool-center. Emitters never offset again.
   The export README says so in as many words, because a fab reading a route
   layer cannot otherwise distinguish centerline from board edge.
2. **`pathGap = tabWidth + bitDiameter`.** The cut is the path swept by a disc of
   radius `r`, so a path gap of `g` leaves `g − 2r` of material. Using `tabWidth`
   as the path gap directly makes every tab one bit-diameter too narrow.
3. **Mouse-bite holes sit on the board's own edge line**, not the tool path and
   not the gap centerline. Two PCBs facing across a shared gap therefore get two
   hole rows `gap` apart — correct, since each board needs its own perforation.
4. **Gap must be ≥ bit diameter** to route between neighbours. `DEFAULT_PANEL_CONFIG`
   ships 0.5 mm, so every new panel starts in conflict for all three bit presets;
   the tab surfaces this as an `error` with a one-click "set gaps to bit" fix that
   also rebuilds the panel.
5. **Nothing auto-recomputes.** `generateRouting()` runs only from the button,
   matching Create Panel and Run check. Config changes set `routingStale`.
6. **Stale routing is cleared, not kept.** A `.rou` carrying a previous panel's
   coordinates is a scrap risk, so `computePanelResult`, `resetPanelConfig`,
   `clearLayers`, `setTargetUnit`, `rotateAllLayers` and `alignDrillLayersToBoard`
   all null out `routingResult` outright.

### Known limitations (deliberate)
- **Bounding-box routing only.** Non-rectangular outlines are routed as their
  bounding box, with a `warning` saying so. True contour offset (arcs, mitred
  corners) is a separate initiative — the same honesty stance the DFM engine
  takes with macro apertures.
- **The `.rou` dialect is unverified.** There is no CAM350 rout export in the
  repo to diff against (`Sample/sample panel/` has `Panel_border.gbr` and
  `pinn.drl`, no rout). Phase A emits the standard Excellon-2 rout form
  (`G00` rapid → `M15` plunge → `G01` cuts → `M16` retract, `M17`/`M30` close)
  and labels it provisional in the README. **Ask for one CAM350 rout export.**
- **Re-importing our own `.rou` still produces a garbage layer.** `detectLayerType`
  classifies `.ROU` as `'drill'`, so it goes to `parseExcellonDrill`, which reads
  `M15`/`G01` as noise. Not worth fixing by adding a `'route'` member to
  `LayerType` — that union ripples into the colour map, opacity table, z-order,
  `generateDescriptiveLayerName` and `getMaskClipPairs`.
  **UPDATE (2026-07-26):** a real *incoming* rout file (a customer's own
  milling-slot export, not one of ours) hit this exact problem and is now
  fixed for that case — `src/lib/routing/import-rout.ts`'s `isRoutGcodeFile`
  recognizes the Excellon-2 rout dialect (a bare tool select with no diameter
  anywhere, alongside plunge/retract + cutter-comp markers — the discriminator
  genuine Excellon never satisfies) and converts each milled path into a
  filled Gerber region, rendered correctly rather than as spurious drill
  hits. This still doesn't apply to files typed something *other* than
  `'drill'`-shaped content, and doesn't change the `LayerType` union — see
  `CLAUDE.md`'s "Milling slots from incoming .rou files".

## 3. Phase B — G-code tab — SHIPPED

The user's machine turned out to run **LinuxCNC** (confirmed directly: "machine
is running LinuxCNC, it can do milling and drilling") and supplied 7 real
production files — one cutting/routing program and six drilling programs at
different tool diameters (`Siltech_SBTH_Routing_17-JUL-2026_*.NC`). That
resolved every question in the original sample checklist below, so Phase B
shipped as one concrete dialect rather than the originally-planned pluggable
`GcodeDialect` abstraction — see §3.3 for why.

### 3.1 What the samples showed
- **Machine class**: a milling controller, not an Excellon-style drill/rout CNC.
  Plain RS274NGC with explicit `G01 Z` moves, no `M15`/`M16`/`M17`.
- **Dialect specifics**: LinuxCNC named parameters (`#<Z_Retract>`, `#<Z_Depth>`,
  `#<Z_Feed>`, `#<XY_Feed>`) set once in the header and referenced throughout;
  a "pressure pad" hold-down (`M64 P0` / `M65 P0`); `G64 P<tolerance>` path
  blending; explicit-decimal coordinates (no zero suppression at all — this
  sidesteps the entire LZ/TZ inversion bug class Excellon output has to guard
  against).
- **Z strategy**: single depth per program (no stepped passes).
- **Tabs**: the machine retracts to `#<Z_Retract>` at every tab and cuts straight
  through untabbed corners as one continuous move — confirmed by diffing the
  real cutting file's retract count against its own corner/tab layout.
- **Datum**: panel-absolute, matching `RoutingResult.paths`' own coordinate space
  — no translation needed between the routing engine and the G-code layer.
- **Mouse bites vs. real holes**: the shop's workflow is one drilling program per
  distinct tool diameter, not one program per feature type — mouse-bite holes
  and imported drill hits that share a diameter go in the same file.
- **Naming**: `<Part>_Cutting_<dia>.NC` / `<Part>_Drilling_<dia>_<n>.NC`, dash
  instead of decimal point in the diameter (`4.3` → `4-30`).

### 3.2 Implementation
`src/lib/routing/gcode.ts` — `generateRouteGcode`, `generateDrillGcode`,
`generateGcodeFiles`, `GcodeContext`, `DEFAULT_GCODE_CONTEXT`. Store slice
(`gcodeContext`, `gcodeFiles`, `generateGcodeFilesAction`, `clearGcodeFiles`) in
`store.ts`, alongside a 6th `CamTab` (`'gcode'`) added to `PANEL_VIEW_TABS`. UI:
`src/components/gcode-panel.tsx`. Export: `exportGcodeFiles` in
`gerber-exporter.ts`, a G-code-only ZIP mirroring `exportRoutingFiles`.
`generateGcodeFilesAction` collects the panel's own imported drill holes via
`collectPanelizedDrillHoles` (in `gerber-exporter.ts`, extracted from the
existing panelized-drill export loop) and folds them together with
`collectMouseBiteHoles(routingResult)` before diameter-grouping.

### 3.3 Why one concrete dialect, not a pluggable abstraction
The plan's original `GcodeDialect` interface assumed multiple real dialects
would eventually exist. With exactly one real machine and one real dialect in
evidence, building that generality now would be speculative — there's nothing
to generalize *from* yet. `gcode.ts`'s header comment states this explicitly:
extract the shared parts (sequencing, file-per-tool-diameter splitting) into a
dialect abstraction if and when a second real machine shows up, not before.

**Two deliberately unmerged templates.** `generateRouteGcode` and
`generateDrillGcode` diverge in template details that came straight out of the
sample files' own two post-processor paths — where `G21` sits, whether the
dwell is repeated, even trailing whitespace after certain lines. These were
kept byte-faithful per-kind rather than forced into one shared template,
because unifying them would mean guessing which file's convention is the "real"
one when they disagree.

**`drillFeedMmPerMin` was originally one uniform default across every tool
diameter** — later reversed once a seventh real data point (2.15mm) joined
the original six and made a real per-diameter shape visible (2000 down to
500 mm/min, smaller bits faster). `resolveDrillFeedMmPerMin`
(`gcode.ts`) now interpolates piecewise-linearly between all seven real
(diameter, feed) pairs by default (`GcodeContext.autoFeedByDiameter`), an
honest encoding of the vendor's own measurements rather than a fitted
formula; `drillFeedMmPerMin` remains as the flat-rate fallback when that
toggle is off, for an operator who wants to override per their own
feeds-and-speeds chart.

### 3.4 Verification
Byte-level reproduction against the real files, the strongest form of proof
available: parse each sample's own coordinates/feed/tool-diameter out of
itself, feed those exact values back into the emitter, and diff line-by-line.
- Two drilling files reproduced **byte-identical**, in full.
- The cutting file's header and footer reproduced **byte-identical**; the body
  was verified by retract-count (4 tab-retracts, matching the file's own
  corner-vs-tab pattern) rather than exact text, since its CAM software starts
  writing at an arbitrary mid-edge point — a cosmetic choice with zero
  functional effect on the machine, not something worth reproducing exactly.
- A separate harness (`scratch-gcode-e2e-verify.ts`, run via `npx tsx`) drove
  the exact pipeline `generateGcodeFilesAction` runs — parse real Gerber/drill
  files → `computePanel` → `planRouting` → `collectPanelizedDrillHoles` →
  `generateGcodeFiles` — against the `WLC_Indicator` fixture, standing in for a
  browser upload test (the Claude in Chrome extension was unavailable this
  session). 16/16 assertions passed.

### 3.5 A Phase A geometry gap the real files exposed
Reproducing the cutting file surfaced a real bug in Phase A's `planRouting`:
the segment-stitching walk only merged forward, so a PCB whose first and last
kept segments met at a genuine (non-tab) corner was still split across two
separate `RoutePath`s — the array's own wrap-around was never checked. Fixed
with an explicit wrap-around merge pass in `plan-routing.ts` (see the code
comment there); re-verified against `scratch-stitch-verify.ts`, all 12
assertions passing afterward.

## 4. Phase C — Contour routing for non-rectangular PCBs — SHIPPED

Phase A routed every PCB as its bounding box, with a standing honesty warning
(`outline-not-rectangular`) admitting that a shaped board (rounded corners,
chamfers, curved edges, interior cutouts/slots) would be over-cut. Phase C
retires that warning by routing the **real traced board profile**.

### 4.1 Design decisions locked with the user
1. Route the outer profile **and** interior cutouts/slots.
2. Emit **flattened polylines**, not G02/G03 arcs — all three emitters
   (`emit-gerber.ts`, `emit-excellon.ts`, `gcode.ts`) needed **zero changes**,
   since they already walk `path.points` generically.
3. Tabs spread **evenly by arc length around the closed contour**; the
   `tabTop/Bottom/Left/Right` edge toggles are hidden and ignored in contour
   mode.

### 4.2 Contour source and the facts that shaped the offset engine
`corePlot()` already produces `plotResult.boardShape` (closed regions of
line/arc segments) — previously discarded; only the rendered Y-down
`shapePathD` string escaped, for the on-screen substrate clip. Several
tracespace implementation facts, found by direct inspection rather than
assumed, materially shaped the design:
- **tracespace's ring start vertex is arbitrary** (`walkPaths` starts at
  `keys().next().value`, insertion-order dependent) — since tabs are
  parameterised by arc length from the ring's start, this forced a mandatory
  `canonicaliseRingStart` (lowest-Y-then-lowest-X vertex) before any
  arc-length work, or tabs would silently relocate between identical runs of
  the same file.
- **`plot()` hardcodes a gap-fill tolerance in the outline's own native
  units** (0.02) and will invent straight bridge segments to close a loop —
  detected (approximately — `ContourRing.syntheticCloseCount`) and surfaced
  as an advisory issue, never overridden.
- **`plotBoardShape` only reads `IMAGE_PATH`** — an outline drawn as a
  G36/G37 filled region fails to trace at all (`no-paths-in-outline`).
- **`calculateBounds` (`gerber-parser.ts`) is arc-blind** while tracespace's
  traced bbox is arc-accurate; both are centreline, so the difference between
  them is exactly the arc bulge — this is `checkContourSize`'s exact,
  non-heuristic cross-check in `plan-routing.ts`.

No polygon-clipping dependency: a PCB profile is a small set of simple,
non-self-intersecting rings, not the general boolean-ops problem a library
like Clipper solves — matching the precedent `dfm/capsules.ts` already set
for hand-rolling segment distance, a spatial hash, and union-find rather than
adding a geometry dependency.

### 4.3 Implementation
`src/lib/board-contour.ts` (new) — the only file that reads a tracespace
`BoardShape`: `boardShapeToContour` (pure adapter), `traceBoardContour`
(async: parse + plot one outline layer + adapt), `boardShapeCoversContent`
(the >=50%-coverage trust gate, extracted so `gerber-svg.ts`'s substrate-clip
guard and the routing engine's trust gate can never drift apart).

`src/lib/routing/offset.ts` (new) — the pure offset/tab engine, zero
tracespace or store imports:
- **Orientation convention**: outer ring CCW, hole rings CW, offset always to
  the RIGHT of travel by the bit radius. Uniformly outward for the boundary
  and inward for holes with no sign flag threaded through the code — the
  join-type rule (round join vs. analytic miter) falls out of the SAME
  turn-sign test regardless of ring type, a local fact about the vertex
  relative to the offset direction, not "convex on a CCW ring."
- `rawOffsetRing` → `pruneByProximity` (a `SegmentGrid` spatial hash) →
  `reconnectRuns` (analytic miter first, a sampled-and-validated chord as
  fallback) → `offsetClosedRing`. Failure policy: a hole ring failing is
  `cutout-too-small-for-bit` (skip that cutout); the outer ring failing, or
  the offset winding flipping relative to the source, discards the WHOLE
  contour with a blocking error — never a fallback to bbox, which is
  known-wrong for a shaped board.
- Arc-length parameterisation (`buildArcLength`/`sampleAt`/`tangentAt`/
  `turningOver`/`extractArcSpan`) and `findSafeTabCenter` (the tab curvature
  guard: reject a tab spanning >20° of accumulated turning, nudge up to one
  `pathGap`, else skip and count).
- `splitClosedByTabs` wraps `geometry.ts`'s `splitEdgeByTabs`, additionally
  merging the wrap-around seam — a real bug caught by the verification
  harness, not by inspection: a ring with N evenly-spaced tabs was producing
  N+1 outline spans, because `splitEdgeByTabs`'s plain `[0,L]` domain reports
  the leading and trailing remainder as two separate spans even when they are
  one continuous physical run through the seam on a closed ring.

`src/lib/routing/plan-routing.ts` — the bbox loop is untouched, now gated
behind `resolveOutlineMode(...) === 'bbox'`; a contour branch computes
`ContourGeometry` **once** per generate (`computeContourGeometry`) and
translates it per panel position (`planContourPcb`) — "trace once, offset
once, tab once," not per-PCB. `resolveOutlineMode('auto', outlineLayer)`
resolves to `'bbox'` only when the outline is already a plain rectangle
(`isRectangularOutline`), where the two modes produce identical output.

`src/lib/store.ts` — `findOutlineBoundsLayer` unifies three previously
independent (and disagreeing) outline-layer lookups; `generateRouting` is now
`async` and traces its own contour (never reads the unrelated, fire-and-forget
`BoardView.boardContour`), aborting with no state change if `layers`/
`panelResult` moved on mid-trace (an exact reference-identity check, since
every mutating action replaces those refs wholesale).

`src/lib/routing/geometry.ts` — `dedupeCoincidentSegments` rewritten as a
spatial hash (contour mode's segment counts made the original O(n²) scan
impractical), verified element-for-element identical to the naive version
across 500 randomized trials including near-coincident pairs straddling the
tolerance boundary.

UI: `routing-panel.tsx` gained an outline-mode segmented control
(Auto/Contour/Bounding box), an interior-cutouts switch, a contour tolerance
input, "Tabs around contour" replacing "Tabs per edge" (with the edge-toggle
buttons hidden) in non-bbox modes, an async Generate button ("Tracing
outline…"), and a guard blocking download while any `error`-severity issue is
present. `gerber-viewer.tsx`'s per-PCB outline preview draws the real traced
polygon instead of a dashed rectangle once a contour-mode plan exists.

`pcbOutlineMode` defaults to `'auto'` — deliberately flipped from `'bbox'`
only after the whole pipeline (offset engine, tab placement, store wiring,
UI) was built and verified end to end; flipping it earlier would have shipped
half-built contour routing as the default behaviour.

### 4.4 Verification
No test suite — numeric harnesses via `npx tsx`, layered per stage (each
stage's harness re-run after later stages to guard against regression):
- **Offset engine**: a Monte-Carlo Minkowski-dilation-area validator (square,
  L-shape, the real WIFI V6 outer profile, a random 40-gon, at two bit radii)
  — genuinely independent of the implementation, catching sign errors,
  wrong-side offsets, missed joins, and over-pruning in one shot. Caught a
  real PRNG defect in the validator itself first (a plain LCG produced a
  spurious ~1.5% bias from the well-known "successive outputs lie on a
  lattice" failure mode) — fixed and re-validated against a known analytic
  case before trusting it against the code under test. Plus exact analytic
  square/circle tests, a direction-awareness regression for arc flattening,
  instancing exactness (`translate(offset(R))` vs. `offset(translate(R))` to
  1e-9), and a narrow-notch test.
- **Planner integration**: reproduced the plan's own worked example exactly —
  the real WIFI V6 outline (33.000 x 102.000mm, 2x Ø3.2mm + 1x Ø1.5mm holes),
  2x2 panel, 2mm gap: at a 2.0mm bit the Ø1.5 cutout collapses (8 cutout
  paths, `cutout-too-small-for-bit`); at 1.0mm all three holes per PCB
  survive (12 cutout paths, no warning). Bbox mode's own output count
  (paths/tabs) reproduced unchanged.
- **Store wiring**: drove the real Zustand store directly (no browser
  needed — zustand's core has no DOM dependency) through the full
  `generateRouting` contour path, the `findOutlineBoundsLayer` `.visible`
  fix, and the staleness guard (mutating `layers` mid-trace and confirming
  the result is discarded, not applied).
- **Dedup**: 500 randomized segment sets compared element-for-element against
  a naive reference implementation, plus a 96,000-segment scale/perf check.
- **Browser, real fixture, real UI**: imported WIFI V6, built a 2x2 panel at
  2mm gap, forced Contour mode at a 1.0mm bit, clicked Generate — the Plan
  summary read "Outline: traced contour / Cutouts: 12 / Tabs: 16 /
  Mouse-bite holes: 64," matching the planner-integration harness exactly,
  with the traced contour and cutout circles visible in the viewer and zero
  console errors. Separately confirmed `'auto'` mode against the same
  (rectangular-outer-boundary) fixture correctly resolved to `'bbox'`.

### 4.5 Known residual limitations
- Contour mode still does not merge coincident *cutting* passes between
  adjacent PCBs the way bbox mode's `mergeCoincidentPasses` does — each PCB's
  contour routes fully independently, so a shared line between two boards
  gets cut twice. That redundancy is genuinely harmless — see §4.6 below for
  the DIFFERENT, unsafe case (coincident-pass TAB destruction) this phase
  turned out to need fixing regardless. A future stage can still wire the
  spatial-hash `dedupeCoincidentSegments` into the contour path purely for
  the cutting-time efficiency win.
- A curved tab's mouse-bite hole row is a straight chord across the tab, not
  arc-following — fine for a small tab on a large-radius curve.
- `calculateBounds` (`gerber-parser.ts`) remains arc-blind; making it
  arc-aware is a separate task that touches panelization, DFM, and drill
  alignment beyond routing's own scope.
- No real curved-outline fixture exists in `Sample/` (confirmed: no G02/G03
  anywhere in the directory) — the arc-flattening and size-mismatch paths are
  verified analytically/synthetically, not against a real curved board.

### 4.6 Production feedback: three real bugs, one of them deeper than it first looked

Three issues came back from real use almost immediately after Phase C shipped
— a screenshot of a real board (`SBTH_PRO_Gerber_v2`) showing a breakaway
tab's mouse-bite holes buried under a continuous swath, mouse-bite holes
judged too deep into the finished board, and a request to vary G-code drill
feed by bit diameter using the shop's own numbers (the same
`Siltech_SBTH_Routing_17-JUL-2026_*` files behind §3).

**First pass (bbox mode) — real, but incomplete.** Root cause #1: `rectEdges`'
a→b direction reverses for 'top' and 'left' (needed for the wrap-around
stitching walk), so a *custom* `tabPositionsMm` override measured "distance
from edge start" from opposite ends on two facing PCBs' edges — landing tabs
at different absolute positions. With `mergeCoincidentPasses` sharing one
pass down the gap centreline at `gap == bit`, each board's own pass then cut
straight through its neighbour's now-misaligned tab. Fixed by canonicalising
tab-position direction to one panel-global sense regardless of edge label;
confirmed byte-identical for the (overwhelmingly common) symmetric
auto-spaced case, and a broad sweep (96 configs: 6 grid shapes × 5 PCB
aspect ratios × 3 tab counts, all default/symmetric tabs) found zero
remaining overlaps.

Root cause #2 (holes): mouse-bite holes were centred exactly on the true
edge (half in, half out) — standard practice, but not what this shop wants.
Fixed with a configurable outward pull (`mouseBiteEdgeClearanceMm`, default
0.2mm) applied only to the holes, not the tab bridge itself.

Root cause #3 (feed): a seventh real drilling file (2.15mm) joined the
original six and made the per-diameter shape unambiguous (2000 down to 500
mm/min, smaller bits faster) — see `DRILL_FEED_TABLE_MM_PER_MIN` in
`gcode.ts`, piecewise-linear interpolation between real measurements.

**The report came back "still reproduced."** The customer's actual board
(per its own real cutting file, `Siltech_SBTH_Routing_17-JUL-2026_Cutting1_2.NC`)
turned out to have 45°-chamfered corners — non-rectangular, so `'auto'`
resolves it to CONTOUR mode, not bbox. The bbox-mode fix above literally
cannot apply there. Re-deriving the failure for contour mode found something
worse than a missed edge case: **contour mode's documented "no cross-PCB
merge, but that's fine — just redundant" stance was WRONG for tabs
specifically.** At `gap == bit`, two facing PCBs' offset boundaries still
land on the exact same line (this doesn't depend on the shape being
rectangular), but contour tabs are placed by whole-perimeter arc length with
no per-edge concept to keep two DIFFERENT PCB instances' tabs aligned the
way rectangle tabs now are. Since contour mode genuinely does not merge or
dedupe passes, a neighbour's own complete, uninterrupted pass — which has no
reason to know about a tab it doesn't own — cuts straight through it. No
merge/dedup mechanism was ever going to catch this, because there's nothing
to deduplicate: both boards' segments are simply different, and one of them
is wrong to leave uninterrupted.

Fixed by extending the arc-length machinery `planContourPcb` already had:
for each PCB instance, translate every OTHER instance's tab centres into
this instance's own local frame and check them against its own boundary via
`nearestArcLengthOnRing`; anything within a bit-radius contributes a silent
extra interrupt (same `pathGap` silencing as an owned tab, no duplicate
`RouteTab`). This forced `ContourGeometry.cutSpans` — previously computed
once, file-space, shared across every instance — to move into
`planContourPcb` itself, since it now depends on something per-instance (a
board's neighbours); `outerPts`/`outerTable`/`tabPositions`/`cutouts` stay
computed once.

**Verification, in order:**
1. Numeric reproduction of the original bbox report (custom `tabPositionsMm`
   on two facing PCBs) — confirmed misaligned tabs at different absolute X,
   and a path point from one board landing inside the other's tab bridge.
2. Same scenario after the fix — tabs land at the identical position, one
   clean shared gap.
3. Broad sweep, symmetric/default tabs, bbox mode — 96 configs, 0 problems
   (this case was never broken, but had never been checked this broadly
   either).
4. The real WIFI V6 contour fixture, 12 grid/tab-count combinations, at
   `bit == gap` (the danger condition) — 0 cross-PCB tab problems with the
   fix.
5. **Differential proof, not just a passing test**: re-ran step 4 with the
   fix's contribution forced to empty. 111 real cross-PCB tab-destruction
   cases appeared across the same 12 configs — proof the check is doing
   real work, not passing vacuously.
6. Re-ran the existing WIFI V6 cutout-count regression (8 cutouts + warning
   at 2.0mm bit, 12 cutouts + none at 1.0mm) after the `ContourGeometry`
   restructure — unchanged.
7. `resolveDrillFeedMmPerMin` reproduces all seven real vendor data points
   exactly, interpolates linearly between them, and clamps outside their
   range.

## 5. Deferred: CNC tooling animation

Requested and explicitly postponed until the routing geometry is trusted.

The seam is ready: `gerber-viewer.tsx` has a `<g data-layer="route-overlay">`
group, and an animation needs only `routingResult.paths` plus a cumulative
per-segment length table to interpolate a moving cutter marker inside it. Nothing
else has to change.

**The G-code tab needed no viewer changes.** It has no overlay or focus state of
its own — G-code is a text serialization of the same `routingResult.paths`
geometry the Routing tab's `route-overlay` group already renders, so the
existing overlay stays the single visual representation for both tabs.

## 6. Why `RoutingConfig` is a separate flat slice

`updatePanelConfig` is a shallow merge with a bespoke `drillFormat` re-spread,
duplicated again in `resetPanelConfig` — so every nested object added to
`PanelConfig` becomes a permanent two-site trap. Keeping routing in its own slice
also means the existing panel export has **zero** regression surface, and keeping
that slice flat means its shallow merge is always correct. `outputFormat` and
`dfmContext` set the precedent.

## 7. Verification

No test suite in this repo. Phase A was verified with `npx tsc --noEmit`,
`npx eslint`, three throwaway `npx tsx` harnesses (60 numeric assertions across
geometry, store invalidation, and emitter round-trip), and browser checks.

Load-bearing assertions worth re-running if this code is touched:
- Cutter comp: every PCB path bbox = board bbox grown by exactly the bit radius.
- `planRouting` does not mutate `PanelResult`.
- Tab arithmetic on L=40, tabWidth=3, bit=2, n=2 → spans `[0,7.5] [12.5,27.5] [32.5,40]`.
- Gap rule produces exactly one `error` on `DEFAULT_PANEL_CONFIG` with a 2 mm bit.
- Dedupe drops exactly `(cols−1)·rows + (rows−1)·cols` passes when `gap == bit`.
- Route Gerber round-trips through `parseGerber` to the same bbox. (Note:
  `parseGerber` reports **centerline** bounds, not stroke-swath bounds.)
- `Sample/sample panel/Panel_border.gbr` is 110.0 × 214.5 mm; its panel-outline
  route at 2 mm must be exactly `(−1,−1) → (111, 215.5)`.

Phase B was verified with `npx tsc --noEmit`, `npx eslint` (no new warnings/errors
in any Phase B file — a pre-existing effect-setState warning and two pre-existing
`any` lint errors elsewhere in `portal-main.tsx`/`gerber-exporter.ts` predate this
work), `npm run build`, byte-level reproduction against the real LinuxCNC sample
files (§3.4), and an end-to-end headless run of the store's own generation
pipeline against real Gerber/drill files.
