# ProEmbSys Portal — Setup Guide

## Prerequisites

- **Node.js** 20.9.0+ (v24.14.1 LTS recommended)
- **PostgreSQL** 16+, running locally — either a native install or Docker (see below)

Gerber/Excellon parsing and SVG rendering are fully client-side (no Python, no external services). The rest of the app — accounts, quoting, orders, messaging, admin — needs a database.

## Installation

```bash
npm install
```

### 1. Get PostgreSQL running

**Docker** (needs Docker Desktop + WSL2 on Windows — skip to the native option below if you don't have WSL2 enabled):
```bash
docker compose up -d
```
This starts Postgres using [docker-compose.yml](docker-compose.yml), matching the `DATABASE_URL` in `.env.example` exactly.

**Native install** (no virtualization needed — simpler on Windows Home):
1. Install PostgreSQL for Windows: https://www.postgresql.org/download/windows/
2. Open **SQL Shell (psql)**, connect as `postgres`, and run:
   ```sql
   CREATE USER propcb WITH PASSWORD 'propcb_dev_password';
   CREATE DATABASE propcb OWNER propcb;
   ```
   This matches `.env.example`'s `DATABASE_URL` — no other config needed either way.

### 2. Configure environment variables

```bash
cp .env.example .env
```
Fill in:
- `AUTH_SECRET` — generate with `openssl rand -base64 32` (or any random 32+ byte string for local dev)
- `RESEND_API_KEY` / `EMAIL_FROM` — only needed for password-reset emails to actually send; the rest of the app works without a real key

### 3. Push the schema and seed pricing data

```bash
npm run db:push      # creates tables from prisma/schema.prisma
npm run db:generate  # regenerates the Prisma client
npm run db:seed      # seeds the PricingRate table
```

### 4. Run it

```bash
npm run dev          # http://localhost:3000
```

Register an account at `/register`. To access `/admin` (pricing editor, order management), promote a user to staff directly in the DB — there's no self-service admin signup:
```bash
npx prisma studio
# or:
node -e "require('@prisma/client').PrismaClient.prototype; const{PrismaClient}=require('@prisma/client');new PrismaClient().user.update({where:{email:'you@example.com'},data:{role:'ADMIN'}}).then(()=>process.exit())"
```

## How It Works

**Gerber / Panelization tool** (client-side, no DB):
- **Parsing:** `src/lib/gerber-parser.ts` (RS-274X) and `src/lib/excellon-parser.ts` (drill files) — custom TypeScript parsers, no external dependency.
- **Rendering:** `src/workers/gerber-worker.ts` runs `@tracespace/parser` → `@tracespace/plotter` → `@tracespace/renderer` in a Web Worker (via Comlink) and returns an SVG fragment + bounds. No server roundtrip.
- **Import methods:** single Gerber/drill files, or a ZIP archive containing multiple layers.
- **State management:** Zustand (`src/lib/store.ts`).

**Backend** (PostgreSQL + Prisma + Auth.js v5):
- **Auth:** Credentials-based login/register/password-reset, roles (`CUSTOMER`/`ENGINEER`/`ADMIN`), route protection via `middleware.ts`.
- **Quoting & pricing:** `src/lib/pricing-engine.ts` resolves quotes from admin-editable rates in the DB (`/admin/pricing`), not hardcoded constants — an order snapshots its price at creation time, so later rate edits never change historical orders.
- **Orders & messaging:** placed orders persist to Postgres (`/orders/[id]` for customers, `/admin/orders/[id]` for staff), each with a polling-based (10s) message thread for customer↔engineer queries.

See [CLAUDE.md](CLAUDE.md) for the full architecture (data flow, coordinate system, panelization engine, exporter, backend internals, and known gotchas).

## Troubleshooting

### Gerber preview shows empty
Check the browser console (F12) — parsing/rendering errors surface there. Common causes: malformed Gerber header (`%FS...%`/`%MO...%` missing), or a ZIP with no recognizable `.gbr`/`.drl` extensions.

### `Can't reach database server at localhost:5432`
Postgres isn't running. `docker compose up -d` (Docker) or check the PostgreSQL service is started (native install). Confirm with `pg_isready -h localhost -p 5432`.

### Login/register fails silently or 500s
Check `AUTH_SECRET` is set in `.env` and the dev server was restarted after adding it (env vars are read at server start, not hot-reloaded).

### Password reset emails never arrive
`RESEND_API_KEY` in `.env.example` is a placeholder. Get a real key from https://resend.com or skip email testing — the reset token is still created in the DB and the flow otherwise works, you just won't receive the email.

## Production Build

```bash
npm run build   # copies static + public into standalone output
npm start        # runs .next/standalone/server.js
```
