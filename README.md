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

### 2026-07-20 — Excellon drill parsing fixes + rendering fixes
- Ported dead-code Excellon robustness fixes into the actual live parser (they'd never been running): Altium 9-digit coords, Allegro comment tool defs, `M00`/`M71`/`M72`, stepped `R` repeats, headerless files.
- Fixed a tool-definition regex that silently dropped every tool on files like `T1F00S00C0.024` (params before diameter).
- Added `'none'` zero-suppression mode end-to-end; added a physical plausibility check for files with no declared suppression (rejects boards smaller than their own largest drill bit).
- Fixed a freeze bug where a 2nd/3rd drill-format override silently did nothing.
- Surfaced the resolved drill format (unit/digits/suppression/tool+hole counts/source) in the Layers panel instead of discarding it.
- Patched an upstream `@tracespace/plotter` bug (via `patch-package`) that collapsed KiCad RoundRect pad side-slabs into zero-area slivers ("butterfly" pads).
- Board view substrate is now clipped to the traced board outline instead of a bounding-box rectangle, so non-rectangular boards don't show a rectangle overlapping the PCB border.

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
