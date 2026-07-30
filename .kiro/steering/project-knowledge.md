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
| `npm run validate` | 43 physics checks against published references. ~85 s. **Authoritative.** |
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

1. **`npm run validate` passing is not visual verification.** None of its 43 checks
   look at whether anything is coherent on screen.
2. **`npm run render` is not visual verification either.** It shows meshes, not the app.
3. To claim the product looks right, use `npm run shoot` and *look at the image*.
4. `window.__lab` (`src/ui/automation.ts`) drives the app: `selectModel`, `advanceTo`,
   `setCamera`, `setFieldMode`, `setOverlays`, `setAim`, `setAimUv`, `probe()`.
   `probe()` deliberately reports interior **and** casting extents side by side,
   because the whole clipping family of bugs came from those two differing while only
   the interior was consulted.
5. Reading an image path twice appears to return a cached result. **Write to a new
   filename** when you re-render, or you will study a stale picture. This wasted time.
6. **A screenshot cannot check the report or the readouts** — the report is a collapsed
   `<pre class="report">`. To verify text output, drive the app with Playwright and read
   `textContent`; that is how the rewritten report was checked. `advanceTo()` past the
   end of the run now produces the report, so this works without clicking anything.
7. **Compare fixtures at the same aim, stand-off *and* seed.** All three move the
   headline figure a long way, and one of them silently reversing a comparison is how a
   previous headline claim survived being wrong (see Traps 14 and 16).

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
- **Exterior hits are captures, but they still splash.** A droplet hitting the casting
  is routed to `CaptureZone.FixtureExterior` because the film solver has no cell for the
  outside of the casting — but it goes through `ImpactResolver.resolveExterior` first,
  which throws a corona by the same threshold as the interior and books only the
  remainder to the zone. It used to be booked and killed outright, which was the single
  largest error in the model. See Trap 14.
- **Aim is two-dimensional and lives on `(u, v)` of the wetted surface.**
  `SimConfig.aimTargetV` walks down the profile, `aimTargetU` across the width.
  `Simulation.aimAtSurfaceUv(u, v)` solves the launch angles ballistically;
  `aimAtProfileFraction(v)` delegates to it on the current `u`.
- **`Simulation.traceAim(t?)` is the only correct answer to "where does the stream go".**
  It tests interior **and** casting, nearest wins, matching the particle sweep's own
  ordering. The viewport trajectory, the aim marker and the aim sweep all go through it.
  Anything that raycasts only `surface` will draw a confident line through solid
  ceramic. See Trap 15.
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

The headline A/B is now measured on **sustained flow only**
(`SplashbackReport.sustainedMicrolitresPerLitre`), not on the whole void. That is not a
convenience; see Trap 16.

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
conventional bowl. Below 0.21 the splashback advantage collapses to nothing. Left
visible on purpose.

**14. Never let a capture zone absorb liquid without resolving what it does.** The
casting exterior was a perfect absorber for a long time: a droplet reaching it was
booked to `CaptureZone.FixtureExterior` and killed — no corona, no secondaries, nothing.
For most aim points that is a rounding error. But the *stream itself* strikes the casting
whenever it is aimed low enough to have to clear the front rim, and the absorber then
swallowed the void whole. Measured on the default bowl at `aimTargetV = 0.55`: **118.6 mL
of a 120 mL void** booked to the exterior, producing zero impacts, an empty film and
**zero splashback** — a perfect score for the one aim that in reality sprays straight
back off the front of the fixture. With `resolveExterior` in place the same case reads
15 500–17 845 µL/L across seeds, making it the worst aim on the fixture, which is what
anyone who has used a urinal would tell you. Volume closure stays at 0.0000% because the
split is exhaustive: ejected volume becomes live droplets, the rest is booked to the
zone. There is a regression check for this; do not delete it.

**15. Anything that answers "where does the stream land" must test the casting too.**
`updateStreamPath` and the aim sweep both raycast `surface` alone, so the dashed
trajectory and the aim marker were drawn *through* the solid casting. The UI showed
liquid reaching the sump while the real stream was being stopped dead by the rim — which
is precisely the case that produced the all-zero run in Trap 14, so the two bugs hid each
other. Use `Simulation.traceAim`. A blocked aim draws amber and the sweep prints "hits
casing".

**16. The all-in splashback figure is not stably signed. Do not build a claim on it.**
The flat-slab-versus-constant-angle ratio was measured at 0.42× at 90 mm stand-off,
0.51× at 120 mm, 1.22× at 180 mm and 2.76× at 250 mm — it changes direction across the
range of a single posture control. The reason is that a decaying stream leaves on the
same aim, falls short, and lands on the fixture's own front rim; a deep fixture needs
more reach (534 mm to the constant-angle back wall against 420 mm for the slab) so it
falls short sooner and with more of the flow (4.6% against 1.8%). That is real physics
and it partly cancels the wall's benefit. Use
`sustainedMicrolitresPerLitre`, which isolates the wall and is stable: across five seeds
the slab sits at 354–579 µL/L and the constant-angle wall at 0–1. The robust
mechanism metric is the splash *fraction* ratio, stable at 1.39–1.45×.

**17. Weak flow dominates splashback, and it is the largest single effect in the model.**
The rise and the dribble are ~18% of the void and produce **6–16× more splashback per
litre** than sustained flow (flat slab 10.3–16.6×, oval bowl 6.1–7.2×, constant-angle
over 17 000× because its sustained figure is ~0). Any aggregate that mixes the phases is
reporting mostly the tail. This is why `FlowPhase` exists and why the report leads with
"when it happens". No change to the bowl shape addresses it.

**18. The parabolic wetted patch belongs to the coherent-jet regime. Do not force it.**
A jet on an inclined wall spreads into a sheet bounded by a thick rim tracing a
parabola-like curve open at the bottom — a hydraulic jump on an incline (Edwards,
Howison, Ockendon & Ockendon, *JFM* 2008). `FilmSolver.depositJet` supplies the physics
for it: the arriving normal momentum becomes radially outward sheet momentum at ~jet
speed (inviscid Bernoulli), spread over a real footprint instead of one cell. But at the
default posture the stream **breaks up at 21 cm and the wall is 51 cm away**, so a
droplet train arrives (measured: 15 of ~900 particles still coherent) and deposits as
scattered spatter plus a runnel — correctly. The rim appears when the jet is still intact
on arrival. Verify with the `Film thickness` view, not the `Liquid` view.

**19. If the liquid looks like a stain, suspect the shading before the solver.** The
wetted region genuinely was structured — the film-thickness field showed a coherent
runnel from impact to sump — while the `Liquid` view showed mottled damp mush. Two
causes, both in the fragment shader. The wet mask was `smoothstep(3e-6, 3e-5)`,
saturating at 30 µm which is *below* the retention thickness, so every cell the liquid
had ever touched read as fully wet and no contact line existed anywhere. And the
capillary-wave term was isotropic `sin/cos` noise on three axes, which is what a rough
absorbent surface looks like; injecting wall-jet momentum made it worse because its
amplitude follows film speed. Now: the mask is referenced to
`FilmParams.retentionThickness` via the `uWetOnset` uniform, the ripple is applied along
the flow direction only, and there is an `aEdge` vertex channel carrying a meniscus
highlight computed on the solver's grid (a wet cell with a much drier neighbour), which
is resolution-independent.

**20. Statistics about "the stream" must exclude re-impacting splash.**
`actualImpingement()` was volume-weighted over every impact of every generation.
Measured on the default bowl: 117 mL of primary arrivals at 46° against 84 mL of
secondary arrivals at 59° — so nearly half the weight of a statistic labelled "where the
stream landed" was liquid that had already bounced, which both dilutes the aim signal and
drags the angle upward. Use `primaryMeanAngle` / `primaryFractionOverCritical`.

**21. Line-of-sight tests must include the casting.** `computeImpingementMap` shadowed
against the interior alone. The casting hides **19–44%** of interior cells from the exit
point depending on model (trough 43.7%, nautilus 37.4%, flat-wall 35.4%, classic-bowl
28.7%, compact 25.5%, stall 18.9%) — the deck under the rim, the back of the lip, the
outer side walls. All of it was being counted as reachable, so the mean angle and the
fraction over the criterion were averages taken partly over ceramic the stream cannot
touch. It now takes an optional `SolidCollider`.

**22. Correlations have a range of validity; clamp to it.** The Cossali wetted-wall
threshold `2100 + 5880·δ^1.44` was fitted for `δ = h/d` up to order one and rises without
bound. Extrapolated into the sump it claimed deeper liquid is ever harder to splash — at
δ = 2 the critical K is already 18 000, effectively unsplashable — which is the opposite
of what a plunging jet does. Past ~1 diameter the mechanism becomes cavity collapse and a
Worthington jet and the threshold flattens. `WET_SPLASH_K_FILM_MAX_DELTA` holds δ at the
edge of the evidence.

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

`npm run validate` → **43/43** (~85 s). `npm run build` clean.

Splashback reference points, oval bowl, default posture, 300 mL void, seed 12345:
aim v = 0.18 gives 3234 µL/L all-in — 1222 µL/L during sustained flow against
12 529 µL/L during the rise and tail. Aim v = 0.55, which puts the stream on the front
rim, gives 24 715 µL/L and is the worst aim available. All four figures were unavailable
before this pass: the tail split did not exist and the rim strike reported zero.

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

**2. Per-model default aim (high, partly done).** Aim is now two-dimensional
(`aimTargetU` / `aimTargetV`), directly pickable in the viewport, and traced against the
casting — so it is legible and honest. What remains is that the *default* is still one
global `aimTargetV = 0.18` applied identically to a 340 mm trough and a 950 mm stall.
`UrinalPreset` should carry a default aim; the reachable range differs enormously by
model (measured shallowest reachable impingement: nautilus 24.6° at v = 0.088,
flat-wall 30.2° at v = 0.397, stall 31.0° at v = 0.581, trough 31.4° at v = 0.397,
compact 37.1° at v = 0.416, classic 43.1° at v = 0.407).

**2b. Aim is solved once, at peak speed, and then held (medium).** `aimAt` uses the
peak-flow exit speed, so as the stream decays it falls progressively shorter on a fixed
elevation until it lands on the fixture's own rim. That is a real effect and Trap 17 says
it dominates the result — but whether a real person tracks their aim as the stream weakens
is a modelling choice that is currently made implicitly and never surfaced. Worth making
explicit rather than leaving as an accident of when the solve happens.

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

## UI

Two rounds of reduction. First the ~40 geometry sliders became a six-card fixture picker
with real rendered thumbnails (`src/ui/thumbnail.ts`, painted one per idle tick, ~40 ms
each). Then the remaining panel — 24 controls opening flat, with no indication which
three mattered — was cut to **5 sliders visible by default** out of 21 present.

Left panel, in order: **Fixture** (picker) · **Aim** · **Stream & posture** (peak flow,
stand-off, exit height) · **Fluid & wall material** (two selects) · **View** (collapsed)
· **Advanced** (collapsed).

`Advanced` holds everything that is not a decision anyone makes while evaluating a
fixture: void volume, exit diameter, tremor, drain coefficient, the two calibrated
coefficients, the published dry-splash K, tangential retention, retention thickness,
capillary strength, both grid resolutions, the seed, and the appearance gains. It exists
for auditability, not for use — **do not remove it**; the model's credibility rests on
those numbers being reachable.

`Aim` is the promoted section, because aim is the most sensitive input in the model and
was previously two abstract numbers buried among twenty. It has an "Aim by clicking"
toggle (or hold Shift) that picks a target by raycasting the viewport onto the wetted
interior, live readouts for where the stream lands and the impingement angle there
against the 30° criterion, and height/side sliders as the fallback. Picking suspends
`OrbitControls` while armed so the two gestures never fight.

Right panel gained **When it happens** (sustained versus weak flow, reading live from
`metrics.perPhase` with a trailing `*` for mid-run figures), and the Impingement section
now separates stream arrivals from re-impacting splash.

The report is structured as **VERDICT → WHEN IT HAPPENS → WHERE IT WENT → WHY → WHAT
WOULD HELP → DRAINAGE → SOLVER**. "What would help" is derived from the run's own numbers
rather than being generic advice. The previous version printed forty-odd quantities in
solver order with no comparison and no statement of what any of it implied, and its
headline was the all-generations impingement figure from Trap 20.
