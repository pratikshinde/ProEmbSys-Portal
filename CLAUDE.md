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
2. **Parse** — `gerber-parser.ts` (custom RS-274X parser) and `excellon-parser.ts` produce `GerberLayer` data with bounds and draw commands. Used for panelization + export math.
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

### The switcher shell outside real routes

`Navbar` (in `portal-main.tsx`) is exported and reused directly by the standalone routes (`/fab-capabilities`, `/orders`, `/orders/[id]`, `/account`) that sit outside the client-side switcher — it accepts optional `page`/`setPage`; when omitted (standalone usage) it navigates to `/?page=<key>` instead of calling `setPage`, and `App`'s effect reads that query param once on mount to jump straight to the requested section. This mirrors the existing "correct after hydration, client-only" pattern already used for sidebar width — deliberately not `useSearchParams()` + Suspense, to avoid a second SSR-bailout mechanism for something this simple.

### Key files

| File | Role |
|---|---|
| `src/lib/store.ts` | Zustand store — Panelization tool state and layer import logic |
| `src/lib/gerber-analysis.ts` | Shared Gerber/Excellon layer-type detection + quote-time board analysis (dimensions, layer count, hole count) — used by both `store.ts` and the PCB Order flow |
| `src/lib/gerber-parser.ts` | RS-274X parser (apertures, coordinates, regions, arcs) |
| `src/lib/excellon-parser.ts` | Excellon drill file parser |
| `src/lib/gerber-svg.ts` | Type definitions + `gerberToSvg()` Comlink client (lazy-instantiates the worker) |
| `src/workers/gerber-worker.ts` | Web Worker — tracespace parse/plot/render, returns the `GerberSvgResult` shape |
| `src/lib/panelization-engine.ts` | Panel layout, Gerber output format helpers, V-score/fiducial/tooling geometry |
| `src/lib/gerber-exporter.ts` | ZIP export — panelized Gerber files per layer |
| `src/lib/stroke-font.ts` / `region-font.ts` | Vector/region-fill fonts for text in Gerber output |
| `src/components/gerber-viewer.tsx` | SVG viewer with pan/zoom, crosshair, panel overlay |
| `src/components/layer-panel.tsx` / `panel-config.tsx` / `export-panel.tsx` | Panelization tool sidebar tabs |
| `src/components/portal-main.tsx` | The marketing/tool shell (`App`) — Home/PCB Order/Panelization/Assembly/Shop/Blog, client-side page-switching |
| `prisma/schema.prisma` | Full DB schema — User/Account/Session (Auth.js), PricingRate, Order, MessageThread/Message |
| `src/lib/auth.ts` / `auth.config.ts` | Auth.js v5 config (full / Edge-safe split — see "Backend") |
| `src/lib/pricing-engine.ts` | Pure quote calculation — supersedes `src/lib/pcb-pricing.ts` |
| `src/lib/email.ts` | Resend wrapper (password reset, lazily instantiated — see below) |
| `middleware.ts` | Edge-safe route protection for `/admin/**` |

### Gotchas worth knowing before touching auth/backend code

- Auth.js v5's `Session`/`JWT`/`User` type augmentation must target `@auth/core/types` / `@auth/core/jwt`, **not** `next-auth`/`next-auth/jwt` — the latter re-export from `@auth/core` but module augmentation doesn't follow re-exports, so augmenting the wrong specifier silently does nothing. See `src/types/next-auth.d.ts`.
- `src/lib/email.ts` constructs the Resend client lazily inside the function, not at module scope — constructing it eagerly throws if `RESEND_API_KEY` is unset, which breaks `next build`'s route-data collection (every API route module gets imported during that step, even ones never called).
- Any page using `useSearchParams()` needs a `<Suspense>` boundary or the production build fails (`login`, `reset-password`).
- Prisma `Decimal` fields (money) must be converted via `Number(...)` at the read boundary before use in the pricing engine or before passing to a Client Component — Decimal is a class instance and isn't a plain serializable prop.

### Coordinate system

The tracespace renderer emits **Y-down SVG coordinates** (Y=0 at top = Gerber maxY). The viewer works in this native SVG space. When displaying cursor position, gerberY = −screenY. The panelization engine works in **Gerber Y-up mm coordinates** (Y increases upward), and the exporter writes coordinates in that convention.

### Gerber output format

The `OutputFormat` struct controls the `%FS...%` header in exported files. Default is 4.6 mm absolute (handles boards up to 9999mm). `autoDetectIntegerDigits` in `panelization-engine.ts` adjusts the integer digit count if the panel is unusually large.

### UI layout (Panelization tool)

Collapsible resizable sidebar (280–600px) + full-height SVG canvas. Three sidebar tabs — **Layers**, **Panel Config**, **Info & Export** — controlled by `activeTab` in the store. Panel computation is only triggered by explicit user action (clicking "Create Panel"), not automatically on layer add or config change.
