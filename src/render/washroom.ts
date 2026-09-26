import * as THREE from 'three';

/**
 * The room the fixture reflects.
 *
 * Wet glaze is a mirror at grazing incidence, so what a wet urinal looks like is
 * mostly a picture of the room it is in. That makes the environment a physical
 * input to the appearance rather than set dressing, and it has to be *this* room:
 * a washroom is lit by long overhead luminaires over light tiled walls and a
 * darker floor, and it is the reflected bar of a luminaire drawn out across a
 * running film that says "liquid" faster than any amount of specular tuning.
 *
 * This replaces three's `RoomEnvironment`, which is a photographic studio with
 * area emitters at intensities of 17 to 100. Two problems, both real here. It is
 * the wrong room -- a fixture reflecting a studio softbox does not look like
 * plumbing. And its absolute scale is arbitrary: PMREM convolves it into an
 * irradiance of order one, but a raw cube capture of the same scene carries the
 * emitters at face value, so the same environment used by the casting through
 * `scene.environment` and by the interior through a cube map came out two orders
 * of magnitude apart and the interior blew to white.
 *
 * Every value below is a *radiance* in linear working space -- what a camera in
 * the room would measure looking at that surface -- because that is exactly what
 * an environment map holds. `MeshBasicMaterial` is therefore correct rather than
 * lazy: these surfaces are not to be lit, they are the light.
 */

/** Sphere-averaged radiance of the room below, for calibrating exposure. */
export const WASHROOM_MEAN_RADIANCE = 1.1;

const basic = (r: number, g: number, b: number): THREE.MeshBasicMaterial =>
  new THREE.MeshBasicMaterial({ color: new THREE.Color().setRGB(r, g, b) });

/**
 * Build the washroom as a scene suitable for `PMREMGenerator.fromScene` and for
 * a `CubeCamera` capture. Caller disposes.
 */
export function buildWashroom(): THREE.Scene {
  const scene = new THREE.Scene();

  const box = new THREE.BoxGeometry(1, 1, 1);
  const plane = new THREE.PlaneGeometry(1, 1);

  const add = (
    geo: THREE.BufferGeometry,
    mat: THREE.Material,
    pos: [number, number, number],
    scale: [number, number, number],
    rot?: [number, number, number]
  ): THREE.Mesh => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(pos[0], pos[1], pos[2]);
    m.scale.set(scale[0], scale[1], scale[2]);
    if (rot) m.rotation.set(rot[0], rot[1], rot[2]);
    scene.add(m);
    return m;
  };

  // The room itself, seen from inside. Light glazed wall tile is a high-value
  // surface but not a white one -- around 0.45 in linear terms, which is the
  // mid-grey a tiled wall photographs as.
  const shell = new THREE.Mesh(box, basic(0.44, 0.46, 0.48));
  shell.material.side = THREE.BackSide;
  shell.scale.set(6, 3.1, 6);
  shell.position.set(0, 1.35, 0);
  scene.add(shell);

  // Ceiling: brighter than the walls, which is what makes a horizontal surface
  // below it read as horizontal.
  add(plane, basic(0.72, 0.73, 0.75), [0, 2.88, 0], [6, 6, 1], [Math.PI / 2, 0, 0]);

  // Floor: dark tile. The contrast between a bright ceiling and a dark floor is
  // the whole of why a vertical wet wall shows a bright band near the top and a
  // dark one near the bottom, which is the gradient that reads as "reflective".
  add(plane, basic(0.10, 0.105, 0.115), [0, -0.2, 0], [6, 6, 1], [-Math.PI / 2, 0, 0]);

  // A darker dado to about a metre, as tiled washrooms almost always have.
  const dado = basic(0.20, 0.21, 0.225);
  dado.side = THREE.BackSide;
  add(box, dado, [0, 0.42, 0], [5.98, 0.85, 5.98]);

  // Three overhead luminaires, at forty times the radiance of the wall they light.
  //
  // That ratio is the point, and it is roughly what a real fitting has: a lit
  // diffuser runs a hundred or more times the luminance of the wall beside it. The
  // reflection of a luminaire in a wet film arrives multiplied by a Fresnel term of
  // three or four percent at the angles a urinal is actually seen from, so a lamp
  // only a few times brighter than the ceramic reflects as something *dimmer* than
  // the ceramic and the film shows nothing at all. At forty the same reflection is
  // brighter than the glaze and reads as a highlight, which is the cue.
  //
  // They occupy about 1.5% of the room's surface, so they add roughly 0.6 to the
  // sphere average -- real, and it is real in a washroom too, where the ceiling
  // fittings are most of the illumination. The renderer tone maps, so the extra
  // range costs highlights rather than clipping them.
  const lamp = basic(40, 40, 38);
  for (const z of [-1.6, 0, 1.6]) {
    add(plane, lamp, [0, 2.86, z], [3.4, 0.22, 1], [Math.PI / 2, 0, 0]);
  }

  // The wall the fixture hangs on, a little brighter than the side walls because
  // it faces the lights squarely. It is also the surface most often reflected in
  // the front of a wall-hung bowl.
  add(plane, basic(0.52, 0.53, 0.55), [0, 1.2, -2.98], [6, 3, 1]);

  return scene;
}

/** Dispose everything `buildWashroom` allocated. */
export function disposeWashroom(scene: THREE.Scene): void {
  scene.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    m.geometry.dispose();
    const mat = m.material as THREE.Material | THREE.Material[];
    if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
    else mat.dispose();
  });
}
