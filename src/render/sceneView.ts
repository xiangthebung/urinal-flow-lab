import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { ShellMesh } from '../geometry/shell';
import { UrinalSurface } from '../geometry/surface';
import { FittingsMesh } from '../geometry/fittings';
import { CaptureScene } from '../sim/capture';
import { Heatmap } from '../sim/metrics';
import { AimTrace } from '../sim/simulation';
import { ColorScale, sample, toCss } from './colormap';
import { DropletView } from './dropletView';
import { FixtureView } from './fixtureView';
import { StreamView } from './streamView';
import { ParticleSystem } from '../sim/particles';
import { Vec3 } from '../core/vec3';

/**
 * The viewport: fixture, droplets, the room, and the person.
 *
 * The user figure is not decoration. Splashback is only meaningful relative to
 * somebody standing there, and the metrics are reported per body zone, so the
 * zones have to be visible or the numbers cannot be checked against what is on
 * screen. Seeing a red droplet cross the shin panel and the shin tally tick up is
 * the difference between trusting the number and taking it on faith.
 */

export const enum CameraPreset {
  ThreeQuarter = 'threeQuarter',
  Front = 'front',
  Side = 'side',
  Top = 'top',
  UserEye = 'userEye',
}

export class SceneView {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGLRenderer;
  readonly controls: OrbitControls;
  readonly fixture = new FixtureView();
  readonly droplets: DropletView;
  readonly stream = new StreamView();

  private shell: ShellMesh | null = null;
  private roomGroup = new THREE.Group();
  private userGroup = new THREE.Group();
  private zoneGroup = new THREE.Group();
  private streamGroup = new THREE.Group();
  private heatGroup = new THREE.Group();
  private floorHeatTexture: THREE.DataTexture | null = null;
  private bodyHeatTexture: THREE.DataTexture | null = null;
  private floorHeatMesh: THREE.Mesh | null = null;
  private bodyHeatMesh: THREE.Mesh | null = null;
  private streamLine: THREE.Line | null = null;
  private aimMarker: THREE.Mesh;
  private target = new THREE.Vector3(0, 0.2, 0.1);

  constructor(canvas: HTMLCanvasElement, dropletCapacity: number) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setClearColor(0x0d1218, 1);
    this.scene.fog = new THREE.Fog(0x0d1218, 2.4, 6.5);

    this.camera = new THREE.PerspectiveCamera(38, 1, 0.02, 40);
    this.camera.position.set(0.75, 0.85, 1.15);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 0.18;
    this.controls.maxDistance = 6;
    this.controls.target.copy(this.target);

    this.droplets = new DropletView(dropletCapacity);

    this.scene.add(new THREE.AmbientLight(0xffffff, 0.45));
    const key = new THREE.DirectionalLight(0xffffff, 1.1);
    key.position.set(1.2, 2.4, 1.6);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0x9fc6ff, 0.45);
    fill.position.set(-1.4, 0.9, 1.4);
    this.scene.add(fill);

    // An environment, because the metalwork is a metal.
    //
    // A physically based metal has no diffuse response at all -- everything you see
    // on chrome is reflected surroundings -- so with directional lights and no
    // environment the flushometer rendered as a black silhouette standing over a
    // white fixture. It looked like a hole in the scene. Lowering its metalness
    // would have fixed the symptom by making it not be metal; supplying something
    // for it to reflect fixes the cause, and the glaze picks up a specular sheen
    // from the same source, which is what glaze does.
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const env = pmrem.fromScene(new RoomEnvironment(), 0.04);
    this.scene.environment = env.texture;
    this.scene.environmentIntensity = 0.55;
    pmrem.dispose();

    this.scene.add(this.roomGroup);
    this.scene.add(this.userGroup);
    this.scene.add(this.zoneGroup);
    this.scene.add(this.streamGroup);
    this.scene.add(this.heatGroup);
    this.scene.add(this.fixture.group);
    this.scene.add(this.stream.mesh);
    this.scene.add(this.droplets.points);

    this.aimMarker = new THREE.Mesh(
      new THREE.SphereGeometry(0.008, 16, 12),
      new THREE.MeshBasicMaterial({ color: 0x35e0ff })
    );
    this.aimMarker.visible = false;
    this.scene.add(this.aimMarker);
  }

  // -----------------------------------------------------------------------

  /** Rebuild everything tied to the geometry. */
  /**
   * Rebuild everything tied to the geometry.
   *
   * The casting is handed in rather than built here. It used to be built in this
   * method, on the grounds that it was purely decorative -- which is exactly how
   * droplets came to pass straight through it. It is solid, the simulation owns it,
   * and the view draws the same one the solver collides against.
   */
  setGeometry(
    surface: UrinalSurface,
    casting: ShellMesh | null,
    capture: CaptureScene,
    fittings: FittingsMesh | null = null
  ): void {
    this.fixture.setSurface(surface);
    this.shell = casting;
    this.fixture.setShell(casting);
    this.fixture.setFittings(fittings);
    this.buildRoom(surface, capture);
    this.buildUser(surface, capture);
    this.buildZones(surface, capture);
    this.buildHeatPlanes(surface, capture);

    // Centred on the whole fixture, metalwork included. Centring on the wetted
    // interior put the orbit pivot inside the bowl, so the object swung about a
    // point well below and behind the thing being looked at.
    const b = capture.extent.all;
    this.target.set(
      0,
      (b.min.y + b.max.y) * 0.5,
      (b.min.z + b.max.z) * 0.5
    );
    this.controls.target.copy(this.target);
  }

  /** Bounds of the exterior casting, or null before any geometry is set. */
  get castingBounds(): { min: Vec3; max: Vec3 } | null {
    return this.shell ? { min: this.shell.min, max: this.shell.max } : null;
  }

  /**
   * World-space ray through a point on the canvas, in normalised device
   * coordinates. Used to turn a click into an aim target.
   *
   * Returned as origin plus a direction already scaled to the far plane, because
   * every consumer is `raycast(origin, dir, 1)`, which wants the whole segment.
   */
  rayThrough(ndcX: number, ndcY: number): { origin: Vec3; dir: Vec3 } {
    const near = new THREE.Vector3(ndcX, ndcY, -1).unproject(this.camera);
    const far = new THREE.Vector3(ndcX, ndcY, 1).unproject(this.camera);
    return {
      origin: { x: near.x, y: near.y, z: near.z },
      dir: { x: far.x - near.x, y: far.y - near.y, z: far.z - near.z },
    };
  }

  private clear(g: THREE.Group): void {
    while (g.children.length) {
      const c = g.children.pop()!;
      const m = c as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
    }
  }

  private buildRoom(surface: UrinalSurface, capture: CaptureScene): void {
    this.clear(this.roomGroup);
    const b = capture.extent.ceramic;

    // Floor.
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(4, 4),
      new THREE.MeshStandardMaterial({
        color: 0x2a3440,
        roughness: 0.85,
        metalness: 0.0,
      })
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(0, surface.floorY, capture.fixtureFrontZ + 0.6);
    this.roomGroup.add(floor);

    // Tile grid on the floor, for a sense of scale.
    const grid = new THREE.GridHelper(4, 40, 0x3b4756, 0x333e4a);
    grid.position.set(0, surface.floorY + 0.001, capture.fixtureFrontZ + 0.6);
    this.roomGroup.add(grid);

    // Mounting wall behind the fixture. Placed off the back of the casting, not
    // the interior: the ceramic continues behind the bowl, so measuring from the
    // interior would bury the back of the fixture in the wall.
    const wall = new THREE.Mesh(
      new THREE.PlaneGeometry(3, 2.6),
      new THREE.MeshStandardMaterial({ color: 0x323d4a, roughness: 0.9 })
    );
    wall.position.set(0, surface.floorY + 1.3, b.min.z - 0.004);
    this.roomGroup.add(wall);
  }

  /**
   * A minimal standing figure at the configured posture.
   *
   * Crude on purpose: it exists to make the capture zones legible and to show the
   * standoff distance honestly. Anything more detailed would imply the body
   * geometry affects the physics, and it does not -- capture is tested against
   * flat zone rectangles, not against this mesh.
   */
  private buildUser(surface: UrinalSurface, capture: CaptureScene): void {
    this.clear(this.userGroup);
    const p = capture.posture;
    const floorY = surface.floorY;
    const cx = p.lateralOffset;
    const legZ = capture.legZ;
    const mat = new THREE.MeshStandardMaterial({
      color: 0x4a5769,
      roughness: 0.7,
      transparent: true,
      opacity: 0.5,
    });

    for (const side of [-1, 1]) {
      const x = cx + side * p.stanceWidth * 0.5;
      const leg = new THREE.Mesh(new THREE.CapsuleGeometry(0.055, 0.62, 4, 12), mat);
      leg.position.set(x, floorY + 0.42, legZ + 0.06);
      this.userGroup.add(leg);

      const shoe = new THREE.Mesh(
        new THREE.BoxGeometry(p.shoeWidth, 0.055, p.shoeLength),
        new THREE.MeshStandardMaterial({ color: 0x1d2530, roughness: 0.6 })
      );
      shoe.position.set(x, floorY + 0.028, legZ - p.shoeLength * 0.15);
      this.userGroup.add(shoe);
    }

    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.15, 0.5, 4, 16), mat);
    torso.position.set(cx, floorY + 1.05, legZ + 0.09);
    this.userGroup.add(torso);

    // Exit point, so the standoff and height are visible rather than implied.
    const exit = new THREE.Mesh(
      new THREE.SphereGeometry(0.012, 16, 12),
      new THREE.MeshBasicMaterial({ color: 0xffe07a })
    );
    exit.position.set(
      cx,
      floorY + p.emitterHeight,
      capture.fixtureFrontZ + p.standoff
    );
    this.userGroup.add(exit);
  }

  /** Translucent panels showing exactly what the splashback tallies measure. */
  private buildZones(surface: UrinalSurface, capture: CaptureScene): void {
    this.clear(this.zoneGroup);
    const p = capture.posture;
    const floorY = surface.floorY;
    const cx = p.lateralOffset;

    const panel = (
      w: number,
      h: number,
      color: number,
      pos: THREE.Vector3,
      rotX = 0
    ): void => {
      const m = new THREE.Mesh(
        new THREE.PlaneGeometry(w, h),
        new THREE.MeshBasicMaterial({
          color,
          transparent: true,
          opacity: 0.16,
          side: THREE.DoubleSide,
          depthWrite: false,
        })
      );
      m.position.copy(pos);
      m.rotation.x = rotX;
      this.zoneGroup.add(m);
      const edge = new THREE.LineSegments(
        new THREE.EdgesGeometry(m.geometry),
        new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.55 })
      );
      edge.position.copy(pos);
      edge.rotation.x = rotX;
      this.zoneGroup.add(edge);
    };

    // Shin and trouser panels face the fixture.
    panel(
      p.bodyHalfWidth * 2,
      p.shinTop - 0.02,
      0xff5a3c,
      new THREE.Vector3(cx, floorY + (p.shinTop + 0.02) * 0.5, capture.legZ)
    );
    panel(
      p.bodyHalfWidth * 2,
      p.thighTop - p.shinTop,
      0xffa03c,
      new THREE.Vector3(cx, floorY + (p.thighTop + p.shinTop) * 0.5, capture.legZ)
    );
  }

  setZonesVisible(v: boolean): void {
    this.zoneGroup.visible = v;
  }
  setUserVisible(v: boolean): void {
    this.userGroup.visible = v;
  }

  /**
   * Planes carrying the deposition heat maps: one on the floor, one on the body.
   *
   * These are the answer to "where did it land", and they are worth showing as
   * images rather than as numbers because the *shape* of the pattern tells a
   * designer something a total cannot. A tight spot straight ahead is an aim
   * problem; a wide fan across both shoes is a wall angle problem.
   */
  private buildHeatPlanes(surface: UrinalSurface, capture: CaptureScene): void {
    this.clear(this.heatGroup);
    const b = capture.extent.ceramic;

    const floorW = b.max.x - b.min.x + 1.0;
    const floorD = capture.fixtureFrontZ + 0.9 - (b.min.z - 0.2);
    const floorTex = makeDataTexture(72, 72);
    const floorMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(floorW, floorD),
      new THREE.MeshBasicMaterial({
        map: floorTex,
        transparent: true,
        depthWrite: false,
      })
    );
    floorMesh.rotation.x = -Math.PI / 2;
    floorMesh.position.set(
      (b.min.x + b.max.x) * 0.5,
      surface.floorY + 0.004,
      (b.min.z - 0.2 + capture.fixtureFrontZ + 0.9) * 0.5
    );
    this.heatGroup.add(floorMesh);
    this.floorHeatTexture = floorTex;
    this.floorHeatMesh = floorMesh;

    const bodyTex = makeDataTexture(48, 80);
    const bodyMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(0.6, 1.0),
      new THREE.MeshBasicMaterial({
        map: bodyTex,
        transparent: true,
        depthWrite: false,
      })
    );
    // Centred on the user, matching the bins `Metrics.bodyMap` actually uses.
    bodyMesh.position.set(
      capture.posture.lateralOffset,
      surface.floorY + 0.5,
      capture.legZ - 0.004
    );
    this.heatGroup.add(bodyMesh);
    this.bodyHeatTexture = bodyTex;
    this.bodyHeatMesh = bodyMesh;
  }

  setHeatmapsVisible(v: boolean): void {
    this.heatGroup.visible = v;
  }

  /** Redraw the airborne liquid: the intact jet as a tube, droplets as points. */
  updateLiquid(ps: ParticleSystem, emitter: Vec3, exitDiameter: number): void {
    this.stream.update(ps, emitter, exitDiameter);
    this.droplets.update(ps);
  }

  /** Push heat map data to the GPU. */
  updateHeatmaps(floor: Heatmap, body: Heatmap): void {
    if (this.floorHeatTexture) writeHeatmap(this.floorHeatTexture, floor, ColorScale.Splash);
    if (this.bodyHeatTexture) writeHeatmap(this.bodyHeatTexture, body, ColorScale.Splash);
    if (this.floorHeatMesh) this.floorHeatMesh.visible = floor.max() > 0;
    if (this.bodyHeatMesh) this.bodyHeatMesh.visible = body.max() > 0;
  }

  /**
   * The aim trajectory: the ballistic path the stream would follow, and where it
   * first meets the fixture.
   *
   * Shown because aim is the parameter with the largest effect on the result and
   * the least intuitive relationship to it. A few degrees of elevation moves the
   * landing point far enough to change the local wall angle by tens of degrees.
   */
  updateStreamPath(trace: AimTrace): void {
    if (this.streamLine) {
      this.streamGroup.remove(this.streamLine);
      this.streamLine.geometry.dispose();
      this.streamLine = null;
    }
    if (trace.points.length < 2) {
      this.aimMarker.visible = false;
      return;
    }

    const pts = trace.points.map((p) => new THREE.Vector3(p.x, p.y, p.z));
    const g = new THREE.BufferGeometry().setFromPoints(pts);
    // Amber when the ceramic stops the stream before it reaches the wetted
    // interior, so a blocked aim reads as a warning rather than as a normal one.
    const blocked = trace.blocked;
    this.streamLine = new THREE.Line(
      g,
      new THREE.LineDashedMaterial({
        color: blocked ? 0xffa03c : 0x35e0ff,
        dashSize: 0.014,
        gapSize: 0.01,
        transparent: true,
        opacity: 0.85,
      })
    );
    this.streamLine.computeLineDistances();
    this.streamGroup.add(this.streamLine);

    if (trace.point) {
      this.aimMarker.position.set(trace.point.x, trace.point.y, trace.point.z);
      (this.aimMarker.material as THREE.MeshBasicMaterial).color.setHex(
        blocked ? 0xffa03c : 0x35e0ff
      );
      this.aimMarker.visible = true;
    } else {
      this.aimMarker.visible = false;
    }
  }

  setStreamPathVisible(v: boolean): void {
    this.streamGroup.visible = v;
    this.aimMarker.visible = v && this.aimMarker.visible;
  }

  /**
   * Distance at which the fixture's eight corners just fit the frame, looking
   * from `off` (a unit direction) at `target`.
   *
   * Two earlier versions. The first scaled 1.9 times the taller of height and
   * width, which frames a 400 mm bowl in a 4:3 viewport and nothing else: it
   * ignored depth, so it cropped every model once the casting was added. The
   * second fitted the *bounding sphere*, which never crops but is loose by the
   * ratio between a box and the sphere around it — half a diagonal for an object
   * that is mostly flat in one axis — and then multiplied that by a 0.62 fill
   * factor on top. Together they left the fixture covering a fifth of the
   * viewport with the rest of the frame empty tiles.
   *
   * Projecting the corners is the same fix already made for the offline renderer,
   * where a loose guess was simultaneously cropping one model and shrinking the
   * other five. It is a fixed-point iteration rather than a closed form because
   * the perspective divide makes the exact relation awkward and this costs
   * nothing: the normalised coordinates fall off roughly as 1/dist, so scaling
   * the distance by the overshoot converges in a handful of passes.
   */
  private fitDistance(
    box: { min: Vec3; max: Vec3 },
    target: THREE.Vector3,
    off: THREE.Vector3,
    margin = 1.1
  ): number {
    const f = 1 / Math.tan((this.camera.fov * Math.PI) / 360);
    const aspect = Math.max(0.1, this.camera.aspect);
    const corners: THREE.Vector3[] = [];
    for (const x of [box.min.x, box.max.x]) {
      for (const y of [box.min.y, box.max.y]) {
        for (const z of [box.min.z, box.max.z]) {
          corners.push(new THREE.Vector3(x, y, z));
        }
      }
    }
    const span = Math.max(
      1e-4,
      Math.hypot(box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z)
    );
    const fwd = off.clone().negate();
    const worldUp = new THREE.Vector3(0, 1, 0);
    const right = new THREE.Vector3().crossVectors(fwd, worldUp).normalize();
    // Degenerate only for a straight-down view, where any horizontal axis will do.
    if (!Number.isFinite(right.x) || right.lengthSq() < 1e-9) right.set(1, 0, 0);
    const up = new THREE.Vector3().crossVectors(right, fwd);

    let dist = span * 2;
    const eye = new THREE.Vector3();
    const d = new THREE.Vector3();
    for (let iter = 0; iter < 24; iter++) {
      eye.copy(target).addScaledVector(off, dist);
      let worst = 0;
      for (const c of corners) {
        d.subVectors(c, eye);
        const z = d.dot(fwd);
        if (z <= 1e-4) {
          worst = Infinity;
          break;
        }
        worst = Math.max(
          worst,
          Math.abs((d.dot(right) / z) * (f / aspect)),
          Math.abs((d.dot(up) / z) * f)
        );
      }
      if (!Number.isFinite(worst)) {
        dist *= 2;
        continue;
      }
      dist *= worst * margin;
      if (Math.abs(worst * margin - 1) < 1e-4) break;
    }
    return dist;
  }

  applyCameraPreset(preset: CameraPreset, surface: UrinalSurface, capture: CaptureScene): void {
    // Framed on everything the fixture occupies, casting *and* metalwork. Using
    // the interior alone put the ceramic outside the frame on every model, and
    // stopping at the ceramic cropped the flushometer off the top.
    const box = capture.extent.all;
    const { min, max } = box;
    const cy = (min.y + max.y) * 0.5;
    const cz = (min.z + max.z) * 0.5;

    this.target.set(0, cy, cz);
    // A unit direction per preset, then the distance that just contains the
    // fixture along it. Solving per direction matters on the elongated models:
    // the trough is 1.49 m wide and 0.29 m tall, so the distance that frames it
    // from the front is nowhere near the one that frames it from the side.
    const dirFor = (v: [number, number, number]): THREE.Vector3 =>
      new THREE.Vector3(v[0], v[1], v[2]).normalize();
    const place = (v: [number, number, number]): void => {
      const off = dirFor(v);
      const d = this.fitDistance(box, this.target, off);
      this.camera.position.copy(this.target).addScaledVector(off, d);
    };

    switch (preset) {
      case CameraPreset.Front:
        place([0, 0, 1]);
        break;
      case CameraPreset.Side:
        place([1, 0, 0]);
        break;
      case CameraPreset.Top:
        place([0.001, 1, 0]);
        break;
      case CameraPreset.UserEye:
        // Roughly where the user's eyes are: the view that decides whether a
        // fixture feels like it splashes.
        this.camera.position.set(
          capture.posture.lateralOffset,
          surface.floorY + 1.6,
          capture.fixtureFrontZ + capture.posture.standoff + 0.12
        );
        break;
      case CameraPreset.ThreeQuarter:
      default:
        // Matches the offline renderer's three-quarter, so a screenshot from the
        // app and a contact-sheet thumbnail show the same view of the same model.
        place([0.62, 0.42, 0.78]);
        break;
    }
    this.controls.target.set(0, cy, cz);
    this.controls.update();
  }

  resize(width: number, height: number): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / Math.max(1, height);
    this.camera.updateProjectionMatrix();
    this.droplets.setViewport(height, dpr);
  }

  render(): void {
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }
}

function makeDataTexture(w: number, h: number): THREE.DataTexture {
  const data = new Uint8Array(w * h * 4);
  const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Render a deposition histogram into a texture.
 *
 * The intensity is mapped through a cube root rather than linearly. Deposition
 * spans several decades between the heaviest cell and the light scatter around it,
 * and a linear map shows only the single hottest spot as anything other than
 * black -- losing precisely the faint wide-area pattern that says the splash is
 * reaching the user.
 */
function writeHeatmap(tex: THREE.DataTexture, map: Heatmap, scale: ColorScale): void {
  const data = tex.image.data as Uint8Array;
  const max = map.max();
  const inv = max > 0 ? 1 / max : 0;
  for (let j = 0; j < map.ny; j++) {
    for (let i = 0; i < map.nx; i++) {
      const src = j * map.nx + i;
      const t = Math.cbrt(map.volume[src] * inv);
      const c = sample(scale, t);
      const dst = (j * map.nx + i) * 4;
      data[dst] = Math.round(c.r * 255);
      data[dst + 1] = Math.round(c.g * 255);
      data[dst + 2] = Math.round(c.b * 255);
      data[dst + 3] = t > 0.02 ? Math.round(Math.min(1, t * 1.6) * 235) : 0;
    }
  }
  tex.needsUpdate = true;
}

export { toCss };
