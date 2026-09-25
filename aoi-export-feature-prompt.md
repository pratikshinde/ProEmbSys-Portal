# Feature prompt — AOI export for the PCB manufacturing portal

> Scope: **this portal only.** Copy everything below the line into a fresh AI session.

---

## What to build

Add an **AOI Export** feature to the ProPCB manufacturing portal (Next.js 16 / React 19 /
TypeScript, CAM Suite with a Gerber panelization engine).

The feature's **only** job is to take an already-computed panel and emit a ZIP containing
binary copper images plus a metadata manifest, in the exact format specified below.

### Explicitly NOT in scope

This portal does **not** perform inspection. It does not capture images, does not use OpenCV,
does not compare anything, does not detect defects. A **separate AOI application** consumes
this ZIP and does all of that. Do not add camera, comparison, or defect-detection logic to
this codebase. The portal is a *file generator*, nothing more.

## Output format (this is the contract — get it exactly right)

Download filename: `{PartNumber}_{Customer}_{Revision}_{Date}_AOI.zip`

```
aoi/
  Top_Copper.png       binary copper raster, top side
  Bottom_Copper.png    binary copper raster, bottom side (horizontally mirrored)
  Top_Drill.png        binary drill mask, top side
  Bottom_Drill.png     binary drill mask, bottom side (horizontally mirrored)
  aoi.json             manifest
  README.txt           plain-text description of the package
```

### Image requirements

- **1-bit greyscale PNG** (PNG colour type 0, bit depth 1). Not RGBA, not 8-bit. The consuming
  app treats these as strictly binary, so the file format must be unambiguous.
- **Copper = white (1), substrate = black (0)** by default, with a config option to invert.
  Whichever is used must be declared per-image in the manifest as `copperValue`.
- **1:1 real-world scale**, set by a configurable `pxPerMm`.
- **Whole panel**, origin at the panel's bottom-left corner in millimetres.
- **Bottom side horizontally mirrored** — it must match what a camera sees when the physical
  board is flipped over.
- **Drill masks** mark every drilled hole (component holes, vias, tooling and reference holes)
  as white, everything else black, at the same dimensions and scale as the copper raster for
  that side. The consuming app subtracts these regions from its comparison. Without them,
  every drilled pad reads as a defect, because the copper layer draws pads as solid discs
  while the real board has a hole through each one.

### Resolution

- Configurable `pxPerMm`, **default 40**.
- The UI must show the resulting pixel dimensions and an estimated file size live, before the
  user generates.
- Enforce a maximum output size and refuse to generate above it, with a clear message telling
  the user to lower the resolution.
- **Warn when the resolution is too low for the board's own geometry**: scan for the finest
  feature (narrowest trace/gap) and if it works out to fewer than ~2 pixels at the chosen
  `pxPerMm`, say so explicitly in the UI and record it in the manifest's `warnings` array.
  Sub-pixel features vanish when rasterised, and the consuming app would report them as
  missing copper on a perfectly good board.

### `aoi.json` manifest

```jsonc
{
  "schemaVersion": 1,
  "generator": { "app": "ProPCB", "generatedAt": "<ISO 8601>" },
  "job": { "partNumber": "...", "revision": "...", "customer": "..." },
  "panel": {
    "widthMm": 166.3,
    "heightMm": 242.3,
    "originMm": [0, 0],
    "axes": { "gerber": "y-up", "image": "y-down" }
  },
  "pxPerMm": 40,

  "images": [
    {
      "file": "Top_Copper.png",
      "kind": "copper",                    // "copper" | "drill"
      "side": "top",
      "mirrored": false,
      "widthPx": 6652, "heightPx": 9692,
      "bitDepth": 1,
      "colorType": "grayscale",
      "copperValue": 1,                    // for drill masks: value meaning "hole"
      "mmToPx": [40, 0, 0, -40, 0, 9692],  // affine [a b c d e f]
      "forwardFormula": "x_px = k*x_mm, y_px = H - k*y_mm",
      "inverseFormula": "x_mm = x_px/k, y_mm = (H - y_px)/k"
    }
    // ...one entry per emitted image, including the drill masks
  ],

  // Alignment anchors. Every entry carries BOTH mm and pixel coordinates, and the
  // pixel coordinates are keyed per side, because the bottom images are mirrored
  // and therefore have a different x for the same physical point.
  "fiducials": [
    { "id": "fid_bl", "mm": [15, 2.5],
      "px": { "top": [600, 9592], "bottom": [6052, 9592] },
      "diameterMm": 1, "clearanceMm": 2 }
  ],
  "holes": [
    { "id": "tooling_tl", "type": "tooling",   // "tooling" | "reference"
      "mm": [9.5, 240.3],
      "px": { "top": [380, 80], "bottom": [6272, 80] },
      "diameterMm": 2 }
  ],

  // One entry per individual board on the panel, so the consuming app can crop
  // per board and attribute a defect to a specific one.
  "placements": [
    { "designId": "...", "row": 0, "col": 0, "rotationDeg": 0,
      "mm": { "x": 0, "y": 5, "w": 83, "h": 116 },
      "px": { "top": { "x": 0, "y": 4852, "w": 3320, "h": 4640 },
              "bottom": { "x": 3332, "y": 4852, "w": 3320, "h": 4640 } } }
  ],

  "warnings": []
}
```

**Critical detail — the Y axis flips.** Panel geometry is Gerber convention, Y-up with the
origin at the bottom-left. Images are Y-down with the origin at the top-left. Every coordinate
written into the manifest must go through the documented transform, and the same transform
must be used for the images themselves, the fiducials, the holes, and the placement rectangles.
Getting this sign wrong produces a vertically mirrored reference that looks plausible and is
completely wrong.

**Per-side pixel coordinates are mandatory.** A flat `px: [x, y]` field is wrong — the same
physical point has a different x in the mirrored bottom image. This is the easiest thing in the
whole spec to get subtly wrong.

## UI

A new **AOI** tab in the CAM Suite sidebar, alongside the existing tabs, following the same
patterns as the Stencil tab:

- Toggles for which sides to include (top / bottom)
- Resolution input (`pxPerMm`), with the live pixel-dimension and size estimate described above
- An invert toggle (copper black instead of white)
- A **Generate** button — disabled until a panel has been computed, and while generating
- A generated-file list with per-file sizes
- A **Download** button producing the ZIP
- Any warnings surfaced visibly, not buried in the manifest only

Generation must be an explicit user action. Do not auto-generate on config change — this
matches the existing convention in this tool, where panel creation, routing, G-code and stencil
generation all require a deliberate click.

## Implementation requirements

- **Rasterise from the panelized Gerber data**, i.e. the same merged, panel-space Gerber the
  fabrication export produces — not from the raw single-board upload, and not from a
  screenshot of the viewer.
- **Reuse the existing export pipeline's geometry.** Board offsets and per-design settings must
  come from the same code path the real Gerber export uses, so the AOI reference and the
  fabricated board can never disagree about where anything is.
- **Never emit a partial or best-effort image.** If a raster cannot be produced correctly
  (parse failure, geometry outside the panel envelope, resolution over the cap), emit nothing
  for that side and report why in `warnings`. A silently wrong inspection reference fails good
  boards, which is worse than producing no reference at all.
- **Clear generated files whenever the panel, layers, or part number change.** A reference
  carrying a previous panel's geometry is the most dangerous possible output of this feature.
- **Persist the config** with saved CAM jobs, defaulting sensibly for jobs saved before this
  feature existed.

## Acceptance criteria

- Generating for a real panelized board produces a ZIP with the exact file layout above.
- The PNGs are genuinely 1-bit (verify: colour type 0, bit depth 1, only two distinct pixel
  values present).
- Feeding a fiducial's `mm` coordinate through `forwardFormula` lands on its stated `px`
  coordinate, for both sides.
- Reading the pixel at a fiducial's stated position in the copper raster returns copper.
- The bottom image is an exact horizontal mirror of the top-side geometry.
- Drill mask white regions line up with real hole positions on the board.
- Changing the panel and regenerating produces a different, correct reference — never a stale
  one.
