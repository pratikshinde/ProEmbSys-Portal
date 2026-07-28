# ProPCB / ProEmbSys Portal

A PCB manufacturing portal for ProEmbSys Technologies — customer-facing quoting, ordering, and account management backed by PostgreSQL, plus a fully client-side Gerber/Excellon panelization tool.

This file tracks **what exists and what's been done**. For setup instructions see [SETUP_GUIDE.md](SETUP_GUIDE.md); for architecture, data flow, and implementation gotchas see [CLAUDE.md](CLAUDE.md) (kept in sync with the codebase — the authoritative technical reference).

## What's here

- **Marketing site + Panelization tool** (`portal-main.tsx`) — Home, PCB Order (quoting), CAM Panelization, Assembly, Shop, Blog. Client-side page switcher, URL-synced.
- **Real backend** (App Router + Prisma + PostgreSQL) — auth, admin-editable pricing, orders, customer↔staff messaging, account/address book, staff management, blog/shop/testimonials CMS.
- **Gerber/Excellon engine** (`src/lib/gerber-parser.ts`, `panelization-engine.ts`, `gerber-exporter.ts`) — custom RS-274X + Excellon parsers, panel layout math, RS-274X/Excellon export. No external services; rendering runs in a Web Worker via `@tracespace`.

## Status

Actively developed. Core ordering flow, backend, and panelization tool are functional end-to-end and manually verified in-browser after each change (see progress log below). No automated test suite yet.

## Development progress

Reverse-chronological. Each entry is a real commit — see `git log` for full diffs.

### 2026-07-28 — Three real routing/G-code bugs from production feedback
- **Tabs destroyed at a shared panel gap:** a customer screenshot showed a breakaway tab's mouse-bite holes buried under a continuous routed swath instead of sitting in a clean uncut gap. First root cause (bounding-box mode): when two PCBs face each other across a gap and their passes get merged into one shared cut (`gap == bit diameter`), a *custom* tab-position override measured "distance from edge start" in opposite directions on the two facing edges — so the two boards' tabs landed at different absolute positions, and each board's own pass cut straight through its neighbour's tab with no warning. Fixed by always measuring tab distance in one consistent panel-wide direction. The customer's actual board turned out to have chamfered (45°-cut) corners — non-rectangular, so it routes in **contour** mode, where the bounding-box fix doesn't apply — and re-investigating there found a deeper version of the same problem: contour mode routes every PCB's profile fully independently (no shared-pass merging at all), so at `gap == bit` a neighbouring board's own complete, uninterrupted pass has no way to know about a tab it doesn't own, and cuts straight through it regardless of the bounding-box fix. Fixed by having each PCB check every other PCB's tabs against its own boundary and silently protect any that coincide. Verified with a differential test: disabling just this contour-mode check reintroduced 111 real tab-destroying overlaps across a battery of real-board test panels; with it enabled, zero.
- **Mouse-bite holes drilled too deep into the board:** holes were centred exactly on the true board edge (half the hole inside the finished PCB, half outside) — standard practice, but this shop wants holes that clear the finished board entirely. Mouse-bite holes are now pulled outward from the edge by a configurable clearance (default 0.2mm, matching the requested 0.15–0.2mm), so the whole hole sits outside the board with a small air gap instead of straddling the cut line.
- **Drill feed rate now varies by bit diameter, using the shop's own real numbers:** previously every drill program used one flat feed rate — a deliberate choice at the time, since only six real data points existed with no clear pattern. A seventh real file (a 2.15mm bit) made the shape unambiguous: real production files show 2000 mm/min for a 0.4mm bit down to 500 mm/min for a 4.3mm bit, smaller bits faster. G-code generation now interpolates between all seven real measurements by default (toggleable back to a flat rate), instead of guessing at a formula.

### 2026-07-28 — Contour routing: shaped boards are routed as their real profile, not a rectangle
- The Routing tab's standing limitation — every PCB routed as its bounding box, over-cutting anything non-rectangular (rounded corners, chamfers, curved edges, interior cutouts) — is retired. A new **Outline mode** control (Auto / Contour / Bounding box) traces the real board profile from the imported outline layer and cuts to it, including interior cutouts/slots, milled before the outer profile so the board stays fully supported by the panel while interior features are cut. **Auto** (the new default) uses the traced profile automatically, except when the outline is already a plain rectangle, where it uses the cheaper, identical bounding-box path instead.
- Tabs on a contour spread evenly around the whole closed profile by arc length, with a curvature guard that skips a tab position outright rather than place it across a corner or a tight curve.
- Fabrication-file honesty carries through: a contour that fails to trace, fails to safely offset by the bit radius, or turns out to describe more than one board blocks generation with a clear error — it never silently falls back to the known-wrong bounding box.
- Verified against a real customer board (a 33×102mm outline with two Ø3.2mm and one Ø1.5mm interior cutouts): at a 2.0mm bit the Ø1.5mm cutout correctly collapses (too small for the bit) with a warning; at 1.0mm all three cutouts route cleanly. Confirmed live in the browser end-to-end — import, panel, generate — with the traced contour and cutout circles visible in the canvas preview and zero console errors.

### 2026-07-26 — Fix two real-world drill/mill import bugs from a customer's Gerber package
- **Silkscreen/soldermask layers rendering as copper:** a real customer export named its layers with the common `_MSK-TOP`/`_SLK-BOT` abbreviations and carried no `TF.FileFunction` attribute at all, so filename detection was the only signal — and it only recognized the full words "MASK"/"SILK", not the abbreviations. Every mask and silk layer fell through to the bare TOP/BOT catch-all and rendered as copper. Fixed to also recognize the abbreviated forms.
- **Drill holes not rendering, or rendering in the wrong place:** the same package's drill file uses an Allegro/PentaLogix dialect that lists hole sizes in comments but never declares a coordinate digit format — the tool's default assumption truncated two significant digits off every coordinate, producing negative bounds on a board that has none. Beyond that, this dialect never issues a single explicit tool-select command in its body (tool changes are implied purely by position), so the on-screen renderer — which reads the raw upload independently of the tool's own parsing — had no way to know which hole was which size and silently drew nothing at all. Both are now fixed: the coordinate format is recognized from the file's own shape, and the renderer is handed a freshly-built, fully explicit drill file constructed from the corrected data instead of the ambiguous original.
- **Milling slots invisible, showing as stray points instead:** the same job included a separate router-path file for four rectangular cutouts. It was being misread as more drill holes (missing their actual shape and size entirely) rather than recognized as router paths. The tool now recognizes this file format and draws the milled openings as real filled shapes, matching a written slot report supplied with the job exactly.
- All three fixes were checked against the real files that exposed them, cross-referenced against independent data in the same package (a router-path summary and a slot dimension report) rather than guessed at, and confirmed not to change behavior on any previously-working file set.

### 2026-07-26 — G-Code tab: LinuxCNC drilling and routing programs
- New **G-Code** tab in the CAM tool turns a generated routing plan into ready-to-run LinuxCNC programs — one cutting/routing program per router-bit diameter, and one drilling program per distinct hole diameter (mouse-bite holes and the panel's own imported drill hits that share a diameter go in the same file, matching the shop's own workflow of one program per bit rather than mid-file tool changes).
- Editable machine context: safe/retract Z, cut depth, spindle RPM, feed rates (route Z, route XY, drill), dwell, path-blending tolerance, work offset, and whether to emit the pressure-pad hold-down commands.
- The dialect was confirmed directly against **7 real files from the shop's own LinuxCNC machine** — one cutting program and six drilling programs at different tool diameters — supplied after the shop's machine class and file samples were requested. Two of the drilling files reproduce **byte-for-byte identical** to the originals when fed their own coordinates back through the emitter; the cutting file's header and footer match byte-for-byte, and its body was verified by retract count (the machine only lifts the tool at a breakaway tab, cutting straight through ordinary corners as one continuous move).
- Reproducing the real cutting file surfaced an actual bug in last week's routing planner: a board whose perimeter path wrapped back around to meet its own starting point (a genuine corner, not a tab) was incorrectly left as two separate paths instead of one continuous cut, because the stitching logic only checked forward, never back to the start. Fixed and re-verified.
- G-code generation and download follow the same "nothing auto-computes" convention as panel creation, DFM checks, and routing — a plan only updates on an explicit "Generate G-Code" click, and any previously generated G-code is invalidated the moment the routing plan it was based on changes.
- The requested CNC tooling animation remains deferred, as agreed, until the routing geometry itself is fully trusted in production.

### 2026-07-26 — Routing tab: router tool paths, breakaway tabs and mouse bites
- New **Routing** tab in the CAM tool generates depaneling router paths — the panel perimeter, each PCB individually, or both. Bit size is a free number entry plus 1.0 / 1.5 / 2.0 mm quick presets. Output is **two** files from one geometry source: a Gerber route layer for documentation/CAM interchange, and an Excellon `.rou` with real tool paths and tool definitions. Both ride along in the full panel export and are also downloadable on their own.
- **Breakaway tabs**, either plain solid bridges or mouse bites (a tab plus a row of small drilled holes for clean snap-off), configurable per edge with either automatic even spacing or explicit positions. Mouse-bite holes go to their own `_MouseBites.drl` by default, so the existing CAM350-verified drill output is untouched.
- Paths are **tool-center coordinates, offset outward from the finished board edge by the bit radius**, so boards come out full size. The export README states this explicitly — a fab reading a route layer otherwise can't tell a centerline from a board edge, and guessing wrong mis-sizes every board by the bit diameter.
- Routing needs the gap between boards to be at least the bit diameter, and the panel default is 0.5mm — so the tab flags that up front with a one-click fix that widens the gaps and rebuilds the panel, rather than silently producing a file the router can't run.
- The canvas previews the real cut swath at the actual bit width (not a hairline), plus tab bridges and bite holes; clicking a tab zooms to it. A routing plan is always cleared when the panel changes, since a rout file carrying a previous panel's coordinates would be scrap.
- **Also fixed, found while building this:** with asymmetric side ribs the PCB grid was positioned from the top rib while the tooling-hole exclusion zone was computed from the bottom rib, so the two disagreed and holes were placed on top of boards — on a 2×2 test panel with 20mm/5mm ribs, five tooling holes landed on PCBs. Invisible with the default symmetric ribs (which is why it survived), and symmetric output is byte-identical after the fix. Separately, the exporter had been mutating the shared output-format object in place, compounding digit upgrades across repeated exports.
- G-code generation shipped separately the same day, once the shop supplied real sample files — see the entry above. The requested CNC tooling animation is still deferred until the routing geometry is trusted; the viewer has a group reserved for it.

### 2026-07-25 — Fix L-shape marks landing off the PCB, DFM marker mispositioned on Bottom view, LAN dev access
- **L-shape marks positioned wrong on export:** `generatePanelizedGerber` was adding `baseOffsetX`/`baseOffsetY` (the outline's native-origin offset, meant only for converting the copper/mask body's *native file* coordinates into panel space) a second time on top of `panel.pcbPositions[].x/y`, which are already panel-absolute — the same way `toolingHoles`/`fiducials`/`infoTexts` are used elsewhere with no such offset. Confirmed with a real board: marks were emitted around X=-43mm to -48mm while the PCB itself sat at X≈5mm to 88mm. Fix: use `pos.x`/`pos.y` directly for the L-shape corners, matching every other panel-overlay feature.
- **DFM violation marker mispositioned on Bottom board view:** clicking a violation to zoom to it centered the viewport on the raw, unmirrored coordinate, while the marker itself renders inside a group that mirrors X around the board's center for Bottom-side viewing (the same convention used for all board content). Clicking a Bottom-side violation therefore panned to empty substrate instead of the marker. Fix: the pan-to-focus effect now applies the identical mirror the marker (and the cursor-position readout) already use. Verified live: reverted the fix and reproduced the miss on a synthetic two-sided board with a deliberate spacing violation, then confirmed the restored fix zooms in exactly on the marker.
- **LAN access broken (page loaded but nothing was clickable, layout didn't fit the screen):** `next.config.ts`'s `allowedDevOrigins` only listed leftover cloud-preview domains from an earlier sandbox session. Next.js blocks cross-origin dev-mode script/HMR requests by default, so any device hitting the dev server via LAN IP got HTML back but no working JS — hydration never completed, so responsive layout logic and every click handler were dead. Fixed by adding the dev machine's LAN IP to the allow-list (a fixed IP, so it needs updating if the machine's address changes).

### 2026-07-25 — Fix missing L-shape corner marks on export + add them to the preview canvas
- **Root cause:** `isRectangularOutline()` gated L-shape marks on a global heuristic — "reject the whole outline if more than 10% of its draw commands are arcs." That disqualifies any ordinary rectangular board that happens to have a mounting hole or fillet drawn with real arc commands anywhere on the Edge.Cuts/profile layer, even nowhere near the actual corners. When that happened, the exporter silently dropped L-shapes from both copper and mask with only a `console.warn` — invisible in production, and there was no preview of the marks at all to catch it beforehand.
- **Fix:** replaced the global ratio check with one that only looks at the four bounding-box corners — an L-shape mark only needs the specific corner it sits on to be a sharp, straight 90° intersection. Arcs and holes anywhere else on the outline no longer matter. Verified against a synthetic rectangle with an arc-drawn mounting hole (now correctly accepted) and a genuinely filleted corner (still correctly rejected), plus two real fixtures that were unaffected either way.
- **Preview:** the Panel Config / Info & Export canvas now draws the same L-shape marks the exporter will produce, gated by the identical checks (`enableLShapeMarks`, copper/mask visibility, `isRectangularOutline`) — so the preview and the export can never disagree, and a customer isn't finding out about dropped marks only after opening the file in a CAM tool.

### 2026-07-24 — Fix dark halo around oversized soldermask openings in Board view
- The masked-gold-copper technique from the 07-21 fiducial fix (below) had a second bug: SVG `<mask>` defaults to `color-interpolation: linearRGB` for its luminance calculation, which darkens anti-aliased pixels at the edge of whatever's being masked. That produced a visible dark ring around every pad where the mask opening is larger than the copper — same dark shade regardless of the actual soldermask color, which is why it looked identical (and wrong) on both a red and a green board.
- Fix: force `color-interpolation: sRGB` on the `<mask>` element itself, in the shared `RawSvgMask` component (covers the CAM tool's single-PCB Board view and the PCB Order page's board preview) and the inline mask used by the panelized Board view.
- Verified against the real fixture from the original fiducial fix (`WLC_Indicator`, FID2, 1.5mm copper pad under a 3.0mm mask opening): toggling the style on/off live against the same rendered geometry reproduces the halo and then cleanly removes it.

### 2026-07-22 — DFM phase 2: annular ring, hole checks, and copper clearance
- **Annular ring** and three related hole checks (unlanded plated holes, hole-to-hole web, holes outside the board outline). Each hole is matched to its concentric pad by first recovering the drill↔copper origin offset, so the checks work whether or not "Align Drill to Board Center" has been used.
- **Copper-to-copper clearance** between different nets, measured exactly rather than approximated — computed in the Web Worker so a 20,000-shape copper layer doesn't freeze the UI (~0.5s for a dense board). Violations appear as clickable markers on the canvas; clicking one zooms straight to it.
- Non-plated holes are now distinguished from plated ones. NPTH mounting holes have no pad by design, and without this the unlanded-hole check flagged them on both real test boards.
- Validated against two real boards: all four copper layers report zero clearance violations (as they should — these are manufactured designs), and the measured minimum clearance comes out at exactly 0.2000mm, matching the designer's actual KiCad setting. Annular ring was cross-checked by hand against the source files: a 0.9mm pad on a 0.4mm drill gives 0.25mm, which is what the engine reports.
- Getting there required two corrections that only real boards exposed: shapes meant to touch can land a fraction apart from coordinate rounding (leaving them wrongly on separate nets), and a pad flooded by the copper pour it connects to never touches that pour's outline. Both produced large numbers of false violations before being fixed.

### 2026-07-22 — DFM checks in the CAM tool, with user-editable rule templates
- New **DFM Check** tab in the Panelization tool: checks an imported Gerber set against manufacturing limits — board/panel size, layer count, thickness, minimum drill, drill aspect ratio, minimum trace width and silkscreen line width — and reports graded findings. Advisory only; nothing blocks an order. Runs on an explicit "Run check" click, matching how panel computation only happens on "Create Panel".
- Limits live in **editable, named DFM templates**, several per user, rather than one hardcoded set: customers save their own (private), staff publish shared ones at `/admin/dfm-templates`, and visitors who aren't signed in can still run checks against the shared ones. A built-in "ProEmbSys Standard" template is generated from our published fab capabilities and can't be deleted.
- The public Fab Capabilities page and the DFM baseline are now generated from one constant, so the numbers we advertise and the numbers we check against can't drift apart.
- Validated against real boards: correctly reads 0.4mm drills, 0.45mm tracks and 83×116mm outlines, and flags KiCad's default 0.12mm silkscreen as a warning (cosmetic, so deliberately not an error). Unit handling is verified by re-running a check with the tool switched to inches and confirming an identical report.
- Groundwork only for the deeper checks: annular ring and copper-to-copper spacing aren't evaluated yet (they need pad↔hole matching and a geometry engine respectively) — see `DFM_DRC_ROADMAP.md`. The PCB Order page reuses this engine unchanged in the next slice.

### 2026-07-21 — Razorpay payment integration for PCB orders and the Shop
- PCB orders: payment happens after staff DRC review — once an order is flipped to `AWAITING_PAYMENT`, the customer sees a "Pay Now" card on their order detail page, pays via Razorpay Checkout, and the order automatically advances to `IN_PRODUCTION`.
- Shop: the mini-cart's old `mailto:` enquiry link is now a real checkout — sign in, pick a saved delivery address, pay. Shop purchases are persisted for the first time (`ShopOrder`/`ShopOrderItem`), with server-recomputed pricing from live `Product` rows, mirroring how PCB orders never trust client-sent prices.
- A Razorpay webhook (`/api/webhooks/razorpay`) is a reliability fallback alongside the client-side payment-verify calls, so a payment still gets marked paid even if the customer closes the tab right after paying. Both paths funnel through the same idempotent "mark paid" helpers.
- New admin "Shop Orders" list (`/admin/shop-orders`) with an inline status control, alongside the existing Orders page.
- Requires real Razorpay test keys in `.env` (`RAZORPAY_KEY_ID`/`RAZORPAY_KEY_SECRET`/`RAZORPAY_WEBHOOK_SECRET`) before a live checkout can be tested end-to-end — verified in-browser up through Razorpay order creation, which cleanly errors with placeholder keys instead of crashing.

### 2026-07-21 — Fix fiducials rendering as flat oversized gold dots in Board view
- Fiducials commonly have a soldermask opening larger than the copper pad beneath them (clearance for optical recognition) — the Board view was painting the entire opening flat gold instead of just the copper, hiding the ring of bare substrate other viewers (tracespace.io, delta-gerber) correctly show, which read as "fiducial missing" even though the source Gerbers were fine.
- The mask layer's geometry is no longer painted directly — it's used to reveal a second gold-colored copy of the matching copper layer, so gold only appears where copper actually is. Ordinary SMD pads (mask ≈ copper size) render identically to before. Fixed in both the CAM tool's Board view (single-PCB and panelized) and the PCB Order page's board preview.
- First attempt used an SVG `<clipPath>` and looked correct on a small test file, but silently rendered nothing on the real board that motivated the fix — a populated board's mask layer has 1000+ shapes (one opening per pad), and this renderer's `<clipPath>` breaks down past a few hundred. Switched to an SVG `<mask>` (raster/luminance-based), verified against the real file this time.

### 2026-07-21 — Export drill format defaults to match the uploaded Gerber
- The Drill Output Format in Panel Config → Drill & Marks used to always start at a hardcoded default (Excellon 2:4 inch) no matter what the customer's drill file actually used.
- It now auto-populates from the imported drill layer's detected format (unit/digits/zero-suppression) the moment a drill file loads, across all three import paths (single file, ZIP, RAR). Manually picking a different format in the UI is still fully respected — the auto-sync only fires while the config is still untouched, so a deliberate user choice is never overwritten by a later import.

### 2026-07-21 — Board preview on the PCB Order page
- After a Gerber upload, the PCB Order page now shows a composited board preview (FR4 substrate + gold pads + soldermask + silkscreen) in the soldermask color the customer is actually ordering — the existing Color spec buttons drive it live, no separate preview-only control.
- New `board-preview.tsx`: deliberately store-independent (doesn't touch the Panelization tool's Zustand store), classifies layers with the same 3-tier priority as the CAM tool (drill content-sniff → TF.FileFunction → filename heuristic) and renders via the same worker pipeline. Static + fit-to-view with a Top/Bottom toggle.
- Extracted the CAM tool's board-color/opacity/z-order tables and its `RawSvgGroup` SVG-injection helper into shared files (`board-colors.ts`, `raw-svg-group.tsx`) so the order-page preview and the CAM tool's Board view can never drift apart. Pure refactor — verified the CAM tool's Board view renders byte-identically after.

### 2026-07-21 — Part-number-based export filenames
- ZIP archive is now named `PartNumber_CustomerName_Version_Date_Panel.zip` instead of a generic `panelized_<N>up_<date>.zip`.
- Every file inside follows `PartNumber_LayerName.gerber` (drill files keep `.drl`). All four PanelInfo fields are sanitized first since they're free-text user input.

### 2026-07-21 — Silkscreen renders black on white soldermask preview
- White ink is invisible on a white mask, so the Board view's silk color now flips to black whenever the White soldermask swatch is selected — matching how real white-soldermask boards are actually printed.

### 2026-07-21 — Configurable rib text size, hover-isolate layers, soldermask color preview
- Rib text size is now user-configurable: `topRibFontSize` / `bottomRibFontSize` (both default 2.8mm) with number inputs in the Export tab, replacing hardcoded constants.
- Hovering a layer row in the Layers panel isolates it in the viewer's "Layers" overlay mode (matching a feature from deltaproto's open-source Gerber viewer); moving the pointer away restores the normal view.
- Added a 7-color soldermask preview (Green/Red/Blue/Purple/Yellow/Black/White) for the Board view — cosmetic only, doesn't touch exported Gerbers. Pad-finish gold stays constant across colors, matching real boards.

### 2026-07-21 — Fix aperture-macro corruption in exported Gerber files
- Root-caused reports of "missing D-codes" and broken RoundRect pad rendering (confirmed via tracespace.io, delta-gerber, and CAM350) to three bugs in the export path — none in tracespace, which export never touches.
- `gerber-parser.ts`: stopped uppercasing custom aperture macro names (`RoundRect` was becoming `ROUNDRECT`, so the exported `%ADD` reference no longer matched the verbatim-copied `%AM` definition — "aperture selected but never defined" in every tool). Also fixed the shape-identifier regex truncating digit-suffixed macro names like KiCad's `FreePoly0` to `FreePoly`, which spilled the trailing digit into and corrupted the first parameter.
- `panelization-engine.ts`: fixed `generateApertureDefinitions` sorting macro parameter keys (`$1`..`$10`) lexicographically instead of numerically — `"$10"` sorted before `"$2"`, shifting every corner coordinate of KiCad's RoundRect macro (10 params: radius + 8 corners + a trailing unused rotation) by one position on the way out, even though the parser had captured them correctly. Explains why CAM350 — spec-correct, no tracespace quirks — rendered the same corrupted geometry as the web viewers.

### 2026-07-21 — Region-based panel font quality
- Replaced the hand-authored region-font glyph polygons with **real vector-font outlines** — an embedded Geist Regular subset (OFL-1.1, ~12 KB) parsed via opentype.js, flattened to filled Gerber regions with proper counters. Crisp proportional letterforms (and lowercase, previously missing) instead of rough bespoke polygons.
- Made the panel preview **WYSIWYG**: it now renders the exact same glyph polygons the Gerber exports (byte-identical coordinates), replacing the old browser-monospace approximation.
- Centralized region text metrics into one `measureRegionText` shared by the emitter, panel-label positioning, and the preview (was duplicated/hardcoded in three places).

### 2026-07-20 — Excellon drill parsing fixes + rendering fixes
- Ported dead-code Excellon robustness fixes into the actual live parser (they'd never been running): Altium 9-digit coords, Allegro comment tool defs, `M00`/`M71`/`M72`, stepped `R` repeats, headerless files.
- Fixed a tool-definition regex that silently dropped every tool on files like `T1F00S00C0.024` (params before diameter).
- Added `'none'` zero-suppression mode end-to-end; added a physical plausibility check for files with no declared suppression (rejects boards smaller than their own largest drill bit).
- Fixed a freeze bug where a 2nd/3rd drill-format override silently did nothing.
- Surfaced the resolved drill format (unit/digits/suppression/tool+hole counts/source) in the Layers panel instead of discarding it.
- Patched an upstream `@tracespace/plotter` bug (via `patch-package`) that collapsed KiCad RoundRect pad side-slabs into zero-area slivers ("butterfly" pads).
- Board view substrate is now clipped to the traced board outline instead of a bounding-box rectangle, so non-rectangular boards don't show a rectangle overlapping the PCB border.
- Fixed missing copper/soldermask geometry on Proteus exports whose aperture macros wrap a primitive's point list across multiple lines — valid RS-274X, but `@tracespace/parser` silently dropped the geometry (`src/lib/gerber-preprocess.ts`).
- Fixed the board preview failing to render at all for boards with an untrustworthy traced outline (e.g. a mechanical-drawing outline that doesn't close into a real shape) — the viewBox now falls back to the union of each layer's own plotted bounds instead of tracespace's degenerate one.
- Fixed a unit-declaration bug in the Excellon normalizer: files using `M71`/`M72` (rather than bare `METRIC`/`INCH`) got their coordinates converted to mm but kept a stale inch-mode header — a self-contradictory file that fed both the preview and the actual fabrication export.
- Made the board-view compositor unit-aware: tracespace merges layers using raw native numbers with no inch↔mm conversion, so a mixed-unit set (inch-native Gerbers + a drill our pipeline re-serialized in metric — which is exactly what "Align Drill to Board Center" produces) misaligned by 25.4×, collapsing the artwork into a corner of a huge substrate. Inch-native plot trees are now scaled to mm before compositing.
- Fixed drill tool diameters surviving in inches after parsing an inch-native Excellon file (coordinates were converted to mm, apertures weren't) — "Align Drill" then re-serialized `T01C0.0240` under a METRIC header, drawing every hole as a uniform near-invisible dot.
- "Align Drill to Board Center" now recovers the drill↔Gerber origin offset **exactly** by matching the hole pattern against the copper pad pattern (vote-based algorithm ported from the MIT-licensed [delta-gerber](https://github.com/Delta-Proto/delta-gerber) project) — 315/315 holes land concentric on their pads on a real Protel relative-origin export, vs. the previous bounding-box-center approximation that left every hole ~2mm off. Falls back to copper-bounds centering when no exact match earns enough support.

### 2026-07-10 — Excellon + export robustness (font-fix port)
- Ported Excellon parser and dynamic D-code allocation improvements from the standalone `pcb-panelization-tool` repo's `font-fix` branch.

### 2026-07-08 — UX audit fixes
- Mobile responsiveness, checkout friction reduction, order status display improvements across the portal shell.

### 2026-07-06 — Staff management, CMS, reorder
- Engineer/Admin staff account management (`/admin/team`).
- Blog post, shop product, and testimonial CRUD + public-facing pages.
- Customer "reorder this board" flow from a past order.
- Fixed missing order detail fields and solder-mask color styling.

### 2026-07-05 — Checkout, accounts, file storage
- Screenshot attachments in order messaging.
- Leaded HASL finish option; solder-mask color swatches.
- Delivery format option (individual PCBs vs. panelized).
- Date-encoded human-readable order references (`PCB-YYYYMMDD-NNNN`).
- Customer account + saved address book, wired into checkout.
- Server-side storage of uploaded Gerber files (previously discarded after client-side parsing).

### 2026-07-04 — Initial build
- PCB portal + Panelization tool scaffolded.
- Backend foundation: Auth.js v5 auth, admin-editable pricing engine, order persistence, customer↔staff messaging.

## Contributing / working in this repo

- Read [CLAUDE.md](CLAUDE.md) first — it documents non-obvious architecture decisions (coordinate conventions, drill zero-suppression conventions, pricing snapshot behavior, etc.) that aren't discoverable from the code alone.
- No automated tests exist; verify changes by running the app (`npm run dev`) and exercising the affected flow in-browser.
- Add a dated entry to this file's progress log for notable changes, and keep CLAUDE.md's architecture notes in sync with any structural changes.
