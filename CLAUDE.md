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

# Database (Prisma — not used by core features yet)
npm run db:push      # Push schema to DB
npm run db:generate  # Generate Prisma client
npm run db:migrate   # Run migrations
npm run db:reset     # Reset DB
```

There are no test commands — this project has no test suite.

## Architecture

This is a single-page Next.js 16 / React 19 / TypeScript app. There is no database in use — all state is client-side in Zustand.

### Data flow

1. **Import** — User uploads `.gbr`/`.drl` files or a ZIP. `store.ts:addLayer` / `addLayersFromZip` parse each file and call `gerberToSvg()` from `gerber-svg.ts`, which dispatches to a Web Worker.
2. **Parse** — `gerber-parser.ts` (custom RS-274X parser) and `excellon-parser.ts` produce `GerberLayer` data with bounds and draw commands. Used for panelization + export math.
3. **SVG render** — `src/workers/gerber-worker.ts` runs `@tracespace/parser` → `@tracespace/plotter` → `@tracespace/renderer` and returns an `svgFragment` + bounds. Fully client-side; no server roundtrip and no Python.
4. **Layer detection** — Layer type and side are first inferred from Gerber's `TF.FileFunction` attribute (extracted by the worker via regex), then by filename heuristics in `store.ts:detectLayerType/detectLayerSide`.
5. **View** — `gerber-viewer.tsx` is an SVG canvas with pan/zoom. On the **Panel Config** tab it builds a `<defs>` of one geometry per layer and `<use>`s it for every PCB position so panel-mode DOM size stays constant in `rows × cols`.
6. **Panelization** — `panelization-engine.ts` computes a `PanelResult` from PCB dimensions + `PanelConfig`. PCB dimensions come from the layer with the largest bounding area (or the explicit `outline` layer if present).
7. **Export** — `gerber-exporter.ts` generates RS-274X Gerber for every layer in the panel plus Excellon drill output, bundled into a ZIP via JSZip + file-saver.

### Key files

| File | Role |
|---|---|
| `src/lib/store.ts` | Zustand store — all app state and layer import logic |
| `src/lib/gerber-parser.ts` | RS-274X parser (apertures, coordinates, regions, arcs) |
| `src/lib/excellon-parser.ts` | Excellon drill file parser |
| `src/lib/gerber-svg.ts` | Type definitions + `gerberToSvg()` Comlink client (lazy-instantiates the worker) |
| `src/workers/gerber-worker.ts` | Web Worker — tracespace parse/plot/render, returns the `GerberSvgResult` shape |
| `src/lib/panelization-engine.ts` | Panel layout, Gerber output format helpers, V-score/fiducial/tooling geometry |
| `src/lib/gerber-exporter.ts` | ZIP export — panelized Gerber files per layer |
| `src/lib/stroke-font.ts` | Vector stroke font for text in Gerber (panel rib labels) |
| `src/lib/region-font.ts` | Region-fill font variant for layer types that need filled text |
| `src/components/gerber-viewer.tsx` | SVG viewer with pan/zoom, crosshair, panel overlay |
| `src/components/layer-panel.tsx` | Sidebar: layer list, type/side/color/opacity controls |
| `src/components/panel-config.tsx` | Sidebar: panel layout configuration form |
| `src/components/export-panel.tsx` | Sidebar: panel info form + export ZIP button |

### Coordinate system

The tracespace renderer emits **Y-down SVG coordinates** (Y=0 at top = Gerber maxY) — the same convention the previous pygerber pipeline used. The viewer works in this native SVG space. When displaying cursor position, gerberY = −screenY. The panelization engine works in **Gerber Y-up mm coordinates** (Y increases upward), and the exporter writes coordinates in that convention.

### Gerber output format

The `OutputFormat` struct controls the `%FS...%` header in exported files. Default is 4.6 mm absolute (handles boards up to 9999mm). `autoDetectIntegerDigits` in `panelization-engine.ts` adjusts the integer digit count if the panel is unusually large.

### UI layout

Single-page layout: collapsible resizable sidebar (280–600px) + full-height SVG canvas. Three sidebar tabs — **Layers**, **Panel Config**, **Info & Export** — controlled by `activeTab` in the store. Panel computation is only triggered by explicit user action (clicking "Create Panel"), not automatically on layer add or config change.
