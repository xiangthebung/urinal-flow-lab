import * as THREE from 'three';
import { CRITICAL_IMPINGEMENT_ANGLE, FILM_DRY_THICKNESS } from '../core/constants';
import { FittingsMesh } from '../geometry/fittings';
import { ShellMesh } from '../geometry/shell';
import { UrinalSurface } from '../geometry/surface';
import { FilmSolver } from '../sim/film';
import { capillaryLength } from '../core/fluid';
import { Metrics } from '../sim/metrics';
import { COLORMAP_GLSL, ColorScale } from './colormap';
import { FILM_GLSL, FilmField } from './filmField';

/**
 * The fixture, the liquid clinging to it, and whichever data field is being
 * inspected.
 *
 * The liquid is the part that needed the most care. A wall film during use is a
 * few tens of microns thick -- the solver puts the median around 30 to 80 um --
 * and there is no way to draw a thickness that small as a thickness. Drawn on a
 * millimetre colour scale it sits in the bottom two percent and reads as black,
 * which makes a perfectly good simulation look like nothing is happening.
 *
 * So the film is rendered the way a thin film actually presents itself: not as a
 * measurable depth but as wetness. Glaze that is wet goes darker and much glossier,
 * the free surface of the film tilts the reflection wherever the thickness varies,
 * and standing liquid picks up a tint with depth. That makes 40 um visible for the
 * same reason a damp patch on a pavement is visible, while the millimetre-scale
 * pooling in the sump still reads as an obvious pool.
 */

export const enum FieldMode {
  /** Realistic: ceramic plus liquid, no data overlay. */
  Liquid = 'liquid',
  Impingement = 'impingement',
  FilmThickness = 'film',
  FilmSpeed = 'filmSpeed',
  Residence = 'residence',
  ImpactVolume = 'impact',
  SplashOrigin = 'splash',
  /** Dry ceramic, no liquid and no data. Geometry inspection only. */
  Dry = 'dry',
}

export interface FieldInfo {
  label: string;
  unit: string;
  scale: ColorScale;
  /** Colour scale bounds, in display units. */
  min: number;
  max: number;
  /** Where the criterion sits, in display units. NaN if none. */
  critical: number;
  /** Multiplier from SI to display units. */
  toDisplay: number;
  /** True if the scale is logarithmic. */
  log: boolean;
  description: string;
}

const SENTINEL = -1e9;

/**
 * A colour written the way a designer picks one -- as an sRGB triple -- and held
 * the way the shader needs it, in linear light.
 *
 * `new THREE.Color(r, g, b)` stores its arguments in the working colour space,
 * which is linear, so a value chosen by eye off a screen arrives 2.2 gammas too
 * dark. Every constant colour in this file was picked by eye.
 */
const srgb = (r: number, g: number, b: number): THREE.Color =>
  new THREE.Color().setRGB(r, g, b, THREE.SRGBColorSpace);

export class FixtureView {
  readonly group = new THREE.Group();
  private geometry!: THREE.BufferGeometry;
  private material!: THREE.ShaderMaterial;
  private mesh!: THREE.Mesh;
  private wire!: THREE.LineSegments;
  private surface!: UrinalSurface;
  private drainRing!: THREE.Line;
  /** The exterior casting. Cosmetic, and never carries a data overlay. */
  private shellMesh: THREE.Mesh | null = null;
  private shellMaterial: THREE.MeshStandardMaterial;
  /** Flush valve, pipe and spud. Chrome, never a data surface. */
  private fittingsMesh: THREE.Mesh | null = null;
  private chromeMaterial: THREE.MeshStandardMaterial;

  /**
   * The one channel still carried per vertex: whichever data field is on display.
   *
   * The liquid used to be here too -- thickness, surface relief, speed, contact
   * line and concentration, five channels scattered onto the vertices every frame
   * -- and moving it into `filmField` is most of this file's change. A data
   * overlay is a piecewise-constant readout of a cell value and looking like one
   * is honest; liquid is a continuous surface and looking like a mesh is not.
   */
  private field!: Float32Array;
  /** Solver film state as a texture, reconstructed per pixel by the shader. */
  private filmField = new FilmField();
  // Scatter scratch.
  private counts!: Uint16Array;
  private cellScratch!: Float64Array;

  mode: FieldMode = FieldMode.Liquid;
  info: FieldInfo = FixtureView.infoFor(FieldMode.Liquid, 0, 1);
  /**
   * Exaggeration on the film's surface relief.
   *
   * Not a taste dial: it stands in for structure the grid cannot hold. The cells
   * here are 3.7 to 55 mm across and a rivulet is two capillary lengths wide --
   * about 4.7 mm for urine on glaze -- so every rivulet in a real running film is
   * sub-grid, and the solver can only report the smooth average of several of
   * them. That average tilts its surface by well under a degree, while the
   * rivulets it is averaging tilt by ten or twelve: a rivulet 4.7 mm wide and half
   * a millimetre deep has flanks at atan(0.5 / 2.35), which is 12 degrees.
   *
   * Twelve degrees is the difference between a surface that catches the ceiling
   * lights and one that does not, and catching them is the whole of how a wet
   * surface announces itself. At the old gain of 12 the rendered tilt was under
   * four degrees, the reflection never moved, and the film could only be seen
   * through a diffuse darkening -- which is what a wetted *absorbent* surface
   * looks like. The gain is set so that a typical film gradient reaches the tilt
   * of the rivulets it is standing for, and `maxTilt` in the shader caps it there.
   *
   * It changes no physics; nothing reads it but the fragment shader.
   */
  reliefGain = 60;
  /** Master strength of the liquid appearance, 0 disables it. */
  liquidStrength = 1;

  constructor() {
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uFieldMin: { value: 0 },
        uFieldMax: { value: 1 },
        uFieldLog: { value: 0 },
        uScale: { value: 1 },
        uCriticalT: { value: 0.5 },
        uUseField: { value: 0 },
        uLiquid: { value: 1 },
        uRelief: { value: 12 },
        uTime: { value: 0 },
        /** Thickness at which glaze starts to read wet, m. The solver's own. */
        uWetOnset: { value: FILM_DRY_THICKNESS },
        // Authored in sRGB and stored linear, because the shader now works in
        // linear light and encodes once at the end -- the same pipeline the
        // casting's MeshStandardMaterial uses. The old shader wrote its working
        // values straight to an sRGB framebuffer with no encode, which is a
        // second reason the two halves of one ceramic object never matched in
        // level however the lighting was adjusted.
        uShadowColor: { value: srgb(0.34, 0.35, 0.38) },
        uBase: { value: srgb(0.895, 0.905, 0.925) },
        // Transmittance of a `uTintDepth` layer of the working fluid. Set from
        // FluidProperties.tint every frame; this is only the initial value.
        uLiquidTint: { value: new THREE.Color(0.88, 0.83, 0.5) },
        /** Depth at which uLiquidTint is the exact transmittance, m. */
        uTintDepth: { value: 1.5e-3 },
        /** Capillary length of the working fluid, m. Sets the rivulet scale. */
        uCapillary: { value: 2.34e-3 },
        // The scene's own three lights, so the interior is lit by the same rig as
        // the casting instead of by a private one that only resembled it.
        uLightA: { value: new THREE.Vector3(1.2, 2.4, 1.6).normalize() },
        uLightB: { value: new THREE.Vector3(-1.4, 0.9, 1.4).normalize() },
        uKeyColor: { value: srgb(1, 1, 1).multiplyScalar(1.1) },
        uFillColor: { value: srgb(0.624, 0.776, 1).multiplyScalar(0.45) },
        uAmbient: { value: srgb(1, 1, 1).multiplyScalar(0.45) },
        // The washroom, as a cube map, for the interior to reflect. Supplied by
        // SceneView from the same RoomEnvironment the casting and the chrome
        // reflect. Without one there is nothing for wet glaze to mirror, and a
        // mirror is the cue the eye uses.
        uEnv: { value: null as THREE.CubeTexture | null },
        uHasEnv: { value: 0 },
        uEnvIntensity: { value: 0.55 },
        uEnvMaxLod: { value: 8 },
        /** Roughness of dry fired glaze. Wet, the reflecting interface is water. */
        uDryRoughness: { value: 0.22 },
        // The film, as a grid rather than as vertex attributes. See filmField.ts.
        uFilm: { value: null as THREE.DataTexture | null },
        uFilmSize: { value: new THREE.Vector2(1, 1) },
        /**
         * Downhill, in world space, for the flow direction where the film has
         * stopped moving and its own velocity says nothing. A constant: the
         * fixture group is never transformed, so world down is fixture down.
         */
        uGravity: { value: new THREE.Vector3(0, -1, 0) },
      },
      vertexShader: /* glsl */ `
        attribute float aField;
        attribute vec2 aUv;
        attribute vec3 aTanU;
        attribute vec3 aTanV;
        varying float vField;
        varying vec2 vUv;
        varying vec3 vTanU;
        varying vec3 vTanV;
        varying vec3 vNormal;
        varying vec3 vView;
        varying vec3 vWorld;
        void main() {
          vField = aField;
          vUv = aUv;
          // World tangents divided by the cell size they span, so the fragment
          // shader can turn a derivative in cell-index units straight into a
          // world-space gradient. Carrying the division here rather than a cell
          // size separately means the two can never be paired up wrongly, and the
          // grid is graded -- cells run from 3.7 to 55 mm across -- so a single
          // scalar would have been wrong nearly everywhere.
          vTanU = mat3(modelMatrix) * aTanU;
          vTanV = mat3(modelMatrix) * aTanV;
          // World space, not view space.
          //
          // normalMatrix is the inverse-transpose of the *modelView* matrix, so
          // normalMatrix * normal is a view-space normal -- and uLightA/uLightB
          // are world directions, deliberately set to the same two directions as
          // the scene's key and fill lights. Lighting a view-space normal with a
          // constant vector is a headlamp: the highlight stayed in the same place
          // on screen however the camera orbited, so the interior had no fixed
          // relationship to the light while the casting eight millimetres away
          // -- a MeshStandardMaterial lit by the real lights -- did. Two halves of
          // one ceramic object shading inconsistently is most of why the wetted
          // basin read as flat and matte next to a solid-looking exterior.
          vec4 world = modelMatrix * vec4(position, 1.0);
          vNormal = normalize(mat3(modelMatrix) * normal);
          vView = cameraPosition - world.xyz;
          // The rivulet pattern's coordinate, in the same space as the flow
          // direction, the normal and gravity. It was the object-space position,
          // which is the same thing only while the model matrix is the identity --
          // and if it ever stopped being, the pattern would shear away from the
          // frame it is laid out in without anything failing to compile.
          vWorld = world.xyz;
          gl_Position = projectionMatrix * viewMatrix * world;
        }
      `,
      fragmentShader: /* glsl */ `
        ${COLORMAP_GLSL}
        ${FILM_GLSL}
        uniform float uFieldMin;
        uniform float uFieldMax;
        uniform float uFieldLog;
        uniform int uScale;
        uniform float uCriticalT;
        uniform float uUseField;
        uniform float uLiquid;
        uniform float uRelief;
        uniform float uTime;
        uniform float uWetOnset;
        uniform vec3 uShadowColor;
        uniform vec3 uBase;
        uniform vec3 uLiquidTint;
        uniform float uTintDepth;
        uniform float uCapillary;
        uniform vec3 uLightA;
        uniform vec3 uLightB;
        uniform vec3 uKeyColor;
        uniform vec3 uFillColor;
        uniform vec3 uAmbient;
        uniform samplerCube uEnv;
        uniform float uHasEnv;
        uniform float uEnvIntensity;
        uniform float uEnvMaxLod;
        uniform float uDryRoughness;
        uniform vec3 uGravity;
        varying float vField;
        varying vec2 vUv;
        varying vec3 vTanU;
        varying vec3 vTanV;
        varying vec3 vNormal;
        varying vec3 vView;
        varying vec3 vWorld;

        // sRGB transfer, both directions. The colour scales are authored as
        // display values and the lighting has to happen in linear light, so the
        // two have to be told apart rather than mixed -- which is what the old
        // shader did by writing its working values straight to the framebuffer.
        vec3 srgbToLinear(vec3 c) {
          return mix(
            pow((c + 0.055) / 1.055, vec3(2.4)),
            c / 12.92,
            step(c, vec3(0.04045))
          );
        }
        /**
         * Tone mapping is three's own, not a copy of it.
         *
         * toneMapping() and toneMappingExposure are prefixed into every
         * non-raw ShaderMaterial when the renderer has tone mapping enabled, so
         * this surface goes through the identical curve as the casting beside it
         * by construction rather than by two implementations agreeing. An earlier
         * pass here did paste in three's ACES fit, and the shader failed to compile
         * with "function already has a body" -- which was the compiler pointing out
         * the duplication before it could become a drift.
         *
         * Tone mapping is not a finishing touch here, it is what lets the room have
         * a light in it. A ceiling luminaire runs tens of times the radiance of the
         * wall it lights, and its reflection in a wet film arrives multiplied by a
         * Fresnel term of three or four percent at the angles a urinal is seen
         * from. Clamping at 1.0 makes such a source impossible, the room has to be
         * built dim to fit, and a dim room reflects as nothing -- which is why the
         * wetted glaze could only ever be shown by darkening it, and a darker matte
         * patch with a soft edge is the appearance of wetted cardboard.
         */
        vec3 linearToSrgb(vec3 c) {
          c = max(c, vec3(0.0));
          return mix(
            1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055,
            c * 12.92,
            step(c, vec3(0.0031308))
          );
        }

        /**
         * The washroom in a chosen direction, blurred by roughness.
         *
         * Mip level stands in for prefiltering: a rough surface gathers a wide
         * cone and a smooth one a narrow ray, which is the whole of what a
         * prefiltered environment encodes.
         *
         * Linear in roughness, not square-rooted. A square root looks like the
         * right shape -- it spends more of the mip range on the rough end, which
         * is where a prefilter's cone angle actually grows fastest -- but it puts
         * a wet film at roughness 0.045 on mip 1.5 of a 128 cube, i.e. a 45-pixel
         * face, and a mirror reflecting a 45-pixel room is not a mirror. The
         * reflected ceiling luminaires are the cue, and they have to stay
         * rectangular.
         */
        vec3 envAt(vec3 dir, float rough) {
          if (uHasEnv < 0.5) {
            // No environment: a plain sky/ground so the terms below still mean
            // something rather than collapsing the surface to a flat diffuse.
            float up = dir.y * 0.5 + 0.5;
            return mix(vec3(0.10, 0.11, 0.13), vec3(0.62, 0.66, 0.72), up);
          }
          float lod = uEnvMaxLod * clamp(rough, 0.0, 1.0);
          return textureCubeLodEXT(uEnv, dir, lod).rgb;
        }

        void main() {
          vec3 n = normalize(vNormal);
          vec3 v = normalize(vView);
          // Two-sided: the bowl interior is visible from angles where the
          // geometric normal faces away, and a black interior is useless.
          if (dot(n, v) < 0.0) n = -n;
          vec3 nDry = n;

          // ---- the film, reconstructed --------------------------------------
          //
          // One cubic sample carries everything the solver knows here: the mean
          // thickness over this cell, the mean velocity, and how much of the layer
          // is voided liquid rather than flush water. The gradient comes out of
          // the same basis analytically, so the free surface's tilt is the exact
          // slope of the reconstruction rather than a difference taken across
          // whatever the mesh happened to be.
          vec4 fs;
          float dhdi;
          float dhdj;
          sampleFilm(vUv, fs, dhdi, dhdj);
          float hMean = fs.x * 1.0e-6;
          float conc = fs.w;

          // The two in-plane directions, in world space and in metres.
          vec3 tuHat = normalize(vTanU);
          vec3 tvHat = normalize(vTanV);
          // vTanU is the unit tangent divided by the cell's width, so the world
          // gradient of the thickness is the index-space derivative times it.
          vec3 gradH = (dhdi * vTanU + dhdj * vTanV) * 1.0e-6;

          // Where the liquid is going. The film's own velocity while it is
          // running; downhill once it is not, because a pool at rest still has a
          // direction its surface structure lines up with, and normalising a zero
          // vector would otherwise leave the pattern pointing at whatever the
          // rounding produced.
          vec3 flow = fs.y * tuHat + fs.z * tvHat;
          float speed = length(flow);
          vec3 downhill = uGravity - n * dot(uGravity, n);
          float dhLen = length(downhill);
          vec3 fHat = speed > 1.0e-3
            ? flow / speed
            : (dhLen > 1.0e-4 ? downhill / dhLen : tvHat);
          vec3 aHat = normalize(cross(n, fHat));

          // ---- sub-grid rivulets ---------------------------------------------
          //
          // The solver reports a mean thickness over a cell 3.7 to 55 mm across,
          // and a film running down glaze is not spread evenly over anything that
          // size. Surface tension gathers it into rivulets about two capillary
          // lengths apart -- 4.7 mm for urine on china -- a few tenths of a
          // millimetre deep, with merely damp glaze between them. A cell reporting
          // 20 um mean is a 0.35 mm rivulet over a twentieth of its width, and the
          // two are not remotely the same thing to look at: one is a bright wet
          // streak with colour in it, the other is nothing at all.
          //
          // Rendering the mean is why the wall could not be made to look wet by
          // any amount of shading work. Every cue is nonlinear in thickness -- the
          // Beer-Lambert path, the surface tilt, the gloss -- so evaluating them
          // at the average of a distribution gives the wrong answer, not a blurred
          // one.
          //
          // The pattern this stands on used to be a sine comb: one wavelength, one
          // width, laid out on a fixed horizontal axis with a sine wobble in the
          // phase. Evenly spaced parallel lines of constant width are what a
          // machined finish looks like, and being pinned to the world horizontal
          // rather than to the flow meant they ran across the direction the liquid
          // was actually moving wherever the wall turned. It is now a ridged
          // two-octave noise in the *flow's* own frame, stretched eight to one
          // along it, so the lanes wander, vary in width, merge and split; and
          // because the frame moves with the film at the film's own speed, they
          // run rather than sit.
          float hRivulet = 0.15 * uCapillary;
          float pitch = 2.0 * uCapillary;
          float cover = clamp(hMean / max(1.0e-9, hRivulet), 0.0, 1.0);

          // Wet by the solvers own reckoning, on the cell mean. Everything the
          // sub-grid model does is bounded by this, and it has to be: the model
          // redistributes a cell mean into lanes that are deeper than the mean by
          // 1/cover, so at a mean of a tenth of a micron -- a trace, well under
          // the dry threshold -- it would lift the lanes to a visibly wet layer
          // and paint rivulets across bone-dry glaze. It did exactly that, over
          // the whole bowl, because a droplet splash leaves a trace everywhere it
          // has ever reached.
          float wetMean = smoothstep(uWetOnset, uWetOnset * 4.0, hMean);

          // Rivulets are a feature of a film that is *running*. Where the film has
          // stopped -- an isolated splash that landed and was pinned by its own
          // contact line, or a settled pool -- the liquid is a patch with an edge,
          // not a set of lanes, and the reconstruction plus the contact line below
          // already draw exactly that. Splitting on the film speed is what keeps a
          // 3 mm splat from being drawn as a rainstorm down the wall.
          float running = smoothstep(0.02, 0.14, speed);

          float hLocal = hMean;
          vec3 gradDetail = vec3(0.0);
          // Slope the rivulets carry that is finer than one pixel, as an RMS tilt.
          // See where it is used, below the lighting terms.
          float subgridSlope = 0.0;
          float detail = uLiquid * wetMean * running;
          if (detail > 0.004) {
            // Twenty pitches long against one across. A rivulet is a line, and the
            // lattice it is drawn from has to be at least as anisotropic as the
            // thing it stands for or the lanes come out as a field of dashes.
            float along = pitch * 20.0;
            vec2 q = vec2(
              dot(vWorld, aHat) / pitch,
              (dot(vWorld, fHat) - uTime * speed) / along);
            vec3 rf = rivuletField(q);

            // Level set chosen so the lanes cover the area the liquid can cover.
            // The exponent calibrates a ridged noise level against its own area
            // and is the only fitted number in here.
            float thr = 1.0 - pow(cover, 0.55);
            float e0 = thr - 0.16;
            float e1 = thr + 0.16;
            float t = clamp((rf.x - e0) / (e1 - e0), 0.0, 1.0);
            float stripe = t * t * (3.0 - 2.0 * t);
            float dStripe = 6.0 * t * (1.0 - t) / (e1 - e0);

            // Filtered against the pixel footprint. A rivulet 0.3 mm wide on a
            // 400 mm bowl is a third of a pixel, and a hard lane that size does
            // not render as a thin line -- it renders as moire. Where the pattern
            // falls below the sampling rate it is faded into its own area average,
            // which is the correct filtered answer and is exactly the cover.
            float aa = clamp(fwidth(rf.x) * 1.4, 0.0, 1.0);
            float resolved = 1.0 - smoothstep(0.25, 0.9, aa);
            // Cover close to one is a continuous sheet -- the sump pool -- and
            // there is nothing left to break up.
            float breakable = 1.0 - smoothstep(0.75, 1.0, cover);
            float visible = detail * resolved * breakable;
            // What the filter just threw away, kept as a slope rather than
            // discarded. See uses below.
            subgridSlope = 0.26 * detail * (1.0 - resolved) * breakable;

            // The cell mean redistributed over the pattern, so that the shading
            // still integrates to the number the solver reported: a fraction
            // cover of the area carries the rivulet and the rest carries a
            // residual damp layer, and the two are weighted to average to hMean.
            float between = 0.15;
            float ridgeH = (1.0 - between * (1.0 - cover)) / max(cover, 0.02);
            float profile = mix(between, ridgeH, stripe);
            hLocal = hMean * mix(1.0, profile, visible);

            // The slope of that redistribution, which is what actually makes a
            // rivulet visible: it turns the surface away from the mean by ten or
            // twelve degrees and the reflected room moves with it.
            float amp = hMean * (ridgeH - between) * visible * dStripe;
            gradDetail = amp * (rf.y * aHat / pitch + rf.z * fHat / along);
          }

          // ---- wet or dry ----------------------------------------------------
          //
          // An optical question, asked of the thickness that is actually here
          // rather than of the cell mean. A surface is optically wet as soon as it
          // carries a continuous layer, which is a fraction of a micron: at that
          // point the interface the light meets is water, the Fresnel term is
          // water, and scattered light starts being trapped by internal
          // reflection. Referenced to FILM_DRY_THICKNESS, which is the solvers
          // own definition of a dry cell and the threshold wettedArea() reports
          // against, so what the picture calls wet and what the metrics call wet
          // are one number. Multiplied by the cell wet mask so that the sub-grid
          // redistribution can shape the wetted region but never extend it.
          float wet = smoothstep(uWetOnset, uWetOnset * 8.0, hLocal) * wetMean * uLiquid;

          // ---- the contact line ----------------------------------------------
          //
          // The free surface turns through a large angle in the last fraction of a
          // millimetre at the edge of a wetted patch, and that turn is most of what
          // tells the eye it is looking at liquid resting on a surface rather than
          // at a stain in one.
          //
          // Two things about it were wrong. It was located on the solver's grid --
          // a per-vertex flag raised where one cell held much more liquid than its
          // neighbour -- so the drawn edge was one cell wide: a 5 to 55 mm soft
          // band that grew and shrank with the grid resolution and, close up, was
          // the widest feature on the bowl. And it was drawn by *adding light*, a
          // fixed pale value all the way round the patch, which is not what an edge
          // does: a meniscus is a piece of steeply curved liquid surface, so it is
          // bright where it happens to face the light and dark where it does not,
          // and a uniform bright outline reads as a sticker. The wetted marks came
          // out as pale decals with cartoon outlines.
          //
          // So it is located in *pixels* from the level set h = the dry threshold,
          // which is where the contact line really is and is resolution-independent
          // -- the distance from that level divided by its screen-space rate of
          // change is a distance in pixels, so the feature stays a line at every
          // camera distance -- and it is applied as a tilt of the surface, letting
          // the same lighting that shades everything else shade it too.
          float pxGrad = max(fwidth(hMean), 1.0e-12);
          float dPix = (hMean - uWetOnset) / pxGrad;
          // Only where there is liquid to hold one: the level set exists all over
          // the dry bowl at h = 0, and without this every cell boundary out on the
          // dry glaze would draw an edge.
          float hasEdge = smoothstep(uWetOnset * 0.5, uWetOnset * 4.0, hMean + pxGrad);
          // Sitting just inside the line, where the meniscus climbs.
          float lip = exp(-(dPix - 1.0) * (dPix - 1.0) * 0.5) * hasEdge * uLiquid;
          // Uphill, out of the liquid: the surface rises from the dry glaze to the
          // film, so the meniscus faces outwards.
          vec3 gOut = -gradH + n * dot(gradH, n);
          float gOutLen = length(gOut);

          vec3 nWet = n;
          if (wet > 0.001 || lip > 0.001) {
            // The free surface of a layer of thickness h has normal proportional
            // to (n - grad h), so the offset is the negated in-plane gradient.
            vec3 g = gradH + gradDetail;
            g -= n * dot(g, n);
            float rlen = length(g);
            vec3 rdir = rlen > 1.0e-9 ? g / rlen : vec3(0.0);
            float s = rlen * uRelief;
            // 17 degrees. Above the 12 a rivulet flank actually has, because the
            // pool rim in the sump genuinely turns further than that, and below
            // the 40 an earlier cap allowed, where a pool edge shaded as though it
            // faced sideways. Saturating rather than clipping keeps the small
            // slopes linear.
            float maxTilt = 0.30;
            nWet = normalize(n - rdir * (s / (1.0 + s / maxTilt)));

            // The meniscus, as a much steeper turn of the same surface in the same
            // direction. Liquid pinned on fired glaze sits at a contact angle of
            // twenty to forty degrees, and the free surface has to get from that
            // angle back to flat within a capillary length -- so the last sliver
            // before the contact line is the steepest liquid on the fixture by a
            // wide margin. Twenty degrees, at the shallow end of that range,
            // because the band is a couple of pixels wide and a steeper one starts
            // to read as an embossed bump rather than as an edge.
            if (lip > 0.001 && gOutLen > 1.0e-12) {
              nWet = normalize(nWet + (gOut / gOutLen) * (0.36 * lip));
            }

            // Capillary waves on fast film, at a scale the grid cannot resolve.
            // Transverse -- stretched across the flow and travelling with it --
            // which is what ripples on a running film are; an isotropic mottle in
            // every direction at once is what a rough absorbent surface looks
            // like, and it was most of why this read as a stain soaking in.
            float agitate = clamp(speed * 1.6, 0.0, 1.0) * (1.0 - 0.7 * cover);
            if (agitate > 0.01) {
              vec2 wq = vec2(
                dot(vWorld, aHat) / (uCapillary * 3.0),
                (dot(vWorld, fHat) - uTime * speed * 1.3) / (uCapillary * 1.6));
              vec3 wn = vnoiseD(wq);
              vec3 wg = (wn.y * aHat / (uCapillary * 3.0)
                       + wn.z * fHat / (uCapillary * 1.6));
              nWet = normalize(nWet - wg * (agitate * 2.2e-5 * uRelief));
            }
          }
          // The contact line is liquid too, so it gets the liquid's optics -- water's
          // Fresnel and a mirror roughness -- and not just its shape. Without this
          // the meniscus would be a steep piece of *dry glaze*, and the one place
          // on a wetted surface that is guaranteed to catch a highlight would be
          // the one place shaded as though it could not.
          float wetOptical = clamp(max(wet, lip * 0.8 * uLiquid), 0.0, 1.0);
          vec3 nUse = normalize(mix(nDry, nWet, wetOptical));

          // ---- albedo of the substrate -------------------------------------
          vec3 albedo;
          if (uUseField > 0.5) {
            if (vField < -1.0e8) {
              albedo = uShadowColor;
            } else {
              float t;
              if (uFieldLog > 0.5) {
                float lo = log(max(uFieldMin, 1.0e-12));
                float hi = log(max(uFieldMax, 1.0e-12));
                t = (log(max(vField, 1.0e-12)) - lo) / max(1.0e-6, hi - lo);
              } else {
                t = (vField - uFieldMin) / max(1.0e-9, uFieldMax - uFieldMin);
              }
              // The colour scales are picked as display values, so they come back
              // to linear before anything is multiplied by them.
              albedo = srgbToLinear(colorScale(uScale, clamp(t, 0.0, 1.0), uCriticalT));
            }
          } else {
            albedo = uBase;
          }

          // ---- the film as a layer, not as a darker patch --------------------
          //
          // Wet glaze is not the same surface with the brightness turned down. It
          // is a second interface standing on top of the first, and every visible
          // difference follows from that:
          //
          //  - the reflection now comes off *water*, which is smoother than fired
          //    glaze and which follows the film's own surface, so the room appears
          //    in it as an image rather than as a broad sheen;
          //  - at grazing incidence Fresnel returns nearly all of the light, so a
          //    wet surface becomes a mirror. That is the cue the eye actually
          //    uses, and the reason the old shader could not produce one is that
          //    there was nothing in the scene for it to reflect;
          //  - light that does get in is refracted into a narrow cone, scatters
          //    off the ceramic, and is largely trapped by total internal
          //    reflection on the way back out. *That* is why wet things look
          //    darker, and it is a transmission loss rather than a change of
          //    albedo;
          //  - and what finally emerges has crossed the layer twice, so it carries
          //    the liquid's own colour by Beer-Lambert over that path rather than
          //    by a blend factor.
          //
          // The old model kept the third bullet's consequence and none of its
          // mechanism: a flat 42% multiply on the albedo, a Blinn-Phong lobe over
          // the top, and no environment. A darker matte patch with a soft edge is
          // exactly what a wetted *absorbent* surface looks like, which is how
          // this came to be reported as "wetting of cardboard".
          float NoV = clamp(dot(nUse, v), 1.0e-3, 1.0);
          // Normal-incidence reflectance of the top interface: water against air
          // is 0.020, fired glaze against air 0.043.
          float f0 = mix(0.043, 0.020, wetOptical);
          float fres = f0 + (1.0 - f0) * pow(1.0 - NoV, 5.0);

          // One roughness drives the reflected room and the punctual highlight
          // together, so they cannot disagree about how glossy the surface is --
          // which they did, the environment being absent and the Blinn exponent
          // being a separate hand-set number.
          float rough = mix(uDryRoughness, 0.045, wetOptical);
          // Rivulets finer than a pixel are roughness, not flatness.
          //
          // The lanes are a fraction of a millimetre wide, so beyond about half a
          // metre from the camera they fall below the sampling rate and the code
          // above fades them into their own area average -- which is the right
          // answer for the *thickness* and precisely the wrong one for the
          // *shading*. Averaging a corrugated surface to a flat one turns a film
          // that was scattering the room over a wide cone into a mirror pointed at
          // one direction, and on a bowl whose interior mostly reflects the dark
          // floor that direction is dark. The wetted wall therefore went from a
          // soft sheen up close to a dead grey patch two steps back, which is the
          // opposite of how wet things behave.
          //
          // A sub-pixel corrugation of RMS slope sigma is optically a rougher
          // surface: the standard variance result adds 2 sigma^2 to alpha^2. So the
          // structure is not lost when it stops being resolved, it is converted
          // into the thing it becomes, and the film keeps its sheen at any
          // distance while still going mirror-smooth where it genuinely is smooth.
          rough = min(1.0, sqrt(rough * rough + 2.0 * subgridSlope * subgridSlope));
          vec3 envSpec = envAt(reflect(-v, nUse), rough);
          // Not the very top mip. A single whole-sphere average gives every point
          // on the fixture the same ambient, which is a flat fill light and throws
          // away the one thing an environment is for: a surface facing the ceiling
          // is lit differently from one facing the floor, and on a basin whose
          // walls face in every direction that difference is most of the form.
          vec3 envDiff = envAt(nUse, 0.82);

          float dA = max(dot(nUse, uLightA), 0.0);
          float dB = max(dot(nUse, uLightB), 0.0);
          vec3 direct = uKeyColor * dA + uFillColor * dB;

          // GGX for the two directional lights, and the reason the film had no
          // glints on it at all.
          //
          // A punctual light is a fiction: it has no angular size, so the GGX peak
          // goes as 1/a2 and a mirror-smooth film puts several thousand on a single
          // pixel. The previous pass met that by clamping the lobe to 24 and then
          // multiplying by 0.06, which caps the brightest possible specular return
          // on wet glaze at 1.44 -- and with the Fresnel term at normal incidence
          // being 0.02, that is three hundredths of a level against a diffuse of
          // around 0.7. The highlight was mathematically present and optically
          // absent, which is why no amount of relief work made the film catch the
          // light: there was nothing for it to catch.
          //
          // The fix is to stop pretending the lights are points. A ceiling
          // luminaire in a washroom subtends a few degrees, and a source of
          // angular radius r reflected in a smooth surface is not a singularity but
          // a spot of that size. Folding the source size into the roughness -- the
          // standard representative-point treatment -- bounds the lobe by
          // construction, at a value that means something, and lets the glint be as
          // bright as a real one.
          float srcRough = max(rough, 0.10);
          vec3 hA = normalize(uLightA + v);
          vec3 hB = normalize(uLightB + v);
          float a2 = srcRough * srcRough * srcRough * srcRough;
          float dhA = max(dot(nUse, hA), 0.0);
          float dhB = max(dot(nUse, hB), 0.0);
          float denA = dhA * dhA * (a2 - 1.0) + 1.0;
          float denB = dhB * dhB * (a2 - 1.0) + 1.0;
          float ggxA = a2 / (3.14159265 * denA * denA);
          float ggxB = a2 / (3.14159265 * denB * denB);
          // Smith-Schlick visibility with the 1/(4 NoL NoV) folded in, so the
          // specular is the real Cook-Torrance quotient rather than a lobe times a
          // number picked to stop it exploding. The NoL that would multiply it
          // cancels against the one in the denominator.
          float k = srcRough * srcRough * 0.5;
          float visA = 0.25 / max(1.0e-4, (dA * (1.0 - k) + k) * (NoV * (1.0 - k) + k));
          float visB = 0.25 / max(1.0e-4, (dB * (1.0 - k) + k) * (NoV * (1.0 - k) + k));
          vec3 directSpec = uKeyColor * ggxA * visA * dA + uFillColor * ggxB * visB * dB;

          // Why a wet surface is darker, and why a white one is hardly darker at
          // all.
          //
          // Light that gets past the top interface scatters off the ceramic and
          // comes back up at every angle, and most of it arrives beyond the
          // critical angle for water against air -- so it is turned back down and
          // has to try again. The diffuse internal reflectance for n = 1.33 is
          // about 0.47. On a *dark* substrate each extra pass is another chance to
          // be absorbed and the surface goes markedly darker, which is the
          // everyday observation. On a white glaze almost nothing is absorbed per
          // pass, so the trapped light escapes eventually and the darkening nearly
          // cancels: this term takes a 0.78 albedo to 0.65, a ratio of 0.84, where
          // a flat multiply was taking it to 0.62.
          //
          // That matters here rather than being a refinement. Wet white sanitary
          // glaze in a real washroom is barely darker than dry -- what changes is
          // that it turns into a mirror. Modelling the wetness as a big diffuse
          // darkening with a soft edge is *precisely* the appearance of a wetted
          // absorbent surface, which is why this read as damp cardboard. The cue
          // has to come from the reflection, and it does now that there is a room
          // to reflect.
          float R_INTERNAL = 0.47;
          vec3 wetAlbedo = albedo * (1.0 - R_INTERNAL) / (1.0 - R_INTERNAL * albedo);

          // Beer-Lambert over twice the thickness. One law covers the whole range
          // the solver produces: tens of microns on the wall reads faintly warm,
          // millimetres in the sump reads as properly coloured liquid. That depth
          // blend used to be a second, separate mechanism for the same thing.
          // Path length times *concentration*: a millimetre of the void colours
          // strongly and a millimetre of flush water does not colour at all, and
          // the same layer somewhere between reads as the mixture it is. Without
          // the concentration the flush was simply more liquid, so washing the
          // bowl down made it darker -- the one thing a flush must never do.
          vec3 absorb = pow(
            clamp(uLiquidTint, vec3(1.0e-3), vec3(1.0)),
            vec3(clamp((2.0 * hLocal * conc) / max(1.0e-6, uTintDepth), 0.0, 8.0))
          );
          vec3 sub = mix(albedo, wetAlbedo, wet) * mix(vec3(1.0), absorb, uLiquid);

          // Lambert, with the 1/pi the ad-hoc version never had -- which is most
          // of why the punctual lights used to overwhelm everything else and why
          // the interior and the casting could not be brought to the same level by
          // adjusting either one. The environment term is already a radiance, and
          // the irradiance from a uniform hemisphere of radiance L is pi*L, so the
          // pi cancels there and does not for the two directional lights.
          float RCP_PI = 0.31830989;
          // (1 - fres) on the diffuse path is energy conservation, not a wetness
          // term: whatever the top interface reflects never reaches the ceramic,
          // wet or dry.
          vec3 col = sub * (1.0 - fres) * ((direct + uAmbient) * RCP_PI + envDiff * uEnvIntensity)
                   + (envSpec * uEnvIntensity + directSpec) * fres;


          // Encoded once, here, so that everything above is linear light and the
          // interior lands on the same transfer function as the casting beside it.
          gl_FragColor = vec4(linearToSrgb(toneMapping(col)), 1.0);
        }
      `,
      side: THREE.DoubleSide,
      transparent: false,
    });

    // Plain glazed porcelain. Deliberately a standard material rather than the
    // shader above: the outside of the fixture is never a data surface, and giving
    // it the film and field machinery would invite reading a colour off it.
    this.shellMaterial = new THREE.MeshStandardMaterial({
      color: 0xe7eaf0,
      roughness: 0.22,
      metalness: 0.02,
      side: THREE.DoubleSide,
    });

    // Polished chrome. High metalness with low roughness is what separates the
    // metalwork from the glaze at a glance, and the glaze is already the
    // brightest thing in frame, so the chrome is kept slightly darker to read as
    // metal rather than as more ceramic.
    this.chromeMaterial = new THREE.MeshStandardMaterial({
      color: 0xc9d2dc,
      roughness: 0.14,
      metalness: 0.92,
      side: THREE.FrontSide,
    });
  }

  /**
   * Attach the metalwork.
   *
   * Chrome rather than the ceramic material, and a separate mesh, because it is a
   * different object: it is never a data surface, and giving it the field shader
   * would invite reading a value off a flush valve.
   */
  setFittings(fittings: FittingsMesh | null): void {
    if (this.fittingsMesh) {
      this.group.remove(this.fittingsMesh);
      this.fittingsMesh.geometry.dispose();
      this.fittingsMesh = null;
    }
    if (!fittings || fittings.empty) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(fittings.positions.slice(), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(fittings.normals.slice(), 3));
    g.setIndex(new THREE.BufferAttribute(fittings.indices.slice(), 1));
    g.computeBoundingSphere();
    this.fittingsMesh = new THREE.Mesh(g, this.chromeMaterial);
    this.fittingsMesh.frustumCulled = false;
    this.group.add(this.fittingsMesh);
  }

  setFittingsVisible(v: boolean): void {
    if (this.fittingsMesh) this.fittingsMesh.visible = v;
  }

  /** Attach the exterior casting. */
  setShell(shell: ShellMesh | null): void {
    if (this.shellMesh) {
      this.group.remove(this.shellMesh);
      this.shellMesh.geometry.dispose();
      this.shellMesh = null;
    }
    if (!shell) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(shell.positions.slice(), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(shell.normals.slice(), 3));
    g.setIndex(new THREE.BufferAttribute(shell.indices.slice(), 1));
    g.computeBoundingSphere();
    this.shellMesh = new THREE.Mesh(g, this.shellMaterial);
    this.shellMesh.frustumCulled = false;
    this.group.add(this.shellMesh);
  }

  setShellVisible(v: boolean): void {
    if (this.shellMesh) this.shellMesh.visible = v;
  }

  /**
   * Adopt the scene's actual lighting rig.
   *
   * The shader used to carry its own copy of the two directional light directions
   * -- close enough to the real ones to read as intentional, applied to a
   * view-space normal so they behaved as a headlamp, and free to drift the moment
   * anyone touched `SceneView`. A second, unread copy of a number the project
   * already has is this codebase's most-repeated defect; one call keeps them
   * identical by construction.
   */
  setLights(
    key: THREE.DirectionalLight,
    fill: THREE.DirectionalLight,
    ambient: THREE.AmbientLight
  ): void {
    const u = this.material.uniforms;
    (u.uLightA.value as THREE.Vector3).copy(key.position).normalize();
    (u.uLightB.value as THREE.Vector3).copy(fill.position).normalize();
    (u.uKeyColor.value as THREE.Color).copy(key.color).multiplyScalar(key.intensity);
    (u.uFillColor.value as THREE.Color).copy(fill.color).multiplyScalar(fill.intensity);
    (u.uAmbient.value as THREE.Color).copy(ambient.color).multiplyScalar(ambient.intensity);
  }


  /**
   * Give the glaze something to reflect.
   *
   * The casting and the chrome reflect a PMREM'd `RoomEnvironment` through
   * `scene.environment`; a raw `ShaderMaterial` gets none of that machinery, so
   * the interior -- the one surface in the scene that is supposed to be *wet* --
   * had nothing to mirror. `SceneView` renders the same room into a cube target
   * and hands it over here, so all three surfaces reflect one room.
   */
  setEnvironment(env: THREE.CubeTexture | null, intensity = 0.55): void {
    this.material.uniforms.uEnv.value = env;
    this.material.uniforms.uHasEnv.value = env ? 1 : 0;
    this.material.uniforms.uEnvIntensity.value = intensity;
    if (env && env.image && Array.isArray(env.image) && env.image[0]) {
      const w = (env.image[0] as { width?: number }).width ?? 256;
      this.material.uniforms.uEnvMaxLod.value = Math.log2(Math.max(2, w));
    }
    this.material.needsUpdate = true;
  }

  setSurface(surface: UrinalSurface): void {
    this.surface = surface;
    if (this.mesh) {
      this.group.remove(this.mesh);
      this.group.remove(this.wire);
      this.geometry.dispose();
    }
    const nVert = (surface.nu + 1) * (surface.nv + 1);
    const nCell = surface.nu * surface.nv;

    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(surface.vertices.slice(), 3)
    );
    this.geometry.setAttribute(
      'normal',
      new THREE.BufferAttribute(surface.vertexNormals.slice(), 3)
    );
    this.field = new Float32Array(nVert);
    this.geometry.setAttribute('aField', new THREE.BufferAttribute(this.field, 1));
    this.geometry.setAttribute('aUv', new THREE.BufferAttribute(this.buildUv(surface), 2));
    const { tanU, tanV } = this.buildTangents(surface);
    this.geometry.setAttribute('aTanU', new THREE.BufferAttribute(tanU, 3));
    this.geometry.setAttribute('aTanV', new THREE.BufferAttribute(tanV, 3));
    this.geometry.setIndex(new THREE.BufferAttribute(surface.indices.slice(), 1));
    this.geometry.computeBoundingSphere();

    this.filmField.resize(surface);
    this.material.uniforms.uFilm.value = this.filmField.texture;
    (this.material.uniforms.uFilmSize.value as THREE.Vector2).set(surface.nu, surface.nv);

    this.counts = new Uint16Array(nVert);
    this.cellScratch = new Float64Array(nCell);

    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.group.add(this.mesh);

    this.wire = new THREE.LineSegments(
      this.buildSparseWireframe(surface, 8, 12),
      new THREE.LineBasicMaterial({ color: 0x1b2430, transparent: true, opacity: 0.22 })
    );
    this.wire.visible = false;
    this.group.add(this.wire);

    if (this.drainRing) this.group.remove(this.drainRing);
    this.drainRing = this.buildDrainOutline(surface);
    this.group.add(this.drainRing);
  }

  /**
   * Where each vertex sits in the film grid's own coordinates.
   *
   * Vertex (i, j) is the *corner* of cell (i, j), so it lands at i/nu -- half a
   * texel short of the texel centre, which is exactly what the shader's `uv *
   * size - 0.5` expects. Getting this off by half a cell would slide the whole
   * film half a cell up and to the left of the geometry it is running over, which
   * is the kind of error that looks like a physics bug.
   */
  private buildUv(s: UrinalSurface): Float32Array {
    const stride = s.nu + 1;
    const uv = new Float32Array((s.nu + 1) * (s.nv + 1) * 2);
    for (let j = 0; j <= s.nv; j++) {
      for (let i = 0; i <= s.nu; i++) {
        const o = (j * stride + i) * 2;
        uv[o] = i / s.nu;
        uv[o + 1] = j / s.nv;
      }
    }
    return uv;
  }

  /**
   * Surface tangents divided by the cell size they span, at the vertices.
   *
   * The shader gets its thickness derivatives in cell-index units, and the grid is
   * graded -- 3.7 mm cells at the sump, 55 mm at the rim -- so turning those into
   * a world-space slope needs the local cell size and not a global one. Folding
   * the division in here means the shader can never pair a tangent with the wrong
   * width, and it costs nothing per frame: both are fixed by the geometry.
   */
  private buildTangents(s: UrinalSurface): { tanU: Float32Array; tanV: Float32Array } {
    const stride = s.nu + 1;
    const nVert = (s.nu + 1) * (s.nv + 1);
    const tanU = new Float32Array(nVert * 3);
    const tanV = new Float32Array(nVert * 3);
    const touch = new Uint8Array(nVert);
    for (let j = 0; j < s.nv; j++) {
      for (let i = 0; i < s.nu; i++) {
        const c = j * s.nu + i;
        const o3 = c * 3;
        const du = Math.max(1e-6, s.cellDu[c]);
        const dv = Math.max(1e-6, s.cellDv[c]);
        const vs = [
          j * stride + i,
          j * stride + i + 1,
          (j + 1) * stride + i,
          (j + 1) * stride + i + 1,
        ];
        for (const vi of vs) {
          const b = vi * 3;
          tanU[b] += s.cellTangentU[o3] / du;
          tanU[b + 1] += s.cellTangentU[o3 + 1] / du;
          tanU[b + 2] += s.cellTangentU[o3 + 2] / du;
          tanV[b] += s.cellTangentV[o3] / dv;
          tanV[b + 1] += s.cellTangentV[o3 + 1] / dv;
          tanV[b + 2] += s.cellTangentV[o3 + 2] / dv;
          touch[vi]++;
        }
      }
    }
    for (let vi = 0; vi < nVert; vi++) {
      const t = touch[vi] || 1;
      const b = vi * 3;
      tanU[b] /= t;
      tanU[b + 1] /= t;
      tanU[b + 2] /= t;
      tanV[b] /= t;
      tanV[b + 1] /= t;
      tanV[b + 2] /= t;
    }
    return { tanU, tanV };
  }

  private buildSparseWireframe(
    s: UrinalSurface,
    everyU: number,
    everyV: number
  ): THREE.BufferGeometry {
    const pts: number[] = [];
    const stride = s.nu + 1;
    const at = (i: number, j: number) => {
      const o = (j * stride + i) * 3;
      return [s.vertices[o], s.vertices[o + 1], s.vertices[o + 2]];
    };
    for (let i = 0; i <= s.nu; i += everyU) {
      for (let j = 0; j < s.nv; j++) pts.push(...at(i, j), ...at(i, j + 1));
    }
    for (let j = 0; j <= s.nv; j += everyV) {
      for (let i = 0; i < s.nu; i++) pts.push(...at(i, j), ...at(i + 1, j));
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    return g;
  }

  private buildDrainOutline(s: UrinalSurface): THREE.Line {
    let cx = 0;
    let cy = 0;
    let cz = 0;
    let n = 0;
    for (let c = 0; c < s.cellIsDrain.length; c++) {
      if (!s.cellIsDrain[c]) continue;
      cx += s.cellPos[c * 3];
      cy += s.cellPos[c * 3 + 1];
      cz += s.cellPos[c * 3 + 2];
      n++;
    }
    const pts: THREE.Vector3[] = [];
    if (n > 0) {
      cx /= n;
      cy /= n;
      cz /= n;
      const r = Math.max(0.004, Math.sqrt(s.drainArea / Math.PI));
      for (let i = 0; i <= 48; i++) {
        const a = (i / 48) * Math.PI * 2;
        pts.push(new THREE.Vector3(cx + r * Math.cos(a), cy + 0.0015, cz + r * Math.sin(a)));
      }
    }
    const g = new THREE.BufferGeometry().setFromPoints(pts);
    return new THREE.Line(g, new THREE.LineBasicMaterial({ color: 0x0e1621 }));
  }

  setWireframeVisible(v: boolean): void {
    if (this.wire) this.wire.visible = v;
  }

  /**
   * Push the displayed data field onto the vertices.
   *
   * Cell-centred solver values are averaged onto the vertices the shader
   * interpolates over. Invalid cells are excluded from the average rather than
   * counted as zero: fields like the impingement map are genuinely undefined where
   * the stream cannot reach, and folding an undefined cell into its neighbours
   * would smear a fabricated value across the boundary. A vertex with no valid
   * neighbour keeps the sentinel and renders grey.
   *
   * This used to carry the liquid as well, in seven more channels. It does not any
   * more -- see `filmField` -- and what is left makes the reason plain: a data
   * overlay is a per-cell readout and reading one off a vertex average is honest,
   * while liquid is a continuous surface whose *slope* is most of its appearance,
   * and a vertex average has no slope worth the name.
   */
  private scatter(fieldCells: Float64Array, invalid: Uint8Array | undefined): void {
    const s = this.surface;
    const stride = s.nu + 1;
    const nVert = this.field.length;
    this.field.fill(0);
    this.counts.fill(0);

    for (let j = 0; j < s.nv; j++) {
      for (let i = 0; i < s.nu; i++) {
        const c = j * s.nu + i;
        if (invalid && invalid[c] !== 0) continue;
        const fv = fieldCells[c];
        if (!Number.isFinite(fv)) continue;
        const v0 = j * stride + i;
        const v1 = v0 + 1;
        const v2 = v0 + stride;
        const v3 = v2 + 1;
        this.field[v0] += fv;
        this.field[v1] += fv;
        this.field[v2] += fv;
        this.field[v3] += fv;
        this.counts[v0]++;
        this.counts[v1]++;
        this.counts[v2]++;
        this.counts[v3]++;
      }
    }

    for (let vi = 0; vi < nVert; vi++) {
      this.field[vi] = this.counts[vi] > 0 ? this.field[vi] / this.counts[vi] : SENTINEL;
    }
    (this.geometry.getAttribute("aField") as THREE.BufferAttribute).needsUpdate = true;
  }

  /** Refresh the surface appearance and the displayed field. */
  update(
    film: FilmSolver,
    metrics: Metrics,
    impingement: Float64Array,
    shadowed: Uint8Array,
    time: number
  ): void {
    const s = this.surface;
    const nCell = s.nu * s.nv;

    // The whole liquid state, as one upload.
    this.filmField.update(film);

    this.material.uniforms.uTime.value = time;
    this.material.uniforms.uRelief.value = this.reliefGain;
    // The solver's own dry threshold, not the retention thickness: see the note
    // in the fragment shader. Held as a uniform rather than inlined so the
    // contact line the shader draws and the wetted area the metrics report are
    // the same threshold.
    this.material.uniforms.uWetOnset.value = FILM_DRY_THICKNESS;
    // The liquid's own colour, from the fluid preset rather than from a constant
    // in this file. It was hardcoded amber, so the water reference -- the preset
    // that exists to reproduce published lab experiments -- drew yellow water.
    const t = film.fluid.tint;
    (this.material.uniforms.uLiquidTint.value as THREE.Color).setRGB(t[0], t[1], t[2]);
    // The rivulet scale is the fluid's, not a constant: a lower surface tension
    // makes narrower, shallower rivulets, and the fluid selector should move the
    // appearance for the same reason it moves the splash threshold.
    this.material.uniforms.uCapillary.value = capillaryLength(film.fluid);
    // Dry mode is for reading geometry, so the liquid is switched off entirely.
    const liquid = this.mode === FieldMode.Dry ? 0 : this.liquidStrength;
    this.material.uniforms.uLiquid.value = liquid;

    let values: Float64Array = this.cellScratch;
    let invalid: Uint8Array | undefined;
    let min = 0;
    let max = 1;
    let useField = 1;
    let log = false;

    switch (this.mode) {
      case FieldMode.Liquid:
      case FieldMode.Dry:
        useField = 0;
        break;
      case FieldMode.Impingement:
        values = impingement;
        invalid = shadowed;
        min = 0;
        max = Math.PI / 2;
        break;
      case FieldMode.FilmThickness:
        values = film.h;
        // Logarithmic, spanning 5 um to 3 mm. A linear millimetre scale is what
        // made the film look absent: the wall carries tens of microns while the
        // sump pools at millimetres, nearly three decades apart, and on a linear
        // scale everything except the pool collapses to the bottom swatch.
        min = 5e-6;
        max = 3e-3;
        log = true;
        break;
      case FieldMode.FilmSpeed: {
        for (let c = 0; c < nCell; c++) this.cellScratch[c] = film.speedAt(c);
        values = this.cellScratch;
        min = 1e-3;
        max = 1.5;
        log = true;
        break;
      }
      case FieldMode.Residence:
        values = film.residenceTime;
        min = 0;
        max = 60;
        break;
      case FieldMode.ImpactVolume: {
        for (let c = 0; c < nCell; c++) {
          this.cellScratch[c] = metrics.impactVolume[c] / Math.max(1e-9, s.cellArea[c]);
        }
        values = this.cellScratch;
        min = 1e-7;
        max = Math.max(1e-5, percentile(this.cellScratch, 0.99));
        log = true;
        break;
      }
      case FieldMode.SplashOrigin: {
        for (let c = 0; c < nCell; c++) {
          this.cellScratch[c] = metrics.impactSplashed[c] / Math.max(1e-9, s.cellArea[c]);
        }
        values = this.cellScratch;
        min = 1e-8;
        max = Math.max(1e-6, percentile(this.cellScratch, 0.99));
        log = true;
        break;
      }
    }

    this.info = FixtureView.infoFor(this.mode, min, max);
    this.material.uniforms.uUseField.value = useField;
    this.material.uniforms.uFieldMin.value = min;
    this.material.uniforms.uFieldMax.value = max;
    this.material.uniforms.uFieldLog.value = log ? 1 : 0;
    this.material.uniforms.uScale.value = this.info.scale;
    if (Number.isFinite(this.info.critical)) {
      const cSi = this.info.critical / this.info.toDisplay;
      this.material.uniforms.uCriticalT.value = log
        ? (Math.log(Math.max(cSi, 1e-12)) - Math.log(Math.max(min, 1e-12))) /
          Math.max(1e-6, Math.log(Math.max(max, 1e-12)) - Math.log(Math.max(min, 1e-12)))
        : (cSi - min) / Math.max(1e-9, max - min);
    } else {
      this.material.uniforms.uCriticalT.value = 2;
    }

    this.scatter(values, invalid);
  }

  static infoFor(mode: FieldMode, min: number, max: number): FieldInfo {
    switch (mode) {
      case FieldMode.Liquid:
        return {
          label: 'Liquid',
          unit: '',
          scale: ColorScale.Film,
          min: 0,
          max: 1,
          critical: Number.NaN,
          toDisplay: 1,
          log: false,
          description:
            'The fixture as it would look. Wet glaze goes darker and glossier, the ' +
            'film surface tilts the reflection where it varies in thickness, and ' +
            'standing liquid takes on a tint with depth. Switch to Film thickness ' +
            'for the numbers behind it.',
        };
      case FieldMode.Dry:
        return {
          label: 'Dry ceramic',
          unit: '',
          scale: ColorScale.Film,
          min: 0,
          max: 1,
          critical: Number.NaN,
          toDisplay: 1,
          log: false,
          description: 'Liquid hidden, for reading the geometry on its own.',
        };
      case FieldMode.Impingement:
        return {
          label: 'Impingement angle',
          unit: '°',
          scale: ColorScale.Impingement,
          min: 0,
          max: 90,
          critical: (CRITICAL_IMPINGEMENT_ANGLE * 180) / Math.PI,
          toDisplay: 180 / Math.PI,
          log: false,
          description:
            'Angle the stream would make with the surface if it landed here. Warm is ' +
            'over the 30° criterion and will throw a corona. Grey is shadowed — the ' +
            'stream cannot reach it in a straight line.',
        };
      case FieldMode.FilmThickness:
        return {
          label: 'Film thickness',
          unit: 'µm',
          scale: ColorScale.Film,
          min: min * 1e6,
          max: max * 1e6,
          critical: Number.NaN,
          toDisplay: 1e6,
          log: true,
          description:
            'Logarithmic, because the wall carries tens of microns while the sump ' +
            'pools at millimetres. Deep patches that persist after the stream stops ' +
            'are where the design accumulates.',
        };
      case FieldMode.FilmSpeed:
        return {
          label: 'Film speed',
          unit: 'm/s',
          scale: ColorScale.Magnitude,
          min,
          max,
          critical: Number.NaN,
          toDisplay: 1,
          log: true,
          description:
            'How fast the wall film is moving. Dark wetted areas are stagnant: ' +
            'liquid sitting still, which is where scale and odour develop.',
        };
      case FieldMode.Residence:
        return {
          label: 'Residence time',
          unit: 's',
          scale: ColorScale.Residence,
          min,
          max,
          critical: Number.NaN,
          toDisplay: 1,
          log: false,
          description:
            'How long each spot stayed wet over the run. The direct predictor of ' +
            'uric acid scale.',
        };
      case FieldMode.ImpactVolume:
        return {
          label: 'Arriving liquid',
          unit: 'mm³/mm²',
          scale: ColorScale.Splash,
          min: min * 1000,
          max: max * 1000,
          critical: Number.NaN,
          toDisplay: 1000,
          log: true,
          description: 'Where the stream and its droplets actually landed, per unit area.',
        };
      case FieldMode.SplashOrigin:
      default:
        return {
          label: 'Splash origin',
          unit: 'mm³/mm²',
          scale: ColorScale.Splash,
          min: min * 1000,
          max: max * 1000,
          critical: Number.NaN,
          toDisplay: 1000,
          log: true,
          description:
            'Where ejected liquid came from. Usually a small patch — fix that patch ' +
            'and most of the splashback goes with it.',
        };
    }
  }

  dispose(): void {
    this.geometry?.dispose();
    this.material.dispose();
    this.filmField.dispose();
  }
}

/** Value at a given quantile, ignoring zeros. Robust colour bounds. */
function percentile(values: Float64Array, q: number): number {
  const nz: number[] = [];
  for (let i = 0; i < values.length; i++) if (values[i] > 0) nz.push(values[i]);
  if (nz.length === 0) return 0;
  nz.sort((a, b) => a - b);
  return nz[Math.min(nz.length - 1, Math.floor(q * nz.length))];
}
