# ProEmbSys Portal — Setup Guide

## Prerequisites

- **Node.js** 20.9.0+ (v24.14.1 LTS recommended)

No Python, no external services — Gerber/Excellon parsing and SVG rendering are fully client-side.

## Installation

```bash
npm install
npm run dev          # http://localhost:3000
```

## How It Works

- **Parsing:** `src/lib/gerber-parser.ts` (RS-274X) and `src/lib/excellon-parser.ts` (drill files) — custom TypeScript parsers, no external dependency.
- **Rendering:** `src/workers/gerber-worker.ts` runs `@tracespace/parser` → `@tracespace/plotter` → `@tracespace/renderer` in a Web Worker (via Comlink) and returns an SVG fragment + bounds. No server roundtrip.
- **Import methods:** single Gerber/drill files, or a ZIP archive containing multiple layers.
- **State management:** Zustand (`src/lib/store.ts`).

See [CLAUDE.md](CLAUDE.md) for the full architecture (data flow, coordinate system, panelization engine, exporter).

## Troubleshooting

### Gerber preview shows empty
Check the browser console (F12) — parsing/rendering errors surface there. Common causes: malformed Gerber header (`%FS...%`/`%MO...%` missing), or a ZIP with no recognizable `.gbr`/`.drl` extensions.

## Production Build

```bash
npm run build   # copies static + public into standalone output
npm start        # runs .next/standalone/server.js
```
