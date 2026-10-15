// Cuerpos por arquetipo. Cada generador crea huesos y piezas en el Builder y devuelve las medidas
// que necesitan los accesorios. Convención: X delante, Y arriba, Z a la derecha; pies en y = 0.
import type { Build, Head, Look } from './appearance';
import { lr, type Builder, type V3 } from './builder';
import { BONE, DARK, IVORY, accessories, head, lum, mix, shade, weapon, type Hum } from './parts';

const BUILDS: Record<Build, { leg: number; torso: number; cw: number; cd: number; head: number; arm: number; legT: number; upper: number; fore: number; wk: number }> = {
  tiny: { leg: 25, torso: 24, cw: 10, cd: 8.5, head: 12, arm: 3.3, legT: 3.8, upper: 12, fore: 12, wk: 0.8 },
  slim: { leg: 43, torso: 29, cw: 10, cd: 7.5, head: 10, arm: 3.1, legT: 3.7, upper: 16, fore: 16, wk: 0.95 },
  normal: { leg: 41, torso: 31, cw: 12.5, cd: 9, head: 10.5, arm: 3.9, legT: 4.4, upper: 16, fore: 16, wk: 1 },
  heavy: { leg: 37, torso: 33, cw: 16, cd: 12, head: 10.5, arm: 5.3, legT: 5.7, upper: 17, fore: 17, wk: 1.06 },
  hulk: { leg: 31, torso: 36, cw: 21, cd: 16, head: 10.5, arm: 7, legT: 7.3, upper: 20, fore: 20, wk: 1.12 },
};

const CREATURE = new Set<Head>(['beast', 'bull', 'bird', 'fish', 'frog', 'demon', 'insect', 'rock', 'troll', 'goblin', 'ape', 'rodent', 'panda', 'reptile', 'tree', 'skull', 'void']);

export interface HumOpts { legs: 'walk' | 'seated' | 'none'; parent?: string }

/** Humanoide completo: cuerpo, cabeza, accesorios y armas. */
export function humanoid(b: Builder, look: Look, o: HumOpts): Hum {
  const build: Build = look.build ?? (look.arch === 'giant' ? 'hulk' : 'normal');
  const d = BUILDS[build];
  const giant = look.arch === 'giant';
  const hunch = look.hunch ?? (giant ? 0.25 : 0);
  const [P, S, A, K] = look.pal;
  const creature = CREATURE.has(look.head ?? 'human');
  const armK = giant ? 1.18 : 1;
  const hipY = d.leg + 3;
  b.bone('hips', o.parent ?? 'root', [0, hipY, 0]);
  b.bone('chest', 'hips', [0, hipY + 4, 0]);
  const dy = -hunch * 7;
  const shY = hipY + d.torso * 0.86 + dy, shX = hunch * 9;
  const neckY = hipY + d.torso + dy * 1.3;
  const r = d.head * (giant ? 0.9 : 1);
  const headC: V3 = [hunch * 16 + 1, neckY + r * 0.92, 0];
  b.bone('head', 'chest', [hunch * 13, neckY - 1, 0]);
  const shZ = d.cw + d.arm * 0.35;
  const hand = { L: [0, 0, 0] as V3, R: [0, 0, 0] as V3 };
  const armored = look.head === 'helm' || (!!look.metal && (build === 'heavy' || build === 'hulk') && !creature);
  const panda = look.head === 'panda';
  const sleeve = panda ? S : creature || look.bare ? K : P;
  const forearm = armored ? (look.metal ?? '#b8bcc6') : look.head === 'panda' ? S : creature || look.bare ? K : mix(K, P, 0.15);

  // Tronco
  b.ell('hips', S, [0, hipY + 1, 0], [d.cd * 0.9, 7, d.cw * 0.82]);
  b.ell('chest', P, [shX * 0.35, hipY + d.torso * 0.42, 0], [d.cd * 0.92, d.torso * 0.42, d.cw * 0.86]);
  b.ell('chest', P, [shX * 0.8, hipY + d.torso * 0.7 + dy * 0.6, 0], [d.cd * 1.02, d.torso * 0.36, d.cw * 1.03]);
  if (build === 'heavy' || build === 'hulk') b.ell('chest', shade(P, 1.08), [shX * 0.8 + d.cd * 0.35, hipY + d.torso * 0.72 + dy * 0.6, 0], [d.cd * 0.7, d.torso * 0.26, d.cw * 0.8]);
  b.ell('chest', A, [0, hipY + 4.5, 0], [d.cd * 0.94, 2.4, d.cw * 0.88]);
  b.tube('head', creature ? K : shade(K, 0.95), [hunch * 12, neckY - 5, 0], [headC[0] - 1, headC[1] - r * 0.4, 0], r * 0.42);

  // Brazos
  for (const s of [-1, 1]) {
    const L = lr(s);
    const sh: V3 = [shX, shY, s * shZ];
    const el: V3 = [shX - 1, shY - d.upper * armK, s * (shZ + 1.5)];
    const hp: V3 = [el[0] + 1.5, el[1] - d.fore * armK, el[2]];
    hand[L as 'L' | 'R'] = hp;
    b.bone('arm' + L, 'chest', sh);
    b.bone('hand' + L, 'arm' + L, el);
    b.ball('arm' + L, sleeve, sh, [d.arm * 1.3, d.arm * 1.3, d.arm * 1.3], { seg: 7 });
    b.tube('arm' + L, sleeve, sh, el, d.arm * 1.18, d.arm * 0.98);
    b.tube('hand' + L, forearm, el, hp, d.arm * 1.0, d.arm * 0.85);
    b.ell('hand' + L, armored ? forearm : panda ? S : K, [hp[0] + 0.5, hp[1] - 1.5, hp[2]], [d.arm * 1.15, d.arm * 1.3, d.arm * 1.0]);
  }

  // Piernas
  if (o.legs !== 'none') {
    const boot = shade(S, 0.55);
    for (const s of [-1, 1]) {
      const L = lr(s);
      const z = s * d.cw * 0.5;
      const hj: V3 = [0, hipY - 2, z];
      const seated = o.legs === 'seated';
      const kn: V3 = seated ? [18, hipY - 1, s * (d.cw * 0.5 + 9)] : [2, hipY * 0.5, z + s * 0.5];
      const an: V3 = seated ? [16, hipY - 24, s * (d.cw * 0.5 + 11)] : [0, 4, z + s];
      b.bone('leg' + L, 'hips', hj);
      b.bone('foot' + L, 'leg' + L, kn);
      const lc = creature && !panda ? K : S;
      b.tube('leg' + L, lc, hj, kn, d.legT * 1.22, d.legT * 0.98);
      b.tube('foot' + L, lc, kn, an, d.legT * 0.98, d.legT * 0.76);
      b.box('foot' + L, creature && !panda ? shade(K, 0.7) : boot, [an[0] + 2.5, an[1] - 1.6, an[2]], [d.legT * 3.1, 4.6, d.legT * 2.1]);
    }
  }

  const h: Hum = {
    hipY, cw: d.cw, cd: d.cd, torso: d.torso, neckY, headC, headR: r, shY, shX, shZ, hand,
    arm: d.arm, legT: d.legT, hunch, top: 0, legs: o.legs, backX: shX * 0.5 - d.cd, chestY: hipY + d.torso * 0.62 + dy * 0.5,
    wk: d.wk, creature,
  };
  h.top = head(b, look, 'head', headC, r);
  accessories(b, look, h);
  weapon(b, look, look.weapon, 1, h);
  if (look.off) weapon(b, look, look.off, -1, h);
  return h;
}

// ---------------------------------------------------------------------------
// Cuadrúpedos (bestias, monturas y la mitad inferior de los centauros)

export type BeastKind = 'horse' | 'cat' | 'wolf' | 'bear' | 'boar' | 'lizard' | 'deer' | 'void' | 'frog';

export interface Quad {
  /** Punto del lomo donde va la silla o el torso del centauro. */
  saddle: V3;
  front: V3;
  top: number;
  legH: number;
}

export interface QuadOpts {
  kind: BeastKind;
  col: string;
  belly?: string;
  mane?: string;
  glow?: string;
  /** Tamaño (1 = caballo de montura). */
  k?: number;
  /** Sin cabeza (el centauro pone su torso). */
  headless?: boolean;
}

export function quad(b: Builder, p: '' | 'm', o: QuadOpts): Quad {
  const k = o.k ?? 1;
  const kind = o.kind;
  const C = o.col, B = o.belly ?? shade(C, 1.25), D = shade(C, 0.6);
  const dims = {
    horse: [72, 34, 15, 12], deer: [62, 34, 12, 10], cat: [66, 24, 13, 12], wolf: [56, 24, 12, 10], bear: [62, 22, 19, 17],
    boar: [52, 16, 15, 13], lizard: [74, 12, 11, 15], void: [60, 22, 15, 15], frog: [36, 10, 14, 16],
  }[kind];
  const len = dims[0] * k, legH = dims[1] * k, girth = dims[2] * k, w = dims[3] * k;
  const by = legH + girth * 0.7;
  b.bone(p + 'body', 'root', [0, by, 0]);
  // Tronco: lomo, pecho y grupa.
  b.ell(p + 'body', C, [0, by, 0], [len * 0.5, girth, w]);
  b.ell(p + 'body', C, [len * 0.28, by + girth * 0.15, 0], [len * 0.28, girth * 1.08, w * 1.06]);
  b.ell(p + 'body', shade(C, 0.92), [-len * 0.3, by + girth * 0.1, 0], [len * 0.25, girth * 1.0, w * 1.05]);
  b.ell(p + 'body', B, [0, by - girth * 0.45, 0], [len * 0.4, girth * 0.55, w * 0.85]);
  // Patas: un hueso por pata, con codo marcado.
  const legs: [string, number, number][] = [['FL', 1, -1], ['FR', 1, 1], ['BL', -1, -1], ['BR', -1, 1]];
  const thick = (kind === 'bear' ? 6.5 : kind === 'boar' ? 4.5 : kind === 'lizard' || kind === 'frog' ? 4.5 : kind === 'horse' || kind === 'deer' ? 3.6 : 4.2) * k;
  for (const [n, fx, s] of legs) {
    const px = fx * len * 0.36, pz = s * w * 0.62;
    const top: V3 = [px, by - girth * 0.2, pz];
    const splay = kind === 'lizard' || kind === 'frog' ? s * 12 * k : 0;
    const knee: V3 = [px + (fx > 0 ? 2 : -4) * k, legH * 0.5, pz + splay];
    const foot: V3 = [px + (fx > 0 ? 1 : -1) * k, 2, pz + splay * 1.1];
    b.bone(p + 'leg' + n, p + 'body', top);
    b.tube(p + 'leg' + n, fx > 0 ? C : shade(C, 0.95), top, knee, thick * (fx > 0 ? 1.25 : 1.45), thick);
    b.tube(p + 'leg' + n, C, knee, foot, thick, thick * 0.75);
    const hoof = kind === 'horse' || kind === 'deer';
    b.ell(p + 'leg' + n, hoof ? DARK : shade(C, 0.8), [foot[0] + (hoof ? 0 : 2 * k), 2.2, foot[2]], hoof ? [thick, 2.6, thick] : [thick * 1.5, 2.4, thick * 1.2]);
  }
  // Cola
  b.bone(p + 'tail', p + 'body', [-len * 0.5, by + girth * 0.3, 0]);
  const tx = -len * 0.5;
  if (kind === 'horse' || kind === 'deer') {
    b.cone(p + 'tail', o.mane ?? D, [tx, by + girth * 0.4, 0], [tx - 16 * k, by - girth * 1.6, 0], 5 * k, { seg: 5 });
  } else if (kind === 'lizard') {
    b.tube(p + 'tail', C, [tx + 6, by, 0], [tx - 28 * k, by - girth * 0.6, 0], w * 0.6, w * 0.35);
    b.cone(p + 'tail', C, [tx - 28 * k, by - girth * 0.6, 0], [tx - 52 * k, 4, 0], w * 0.35, { seg: 5 });
  } else if (kind !== 'frog' && kind !== 'bear') {
    const long = kind === 'cat' ? 1.5 : 1;
    b.tube(p + 'tail', kind === 'void' ? shade(C, 1.3) : C, [tx + 3, by + girth * 0.3, 0], [tx - 18 * k * long, by + girth * 0.1, 0], thick * 0.7, thick * 0.5);
    b.cone(p + 'tail', o.mane ?? C, [tx - 18 * k * long, by + girth * 0.1, 0], [tx - 34 * k * long, by - girth * 0.6, 0], thick * 0.55, { seg: 5 });
  }
  const front: V3 = [len * 0.48, by + girth * 0.5, 0];
  let top = by + girth;
  if (!o.headless) {
    const hb = p + 'head';
    const nb: V3 = [len * 0.42, by + girth * 0.4, 0];
    b.bone(hb, p + 'body', nb);
    const eyes = (c: V3, r: number, dz: number) => {
      for (const s of [-1, 1]) b.ell(hb, o.glow ?? '#151010', [c[0] + r * 0.55, c[1] + r * 0.3, s * r * dz], [r * 0.18, r * 0.2, r * 0.18], { detail: 0, lit: o.glow ? 1 : 0 });
    };
    switch (kind) {
      case 'horse': case 'deer': {
        const hc: V3 = [len * 0.62, by + girth + 20 * k, 0];
        b.tube(hb, C, nb, [hc[0] - 4 * k, hc[1], 0], girth * 0.62, girth * 0.42);
        b.ell(hb, C, [hc[0] + 6 * k, hc[1] - 4 * k, 0], [13 * k, 6 * k, 5.5 * k], { rot: [0, 0, -0.6] });
        b.ell(hb, D, [hc[0] + 13 * k, hc[1] - 11 * k, 0], [4.5 * k, 3.5 * k, 4.2 * k], { detail: 0 });
        for (const s of [-1, 1]) b.cone(hb, C, [hc[0] - 2 * k, hc[1] + 4 * k, s * 3 * k], [hc[0] - 4 * k, hc[1] + 11 * k, s * 4 * k], 2 * k, { seg: 4 });
        if (kind === 'horse') b.plate(hb, o.mane ?? D, [[0, 0], [3, 0], [-6, -20], [-14, -22]], 3 * k, [hc[0] - 4 * k, hc[1] + 4 * k, 0], { scale: [k, k, 1] });
        eyes([hc[0] + 2 * k, hc[1] - 1 * k, 0], 6 * k, 0.8);
        top = Math.max(top, hc[1] + 10 * k);
        break;
      }
      case 'cat': case 'wolf': case 'bear': case 'boar': case 'void': {
        const big = kind === 'bear' ? 1.25 : kind === 'void' ? 1.3 : 1;
        const r = 9 * k * big;
        const hc: V3 = [len * 0.62, by + girth * (kind === 'boar' ? 0.2 : 0.75), 0];
        b.tube(hb, C, nb, hc, girth * 0.7, r * 0.8);
        b.ell(hb, C, hc, [r, r * 0.9, r * 0.92]);
        const snout = kind === 'wolf' ? 1.0 : kind === 'boar' ? 0.9 : kind === 'bear' ? 0.6 : kind === 'void' ? 0 : 0.45;
        if (snout > 0) {
          b.ell(hb, kind === 'cat' || kind === 'wolf' ? B : shade(C, 1.15), [hc[0] + r * (0.6 + snout * 0.5), hc[1] - r * 0.25, 0], [r * (0.4 + snout * 0.4), r * 0.42, r * 0.5]);
          b.ell(hb, '#151010', [hc[0] + r * (0.95 + snout * 0.85), hc[1] - r * 0.15, 0], [r * 0.15, r * 0.13, r * 0.18], { detail: 0 });
        }
        if (kind === 'boar') for (const s of [-1, 1]) b.horn(hb, IVORY, [[hc[0] + r * 1.1, hc[1] - r * 0.5, s * r * 0.35], [hc[0] + r * 1.5, hc[1] - r * 0.1, s * r * 0.55], [hc[0] + r * 1.4, hc[1] + r * 0.5, s * r * 0.45]], r * 0.16);
        if (kind !== 'void') for (const s of [-1, 1]) b.cone(hb, C, [hc[0] - r * 0.2, hc[1] + r * 0.6, s * r * 0.5], [hc[0] - r * 0.35, hc[1] + r * (kind === 'bear' ? 1.05 : 1.5), s * r * 0.6], r * (kind === 'bear' ? 0.35 : 0.3), { seg: 4 });
        if (kind === 'cat' && o.mane) b.ell(hb, o.mane, [hc[0] - r * 0.4, hc[1], 0], [r * 0.7, r * 1.2, r * 1.2]);
        eyes(hc, r, 0.45);
        top = Math.max(top, hc[1] + r * 1.4);
        break;
      }
      case 'lizard': {
        const r = 10 * k;
        const hc: V3 = [len * 0.62, by + 2 * k, 0];
        b.tube(hb, C, nb, hc, girth * 0.75, r * 0.7);
        b.ell(hb, C, [hc[0] + r * 0.4, hc[1], 0], [r * 1.5, r * 0.6, r * 0.9]);
        b.ell(hb, B, [hc[0] + r * 0.6, hc[1] - r * 0.35, 0], [r * 1.3, r * 0.3, r * 0.8]);
        for (const s of [-1, 1]) b.ell(hb, o.glow ?? '#e0d040', [hc[0] + r * 0.2, hc[1] + r * 0.5, s * r * 0.55], [r * 0.25, r * 0.25, r * 0.25], { detail: 0, lit: 0.6 });
        for (let i = 0; i < 5; i++) b.cone(p + 'body', o.mane ?? D, [len * (0.35 - i * 0.15), by + girth * 0.85, 0], [len * (0.32 - i * 0.15), by + girth * 1.6, 0], 3.2 * k, { seg: 3 });
        top = Math.max(top, by + girth * 1.6);
        break;
      }
      case 'frog': {
        const r = 12 * k;
        const hc: V3 = [len * 0.45, by + girth * 0.3, 0];
        b.ell(hb, C, hc, [r * 1.1, r * 0.75, r * 1.2]);
        b.ell(hb, B, [hc[0] + r * 0.3, hc[1] - r * 0.35, 0], [r * 0.9, r * 0.35, r * 1.05]);
        for (const s of [-1, 1]) {
          b.ell(hb, C, [hc[0] + r * 0.1, hc[1] + r * 0.6, s * r * 0.6], [r * 0.38, r * 0.38, r * 0.38]);
          b.ell(hb, '#151010', [hc[0] + r * 0.4, hc[1] + r * 0.68, s * r * 0.62], [r * 0.14, r * 0.18, r * 0.18], { detail: 0 });
        }
        top = Math.max(top, hc[1] + r);
        break;
      }
    }
  }
  return { saddle: [-len * 0.02, by + girth, 0], front, top, legH };
}

/** Montura con jinete sentado. */
export function mounted(b: Builder, look: Look): number {
  const mk = look.mount ?? 'horse';
  const col = look.mountCol ?? '#6a4a2e';
  if (mk === 'bat') return batRider(b, look);
  const kind = mk === 'cat' ? 'cat' : mk === 'lizard' ? 'lizard' : 'horse';
  const q = quad(b, 'm', { kind, col, mane: kind === 'horse' ? shade(col, 0.5) : mk === 'cat' ? undefined : shade(col, 0.7), glow: look.glow && kind === 'horse' && lum(col) < 0.05 ? look.glow : undefined, k: kind === 'lizard' ? 1.15 : 1.15 });
  // Silla
  b.ell('mbody', look.pal[2], [q.saddle[0], q.saddle[1] - 1, 0], [11, 3, 13]);
  b.box('mbody', look.pal[0], [q.saddle[0], q.saddle[1] - 7, 0], [18, 12, 30]);
  let top = q.top;
  const build = look.build ?? 'slim';
  const RS = 0.8;
  const oy = q.saddle[1] + 2 - (BUILDS[build].leg + 3) * RS;
  b.at([q.saddle[0] - 2, oy, 0], () => {
    const h = humanoid(b, { ...look, build }, { legs: 'seated', parent: 'mbody' });
    top = Math.max(top, h.top * RS + oy);
  }, [0, 0, 0], RS);
  return top;
}

/** Batrider: troll sobre un murciélago gigante. */
function batRider(b: Builder, look: Look): number {
  const col = look.mountCol ?? '#4a3a40';
  const by = 36;
  b.bone('mbody', 'root', [0, by, 0]);
  b.ell('mbody', col, [0, by, 0], [22, 13, 15]);
  b.ell('mbody', shade(col, 1.3), [2, by - 5, 0], [16, 8, 11]);
  b.bone('mhead', 'mbody', [18, by + 4, 0]);
  b.ell('mhead', col, [26, by + 6, 0], [9, 8, 8]);
  for (const s of [-1, 1]) {
    b.cone('mhead', col, [24, by + 12, s * 4], [22, by + 26, s * 8], 3.5, { seg: 4 });
    b.ell('mhead', '#ff6a3a', [33, by + 8, s * 3], [1.2, 1.4, 1.4], { lit: 1, detail: 0 });
    const bn = 'wing' + lr(s);
    b.bone(bn, 'mbody', [4, by + 6, s * 10]);
    const out = (pts: [number, number][]) => pts.map(([x, y]) => [x * s, y] as [number, number]);
    b.tube(bn, shade(col, 1.2), [4, by + 6, s * 10], [0, by + 26, s * 44], 2.4, 1.6);
    b.tube(bn, shade(col, 1.2), [0, by + 26, s * 44], [-10, by + 14, s * 74], 1.6, 1);
    b.plate(bn, shade(col, 0.8), out([[0, 0], [34, 20], [64, 8], [52, -8], [36, -4], [22, -14], [8, -8]]), 0.8, [2, by + 6, s * 10], { plane: 'zy', rot: [0, -s * 0.15, 0] });
    b.bone('mleg' + lr(s), 'mbody', [-6, by - 8, s * 6]);
    b.tube('mleg' + lr(s), col, [-6, by - 8, s * 6], [-14, by - 22, s * 8], 2.2, 1.5);
  }
  let top = by + 30;
  const oy = by + 12 - (BUILDS.slim.leg + 3) * 0.85;
  b.at([-2, oy, 0], () => {
    const h = humanoid(b, { ...look, build: 'slim' }, { legs: 'seated', parent: 'mbody' });
    top = Math.max(top, h.top * 0.85 + oy);
  }, [0, 0, 0], 0.85);
  return top;
}

/** Centauro: cuerpo de cuadrúpedo con torso humanoide delante. */
export function centaur(b: Builder, look: Look, kind: BeastKind): number {
  const col = look.mountCol ?? look.pal[1];
  const q = quad(b, 'm', { kind, col, mane: look.hair, headless: true, k: look.build === 'heavy' ? 1.1 : 0.95 });
  let top = q.top;
  const hipLocal = BUILDS[look.build ?? 'normal'].leg + 3;
  b.at([q.front[0] - 6, q.front[1] - hipLocal - 2, 0], () => {
    const h = humanoid(b, look, { legs: 'none', parent: 'mbody' });
    top = Math.max(top, h.top + q.front[1] - hipLocal - 2);
  });
  return top;
}

/** Torso flotante con estela (espíritus) o cola de serpiente. */
export function floating(b: Builder, look: Look, tail: 'wisp' | 'snake'): number {
  const build = look.build ?? 'normal';
  const hipLocal = BUILDS[build].leg + 3;
  const lift = tail === 'snake' ? 44 : 34;
  let top = 0;
  let h!: Hum;
  b.at([0, lift - hipLocal, 0], () => { h = humanoid(b, look, { legs: 'none' }); top = h.top + lift - hipLocal; });
  const [P, S, , K] = look.pal;
  const cw = BUILDS[build].cw;
  if (tail === 'wisp') {
    b.bone('tail', 'hips', [0, lift - 2, 0]);
    b.bone('tail2', 'tail', [-6, lift - 20, 0]);
    b.lathe('tail', P, [[cw * 0.9, lift + 2], [cw * 1.1, lift - 8], [cw * 0.95, lift - 20]], [0, 0, 0], { seg: 7 });
    b.cone('tail2', shade(P, 0.75), [-6, lift - 20, 0], [-22, 2, 0], cw * 0.95, { seg: 7, rot: [Math.PI, 0, 0] });
    if (look.glow) b.cone('tail2', look.glow, [-8, lift - 24, 0], [-20, 6, 0], cw * 0.4, { seg: 5, lit: 0.7 });
  } else {
    const belly = mix(K, '#f0e0b0', 0.35);
    const chain: V3[] = [[0, lift - 4, 0], [-4, lift - 26, 0], [-24, 8, 4], [-50, 6, -8], [-72, 5, 4]];
    const rad = [cw * 0.95, cw * 0.9, cw * 0.75, cw * 0.55, cw * 0.3];
    const names = ['tail', 'tail2', 'tail3', 'tail4'];
    let parent = 'hips';
    for (let i = 0; i < 4; i++) {
      b.bone(names[i], parent, chain[i]);
      b.tube(names[i], i % 2 ? shade(K, 0.9) : K, chain[i], chain[i + 1], rad[i], rad[i + 1], { seg: 7 });
      b.ell(names[i], belly, [chain[i][0] + 2, chain[i][1] - 1, chain[i][2]], [rad[i] * 0.8, rad[i] * 0.7, rad[i] * 0.8], { detail: 0 });
      parent = names[i];
    }
    b.cone('tail4', S, chain[4], [-84, 5, 10], rad[4], { seg: 5 });
  }
  return top;
}

// ---------------------------------------------------------------------------
// Voladores: dragones y aves

export function flyer(b: Builder, look: Look): number {
  const [P, S, A, K] = look.pal;
  const G = look.glow ?? A;
  const bird = look.flyer === 'bird';
  const twin = look.acc.includes('second_head');
  const fairy = look.scale < 0.9;
  const by = 40;
  b.bone('body', 'root', [0, by, 0]);
  const lit = bird ? 0.75 : 0;
  b.ell('body', P, [0, by, 0], bird ? [16, 17, 13] : [26, 12, 12], { lit });
  b.ell('body', bird ? shade(A, 1) : mix(K, '#f0e0b0', 0.3), [4, by - 5, 0], bird ? [10, 11, 9] : [18, 8, 10], { lit: bird ? 1 : 0 });
  // Cuellos y cabezas
  const heads: [string, number, string][] = twin ? [['head', -1, S], ['head2', 1, K]] : [['head', 0, P]];
  for (const [hb, s, col] of heads) {
    const nb: V3 = [bird ? 10 : 18, by + 6, s * 6];
    const hc: V3 = bird ? [18, by + 18, 0] : [40, by + 26, s * 13];
    b.bone(hb, 'body', nb);
    b.tube(hb, col, nb, [hc[0] - 6, hc[1] - 4, hc[2]], bird ? 6 : 6, bird ? 5 : 4.5, { lit });
    const r = bird ? 8 : 7.5;
    b.ell(hb, col, hc, [r * 1.15, r * 0.8, r * 0.8], { lit });
    if (bird) {
      b.cone(hb, A, [hc[0] + r * 0.8, hc[1] - 1, 0], [hc[0] + r * 2.1, hc[1] - 4, 0], r * 0.32, { seg: 4, lit: 1 });
      b.plate(hb, G, [[0, 0], [4, 2], [-10, 18], [-18, 12]], 1.4, [hc[0] - 2, hc[1] + 4, 0], { lit: 1 });
    } else {
      b.ell(hb, shade(col, 1.15), [hc[0] + r * 1.3, hc[1] - r * 0.3, hc[2]], [r * 1.2, r * 0.42, r * 0.55]);
      b.box(hb, shade(col, 0.5), [hc[0] + r * 1.6, hc[1] - r * 0.55, hc[2]], [r * 1.3, r * 0.12, r * 0.7]);
      const hornCol = col === K && twin ? shade(K, 0.6) : BONE;
      for (const z of [-1, 1]) {
        b.ell(hb, twin ? (s < 0 ? '#bfe9ff' : '#ffb060') : G, [hc[0] + r * 0.5, hc[1] + r * 0.3, hc[2] + z * r * 0.5], [r * 0.18, r * 0.2, r * 0.18], { lit: 1, detail: 0 });
        if (look.acc.includes('horns')) b.horn(hb, hornCol, [[hc[0] - r * 0.2, hc[1] + r * 0.5, hc[2] + z * r * 0.4], [hc[0] - r * 1.0, hc[1] + r * 1.1, hc[2] + z * r * 0.6], [hc[0] - r * 1.9, hc[1] + r * 1.3, hc[2] + z * r * 0.5]], r * 0.25);
      }
      if (look.acc.includes('ice')) for (let i = 0; i < 4; i++) b.cone('body', '#e8f8ff', [8 - i * 10, by + 11, 0], [4 - i * 10, by + 22, 0], 3, { seg: 4, lit: 0.4 });
    }
  }
  // Alas: láminas horizontales (el perfil va hacia fuera en x y hacia atrás en y).
  const span = fairy ? 38 : bird ? 62 : 58;
  for (const s of [-1, 1]) {
    const bn = 'wing' + lr(s);
    const w0: V3 = [4, by + 8, s * 9];
    b.bone(bn, 'body', w0);
    const out = (pts: [number, number][]) => pts.map(([x, y]) => [x * s, y] as [number, number]);
    const flat = { plane: 'zy' as const, rot: [0, 0, Math.PI / 2] as V3 };
    if (bird) {
      b.tube(bn, A, w0, [6, by + 12, s * span * 0.5], 3, 2.2, { lit: 1 });
      b.tube(bn, A, [6, by + 12, s * span * 0.5], [0, by + 10, s * span], 2.2, 1, { lit: 1 });
      const feathers: [number, number][] = [[0, -2], [span * 0.5, -6], [span, 0], [span * 0.92, 10], [span * 0.82, 7], [span * 0.76, 20], [span * 0.62, 13], [span * 0.52, 27], [span * 0.38, 18], [span * 0.24, 30], [span * 0.1, 20], [0, 16]];
      b.plate(bn, G, out(feathers), 1.2, [w0[0] + 2, w0[1] + 1, w0[2]], { ...flat, lit: 1 });
      b.plate(bn, A, out(feathers.map(([x, y]) => [x * 0.8, y * 0.6] as [number, number])), 1.2, [w0[0] + 3, w0[1] + 2, w0[2]], { ...flat, lit: 1 });
    } else if (fairy) {
      for (const k2 of [0, 1]) b.plate(bn, k2 ? A : S, out([[0, 0], [span * 0.4, -10 + k2 * 22], [span, -4 + k2 * 26], [span * 0.7, 12 + k2 * 10], [span * 0.2, 10 + k2 * 6]]), 0.6, [w0[0] - k2 * 4, w0[1] + 1, w0[2]], { ...flat, lit: 0.5 });
    } else {
      const mid: V3 = [8, by + 13, s * span * 0.5];
      const tip: V3 = [2, by + 11, s * span];
      b.tube(bn, shade(S, 1.1), w0, mid, 2.6, 2);
      b.tube(bn, shade(S, 1.1), mid, tip, 2, 1);
      b.cone(bn, shade(S, 1.1), tip, [-4, by + 10, s * (span + 8)], 1.2, { seg: 4 });
      b.plate(bn, twin ? (s < 0 ? '#7aa8d0' : '#c0603a') : shade(S, 1.0),
        out([[0, 0], [span * 0.5, -4], [span, 2], [span * 0.82, 18], [span * 0.62, 13], [span * 0.45, 28], [span * 0.28, 20], [span * 0.1, 26], [0, 16]]),
        0.8, [w0[0] + 1, w0[1] + 2, w0[2]], flat);
    }
  }
  // Cola
  b.bone('tail', 'body', [-18, by, 0]);
  b.bone('tail2', 'tail', [-40, by - 6, 0]);
  if (bird) {
    for (let i = 0; i < 5; i++) b.plate('tail', i % 2 ? G : A, [[0, -3], [0, 3], [-46, 4 + (i - 2) * 6], [-52, (i - 2) * 6]], 1.2, [-12, by - 2, 0], { rot: [(i - 2) * 0.35, 0, 0.15], lit: 1 });
  } else {
    b.tube('tail', P, [-18, by, 0], [-40, by - 4, 0], 7, 4.5);
    b.tube('tail2', P, [-40, by - 4, 0], [-70, by - 2, 0], 4.5, 1.8);
    b.plate('tail2', A, [[0, 0], [-10, 7], [-18, 0], [-10, -7]], 1.2, [-68, by - 2, 0], { rot: [Math.PI / 2, 0, 0] });
    for (let i = 0; i < 4; i++) b.cone('body', A, [10 - i * 9, by + 11, 0], [7 - i * 9, by + 18, 0], 2.4, { seg: 3 });
  }
  // Patas recogidas
  for (const s of [-1, 1]) {
    b.tube('body', shade(P, 0.8), [-4, by - 8, s * 7], [-8, by - 20, s * 8], 3, 2.2);
    b.cone('body', DARK, [-8, by - 20, s * 8], [-2, by - 24, s * 8], 2.4, { seg: 4 });
  }
  return by + (bird ? 34 : 32);
}

// ---------------------------------------------------------------------------
// Insectos y arácnidos

export function insect(b: Builder, look: Look): number {
  const [P, S, A, K] = look.pal;
  const n = look.legs ?? 6;
  const spider = n >= 8;
  const by = spider ? 26 : 20;
  b.bone('body', 'root', [0, by, 0]);
  b.ell('body', P, [0, by, 0], [16, 10, 13]);
  if (look.acc.includes('shell')) b.ell('body', shade(P, 0.8), [-4, by + 6, 0], [20, 9, 16]);
  // Abdomen
  b.bone('abdomen', 'body', [-12, by + 2, 0]);
  const ab = spider ? [22, 18, 19] : look.acc.includes('wings_bug') ? [20, 6, 6] : [16, 9, 11];
  b.ell('abdomen', spider ? shade(P, 0.9) : S, [-12 - ab[0] * 0.85, by + (spider ? 10 : 2), 0], ab as V3);
  if (spider) {
    b.ell('abdomen', A, [-12 - ab[0] * 0.85, by + 10 + ab[1] * 0.85, 0], [ab[0] * 0.5, 3, ab[2] * 0.35], { lit: 0.3 });
    for (const s of [-1, 1]) b.ell('abdomen', A, [-12 - ab[0] * 1.2, by + 18, s * ab[2] * 0.6], [4, 3, 3], { lit: 0.3, detail: 0 });
  }
  // Cabeza
  b.bone('head', 'body', [12, by + 2, 0]);
  const hc: V3 = [22, by + 4, 0];
  head(b, { ...look, head: 'insect', pal: [shade(P, 1.05), S, A, K] }, 'head', hc, 9);
  // Patas
  for (let i = 0; i < n; i++) {
    const s = i % 2 ? 1 : -1;
    const pair = Math.floor(i / 2);
    const pairs = n / 2;
    const t = pairs > 1 ? pair / (pairs - 1) : 0.5;
    const px = 10 - t * 20;
    const dir = 1 - t * 2;
    const reach = spider ? 46 : 34;
    const root: V3 = [px, by, s * 10];
    const knee: V3 = [px + dir * reach * 0.45, by + (spider ? 26 : 14), s * (10 + reach * 0.55)];
    const foot: V3 = [px + dir * reach * 0.8, 0, s * (10 + reach * 0.85)];
    const bn = 'leg' + i;
    b.bone(bn, 'body', root);
    b.tube(bn, shade(P, 0.85), root, knee, 3, 2.4);
    b.tube(bn, shade(P, 0.7), knee, foot, 2.4, 1.0);
  }
  // Pinzas
  if (look.acc.includes('claws_big')) {
    for (const s of [-1, 1]) {
      const bn = 'arm' + lr(s);
      const sh: V3 = [14, by + 4, s * 11];
      b.bone(bn, 'body', sh);
      const el: V3 = [26, by + 14, s * 20];
      const tip: V3 = [44, by + 8, s * 16];
      b.tube(bn, P, sh, el, 4, 3.4);
      b.tube(bn, P, el, tip, 3.4, 4.5);
      b.cone(bn, shade(P, 1.1), tip, [56, by + 10, s * 12], 3.8, { seg: 4 });
      b.cone(bn, shade(P, 0.9), [tip[0] - 2, tip[1] - 3, tip[2]], [54, by + 2, s * 14], 2.6, { seg: 4 });
    }
  }
  // Aguijón del escorpión
  if (look.acc.includes('tail_stinger')) {
    b.bone('tail', 'abdomen', [-30, by + 4, 0]);
    b.bone('tail2', 'tail', [-40, by + 30, 0]);
    const pts: V3[] = [[-28, by + 2, 0], [-40, by + 14, 0], [-42, by + 30, 0], [-34, by + 44, 0], [-20, by + 50, 0]];
    for (let i = 0; i < 4; i++) b.ell(i < 2 ? 'tail' : 'tail2', i % 2 ? shade(P, 0.9) : P, [(pts[i][0] + pts[i + 1][0]) / 2, (pts[i][1] + pts[i + 1][1]) / 2, 0], [6 - i * 0.6, 8, 6 - i * 0.6]);
    b.cone('tail2', A, [-20, by + 50, 0], [-8, by + 42, 0], 4, { seg: 5 });
  }
  if (look.acc.includes('wings_bug')) {
    for (const s of [-1, 1]) {
      const bn = 'wing' + lr(s);
      b.bone(bn, 'body', [-2, by + 9, s * 5]);
      const out = (pts: [number, number][]) => pts.map(([x, y]) => [x * s, y] as [number, number]);
      for (const k of [0, 1]) b.plate(bn, k ? shade(A, 1.1) : mix(A, '#ffffff', 0.4), out([[0, 0], [24, 14 - k * 10], [52, 6 - k * 12], [30, -6 - k * 4]]), 0.5, [-2 - k * 6, by + 9, s * 5], { plane: 'zy', rot: [0.2, -s * 0.9, 0], lit: 0.3 });
    }
  }
  return by + (spider ? 30 : 20);
}

// ---------------------------------------------------------------------------
// Cuerpo amorfo (Io)

export function orb(b: Builder, look: Look): number {
  const [P, S, A] = look.pal;
  const by = 40;
  b.bone('body', 'root', [0, by, 0]);
  b.ball('body', P, [0, by, 0], [16, 16, 16], { lit: 0.45, seg: 10 });
  b.ball('body', A, [0, by, 0], [9, 9, 9], { lit: 1, seg: 8 });
  b.bone('spin', 'root', [0, by, 0]);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const tip: V3 = [Math.cos(a) * 30, by - 16 + (i % 2) * 22, Math.sin(a) * 30];
    b.cone('spin', S, [Math.cos(a) * 12, by, Math.sin(a) * 12], tip, 3.5, { seg: 4, lit: 0.8 });
    b.ell('spin', A, tip, [2.5, 2.5, 2.5], { lit: 1, detail: 0 });
  }
  return by + 18;
}

// ---------------------------------------------------------------------------
// Máquinas

export function vehicle(b: Builder, look: Look): number {
  const [P, S, A, K] = look.pal;
  const M = look.metal ?? '#9a9ea8';
  if (look.vehicle === 'copter') {
    const by = 30;
    b.bone('body', 'root', [0, by, 0]);
    b.ell('body', P, [0, by, 0], [24, 13, 13]);
    b.ell('body', shade(P, 0.8), [-6, by - 6, 0], [16, 7, 11]);
    b.tube('body', P, [-18, by + 2, 0], [-56, by + 8, 0], 5, 2.5);
    b.plate('body', A, [[0, 0], [6, 0], [-2, 18], [-8, 18]], 1.2, [-54, by + 8, 0]);
    for (const s of [-1, 1]) {
      b.tube('body', M, [16, by - 6, s * 10], [36, by - 6, s * 10], 2, 2);
      b.tube('body', DARK, [6, by - 12, s * 9], [6, by - 24, s * 12], 1.2);
      b.tube('body', DARK, [-12, by - 12, s * 9], [-12, by - 24, s * 12], 1.2);
      b.tube('body', DARK, [14, by - 24, s * 12], [-20, by - 24, s * 12], 1.4);
    }
    // Piloto: enano con gafas y barba
    b.bone('head', 'body', [6, by + 10, 0]);
    b.ell('head', A, [4, by + 12, 0], [8, 7, 9]);
    head(b, { ...look, head: 'human' }, 'head', [6, by + 22, 0], 7);
    b.cone('head', look.hair ?? '#e07a3a', [10, by + 18, 0], [12, by + 8, 0], 5, { seg: 5 });
    for (const s of [-1, 1]) b.cyl('head', '#9fd8ff', [12, by + 24, s * 2.6], 2.2, 2.2, 2.5, { rot: [0, 0, Math.PI / 2], seg: 7, lit: 0.4 });
    b.ell('head', '#7a4a2a', [5, by + 26, 0], [7, 3, 7.5]);
    // Rotor
    b.tube('body', DARK, [0, by + 12, 0], [0, by + 30, 0], 1.6);
    b.bone('spin', 'body', [0, by + 30, 0]);
    b.box('spin', S, [0, by + 30, 0], [96, 1.4, 6]);
    b.box('spin', S, [0, by + 30, 0], [6, 1.4, 96]);
    b.ell('spin', A, [0, by + 31, 0], [4, 3, 4]);
    return by + 32;
  }
  // Carro de Techies: tres goblins y una bomba
  const by = 20;
  b.bone('body', 'root', [0, by, 0]);
  b.box('body', '#8a5a2a', [0, by + 2, 0], [44, 14, 30]);
  b.box('body', shade('#8a5a2a', 0.7), [0, by + 9.5, 0], [46, 3, 32]);
  b.tube('body', '#8a5a2a', [22, by, 0], [40, by - 4, 0], 1.5);
  for (const s of [-1, 1]) {
    b.bone('wheel' + lr(s), 'body', [0, 12, s * 17]);
    b.cyl('wheel' + lr(s), '#3a2a1a', [0, 12, s * 17], 12, 12, 4, { rot: [Math.PI / 2, 0, 0], seg: 8 });
    b.box('wheel' + lr(s), M, [0, 12, s * 18.5], [22, 3, 1.5]);
    b.box('wheel' + lr(s), M, [0, 12, s * 18.5], [3, 22, 1.5]);
  }
  b.ball('body', '#2a2a30', [-10, by + 22, 0], [12, 12, 12], { seg: 8 });
  b.tube('body', DARK, [-10, by + 33, 0], [-6, by + 40, 0], 1);
  b.ell('body', '#ffcf40', [-6, by + 41, 0], [2.5, 3, 2.5], { lit: 1, detail: 0 });
  b.bone('head', 'body', [8, by + 10, 0]);
  const gob = [[10, 9, '#c03030'], [2, -10, '#3a6ab0'], [14, -4, '#e0a040']] as [number, number, string][];
  for (const [x, z, col] of gob) {
    b.ell('head', col, [x, by + 16, z], [5, 6, 5]);
    head(b, { ...look, head: 'goblin', pal: [P, S, A, K] }, 'head', [x + 1, by + 26, z], 5.5);
    b.cyl('head', DARK, [x + 1, by + 31, z], 4, 5, 3, { seg: 6 });
  }
  return by + 36;
}
