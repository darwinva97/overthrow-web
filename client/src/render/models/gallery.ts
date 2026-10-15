// Galería de pruebas: monta muchos modelos en rejilla para revisarlos con capturas.
// No la usa el juego. Se compila aparte (esbuild) y se abre con parámetros en la URL:
//   ?set=heroes|creeps|wards&from=0&count=24&cols=8&act=idle|walk|attack|strike|cast|chan|stun|death&t=0.6&zoom=1
import * as THREE from 'three';
import { LOOKS } from './appearance';
import { newAnim, pose, rigOf, step, type AnimIn } from './animate';
import { instantiate, unitMaterial, type ModelDef } from './builder';
import { CREEP_SAMPLES, WARD_SAMPLES, heroModel, hexModel, unitModel } from './index';

const q = new URLSearchParams(location.search);
const set = q.get('set') ?? 'heroes';
const from = +(q.get('from') ?? 0);
const cols = +(q.get('cols') ?? 8);
const act = q.get('act') ?? 'idle';
const T = +(q.get('t') ?? 0.6);
const zoom = +(q.get('zoom') ?? 1);
const W = +(q.get('w') ?? 1600), H = +(q.get('h') ?? 1000);
const only = q.get('only')?.split(',');

let names: string[] = set === 'heroes' ? Object.keys(LOOKS) : set === 'creeps' ? CREEP_SAMPLES : WARD_SAMPLES.concat(['hex']);
if (only) names = only;
names = names.slice(from, from + +(q.get('count') ?? names.length));

const gl = new THREE.WebGLRenderer({ antialias: true });
gl.setSize(W, H);
gl.shadowMap.enabled = true;
gl.shadowMap.type = THREE.PCFSoftShadowMap;
gl.outputColorSpace = THREE.SRGBColorSpace;
gl.toneMapping = THREE.ACESFilmicToneMapping;
document.body.appendChild(gl.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color('#0c0a10');
scene.add(new THREE.HemisphereLight(0xc8c0ff, 0x2a2018, 1.1));
const sun = new THREE.DirectionalLight(0xfff1d6, 2.3);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -1600, right: 1600, top: 1600, bottom: -1600, near: 100, far: 6000 });
sun.shadow.bias = -0.0008;
scene.add(sun, sun.target);

const spacing = set === 'heroes' ? 190 : 170;
const rows = Math.ceil(names.length / cols);
const gw = (cols - 1) * spacing, gh = (rows - 1) * spacing;
const ground = new THREE.Mesh(new THREE.PlaneGeometry(gw + 800, gh + 800), new THREE.MeshStandardMaterial({ color: '#3d4a2c', roughness: 0.95 }));
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

interface Item { name: string; def: ModelDef; inst: ReturnType<typeof instantiate>; rig: ReturnType<typeof rigOf>; st: ReturnType<typeof newAnim>; g: THREE.Group }
const items: Item[] = names.map((name, i) => {
  const def = set === 'heroes' ? heroModel(name) : name === 'hex' ? hexModel() : unitModel(set === 'wards' ? 'ward' : 'creep', name);
  const inst = instantiate(def, unitMaterial());
  inst.mesh.castShadow = true;
  const g = new THREE.Group();
  g.add(inst.mesh);
  g.scale.setScalar(def.scale);
  const x = (i % cols) * spacing - gw / 2, z = Math.floor(i / cols) * spacing - gh / 2;
  g.position.set(x, 0, z);
  g.rotation.y = q.get('face') === 'side' ? 0 : -Math.PI / 2 + 0.5; // mirando a cámara, algo girados
  scene.add(g);
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.82, 1, 40).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: i % 2 ? '#d84a3a' : '#3a8ad8', transparent: true, opacity: 0.85, depthWrite: false }));
  ring.scale.setScalar(40); ring.position.set(x, 2, z);
  scene.add(ring);
  return { name, def, inst, rig: rigOf(inst), st: newAnim((i * 0.37) % 1), g };
});

// Simula el estado pedido hasta el instante T.
const dt = 1 / 60;
for (let t = 0; t < T; t += dt) {
  const inp: AnimIn = { speed: act === 'walk' ? 320 : 0, attacking: false, cast: 0, stunned: act === 'stun', aim: q.get('aim') === '1' };
  if (act === 'attack') inp.attacking = true;
  if (act === 'strike') inp.attacking = t < T - 0.1;
  if (act === 'cast') inp.cast = 1;
  if (act === 'chan') inp.cast = 2;
  for (const it of items) {
    if (act === 'death' && it.st.dead < 0) it.st.dead = 0;
    step(it.st, inp, dt, it.def.scale);
  }
}
for (const it of items) pose(it.inst, it.rig, it.st);

const cam = new THREE.PerspectiveCamera(40, W / H, 20, 20000);
const pitch = (+(q.get("pitch") ?? 56) * Math.PI) / 180;
const pitchQ = +(q.get("pitch") ?? 56);
const dist = Math.max((gw + spacing * 1.3) / (2 * Math.tan((20 * Math.PI) / 180) * (W / H)), (gh + spacing * 1.5) / (2 * Math.tan((20 * Math.PI) / 180)) / Math.sin((pitchQ * Math.PI) / 180)) / zoom;
cam.position.set(0, Math.sin(pitch) * dist, Math.cos(pitch) * dist + 30);
cam.lookAt(0, 40, 30);
sun.position.set(-900, 2600, 700);
gl.render(scene, cam);

// Nombres
const ov = document.createElement('canvas');
ov.width = W; ov.height = H;
Object.assign(ov.style, { position: 'absolute', left: '0', top: '0' });
document.body.appendChild(ov);
const c = ov.getContext('2d')!;
c.font = '13px sans-serif'; c.textAlign = 'center';
const v = new THREE.Vector3();
let calls = 0;
for (const it of items) {
  v.set(it.g.position.x, -8, it.g.position.z + 46).project(cam);
  const sx = (v.x + 1) / 2 * W, sy = (1 - v.y) / 2 * H;
  c.fillStyle = 'rgba(0,0,0,.55)'; c.fillRect(sx - 60, sy - 12, 120, 17);
  c.fillStyle = '#fff'; c.fillText(it.name, sx, sy);
}
calls = gl.info.render.calls;
const tris = items.map((it) => (it.def.geo.attributes.position.count / 3) | 0);
(window as unknown as { done: unknown }).done = { calls, tris: tris.reduce((a, b) => a + b, 0), max: Math.max(...tris), n: items.length, bones: Math.max(...items.map((i) => i.inst.bones.length)) };
