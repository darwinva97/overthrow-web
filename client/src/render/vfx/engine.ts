// Motor de efectos compartido por los dos modos: convierte eventos, estados, proyectiles y zonas
// en primitivas (Frame) y simula las partículas. No sabe nada de Canvas ni de Three.js.
import type { Fx } from '../../../../shared/sim/types';
import { ST } from '../../../../shared/sim/types';
import type { VUnit } from '../../game/state';
import { ORB_COLOR } from '../fxstyle';
import type { View } from '../types';
import { SH } from './atlas';
import {
  castLook, fxStyle, hexRgb, lighten, projStyle, statusStyle, zoneStyle,
  type FxDef, type ProjDef, type Resolved, type StatusDef, type ZoneDef,
} from './catalog';
import { brush, DECAL, Frame, ParticlePool, type Brush } from './frame';

type RGB = [number, number, number];

/** Pinceles y colores precalculados de un estilo (uno por estilo resuelto). */
interface Kit {
  c: RGB; c2: RGB;
  /** Chispas con la forma del estilo. */
  spark: Brush;
  /** Brillos pequeños redondos. */
  mote: Brush;
  /** Humo o polvo (mezcla normal). */
  smoke: Brush;
  /** Trozos que caen con gravedad (esquirlas, gotas). */
  chunk: Brush;
}

interface Live {
  s: Resolved<FxDef>;
  def: FxDef;
  kit: Kit;
  f: Fx;
  t: number;
  d: number;
  seed: number;
  /** Estado propio (impacto ya ocurrido, fin ya lanzado…). */
  flag: number;
}

export interface Bounds { x0: number; y0: number; x1: number; y1: number }

export interface EngineOpts {
  /** Capacidad de sprites del frame y de partículas del pool. */
  sprites: number;
  particles: number;
  /** Altura extra de las unidades voladoras (3D: 120; 2D: 0). */
  flyLift: number;
  /** Multiplicador global de partículas. */
  density: number;
  /** Altura de la cabeza de una unidad (si el modo la conoce mejor). */
  headOf?: (u: VUnit) => number;
}

const TAU = Math.PI * 2;
const ease = (k: number) => 1 - (1 - k) * (1 - k);
const clamp01 = (k: number) => (k < 0 ? 0 : k > 1 ? 1 : k);
const rnd = (a: number, b: number) => a + Math.random() * (b - a);
/** Ruido determinista barato. */
const hash = (n: number) => { const s = Math.sin(n * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s); };

export class VfxEngine {
  readonly frame: Frame;
  readonly pool: ParticlePool;
  private live: Live[] = [];
  private spare: Live[] = [];
  private kits = new Map<object, Kit>();
  private projPrev = new Map<number, { x: number; y: number; seen: number; acc: number; s: Resolved<ProjDef> | null }>();
  private zoneBorn = new Map<number, number>();
  private clock = 0;
  private frameNo = 0;
  private dens = 1;
  private opts: EngineOpts;
  private b: Bounds | null = null;
  /** Estadísticas del último frame. */
  readonly info = { live: 0, particles: 0, sprites: 0, decals: 0, beams: 0, shells: 0, tLive: 0, tUnits: 0, tProj: 0, tSim: 0 };

  constructor(opts: EngineOpts) {
    this.opts = opts;
    this.frame = new Frame(opts.sprites);
    this.pool = new ParticlePool(opts.particles);
  }

  // ------------------------------------------------------------ utilidades

  private kit(s: { c: string; c2: string; sh: number; dark: boolean }, key: object): Kit {
    let k = this.kits.get(key);
    if (k) return k;
    const c = hexRgb(s.c), c2 = hexRgb(s.c2);
    const dk = hexRgb(s.dark ? s.c : lighten(s.c, 0.15));
    k = {
      c, c2,
      spark: brush(c, c2, { shape: s.sh, s0: 28, s1: 6, life: 0.55, lifeVar: 0.4, drag: 2.2, hot: 0.3, spinVar: 3 }),
      mote: brush(c2, c, { shape: SH.SPARK, s0: 16, s1: 4, life: 0.6, lifeVar: 0.4, drag: 1.2, hot: 0.5 }),
      smoke: brush(dk, [dk[0] * 0.55, dk[1] * 0.55, dk[2] * 0.55], { shape: SH.SMOKE, s0: 60, s1: 150, life: 1, lifeVar: 0.3, drag: 1.6, alpha: 0.55, normal: true, hot: 0, spinVar: 1 }),
      chunk: brush(c, c2, { shape: s.sh === SH.GLOW ? SH.SPARK : s.sh, s0: 22, s1: 12, life: 0.8, lifeVar: 0.3, drag: 0.6, grav: 1400, hot: 0.5, spinVar: 6 }),
    };
    this.kits.set(key, k);
    return k;
  }

  private visible(x: number, y: number, m: number) {
    const b = this.b;
    return !b || (x > b.x0 - m && x < b.x1 + m && y > b.y0 - m && y < b.y1 + m);
  }

  /** Altura de la cabeza de una unidad sobre su base. */
  head(u: VUnit) {
    if (this.opts.headOf) return this.opts.headOf(u);
    return u.k === 'hero' || u.k === 'illusion' ? 180 : u.k === 'creep' || u.k === 'summon' ? 120 : u.k === 'ward' ? 90 : u.k === 'throne' || u.k === 'fountain' ? 260 : 110;
  }
  private base(u: VUnit) { return (u.s & ST.flying) !== 0 ? this.opts.flyLift : 0; }
  private radius(u: VUnit) { return u.k === 'hero' || u.k === 'illusion' ? 34 : Math.max(20, u.r * 1.2); }

  // ------------------------------------------------------------ eventos

  fx(f: Fx, v: View) {
    if (f.n === 'cast') { this.cast(f); return; }
    const s = fxStyle(f);
    if (!s) return;
    let def = s.def;
    let kitKey: object = s;
    let res = s;
    if (f.n === 'orb_throw') {
      const col = ORB_COLOR[f.c ?? 'common'] ?? '#ffffff';
      res = { ...s, c: col, c2: lighten(col, 0.7) };
      kitKey = (ORB_KEYS[col] ??= {});
    }
    // Sin campos para dibujar un haz: se queda en impacto.
    if ((def.k === 'beam' || def.k === 'chain') && f.x2 === undefined && f.u2 === undefined && !def.sky) def = { ...def, k: 'impact' };
    this.push(res, def, this.kit(res, kitKey), f, f.d ?? def.d ?? DEFAULT_D[def.k]);
  }

  private push(s: Resolved<FxDef>, def: FxDef, kit: Kit, f: Fx, d: number) {
    // Tope de efectos vivos: con el frame atascado se acumulan; primero se descartan los menores.
    const n = this.live.length;
    if (n >= MAX_LIVE || (n >= MAX_LIVE / 2 && MINOR.has(def.k) && (f.r ?? 0) < 200)) return;
    // Mismo efecto sobre la misma unidad recién lanzado (golpes, destellos del trono, chispas de Io): se descarta.
    if (f.u && MINOR.has(def.k)) {
      for (let i = n - 1; i >= Math.max(0, n - 80); i--) {
        const o = this.live[i];
        if (o.f.u === f.u && o.f.n === f.n && o.t < Math.min(0.25, o.d * 0.5)) return;
      }
    }
    const l = this.spare.pop() ?? ({} as Live);
    l.s = s; l.def = def; l.kit = kit; l.f = f; l.t = 0; l.d = Math.max(0.05, d); l.seed = Math.random() * 1000; l.flag = 0;
    this.live.push(l);
  }

  /** Destello de lanzamiento en la mano del héroe. */
  private cast(f: Fx) {
    if (!f.u) return;
    const look = castLook(f.a);
    const def = CAST_DEF;
    const res: Resolved<FxDef> = { def, c: look.c, c2: look.c2, sh: look.sh, dark: false, auto: false };
    this.push(res, def, this.kit(res, look), f, 0.4);
  }

  // ------------------------------------------------------------ frame

  update(v: View, dt: number, bounds: Bounds | null) {
    this.clock += dt;
    this.frameNo++;
    this.b = bounds;
    const fr = this.frame;
    fr.clear();
    const load = this.pool.load;
    this.dens = this.opts.density * (load > 0.55 ? Math.max(0.15, 1 - (load - 0.55) * 2.2) : 1);

    const t0 = performance.now();
    for (let i = 0; i < this.live.length; i++) {
      const l = this.live[i];
      l.t += dt;
      if (l.t >= l.d) {
        if (l.def.end && !(l.flag & 2)) this.spawnEnd(l);
        this.spare.push(l);
        this.live[i] = this.live[this.live.length - 1];
        this.live.pop();
        i--;
        continue;
      }
      this.drawLive(l, v, dt);
    }

    const t1 = performance.now();
    for (const u of v.units) {
      if (u.s & ST.hidden) continue;
      if (!this.visible(u.px, u.py, 900)) continue;
      if (u.fx) this.drawStatuses(u, dt);
      if (u.c) this.drawCasting(u, dt);
    }
    const t2 = performance.now();
    this.drawProjectiles(v, dt);
    this.drawZones(v, dt);
    const t3 = performance.now();
    this.pool.step(dt, fr);
    const t4 = performance.now();

    const inf = this.info;
    inf.live = this.live.length; inf.particles = this.pool.n; inf.sprites = fr.nA + fr.nN;
    inf.decals = fr.nDA + fr.nDN; inf.beams = fr.nB; inf.shells = fr.nS;
    const ema = (a: number, b: number) => a + (b - a) * 0.1;
    inf.tLive = ema(inf.tLive, t1 - t0); inf.tUnits = ema(inf.tUnits, t2 - t1); inf.tProj = ema(inf.tProj, t3 - t2); inf.tSim = ema(inf.tSim, t4 - t3);
  }

  private spawnEnd(l: Live) {
    l.flag |= 2;
    const end = l.def.end!;
    const f: Fx = { n: l.f.n, x: l.f.x2 ?? l.f.x, y: l.f.y2 ?? l.f.y, r: l.f.r, t: l.f.t, a: l.f.a };
    const c = end.c ?? l.s.c, c2 = end.c2 ?? lighten(c, 0.65);
    const res: Resolved<FxDef> = { def: end, c, c2, sh: end.sh ?? l.s.sh, dark: !!end.dark, auto: l.s.auto };
    this.push(res, end, this.kit(res, end), f, end.d ?? DEFAULT_D[end.k]);
  }

  // ------------------------------------------------------------ puntos de anclaje

  private ax = 0; private ay = 0; private az = 0;
  /** Mano de la unidad (o el punto dado). */
  private hand(v: View, id: number | undefined, x: number, y: number) {
    const u = id ? v.byId.get(id) : undefined;
    if (u) {
      this.ax = u.px + Math.cos(u.pf) * 26; this.ay = u.py + Math.sin(u.pf) * 26; this.az = this.base(u) + this.head(u) * 0.62;
    } else { this.ax = x; this.ay = y; this.az = 90; }
  }
  /** Pecho de la unidad (o el punto dado). */
  private chest(v: View, id: number | undefined, x: number, y: number) {
    const u = id ? v.byId.get(id) : undefined;
    if (u) { this.ax = u.px; this.ay = u.py; this.az = this.base(u) + this.head(u) * 0.55; }
    else { this.ax = x; this.ay = y; this.az = 70; }
  }

  // ------------------------------------------------------------ efectos vivos

  private drawLive(l: Live, v: View, dt: number) {
    const { def, kit, f } = l;
    const fr = this.frame;
    const k = l.t / l.d;
    const first = l.flag === 0 || (l.flag & 1) === 0;
    if (first) l.flag |= 1;
    const R = f.r ?? def.r ?? 200;
    const n = (def.n ?? 1) * this.dens;
    const [cr, cg, cb] = kit.c, [hr, hg, hb] = kit.c2;
    const far = !this.visible(f.x, f.y, R + 300) && (f.x2 === undefined || !this.visible(f.x2, f.y2!, R + 300));
    if (far) return;

    switch (def.k) {
      case 'burst': {
        const fu = f.u ? v.byId.get(f.u) : undefined;
        const x = fu?.px ?? f.x, y = fu?.py ?? f.y;
        if (first) {
          const cnt = Math.round(16 * n * Math.min(2.4, Math.max(0.6, R / 150)));
          for (let i = 0; i < cnt; i++) {
            const a = Math.random() * TAU, sp = R * rnd(1.4, 3.2);
            this.pool.spawn(kit.spark, x + Math.cos(a) * 12, y + Math.sin(a) * 12, rnd(20, 80), Math.cos(a) * sp, Math.sin(a) * sp, rnd(80, 420), Math.min(2.2, Math.max(0.7, R / 160)));
          }
          if (l.s.dark) for (let i = 0; i < Math.round(7 * n); i++) {
            const a = Math.random() * TAU, sp = R * rnd(0.4, 1.2);
            this.pool.spawn(kit.smoke, x, y, 30, Math.cos(a) * sp, Math.sin(a) * sp, rnd(20, 90), Math.max(0.8, R / 140));
          }
          else for (let i = 0; i < Math.round(6 * n); i++) {
            const a = Math.random() * TAU, sp = R * rnd(0.3, 1);
            this.pool.spawn(kit.mote, x, y, rnd(30, 90), Math.cos(a) * sp, Math.sin(a) * sp, rnd(200, 600), 1.6);
          }
        }
        const e = ease(k);
        // Las explosiones grandes se apagan antes y sin destello blanco: si no, varias juntas lo queman todo.
        const big = R > 280 ? Math.sqrt(280 / R) : 1;
        fr.sprite(x, y, 60, Math.min(R, 500) * (0.9 + 0.7 * e), cr, cg, cb, (1 - k) * (1 - k) * 0.5 * big, SH.GLOW, 0, 0.25);
        if (k < 0.2 && R <= 280) fr.sprite(x, y, 60, R * 0.5, 1, 1, 1, (1 - k / 0.2) * 0.45, SH.GLOW, 0, 1);
        fr.decal(DECAL.DISC, x, y, R * (0.55 + 0.55 * e), 0, 0, cr, cg, cb, 0.35 * (1 - k) * big);
        if (def.ring) fr.decal(DECAL.RING, x, y, R * (0.25 + 0.95 * e), 0, 0, cr, cg, cb, (1 - k) * big, 0.1);
        break;
      }
      case 'nova': {
        const back = !!def.back;
        const rr = Math.max(8, back ? R * Math.sin(Math.PI * k) : R * (0.12 + 0.88 * ease(k)));
        const big = R > 400 ? Math.sqrt(400 / R) : 1;
        const a = (back ? Math.min(1, (1 - k) * 3) : 1 - k * k) * big;
        fr.decal(DECAL.RING, f.x, f.y, rr, 0, 0, cr, cg, cb, 0.95 * a, 0.16);
        fr.decal(DECAL.RING, f.x, f.y, rr * 0.86, 0, 0, hr, hg, hb, 0.55 * a, 0.05);
        fr.decal(DECAL.DISC, f.x, f.y, rr, 0, 0, cr, cg, cb, 0.2 * a);
        if (k < 0.15) fr.sprite(f.x, f.y, 50, R * 0.7, cr, cg, cb, 0.7 * (1 - k / 0.15), SH.GLOW, 0, 0.8);
        // Partículas en el frente de la onda.
        const rate = 90 * n * Math.min(2.5, rr / 220) * dt;
        const cnt = Math.floor(rate) + (Math.random() < rate % 1 ? 1 : 0);
        for (let i = 0; i < cnt; i++) {
          const an = Math.random() * TAU, out = back ? 0 : rnd(60, 200);
          const tan = def.swirl ? 260 : 0;
          const br = l.s.dark && i % 2 ? kit.smoke : kit.spark;
          this.pool.spawn(br, f.x + Math.cos(an) * rr, f.y + Math.sin(an) * rr, rnd(5, 40),
            Math.cos(an) * out - Math.sin(an) * tan, Math.sin(an) * out + Math.cos(an) * tan, rnd(60, 260), l.s.dark ? 0.6 : 0.9);
        }
        if (def.ring && k > 0.1) fr.decal(DECAL.RING, f.x, f.y, R * ease(clamp01((k - 0.1) / 0.9)), 0, 0, 1, 1, 1, 0.35 * (1 - k), 0.04);
        break;
      }
      case 'pillar': {
        const H = def.h ?? 500;
        // El radio del evento puede ser el de un aura enorme: la columna no pasa de 300.
        const R = Math.min(f.r ?? def.r ?? 200, def.w ?? 300);
        const grow = ease(clamp01(k * 5));
        const w = R * 0.85 * (1 - k * 0.6);
        const a = k < 0.7 ? 1 : (1 - k) / 0.3;
        fr.beam(f.x, f.y, 0, f.x, f.y, H * grow, w, cr, cg, cb, 0.75 * a);
        fr.beam(f.x, f.y, 0, f.x, f.y, H * grow * 0.95, w * 0.38, hr, hg, hb, 0.95 * a);
        fr.decal(DECAL.DISC, f.x, f.y, R * 1.05, 0, 0, cr, cg, cb, 0.6 * a);
        fr.sprite(f.x, f.y, 40, R * 1.8, cr, cg, cb, 0.45 * a, SH.GLOW, 0, 0.7);
        if (def.ring) fr.decal(DECAL.RING, f.x, f.y, R * (0.4 + 0.9 * ease(k)), 0, 0, hr, hg, hb, 1 - k, 0.12);
        if (first) {
          for (let i = 0; i < Math.round(26 * n); i++) {
            const an = Math.random() * TAU, d = Math.random() * R * 0.7;
            this.pool.spawn(kit.spark, f.x + Math.cos(an) * d, f.y + Math.sin(an) * d, rnd(0, 60), Math.cos(an) * rnd(40, 200), Math.sin(an) * rnd(40, 200), rnd(500, 1300), 1.3);
          }
          if (l.s.dark) for (let i = 0; i < Math.round(6 * n); i++) this.pool.spawn(kit.smoke, f.x, f.y, 20, rnd(-150, 150), rnd(-150, 150), rnd(40, 120), R / 120);
        }
        if (k < 0.5) this.emitRate(kit.spark, 40 * n, dt, f.x, f.y, 10, R * 0.6, 300, 900, 0.9);
        break;
      }
      case 'beam': {
        this.hand(v, f.u, f.x, f.y);
        const x1 = this.ax, y1 = this.ay, z1 = this.az;
        this.chest(v, f.u2, f.x2 ?? f.x, f.y2 ?? f.y);
        const x2 = this.ax, y2 = this.ay, z2 = this.az;
        const W = def.w ?? 12;
        const fl = 1 + 0.18 * Math.sin(l.t * 55 + l.seed);
        const a = k < 0.75 ? 1 : (1 - k) / 0.25;
        const w = W * (1 - k * 0.35) * fl;
        fr.beam(x1, y1, z1, x2, y2, z2, w * 2.2, cr, cg, cb, 0.45 * a);
        fr.beam(x1, y1, z1, x2, y2, z2, w, cr, cg, cb, 0.9 * a);
        fr.beam(x1, y1, z1, x2, y2, z2, w * 0.38, hr, hg, hb, a);
        fr.sprite(x1, y1, z1, W * 4, cr, cg, cb, 0.8 * a, SH.GLOW, 0, 1);
        fr.sprite(x2, y2, z2, W * 6, cr, cg, cb, 0.9 * a, SH.GLOW, 0, 1);
        const len = Math.hypot(x2 - x1, y2 - y1);
        const rate = Math.min(80, len / 40) * 18 * n * dt * (1 - k);
        const cnt = Math.floor(rate) + (Math.random() < rate % 1 ? 1 : 0);
        for (let i = 0; i < cnt; i++) {
          const t = Math.random();
          this.pool.spawn(kit.mote, x1 + (x2 - x1) * t, y1 + (y2 - y1) * t, z1 + (z2 - z1) * t, rnd(-80, 80), rnd(-80, 80), rnd(-40, 140), Math.max(0.8, W / 14));
        }
        if (first) this.burstAt(kit, x2, y2, z2, 12 * n, 260, Math.max(0.8, W / 16));
        break;
      }
      case 'chain': {
        let x1: number, y1: number, z1: number;
        this.chest(v, f.u2 ?? (def.sky ? f.u : undefined), f.x2 ?? f.x, f.y2 ?? f.y);
        const x2 = this.ax, y2 = this.ay, z2 = def.sky ? Math.max(20, this.az - 30) : this.az;
        if (def.sky) { x1 = x2 + 60; y1 = y2 - 40; z1 = 1300; }
        else { this.hand(v, f.u, f.x, f.y); x1 = this.ax; y1 = this.ay; z1 = this.az; }
        const W = def.w ?? 6;
        const a = k < 0.6 ? 1 : (1 - k) / 0.4;
        const len = Math.hypot(x2 - x1, y2 - y1, z2 - z1);
        const N = Math.max(4, Math.min(14, Math.round(len / 80)));
        const bucket = Math.floor(l.t / 0.045);
        let px = x1, py = y1, pz = z1;
        const jit = Math.min(70, len * 0.08);
        for (let i = 1; i <= N; i++) {
          const t = i / N;
          let qx = x1 + (x2 - x1) * t, qy = y1 + (y2 - y1) * t, qz = z1 + (z2 - z1) * t;
          if (i < N) {
            const h1 = hash(l.seed + i * 13.1 + bucket * 7.7), h2 = hash(l.seed + i * 3.7 + bucket * 1.3), h3 = hash(l.seed + i * 5.3 + bucket * 9.1);
            qx += (h1 - 0.5) * 2 * jit; qy += (h2 - 0.5) * 2 * jit; qz += (h3 - 0.5) * jit;
          }
          fr.beam(px, py, pz, qx, qy, qz, W * 3.2, cr, cg, cb, 0.75 * a);
          fr.beam(px, py, pz, qx, qy, qz, W * 1.1, hr, hg, hb, a);
          if (i < N) fr.sprite(qx, qy, qz, W * 5, cr, cg, cb, 0.35 * a, SH.GLOW, 0, 0.5);
          if (i === (bucket % N) + 1 && i < N) fr.sprite(qx, qy, qz, W * 8, cr, cg, cb, 0.5 * a, SH.GLOW, 0, 1);
          px = qx; py = qy; pz = qz;
        }
        fr.sprite(x2, y2, z2, W * 12, cr, cg, cb, 0.9 * a, SH.GLOW, 0, 1);
        if (def.sky) {
          fr.decal(DECAL.DISC, x2, y2, 140, 0, 0, cr, cg, cb, 0.7 * a);
          if (def.ring) fr.decal(DECAL.RING, x2, y2, 60 + 180 * ease(k), 0, 0, hr, hg, hb, 1 - k, 0.12);
        }
        if (first) this.burstAt(kit, x2, y2, Math.max(30, z2 - 20), 14 * n, 380, 0.8, SH.SPARK);
        break;
      }
      case 'cone': {
        let dx = (f.x2 ?? f.x) - f.x, dy = (f.y2 ?? f.y) - f.y;
        if (!dx && !dy) { const u = f.u ? v.byId.get(f.u) : undefined; dx = Math.cos(u?.pf ?? 0); dy = Math.sin(u?.pf ?? 0); }
        const ang = Math.atan2(dy, dx);
        const half = ((def.w ?? 30) * Math.PI) / 180;
        const L = f.r ?? def.r ?? Math.max(300, Math.hypot(dx, dy));
        const grow = ease(clamp01(k * 2.5));
        fr.decal(DECAL.CONE, f.x, f.y, L * grow, 0, ang, cr, cg, cb, 0.85 * (1 - k), half);
        if (first) for (let i = 0; i < Math.round(28 * n); i++) {
          const an = ang + (Math.random() - 0.5) * 2 * half, sp = L * rnd(1.2, 3);
          this.pool.spawn(kit.spark, f.x + Math.cos(an) * 30, f.y + Math.sin(an) * 30, rnd(30, 80), Math.cos(an) * sp, Math.sin(an) * sp, rnd(20, 160), 1.1);
        }
        break;
      }
      case 'line': {
        const x2 = f.x2 ?? f.x, y2 = f.y2 ?? f.y;
        const dx = x2 - f.x, dy = y2 - f.y, len = Math.hypot(dx, dy) || 1;
        const ang = Math.atan2(dy, dx);
        const Wd = f.r ?? def.w ?? 90;
        const travel = Math.min(0.45, l.d * 0.5);
        const p = ease(clamp01(l.t / travel));
        const fade = l.d > 1.5 ? (l.d - l.t < 0.5 ? (l.d - l.t) / 0.5 : 1) * Math.min(1, l.t / 0.15) : 1 - k * k;
        const cl = len * p;
        const mx = f.x + Math.cos(ang) * cl / 2, my = f.y + Math.sin(ang) * cl / 2;
        if (l.s.dark) {
          // Grieta: franja oscura con el núcleo encendido.
          fr.decal(DECAL.LINE, mx, my, Wd / 2, cl / 2, ang, cr * 0.3, cg * 0.25, cb * 0.2, 0.85 * fade, 0, 0, true);
          fr.decal(DECAL.LINE, mx, my, Wd / 5, cl / 2, ang, cr, cg, cb, 0.7 * fade);
        } else fr.decal(DECAL.LINE, mx, my, Wd / 2, cl / 2, ang, cr, cg, cb, 0.85 * fade);
        // Frente que avanza.
        const fx = f.x + Math.cos(ang) * cl, fy = f.y + Math.sin(ang) * cl;
        if (p < 1) {
          fr.sprite(fx, fy, 40, Wd * 1.6, cr, cg, cb, 0.9, SH.GLOW, 0, 0.9);
          const rate = 140 * n * dt * Math.max(0.6, Wd / 100);
          for (let i = 0; i < rate; i++) {
            const side = (Math.random() - 0.5) * Wd;
            const br = l.s.dark && i % 2 ? kit.smoke : (l.s.dark ? kit.chunk : kit.spark);
            this.pool.spawn(br, fx - Math.sin(ang) * side, fy + Math.cos(ang) * side, rnd(5, 40), Math.cos(ang) * rnd(0, 200), Math.sin(ang) * rnd(0, 200), rnd(150, 500), 1);
          }
        } else if (l.d > 1.5) this.emitLine(kit.mote, 5 * n * (len / 300), dt, f.x, f.y, x2, y2, Wd * 0.4);
        if (first && def.ring) for (let i = 0; i < Math.round(len / 25 * n); i++) {
          const t = Math.random(), side = (Math.random() - 0.5) * Wd;
          this.pool.spawn(kit.spark, f.x + dx * t - Math.sin(ang) * side, f.y + dy * t + Math.cos(ang) * side, 20, rnd(-60, 60), rnd(-60, 60), rnd(300, 800), 1.2);
        }
        break;
      }
      case 'warn': {
        if (f.x2 !== undefined && !f.r) {
          // Aviso en línea (Kinetic Field en muro, Earth Splitter…).
          const dx = f.x2 - f.x, dy = f.y2! - f.y, len = Math.hypot(dx, dy);
          const ang = Math.atan2(dy, dx);
          fr.decal(DECAL.LINE, (f.x + f.x2) / 2, (f.y + f.y2!) / 2, 40, len / 2, ang, cr, cg, cb, 0.35 + 0.25 * k);
          break;
        }
        const pulse = 0.75 + 0.25 * Math.sin(l.t * 16);
        fr.decal(DECAL.WARN, f.x, f.y, R, 0, 0, cr, cg, cb, pulse, k);
        this.emitRate(kit.mote, 14 * n * Math.min(3, R / 200), dt, f.x, f.y, R * 0.95, R, 60, 200, 0.8, true);
        break;
      }
      case 'field': {
        const a = Math.min(1, l.t / 0.25) * (l.d - l.t < 0.4 ? (l.d - l.t) / 0.4 : 1);
        this.drawArea(f.x, f.y, R, a, kit, l.s.dark, def.swirl ?? false, true, n, dt, l.seed);
        break;
      }
      case 'blink': {
        const fu = f.u ? v.byId.get(f.u) : undefined;
        const ox = f.x, oy = f.y;
        const dx2 = f.x2 ?? fu?.px ?? f.x, dy2 = f.y2 ?? fu?.py ?? f.y;
        const same = Math.abs(dx2 - ox) + Math.abs(dy2 - oy) < 5;
        if (first) {
          for (let i = 0; i < Math.round(14 * n); i++) {
            const an = Math.random() * TAU, d = rnd(30, 90);
            this.pool.spawn(kit.spark, ox + Math.cos(an) * d, oy + Math.sin(an) * d, rnd(30, 150), -Math.cos(an) * 120, -Math.sin(an) * 120, rnd(60, 260), 0.9);
          }
          if (!same) this.burstAt(kit, dx2, dy2, 80, 14 * n, 280, 0.9);
        }
        fr.sprite(ox, oy, 80, 190 * (1 - k * 0.5), cr, cg, cb, (1 - k), SH.GLOW, 0, 1);
        fr.decal(DECAL.DISC, ox, oy, 90, 0, 0, cr, cg, cb, 0.6 * (1 - k));
        if (!same) {
          fr.sprite(dx2, dy2, 80, 220 * (1 - k * 0.4), cr, cg, cb, (1 - k), SH.GLOW, 0, 1);
          fr.decal(DECAL.RING, dx2, dy2, 50 + 70 * ease(k), 0, 0, hr, hg, hb, 1 - k, 0.15);
          if (def.trail) {
            fr.beam(ox, oy, 70, dx2, dy2, 70, 34 * (1 - k), cr, cg, cb, 0.5 * (1 - k));
            fr.beam(ox, oy, 70, dx2, dy2, 70, 10 * (1 - k), hr, hg, hb, 0.8 * (1 - k));
          }
        }
        break;
      }
      case 'impact': {
        this.chest(v, f.u ?? f.u2, f.x, f.y);
        const r = def.r ?? 50;
        if (first) this.burstAt(kit, this.ax, this.ay, this.az, 9 * n, r * 6, Math.max(0.5, r / 60));
        fr.sprite(this.ax, this.ay, this.az, r * 2.6 * (1 - k * 0.4), cr, cg, cb, Math.pow(1 - k, 1.5), SH.GLOW, 0, 1);
        break;
      }
      case 'slash': {
        this.chest(v, f.u ?? f.u2, f.x, f.y);
        const L = def.r ?? f.r ?? 120;
        for (let j = 0; j < 2; j++) {
          const kk = clamp01((k - j * 0.25) / 0.6);
          if (kk <= 0 || kk >= 1) continue;
          const an = l.seed + j * 1.7;
          const c = Math.cos(an) * L / 2, s = Math.sin(an) * L / 2;
          const w = 14 * (1 - kk);
          fr.beam(this.ax - c, this.ay - s, this.az + 40, this.ax + c, this.ay + s, this.az - 40, w * 2.4, cr, cg, cb, 0.6 * (1 - kk));
          fr.beam(this.ax - c, this.ay - s, this.az + 40, this.ax + c, this.ay + s, this.az - 40, w, hr, hg, hb, 1 - kk);
        }
        if (first) this.burstAt(kit, this.ax, this.ay, this.az, 12 * n, 420, 0.8, SH.SPARK);
        fr.sprite(this.ax, this.ay, this.az, L * 1.4, cr, cg, cb, 0.6 * (1 - k), SH.GLOW, 0, 1);
        break;
      }
      case 'bubble': {
        const u = f.u ? v.byId.get(f.u) : undefined;
        const x = u?.px ?? f.x, y = u?.py ?? f.y, h = u ? this.head(u) : 160, z0 = u ? this.base(u) : 0;
        fr.shell(x, y, z0 + h * 0.5, h * 0.6 + 30 * ease(k), cr, cg, cb, 0.9 * (1 - k));
        if (first) this.burstAt(kit, x, y, z0 + h * 0.5, 10 * n, 300, 0.7, SH.SPARK);
        break;
      }
      case 'arc': {
        const x2 = f.x2 ?? f.x, y2 = f.y2 ?? f.y;
        const H = def.h ?? 300;
        const x = f.x + (x2 - f.x) * k, y = f.y + (y2 - f.y) * k, z = 60 + Math.sin(Math.PI * k) * H;
        const S = f.n === 'orb_throw' ? 40 : 30;
        fr.sprite(x, y, z, S * 1.6, hr, hg, hb, 1, l.s.sh, l.t * 6, 1);
        fr.sprite(x, y, z, S * 4, cr, cg, cb, 0.75, SH.GLOW, 0, 0.6);
        fr.decal(DECAL.DISC, x, y, 40 + z * 0.05, 0, 0, 0, 0, 0, 0.3, 0, 0, true);
        this.emitRate(kit.spark, 50 * n, dt, x, y, 0, 10, -30, 30, 0.7, false, z);
        break;
      }
      case 'rise': {
        const u = f.u ? v.byId.get(f.u) : undefined;
        const x = u?.px ?? f.x, y = u?.py ?? f.y, z0 = u ? this.base(u) : 0;
        const r = def.r ?? 100;
        // h: 0 → solo partículas (destellos muy frecuentes, como el del trono).
        if (def.h !== 0) {
          if (def.ring) fr.decal(DECAL.RING, x, y, r * (0.5 + 0.6 * ease(k)), 0, 0, cr, cg, cb, 1 - k, 0.18);
          fr.decal(DECAL.DISC, x, y, r * 0.9, 0, 0, cr, cg, cb, 0.4 * (1 - k));
          fr.sprite(x, y, z0 + 90, r * 1.8, cr, cg, cb, 0.3 * (1 - k), SH.GLOW, 0, 0.5);
        }
        this.emitRate(kit.spark, 50 * n, dt * (1 - k), x, y, 0, r * 0.7, 180, 420, 0.7, false, z0 + 10);
        break;
      }
      case 'spin': {
        const u = f.u ? v.byId.get(f.u) : undefined;
        const x = u?.px ?? f.x, y = u?.py ?? f.y, z0 = (u ? this.base(u) : 0) + 60;
        const r = Math.min(R, 320) * 0.8;
        this.drawBlades(x, y, z0, r, l.t * 16 + l.seed, 3, kit, 1 - k * k, l.def.sh ?? SH.SHARD);
        fr.decal(DECAL.RING, x, y, r, 0, 0, cr, cg, cb, 0.55 * (1 - k), 0.12);
        if (first) this.burstAt(kit, x, y, z0, 10 * n, r * 3, 0.8);
        break;
      }
      case 'fall': {
        const H = def.h ?? 900;
        const hitK = 0.35;
        if (k < hitK) {
          const kk = k / hitK;
          const x = f.x - H * 0.35 * (1 - kk), y = f.y - H * 0.18 * (1 - kk), z = H * (1 - kk);
          fr.sprite(x, y, z, Math.max(60, R * 0.5), hr, hg, hb, 1, SH.GLOW, 0, 1);
          fr.sprite(x, y, z, Math.max(140, R * 1.2), cr, cg, cb, 0.8, SH.GLOW, 0, 0.6);
          this.emitRate(kit.spark, 120 * n, dt, x, y, 0, 25, -100, 100, 1.2, false, z);
          fr.decal(DECAL.WARN, f.x, f.y, R, 0, 0, cr, cg, cb, 0.6, kk);
        } else {
          const kk = (k - hitK) / (1 - hitK);
          if (!(l.flag & 4)) {
            l.flag |= 4;
            this.burstAt(kit, f.x, f.y, 30, 26 * n * Math.min(2, R / 180), R * 2.6, Math.max(0.8, R / 150));
            if (l.s.dark || this.dens > 0.5) for (let i = 0; i < Math.round(5 * n); i++) this.pool.spawn(kit.smoke, f.x, f.y, 30, rnd(-R, R), rnd(-R, R), rnd(40, 160), R / 130);
          }
          fr.sprite(f.x, f.y, 60, R * (1.3 + kk), cr, cg, cb, (1 - kk) * (1 - kk), SH.GLOW, 0, 0.9);
          fr.decal(DECAL.DISC, f.x, f.y, R * (0.7 + 0.4 * kk), 0, 0, cr, cg, cb, 0.8 * (1 - kk));
          if (def.ring) fr.decal(DECAL.RING, f.x, f.y, R * (0.3 + 0.9 * ease(kk)), 0, 0, hr, hg, hb, 1 - kk, 0.12);
        }
        break;
      }
      case 'spikes': {
        const rr = R * ease(k);
        fr.decal(DECAL.RING, f.x, f.y, Math.max(10, rr), 0, 0, cr, cg, cb, 0.8 * (1 - k * 0.5), 0.14);
        const rate = (TAU * Math.max(40, rr)) / 70 * 8 * n * dt;
        const cnt = Math.floor(rate) + (Math.random() < rate % 1 ? 1 : 0);
        for (let i = 0; i < cnt; i++) {
          const an = Math.random() * TAU;
          this.pool.spawn(kit.chunk, f.x + Math.cos(an) * rr, f.y + Math.sin(an) * rr, 0, Math.cos(an) * 60, Math.sin(an) * 60, rnd(500, 900), 1.6);
          if (l.s.dark && i % 3 === 0) this.pool.spawn(kit.smoke, f.x + Math.cos(an) * rr, f.y + Math.sin(an) * rr, 10, 0, 0, 50, 0.8);
        }
        break;
      }
      case 'portal': {
        const a = Math.min(1, l.t / 0.3) * (l.d - l.t < 0.3 ? (l.d - l.t) / 0.3 : 1);
        const r = def.r ?? 110;
        const pts = f.x2 !== undefined ? 2 : 1;
        for (let j = 0; j < pts; j++) {
          const x = j ? f.x2! : f.x, y = j ? f.y2! : f.y;
          fr.decal(DECAL.RUNES, x, y, r, 0, this.clock * (j ? -1.2 : 1.2), cr, cg, cb, 0.9 * a, 0);
          fr.decal(DECAL.DISC, x, y, r * 0.9, 0, 0, cr, cg, cb, 0.35 * a);
          fr.beam(x, y, 0, x, y, 260, r * 0.9, cr, cg, cb, 0.18 * a);
          this.emitRate(kit.mote, 22 * n, dt, x, y, r * 0.6, r, 120, 320, 0.9, true);
        }
        break;
      }
      case 'none': break;
    }
    // Destello de lanzamiento (CAST_DEF): se pinta aparte para que siga la mano.
    if (def === CAST_DEF) this.drawCastFlash(l, v);
  }

  private drawCastFlash(l: Live, v: View) {
    const u = l.f.u ? v.byId.get(l.f.u) : undefined;
    if (!u) return;
    const k = l.t / l.d;
    const [cr, cg, cb] = l.kit.c;
    this.hand(v, u.i, u.px, u.py);
    if (!(l.flag & 8)) { l.flag |= 8; this.burstAt(l.kit, this.ax, this.ay, this.az, 10 * this.dens, 260, 0.7, SH.SPARK); }
    this.frame.sprite(this.ax, this.ay, this.az, 150 * (0.6 + 0.6 * ease(k)), cr, cg, cb, (1 - k) * 0.95, SH.GLOW, 0, 1);
    this.frame.decal(DECAL.RING, u.px, u.py, 50 + 60 * ease(k), 0, 0, cr, cg, cb, 0.8 * (1 - k), 0.14);
  }

  // ------------------------------------------------------------ ayudantes de emisión

  private burstAt(kit: Kit, x: number, y: number, z: number, count: number, speed: number, size: number, shape?: number) {
    const br = shape === SH.SPARK ? kit.mote : kit.spark;
    const c = Math.round(count);
    for (let i = 0; i < c; i++) {
      const a = Math.random() * TAU, e = rnd(-0.6, 1), sp = speed * rnd(0.4, 1);
      this.pool.spawn(br, x, y, z, Math.cos(a) * sp, Math.sin(a) * sp, e * sp * 0.8, size);
    }
  }

  /** Emisión continua en un anillo (r0..r1) con subida vz0..vz1. */
  private emitRate(br: Brush, perSec: number, dt: number, x: number, y: number, r0: number, r1: number, vz0: number, vz1: number, size: number, ring = false, z = 10) {
    const rate = perSec * dt;
    const cnt = Math.floor(rate) + (Math.random() < rate % 1 ? 1 : 0);
    for (let i = 0; i < cnt; i++) {
      const an = Math.random() * TAU, d = ring ? rnd(r0, r1) : Math.sqrt(Math.random()) * (r1 - r0) + r0;
      this.pool.spawn(br, x + Math.cos(an) * d, y + Math.sin(an) * d, z, rnd(-20, 20), rnd(-20, 20), rnd(vz0, vz1), size);
    }
  }

  private emitLine(br: Brush, perSec: number, dt: number, x1: number, y1: number, x2: number, y2: number, spread: number) {
    const rate = perSec * dt;
    const cnt = Math.floor(rate) + (Math.random() < rate % 1 ? 1 : 0);
    for (let i = 0; i < cnt; i++) {
      const t = Math.random();
      this.pool.spawn(br, x1 + (x2 - x1) * t + rnd(-spread, spread), y1 + (y2 - y1) * t + rnd(-spread, spread), 10, 0, 0, rnd(80, 220), 0.9);
    }
  }

  /** Hojas o filos girando (Blade Fury, Counter Helix…). */
  private drawBlades(x: number, y: number, z: number, r: number, ang: number, count: number, kit: Kit, a: number, sh: number) {
    const [cr, cg, cb] = kit.c, [hr, hg, hb] = kit.c2;
    const shape = sh === SH.GLOW || sh === SH.SPARK ? SH.SHARD : sh;
    for (let i = 0; i < count; i++) {
      const base = ang + (i * TAU) / count;
      for (let j = 0; j < 5; j++) {
        const an = base - j * 0.16;
        const px = x + Math.cos(an) * r, py = y + Math.sin(an) * r;
        this.frame.sprite(px, py, z, (j ? 50 : 64) * (1 - j * 0.12), j ? cr : hr, j ? cg : hg, j ? cb : hb, a * (1 - j * 0.2), j ? SH.GLOW : shape, an + Math.PI / 2, j ? 0.5 : 0.9);
      }
    }
  }

  /** Área persistente: disco, borde, runas, remolino y partículas. */
  private drawArea(x: number, y: number, R: number, a: number, kit: Kit, dark: boolean, swirl: boolean, edge: boolean, n: number, dt: number, seed: number) {
    const fr = this.frame;
    const [cr, cg, cb] = kit.c, [hr, hg, hb] = kit.c2;
    // Las áreas muy grandes se quedan más tenues para no tapar la pelea.
    const big = Math.min(1, 380 / Math.max(1, R));
    if (R <= 520 || dark) fr.decal(DECAL.DISC, x, y, R, 0, 0, cr, cg, cb, (dark ? 0.5 : 0.3) * a * (0.4 + 0.6 * big), 0, 0, dark);
    fr.decal(DECAL.RING, x, y, R, 0, 0, cr, cg, cb, (edge ? 0.85 : 0.45) * a * (0.5 + 0.5 * big), 0.05);
    if (edge && !dark && R <= 420) fr.decal(DECAL.RUNES, x, y, R * 0.97, 0, this.clock * 0.3 + seed, hr, hg, hb, 0.22 * a, 1);
    if (swirl) {
      for (let i = 0; i < 6; i++) {
        const rr = R * (0.25 + 0.12 * i), an = this.clock * (3.2 - i * 0.3) + i * 1.1;
        fr.sprite(x + Math.cos(an) * rr, y + Math.sin(an) * rr, 30 + i * 12, R * 0.45, cr, cg, cb, 0.5 * a, SH.SWIRL, an, 0.5, false);
      }
      fr.sprite(x, y, 40, R * 0.9, hr, hg, hb, 0.35 * a, SH.SWIRL, -this.clock * 4, 0.7);
    }
    const area = Math.min(4, (R * R) / (300 * 300));
    const per = Math.max(6, 36 * area) * n * a;
    this.emitRate(dark ? kit.smoke : kit.spark, per * (dark ? 0.5 : 1), dt, x, y, 0, R * 0.95, dark ? 20 : 60, dark ? 70 : 220, dark ? 1.1 : 0.85);
  }

  // ------------------------------------------------------------ estados sobre unidades

  private drawStatuses(u: VUnit, dt: number) {
    let marks = 0, shells = 0;
    for (const name of u.fx!) {
      const s = statusStyle(name);
      let def: StatusDef | undefined = s.def;
      let depth = 0;
      while (def && depth < 3) {
        if (def.k === 'mark' && marks++ > 0) { def = def.also; depth++; continue; }
        if ((def.k === 'shield' || def.k === 'frozen') && shells++ > 1) { def = def.also; depth++; continue; }
        const res = depth === 0 ? s : this.alsoOf(s, def);
        this.drawStatus(u, def, this.kit(res, res), res.dark, dt, res.sh);
        def = def.also; depth++;
      }
    }
  }

  private alsoMemo = new Map<StatusDef, Resolved<StatusDef>>();
  /** Estado secundario (also) resuelto con los colores del principal; se calcula una vez. */
  private alsoOf(s: Resolved<StatusDef>, def: StatusDef): Resolved<StatusDef> {
    let r = this.alsoMemo.get(def);
    if (!r) {
      r = { ...s, def, c: def.c ?? s.c, c2: def.c2 ?? (def.c ? lighten(def.c, 0.65) : s.c2), sh: def.sh ?? s.sh };
      this.alsoMemo.set(def, r);
    }
    return r;
  }

  private drawStatus(u: VUnit, def: StatusDef, kit: Kit, dark: boolean, dt: number, sh: number) {
    const fr = this.frame;
    const [cr, cg, cb] = kit.c, [hr, hg, hb] = kit.c2;
    const x = u.px, y = u.py, z0 = this.base(u), H = this.head(u), ur = this.radius(u);
    const t = this.clock, n = (def.n ?? 1) * this.dens;
    const ph = (u.i * 0.731) % TAU;
    switch (def.k) {
      case 'stun': {
        for (let i = 0; i < 3; i++) {
          const a = t * 5 + (i * TAU) / 3 + ph;
          fr.sprite(x + Math.cos(a) * 36, y + Math.sin(a) * 36, z0 + H + 18 + Math.sin(a * 2) * 6, 44, cr, cg, cb, 1, SH.STAR, a, 0.9);
        }
        fr.decal(DECAL.RING, x, y, ur * 1.2, 0, 0, cr, cg, cb, 0.35, 0.1);
        break;
      }
      case 'shield': {
        const pulse = 0.5 + 0.12 * Math.sin(t * 4 + ph);
        fr.shell(x, y, z0 + H * 0.5, Math.max(ur * 1.7, H * 0.55), cr, cg, cb, pulse);
        fr.decal(DECAL.RING, x, y, ur * 1.5, 0, 0, cr, cg, cb, 0.55, 0.12);
        break;
      }
      case 'frozen': {
        fr.shell(x, y, z0 + H * 0.45, Math.max(ur * 1.5, H * 0.5), cr, cg, cb, 0.7, 1.15);
        for (let i = 0; i < 4; i++) {
          const a = ph + i * 1.7;
          fr.sprite(x + Math.cos(a) * ur, y + Math.sin(a) * ur, z0 + 30 + i * 28, 46, hr, hg, hb, 0.8, SH.SHARD, a, 0.8);
        }
        break;
      }
      case 'aura': {
        fr.decal(DECAL.RING, x, y, ur * 1.55, 0, 0, cr, cg, cb, 0.75, 0.14);
        fr.decal(DECAL.RUNES, x, y, ur * 1.9, 0, t * 0.8 + ph, cr, cg, cb, 0.4, 0);
        this.emitRate(kit.mote, 5 * n, dt, x, y, ur, ur * 1.5, 60, 160, 0.7, true, z0 + 5);
        break;
      }
      case 'field': {
        const R = def.r ?? 300;
        this.drawArea(x, y, R, 0.6, kit, dark, false, false, n, dt, ph);
        // Estallidos sueltos dentro del área (Freezing Field, Epicenter…).
        if (def.pops && Math.random() < def.pops * dt * Math.min(1, this.dens * 1.5)) {
          const an = Math.random() * TAU, d = Math.sqrt(Math.random()) * R;
          const px = x + Math.cos(an) * d, py = y + Math.sin(an) * d;
          this.burstAt(kit, px, py, 30, 10 * n + 4, 360, 1.1);
          fr.decal(DECAL.RING, px, py, 90, 0, 0, cr, cg, cb, 0.8, 0.25);
        }
        break;
      }
      case 'spin': {
        const r = (def.r ?? 260) * 0.75;
        this.drawBlades(x, y, z0 + 60, r, t * 14 + ph, 3, kit, 0.9, def.sh ?? SH.SHARD);
        fr.decal(DECAL.DISC, x, y, def.r ?? 260, 0, 0, cr, cg, cb, 0.22);
        fr.decal(DECAL.RING, x, y, def.r ?? 260, 0, 0, cr, cg, cb, 0.5, 0.04);
        this.emitRate(kit.mote, 30 * n, dt, x, y, r * 0.8, r * 1.1, 40, 180, 0.8, true, z0 + 50);
        break;
      }
      case 'mark': {
        const bob = Math.sin(t * 3 + ph) * 6;
        const z = z0 + H + 85 + bob;
        fr.sprite(x, y, z, 110, cr, cg, cb, 0.5, SH.GLOW, 0, 0.4);
        fr.sprite(x, y, z, 68, cr, cg, cb, 1, def.mark ?? SH.STAR, 0, 0.55);
        break;
      }
      case 'motes': {
        this.emitRate(kit.spark, 9 * n, dt, x, y, ur * 0.4, ur * 1.1, 70, 160, 0.75, true, z0 + rnd(20, H * 0.7));
        break;
      }
      case 'burn': {
        this.emitRate(kit.spark, 26 * n, dt, x, y, 0, ur * 0.7, 120, 260, 1.15, false, z0 + rnd(20, H * 0.6));
        fr.sprite(x, y, z0 + H * 0.45, H * 1.0, cr, cg, cb, 0.14 + 0.05 * Math.sin(t * 13 + ph), SH.GLOW, 0, 0.2);
        break;
      }
      case 'drip': {
        const rate = 5 * n * dt;
        if (Math.random() < rate) this.pool.spawn(kit.chunk, x + rnd(-ur, ur) * 0.6, y + rnd(-ur, ur) * 0.6, z0 + H * rnd(0.5, 0.9), 0, 0, rnd(-40, 60), 1.1);
        fr.decal(DECAL.DISC, x, y, ur * 1.5, 0, 0, cr, cg, cb, 0.45);
        fr.sprite(x, y, z0 + H * 0.5, H, cr, cg, cb, 0.22, SH.GLOW, 0, 0.2);
        break;
      }
      case 'lift': {
        for (let i = 0; i < 3; i++) {
          const a = -t * (7 + i) + i * 2;
          fr.sprite(x, y, z0 + 25 + i * 60, 150 - i * 22, cr, cg, cb, 0.7, SH.SWIRL, a, 0.5);
        }
        fr.decal(DECAL.RING, x, y, ur * 1.6, 0, 0, cr, cg, cb, 0.5, 0.2);
        this.emitRate(kit.mote, 10 * n, dt, x, y, ur, ur * 1.4, 150, 300, 0.6, true, z0 + 10);
        break;
      }
      case 'ghost': {
        fr.sprite(x, y, z0 + H * 0.5, H * 1.2, cr, cg, cb, 0.12 + 0.05 * Math.sin(t * 3 + ph), SH.GLOW, 0, 0.2);
        if (Math.random() < 3 * n * dt) this.pool.spawn(kit.smoke, x + rnd(-ur, ur), y + rnd(-ur, ur), z0 + 30, 0, 0, 40, 0.5);
        break;
      }
      case 'root': {
        fr.decal(DECAL.RING, x, y, ur * 1.3, 0, 0, cr, cg, cb, 0.8, 0.25);
        for (let i = 0; i < 5; i++) {
          const a = ph + (i * TAU) / 5 + Math.sin(t * 2 + i) * 0.1;
          fr.sprite(x + Math.cos(a) * ur * 1.1, y + Math.sin(a) * ur * 1.1, z0 + 18 + (i % 2) * 14, 34, cr, cg, cb, 0.9, SH.LEAF, a, 0.4);
        }
        break;
      }
      case 'sleep': {
        if (Math.random() < 2.5 * n * dt) this.pool.spawn(kit.mote, x + rnd(-10, 10), y, z0 + H + 10, rnd(10, 30), 0, rnd(50, 90), 1.4);
        fr.sprite(x, y, z0 + H * 0.5, H, cr, cg, cb, 0.18, SH.GLOW, 0, 0.3);
        break;
      }
      case 'hex': {
        for (let i = 0; i < 4; i++) {
          const a = t * 4 + (i * TAU) / 4 + ph;
          fr.sprite(x + Math.cos(a) * ur * 1.2, y + Math.sin(a) * ur * 1.2, z0 + 40 + Math.sin(t * 3 + i) * 20, 28, cr, cg, cb, 0.9, SH.STAR, a, 0.8);
        }
        fr.decal(DECAL.RING, x, y, ur * 1.3, 0, 0, cr, cg, cb, 0.5, 0.15);
        break;
      }
      case 'slow': {
        fr.decal(DECAL.RING, x, y, ur * 1.35, 0, 0, cr, cg, cb, 0.6, 0.18);
        if (Math.random() < 1.6 * n * dt) this.pool.spawn(kit.mote, x, y, z0 + H * 0.7, 0, 0, -90, 1.1);
        break;
      }
      case 'trail': {
        const moving = u.speed > 60;
        this.emitRate(kit.spark, (moving ? 30 : 6) * n, dt, x, y, 0, ur * 0.6, 0, 60, 0.9, false, z0 + rnd(10, H * 0.6));
        fr.sprite(x, y, z0 + H * 0.4, H * 0.9, cr, cg, cb, moving ? 0.25 : 0.12, SH.GLOW, 0, 0.3);
        fr.decal(DECAL.RING, x, y, ur * 1.3, 0, 0, cr, cg, cb, 0.35, 0.12);
        break;
      }
      case 'glow': {
        fr.sprite(x, y, z0 + H * 0.5, H * 1.15, cr, cg, cb, 0.2 + 0.07 * Math.sin(t * 6 + ph), SH.GLOW, 0, 0.2);
        break;
      }
      case 'none': break;
    }
  }

  // ------------------------------------------------------------ lanzamiento y canalización

  private drawCasting(u: VUnit, dt: number) {
    const look = castLook(u.ck);
    const kit = this.kits.get(look) ?? this.kit({ c: look.c, c2: look.c2, sh: look.sh, dark: false }, look);
    const [cr, cg, cb] = kit.c, [hr, hg, hb] = kit.c2;
    const fr = this.frame;
    const z0 = this.base(u), H = this.head(u);
    const hx = u.px + Math.cos(u.pf) * 26, hy = u.py + Math.sin(u.pf) * 26, hz = z0 + H * 0.62;
    if (u.c === 1) {
      // Punto de lanzamiento: energía que se concentra en la mano.
      fr.sprite(hx, hy, hz, 70 + 20 * Math.sin(this.clock * 24), cr, cg, cb, 0.85, SH.GLOW, 0, 1);
      if (Math.random() < 18 * this.dens * dt) {
        const a = Math.random() * TAU;
        this.pool.spawn(kit.mote, hx + Math.cos(a) * 60, hy + Math.sin(a) * 60, hz + rnd(-30, 30), -Math.cos(a) * 140, -Math.sin(a) * 140, 0, 0.7, 0.5);
      }
    } else {
      // Canalización: círculo de runas girando a los pies y chispas que suben.
      fr.decal(DECAL.RUNES, u.px, u.py, 105, 0, this.clock * 1.4, cr, cg, cb, 0.85, 0);
      fr.decal(DECAL.RING, u.px, u.py, 118, 0, 0, hr, hg, hb, 0.6 + 0.2 * Math.sin(this.clock * 6), 0.06);
      fr.sprite(hx, hy, hz, 90, cr, cg, cb, 0.8, SH.GLOW, 0, 1);
      this.emitRate(kit.mote, 16 * this.dens, dt, u.px, u.py, 90, 115, 120, 260, 0.8, true, z0 + 5);
    }
  }

  // ------------------------------------------------------------ proyectiles

  private drawProjectiles(v: View, dt: number) {
    const fr = this.frame;
    for (const p of v.projs) {
      let pv = this.projPrev.get(p.i);
      if (!pv) { pv = { x: p.x, y: p.y, seen: 0, acc: 0, s: null }; this.projPrev.set(p.i, pv); }
      const dx = p.x - pv.x, dy = p.y - pv.y, dist = Math.hypot(dx, dy);
      let ux = 0, uy = 0;
      if (dist > 0.5) { ux = dx / dist; uy = dy / dist; }
      else { const tu = p.tu ? v.byId.get(p.tu) : undefined; if (tu) { const l = Math.hypot(tu.px - p.x, tu.py - p.y) || 1; ux = (tu.px - p.x) / l; uy = (tu.py - p.y) / l; } }
      const ox = pv.x, oy = pv.y;
      pv.x = p.x; pv.y = p.y; pv.seen = this.frameNo;
      if (!this.visible(p.x, p.y, 400)) continue;
      const s = pv.s ??= projStyle(p.fx, p.a);
      const def: ProjDef = s.def;
      const kit = this.kit(s, s);
      const [cr, cg, cb] = kit.c, [hr, hg, hb] = kit.c2;
      const attack = p.fx.startsWith('attack:');
      const src = v.byId.get(p.s);
      const z = def.z ?? (attack ? (src ? this.base(src) : 0) + 95 : 80);
      const S = def.s;
      const rot = def.spin ? this.clock * 16 : Math.atan2(uy, ux) + Math.PI / 2;
      if (def.wave) {
        // Onda ancha: varias manchas a lo ancho del frente y una franja en el suelo detrás.
        const W = def.wave, m = Math.max(3, Math.min(8, Math.round(W / 45)));
        const px = -uy, py = ux;
        for (let i = 0; i < m; i++) {
          const o = (i / (m - 1) - 0.5) * W;
          const j = Math.sin(this.clock * 20 + i * 1.7) * 8;
          fr.sprite(p.x + px * o + ux * j, p.y + py * o + uy * j, z, (W / m) * 2.6, cr, cg, cb, 0.8, SH.GLOW, 0, 0.7);
          fr.sprite(p.x + px * o, p.y + py * o, z, (W / m) * 1.5, hr, hg, hb, 0.7, s.sh, rot, 0.8, def.dark);
        }
        fr.decal(DECAL.LINE, p.x - ux * 90, p.y - uy * 90, W / 2, 90, Math.atan2(uy, ux), cr, cg, cb, 0.4, 0, 0, def.dark);
      } else {
        fr.sprite(p.x, p.y, z, S * 3.6, cr, cg, cb, 0.85, SH.GLOW, 0, 0.6);
        fr.sprite(p.x, p.y, z, S * 1.5, hr, hg, hb, 1, attack ? SH.SPARK : s.sh, rot, 1);
        if (def.arrow) for (let j = 1; j <= 4; j++) fr.sprite(p.x - ux * S * 0.45 * j, p.y - uy * S * 0.45 * j, z, S * (1.3 - j * 0.2), cr, cg, cb, 0.8 - j * 0.16, SH.SPARK, 0, 0.8);
      }
      if (def.chain && src) {
        this.hand(v, src.i, src.px, src.py);
        const [lr, lg, lb] = hexRgb(def.chain);
        fr.beam(this.ax, this.ay, this.az, p.x, p.y, z, 7, lr, lg, lb, 0.9);
        const L = Math.hypot(p.x - this.ax, p.y - this.ay), links = Math.min(40, Math.floor(L / 45));
        for (let j = 1; j < links; j++) {
          const t = j / links;
          fr.sprite(this.ax + (p.x - this.ax) * t, this.ay + (p.y - this.ay) * t, this.az + (z - this.az) * t, 16, lr, lg, lb, 0.9, SH.RING, t * 20, 0.3);
        }
      }
      // Estela: partículas repartidas por el tramo recorrido este frame.
      if (dist > 0.5 && dist < 400) {
        pv.acc += (dist / 100) * (def.trail ?? 2) * this.dens * (attack ? 0.8 : 1);
        const spread = def.wave ? def.wave * 0.45 : S * 0.3;
        while (pv.acc >= 1) {
          pv.acc -= 1;
          const t = Math.random(), side = (Math.random() - 0.5) * 2 * spread;
          this.pool.spawn(def.dark ? kit.smoke : kit.spark, ox + dx * t - uy * side, oy + dy * t + ux * side, z + rnd(-8, 8), rnd(-30, 30) - ux * 40, rnd(-30, 30) - uy * 40, rnd(-20, 40),
            Math.max(0.35, S / 40) * (def.dark ? 0.6 : 1), attack ? 0.55 : 0.8);
        }
      }
    }
    if (this.frameNo % 60 === 0) for (const [id, pv] of this.projPrev) if (this.frameNo - pv.seen > 30) this.projPrev.delete(id);
  }

  // ------------------------------------------------------------ zonas

  private drawZones(v: View, dt: number) {
    const fr = this.frame;
    for (const z of v.zones) {
      let born = this.zoneBorn.get(z.i);
      if (born === undefined) { born = this.clock; this.zoneBorn.set(z.i, born); }
      if (!this.visible(z.x, z.y, z.r + 200)) continue;
      const s = zoneStyle(z.fx, z.a);
      const def: ZoneDef = s.def;
      const kit = this.kit(s, s);
      const [cr, cg, cb] = kit.c;
      const a = Math.min(1, (this.clock - born) / 0.3) * Math.min(1, Math.max(0, z.e) / 0.4 + 0.05);
      this.drawArea(z.x, z.y, z.r, a, kit, s.dark, !!def.swirl, !!def.edge, (def.n ?? 1) * this.dens, dt, z.i);
      if (def.dome) fr.shell(z.x, z.y, 0, z.r, cr, cg, cb, 0.55 * a, 0.7);
      if (def.rain) {
        const rate = Math.max(3, (z.r * z.r) / 9000) * (def.n ?? 1) * this.dens * dt;
        const cnt = Math.floor(rate) + (Math.random() < rate % 1 ? 1 : 0);
        for (let i = 0; i < cnt; i++) {
          const an = Math.random() * TAU, d = Math.sqrt(Math.random()) * z.r;
          this.pool.spawn(kit.mote, z.x + Math.cos(an) * d, z.y + Math.sin(an) * d, rnd(350, 600), 0, 0, -1100, 1.2, 0.6);
        }
      }
    }
    if (this.frameNo % 120 === 0) {
      const ids = new Set(v.zones.map((z) => z.i));
      for (const id of this.zoneBorn.keys()) if (!ids.has(id)) this.zoneBorn.delete(id);
    }
  }

  /** Qué se está dibujando ahora (para depurar desde la consola: __vfx.dump()). */
  dump(v: View) {
    const count = (arr: string[]) => arr.reduce<Record<string, number>>((o, k) => ((o[k] = (o[k] ?? 0) + 1), o), {});
    return {
      live: count(this.live.map((l) => l.f.n + (l.f.c ? '.' + l.f.c : '') + ':' + l.def.k)),
      status: count(v.units.flatMap((u) => (u.fx ?? []).map((f) => f + ':' + u.k + ':' + u.n))),
      zones: count(v.zones.map((z) => z.fx)),
      projs: count(v.projs.map((p) => p.fx)),
      info: { ...this.info },
      zr: v.zones.filter((z) => z.r > 300).map((z) => z.fx + ':' + z.r),
      big: this.live.filter((l) => (l.f.r ?? l.def.r ?? 0) > 300).map((l) => `${l.f.n}@${l.f.a ?? ''}:${l.def.k}:r${l.f.r ?? l.def.r}:d${l.d.toFixed(1)}`),
    };
  }

  dispose() { this.live.length = 0; this.pool.clear(); this.kits.clear(); }
}

const DEFAULT_D: Record<string, number> = {
  burst: 0.55, nova: 0.6, pillar: 0.7, beam: 0.45, chain: 0.3, cone: 0.5, line: 0.7, warn: 1, field: 3, blink: 0.45,
  impact: 0.35, slash: 0.4, bubble: 0.5, arc: 0.8, rise: 0.9, spin: 0.45, fall: 0.7, spikes: 0.8, portal: 3, none: 0.1,
};
const CAST_DEF: FxDef = { k: 'none' };
const MAX_LIVE = 500;
const MINOR = new Set(['impact', 'rise', 'none', 'bubble', 'slash']);
const ORB_KEYS: Record<string, object> = {};
