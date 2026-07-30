# Urinal Flow Lab — what a new agent needs to know

Physics-based urinal splashback and drainage simulator. TypeScript, Vite, three.js, no
test framework beyond a bespoke validation suite.

Read the "Verification" and "Traps" sections before changing geometry. They exist
because each item in them cost real time to find, and most of them look correct.

---

## Commands

| | |
|---|---|
| `npm run dev` | Vite dev server |
| `npm run build` | `tsc --noEmit && vite build` |
| `npm run validate` | 39 physics checks against published references. ~60 s. **Authoritative.** |
| `npm run shoot` | Screenshot the **running app** headlessly. See below. |
| `npm run render` | Offline render of the fixture **meshes only**. Fast, but not the product. |

`npm run shoot` needs `npx playwright install chromium` once (~88 MB).

Useful flags: `--models classic-bowl --t 0.9,6.8 --cameras threeQuarter,front,side,top
--field dry|liquid|impingement|... --overlays zones=0,heatmaps=0,streamPath=0,shell=0
--stage --out tools/shots/x`. Times are **simulated** seconds, so shots are reproducible.

---

## Verification — read this first

The single most expensive mistake made on this project was reviewing geometry with an
offline rasteriser that drew the fixture mesh *alone* — no shaders, no liquid, no
droplets, no user figure, no room — and reporting that as "it looks right in the
product". It is a different claim, and it concealed a whole family of integration
faults for a long time: capture planes buried inside the ceramic, an opaque casting
occluding the stream, an aim constant tuned for one fixture applied to all six, and
splash flying straight through the fixture body.

Rules:

1. **`npm run validate` passing is not visual verification.** None of its 39 checks
   look at whether anything is coherent on screen.
2. **`npm run render` is not visual verification either.** It shows meshes, not the app.
3. To claim the product looks right, use `npm run shoot` and *look at the image*.
4. `window.__lab` (`src/ui/automation.ts`) drives the app: `selectModel`, `advanceTo`,
   `setCamera`, `setFieldMode`, `setOverlays`, `probe()`. `probe()` deliberately
   reports interior **and** casting extents side by side, because the whole clipping
   family of bugs came from those two differing while only the interior was consulted.
5. Reading an image path twice appears to return a cached result. **Write to a new
   filename** when you re-render, or you will study a stale picture. This wasted time.

---

## Architecture

```
core/       vec3, rng, constants, fluid (FLUID_PRESETS, WALL_MATERIALS)
geometry/   profile   sagittal 2-D section (ProfileParams, buildProfile)
            surface   UrinalSurface — THE WETTED INTERIOR, structured (u,v) loft
            wrap      side-edge stand-off along the profile
            shell     exterior casting (ShellParams, buildShell -> ShellMesh)
            collider  SolidCollider / MeshCollider — makes any mesh collidable
            presets   the 6-model fixture library
            bvh       ray/triangle acceleration
sim/        simulation  owns surface + casting + castingCollider; SimConfig
            stream, particles, impact, film, capture, metrics
render/     sceneView, fixtureView, dropletView, streamView, colormap
            softRaster  software rasteriser shared by thumbnails and tools/preview
ui/         app, controls, charts, thumbnail, automation
validation/ suite (39 checks), runCli
tools/      shoot.mts (headless app screenshots), preview.mts (offline meshes)
```

### Load-bearing contracts

- **`UrinalSurface` is one lofted patch over `(u,v)`**, `u ∈ [-1,1]` across the width,
  `v ∈ [0,1]` from the top of the back wall to the front lip tip, uniform in
  arclength. The film solver is finite-volume and *requires* a structured grid with a
  known metric. This is why "import an arbitrary mesh" is not a small feature — it
  needs a `FixtureGeometry` seam, not a loader.
- **The casting is solid and the simulation owns it.** `Simulation.casting` +
  `Simulation.castingCollider`. `SceneView.setGeometry(surface, casting, capture)`
  receives it. Do not rebuild it in the render layer.
- **Exterior hits are captures, not impacts.** A droplet hitting the casting is routed
  to `CaptureZone.FixtureExterior`. The film solver has no cell for the outside of the
  casting. This keeps volume closure exact.
- **Volume closure is validated at 0.0000%.** If a change makes liquid appear or
  vanish, that check fails. Treat it as the strongest signal in the suite.
- Presets are shared objects. Always copy on load: `{ ...getPreset(id).params }`.
  `src/ui/app.ts` does this for both `surface` and `casting`.

---

## The fixture library

`src/geometry/presets.ts` — 6 models, chosen to be told apart at a glance.

`classic-bowl` · `flat-wall` (square slab, also the flat-wall splash control) ·
`stall-urinal` · `trough` · `compact-waterless` · `nautilus-tall` (constant-angle).

**`src/validation/suite.ts` hardcodes the ids `classic-bowl`, `flat-wall` and
`nautilus-tall`.** Renaming or removing them breaks the suite. `flat-wall` must keep a
*planar* back wall — the headline A/B claim depends on it meeting the stream near
normal incidence.

`UrinalPreset.shell?: Partial<ShellParams>` gives each model its own exterior
character. That is the extension point for casting style.

---

## Traps

Each of these looks reasonable and is wrong. Several are physics bugs, not cosmetics.

**1. Never build the casting in the render layer.** It is solid. Building it in
`SceneView` because it "was only cosmetic" is exactly how splash came to fly through
the ceramic — 19,377 droplets per run on the default bowl, all unaccounted.

**2. `halfWidthAt` must be differentiable at the sump.** It once used
`pow(t, 1/e)` above the sump; with `e = 2` that is `sqrt(t)`, which has an **infinite
derivative at `t = 0`**. The width was continuous but not smooth exactly where the
profile goes horizontal, so the v-tangent gained an unbounded lateral component and
cells at the sump edge skewed under 2° with **normals flipped against their
neighbours** — which silently inverts gravity and the impact angle in the very cells
that decide drainage. Now smoothstepped to arrive with zero slope from both sides.

**3. The wrap fade must be a single mechanism, in arclength, ending before the sump.**
See the long comment in `src/geometry/wrap.ts`. Three different fades were composed
over time and each fought the others, producing three separate regressions (a 28% error
in settled pool depth; flipped normals; degenerate cells). Do not add a fourth
mechanism — change the one that is there.

**4. Do not pin the front-rise foot to the bowl depth.** It used to be
`bowlDepth − inturn − 0.02`, which makes the front wall of the bowl **vertical**, so the
casting is a slab of constant depth from floor to lip and the fixture reads as a
rounded box no matter how the exterior is built. `sumpFrontFraction` (~0.55) gives the
undercut, which is most of a urinal's recognisable silhouette.

**5. The casting is not the convex hull of the interior.** The interior spans full
width at the rim and full depth at the lip, so its hull is a box by construction. Cap
the skin to `ShellParams.wallThickness`; the exterior follows the bowl's form.

**6. Fit the casting section as a support function.** Two cheaper fits fail:
radius-per-angle leaves the directions the bowl does not occupy undefined, and filling
them from neighbours carries the lip's forward reach out sideways (a 340 mm bowl came
out 600 mm wide); a width-and-depth box has corners the bowl never fills and inflated
the casting by 70 mm when grown to contain them.

**7. Deck raycasts are fragile in two specific ways.** (a) The probe must be offset a
few mm off the patch boundary row, or the ray travels in the plane of that row, grazes,
and misses about half the time — reporting "no cavity" and paving the deck over the
opening. This once made two renders byte-identical and cost real debugging time.
(b) Probe *below* the lip, where the bowl's front wall still exists; probing above it
lets the ray sail over the front wall onto the back wall and the deck then paves the
whole cavity into a flat shelf. (c) Bound the deck width — the raycast may only make it
narrower, never wider.

**8. The rim deck fans outward from the axis** to `min(wall, cavity)`. Ringing inward
from the wall paves straight over the opening.

**9. `widthLip` must stay close to `widthRim`** (~0.85–0.9×). Narrowing it looks
sleeker and leaves gaps between the front rise and the back wall's side edges that
splash escapes through: dropping the nautilus from 0.28 to 0.22 multiplied splashback
on the user by **five** and broke the headline claim.

**10. Draw the aim trajectory at the current exit speed, not peak.** Exit speed varies
more than twofold across a void (1.50 m/s at t = 0.9 s against 3.11 m/s at peak on the
default 28.6 s curve). Drawing it once at peak put the dashed line far from the
droplets for most of a run and made a correct trajectory model look broken.

**11. Frame the camera from the bounding sphere of interior ∪ casting**, solved from
the camera's own fov and aspect. The old `1.9 × max(height, width)` ignored depth and
cropped every model.

**12. When validation fails after a geometry change, work out whether the solver or
the test is wrong.** The standing-pool check broke three times. Twice the *test* was at
fault: it deposits a fixed volume and asserts the pool pins at the capillary limit, so
it silently becomes volume-limited when the sump's level area changes. An attempt to
make it geometry-adaptive made it worse — sizing the fill from the level area spread
liquid across the whole basin, which made the pool **basin**-limited and it exceeded
the capillary limit at 3.35 mm. The companion "never exceeds" check caught that. The
current design is a small localised blob, justified by the depth being the same for
1×, 1.5× and 2× the fill, i.e. an attractor.

**13. `wrapDepth` for `nautilus-tall` is a genuine trade, not a tuning oversight.** The
generated wall already sweeps most of the bowl depth forward and the wrap is measured
forward from there, so 0.26 makes the fixture 511 mm deep against ~360 for a
conventional bowl. Below 0.21 the 8× splashback advantage collapses to nothing. Left
visible on purpose.

---

## Current measured state

All six presets, at every grid resolution from 48×96 to 112×200:

- flipped normals: **0** (was 2–10 on the original presets)
- degenerate cells: **0** (was 4–28)
- worst cell skew: **0.42–0.99** (was 0.079 — tangents 4.5° apart). The 0.42 is
  `nautilus-tall` at 112×200; everything else is above 0.47.

Re-measure with a throwaway script over `PRESETS` × resolutions if you touch
`surface.ts`, `wrap.ts` or any preset's `wrapDepth` / `taperExponent` / `widthSump`.
Those three quantities are what move it.

`npm run validate` → **39/39**. `npm run build` clean.

Fixture envelopes (W × D × H mm): classic-bowl 401×363×475, flat-wall 368×363×528,
stall-urinal 448×393×1010, trough 942×347×410, compact-waterless 360×392×471,
nautilus-tall 425×511×596. Real references: TOTO wall-hung 320×340×540, RAK Jazira
355×330×445, ADA rim limit 430 mm above floor.

---

## Outstanding work, in priority order

**1. `FixtureExtent` (high).** Every `npm run shoot` line prints
`castingAheadOfCapture`, currently 0–44 mm depending on model. `CaptureScene` still
derives everything — emitter stand-off, user figure, shin/thigh planes, floor, heat
planes — from `surface.bounds().max.z`, the **interior**. Consequently the
`FixtureExterior` capture plane sits at `interiorFrontZ + 4 mm`, i.e. *inside* the
ceramic, and "stand-off from fixture" under-reports the real gap. The casting collider
now intercepts droplets before they reach that plane, so it is masked rather than
fixed. The fix is one object carrying front/back/bottom/bounds/floor, built from
interior ∪ casting, consumed by capture, camera, room, user and zones — which kills the
whole class at source instead of patching six call sites.

**2. Per-model aim (high).** `defaultConfig().aimTargetV = 0.18` is a single global
applied identically to a 340 mm trough and a 950 mm stall. Aim is the most sensitive
input in the model (splashback varies by more than an order of magnitude between
v = 0.14 and v = 0.36 on one fixture). It belongs on the model.

**3. `FixtureModel` registry + `FixtureGeometry` interface (medium).** For user-supplied
models. Suggested shape: a registry (`registerFixture`) so built-in presets, user JSON
and imported meshes all arrive through one door; `FixtureGeometry` as an interface with
`UrinalSurface` as one implementation; casting as a strategy with a null implementation
for meshes that already have an exterior. Two import paths, easiest first: fit the
parametric loft to an imported mesh (keeps the film solver intact, lossy), then native
imported grids (needs the solver to accept a general grid).

**4. Hardcoded constants (medium).** `BANDS`, `ABINS`, `BODY_A`, `BODY_V` in `shell.ts`
are module constants, not parameters. Inline magic numbers there too: `0.7 / convexity`
curvature cap, `1.004` push-out, `0.0025` march step, `smoothstep(0.35, 0.85)` for
backness. `THUMB_RES` in `ui/thumbnail.ts`; card size in `app.ts`.

**5. Interior side-wall seam artifact (low).** Visible in three-quarter shots of
`classic-bowl`. Not diagnosed.

**6. `shell.ts` structural assumptions (low, but blocks imports).** It assumes symmetry
about `x = 0`, a flat wall-mounted back plane, exactly one forward-facing opening above
one front lip, and a convex section. A corner unit, a floor-standing pedestal, an
asymmetric model or a two-opening model breaks it.

---

## UI note

The ~40 geometry sliders were replaced by a six-card fixture picker with real rendered
thumbnails (`src/ui/thumbnail.ts`, painted one per idle tick, ~40 ms each). The stream,
posture, fluid and model-coefficient controls remain — those are the experiment, not
the fixture. `Outlet condition` keeps the drain discharge coefficient, which is a
condition rather than a shape.
