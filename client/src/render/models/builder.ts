// Constructor de modelos procedurales: piezas low-poly (elipsoides, tubos, conos, cajas,
// láminas extruidas) que se cuelgan de huesos y se fusionan en una sola geometría con
// pesos rígidos. Cada unidad es así una SkinnedMesh: una llamada de dibujo para todo el cuerpo,
// con material y textura de paleta compartidos por todas las unidades.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { glowTex, paletteRow, paletteTex, type PaletteRow } from './palette';

export type V3 = [number, number, number];
export interface BoneDef { name: string; parent: number; pos: V3 }

/** Qué sistemas de animación usa un modelo (ver animate.ts). */
export interface AnimSpec {
  /** Bípedo: 'walk' anda, 'float' flota sin piernas, 'seated' va montado, 'none' sin bípedo. */
  biped: 'walk' | 'float' | 'seated' | 'none';
  /** Cuadrúpedo propio ('') o montura ('m'). */
  quad?: '' | 'm';
  /** Patas de insecto: número de patas (bones leg0..legN-1). */
  insect?: number;
  wings?: 'flap' | 'glide' | 'buzz';
  tail?: 'wag' | 'snake' | 'sway';
  /** Altura de vuelo sobre el suelo. */
  hover?: number;
  /** Pieza que gira sola (rotor, orbes). */
  spin?: number;
  /** Ruedas (bones wheelL/wheelR) que giran al avanzar. */
  wheels?: boolean;
  /** Estilo del golpe. */
  strike: Strike;
  /** Estructura sin vida: no respira ni anda (wards, tumbas). */
  still?: boolean;
  /** Cuerpo amorfo: late y gira. */
  blob?: boolean;
}

export type Strike = 'slash' | 'chop' | 'thrust' | 'bow' | 'gun' | 'cast' | 'punch' | 'dual' | 'bite' | 'claw' | 'whip' | 'none';

/** Pose de reposo de los brazos de un bípedo según su golpe: [brazoD, codoD, brazoI, codoI] (giro en Z). */
export const IDLE_ARM: Record<Strike, [number, number, number, number]> = {
  slash: [0.1, 0.35, 0.05, 0.25], chop: [0.15, 0.45, 0.15, 0.45], thrust: [0.1, 0.55, 0.05, 0.4],
  bow: [0.05, 0.2, 0.35, 0.5], gun: [0.3, 0.6, 0.1, 0.35], cast: [0.05, 0.3, 0.05, 0.3],
  punch: [0.15, 1.0, 0.15, 1.0], dual: [0.15, 0.5, 0.15, 0.5], claw: [0.2, 0.6, 0.2, 0.6],
  whip: [0.1, 0.4, 0.05, 0.25], bite: [0.05, 0.25, 0.05, 0.25], none: [0.05, 0.25, 0.05, 0.25],
};

export interface ModelDef {
  key: string;
  geo: THREE.BufferGeometry;
  bones: BoneDef[];
  inverses: THREE.Matrix4[];
  anim: AnimSpec;
  /** Altura de la cabeza en unidades del modelo (sin escala). */
  height: number;
  scale: number;
  sphere: THREE.Sphere;
  shadow: boolean;
  /** Índice de cada papel de hueso, resuelto una vez. */
  roles: Record<string, number>;
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

export interface PartOpts { rot?: V3; lit?: number; detail?: number; seg?: number }

export const lr = (s: number) => (s < 0 ? 'L' : 'R');

export class Builder {
  readonly key: string;
  readonly pal: PaletteRow;
  bones: BoneDef[] = [{ name: 'root', parent: -1, pos: [0, 0, 0] }];
  private parts: THREE.BufferGeometry[] = [];
  /** Transformación activa: todo lo que se añade (piezas y pivotes) pasa por ella. */
  private xf: THREE.Matrix4 | null = null;
  private stack: (THREE.Matrix4 | null)[] = [];

  /** Aplica una transformación a lo que se construya dentro de fn. */
  within(m: THREE.Matrix4, fn: () => void) {
    this.stack.push(this.xf);
    this.xf = this.xf ? this.xf.clone().multiply(m) : m.clone();
    try { fn(); } finally { this.xf = this.stack.pop() ?? null; }
  }
  /** Atajo: traslada (y opcionalmente gira y escala) lo construido dentro de fn. */
  at(pos: V3, fn: () => void, rot: V3 = [0, 0, 0], scale = 1) {
    _e.set(rot[0], rot[1], rot[2]);
    this.within(new THREE.Matrix4().compose(new THREE.Vector3(...pos), new THREE.Quaternion().setFromEuler(_e), new THREE.Vector3(scale, scale, scale)), fn);
  }
  /** Punto transformado por la transformación activa. */
  pt(p: V3): V3 {
    if (!this.xf) return p;
    _p.set(p[0], p[1], p[2]).applyMatrix4(this.xf);
    return [_p.x, _p.y, _p.z];
  }

  constructor(key: string) {
    this.key = key;
    this.pal = paletteRow(key);
  }

  idx(name: string): number {
    const i = this.bones.findIndex((b) => b.name === name);
    return i;
  }
  has(name: string) { return this.idx(name) >= 0; }

  /** Añade un hueso con pivote absoluto `pos` (pose de reposo sin giros). */
  bone(name: string, parent: string, pos: V3) {
    pos = this.pt(pos);
    const p = this.idx(parent);
    const existing = this.idx(name);
    if (existing >= 0) { this.bones[existing] = { name, parent: p, pos }; return this; }
    this.bones.push({ name, parent: p < 0 ? 0 : p, pos });
    return this;
  }

  /** Geometría cualquiera ya colocada; la pinta del color y la ata al hueso. */
  add(bone: string, col: string, g: THREE.BufferGeometry, lit = 0) {
    let bi = this.idx(bone);
    if (bi < 0) bi = 0;
    const geo = g.index ? g.toNonIndexed() : g;
    if (geo !== g) g.dispose();
    if (this.xf) geo.applyMatrix4(this.xf);
    for (const k of Object.keys(geo.attributes)) if (k !== 'position' && k !== 'normal') geo.deleteAttribute(k);
    if (!geo.attributes.normal) geo.computeVertexNormals();
    const n = geo.attributes.position.count;
    const [u, v] = this.pal.uv(col, lit);
    const uv = new Float32Array(n * 2);
    const si = new Uint16Array(n * 4);
    const sw = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) { uv[i * 2] = u; uv[i * 2 + 1] = v; si[i * 4] = bi; sw[i * 4] = 1; }
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
    geo.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4));
    this.parts.push(geo);
    return this;
  }

  private place(g: THREE.BufferGeometry, c: V3, scale: V3, rot?: V3) {
    _e.set(rot?.[0] ?? 0, rot?.[1] ?? 0, rot?.[2] ?? 0);
    _q.setFromEuler(_e);
    _m.compose(_p.set(c[0], c[1], c[2]), _q, _s.set(scale[0], scale[1], scale[2]));
    g.applyMatrix4(_m);
    return g;
  }

  /** Elipsoide facetado de radios r. */
  ell(bone: string, col: string, c: V3, r: V3, o: PartOpts = {}) {
    const g = new THREE.IcosahedronGeometry(1, o.detail ?? 1);
    return this.add(bone, col, this.place(g, c, r, o.rot), o.lit);
  }

  /** Esfera baja de polígonos con segmentos (más redonda que el icosaedro). */
  ball(bone: string, col: string, c: V3, r: V3, o: PartOpts = {}) {
    const seg = o.seg ?? 8;
    const g = new THREE.SphereGeometry(1, seg, Math.max(3, Math.round(seg * 0.6)));
    return this.add(bone, col, this.place(g, c, r, o.rot), o.lit);
  }

  box(bone: string, col: string, c: V3, s: V3, o: PartOpts = {}) {
    const g = new THREE.BoxGeometry(1, 1, 1);
    return this.add(bone, col, this.place(g, c, s, o.rot), o.lit);
  }

  /** Cilindro o tronco de cono vertical centrado en c. */
  cyl(bone: string, col: string, c: V3, rTop: number, rBot: number, h: number, o: PartOpts = {}) {
    const g = new THREE.CylinderGeometry(rTop, rBot, h, o.seg ?? 7);
    return this.add(bone, col, this.place(g, c, [1, 1, 1], o.rot), o.lit);
  }

  /** Tubo de a a b con radios r0 (en a) y r1 (en b). */
  tube(bone: string, col: string, a: V3, b: V3, r0: number, r1 = r0, o: PartOpts = {}) {
    _a.set(a[0], a[1], a[2]); _b.set(b[0], b[1], b[2]);
    const len = _a.distanceTo(_b);
    if (len < 1e-3) return this;
    const g = new THREE.CylinderGeometry(r1, r0, len, o.seg ?? 6);
    _b.sub(_a).normalize();
    _q.setFromUnitVectors(UP, _b);
    _m.compose(_p.set((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2), _q, _s.set(1, 1, 1));
    g.applyMatrix4(_m);
    return this.add(bone, col, g, o.lit);
  }

  /** Cono de la base a la punta. */
  cone(bone: string, col: string, base: V3, tip: V3, r: number, o: PartOpts = {}) {
    _a.set(base[0], base[1], base[2]); _b.set(tip[0], tip[1], tip[2]);
    const len = _a.distanceTo(_b);
    if (len < 1e-3) return this;
    const g = new THREE.ConeGeometry(r, len, o.seg ?? 6);
    _b.sub(_a).normalize();
    _q.setFromUnitVectors(UP, _b);
    _m.compose(_p.set((base[0] + tip[0]) / 2, (base[1] + tip[1]) / 2, (base[2] + tip[2]) / 2), _q, _s.set(1, 1, 1));
    g.applyMatrix4(_m);
    return this.add(bone, col, g, o.lit);
  }

  /** Cuerno curvo: cadena de conos que sigue los puntos. */
  horn(bone: string, col: string, pts: V3[], r: number, o: PartOpts = {}) {
    for (let i = 0; i < pts.length - 1; i++) {
      const k0 = 1 - i / (pts.length - 1), k1 = 1 - (i + 1) / (pts.length - 1);
      if (i === pts.length - 2) this.cone(bone, col, pts[i], pts[i + 1], r * k0 + 0.3, { seg: o.seg ?? 5, lit: o.lit });
      else this.tube(bone, col, pts[i], pts[i + 1], r * k0 + 0.3, r * k1 + 0.3, { seg: o.seg ?? 5, lit: o.lit });
    }
    return this;
  }

  torus(bone: string, col: string, c: V3, R: number, r: number, o: PartOpts & { arc?: number; tub?: number } = {}) {
    const g = new THREE.TorusGeometry(R, r, o.seg ?? 4, o.tub ?? 12, o.arc ?? Math.PI * 2);
    return this.add(bone, col, this.place(g, c, [1, 1, 1], o.rot), o.lit);
  }

  /** Lámina: polígono 2D (en el plano XY) extruido con grosor `depth` a lo largo de Z. */
  plate(bone: string, col: string, pts: [number, number][], depth: number, c: V3, o: PartOpts & { scale?: V3; plane?: 'xy' | 'zy' } = {}) {
    const sh = new THREE.Shape(pts.map(([x, y]) => new THREE.Vector2(x, y)));
    const g = new THREE.ExtrudeGeometry(sh, { depth, bevelEnabled: false, curveSegments: 2 });
    g.translate(0, 0, -depth / 2);
    // 'zy': la X del perfil pasa a ser la Z del modelo (láminas que miran hacia delante o atrás).
    if (o.plane === 'zy') g.rotateY(-Math.PI / 2);
    return this.add(bone, col, this.place(g, c, o.scale ?? [1, 1, 1], o.rot), o.lit);
  }

  /** Sólido de revolución: perfil [radio, altura]. */
  lathe(bone: string, col: string, prof: [number, number][], c: V3, o: PartOpts & { scale?: V3 } = {}) {
    const g = new THREE.LatheGeometry(prof.map(([r, y]) => new THREE.Vector2(Math.max(0.01, r), y)), o.seg ?? 7);
    return this.add(bone, col, this.place(g, c, o.scale ?? [1, 1, 1], o.rot), o.lit);
  }

  /** Cierra el modelo: fusiona y calcula las matrices inversas de la pose de reposo. */
  finish(anim: AnimSpec, height: number, scale: number, shadow: boolean): ModelDef {
    const geo = this.parts.length ? mergeGeometries(this.parts, false)! : new THREE.BufferGeometry();
    for (const p of this.parts) p.dispose();
    this.parts = [];
    geo.computeBoundingSphere();
    const inverses = this.bones.map((b) => new THREE.Matrix4().makeTranslation(-b.pos[0], -b.pos[1], -b.pos[2]));
    const r = Math.max(height, geo.boundingSphere?.radius ?? height) * 1.15;
    const roles: Record<string, number> = {};
    this.bones.forEach((b, i) => { roles[b.name] = i; });
    return {
      key: this.key, geo, bones: this.bones, inverses, anim, height, scale,
      sphere: new THREE.Sphere(new THREE.Vector3(0, height * 0.5, 0), r), shadow, roles,
    };
  }
}

// ---------------------------------------------------------------------------
// Instancias

const IDENT = new THREE.Matrix4();

export interface ModelInst {
  def: ModelDef;
  mesh: THREE.SkinnedMesh;
  bones: THREE.Bone[];
  /** Pose de reposo (posición local) de cada hueso, para animar con desplazamientos. */
  rest: THREE.Vector3[];
}

export function instantiate(def: ModelDef, mat: THREE.Material): ModelInst {
  const mesh = new THREE.SkinnedMesh(def.geo, mat);
  const bones = def.bones.map((d) => { const b = new THREE.Bone(); b.name = d.name; return b; });
  def.bones.forEach((d, i) => {
    const b = bones[i];
    if (d.parent < 0) { b.position.set(d.pos[0], d.pos[1], d.pos[2]); mesh.add(b); return; }
    const p = def.bones[d.parent].pos;
    b.position.set(d.pos[0] - p[0], d.pos[1] - p[1], d.pos[2] - p[2]);
    bones[d.parent].add(b);
  });
  const skel = new THREE.Skeleton(bones, def.inverses);
  mesh.bind(skel, IDENT);
  mesh.boundingSphere = def.sphere;
  mesh.castShadow = def.shadow;
  mesh.receiveShadow = false;
  return { def, mesh, bones, rest: bones.map((b) => b.position.clone()) };
}

// ---------------------------------------------------------------------------
// Materiales compartidos

const matCache = new Map<string, THREE.MeshStandardMaterial>();

function rim(m: THREE.MeshStandardMaterial) {
  // Luz de contorno: separa a las unidades del suelo vistas desde lejos.
  m.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader.replace('#include <opaque_fragment>', `
      outgoingLight += vec3(0.20, 0.19, 0.26) * pow(1.0 - clamp(abs(dot(normal, normalize(vViewPosition))), 0.0, 1.0), 2.5);
      #include <opaque_fragment>`);
  };
  m.customProgramCacheKey = () => 'unit-rim';
  return m;
}

export type Tint = 'none' | 'flash' | 'illusion' | 'flash-illusion';

function makeMat(tint: Tint, alpha: number) {
  const m = rim(new THREE.MeshStandardMaterial({
    map: paletteTex, emissiveMap: glowTex, emissive: 0xffffff, emissiveIntensity: 1.4,
    roughness: 0.78, metalness: 0, flatShading: true,
  }));
  if (tint === 'flash') m.color.setRGB(2.6, 2.1, 2.0);
  if (tint === 'illusion') { m.color.setRGB(0.55, 0.8, 1.7); }
  if (tint === 'flash-illusion') m.color.setRGB(1.6, 2.0, 3.0);
  if (alpha < 1) { m.transparent = true; m.opacity = alpha; }
  return m;
}

/** Material compartido para un tinte y una opacidad (cuantizada). */
export function unitMaterial(tint: Tint = 'none', alpha = 1): THREE.MeshStandardMaterial {
  const a = Math.round(alpha * 20) / 20;
  const key = tint + a;
  let m = matCache.get(key);
  if (!m) { m = makeMat(tint, a); matCache.set(key, m); }
  return m;
}

/** Material propio (para fundidos de muerte); hay que liberarlo con dispose. */
export function ownMaterial(tint: Tint): THREE.MeshStandardMaterial {
  const m = makeMat(tint, 0.99);
  return m;
}
