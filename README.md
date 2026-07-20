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
