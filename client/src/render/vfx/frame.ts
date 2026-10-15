// Primitivas de dibujo de un frame y pool de partículas, sin objetos por frame.
// El motor (engine.ts) rellena un Frame; cada modo lo pinta a su manera:
//   sprites  billboards con una forma del atlas (aditivos o normales)
//   decals   formas en el suelo: disco, anillo, aviso, cono, línea, runas
//   beams    haces entre dos puntos 3D
//   shells   esferas (escudos, cúpulas)
// Coordenadas: x, y del mundo (suelo) y z = altura.

export const SP = 11; // x y z size r g b a shape rot hot
export const DC = 13; // x y z sx sy rot r g b a type p1 p2
export const BM = 11; // x1 y1 z1 x2 y2 z2 w r g b a
export const SL = 9;  // x y z rad r g b a squash

export const DECAL = { DISC: 0, RING: 1, WARN: 2, CONE: 3, LINE: 4, RUNES: 5 } as const;

export class Frame {
  readonly spA: Float32Array; nA = 0;
  readonly spN: Float32Array; nN = 0;
  readonly dcA: Float32Array; nDA = 0;
  readonly dcN: Float32Array; nDN = 0;
  readonly bm: Float32Array; nB = 0;
  readonly sl: Float32Array; nS = 0;
  readonly capSprites: number; readonly capDecals: number; readonly capBeams: number; readonly capShells: number;
  constructor(capSprites: number, capDecals = 768, capBeams = 768, capShells = 160) {
    this.capSprites = capSprites; this.capDecals = capDecals; this.capBeams = capBeams; this.capShells = capShells;
    this.spA = new Float32Array(capSprites * SP);
    this.spN = new Float32Array(Math.floor(capSprites / 2) * SP);
    this.dcA = new Float32Array(capDecals * DC);
    this.dcN = new Float32Array(Math.floor(capDecals / 2) * DC);
    this.bm = new Float32Array(capBeams * BM);
    this.sl = new Float32Array(capShells * SL);
  }
  clear() { this.nA = this.nN = this.nDA = this.nDN = this.nB = this.nS = 0; }

  /** Billboard. hot: cuánto se blanquea el núcleo (0-1). normal: mezcla normal en vez de aditiva. */
  sprite(x: number, y: number, z: number, size: number, r: number, g: number, b: number, a: number, shape: number, rot = 0, hot = 0.8, normal = false) {
    if (a <= 0.004 || size <= 0) return;
    let arr: Float32Array, i: number;
    if (normal) { if (this.nN * SP >= this.spN.length) return; arr = this.spN; i = this.nN++ * SP; }
    else { if (this.nA >= this.capSprites) return; arr = this.spA; i = this.nA++ * SP; }
    arr[i] = x; arr[i + 1] = y; arr[i + 2] = z; arr[i + 3] = size;
    arr[i + 4] = r; arr[i + 5] = g; arr[i + 6] = b; arr[i + 7] = a;
    arr[i + 8] = shape; arr[i + 9] = rot; arr[i + 10] = hot;
  }

  /** Forma en el suelo. sx = radio (o semiancho), sy = semilargo (líneas), rot en radianes. */
  decal(type: number, x: number, y: number, sx: number, sy: number, rot: number, r: number, g: number, b: number, a: number, p1 = 0, p2 = 0, normal = false, z = 4) {
    if (a <= 0.004 || sx <= 0) return;
    // Anillos: grosor máximo absoluto, para que las ondas enormes no se conviertan en bandas.
    if (type === DECAL.RING && p1 * sx > 42) p1 = 42 / sx;
    let arr: Float32Array, i: number;
    if (normal) { if (this.nDN * DC >= this.dcN.length) return; arr = this.dcN; i = this.nDN++ * DC; }
    else { if (this.nDA >= this.capDecals) return; arr = this.dcA; i = this.nDA++ * DC; }
    arr[i] = x; arr[i + 1] = y; arr[i + 2] = z; arr[i + 3] = sx; arr[i + 4] = sy; arr[i + 5] = rot;
    arr[i + 6] = r; arr[i + 7] = g; arr[i + 8] = b; arr[i + 9] = a; arr[i + 10] = type; arr[i + 11] = p1; arr[i + 12] = p2;
  }

  beam(x1: number, y1: number, z1: number, x2: number, y2: number, z2: number, w: number, r: number, g: number, b: number, a: number) {
    if (a <= 0.004 || this.nB >= this.capBeams) return;
    const i = this.nB++ * BM, arr = this.bm;
    arr[i] = x1; arr[i + 1] = y1; arr[i + 2] = z1; arr[i + 3] = x2; arr[i + 4] = y2; arr[i + 5] = z2;
    arr[i + 6] = w; arr[i + 7] = r; arr[i + 8] = g; arr[i + 9] = b; arr[i + 10] = a;
  }

  shell(x: number, y: number, z: number, rad: number, r: number, g: number, b: number, a: number, squash = 1) {
    if (a <= 0.004 || this.nS >= this.capShells) return;
    const i = this.nS++ * SL, arr = this.sl;
    arr[i] = x; arr[i + 1] = y; arr[i + 2] = z; arr[i + 3] = rad;
    arr[i + 4] = r; arr[i + 5] = g; arr[i + 6] = b; arr[i + 7] = a; arr[i + 8] = squash;
  }
}

/** Plantilla de emisión: se crea una vez por estilo y se reutiliza. */
export interface Brush {
  /** Colores entre los que se mezcla cada partícula. */
  r1: number; g1: number; b1: number; r2: number; g2: number; b2: number;
  life: number; lifeVar: number;
  s0: number; s1: number;
  alpha: number;
  shape: number;
  normal: boolean;
  grav: number;
  drag: number;
  hot: number;
  spinVar: number;
}

export function brush(c1: [number, number, number], c2: [number, number, number], o: Partial<Brush> = {}): Brush {
  return {
    r1: c1[0], g1: c1[1], b1: c1[2], r2: c2[0], g2: c2[1], b2: c2[2],
    life: 0.6, lifeVar: 0.4, s0: 30, s1: 6, alpha: 1, shape: 0, normal: false, grav: 0, drag: 1.5, hot: 0.8, spinVar: 0, ...o,
  };
}

/** Pool fijo de partículas en arrays planos. Las muertas se compactan intercambiando con la última. */
export class ParticlePool {
  n = 0;
  readonly cap: number;
  private x: Float32Array; private y: Float32Array; private z: Float32Array;
  private vx: Float32Array; private vy: Float32Array; private vz: Float32Array;
  private age: Float32Array; private life: Float32Array;
  private s0: Float32Array; private s1: Float32Array;
  private r: Float32Array; private g: Float32Array; private b: Float32Array; private a: Float32Array;
  private shape: Uint8Array; private normal: Uint8Array;
  private grav: Float32Array; private drag: Float32Array; private hot: Float32Array;
  private rot: Float32Array; private vr: Float32Array;

  constructor(cap: number) {
    this.cap = cap;
    const F = () => new Float32Array(cap);
    this.x = F(); this.y = F(); this.z = F(); this.vx = F(); this.vy = F(); this.vz = F();
    this.age = F(); this.life = F(); this.s0 = F(); this.s1 = F();
    this.r = F(); this.g = F(); this.b = F(); this.a = F();
    this.shape = new Uint8Array(cap); this.normal = new Uint8Array(cap);
    this.grav = F(); this.drag = F(); this.hot = F(); this.rot = F(); this.vr = F();
  }

  /** Lleno en más de este porcentaje: los emisores reducen la densidad. */
  get load() { return this.n / this.cap; }

  spawn(br: Brush, x: number, y: number, z: number, vx: number, vy: number, vz: number, sizeMul = 1, lifeMul = 1) {
    if (this.n >= this.cap) return;
    const i = this.n++;
    // Tres tonos por pincel (no una mezcla continua): así el modo 2D cachea pocos sprites tintados.
    const m = Math.floor(Math.random() * 3) * 0.5;
    this.x[i] = x; this.y[i] = y; this.z[i] = z; this.vx[i] = vx; this.vy[i] = vy; this.vz[i] = vz;
    this.age[i] = 0; this.life[i] = Math.max(0.05, (br.life + (Math.random() - 0.5) * 2 * br.lifeVar * br.life) * lifeMul);
    this.s0[i] = br.s0 * sizeMul; this.s1[i] = br.s1 * sizeMul;
    this.r[i] = br.r1 + (br.r2 - br.r1) * m; this.g[i] = br.g1 + (br.g2 - br.g1) * m; this.b[i] = br.b1 + (br.b2 - br.b1) * m;
    this.a[i] = br.alpha; this.shape[i] = br.shape; this.normal[i] = br.normal ? 1 : 0;
    this.grav[i] = br.grav; this.drag[i] = br.drag; this.hot[i] = br.hot;
    this.rot[i] = br.spinVar ? Math.random() * Math.PI * 2 : 0; this.vr[i] = (Math.random() - 0.5) * br.spinVar;
  }

  step(dt: number, out: Frame) {
    let i = 0;
    while (i < this.n) {
      const age = (this.age[i] += dt);
      const life = this.life[i];
      if (age >= life) { this.kill(i); continue; }
      const k = age / life;
      const dr = Math.max(0, 1 - this.drag[i] * dt);
      this.vx[i] *= dr; this.vy[i] *= dr; this.vz[i] = this.vz[i] * dr - this.grav[i] * dt;
      this.x[i] += this.vx[i] * dt; this.y[i] += this.vy[i] * dt; this.z[i] += this.vz[i] * dt;
      if (this.z[i] < 0) { this.z[i] = 0; this.vz[i] *= -0.3; }
      this.rot[i] += this.vr[i] * dt;
      // Entrada rápida y salida suave.
      const fade = k < 0.12 ? k / 0.12 : 1 - (k - 0.12) / 0.88;
      const size = this.s0[i] + (this.s1[i] - this.s0[i]) * k;
      out.sprite(this.x[i], this.y[i], this.z[i], size, this.r[i], this.g[i], this.b[i], this.a[i] * fade * (2 - fade), this.shape[i], this.rot[i], this.hot[i] * (1 - k * 0.6), this.normal[i] === 1);
      i++;
    }
  }

  private kill(i: number) {
    const j = --this.n;
    if (i === j) return;
    this.x[i] = this.x[j]; this.y[i] = this.y[j]; this.z[i] = this.z[j];
    this.vx[i] = this.vx[j]; this.vy[i] = this.vy[j]; this.vz[i] = this.vz[j];
    this.age[i] = this.age[j]; this.life[i] = this.life[j]; this.s0[i] = this.s0[j]; this.s1[i] = this.s1[j];
    this.r[i] = this.r[j]; this.g[i] = this.g[j]; this.b[i] = this.b[j]; this.a[i] = this.a[j];
    this.shape[i] = this.shape[j]; this.normal[i] = this.normal[j];
    this.grav[i] = this.grav[j]; this.drag[i] = this.drag[j]; this.hot[i] = this.hot[j];
    this.rot[i] = this.rot[j]; this.vr[i] = this.vr[j];
  }

  clear() { this.n = 0; }
}
