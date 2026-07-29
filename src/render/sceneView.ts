import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GRAVITY } from '../core/constants';
import { UrinalSurface } from '../geometry/surface';
import { CaptureScene } from '../sim/capture';
import { Heatmap } from '../sim/metrics';
import { StreamEmitter } from '../sim/stream';
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
  setGeometry(surface: UrinalSurface, capture: CaptureScene): void {
    this.fixture.setSurface(surface);
    this.buildRoom(surface, capture);
    this.buildUser(surface, capture);
    this.buildZones(surface, capture);
    this.buildHeatPlanes(surface, capture);

    const b = surface.bounds();
    this.target.set(
      0,
      (b.min.y + b.max.y) * 0.5,
      (b.min.z + b.max.z) * 0.5
    );
    this.controls.target.copy(this.target);
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
    const b = surface.bounds();

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

    // Mounting wall behind the fixture.
    const wall = new THREE.Mesh(
      new THREE.PlaneGeometry(3, 2.6),
      new THREE.MeshStandardMaterial({ color: 0x323d4a, roughness: 0.9 })
    );
    wall.position.set(0, surface.floorY + 1.3, b.min.z - 0.005);
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
    const b = surface.bounds();

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
    bodyMesh.position.set(0, surface.floorY + 0.5, capture.legZ - 0.004);
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
  updateStreamPath(emitter: StreamEmitter, surface: UrinalSurface, tSample: number): void {
    if (this.streamLine) {
      this.streamGroup.remove(this.streamLine);
      this.streamLine.geometry.dispose();
      this.streamLine = null;
    }
    const speed = emitter.speedAt(tSample);
    if (speed <= 1e-4) {
      this.aimMarker.visible = false;
      return;
    }
    const dir = emitter.aimDirection();
    const pts: THREE.Vector3[] = [];
    const o = emitter.position;
    const dt = 0.004;
    let prev = new THREE.Vector3(o.x, o.y, o.z);
    pts.push(prev.clone());
    let hitPoint: THREE.Vector3 | null = null;
    for (let i = 1; i <= 200; i++) {
      const t = i * dt;
      const p = new THREE.Vector3(
        o.x + dir.x * speed * t,
        o.y + dir.y * speed * t - 0.5 * GRAVITY * t * t,
        o.z + dir.z * speed * t
      );
      const seg = { x: p.x - prev.x, y: p.y - prev.y, z: p.z - prev.z };
      const hit = surface.raycast(prev, seg, 1);
      if (hit) {
        hitPoint = new THREE.Vector3(hit.point.x, hit.point.y, hit.point.z);
        pts.push(hitPoint.clone());
        break;
      }
      pts.push(p.clone());
      prev = p;
      if (p.y < surface.floorY) break;
    }
    const g = new THREE.BufferGeometry().setFromPoints(pts);
    this.streamLine = new THREE.Line(
      g,
      new THREE.LineDashedMaterial({
        color: 0x35e0ff,
        dashSize: 0.014,
        gapSize: 0.01,
        transparent: true,
        opacity: 0.85,
      })
    );
    this.streamLine.computeLineDistances();
    this.streamGroup.add(this.streamLine);

    if (hitPoint) {
      this.aimMarker.position.copy(hitPoint);
      this.aimMarker.visible = true;
    } else {
      this.aimMarker.visible = false;
    }
  }

  setStreamPathVisible(v: boolean): void {
    this.streamGroup.visible = v;
    this.aimMarker.visible = v && this.aimMarker.visible;
  }

  applyCameraPreset(preset: CameraPreset, surface: UrinalSurface, capture: CaptureScene): void {
    const b = surface.bounds();
    const cy = (b.min.y + b.max.y) * 0.5;
    const cz = (b.min.z + b.max.z) * 0.5;
    const span = Math.max(b.max.y - b.min.y, b.max.x - b.min.x) * 1.9;
    switch (preset) {
      case CameraPreset.Front:
        this.camera.position.set(0, cy, cz + span);
        break;
      case CameraPreset.Side:
        this.camera.position.set(span, cy, cz);
        break;
      case CameraPreset.Top:
        this.camera.position.set(0.001, b.max.y + span * 0.9, cz);
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
        this.camera.position.set(span * 0.62, cy + span * 0.42, cz + span * 0.78);
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
