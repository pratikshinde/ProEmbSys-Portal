# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Development
npm run dev          # Start dev server on port 3000

# Build & Production
npm run build        # Build (copies static + public into standalone)
npm start            # Run production build (standalone mode)

# Lint
npm run lint         # ESLint

# Database (Prisma + PostgreSQL — required, see "Backend" below)
npm run db:push      # Push schema to DB (no migration history — fine for dev)
npm run db:migrate   # Create/run a migration (use once schema is stable)
npm run db:generate  # Regenerate the Prisma client after schema.prisma changes
npm run db:seed      # Seed PricingRate rows (prisma/seed.ts)
npm run db:reset     # Drop + recreate the DB, reapply migrations, reseed
```

There are no test commands — this project has no test suite.

## Architecture

Next.js 16 / React 19 / TypeScript, App Router. Two things coexist:

1. **The marketing/tool shell** — `src/app/page.tsx` renders `portal-main.tsx`'s `App`, which owns Home/PCB Order/Panelization/Assembly/Shop/Blog via client-side `useState('home')`, **not** real Next.js routes. This is legacy from before the backend existed; don't migrate it wholesale, just be aware `page` state ≠ URL here.
2. **Real routes with a database** — auth, orders, messaging, and admin all use actual App Router pages/API routes backed by PostgreSQL via Prisma. See "Backend" below.

### Gerber / Panelization data flow (client-side, no DB)

1. **Import** — User uploads `.gbr`/`.drl` files or a ZIP. `store.ts:addLayer` / `addLayersFromZip` parse each file and call `gerberToSvg()` from `gerber-svg.ts`, which dispatches to a Web Worker.
2. **Parse** — `gerber-parser.ts` produces `GerberLayer` data with bounds and draw commands, used for panelization + export math. It holds **both** parsers: `parseGerber` (custom RS-274X) and `parseExcellonDrill` (Excellon drill), dispatched on `isExcellonDrillFile`. Drill layers additionally carry a `drillMeta` field (resolved unit / digits / zero suppression / tool + hole counts / where the format came from) which the Layers panel displays.
3. **SVG render** — `src/workers/gerber-worker.ts` runs `@tracespace/parser` → `@tracespace/plotter` → `@tracespace/renderer` and returns an `svgFragment` + bounds. Fully client-side; no server roundtrip.
4. **Layer detection** — Layer type and side are inferred from Gerber's `TF.FileFunction` attribute first, then filename heuristics in `gerber-analysis.ts:detectLayerType/detectLayerSide` (re-exported by `store.ts` — the two Gerber consumers, the Panelization tool and the PCB Order quote flow, share this logic rather than duplicating it).
5. **View** — `gerber-viewer.tsx` is an SVG canvas with pan/zoom. On the **Panel Config** tab it builds a `<defs>` of one geometry per layer and `<use>`s it for every PCB position so panel-mode DOM size stays constant in `rows × cols`.
6. **Panelization** — `panelization-engine.ts` computes a `PanelResult` from PCB dimensions + `PanelConfig`. PCB dimensions come from the layer with the largest bounding area (or the explicit `outline` layer if present).
7. **Export** — `gerber-exporter.ts` generates RS-274X Gerber for every layer in the panel plus Excellon drill output, bundled into a ZIP via JSZip + file-saver.

### Backend (PostgreSQL + Prisma + Auth.js v5)

Requires a running Postgres and a populated `.env` (`DATABASE_URL`, `AUTH_SECRET`, `APP_URL`, `RESEND_API_KEY`, `EMAIL_FROM` — see `.env.example`). Schema: `prisma/schema.prisma`.

- **Auth** — Auth.js v5 (`next-auth@beta`), Credentials provider, Prisma adapter, JWT sessions. Config is split across `src/lib/auth.config.ts` (Edge-safe subset — no Prisma/bcrypt — used by `middleware.ts`) and `src/lib/auth.ts` (full config with the adapter + provider, used everywhere else). **Don't import `auth.ts` from middleware** — it pulls in the Prisma adapter, which breaks on the Edge runtime. Roles: `CUSTOMER` / `ENGINEER` / `ADMIN`. Password reset is fully custom (`PasswordResetToken` model + `src/lib/email.ts` via Resend) since Credentials auth has no built-in flow. Real routes: `/login`, `/register`, `/forgot-password`, `/reset-password`.
- **Pricing** — `src/lib/pricing-engine.ts` exports `calculatePcbQuoteV2`, a pure function (no DB import) that resolves a quote from a `PricingRatesMap`. Rates live in one generic `PricingRate` table (`category` + `key` + `value` + `unit`), editable at `/admin/pricing`, so raw-material cost changes don't require a redeploy. `src/app/api/quote/route.ts` fetches active rates, builds the map via `buildRatesMap`, and calls the pure function. `prisma/seed.ts` seeds initial rates transcribed from the old hardcoded constants in `src/lib/pcb-pricing.ts` (now superseded, kept for reference — not deleted). **Orders store a full snapshot** of the resolved breakdown in `Order.priceBreakdown` (JSON) at creation time — editing a `PricingRate` later must never change an already-placed order's price; if you touch the pricing flow, preserve this.
- **Orders** — `src/app/api/orders/route.ts` (list/create) and `.../[id]/route.ts` (get/PATCH status). Creating an order also creates its `MessageThread` in the same transaction. Customer view: `/orders/[id]`. Staff view: `/admin/orders/[id]` (adds a status-change control). `Order.reference` is a date-encoded, human-readable ID (`PCB-YYYYMMDD-NNNN`, day boundary in IST since the business is Bangalore-based) generated by `src/lib/order-reference.ts`'s `generateOrderReference()` — always call it with the transaction client (`tx`, not `db`), not just for consistency but because it must run inside the same transaction as `Order.create` so a rollback also undoes the counter increment (`OrderSequence` table, one row per day, incremented via an atomic Postgres upsert). Never derive the sequence number by counting existing rows — concurrent requests would race and collide.
- **Messaging** — Polling-based (no WebSockets), 10s interval via `@tanstack/react-query`'s `refetchInterval`. One `MessageThread` per order (or a standalone `GENERAL_INQUIRY` thread). Shared UI: `src/components/messaging/message-thread.tsx`, used by both the customer and staff order-detail pages. API: `src/app/api/messages/threads/route.ts` + `.../[id]/route.ts`. Messages support one image attachment each (screenshots) — `POST .../[id]` takes `multipart/form-data`, not JSON. Files are saved to local disk (`src/lib/attachments.ts`, `uploads/messages/<threadId>/<uuid>.<ext>`, gitignored) — fine for a single-instance deploy, but swap for S3-compatible object storage before scaling to multiple instances or a container that doesn't persist disk across restarts. Attachments are served through an auth-gated route (`src/app/api/messages/attachments/[threadId]/[filename]/route.ts`, reuses `canAccessThread` from `src/lib/messaging.ts`) rather than `public/`, since screenshots are private to the order's participants.
- **Admin area** — `/admin/**`, gated twice: `middleware.ts` (coarse, Edge-safe, JWT role check) + `src/app/admin/layout.tsx` (DB-aware redirect for non-staff). `/admin/pricing` additionally requires `ADMIN` specifically (engineers can view orders/reply to messages but not edit pricing) — enforced both in the page and in the `/api/pricing/rates` routes.
- **Fab Capabilities page** — `/fab-capabilities` is static content (no DB), intentionally — process specs change far less often than pricing.
- **Customer account** — `/account` (name + address book). `Address` supports multiple saved billing/delivery addresses per user with one default per type; `gstNumber` lives on the address (India ties GST registration to a specific place of business), not on `User`, since a customer can have several GST-registered billing addresses. Set-default is enforced by unsetting other addresses of the same type inside the same transaction, both on create and update (`src/app/api/account/addresses/route.ts` and `.../[id]/route.ts`) — never just flip the new one without clearing the old default, or you can end up with two.
- **Checkout addresses** — `PCBOrderPage` fetches the customer's saved addresses and auto-selects their defaults; a delivery address is required to place an order (not to save a quote), a billing address is optional (not every customer needs a GST invoice). Like `priceBreakdown`, the chosen addresses are snapshotted onto `Order.deliveryAddress`/`billingAddress` (`Json?`) at creation time rather than kept as live foreign keys — `Address` rows are user-editable and deletable, so a live FK would let a placed order's shipping details silently change or break later. `src/lib/format-address.ts` narrows the stored `Json` back into a typed shape for display on the order detail pages.
- **Uploaded Gerber files** — the browser previously parsed the uploaded `.gbr`/`.zip`/`.rar` client-side (for dimension/layer detection) and discarded it, sending only the filename string. `POST /api/orders` now takes `multipart/form-data` and actually persists the file via `src/lib/order-files.ts` (same local-disk pattern as `src/lib/attachments.ts`, but validated by extension rather than MIME type — browsers don't reliably report one for `.gbr`/`.rar` — and with no per-order subfolder, since the order doesn't exist yet at upload time). Placing a real order (not saving a quote) now requires a file, checked both client-side (`PCBOrderPage`) and server-side. Download is auth-gated at `/api/orders/[id]/file` (owner or staff only), same ownership check as `/api/orders/[id]`.
- **Staff management** — `/admin/team` (ADMIN only). `User.isActive` gates login in `src/lib/auth.ts`'s `authorize()` — deactivating a staff account (`DELETE /api/admin/staff/[id]`, despite the verb, only flips `isActive: false`) is deliberately **not** a hard delete: `Message.authorId` cascades on delete, and an Engineer's sent messages live in threads shared with customers, so hard-deleting would erase their side of past conversations. An admin can't deactivate or demote their own account (checked server-side in `.../staff/[id]/route.ts`, not just hidden in the UI). New accounts get a random temp password (works immediately, shown once in the creating admin's browser) plus a best-effort welcome email with a password-set link reusing the existing reset-password flow — email failure never blocks account creation.
- **Resend failures don't throw by default** — the Resend SDK resolves `{ data, error }` on API-level failures (e.g. a placeholder `RESEND_API_KEY`) rather than throwing; only network-level failures throw. `src/lib/email.ts` explicitly checks `result.error` and throws, so callers that branch on success/failure (like the staff-creation `emailSent` flag) aren't silently wrong. Because of this, `forgot-password`'s route wraps the send in `try/catch` — the reset token must still be created even if the email fails, matching the documented "always return 200" behavior.
- **Blog, Shop products, Testimonials** — all three follow the same shape: a Prisma model with `isActive`/`published` + `sortOrder`, an admin CRUD API gated to ADMIN or ENGINEER (`/api/admin/blog`, `/api/admin/products`, `/api/admin/testimonials`, plus `[id]` routes), a public read-only API returning only active/published rows (`/api/blog`, `/api/products`, `/api/testimonials`), and an admin page + client table component under `src/app/admin/**` / `src/components/admin/**`. Blog content is Markdown, rendered via `react-markdown` on the real `/blog/[slug]` route (outside the switcher shell, like `/fab-capabilities`) — arbitrary Tailwind descendant selectors (`[&_h1]:...`) style the output since `@tailwindcss/typography` isn't installed. `BlogPage`, `ShopPage`, and `HomePage`'s teaser sections all fetch from the public APIs client-side instead of the hardcoded `BLOG_POSTS`/`PRODUCTS` arrays that used to live in `portal-main.tsx` (removed).
- **Reorder** — the "Reorder this board" button on `/orders/[id]` (only shown to the order's own customer, not staff viewing via that same route) links to `/?page=order&reorder=<orderId>`. `PCBOrderPage` reads that param client-side, fetches the old order via the existing (already ownership-checked) `GET /api/orders/[id]`, and pre-fills every spec field from it — including re-fetching its stored Gerber file through the auth-gated download route and re-constructing a `File` object client-side so it runs through the exact same `handleFile()` analysis path as a fresh upload. Nothing about this is a special "confirm and repeat" flow — it lands the customer back at step 2 with everything pre-filled but fully editable (color, dimensions, delivery format, the file itself, all of it), then goes through the completely normal place-order flow, including a brand new server-side price recompute and its own independently-stored copy of the Gerber file.

### The switcher shell outside real routes

`Navbar` (in `portal-main.tsx`) is exported and reused directly by the standalone routes (`/fab-capabilities`, `/orders`, `/orders/[id]`, `/account`) that sit outside the client-side switcher — it accepts optional `page`/`setPage`; when omitted (standalone usage) it navigates to `/?page=<key>` instead of calling `setPage`. `App`'s `setPage` mirrors every section switch into the URL via `history.pushState` and a `popstate` listener re-reads `?page=` — so back/forward buttons, bookmarks, and middle-click all work even though sections aren't real routes. This is still deliberately not `useSearchParams()` + Suspense (avoids a second SSR-bailout mechanism); the URL read happens client-side only, mirroring the sidebar-width hydration pattern. Nav items render as real `<a href="/?page=…">` anchors with intercepted left-clicks. `Navbar` collapses to a hamburger drawer below 920px (`useIsMobile` hook in `portal-main.tsx`); the shell's layout is otherwise fluid via `clamp()` and `auto-fit` grids since inline styles can't use media queries. The shop cart state lives in `App` (single source — the navbar badge and `ShopPage` mini-cart both read it); there is no online checkout yet, the mini-cart's CTA is a prefilled order-enquiry `mailto:`.

### Key files

| File | Role |
|---|---|
| `src/lib/store.ts` | Zustand store — Panelization tool state and layer import logic |
| `src/lib/gerber-analysis.ts` | Shared Gerber/Excellon layer-type detection + quote-time board analysis (dimensions, layer count, hole count) — used by both `store.ts` and the PCB Order flow |
| `src/lib/gerber-parser.ts` | RS-274X parser (apertures, coordinates, regions, arcs) **and** the Excellon drill parser (`parseExcellonDrill`, `autoDetectDrillFormat`, `generateNormalizedExcellon`) — the only drill parser in the repo |
| `src/lib/gerber-svg.ts` | Type definitions + `gerberToSvg()` Comlink client (lazy-instantiates the worker) |
| `src/workers/gerber-worker.ts` | Web Worker — tracespace parse/plot/render, returns the `GerberSvgResult` shape |
| `src/lib/panelization-engine.ts` | Panel layout, Gerber output format helpers, V-score/fiducial/tooling geometry |
| `src/lib/gerber-exporter.ts` | ZIP export — panelized Gerber files per layer |
| `src/lib/stroke-font.ts` / `region-font.ts` | Vector/region-fill fonts for text in Gerber output |
| `src/components/gerber-viewer.tsx` | SVG viewer with pan/zoom, crosshair, panel overlay |
| `src/components/layer-panel.tsx` / `panel-config.tsx` / `export-panel.tsx` | Panelization tool sidebar tabs |
| `src/components/portal-main.tsx` | The marketing/tool shell (`App`) — Home/PCB Order/Panelization/Assembly/Shop/Blog, client-side page-switching |
| `prisma/schema.prisma` | Full DB schema — User/Account/Session (Auth.js), PricingRate, Order, MessageThread/Message, BlogPost, Product, Testimonial |
| `src/lib/auth.ts` / `auth.config.ts` | Auth.js v5 config (full / Edge-safe split — see "Backend") |
| `src/lib/pricing-engine.ts` | Pure quote calculation — supersedes `src/lib/pcb-pricing.ts` |
| `src/lib/email.ts` | Resend wrapper (password reset, staff welcome, lazily instantiated — see below) |
| `src/lib/order-status.ts` + `src/components/order-status-badge.tsx` / `order-timeline.tsx` | The only sanctioned way to display an `OrderStatus` — humanized labels + colors (never show raw enum strings like `PENDING_REVIEW` to users), plus the pipeline timeline on `/orders/[id]` |
| `middleware.ts` | Edge-safe route protection for `/admin/**` |
| `src/app/admin/team/page.tsx` + `src/components/admin/staff-table.tsx` | Staff (Engineer/Admin) account management, ADMIN only |
| `src/app/admin/blog\|products\|testimonials/page.tsx` + matching `src/components/admin/*-table.tsx` | CMS-style admin CRUD for the three content types, all ADMIN or ENGINEER |
| `src/app/blog/[slug]/page.tsx` | Public blog post detail route (real route, outside the switcher shell) |

### Gotchas worth knowing before touching auth/backend code

- Auth.js v5's `Session`/`JWT`/`User` type augmentation must target `@auth/core/types` / `@auth/core/jwt`, **not** `next-auth`/`next-auth/jwt` — the latter re-export from `@auth/core` but module augmentation doesn't follow re-exports, so augmenting the wrong specifier silently does nothing. See `src/types/next-auth.d.ts`.
- `src/lib/email.ts` constructs the Resend client lazily inside the function, not at module scope — constructing it eagerly throws if `RESEND_API_KEY` is unset, which breaks `next build`'s route-data collection (every API route module gets imported during that step, even ones never called).
- Any page using `useSearchParams()` needs a `<Suspense>` boundary or the production build fails (`login`, `reset-password`).
- Prisma `Decimal` fields (money) must be converted via `Number(...)` at the read boundary before use in the pricing engine or before passing to a Client Component — Decimal is a class instance and isn't a plain serializable prop.

### Tracespace patch + board-view substrate

`patches/@tracespace+plotter+*.patch` (applied by `postinstall` via patch-package) fixes an upstream bug in macro primitive 20 ("vector line"): the width offset was applied *along* the line instead of perpendicular, collapsing the side slabs of KiCad `RoundRect` pad macros into zero-area slivers (pads rendered as a "butterfly" — center box + corner circles, no sides). Don't delete the patch or reinstall without `postinstall` running.

The viewer's Board view composites per-layer worker SVGs itself (not `@tracespace/core` renderBoard). Its FR4 substrate is a bounds rectangle **clipped to the traced board outline** when `BoardView.shapePathD` is set (`gerberRenderBoardView` in `gerber-svg.ts` traces the outline layer via core's `boardShape` and rejects untrustworthy shapes — e.g. Protel Mechanical-1 dimension ticks that close into degenerate slivers — falling back to the plain rectangle). KiCad exports *filled* silkscreen shapes as dense 0.04mm hatch strokes; a solid silk disc on screen is usually real design content, not a rendering bug.

### Coordinate system

The tracespace renderer emits **Y-down SVG coordinates** (Y=0 at top = Gerber maxY). The viewer works in this native SVG space. When displaying cursor position, gerberY = −screenY. The panelization engine works in **Gerber Y-up mm coordinates** (Y increases upward), and the exporter writes coordinates in that convention.

### Gerber output format

The `OutputFormat` struct controls the `%FS...%` header in exported files. Default is 4.6 mm absolute (handles boards up to 9999mm). `autoDetectIntegerDigits` in `panelization-engine.ts` adjusts the integer digit count if the panel is unusually large.

Panel-overlay apertures (L-shape marks, stroke text, donuts, fiducials) are allocated **dynamically above the customer's max D-code** (`findMaxDCode` in `panelization-engine.ts`, base ≥ 301 rounded to the next century) — never hardcode overlay D-codes like the old D53/D54/D200/D210; customer Gerbers routinely use those ranges and duplicate/conflicting `%ADD` definitions trip CAM tools. `parseExcellonDrill` (in `gerber-parser.ts`) handles Altium 9+-digit coordinates (5.5 autodetect), Allegro `;Holesize`/`;FILE_FORMAT` comment headers, `M00` tool changes, stepped `R` repeat commands, headerless files (no `M48`/`%`), and explicit-decimal coordinates (KiCad) — ported/adapted from the standalone `pcb-panelization-tool` repo's `font-fix` branch, which is the upstream lineage of this tool.

### Drill zero suppression — two opposite conventions

`DrillZeroSuppressionMode` in `gerber-parser.ts` names **which zeros were removed from the file** (`'leading'` → pad left to restore). `DrillZeroSuppression` in `panelization-engine.ts` is the *export* setting and is deliberately **inverted**, because CAM350 reads the LZ/TZ header keywords backwards: exporting `'leading'` strips *trailing* zeros. They don't collide (exports carry an explicit header; the drill handed to the viewer is normalized to explicit decimals) — but never unify them without re-testing in CAM350. `'none'` means fixed-width coordinates in both.

A drill layer keeps its pristine upload in `LayerEntry.originalContent`; `rawContent` is the *normalized* Excellon (explicit decimals) consumed by the exporter and the SVG renderer. Drill format overrides and `autoDetectDrillFormat` must always re-parse from `originalContent` — re-parsing `rawContent` is a silent no-op, since explicit decimals ignore the format entirely.

### UI layout (Panelization tool)

Collapsible resizable sidebar (280–600px) + full-height SVG canvas. Three sidebar tabs — **Layers**, **Panel Config**, **Info & Export** — controlled by `activeTab` in the store. Panel computation is only triggered by explicit user action (clicking "Create Panel"), not automatically on layer add or config change.
