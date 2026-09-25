# PCB AOI (Automated Optical Inspection) — Project Plan

> **Revision 3 (2026-09-19)** — stack changed to **React Native + Express/TypeScript**
> (was Kotlin/CameraX + Python/FastAPI). See §1.1 for the library choices and the one real
> trade this costs. The change also opens a better route for Phase 4 (§9).
>
> **Revision 2 (2026-09-19)** — updated against the now-shipped AOI export in this portal.
> Material changes: the golden-reference package is a real, fixed contract (§0.1); **drill
> masks must be subtracted before diffing** (§5.4) or every drilled pad reads as a defect; and
> a measured **resolution budget** (§6) that rules out photographing a whole panel in one
> frame. §6 is the one that changes the product, not just the code.

## 0. Context and how this fits together

This portal (`ProPCB Website`) has an **AOI tab** in the CAM Suite that generates a
*Gerber-derived* golden reference. That path is precise (it comes from the design files
themselves) but only exists for boards panelized through this tool.

This plan covers the **photo-based half of the system**: a customer- or shop-floor-supplied
photograph of a physically fabricated board becomes the golden reference, a second photograph
of a board-under-test is captured on the shop floor, and the two are compared pixel-wise with
mismatches boxed. This is a genuinely different, harder problem than the Gerber path — a
photograph has lighting variation, glare, perspective distortion, and no ground-truth
scale — and the plan below is written around that reality rather than treating it as a
smaller version of the Gerber path.

**Decisions already made** (confirmed 2026-09, revisit if wrong):
- Golden-reference registration (a physical board photo → binary, stage 1) is **driven from
  the app** — capture, preview, confirm/retake, and the manual-fiducial fallback all live
  there — but the **image processing runs server-side**, like every other stage.
  ⚠ *Reconciled in revision 3.* The original wording ("registration happens in the Android
  app") read as on-device processing, which contradicts §2, §3 and §4, all of which have
  always described registration as an upload to `POST /golden-references` processed by the
  service. Nothing else in the plan assumed on-device CV. **If on-device registration was
  genuinely intended, say so — it changes §1.1 (the app needs an OpenCV dependency after all),
  §4, and the "no on-device OpenCV" claim in §5.6.**
- Capture and comparison (stages 2–3) run as **a backend service the app calls** — not
  on-device. The app captures and uploads; a server binarizes, aligns, diffs, and returns
  boxed results.
- The app **does not exist yet** — this plan covers it from zero, not just the algorithm.
- **Stack: React Native for the app, Express + TypeScript for the service** (confirmed
  2026-09-19). See §1.1 — this is a deliberate trade of computer-vision ecosystem depth for
  one language across the whole system, and it has a concrete payoff in §0.1 and §9/Phase 4.

### 0.1 The Gerber-derived package is a fixed contract — build against it

The portal's AOI tab emits a ZIP (`{Part}_{Customer}_{Rev}_{Date}_AOI.zip`) containing:

```
aoi/
  Top_Copper.png     1-bit greyscale PNG (colour type 0, bit depth 1)
  Bottom_Copper.png  same, horizontally mirrored
  Top_Drill.png      1-bit drill mask — every drilled hole
  Bottom_Drill.png   same, mirrored
  aoi.json           manifest
  README.txt
```

The manifest's load-bearing fields, all of which this project consumes rather than re-derives:

| field | why it matters here |
|---|---|
| `pxPerMm` | ties every pixel measurement to millimetres (§6) |
| `images[].kind` | `"copper"` \| `"drill"` — drill masks are **subtracted**, not compared (§5.4) |
| `images[].mirrored` | the bottom images run X backwards; inspecting side B is not the same image (§7) |
| `images[].copperValue` | `1` or `0`. **Read it, never assume** — the portal has an invert toggle |
| `images[].mmToPx` | forward affine `[a b c d e f]`; the Y axis flips (Gerber Y-up → image Y-down) |
| `fiducials[]` | mm **and** per-side px — the registration anchors, already known for this path |
| `holes[]` | tooling/reference holes, mm and per-side px — secondary anchors |
| `placements[]` | per-board rectangles on the panel, mm and per-side px — **the crop list** (§6) |
| `warnings[]` | non-empty means the reference is degraded; the app must surface it, not ignore it |

⚠ **`px` is keyed per side** (`{top: [x,y], bottom: [x,y]}`), because the same physical point
has a different x in the mirrored bottom image. A flat `px: [x, y]` would be wrong.

## 1. System architecture

```
┌──────────────────────────┐        ┌───────────────────────────────┐
│   AOI App                 │ ─────► │   AOI Backend Service           │
│  (new, React Native +     │  HTTPS │  (new, Express + TypeScript,    │
│   VisionCamera)           │ ◄───── │   OpenCV bindings)              │
│  - Register golden ref    │  JSON  │  - Binarize                     │
│  - Capture & inspect      │        │  - Align (fiducial homography)  │
│  - View boxed results     │        │  - Diff + connected components  │
└──────────────────────────┘        │  - Store refs/results           │
                                     └───────────────┬──────────────────┘
                                                      │
                                     ┌────────────────┴───────────────┐
                                     │  Object storage (images) +      │
                                     │  Postgres (jobs, refs, results) │
                                     └──────────────────────────────────┘
                                                      ▲
                                                      │ optional seed
                                     ┌────────────────┴───────────────┐
                                     │  ProPCB Website (this repo)     │
                                     │  CAM Suite → AOI tab            │
                                     │  Gerber-derived golden reference│
                                     └──────────────────────────────────┘
```

Two independent golden-reference *sources* feed the same store: the Gerber-derived package
from this portal (§0.1), and the photo-derived one from the app. A board can have either or
both. The comparison engine doesn't need to know which kind it's diffing against — both are
normalized to the same binary-raster + manifest shape (§2).

**Why a separate service, not routes in this Next.js app**: this pipeline benefits from being
iterated on independently of the portal's release cadence, and it wants long-running
CPU-bound request handling that does not belong in the portal's request path. It deploys as
its own Docker container alongside the portal's existing Docker/nginx setup (same server,
separate service/port), not inside `next dev`.

### 1.1 Stack — and the one real trade

| layer | choice | notes |
|---|---|---|
| app | **React Native** | `react-native-vision-camera` for capture — see §6, it is the reason for this specific library |
| | | Expo works, but VisionCamera needs a **custom dev client**, not Expo Go |
| service | **Express + TypeScript** | `multer` for uploads, `zod` for request/manifest validation (already the portal's convention) |
| CV | **OpenCV via Node bindings** | `@u4/opencv4nodejs` (native, fast, needs a build) or `@techstark/opencv-js` (WASM, zero-build, slower) — decide in Phase 1, see §11 |
| image I/O | **`sharp`** | decode/resize/colour-space work; libvips-fast. Not a substitute for OpenCV — it has no homography or connected components |
| DB | **Postgres + Prisma** | same ORM as the portal, so the §2 model is a Prisma schema rather than hand-written DDL |

**The trade, stated plainly:** revision 1 chose Python *specifically* because OpenCV-Python is
where the mature documentation and the well-understood failure modes live. Moving to Node
gives that up — the overwhelming majority of OpenCV examples, Stack Overflow answers and
tuning advice you will hit while working through §8 are written in Python, and you will be
translating them. The Node bindings also lag the Python API and are less travelled. That is a
genuine cost on the hardest part of this project (§4 step 2, §5.3 thresholding), not a wash.

**What it buys, which is not nothing:**

1. **One language across the whole system.** The portal, the service and the app are all
   TypeScript. One toolchain, one set of conventions, one team.
2. **The manifest contract stops being a re-implementation.** `src/lib/aoi/types.ts` in this
   repo already defines `AoiManifest`, `AoiImageMeta`, `AoiFeature`, `AoiPlacement` and the
   `mmToPx` transform. An Express/TS service **imports those types** instead of re-declaring
   them in Python — which removes, structurally, the exact class of contract-drift bug that
   §0.1 exists to warn about. A shared npm package or a path import is enough.
3. **The portal's rasteriser becomes reusable server-side.** This is the big one and it is
   developed in §9 / Phase 4 — the Gerber → binary-raster pipeline in `src/lib/aoi/` is pure
   TypeScript with an injected canvas, and it already runs headlessly under Node today
   (`scripts/verify-aoi-raster.mts`, via `@napi-rs/canvas`). A Node service can run it
   directly. A Python service could not have.

Given (2) and (3), the trade is defensible — but go in knowing the CV work will be the part
that hurts, and budget §8's tuning accordingly.

## 2. Data model (backend service, new database)

A new Postgres database (or schema in the existing instance — either works; a separate
database is cleaner for backup/access-control since this holds shop-floor images, not customer
PII). Expressed as a Prisma schema, matching the portal's own convention (§1.1). Sketch, not
final DDL:

```
Board            { id, name, customerRef, revision, createdAt }
GoldenReference  { id, boardId, source: 'photo' | 'gerber',
                   side: 'top' | 'bottom', mirrored: bool,
                   imagePath, maskPath (binary copper), drillMaskPath (binary, nullable),
                   copperValue: 0 | 1,
                   pxPerMm, widthPx, heightPx,
                   fiducials: jsonb [{id, mm:{x,y}, px:{x,y}, diameterMm}],
                   placements: jsonb [{designId, mm:{x,y,w,h}, px:{x,y,w,h}}],
                   registeredBy, registeredAt }
Inspection       { id, boardId, goldenReferenceId,
                   placementIndex (nullable — which board on the panel was shot),
                   capturePath, maskPath (binary), alignedPath,
                   verdict: 'pass' | 'fail' | 'needs_review',
                   effectivePxPerMm, smallestDetectableMm,
                   defectCount, createdAt, deviceId, operatorId }
Defect           { id, inspectionId,
                   bboxPx: {x,y,w,h}, bboxMm: {x,y,w,h},
                   kind: 'open' | 'short' | 'unclassified',
                   areaPx, confidence }
```

Changes from revision 1, all driven by §0.1:

- **`side` + `mirrored`** — a golden reference is per side, not per board. Comparing a bottom
  capture against a top reference is a guaranteed all-red diff.
- **`drillMaskPath`** — nullable, because the photo path has no drill data. When present it is
  subtracted before diffing (§5.4).
- **`copperValue`** — carried through rather than assumed, so a reference exported with the
  portal's invert toggle on still compares correctly.
- **`placements`** — per-board crops, which §6 makes load-bearing rather than a nicety.
- **`effectivePxPerMm` / `smallestDetectableMm`** on `Inspection` — recorded per run, because
  it depends on how close the operator held the camera. A result is not interpretable without
  knowing what it was physically capable of seeing.

`fiducials` is still the load-bearing alignment field (§5.2). For `source: 'gerber'` it comes
straight from `aoi.json`; for `source: 'photo'` the registration pipeline has to *find* them
optically (§4).

## 3. API contract (backend service)

```
POST /boards                          create a board record
POST /boards/{id}/golden-references   register a golden reference
  multipart: image file, source ('photo' | 'gerber-seed'), side, pxPerMm (if known)
  for 'gerber-seed': the AOI zip itself (§0.1) — manifest parsed server-side
  → { goldenReferenceId, fiducialsFound, widthPx, heightPx, pxPerMm, warnings[] }

POST /boards/{id}/inspections         run a comparison against the current golden reference
  multipart: image file, side, placementIndex (optional), deviceId, operatorId (optional)
  → { inspectionId, verdict, effectivePxPerMm, smallestDetectableMm,
      defects: [{bboxPx, bboxMm, kind, areaPx}], alignedPreviewUrl, warnings[] }

GET  /inspections/{id}                fetch a past result (for history/re-review in the app)
GET  /boards/{id}/golden-references    list references (one per side, per source)
```

`side` is required on both write paths — see §2. `placementIndex` names which board on the
panel was photographed, which §6 makes the normal case rather than the exception.

A `gerber-seed` registration accepts the portal's ZIP whole, so the manifest is the contract
and nothing is re-keyed by hand. On the portal side this needs a small "Publish to AOI service"
action next to the existing download (Phase 4).

## 4. Registration pipeline (golden reference, stage 1)

Input: a photo of a real, known-good board, uploaded from the app. Runs server-side (§0).

1. **Decode + basic sanity check** — reject if resolution is implausibly low or the image is
   mostly blank/blown-out (a failed capture, not a board). Also reject if the implied
   resolution is below the §6 floor, rather than registering a reference that can never
   produce a trustworthy inspection.
2. **Fiducial detection** — the SAME three fiducials a Gerber-panelized board already carries
   (copper dots, per this repo's own panelization engine) are the natural alignment anchors:
   circular, high-contrast against substrate, roughly known size. Detect via Hough-circle
   transform or blob detection after adaptive thresholding. This is the hard part of the whole
   registration pipeline — see §8 (risks) for what happens when detection fails.
3. **Perspective correction** — once ≥3 fiducials are found, compute a homography from their
   detected pixel positions to their *expected* positions (a rectangle in a normalized
   top-down frame) and warp the whole image. This corrects the "photo taken at an angle"
   problem without needing a calibrated camera rig.
4. **Scale calibration** — the real-world spacing between fiducials (known, either from the
   Gerber-derived manifest if this board also has one, or from a user-entered board size in
   the app) gives `pxPerMm` for the warped image, so downstream mm-based defect sizing works
   the same way it already does for the Gerber path.
5. **Binarization** — adaptive thresholding (Otsu or adaptive Gaussian, not a fixed global
   threshold — real lighting varies shot to shot) to separate copper from substrate/mask.
   Likely operates on a color-filtered channel (copper vs. green/black soldermask separates
   better in HSV than in a naive greyscale) — this needs tuning against real sample photos,
   not guessed in advance (see §8).
6. **Validate the output, not the steps** — reject a mask that is uniform (all copper or all
   substrate), or whose copper coverage is implausible (<3% or >90%). A pipeline that "ran
   successfully" and produced a blank mask is the single most dangerous outcome here, because
   nothing downstream can tell it apart from a real result. This portal shipped exactly that
   bug in its own drill masks: the code counted draw calls instead of painted pixels, so a
   100%-black image was emitted with an empty `warnings` array. Check the artifact.
7. **Store** — the warped+binarized mask, the fiducial pixel positions (in the *warped* frame),
   `pxPerMm`, `side`, and the original photo (for audit/re-processing if the pipeline improves).

## 5. Capture + comparison pipeline (stages 2–3)

### 5.1 Capture (React Native app)
`react-native-vision-camera`, configured to the **highest-resolution still format the device
offers** (§6 — not the default preview-resolution capture). Concretely: select the format with
`useCameraFormat(device, [{ photoResolution: 'max' }])` and capture with
`takePhoto({ enableShutterSound: false })`, rather than accepting the default format. This is
why VisionCamera specifically: explicit format/resolution selection is the requirement §6
imposes, and it is the thing a simpler camera wrapper will quietly not give you.

⚠ **Do not capture from a frame processor or a preview frame.** Those run at preview
resolution — roughly 1080p — which is nowhere near the §6 floor, and the resulting mask will
be confidently wrong rather than obviously broken.

The app shows a live overlay guiding the operator to fill the frame with a *single board* and
hold it flat and parallel to the camera — the registration pipeline's perspective correction
handles *some* skew, but a wildly angled shot still degrades fiducial-detection accuracy.
Capture is uploaded as-is (multipart); all processing happens server-side.

React Native also makes an iOS build essentially free. Treat that as a bonus, not a plan:
iOS and Android expose different maximum photo formats, so §6's px/mm floor has to be
re-measured per device class, and the Phase 0 spike should cover whichever one ships first.

### 5.2 Alignment
Identical to registration steps 2–4 above, but the fiducials' *expected* positions now come
from the stored golden reference's own manifest, not a fresh guess — the capture is warped
into the *same pixel space the golden reference already lives in*. This is why storing
fiducial positions on `GoldenReference` (§2) matters: it's the contract that makes stage 3 a
simple pixel-aligned comparison instead of a general (much harder) image-registration problem
every single time.

When the reference is a whole panel and the capture is one board (§6), the warp target is that
board's own `placements[i].px` rectangle, cropped out of the reference.

### 5.3 Binarization
Same thresholding approach as registration (§4 step 5) — must be the *same code path*, not an
independently-tuned second implementation, or systematic differences between the two
binarizations would show up as false defects everywhere, not just at real mismatches. Normalize
both masks to `copper = 1` on the way in, using each reference's declared `copperValue`.

### 5.4 Diff + defect extraction

0. **Subtract the drill mask.** ⚠ **Do this before diffing, or the result is garbage.** The
   copper raster draws every pad and via as a *solid disc*; the real board has a hole through
   the middle of each one. Without masking those regions out, every single drilled pad reports
   as missing copper — hundreds of false "opens" on a perfectly good board. Where the golden
   reference is Gerber-derived, `Top_Drill.png`/`Bottom_Drill.png` give this exactly (white =
   hole, at identical dimensions and scale). Where it is photo-derived there is no drill mask,
   so holes must either be detected optically or the false positives accepted — a real
   asymmetry between the two reference sources, and a reason to prefer the Gerber path for any
   board that has design files.
1. **Pixel diff**: directional difference of the two binary masks — compute
   `golden AND NOT capture` and `capture AND NOT golden` separately rather than a symmetric
   XOR, since step 5's classification is free once they're already separated.
2. **Morphological cleanup**: a small erode→dilate (opening) pass to remove single-pixel noise
   from minor sub-pixel misalignment or threshold jitter — real defects are contiguous blobs of
   meaningful size, not scattered single pixels.
3. **Connected components**: label contiguous diff regions.
4. **Filter by area**: drop components below a minimum pixel-area threshold (tunable —
   anti-alias/threshold noise at edges is the dominant source of tiny spurious components).
   ⚠ Filter on **area**, and on a width that is *sustained* across several scan lines — not on
   a per-scanline minimum run length. This portal got that exact measurement wrong: the
   topmost row of any filled circular pad is a one-pixel run, so a naive minimum-run metric
   reported "1 px" on every board at every resolution, and the warning built on it fired
   forever. A tapering curved boundary is not a thin feature.
5. **Classify** (best-effort, not required for v1): `golden AND NOT capture` is a candidate
   **open** (missing copper); `capture AND NOT golden` is a candidate **short/bridge** (extra
   copper).
6. **Bounding box + mm conversion**: for each surviving component, its pixel bbox plus
   `pxPerMm` gives a real-world mm bbox — directly comparable to how the Gerber-derived path
   already reports fiducial/hole positions in both units.
7. **Verdict**: pass/fail/needs-review from defect count + total defect area against
   configurable thresholds (per board, or a sane global default to start).

### 5.5 Output
An annotated image (boxes drawn on the aligned capture) plus the structured `defects[]` list,
returned to the app for the operator to review immediately — **and the run's
`smallestDetectableMm`** (§6), so a "pass" is never read as stronger evidence than it is.

### 5.6 App screens

- **Board select** — pick or search the board/job being inspected (from `/boards`).
- **Side select** — top or bottom, explicit (§7). Not inferred, and not a hidden default.
- **Register golden reference** — capture → preview → confirm/retake → upload → show the
  fiducial-detection result (how many found, resulting px/mm, any warnings) *before*
  committing. A registration that silently succeeds with 3 badly-placed fiducials poisons
  every later inspection of that board.
- **Inspect** — capture → upload → loading → results: the annotated image, a scrollable defect
  list (tap a defect to zoom to its bbox), and the run's `smallestDetectableMm` shown next to
  the verdict rather than buried.
- **Manual fiducial tap** — the §8.1 fallback, reachable from both capture flows when
  automatic detection finds fewer than 3.
- **History** — past inspections for a board, pass/fail at a glance.

Tech: React Native + `react-native-vision-camera` (§1.1, §5.1), a typed API client sharing the
service's request/response types, standard state management. **No on-device OpenCV** — the CV
logic lives in one place (the backend) rather than duplicated across app versions, which is
the whole point of the confirmed architecture.

## 6. Resolution budget — what the camera must actually resolve

This section is new in revision 2 and it constrains the product, not just the implementation.
The numbers below are **measured** on a real customer board (WLC INDICATOR Rev 1.1) through
this portal's own AOI export, not estimated.

**What the board actually contains**, measured on the rasterised reference:

| feature | size | at 40 px/mm |
|---|---|---|
| narrowest copper | 0.25 mm | 10 px |
| narrowest clearance | **0.05 mm** | 2 px |

**A feature needs ~2 px to survive binarization at all.** Below that it antialiases to
below-threshold grey and vanishes. This is not theoretical: re-rasterising the same board at
20 px/mm **closed the 0.05 mm clearance entirely** — two nets that are separate on the real
board merged into one blob in the reference. An inspection against that reference cannot
detect a short there, because the reference itself already shows a short.

**Now the camera math.** The panel is 166.3 × 242.3 mm; one board on it is 83 × 116 mm.

| capture | px/mm | 0.05 mm clearance | verdict |
|---|---|---|---|
| 12 MP (4032×3024), **whole panel** | ~16.6 | 0.8 px | **unusable** — below the level we measured the clearance vanishing at |
| 12 MP, **one board** | ~35 | 1.75 px | marginal, under the 2 px floor |
| 48 MP (8000×6000), **one board** | ~69 | 3.5 px | comfortable |

**Consequences, which the plan must be built around:**

1. **Photograph one board at a time, never the whole panel.** This is why `placements[]` (§0.1)
   is load-bearing: it gives the per-board crop of the golden reference to compare a
   single-board capture against, and it attributes a defect to a specific board for free.
2. **Require the device's high-resolution still mode**, not the default capture resolution.
   In VisionCamera terms that is an explicit `photoResolution: 'max'` format selection (§5.1),
   and the app should refuse, or loudly warn, below a configured px/mm floor. Note the 12 MP
   row below is roughly what a *default* capture gives you — the 48 MP row is what you get
   only by asking for it.
3. **Report `smallestDetectableMm` with every result** (= ~2 / effectivePxPerMm). At 35 px/mm
   that is ~0.06 mm; the operator must know a "pass" means "no defect larger than that was
   found", not "no defect".
4. **Fine-pitch boards may be out of reach of a phone entirely.** For a board whose clearance
   is at 0.05 mm, a phone at one-board framing is marginal at best. That is an honest product
   limit to state up front rather than discover in the field — and a reason the Gerber-derived
   path (which has no optical limit at all) should be preferred wherever design files exist.

## 7. Side handling — top and bottom are different references

The bottom images are **horizontally mirrored**, because that is what a camera sees when the
physical board is flipped over. This has three consequences the app cannot paper over:

- A golden reference is **per side** (§2). There is no single "the reference for this board".
- The app must know, and record, which side is being photographed — an explicit control, not
  an inference. Comparing a bottom capture to a top reference produces an all-red diff that
  looks like catastrophic failure rather than like the mistake it is.
- Fiducial `px` coordinates are already per-side in the manifest (§0.1); use the matching set
  rather than re-deriving the mirror.

## 8. Real risks — read before estimating timelines

These are the things that make this a computer-vision project, not a CRUD app, and they're the
actual source of schedule risk:

1. **Fiducial detectability in a real photo is not guaranteed.** Copper dots that are trivial
   to find in a clean Gerber render can be hard to threshold reliably under real shop-floor
   lighting (glare off bare copper is the classic failure mode). Plan for a fallback: if
   automatic detection finds fewer than 3 fiducials, the app should let the operator manually
   tap the 3 fiducial positions on the preview image before upload, rather than silently
   failing. Build this fallback from the start, not as a v2 patch.
2. **Optical resolution may simply be insufficient** (§6). This is the risk most likely to
   change the product rather than the code, and it is cheap to settle early: photograph one
   real board, measure the achieved px/mm against a known fiducial spacing, compare to the
   board's own finest feature. Do this in Phase 1, before anything is built on the assumption
   that it works.
3. **Lighting consistency matters more than any algorithm parameter.** A fixed threshold tuned
   on one lighting setup will misfire under another. Strongly recommend a **simple fixed
   capture fixture** (consistent distance, diffuse lighting, no direct glare) for shop-floor
   use — this is a hardware/process recommendation, not just software, and it will do more for
   accuracy than any amount of algorithm tuning. A fixture also fixes the working distance,
   which makes px/mm a known constant instead of a per-shot variable.
4. **Board flatness / focus** — a board that isn't flat against the capture surface introduces
   local defocus and perspective error the homography step can't fully correct. Same fixture
   recommendation applies.
5. **No real sample photos exist yet.** Every threshold/parameter above (adaptive-threshold
   window size, minimum defect area, HSV channel choice) needs tuning against *real* captured
   images from the actual intended lighting/camera setup, not guessed in the abstract — an
   explicit Phase 1 milestone (§9), not deferred to "polish."
6. **False positives from OK manufacturing variance.** Real boards have some legitimate
   pixel-level trace-edge roughness even when good. The morphological cleanup + minimum-area
   filter (§5.4) is the first defense; expect a tuning pass against real accept/reject sample
   pairs before this is trustworthy enough to gate anything.
7. **Silently-degraded artifacts are the worst failure mode in this whole system.** A blank
   mask, a mis-scaled reference, or a mirrored-side mix-up all produce confident, plausible,
   completely wrong output. Every stage should validate what it *produced*, not that it ran —
   and a degraded result should be dropped with an explanation rather than returned. This is
   not hypothetical; the portal's own AOI export shipped a blank drill mask with an empty
   warnings array because it counted draw calls instead of painted pixels.

## 9. Phased delivery

**Phase 0 — Resolution feasibility spike (days, not weeks).**
Photograph one real, already-fabricated board with the intended phone, at one-board framing.
Measure achieved px/mm from known fiducial spacing; compare against that board's finest
feature from its Gerber-derived reference (§6). This either validates the whole approach or
changes the hardware requirement, and it needs no code beyond a ruler and a measurement.

**Phase 1 — Backend skeleton + registration.**
Express service, Prisma schema, `/boards` + `/golden-references` endpoints. Fiducial
detection + perspective correction + binarization + output validation (§4.6), run and
validated against a handful of real sample photos under a couple of lighting conditions —
this is where the risks in §8 get surfaced early, before any app UI exists to hide behind.

Node has no Jupyter equivalent, so the harness idiom is **standalone `scripts/*.mts` run with
`npx tsx`, asserting named oracles and writing intermediate images to disk for eyeballing** —
exactly the pattern this repo already uses in `scripts/verify-aoi-raster.mts`. Copy it. It is
what caught two real measurement bugs in the portal's own AOI work, and it beats a notebook
for anything you want to re-run as a regression later.

Also settle the OpenCV binding here (§1.1, §11) — build `@u4/opencv4nodejs` in the Docker
image and confirm `findHomography`, `warpPerspective`, `adaptiveThreshold`,
`HoughCircles` and `connectedComponentsWithStats` are all reachable before committing to it.
Falling back to `@techstark/opencv-js` later is cheap; discovering a missing binding in
Phase 2 is not.

**Phase 2 — Comparison engine.**
`/inspections` endpoint: alignment against a stored reference, **drill-mask subtraction**,
diff, connected components, bounding boxes, verdict. Validated against deliberately-defective
sample pairs (a board with a known scratch/short introduced) to confirm real defects are
actually caught, not just that the pipeline runs. Also validate the *negative* case: a
known-good board must come back clean, which is where drill-mask subtraction and the
false-positive filtering earn their keep.

**Phase 3 — React Native app.**
Board select, side select, register, inspect, history screens against the now-working backend.
Include the manual-fiducial-tap fallback (§8.1) and the high-resolution capture requirement
(§6, §5.1) from the start. Verify on a real device early — the camera format list is a
device-capability question, and a simulator will not tell you what §6 needs to know.

**Phase 4 — Gerber-path integration.** *(materially better under the Node stack — read this
before committing to the simple version.)*

**4a, the simple version:** a "Publish to AOI service" action in this portal's AOI tab that
posts the generated ZIP to `/golden-references` as `gerber-seed`, so a board with design files
never needs a photo-based registration step at all. ⚠ Blocked on the portal's drill-mask
generation being fixed — as of 2026-09-19 the browser emits a blank mask (dropped rather than
shipped, so the export is honest, but the drill data is missing). Phase 2's drill subtraction
has nothing to consume until that lands.

**4b, worth considering instead:** because the service is now Node/TypeScript (§1.1), it can
**run the portal's own rasteriser directly** — `src/lib/aoi/` is pure TS with an injected
canvas, and it already runs headlessly under Node via `@napi-rs/canvas` today. The service
would take the Gerber files and generate the reference itself, rather than depending on a
browser to produce and upload a ZIP.

That is not just tidier, it sidesteps the Phase 4a blocker entirely: the same code that
produces a blank drill mask in the browser produces a correct one headlessly — verified,
628,720 lit pixels on the same board. A server-side generator therefore has **no dependency on
the unresolved browser bug at all**, and removes the manual download→upload step from the
operator's path. This route was not available under the Python plan.

Do 4b if the browser bug is still open when Phase 4 starts; do 4a if it has been fixed by then
and the upload flow is genuinely wanted for other reasons.

**Phase 5 — Production hardening.**
Deploy the backend as a Docker container alongside the portal's existing Docker/nginx setup;
auth between app and backend (API key or the portal's existing user accounts, TBD); logging/
audit trail for who registered/ran what; threshold tuning from real field data.

## 10. Out of scope (v1)

On-device comparison, defect-type classification beyond open/short, automatic pass/fail
threshold tuning (starts as configured constants), multi-camera/3D capture, silkscreen or
soldermask inspection (copper only, matching the portal's existing AOI tab), and multi-tile
stitching of a whole panel from several frames (§6 resolves this by inspecting one board per
frame instead).

## 11. Open questions to confirm before Phase 1 starts

- Auth model between the app and the backend (shared API key per device vs. real user
  login) — not yet decided above.
- Where the backend's Postgres lives — same server as the portal's DB or fully separate.
- Whether "needs_review" is a real third verdict state the UI must support, or v1 is strictly
  pass/fail.
- Which phone/camera is the target, and whether a fixed capture fixture is acceptable on the
  shop floor — §6 and §8.3 both hinge on this, and it is a purchasing decision, not a code one.
  With React Native, also: Android only, or iOS too (§5.1 — it changes what Phase 0 measures).
- Whether bare-copper boards (pre-soldermask) or finished boards are being inspected — it
  changes the binarization channel choice (§4.5) completely, and possibly the fixture lighting.
- **Which OpenCV binding** (§1.1): `@u4/opencv4nodejs` native vs `@techstark/opencv-js` WASM.
  Settle it in Phase 1 against the real operation list, not on paper. Native wins on speed and
  API coverage; WASM wins on build simplicity. Docker makes the native build tolerable, since
  the image is yours to control.
- Whether the app is Expo-with-dev-client or bare React Native (§1.1). VisionCamera works with
  both; Expo Go alone will not, so "we'll just use Expo Go" is not an option here.
