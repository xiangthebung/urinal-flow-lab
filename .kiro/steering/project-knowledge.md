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
| `npm run validate` | 60 physics checks against published references. ~395 s. **Authoritative.** |
| `npm run shoot` | Screenshot the **running app** headlessly. See below. |
| `npm run render` | Offline render of the fixture **meshes only**. Fast, but not the product. |
| `npx tsx tools/fixture-lab.mts <id> [--full] [--out x.png]` | **Shape a fixture.** Merges `tools/tuned/<id>.json` over a preset, prints the admissibility metrics, writes a 4-view PNG. `--full` runs all four grid resolutions. |
| `npx tsx tools/thumbsheet.mts [--scale 3] [--out x.png]` | **Check the picker.** Contact sheet of all six thumbnails, rendered by calling `renderFixtureThumbnail` — the function the cards call — and composited on the panel's own background. Prints ink coverage and mean luminance per card. |

`fixture-lab` is the right tool for geometry work: no browser, a second per iteration,
and it prints the numbers that decide whether a shape is legal rather than only
showing you a picture. It reads an override file so several people (or several
subagents) can shape different fixtures without touching `presets.ts` or each other.

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

1. **`npm run validate` passing is not visual verification.** None of its 60 checks
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
8. **The picker's thumbnails are their own renderer, and it is not the viewport's.**
   The cards go through `softRaster`, the viewport goes through WebGL shaders. A defect
   in one is invisible in the other, and that asymmetry cost real time: the rasteriser
   was inventing horizontal stripes on every fixture while the viewport looked fine, so
   the stripes read as a geometry problem for a long while. `tools/thumbsheet.mts` calls
   the picker's own function, so what it writes is what the cards show.
9. **Diagnose a suspicious surface feature by hiding things, not by staring.**
   `--overlays shell=0` leaves the interior alone, which is how the "bright flap curling
   out of the bowl" was finally pinned on the casting's rim band rather than on the
   loft. Four wrong hypotheses were tried first, each of which looked right.

---

## Architecture

```
core/       vec3, rng, constants, fluid (FLUID_PRESETS, WALL_MATERIALS)
geometry/   profile   sagittal 2-D section (ProfileParams, buildProfile)
            surface   UrinalSurface — THE WETTED INTERIOR, structured (u,v) loft
            wrap      side-edge stand-off along the profile
            shell     exterior casting (ShellParams, buildShell -> ShellMesh)
            fittings  flush valve, supply pipe, outlet spud — SOLID, collidable
            collider  SolidCollider / MeshCollider / CompositeCollider
            presets   the 6-model fixture library
            bvh       ray/triangle acceleration
sim/        simulation  owns surface + casting + castingCollider; SimConfig
            stream, particles, impact, film, capture, metrics
render/     sceneView, fixtureView, dropletView, streamView, colormap
            softRaster  software rasteriser shared by thumbnails and tools/preview
ui/         app, controls, charts, thumbnail, automation
validation/ suite (60 checks), runCli
tools/      shoot.mts      headless screenshots of the running app
            thumbsheet.mts contact sheet of the picker's own thumbnails
            fixture-lab.mts shape bench: metrics + 4-view render, no browser
            preview.mts    offline render of the meshes
            png.mts        shared PNG encoder and blit
```

### Load-bearing contracts

- **`FixtureExtent` is the only correct answer to "where is the fixture".**
  `src/sim/extent.ts`, built from interior ∪ casting (`ceramic`) and again with the
  metalwork (`all`), and consumed by `CaptureScene`, the emitter, the room, the user
  figure, the zones and the camera. Everything used to derive its answer from
  `surface.bounds()`, which is the wetted patch and stops 0–44 mm short of the real
  front face. Two consequences, both real: the user stood `standoff` in front of the
  *interior*, so the control labelled "stand-off from fixture" over-reported the gap
  by up to a third in the optimistic direction; and the `FixtureExterior` capture
  plane, nominally 4 mm in front of the ceramic, sat *inside* the casting where
  nothing could reach it. `npm run shoot` prints `castingAheadOfCapture`, which is
  the residual — it now reads 0 mm on every model. Posture uses `ceramic`, because a
  person does not stand back from the flush valve; framing uses `all`, because a
  cropped flushometer is what makes a render look wrong.
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
- **The metalwork is solid too.** `src/geometry/fittings.ts` builds the flushometer,
  its supply pipe and the outlet spud, and `Simulation.castingCollider` is a
  `CompositeCollider` over casting + fittings. They stand above the bowl, closer to
  the user's aim than any ceramic, and a level stream hits the valve body. Anything
  visible that cannot be hit silently deletes liquid — that is the fault that made
  the casting an absorber, so do not demote them to scenery.
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

Four of them are now dimensioned against named real products, and the reference is
recorded in the preset's comment so it can be checked rather than trusted:

| preset | reference product | envelope W×D×H mm | published |
|---|---|---|---|
| `classic-bowl` | American Standard Washbrook 6501.010 wall-hung washout | 470×364×692 | 470×355×692 |
| `stall-urinal` | American Standard Stallbrook 6400.001 / Kohler Branham K-25039-T | 458×382×972 | 457×381×972 |
| `trough` | Pland Bruges TR1500P wall-hung stainless | 1491×317×550 | 1500 × 220–300 × 440–593 |
| `compact-waterless` | Falcon Waterfree F-4000 (= Sloan WES-1000 body) | 391×357×576 | 492×657×366 as W×H×D |

`flat-wall` is a deliberate control rather than a product, and `nautilus-tall` is
generated, so neither is dimensioned to a catalogue.

**The library is the North American commercial range, on purpose.** That decision used
to be implicit and was therefore made wrongly: US bowls carry integral privacy sides and
run wide (Washbrook 470×355, Lynbrook 470×356, Zurn Z5755-U 470×362, Kohler Bardon
457×359), while European bowls have no shields and run narrow (V&B Subway 285×315,
V&B O.novo 290×245, Duravit Starck 3 330×350, Geberit Selva 340×370). `classic-bowl` at
its old 358×388 was, by accident, a credible *European* bowl wearing an American spec
sheet's name. It has been re-dimensioned to the Washbrook it always claimed rather than
re-attributed, because the rest of the set is North American and because the wide
shielded bowl is the more interesting object here — those shields are enclosure, and
Trap 9 is the reason enclosure governs how much splash leaves sideways. A European range
would be a legitimate second library, not an entry in this one.

Worth knowing before adding a fixture: **rimless is now common** (Geberit Selva, both
Armitage Shanks models), which falsifies the "chunky rolled rim flange every real fixture
has" claim in the casting-style notes below. The library has no rimless entry.

The stall's front lip is a known, deliberate deviation. American Standard's *installation*
sheet calls for a pit so the lip sets flush with the finished floor, with the floor sloped
to drain into it — so a real full stall urinal's bowl opens at floor level, where the model
puts its front lip 340 mm up with solid casting below. That is a different fixture rather
than a tuning value: the front rise is most of this preset's enclosure and is entangled
with the envelope, so changing it in the same pass as the taper would have made it
impossible to say which change moved the splash.

Two per-preset fields carry things that genuinely differ by model:

- **`fittings?: Partial<FittingsParams>`** — `compact-waterless` sets
  `flushValve: false`, because a waterless urinal has no water supply at all and the
  absence of a flushometer *is* the product. The trough and the stall adjust
  `pipeRise` for their height.
- **`defaultAimV?: number`** — one global fraction cannot mean the same thing on a
  290 mm trough and a 974 mm stall. At the old shared 0.18 the stall was struck at
  **75°**, near normal incidence and the worst angle on the fixture, purely because
  the same fraction lands somewhere else on a fixture three times the height. Measured
  angle-vs-aim, the defaults are: classic-bowl 0.26 (55°), flat-wall 0.34 (33°),
  stall 0.50 (42°), trough 0.22 (52°), compact 0.26 (63°), nautilus 0.18 (25°).
  Two are worth knowing: the oval bowl is 55° *anywhere* from v = 0.10 to 0.38 — it is
  a uniformly steep target, which is the mechanism its `expectation` text describes —
  and the trough has so little wall that v = 0.30 already reads 80°.
  **`compact-waterless` is now 0.12, not 0.26** — 0.26 was inside the band its own
  casting blocks, so the preset could not be aimed into at its own default. See Trap 44,
  and re-check `traceAim().blocked` at every preset's default after any casting or
  posture change.

**`src/validation/suite.ts` hardcodes the ids `classic-bowl`, `flat-wall` and
`nautilus-tall`.** Renaming or removing them breaks the suite. `flat-wall` must keep a
*planar* back wall — the headline A/B claim depends on it meeting the stream near
normal incidence.

The headline A/B is now measured on **sustained flow only**
(`SplashbackReport.sustainedMicrolitresPerLitre`), not on the whole void. That is not a
convenience; see Trap 16.

`UrinalPreset.shell?: Partial<ShellParams>` gives each model its own exterior
character. That is the extension point for casting style.

**Casting style, from matching the American Standard reference photographs.** The
exterior is fitted as a support function over the interior (Trap 5, 6), so it
starts out as the interior's convex hull and the parameters pull it away from that.
Two of them decide whether the result looks like sanitaryware or like a cauldron:

- `sectionSmoothing` relaxes the fitted plan section toward a circle. At the old
  values of 5–7 the bowl came out a **round pod**, which is most of what "your
  urinals look bad" was about. Real washout urinals are squarish in plan: use 0–3.
- `bulge` adds mid-height fullness. Real fixtures are near-straight-sided; keep it
  at or near 0. It was 0.014–0.02.
- `bottomExtension` + `bottomTaper` make the nose below the bowl. A wall-hung bowl
  wants a long narrow nose (0.10 / 0.17); a stall urinal is a straight column to
  the floor, so it wants almost none (0.02 / 0.94).
- `rimThickness` ~0.022–0.026 with `rimBandWidth` ~0.03 gives the chunky rolled rim
  flange every real fixture has. It was 0.014, which read as a paper edge.

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
over 17 000× because its sustained figure is ~0; with the controls carrying their own
casting, seed 4242 reads 20.8× and 5260×). Any aggregate that mixes the phases is
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

**25. The notch is `wrapDepth − drainZ`, and that makes it tunable without touching
the wrap.** Discovered independently by three people shaping different fixtures, and
it is the most useful geometry fact on this project. The `u = ±1` side edge of the
opening bottoms out wherever the wrap fade has reached zero, which `wrap.ts` places
about 15 mm of arclength short of the sump low point — so the lowest point of the
opening's edge is the *profile's own depth at the drain*. Move the outlet forward and
the edge has less to dive back to. Measured, by doing only that plus the
`sumpFrontFraction` needed to unclamp it: classic-bowl 131–138 → 47–60 mm, stall
91–105 → 34–48 mm, compact-waterless 149–154 → 48–57 mm. All at 0 flipped normals and
0 degenerate cells, at every resolution. `drainZ` has a clamp ceiling of
`bowlDepth × sumpFrontFraction − 30 mm`, so raising one without the other silently does
nothing — that exact mistake cost a round trip here.

**26. `openMouth` equals `bowlDepth` identically. It is not a defect metric.**
`buildProfile` pins the rim centreline at `z = 0` for planar and concave back walls,
and the far end of the boundary loop is the lip tip at `z ≈ bowlDepth`, so the loop
must span the full depth. It reads 300/313/348/350/430 mm on the five non-generated
presets — exactly their bowl depths. No parameter moves it, and *deepening* a fixture
toward its real product dimension necessarily raises it. Do not treat a rising
openMouth as a regression, and do not spend time tuning it. The only lever is
`hoodDepth`, which throws the `v = 0` row forward — and that is a near-horizontal
surface at the point where the wrap is at maximum, i.e. the Trap 3 cancellation
mechanism with no fade protecting it. The notch (Trap 25) is the metric that actually
measures the defect.

**27. A test must not encode a dimension it does not own.** The "peeing on the fixture"
check pinned −30° elevation for "in the bowl" and 0° for "on the fixture". Those meant
what they said on a 526 mm body; on the reshaped 640 mm body with a 375 mm front rise,
−30° clips the front rim on the way in, so both cases became partly rim strikes and the
ratio collapsed from 7.2× to 1.5× **with no change to the physics at all**. It read as a
physics regression and was a stale constant. It now finds the elevation by scanning for
`traceAim().blocked` and asserts that it really is blocked, so it follows the geometry.
Related: how far onto the fixture you aim matters a lot — grazing the rim at −8° reads
1.3× the in-bowl figure, +16° reads 4.9×.

**23. The contact line applies at the boundary of the patch, not just between
cells.** `FilmSolver.substep` tested pinning only when the neighbour *existed and
was dry*; at `u = ±1` there is no neighbour, so no test ran and any film with
outward velocity poured over the rim however thin it was. Measured on the default
bowl: **57 mL of a 300 mL void ran off the side edges — 17.8% of everything that
landed** — and was released as tens of thousands of drips down the outside. On
screen it read as a permanent waterfall fed by a trickle, which is what prompted
"the fluid flow should be based on the amount". Applying `canAdvance` at the
boundary halved it to 8.4%. The remaining 8.4% has not been chased; it is
concentrated where the stream actually strikes, and may be legitimate.

**24. Anything that removes liquid must be added to the closure sum.**
`Metrics.escapedVolume` was declared, reset and *reported* — but never
incremented, and it was missing from `Simulation.report()`'s `accounted` total. So
every droplet thrown clear of the region of interest vanished unaccounted. Wholly
invisible while splash stayed inside the bowl, which is why it survived: closure
read 0.0000% for every ordinary case. Aim at the flush valve instead and splash
leaves the box, and the balance drifted to 0.0718%. Fixed by having `cullOutside`
return the volume it killed. There is a check for it; the lesson generalises — a
field that is reported but never written is worse than no field.

**22. Correlations have a range of validity; clamp to it.** The Cossali wetted-wall
threshold `2100 + 5880·δ^1.44` was fitted for `δ = h/d` up to order one and rises without
bound. Extrapolated into the sump it claimed deeper liquid is ever harder to splash — at
δ = 2 the critical K is already 18 000, effectively unsplashable — which is the opposite
of what a plunging jet does. Past ~1 diameter the mechanism becomes cavity collapse and a
Worthington jet and the threshold flattens. `WET_SPLASH_K_FILM_MAX_DELTA` holds δ at the
edge of the evidence.

**28. `softRaster` shades from vertex normals. Do not let it fall back to face
normals.** It ignored the vertex normals both meshes carry and lit every triangle flat.
That is not a cosmetic shortcut: the casting's exterior is fitted in height bands, so
flat shading drew each band as its own facet and all six fixtures wore horizontal
corduroy that is not on the object. Because the WebGL viewport was smooth, the stripes
read as a geometry fault for a long time. Two-sided — the normal is flipped toward the
eye — because the interior loft is a single sheet seen from inside the bowl and a
one-sided term drops half of every fixture into silhouette.

**29. The casting's envelope must be fitted per *edge*, not per vertex.** `buildShell`
binned each interior vertex into the nearest height band. Interior rows are uniform in
arclength, not in height, so wherever the profile is steep — the whole back wall —
consecutive rows are further apart in y than the bands are: bands between two rows got
nothing and were filled by copying a neighbour, bands that caught a row jumped out to
it, and the raw fit is used again as a floor under the smoothed one so no amount of
smoothing removed it. Now every grid edge raises every band it crosses, at the height
where it crosses. Two details are load-bearing. (a) An edge crossing *exactly one* band
is the common case, not a degenerate one — excluding it (`hi <= lo` instead of
`hi < lo`) makes the whole mechanism a near no-op, which is how this looked fixed while
the ribbing metric barely moved. (b) Vertices are spread into both bracketing bands only
where their column **turns back in height**; spreading every vertex guarantees
containment and reintroduces the ribbing as a ±2 mm alternation, because a vertex
part-way above a band line raises that band to its own reach. `ShellMesh.fit.protrusion`
is the check that the turning-point rule is sufficient, and `fit.ribbing` measures the
alternation. Both print in `fixture-lab`.

**30. Measure ribbing as *alternation*, not as the largest second difference.** A urinal
has real creases in it — the corner where a vertical wall meets the sump, the fast taper
of the bottom cap, the 68 mm step where the front lip ends. Those are single-signed and
belong there, and a max-second-difference metric is dominated by them: it read 36 mm on a
casting whose visible ribbing was gone. Taking the smaller of each consecutive pair of
opposite-signed second differences scores designed creases near zero.

**31. The patch's `u = ±1` boundary is not the rim of the opening.** It is the profile
swept out to the full half width, so it runs from the top of the back wall all the way
*down* through the sump and back up to the lip — on the default bowl it reaches
y = −28 mm at 21° off centre. Anything that treats the boundary loop as the mouth's edge
gets that point. Deriving the casting's top height from the lowest loop height per angle
pins the casting to the sump floor at that angle and the solid collapses to a point,
which renders as a large triangular blade sticking out of the front of the fixture. The
`v = 0` and `v = 1` rows *are* genuine top edges and are safe to use, but only where they
coincide with the outer wall — at θ = 0 the rim is 14 mm from the axis while the wall is
340 mm out, so flooring to boundary points regardless of radius drags the casting up to
rim height and paves the mouth over.

**32. The solid body's top follows the opening, angle by angle.** Not one height. A
constant top at the front-lip height is right at the front and nowhere else, and at the
sides it leaves a horizontal annulus over solid ceramic with no cavity to trim it
against — a 50 mm plate standing proud of the fixture like a collar on a plant pot, with
the thin back panel apparently balanced on it. The test per angle is: stand on the outer
wall at a height and look straight down; a hit a long way below means the wall is out
over the open mouth. Smooth the result hard (24 passes) — the raw test steps 115 mm over
one or two angular columns, and the strip capping the wall then twists into a flange.
Cap that strip at `rimThickness + clearance`, not at `wallThickness + clearance + 12 mm`:
where the top edge is climbing it is a near-vertical face, and 52 mm of it reads as a
flange.

**33. Facing backward is not the same as being at the back.** The thickness exemption in
`buildShell` keyed off the outward normal's −z component alone. The rim wraps forward to
275 mm at the sides, and those points still face backward and upward, so they were
granted the full 300 mm thickness cap 275 mm from the mounting plane — and the rim band,
whose width *is* that thickness, drew the result edge on: a pair of thin plates out of
the sides of the fixture like carrying handles. The exemption is about position, so it is
now gated on distance from the mounting plane as well.

**34. Cull the casting skin where *both* rows are below the cut, not either.** With
"either", the one row straddling the cut is emitted, and at the front that row is the
lip: the profile turns over there, so the row below the lip tip is already under the cut
while the tip is above it. The result is a free-standing ring of offset quads around the
lip that renders as a bright flap curling out of the bowl. The lip keeps its visible
edge from the rim band, which runs round the whole loop.

**35. A physically based metal with no environment renders black.** The flushometer is
`metalness: 0.92`, and a metal has no diffuse response — everything you see on chrome is
reflected surroundings. With two directional lights and no `scene.environment` it drew as
a black silhouette over a white fixture and looked like a hole in the scene. Lowering the
metalness fixes the symptom by making it not be metal; a PMREM'd `RoomEnvironment` fixes
the cause, and the glaze picks up a specular sheen from the same source. Do not remove it
without replacing it.

**36. Frame offline views by projecting the corners, not by scaling a dimension.**
`framedThreeQuarterView` used `1.68 ×` the largest box dimension. That is a guess loose
enough for the worst case and therefore far too loose for every other, and it ignores
both the frame's aspect ratio and which axis binds — the fixtures are portrait, so height
binds. They covered 11–16% of their cards. Projecting the eight corners and shrinking the
distance until they just fit took it to 16–26%, and it also stopped `compact-waterless`
being silently *cropped*, which the loose guess was doing in the other direction.

**38. A parcel is not a droplet once the secondary cap binds, and the energy guard
has to know that.** `emitSecondaries` clamps the count to `maxSecondaries` (10) to
bound cost, so each spawned parcel carries `splashVolume / count` and stands in for
however many droplets of diameter `dd` that makes. The kinetic-energy budget that
stops the model manufacturing splashback out of nothing was summing
`0.5 ρ (π/6 dd³) sp²` — the *nominal* droplet — so it under-counted the outgoing
energy by the parcel multiplicity and never bound. That multiplicity is largest
exactly when the impact is most violent, i.e. in the cases the guard exists for. The
surface-energy term had the same fault in the same direction, and the parent's area
was one sphere when the parent may be a whole wavelength of jet. All three are now
computed on the liquid that actually moves.

**39. Emission sub-stepping needs the accumulator, not its fractional part.**
`StreamEmitter.step` spread parcels back along the step by
`emitAccumulator − floor(emitAccumulator)`. Subtracting one does not change a
fractional part, so every parcel emitted in a step got the same offset: five parcels
in a millisecond left from one point with identical velocities and flew as a lump.
The comment said "so parcels do not stack on one point". The remaining accumulator
*is* the number of wavelengths still queued behind this one, so
`back = accumulator / emissionFrequency` is the parcel's real age.

**40. The roughness correction on the dry threshold could only ever lower it.**
`dryCriticalK * clamp(1/(1 + 900·Ra/d), 0.45, 1.6)`: `1/(1+x)` never exceeds 1, so
the 1.6 ceiling was unreachable and the doc's "a very smooth fired glaze raises it"
could not happen. Worse at the other end — a fired sanitary glaze at Ra = 0.3 µm read
45 against Mundo's smooth 57.7, a 21% cut for the surface that *is* the smooth
reference, and aged glaze hit the 0.45 floor at 26, below the published rough figure
of ~33. It now smoothsteps between `DRY_SPLASH_K_SMOOTH` and `DRY_SPLASH_K_ROUGH` on
Ra/d, so both ends land where the measurements are and the second constant is no
longer declared-and-unread.

> **Open, and the largest unresolved question in the model.** A later audit of the
> splash correlations found that **Mundo's 57.7 is the rough asymptote of Cossali's own
> dry correlation, not the smooth-glaze value this trap took it for.** If that reading is
> right, the fix above anchors the smooth end of the interpolation to a number that
> belongs at the rough end, and every splashback figure in the project moves with it —
> hardest on the casting exterior, which is where the largest absolute numbers are. It was
> deliberately left unchanged rather than fixed in the same pass that raised the suite to
> 60 checks, because changing it re-baselines every reference figure here at once and the
> change should be made on its own, with the seed and stand-off sweeps re-run. Resolve
> this before trusting any absolute µL/L number; the ratios are unaffected, which is one
> more reason every check in the suite is written as one. The related pinning is done:
> `constants.ts` claimed Cossali's K used Mundo's grouping, and it is that group raised to
> exactly 1.6, now asserted.

**41. Resolve a swept segment by distance, not by category.** `ParticleSystem.step`
tested the interior, then the casting, then the capture zones — so a droplet that
crossed a shin panel on its way to the fixture was booked to the fixture. Small at the
default posture and wrong at any posture where the legs reach in front of part of the
ceramic, which is what `legSetback` exists to vary. All three are now compared on `t`.

**42. The design score must not be built on the all-in splashback figure.** That is
Trap 16 restated: the all-in number reverses which of two fixtures is better across
the range of one posture slider, so a 0–100 figure a designer would rank by inherited
that instability wholesale. `scoreDesign` now takes the splash sub-score from
`sustainedMicrolitresPerLitre` — the part the fixture governs, stable across seeds —
and pushes the tail into a note, where it belongs, because no bowl shape addresses it.

**44. `compact-waterless` could not be aimed into, and nothing said so.** Its
`defaultAimV` was 0.26 and the comment beside it said "past v = 0.30 the casting blocks
the aim". Measured: the casting blocks everything past **v ≈ 0.15**, so the fixture's
own default aim was a rim strike — Trap 14's worst outcome, reported as the model's
nominal behaviour, on every run anyone ever did of that preset. It survived because the
reach readout raycast the interior alone (Trap 15) and answered "no wall" rather than
"the casting is in the way", so the HUD read `reach 0 cm` and the note went blank. Now
0.12, one sweep step clear of the boundary. The reachable band is 67° from end to end,
which is the real verdict on the shape and is outstanding item 5 — aim cannot fix a
fixture you cannot aim into. **Check `traceAim().blocked` at a preset's own
`defaultAimV` whenever the casting or the posture changes.**

**45. A tangential graze reports 0° and wins "best aim" outright.** Where the trace
catches the rim edge-on, `traceAim` returns `reached` with an impingement angle of
essentially zero, and the aim sweep then recommends it. Measured on the untouched
library: classic-bowl v = 0.49, flat-wall 0.62 and nautilus-tall 0.55 all read 0°, each
flanked on both sides by aims the casing blocks. It is the worst possible
recommendation — one sweep step either way puts the stream on the outside of the
fixture, and the model's own tremor is larger than that step. The sweep now marks any
reachable aim adjacent to a blocked one as grazing, lists it, and excludes it from the
recommendation.

**43. A control fixture must be simulated as the fixture it is.** The headline A/B in
`suite.ts` built `flat-wall` and `nautilus-tall` from `preset.params` alone and left
`casting` and `fittings` at the defaults, so the two controls wore the default bowl's
exterior and metalwork. Neither the app nor the picker shows those fixtures. The
casting is solid, it splashes, it hides 19–44% of the interior from the exit point,
and the metalwork stands closer to the user than any ceramic — so "same stream, same
seed, same aim" was controlling everything except the part of the fixture nearest the
user.

**37. A validation check must select geometry by something the geometry owns.** The
"peeing on the fixture" check scanned aim elevation in degrees and took the highest
blocked angle. That worked only while the casting had the Trap 32 collar for a level
stream to hit; on the corrected casting no elevation between +20° and −20° lands on the
ceramic at all — above −14° the stream strikes the flushometer over the rim, a 32 mm tube
that most of the flow goes past, and below it the stream enters the bowl. It failed at
2.96× against a 3× threshold with nothing wrong in the solver. It now walks
`aimTargetV`, which is a *fraction of the profile* and so means the same thing on every
fixture, and requires the hit to be at or below `casting.max.y`. This is the same lesson
as Trap 27, found again in the same check.

**46. Manufacturers do not agree on axis order, and many sheets print the triple
unlabelled.** American Standard and Sloan print D × W × H, Kohler prints H × W × D,
Falcon spells out W × H × D. A dimension copied from a catalogue without checking which
axis is which is a coin flip, and it does not look like an error afterwards, because all
three numbers are real dimensions of the real product. Two presets carried transposed
axes for the whole life of the project:

- `classic-bowl` claimed a Washbrook 6501 against a "356 × 356" nominal. The sheet says
  **470 W × 355 D**, and the 14 in on it is the *elongated rim from finished wall*, i.e.
  the projection — it had been copied into the width slot as well. The preset built
  W/D = 0.92 where the product is 1.32: **112 mm too narrow and 33 mm too deep, on the
  fixture every run opens on.**
- `compact-waterless` claimed a Sloan WES-1000, whose sheet prints 365 × 498 × 679 with
  no labels. Falcon publish the identical fixture as W × H × D 492 × 657 × 366, so 498 is
  the **width** and 366 the depth — it had been built **497 mm deep**. That single
  transposition is the whole of Trap 44: a bowl that deep stands its own rim so far
  forward that it shadows the wall behind it, which is exactly why the casting blocked
  every aim past v = 0.15. Rebuilt as a Falcon F-4000, it is aimable from v = 0.02 to 0.42.

The check that catches this is a *ratio*, not a dimension: a wall-hung bowl is wider than
it is deep, and W/D under 1 should have been read as a contradiction of the "extended
sides for privacy" bullet on the same sheet. Cross-check every triple against a second
manufacturer publishing the same fixture, and prefer sheets that label their axes.

**47. `bowlDepth` is measured from the profile datum, not the finished wall.**
`backSetback` puts the back face ~45 mm behind the datum and the casting adds ~43 mm of
skin, so **projection from the wall is `bowlDepth + ~88 mm`**. A published projection
dropped straight into `bowlDepth` overshoots by that much. This cost a round trip: the
stall was diagnosed as needing `bowlDepth` 0.294 → 0.381 to match a published 381 mm base
projection, and the existing 0.294 was **already giving 382 mm and was right to a
millimetre**; 0.381 would have made it 463 mm, deeper than any stall urinal made. The
defect was at the *other end* — 277 mm of projection at the top against a published 203 —
and the lever was `wrapDepth`. Measure the silhouette before changing a depth.

**48. A `W × D × H` envelope cannot express a taper, which is how a wrong one survives.**
Every stall urinal in production slopes: American Standard Stallbrook 381 mm at the base
to 203 at the top, Kohler Branham 414 to 205. American Standard's own name for the
product is a "sloping front stall urinal" — the taper *is* the silhouette. The preset was
a straight-sided column at a constant 294 mm and its comment recorded a correct-looking
"458 × 382 × 974", because the envelope numbers a bounding box reports are the extremes
and both extremes were right. `tools/silhouette.mts` prints projection against height,
which is the measurement that can see this.

**49. Grid quality alone cannot see an envelope error.** While closing the interior into
a basin, `MAX_WALL_SLOPE` was chosen as 2 because it minimised flipped normals — and at
that value the steepness floor becomes the binding term everywhere and the oval bowl came
out **736 mm wide against 422, with a spotless grid at every resolution**. Flipped
normals, degenerate cells and skew are all *local* measures; none of them can tell you
the object is the wrong size. Any tuning decision made on grid metrics must have the
envelope checked alongside it. (The admissible band was 14–50; 25 is the value.)

**50. A model can be computed, validated, rendered — and never emitted.** Satellite
droplets had a size law, a `satelliteFraction` parameter, a validation check and a
dedicated pale-blue style in `dropletView.ts` that could never appear. **Zero particles
carried the satellite flag over a full run**, and `satelliteFraction` did nothing but
mis-size the parent drop. It is now 6.00% of the void against a stated 0.06. The lesson
generalises past this one bug: a quantity being present in the parameters, in the tests
and in the renderer is not evidence that it is present in the simulation. Assert on a
*count* of the thing having happened, which is also how Trap 38's inert energy guard was
finally caught — 21 853 splash events and zero clampings.

**51. A law tested only against itself is untested.** The droplet drag law's only checks
were self-consistent — they evaluated the law and compared it with the law. Against Gunn
& Kinzer's 1949 terminal-velocity measurements it was **22.0% out at 5 mm**, and
substituting Clift & Gauvin alone made it **worse** (30.6%); it needs Liu–Reitz
deformation to reach 6.5%, because a 5 mm drop is not a sphere. Two errors had been
cancelling: a flat C_d = 0.44 above Re = 1000 was 9–14% high where those drops sit, and
rigid-sphere was ~25% low. **Every correlation in this model needs at least one check
against an external measurement**, not against its own output. The same audit found the
jet-breakup dispersion relation had no aerodynamic term at all and hard-returned zero
above the Plateau limit, so breakup length rose linearly with speed for ever — a 3 mm jet
at 30 m/s was claimed coherent for **2.08 m**. Real jets rise, peak, then break up
*sooner*. Invisible at the default posture, where the gas Weber number is 0.63.

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

`npm run validate` → **60/60** (~395 s). `npm run build` clean. The count rose from 46
when the solver audit added 14 checks, and three existing tolerances were *tightened* from
3%/3%/2% to 1% at the same time, because the corrected jet-breakup wavenumber lands closer
to Rayleigh's published 0.697 than the old one did. `tools/labsheet.mts` reports all six
presets clean at all four grid resolutions.

> **The absolute µL/L figures below moved on 2026-08-08** and the older ones are kept
> only for the shape of the argument. Three changes account for it, all of them making
> the geometry more like the product: the emitter sits `standoff` from the *ceramic*
> rather than from the wetted interior (`FixtureExtent`, 0–44 mm nearer than before),
> the dry-splash threshold for a smooth glaze is the published 57.7 instead of an
> effective 45, and the A/B controls carry their own casting and metalwork. Ratios are
> what to trust; every check in the suite is written as one for that reason.

Peeing *on* the fixture rather than into it, oval bowl, 150 mL, seed 4242, 48×96, and
the check now walks `aimTargetV` to find the first target the casting blocks (Trap 37).
Into the bowl at the preset's own default aim (v = 0.26, 56° on the interior):
**7908 µL/L**. Onto the casting at v = 0.45, which the trace reports blocked 397 mm
above the datum: **119 790 µL/L**, 15.1×. Before this pass the same two cases read 5668
and 98 559 (17.4×), and before Trap 24 the second one did not close.

The earlier walk forward from a *deeper* strike, for the shape of it: at v = 0.50 →
291 446, 0.55 → 247 669, 0.60 → 54 795, 0.65 → 20 053, 0.70 → 8925. The penalty is
enormous but falls away fast, because past the front rim the stream starts clearing the
fixture again. Closure stays 0.0000% in all of them.

Aiming by raw elevation instead reaches the **metalwork**, not the ceramic — see Trap 37.
For the record, at 150 mL/seed 4242: +14° gives 56 634 µL/L (8.5×) and +20° gives
19 788 (3.0×), both on the flush valve; −14° grazes the top of the casting at 7717 (1.2×);
−16° and below enter the bowl.

Splashback reference points, oval bowl, default posture, 300 mL void, seed 12345:
aim v = 0.18 gives 3234 µL/L all-in — 1222 µL/L during sustained flow against
12 529 µL/L during the rise and tail. Aim v = 0.55, which puts the stream on the front
rim, gives 24 715 µL/L and is the worst aim available. All four figures were unavailable
before this pass: the tail split did not exist and the rim strike reported zero.

Fixture envelopes and the notch, after the reshape. All six are 0 flipped normals,
0 degenerate cells, no self-intersection and no clamped parameters at 48×96, 56×104,
72×132 and 112×200:

| preset | W×D×H mm | notch | openMouth | protrude | ribbing |
|---|---|---|---|---|---|
| classic-bowl | 470×364×692 | 60 mm | 329 mm | 0.0 mm | 0.7–2.2 mm |
| flat-wall | 392×371×548 | 52 mm | 300 mm | 0.0 mm | 39.9–40.3 mm |
| stall-urinal | 458×382×974 | 0 mm | 313 mm | 0.0 mm | 22.4–23.0 mm |
| trough | 1491×317×550 | 18 mm | 250 mm | 0.0 mm | 105.0 mm |
| compact-waterless | 391×357×576 | 23 mm | 320 mm | 1.4–1.8 mm | 58.6–60.3 mm |
| nautilus-tall | 365×526×627 | 299–301 mm | 299–301 mm | 1.1 mm | 0.6–0.8 mm |

Four of the six now fit their casting exactly (`protrude` 0.0 mm), against 0–95 mm before,
and `classic-bowl`'s ribbing fell from 5.6–17.4 mm to under 2.2. Two shared-code fixes did
most of that. The casting section is now fitted in a plan frame **normalised by
elongation** — a polar fit about `x = 0` is only an even sampling of a body about as wide
as it is deep, and on the old 1.49 m trough the fitted radius peaked at 810 mm at 65° and
fell to 745 at 90°, crowding the whole length into a few angular bins and drawing the
V-notches at the end caps. It is clamped at 1, so it is exactly the identity for the five
compact presets, verified unchanged to the digit. And the **sump floor was missing from
the fit**: Trap 29 spreads a vertex into both bracketing bands only where its column turns
in height, on the argument that a monotone run is covered by its edges — but that fails on
a run that is *flat*, where no edge crosses a band line either. Protrusion had been
tracking sump slope almost monotonically across the library.

The trough's remaining 105 mm of ribbing is down from 228 and is the same structural
limit: it is 1.49 m wide and the envelope is still a polar `radius(y, θ)`.

`protrude` and `ribbing` are the two casting-fit numbers `fixture-lab` prints; see
Traps 29 and 30 for what they mean and why the ribbing one counts alternation. `nautilus`
is the reference for "clean": 0.8 mm. The residue on the others is concentrated at one
place each and is diagnosed, not mysterious — `fixture-lab` prints the height and
direction. classic-bowl 380 mm / −26°, flat-wall 302 mm / −23°, stall 308 mm / −26° and
compact 421 mm / +15° are all the **front-lip step**, where the support function has a
genuine ~68 mm discontinuity and the smoothing plus the raw floor ring around it. The
trough's 228 mm at 122 mm / −60° is different and structural: it is 1.49 m wide and the
envelope is a polar `radius(y, θ)` about `x = 0`, which is the wrong parameterisation for
something that elongated. Both are visible in the render only as a faint crease; neither
is the corduroy that used to be there.

`nautilus-tall` is the only one still carrying a large notch, and outstanding item 0
explains why it is structural rather than untuned. ADA reference points: rim 430 mm max
above floor, depth 345 mm minimum from
the outer rim face to the wall. Only `classic-bowl` and `trough` currently meet the
depth minimum; the stall is the non-accessible tall variant by design.

**One physics-relevant consequence of the reshape:** `classic-bowl` now has a broad
washout floor with the outlet forward of centre (`widthSump` 0.14 → 0.185, `drainZ`
0.10 → 0.232), which is correct for the reference product but is a materially
different drainage geometry. Its residual volume and clear time moved with it. The
suite's standing-pool checks use `defaultSurfaceParams()` rather than this preset, so
they are unaffected — but if that ever changes, Trap 12 applies.

---

## Outstanding work, in priority order

**0. The opening is not a mouth (low now — addressed on all six, one model excepted).**

Fixed across the library *without* touching the wrap law, using Traps 25 and 3
together. Five of six are now 0–60 mm, against 90–368 before:

| preset | before | after | what did it |
|---|---|---|---|
| classic-bowl | 131–138 | 47–60 | `drainZ` forward (Trap 25) |
| flat-wall | 103–112 | 52 | `wrapDecay` 1.0 → 0.6 |
| stall-urinal | 91–105 | 34–48 | `drainZ` forward |
| trough | 0 | 0 | already `backWallTilt` |
| compact-waterless | 149–154 | 48–57 | `drainZ` forward |
| nautilus-tall | 356–368 | **299–301** | `wrapDecay` 1.15 → 0.95, and stuck there |

Which lever works depends on the back wall, and this is the useful generalisation:

- **Curved or tilted back wall** → `drainZ` forward (Trap 25). The profile is already
  moving forward, so raising its depth at the sump lifts the whole side edge.
- **Dead vertical wall** (`flat-wall`) → `drainZ` barely helps, because the profile is
  at `z = 0` for the entire height, so the minimum falls on the *wall* rather than at
  the sump. `wrapDecay` is the lever: hold the wrap open further down. Took it 103 → 52
  where `drainZ` alone had only reached 79.
- **Generated wall** (`nautilus-tall`) → neither works well, and it is the one genuine
  remaining case. `buildProfile` pins the constant-angle wall foot at
  `z = min(maxWallRun/2, 0.02)` — **a hardcoded 0.02 that no preset value can lift** —
  so the wall always returns to the mounting plane at the throat and the side edge
  spans the full depth regardless (`notch == openMouth` exactly, on this model alone).
  `drainZ` moved it 356 → 344. `wrapDecay` 0.95 reaches 300 and is where it stops:
  0.85 reaches 290, and **0.6 reaches 282 but grows 26 degenerate cells at 72×132 and
  153 at 112×200 while staying perfectly clean at 48×96 and 56×104** — Trap 3, hiding
  from anyone who does not run every resolution. Lifting that hardcoded foot cap is the
  only thing left, and it is a change to the generator, not a tuning value.

Any further work here must beat the current baseline — **0 flipped normals and 0
degenerate cells on all six presets at every resolution from 48×96 to 112×200** — and
must re-run the seed and stand-off sweeps, because enclosure is what stops splash
leaving and the A/B claim rests on it. It survived this pass: 46/46 with both control
fixtures reshaped.

The `u = ±1` boundary of the loft *is* the rim of the opening. It should be a
nearly planar, roughly vertical oval facing the user. It is not. The side edge
stands `wrapDepth` forward at the rim, then the wrap fades to zero before the sump
(which Trap 3 requires), so the edge **dives back almost to the mounting plane at
throat height** and comes forward again up the front rise. The opening is therefore
a twisted loop spanning the full depth of the bowl, and the fixture renders as a
scroll or a scoop with a slot cut in its side rather than as a bowl with a mouth.

Measured with `tools/diag-grid.mts` (recreate it; it also prints the Trap 3 quality
metrics), backward excursion of the side edge and z-spread of the whole boundary
loop:

| preset | notch | opening z-spread |
|---|---|---|
| classic-bowl | 131–138 mm | 280 mm |
| flat-wall | 103–112 mm | 300 mm |
| stall-urinal | 91–105 mm | 320 mm |
| trough | 0 mm | 260 mm |
| compact-waterless | 149–154 mm | 310 mm |
| nautilus-tall | 356–368 mm | 356–368 mm |

A real fixture's mouth spreads maybe 40–60 mm in z. `trough` scores 0 on the notch
only because its `wrapDepth` is 0.05, i.e. it barely wraps at all.

The obvious law — side edge on the front plane, `wrap(v) = frontPlane −
profile.z(v)` — is exactly the case Trap 3 says collapses cells across the
horizontal sump floor, so it must be measured, not assumed. Baseline to beat, at
every resolution from 48×96 to 112×200 and on all six presets: **0 flipped normals,
0 degenerate cells.** Re-run the seed sweep and the stand-off sweep afterwards too,
because enclosure is what stops splash leaving and the A/B claim rests on it.

**1. `FixtureExtent` — done.** `src/sim/extent.ts`; see the load-bearing contract
above. `castingAheadOfCapture` now reads 0 mm on every model. One consequence worth
knowing: the constant-angle generator's two-pass alignment now measures the front face
off the *ceramic*, so each pass costs a casting build. That is deliberate — aligning
the generator to a user standing 0–44 mm further forward than the one the simulation
then places is the exact mistake the alignment code exists to prevent.

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

**3b. The picker's card caption measures the ceramic, not the plumbing (done).** It
used to be read off the same box the view is framed on, which includes the flushometer
and its supply pipe — so the cards advertised the oval bowl as 878 mm tall against a
catalogue 640, and the trough as 796 against 290. `ThumbnailResult.dims` now comes from
interior ∪ casting while the frame still holds the metalwork. `tools/thumbsheet.mts`
prints the captions, and they now match the envelope table above exactly.

**4. Hardcoded constants (medium).** `BANDS` (112), `ABINS` (49), `BODY_A` (44),
`BODY_V` (96) in `shell.ts` are module constants, not parameters. They were 56/33/34/56
and were raised because they are a *sampling rate* on a bilinearly interpolated table, so
the casting carries a crease at every band and bin; at 56 bands over a 640 mm fixture
those creases are 11 mm apart, which is visible. Cost is O(BANDS × ABINS²) once per
rebuild, a few hundred thousand operations, so there is no reason to be frugal. Inline
magic numbers there too: `0.7 / convexity` curvature cap, `1.004` push-out, `0.0025`
march step, `smoothstep(0.35, 0.85)` for backness, the 24 smoothing passes on `topY`.
`THUMB_RES` in `ui/thumbnail.ts`; card size in `app.ts`, which `tools/thumbsheet.mts`
duplicates and must be kept in step with.

**5. Per-model shape work — done.** All four catalogue presets are now their reference
product, and the two that were not turned out to be Trap 46 rather than tuning:
`compact-waterless` was 497 mm *deep* because 498 was the width, and is now a Falcon
F-4000 at 391 × 357 × 576 that can be aimed into across v = 0.02–0.42 instead of being
blocked past 0.15. `trough` was the wrong *kind* of object rather than the wrong size —
290 mm tall and 419 deep, where every trough in production is tall and shallow because
the back panel is the splashback and the gutter only collects — and is now a Pland Bruges
TR1500P, **sparged along its length** rather than flushed from a single valve over the
middle. Its V-notches went with the elongation-normalised section fit. `stall-urinal`
gained the sloping front its reference advertises (Trap 48).

What remains here is smaller and named: the trough's 105 mm of ribbing is the polar
envelope's structural limit at 1.49 m of width, and the stall's front lip belongs at
floor level rather than 340 mm up — deliberately deferred, because the front rise is most
of that preset's enclosure and moving it in the same pass as the taper would confound
which change moved the splash.

**6. Interior side-wall seam artifact (low).** Visible in three-quarter shots of
`classic-bowl`. Not diagnosed. Related and larger: with `--overlays shell=0` the interior
is visibly a *saddle*, not a basin — the loft's half width narrows at the sump, so the
`u = ±1` edges pinch in and the bowl has no side walls in its front half. The casting
hides it, and Trap 9 is the splash consequence, but it is the reason the interior alone
does not look like a bowl. Closing it needs a closed ring per height instead of a strip
per profile station, which is the `FixtureGeometry` work in item 3.

**7. `shell.ts` structural assumptions (low, but blocks imports).** It assumes symmetry
about `x = 0`, a flat wall-mounted back plane, exactly one forward-facing opening above
one front lip, and a convex section. A corner unit, a floor-standing pedestal, an
asymmetric model or a two-opening model breaks it.

---

## UI

Two rounds of reduction. First the ~40 geometry sliders became a six-card fixture picker
with real rendered thumbnails (`src/ui/thumbnail.ts`, painted one per idle tick, ~40 ms
each). Then the remaining panel — 24 controls opening flat, with no indication which
three mattered — was cut to **5 sliders visible by default** out of 21 present.

The picker's cards are **square** (126 × 126), not 4:3. Every fixture is taller than it is
wide — the stall is 2.7× — and the thumbnail is framed to the card, so a landscape card
spends its area on background either side and shrinks the object to fit the short axis.
Square costs three rows of picker height and buys about a third more drawn fixture. The
thumbnails include the metalwork, because a flushometer is most of what makes a urinal
recognisable at 126 px — and because its *absence* is recognisable too: `compact-waterless`
sets `fittings.flushValve = false`, which reads instantly next to five that have one.

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
was previously two abstract numbers buried among twenty. It has live readouts for where
the stream lands and the impingement angle there against the 30° criterion, plus
height/side sliders.

**Aim is a click, not a mode.** A plain click on the fixture sets it; a drag orbits;
the two are told apart by whether the pointer moved more than 5 px, which is what
every 3-D tool does. It used to be a latch — arm "Aim by clicking", click, then
remember to disarm or it kept swallowing the orbit gesture — which is three actions
for the most-used control in the tool. Shift-drag paints aim continuously and
Shift+arrows nudge it; `A` still gives a sticky mode for anyone who wants one.

### Keyboard

There was none, which for a tool whose main verb is "watch this run" meant a mouse
trip to the bottom of the window every time. `Space` play/pause · `R` restart ·
`S`/`.` step 0.1 s · `,` step 0.01 s · `[` `]` speed · `1`–`8` surface view · `C`
cycle camera · `A` sticky aim · `Shift`+arrows nudge aim · `Esc` cancel · `?` the
list, which is also the `?` button on the viewport.

Two details keep it from being a nuisance, and both are load-bearing: keys are ignored
while focus is in an input, select or textarea, so the arrow keys still drive whichever
slider is held; and `Space` is swallowed rather than allowed through, because the
browser's default is to scroll the panel *and* re-trigger the last clicked button.

Camera presets are buttons on the right edge of the viewport, not inside the collapsed
`View` section — they were two clicks and a scroll for something used constantly. The
four corners of the stage are taken (tabs, HUD, legend, warning note), which is why
they sit centred on the right edge; a bottom bar landed on top of the note.

The aim sweep is **debounced by 130 ms**. It solves and traces thirteen aim points and
was running synchronously on every aim tick, including every mouse-move while
painting — that was the lag. `refreshViews()` flushes any pending sweep so automation
never photographs a half-updated panel.

Right panel gained **When it happens** (sustained versus weak flow, reading live from
`metrics.perPhase` with a trailing `*` for mid-run figures), and the Impingement section
now separates stream arrivals from re-impacting splash.

The report is structured as **VERDICT → WHEN IT HAPPENS → WHERE IT WENT → WHY → WHAT
WOULD HELP → DRAINAGE → SOLVER**. "What would help" is derived from the run's own numbers
rather than being generic advice. The previous version printed forty-odd quantities in
solver order with no comparison and no statement of what any of it implied, and its
headline was the all-generations impingement figure from Trap 20.

### The results panel reads live

Nineteen readouts across Splashback, Impingement and Drainage used to print a literal
em-dash until a full analysis had been run, so the right-hand panel spent every
playback looking broken while the simulation underneath it held every one of those
numbers. They now read from the running metrics and switch to the finished report when
there is one, with a trailing `*` marking a mid-run figure — the convention the
headline already used. Three of the sources walk the whole film grid and
`actualImpingement` sorts two arrays as long as it, so each is computed once per
simulated instant and shared: it was being called four times per repaint at 8 Hz.

**A per-litre figure needs a denominator.** µL/L against the few millilitres voided in
the first second reads as tens of thousands, so the most prominent number in the tool
opened every run announcing a catastrophe in the band its own report calls "the user is
being sprayed". Below a tenth of the void, the absolute volume is shown instead. Same
guard on the two per-phase figures and the tail ratio.

**The overlay note is one element and had two writers.** The geometry warning
("profile self-intersects — not manufacturable") was written by
`refreshGeometryDependent`, and the jet-coherence hint by `updateHud` at ~8 Hz, into
the same node. The warning was overwritten within a frame of appearing and was in
practice unreachable. There is now one writer, `updateOverlayNote`, with a priority
order: geometry invalid → aim strikes the casing → stream falling short → coherent at
the wall → broken up before it. The middle two are new and both matter: an aim on the
casing is the worst outcome available, and "falling short" is the tail mechanism of
Trap 17, which the note went *blank* for because the old reach test used peak exit
speed and so always found a wall in front of it.

**The reach readout goes through `traceAim`** — Trap 15 in a place the original fix
missed. `App.distanceToWall` raycast the interior alone, so it reported a distance to a
point the liquid could never reach and returned 0, i.e. "no wall at all", for exactly
the aims stopped dead by the front rim. It is now arc length along the traced path,
casting and metalwork included.

**"Aim height" was named for the opposite of what it does.** `v` walks *down* the
profile from the rim, so dragging the slider right lowered the impact point. Renamed
"Aim down the wall"; the readouts above it already give the landing point in mm above
the floor, which is the answer anyone actually wants.

**The legend is for decoding a colour scale.** The two appearance-only views have none,
so it drew a permanent paragraph over the default view restating the tab highlighted a
few centimetres away. The prose moved onto the tabs as tooltips, where it is readable
*before* you switch; `.legend:empty` hides the panel.

**The camera frames by projecting the eight corners**, the same fix Trap 36 made for
the offline renderer, and per preset direction. It fitted the bounding *sphere* and
then multiplied by a 0.62 fill factor, which never crops and is loose by the ratio
between a box and the sphere around it — the fixtures covered about a fifth of the
viewport. It matters most on the trough: 1.49 m wide and 0.29 m tall, so the distance
that frames it from the front is nowhere near the one that frames it from the side.
