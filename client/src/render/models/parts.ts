// Piezas de los modelos: cabezas, accesorios y armas. Todas se construyen en el espacio del
// modelo (X delante, Y arriba, Z a la derecha) y se cuelgan de un hueso del esqueleto.
import * as THREE from 'three';
import type { Acc, Head, Look, Weapon } from './appearance';
import { IDLE_ARM, lr, type Builder, type Strike, type V3 } from './builder';

// ---------------------------------------------------------------------------
// Colores

const _c = new THREE.Color();
const _d = new THREE.Color();
/** Aclara (k > 1) u oscurece (k < 1) un color. */
export function shade(hex: string, k: number): string {
  _c.set(hex);
  if (k <= 1) _c.multiplyScalar(k);
  else _c.lerp(_d.set('#ffffff'), Math.min(1, k - 1));
  return '#' + _c.getHexString();
}
/** Luminancia aproximada (0-1) de un color. */
export function lum(hex: string): number {
  _c.set(hex);
  return _c.r * 0.3 + _c.g * 0.59 + _c.b * 0.11;
}
export function mix(a: string, b: string, t: number): string {
  _c.set(a).lerp(_d.set(b), t);
  return '#' + _c.getHexString();
}

export const WOOD = '#6a4a2e';
export const DARK = '#2a2220';
export const GOLD = '#e2b84a';
export const BONE = '#e6dcc4';
export const IVORY = '#efe6cf';

// ---------------------------------------------------------------------------
// Medidas de un humanoide ya construido (las usan accesorios y armas)

export interface Hum {
  hipY: number; cw: number; cd: number; torso: number;
  neckY: number; headC: V3; headR: number;
  shY: number; shX: number; shZ: number;
  hand: { L: V3; R: V3 };
  arm: number; legT: number;
  hunch: number;
  top: number;
  legs: 'walk' | 'seated' | 'none';
  backX: number;
  chestY: number;
  /** Escala de las armas según la complexión. */
  wk: number;
  /** Cabeza de criatura: el accesorio se adapta (orejas, cuernos más grandes…). */
  creature: boolean;
}

// ---------------------------------------------------------------------------
// Cabezas

type EyeOpts = { dx?: number; dy?: number; dz?: number; w?: number; h?: number };
function eyes(b: Builder, bone: string, c: V3, r: number, col: string, lit: number, o: EyeOpts = {}) {
  const dx = o.dx ?? 0.86, dy = o.dy ?? 0.12, dz = o.dz ?? 0.38;
  for (const s of [-1, 1]) {
    b.box(bone, col, [c[0] + r * dx, c[1] + r * dy, c[2] + s * r * dz], [1.6, r * (o.h ?? 0.2), r * (o.w ?? 0.3)], { rot: [0, 0, 0], lit });
  }
}

/** Construye la cabeza en el hueso `bone`, centrada en c con radio r. Devuelve la altura de la coronilla. */
export function head(b: Builder, look: Look, bone: string, c: V3, r: number): number {
  const [P, S, A, K] = look.pal;
  const G = look.glow;
  const kind: Head = look.head ?? 'human';
  const [x, y, z] = c;
  const glowEyes = (col = G ?? '#ffe080', o: EyeOpts = {}) => eyes(b, bone, c, r, col, 1, o);
  const darkEyes = (o: EyeOpts = {}) => eyes(b, bone, c, r, '#1a1414', 0, o);
  switch (kind) {
    case 'human': case 'mask': {
      b.ell(bone, K, c, [r * 0.95, r * 1.05, r * 0.88]);
      b.ell(bone, shade(K, 0.92), [x + r * 0.55, y - r * 0.45, z], [r * 0.45, r * 0.4, r * 0.55], { detail: 0 });
      darkEyes();
      if (kind === 'mask') b.box(bone, A, [x + r * 0.9, y + r * 0.05, z], [2, r * 1.3, r * 1.4]);
      return y + r;
    }
    case 'beast': {
      b.ell(bone, K, c, [r, r * 0.95, r * 0.95]);
      b.ell(bone, shade(K, 1.15), [x + r * 0.95, y - r * 0.25, z], [r * 0.75, r * 0.5, r * 0.55]);
      b.ell(bone, '#1a1414', [x + r * 1.65, y - r * 0.12, z], [r * 0.2, r * 0.18, r * 0.24], { detail: 0 });
      if (G) glowEyes(G, { dx: 0.78, dy: 0.25, dz: 0.42 }); else darkEyes({ dy: 0.25 });
      return y + r;
    }
    case 'bull': {
      b.ell(bone, K, c, [r * 1.05, r, r * 1.05]);
      b.ell(bone, shade(K, 1.2), [x + r * 0.9, y - r * 0.35, z], [r * 0.65, r * 0.55, r * 0.75]);
      for (const s of [-1, 1]) b.ell(bone, '#1a1414', [x + r * 1.5, y - r * 0.3, z + s * r * 0.3], [r * 0.12, r * 0.14, r * 0.14], { detail: 0 });
      if (G) glowEyes(G, { dx: 0.8, dy: 0.25, dz: 0.5 }); else darkEyes({ dy: 0.25, dz: 0.5 });
      return y + r;
    }
    case 'bird': {
      b.ell(bone, K, c, [r * 0.95, r, r * 0.85]);
      b.cone(bone, A, [x + r * 0.7, y - r * 0.05, z], [x + r * 2.2, y - r * 0.5, z], r * 0.38, { seg: 4 });
      if (G) glowEyes(G, { dy: 0.25, dz: 0.45 }); else darkEyes({ dy: 0.25, dz: 0.45 });
      return y + r;
    }
    case 'skull': {
      b.ell(bone, K, [x, y + r * 0.1, z], [r * 0.95, r * 0.95, r * 0.85]);
      b.box(bone, shade(K, 0.9), [x + r * 0.55, y - r * 0.65, z], [r * 0.7, r * 0.45, r * 1.0]);
      for (const s of [-1, 1]) b.ell(bone, '#120e0e', [x + r * 0.72, y + r * 0.05, z + s * r * 0.36], [r * 0.25, r * 0.28, r * 0.26], { detail: 0 });
      glowEyes(G ?? '#ff3020', { dx: 0.9, dy: 0.05, dz: 0.36, h: 0.16, w: 0.18 });
      return y + r * 1.05;
    }
    case 'helm': {
      const M = look.metal ?? '#b8bcc6';
      b.ell(bone, M, [x, y + r * 0.08, z], [r * 1.05, r * 1.12, r * 1.0]);
      b.box(bone, shade(M, 0.8), [x + r * 0.85, y - r * 0.2, z], [r * 0.4, r * 1.1, r * 0.35]);
      b.box(bone, '#141010', [x + r * 0.92, y + r * 0.12, z], [r * 0.3, r * 0.18, r * 1.3]);
      if (G) glowEyes(G, { dx: 0.98, dy: 0.12, dz: 0.3, h: 0.14 });
      return y + r * 1.15;
    }
    case 'fish': {
      b.ell(bone, K, [x + r * 0.25, y, z], [r * 1.25, r * 0.85, r * 1.05]);
      b.box(bone, shade(K, 0.45), [x + r * 1.2, y - r * 0.32, z], [r * 0.5, r * 0.12, r * 1.3]);
      for (const s of [-1, 1]) b.ell(bone, G ?? '#f0e8a0', [x + r * 0.7, y + r * 0.35, z + s * r * 0.75], [r * 0.25, r * 0.3, r * 0.25], { detail: 0, lit: G ? 1 : 0 });
      return y + r * 0.9;
    }
    case 'frog': {
      b.ell(bone, K, [x + r * 0.2, y - r * 0.1, z], [r * 1.25, r * 0.8, r * 1.4]);
      b.ell(bone, shade(K, 1.3), [x + r * 0.55, y - r * 0.5, z], [r * 0.9, r * 0.35, r * 1.2]);
      for (const s of [-1, 1]) {
        b.ell(bone, shade(K, 1.1), [x + r * 0.45, y + r * 0.55, z + s * r * 0.65], [r * 0.4, r * 0.4, r * 0.4]);
        b.ell(bone, '#1a1414', [x + r * 0.78, y + r * 0.6, z + s * r * 0.68], [r * 0.15, r * 0.2, r * 0.2], { detail: 0 });
      }
      return y + r * 0.95;
    }
    case 'demon': {
      b.ell(bone, K, c, [r * 0.95, r * 1.05, r * 0.85]);
      b.box(bone, shade(K, 0.85), [x + r * 0.55, y - r * 0.55, z], [r * 0.9, r * 0.55, r * 1.1], { rot: [0, 0, -0.25] });
      b.box(bone, shade(K, 0.7), [x + r * 0.75, y + r * 0.35, z], [r * 0.4, r * 0.25, r * 1.4]);
      glowEyes(G ?? '#ff3020', { dy: 0.12, h: 0.16, w: 0.34 });
      return y + r;
    }
    case 'insect': {
      b.ell(bone, P, c, [r * 1.05, r * 0.9, r * 0.95]);
      for (const s of [-1, 1]) {
        b.ell(bone, G ?? '#c03030', [x + r * 0.6, y + r * 0.2, z + s * r * 0.55], [r * 0.38, r * 0.45, r * 0.35], { lit: G ? 0.9 : 0.2 });
        b.cone(bone, shade(P, 0.6), [x + r * 0.8, y - r * 0.5, z + s * r * 0.3], [x + r * 1.6, y - r * 0.7, z + s * r * 0.05], r * 0.2, { seg: 4 });
      }
      return y + r * 0.9;
    }
    case 'rock': {
      b.ell(bone, K, c, [r * 1.1, r * 0.95, r * 1.05], { detail: 0 });
      b.ell(bone, shade(K, 0.85), [x + r * 0.5, y - r * 0.4, z], [r * 0.7, r * 0.5, r * 0.85], { detail: 0 });
      glowEyes(G ?? '#7af0ff', { dx: 0.95, dy: 0.15, h: 0.18, w: 0.25 });
      return y + r * 0.95;
    }
    case 'void': {
      b.ell(bone, shade(P, 0.9), c, [r * 0.95, r * 1.1, r * 0.9]);
      glowEyes(G ?? '#ffffff', { dx: 0.88, dy: 0.1, h: 0.14, w: 0.36 });
      return y + r * 1.1;
    }
    case 'troll': {
      b.ell(bone, K, c, [r * 0.95, r * 1.0, r * 0.85]);
      b.cone(bone, shade(K, 0.95), [x + r * 0.7, y - r * 0.05, z], [x + r * 1.8, y - r * 0.35, z], r * 0.28, { seg: 5 });
      for (const s of [-1, 1]) {
        b.cone(bone, K, [x - r * 0.1, y + r * 0.2, z + s * r * 0.7], [x - r * 0.7, y + r * 0.5, z + s * r * 1.9], r * 0.28, { seg: 4 });
        b.cone(bone, IVORY, [x + r * 0.7, y - r * 0.55, z + s * r * 0.35], [x + r * 1.05, y + r * 0.0, z + s * r * 0.5], r * 0.13, { seg: 4 });
      }
      if (G) glowEyes(G, { dy: 0.2 }); else darkEyes({ dy: 0.2 });
      return y + r;
    }
    case 'goblin': {
      b.ell(bone, K, c, [r * 0.95, r, r * 0.9]);
      b.cone(bone, shade(K, 0.95), [x + r * 0.7, y, z], [x + r * 1.5, y - r * 0.3, z], r * 0.3, { seg: 5 });
      for (const s of [-1, 1]) b.cone(bone, K, [x, y + r * 0.2, z + s * r * 0.7], [x - r * 0.3, y + r * 0.5, z + s * r * 2.3], r * 0.45, { seg: 4 });
      if (G) glowEyes(G, { dy: 0.25 }); else darkEyes({ dy: 0.25 });
      return y + r;
    }
    case 'ape': {
      b.ell(bone, K, c, [r * 0.95, r, r * 0.9]);
      b.ell(bone, shade(K, 1.35), [x + r * 0.75, y - r * 0.3, z], [r * 0.5, r * 0.45, r * 0.6]);
      for (const s of [-1, 1]) b.ell(bone, shade(K, 1.2), [x, y + r * 0.1, z + s * r * 0.95], [r * 0.2, r * 0.35, r * 0.25], { detail: 0 });
      darkEyes({ dy: 0.25 });
      return y + r;
    }
    case 'rodent': {
      b.ell(bone, K, c, [r * 1.0, r * 0.9, r * 0.9]);
      b.ell(bone, shade(K, 1.3), [x + r * 0.8, y - r * 0.25, z], [r * 0.5, r * 0.38, r * 0.42]);
      b.ell(bone, '#1a1414', [x + r * 1.28, y - r * 0.18, z], [r * 0.14, r * 0.12, r * 0.14], { detail: 0 });
      darkEyes({ dy: 0.2, dz: 0.42 });
      return y + r;
    }
    case 'panda': {
      const W = look.hair ?? '#f0ece0';
      b.ell(bone, W, c, [r * 1.05, r, r * 1.05]);
      b.ell(bone, shade(W, 1.1), [x + r * 0.8, y - r * 0.3, z], [r * 0.5, r * 0.4, r * 0.55]);
      b.ell(bone, '#1a1414', [x + r * 1.25, y - r * 0.2, z], [r * 0.14, r * 0.12, r * 0.16], { detail: 0 });
      for (const s of [-1, 1]) {
        b.ell(bone, '#1e1a1a', [x + r * 0.7, y + r * 0.15, z + s * r * 0.4], [r * 0.3, r * 0.3, r * 0.26], { detail: 0 });
        b.ell(bone, '#1e1a1a', [x - r * 0.1, y + r * 0.85, z + s * r * 0.7], [r * 0.3, r * 0.3, r * 0.2], { detail: 0 });
      }
      if (G) glowEyes(G, { dx: 0.92, dy: 0.18, dz: 0.4, h: 0.12, w: 0.14 });
      return y + r * 1.1;
    }
    case 'reptile': {
      b.ell(bone, K, c, [r * 1.0, r * 0.85, r * 0.85]);
      b.ell(bone, shade(K, 1.1), [x + r * 1.0, y - r * 0.25, z], [r * 0.85, r * 0.45, r * 0.55]);
      glowEyes(G ?? '#e0e040', { dx: 0.6, dy: 0.35, dz: 0.55 });
      return y + r * 0.9;
    }
    case 'tree': {
      b.ell(bone, K, c, [r * 0.9, r * 1.2, r * 0.9], { detail: 0 });
      b.box(bone, shade(K, 0.7), [x + r * 0.6, y - r * 0.4, z], [r * 0.6, r * 0.5, r * 1.1]);
      glowEyes(G ?? '#d0ff7a', { dx: 0.85, dy: 0.15, dz: 0.36 });
      return y + r * 1.2;
    }
  }
  return y + r;
}

// ---------------------------------------------------------------------------
// Accesorios de humanoide

export function accessories(b: Builder, look: Look, h: Hum) {
  const [P, S, A, K] = look.pal;
  const HAIR = look.hair ?? shade(S, 0.8);
  const G = look.glow ?? A;
  const M = look.metal ?? '#c4c8d0';
  const [hx, hy, hz] = h.headC;
  const r = h.headR;
  const has = (a: Acc) => look.acc.includes(a);
  const covered = has('hood') || has('helm') || has('helm_horned') || has('hat_wide') || has('hat_pointy') || has('hat_tricorn') || has('hat_top') || look.head === 'helm';
  const hornCol = look.head === 'demon' || look.head === 'void' ? '#221c22' : BONE;
  const top = (v: number) => { h.top = Math.max(h.top, v); };
  const ensureCape = () => { if (!b.has('cape')) b.bone('cape', 'chest', [h.backX, h.shY + 2, 0]); };

  for (const a of look.acc) {
    switch (a) {
      case 'horns': for (const s of [-1, 1]) b.horn('head', hornCol, [[hx, hy + r * 0.6, s * r * 0.5], [hx + r * 0.1, hy + r * 1.3, s * r * 0.95], [hx + r * 0.5, hy + r * 1.8, s * r * 1.05]], r * 0.3); top(hy + r * 1.8); break;
      case 'horns_ram': for (const s of [-1, 1]) b.torus('head', hornCol, [hx - r * 0.1, hy + r * 0.3, s * r * 0.95], r * 0.5, r * 0.18, { rot: [0, 0, 0], arc: Math.PI * 1.6 }); break;
      case 'horns_long': for (const s of [-1, 1]) b.horn('head', hornCol, [[hx, hy + r * 0.55, s * r * 0.55], [hx - r * 0.6, hy + r * 1.4, s * r * 1.3], [hx - r * 1.6, hy + r * 2.1, s * r * 1.7], [hx - r * 2.6, hy + r * 2.3, s * r * 1.6]], r * 0.36); top(hy + r * 2.3); break;
      case 'horn_nose': b.horn('head', IVORY, [[hx + r * 1.2, hy - r * 0.1, hz], [hx + r * 1.7, hy + r * 0.6, hz], [hx + r * 1.6, hy + r * 1.5, hz]], r * 0.35); break;
      case 'antlers': {
        const col = look.head === 'tree' ? shade(S, 1.1) : '#c8a878';
        for (const s of [-1, 1]) {
          const base: V3 = [hx - r * 0.1, hy + r * 0.7, s * r * 0.45];
          const mid: V3 = [hx - r * 0.3, hy + r * 1.9, s * r * 1.3];
          const tip: V3 = [hx - r * 0.2, hy + r * 3.0, s * r * 2.3];
          b.tube('head', col, base, mid, r * 0.16, r * 0.13);
          b.cone('head', col, mid, tip, r * 0.13, { seg: 4 });
          b.cone('head', col, [mid[0], mid[1], mid[2]], [hx + r * 0.6, hy + r * 2.6, s * r * 1.4], r * 0.11, { seg: 4 });
          b.cone('head', col, [hx - r * 0.25, hy + r * 1.4, s * r * 0.95], [hx - r * 1.1, hy + r * 2.4, s * r * 1.3], r * 0.1, { seg: 4 });
        }
        top(hy + r * 3);
        break;
      }
      case 'tusks': for (const s of [-1, 1]) b.horn('head', IVORY, [[hx + r * 0.7, hy - r * 0.55, s * r * 0.4], [hx + r * 1.2, hy - r * 0.8, s * r * 0.55], [hx + r * 1.5, hy - r * 0.1, s * r * 0.6]], r * 0.2); break;
      case 'ears_long': for (const s of [-1, 1]) b.cone('head', K, [hx - r * 0.1, hy + r * 0.1, s * r * 0.8], [hx - r * 0.6, hy + r * 0.6, s * r * 2.0], r * 0.25, { seg: 4 }); break;
      case 'ears_beast': for (const s of [-1, 1]) b.cone('head', h.creature ? K : HAIR, [hx - r * 0.1, hy + r * 0.7, s * r * 0.55], [hx - r * 0.2, hy + r * 1.6, s * r * 0.8], r * 0.32, { seg: 4 }); top(hy + r * 1.6); break;
      case 'hair':
        if (!covered) b.ell('head', HAIR, [hx - r * 0.3, hy + r * 0.38, hz], [r * 0.85, r * 0.75, r * 1.0]);
        b.ell('head', HAIR, [hx - r * 0.75, hy - r * 0.6, hz], [r * 0.45, r * 1.3, r * 0.95]);
        break;
      case 'ponytail':
        if (!covered) b.ell('head', HAIR, [hx - r * 0.32, hy + r * 0.4, hz], [r * 0.82, r * 0.72, r * 0.98]);
        b.ball('head', HAIR, [hx - r * 0.95, hy + r * 0.5, hz], [r * 0.3, r * 0.3, r * 0.3]);
        b.cone('head', HAIR, [hx - r * 1.05, hy + r * 0.35, hz], [hx - r * 1.8, hy - r * 2.2, hz], r * 0.4, { seg: 5 });
        break;
      case 'topknot':
        if (!covered) b.ell('head', HAIR, [hx - r * 0.32, hy + r * 0.4, hz], [r * 0.82, r * 0.7, r * 0.98]);
        b.ball('head', HAIR, [hx - r * 0.3, hy + r * 1.15, hz], [r * 0.35, r * 0.35, r * 0.35]);
        b.cone('head', HAIR, [hx - r * 0.4, hy + r * 1.2, hz], [hx - r * 1.6, hy + r * 0.4, hz], r * 0.28, { seg: 5 });
        top(hy + r * 1.5);
        break;
      case 'mohawk':
        b.plate('head', HAIR, [[-r * 1.2, 0], [r * 0.9, 0], [r * 0.6, r * 0.9], [-r * 0.2, r * 1.3], [-r * 1.3, r * 0.6]], r * 0.35, [hx, hy + r * 0.6, hz]);
        top(hy + r * 1.9);
        break;
      case 'beard': {
        const col = look.hair ?? '#e8e8e8';
        b.cone('head', col, [hx + r * 0.6, hy - r * 0.55, hz], [hx + r * 0.9, hy - r * 2.0, hz], r * 0.7, { seg: 5 });
        break;
      }
      case 'hood': {
        const col = shade(P, 0.85);
        b.ell('head', col, [hx - r * 0.25, hy + r * 0.15, hz], [r * 1.2, r * 1.25, r * 1.15]);
        b.cone('head', col, [hx - r * 0.8, hy + r * 0.7, hz], [hx - r * 1.7, hy + r * 1.3, hz], r * 0.55, { seg: 5 });
        b.ell('head', shade(P, 0.25), [hx + r * 0.62, hy, hz], [r * 0.35, r * 0.85, r * 0.75], { detail: 0 });
        if (look.glow && look.head !== 'skull') eyes(b, 'head', h.headC, r, look.glow, 1, { dx: 0.92, dy: 0.05, h: 0.14, w: 0.24 });
        top(hy + r * 1.4);
        break;
      }
      case 'crown': {
        b.cyl('head', GOLD, [hx - r * 0.05, hy + r * 0.85, hz], r * 0.85, r * 0.75, r * 0.4, { seg: 8 });
        for (let i = 0; i < 6; i++) {
          const a2 = (i / 6) * Math.PI * 2;
          b.cone('head', GOLD, [hx - r * 0.05 + Math.cos(a2) * r * 0.78, hy + r * 1.0, hz + Math.sin(a2) * r * 0.78], [hx - r * 0.05 + Math.cos(a2) * r * 0.85, hy + r * 1.7, hz + Math.sin(a2) * r * 0.85], r * 0.18, { seg: 4 });
        }
        b.ell('head', G, [hx + r * 0.75, hy + r * 0.9, hz], [r * 0.15, r * 0.2, r * 0.2], { lit: 1, detail: 0 });
        top(hy + r * 1.7);
        break;
      }
      case 'circlet':
        b.torus('head', GOLD, [hx, hy + r * 0.45, hz], r * 0.93, r * 0.09, { rot: [Math.PI / 2, 0, 0.12], tub: 14 });
        b.ell('head', G, [hx + r * 0.95, hy + r * 0.52, hz], [r * 0.12, r * 0.16, r * 0.16], { lit: 1, detail: 0 });
        break;
      case 'halo':
        b.torus('head', look.glow ?? '#ffe080', [hx - r * 0.6, hy + r * 1.2, hz], r * 1.1, r * 0.12, { rot: [Math.PI / 2, 0.5, 0], lit: 1, tub: 16 });
        top(hy + r * 1.6);
        break;
      case 'helm':
        if (look.head === 'helm') break;
        b.ell('head', M, [hx - r * 0.05, hy + r * 0.3, hz], [r * 1.05, r * 0.85, r * 1.02]);
        b.box('head', shade(M, 0.8), [hx + r * 0.9, hy - r * 0.05, hz], [r * 0.2, r * 0.8, r * 0.2]);
        top(hy + r * 1.15);
        break;
      case 'helm_horned':
        b.ell('head', M, [hx - r * 0.05, hy + r * 0.3, hz], [r * 1.05, r * 0.85, r * 1.02]);
        for (const s of [-1, 1]) b.horn('head', IVORY, [[hx, hy + r * 0.5, s * r * 0.9], [hx + r * 0.1, hy + r * 0.9, s * r * 1.7], [hx + r * 0.3, hy + r * 1.9, s * r * 2.0]], r * 0.3);
        top(hy + r * 1.9);
        break;
      case 'crest': {
        const col = look.head === 'bird' || look.head === 'void' ? A : shade(A, 0.9);
        b.plate('head', col, [[-r * 1.4, r * 0.2], [r * 0.5, 0], [r * 0.25, r * 0.8], [-r * 0.5, r * 1.25], [-r * 1.9, r * 0.95]], r * 0.28, [hx, hy + r * 0.7, hz], { lit: look.head === 'void' ? 0.5 : 0 });
        top(hy + r * 1.95);
        break;
      }
      case 'hat_wide': {
        const col = look.pal[1];
        b.cyl('head', col, [hx - r * 0.1, hy + r * 0.62, hz], r * 2.3, r * 2.3, r * 0.18, { seg: 10 });
        b.cyl('head', col, [hx - r * 0.1, hy + r * 1.05, hz], r * 0.7, r * 0.88, r * 0.9, { seg: 8 });
        b.cyl('head', A, [hx - r * 0.1, hy + r * 0.78, hz], r * 0.9, r * 0.9, r * 0.2, { seg: 8 });
        top(hy + r * 1.5);
        break;
      }
      case 'hat_pointy': {
        const col = look.pal[0];
        b.cyl('head', col, [hx - r * 0.1, hy + r * 0.6, hz], r * 1.7, r * 1.7, r * 0.16, { seg: 10 });
        b.cone('head', col, [hx - r * 0.1, hy + r * 0.62, hz], [hx - r * 0.9, hy + r * 3.4, hz], r * 1.0, { seg: 7 });
        b.cyl('head', A, [hx - r * 0.1, hy + r * 0.82, hz], r * 1.0, r * 1.02, r * 0.25, { seg: 8 });
        top(hy + r * 3.4);
        break;
      }
      case 'hat_tricorn': {
        b.cyl('head', DARK, [hx - r * 0.1, hy + r * 0.72, hz], r * 1.9, r * 1.9, r * 0.5, { seg: 3, rot: [0, Math.PI, 0] });
        b.cyl('head', DARK, [hx - r * 0.1, hy + r * 1.05, hz], r * 0.8, r * 0.95, r * 0.7, { seg: 8 });
        b.cyl('head', GOLD, [hx - r * 0.1, hy + r * 0.97, hz], r * 1.92, r * 1.92, r * 0.12, { seg: 3, rot: [0, Math.PI, 0] });
        top(hy + r * 1.5);
        break;
      }
      case 'hat_top':
        b.cyl('head', DARK, [hx - r * 0.05, hy + r * 0.7, hz], r * 1.5, r * 1.5, r * 0.15, { seg: 10 });
        b.cyl('head', DARK, [hx - r * 0.05, hy + r * 1.75, hz], r * 0.8, r * 0.75, r * 2.0, { seg: 8 });
        b.cyl('head', A, [hx - r * 0.05, hy + r * 1.0, hz], r * 0.79, r * 0.79, r * 0.35, { seg: 8 });
        top(hy + r * 2.8);
        break;
      case 'goggles':
        for (const s of [-1, 1]) b.cyl('head', A, [hx + r * 0.8, hy + r * 0.45, hz + s * r * 0.38], r * 0.32, r * 0.32, r * 0.35, { rot: [0, 0, Math.PI / 2], seg: 8, lit: 0.35 });
        b.torus('head', DARK, [hx, hy + r * 0.45, hz], r * 0.95, r * 0.1, { rot: [Math.PI / 2, 0, 0], tub: 12 });
        break;
      case 'mask':
        if (look.head === 'mask') break;
        b.plate('head', A, [[-r * 0.9, -r * 0.8], [r * 0.9, -r * 0.8], [r * 1.0, r * 0.6], [0, r * 1.1], [-r * 1.0, r * 0.6]], r * 0.3, [hx + r * 0.88, hy, hz], { plane: 'zy' });
        eyes(b, 'head', h.headC, r, look.glow ?? '#120e0e', look.glow ? 1 : 0, { dx: 1.05, dy: 0.15, h: 0.16, w: 0.3 });
        break;
      case 'mask_tall': {
        b.plate('head', IVORY, [[-r * 1.0, -r * 1.0], [r * 1.0, -r * 1.0], [r * 1.1, r * 1.6], [0, r * 2.6], [-r * 1.1, r * 1.6]], r * 0.35, [hx + r * 0.9, hy, hz], { plane: 'zy' });
        b.box('head', '#c03020', [hx + r * 1.1, hy + r * 0.9, hz], [r * 0.12, r * 1.4, r * 0.18]);
        b.box('head', '#141010', [hx + r * 1.1, hy + r * 0.15, hz], [r * 0.15, r * 0.18, r * 1.3]);
        b.cone('head', HAIR, [hx - r * 0.3, hy + r * 1.1, hz], [hx - r * 1.8, hy + r * 1.8, hz], r * 0.45, { seg: 5 });
        top(hy + r * 2.6);
        break;
      }
      case 'veil':
        b.box('head', shade(P, 0.9), [hx + r * 0.78, hy - r * 0.35, hz], [r * 0.3, r * 0.75, r * 1.5]);
        break;
      case 'headdress':
        for (let i = 0; i < 5; i++) {
          const t2 = (i - 2) * 0.42;
          const col = i % 2 ? A : P;
          b.plate('head', col, [[-r * 0.25, 0], [r * 0.25, 0], [r * 0.2, r * 1.9], [0, r * 2.3], [-r * 0.2, r * 1.9]], r * 0.12, [hx - r * 0.5, hy + r * 0.5, hz + Math.sin(t2) * r * 0.8], { plane: 'zy', rot: [t2 * 0.9, 0, 0.35] });
        }
        top(hy + r * 2.6);
        break;
      case 'snake_hair':
        for (let i = 0; i < 7; i++) {
          const a2 = (i / 7) * Math.PI * 2;
          const sx = Math.cos(a2) * r * 0.75, sz = Math.sin(a2) * r * 0.85;
          b.horn('head', i % 2 ? K : shade(K, 0.8), [[hx + sx * 0.6 - r * 0.2, hy + r * 0.5, hz + sz * 0.6], [hx + sx * 1.4 - r * 0.4, hy + r * 1.2, hz + sz * 1.5], [hx + sx * 1.9 - r * 0.6, hy + r * 0.7, hz + sz * 2.0]], r * 0.22);
        }
        top(hy + r * 1.4);
        break;
      case 'fins':
        for (const s of [-1, 1]) b.plate('head', A, [[0, 0], [r * 0.4, r * 0.5], [-r * 1.5, r * 0.9], [-r * 1.0, 0]], r * 0.1, [hx - r * 0.2, hy + r * 0.1, s * r * 0.9], { rot: [s * 0.5, 0, 0] });
        b.plate('chest', A, [[0, 0], [-h.torso * 0.2, h.torso * 0.75], [-h.torso * 0.75, h.torso * 0.25]], 1.2, [h.backX + 1, h.chestY - h.torso * 0.3, 0]);
        break;
      case 'frill':
        b.plate('head', A, [[-r * 2.0, -r * 1.2], [-r * 0.2, -r * 1.4], [-r * 0.5, r * 1.6], [-r * 1.9, r * 1.2]], r * 0.12, [hx - r * 0.3, hy, hz], { plane: 'zy' });
        b.plate('head', shade(A, 0.8), [[-r * 2.0, -r * 1.2], [-r * 0.2, -r * 1.4], [-r * 0.5, r * 1.6], [-r * 1.9, r * 1.2]], r * 0.12, [hx - r * 0.3, hy, hz], { plane: 'zy', scale: [1, 1.2, 0.6] });
        top(hy + r * 1.6);
        break;
      case 'nose_ring':
        b.torus('head', GOLD, [hx + r * 1.45, hy - r * 0.6, hz], r * 0.3, r * 0.07, { rot: [0, Math.PI / 2, 0] });
        break;
      case 'second_head': {
        const c2: V3 = [hx - r * 0.1, hy + r * 0.1, -r * 1.9];
        b.bone('head2', 'chest', [h.headC[0] - r * 0.3, h.neckY, -r * 1.6]);
        b.tube('head2', K, [hx - r * 0.3, h.neckY - 3, -r * 1.2], c2, r * 0.45);
        head(b, { ...look, head: look.head ?? 'human' }, 'head2', c2, r * 0.9);
        break;
      }
      // ------------------------------------------------------------ cuerpo
      case 'cape': {
        ensureCape();
        const len = h.legs === 'walk' ? h.shY - 12 : h.shY - h.hipY + 14;
        const w = h.cw * 1.15;
        const col = shade(P, 0.75);
        b.plate('cape', col, [[-w, 0], [w, 0], [w * 1.25, -len], [w * 0.4, -len - 5], [-w * 0.4, -len - 5], [-w * 1.25, -len]], 1.6, [h.backX - 1, h.shY + 2, 0], { plane: 'zy' });
        b.ell('chest', shade(P, 0.7), [h.backX + 3, h.shY + 1, 0], [4, 3, h.cw + 3]);
        break;
      }
      case 'robe': {
        if (h.legs !== 'walk') break;
        const y0 = h.hipY + 4;
        b.lathe('hips', P, [[h.cw * 0.95, y0], [h.cw * 1.2, y0 - 10], [h.cw * 1.55, 6], [h.cw * 1.6, 2]], [0, 0, 0], { seg: 8, scale: [h.cd / h.cw * 1.1, 1, 1] });
        b.lathe('hips', A, [[h.cw * 1.62, 7], [h.cw * 1.66, 3]], [0, 0, 0], { seg: 8, scale: [h.cd / h.cw * 1.1, 1, 1] });
        break;
      }
      case 'skirt': {
        if (h.legs !== 'walk') break;
        const y0 = h.hipY + 4;
        b.lathe('hips', A === GOLD ? P : mix(P, A, 0.3), [[h.cw * 0.95, y0], [h.cw * 1.35, y0 - 16], [h.cw * 1.45, y0 - 20]], [0, 0, 0], { seg: 8, scale: [h.cd / h.cw * 1.2, 1, 1] });
        break;
      }
      case 'loincloth':
        for (const s of [-1, 1]) b.plate('hips', A, [[-h.cw * 0.45, 0], [h.cw * 0.45, 0], [h.cw * 0.35, -h.hipY * 0.45], [-h.cw * 0.35, -h.hipY * 0.45]], 1.2, [s * h.cd * 0.9, h.hipY + 2, 0], { plane: 'zy', rot: [0, 0, -s * 0.12] });
        break;
      case 'coat':
        ensureCape();
        b.plate('cape', P, [[-h.cw * 0.95, 0], [h.cw * 0.95, 0], [h.cw * 1.15, -h.hipY * 0.85], [-h.cw * 1.15, -h.hipY * 0.85]], 1.6, [h.backX + 1, h.hipY + 6, 0], { plane: 'zy' });
        b.ell('chest', A, [h.cd * 0.2, h.neckY - 2, 0], [h.cd * 0.9, 3, h.cw * 0.8]);
        break;
      case 'scarf': {
        b.torus('chest', A, [h.hunch * 10, h.neckY - 1, 0], h.headR * 0.75, 2.4, { rot: [Math.PI / 2, 0, 0], tub: 10, seg: 5 });
        ensureCape();
        b.plate('cape', A, [[-3, 0], [3, 0], [2, -26], [-2, -30]], 1.2, [h.backX - 1, h.neckY - 2, 3], { plane: 'zy', rot: [0.25, 0, 0] });
        break;
      }
      case 'pauldrons': case 'pauldrons_spiked': {
        const col = look.head === 'helm' || look.metal ? M : A;
        for (const s of [-1, 1]) {
          const pa = Math.min(h.arm, 5.2);
          b.ell('arm' + lr(s), col, [h.shX, h.shY + 2, s * (h.shZ + 1)], [pa * 1.75, pa * 1.1, pa * 1.6]);
          b.ell('arm' + lr(s), shade(col, 0.75), [h.shX, h.shY + 0.5, s * (h.shZ + 1.5)], [pa * 1.55, pa * 0.5, pa * 1.5], { detail: 0 });
          if (a === 'pauldrons_spiked') b.cone('arm' + lr(s), BONE, [h.shX, h.shY + 3, s * (h.shZ + 2)], [h.shX - 2, h.shY + 14, s * (h.shZ + 8)], pa * 0.6, { seg: 4 });
        }
        break;
      }
      case 'fur_collar':
        b.torus('chest', h.creature ? shade(K, 1.3) : '#d8ceb8', [h.hunch * 8, h.neckY - 3, 0], h.cw * 0.7, h.cw * 0.32, { rot: [Math.PI / 2, 0, 0], seg: 5, tub: 10 });
        break;
      case 'belly':
        b.ell('chest', h.creature ? shade(K, 1.15) : K, [h.cd * 0.45 + 2, h.hipY + h.torso * 0.35, 0], [h.cd * 0.85, h.torso * 0.42, h.cw * 0.85]);
        break;
      case 'spikes_back': {
        const k = Math.min(1.2, h.cw / 14);
        for (let i = 0; i < 9; i++) {
          const yy = h.hipY + h.torso * (0.3 + (i % 3) * 0.28), zz = (Math.floor(i / 3) - 1) * h.cw * 0.55;
          b.cone('chest', look.head === 'demon' || look.head === 'void' ? shade(look.pal[1], 1.6) : IVORY, [h.backX + 3, yy, zz], [h.backX - 16 * k, yy + 9 * k, zz * 1.4], 2.4 * k, { seg: 4 });
        }
        break;
      }
      case 'shell':
        b.ell('chest', shade(P, 0.75), [h.backX + h.cd * 0.25, h.chestY - 2, 0], [h.cd * 0.8, h.torso * 0.6, h.cw * 1.05]);
        for (let i = 0; i < 3; i++) b.ell('chest', shade(P, 0.6), [h.backX - h.cd * 0.25, h.chestY - 10 + i * 9, 0], [h.cd * 0.4, 2.2, h.cw * 0.95]);
        break;
      case 'backpack':
        b.box('chest', look.metal ?? M, [h.backX - 5, h.chestY, 0], [10, h.torso * 0.75, h.cw * 1.4]);
        for (const s of [-1, 1]) b.cyl('chest', shade(M, 0.8), [h.backX - 7, h.chestY + h.torso * 0.5, s * h.cw * 0.5], 2.4, 2.8, 14, { seg: 6 });
        b.ell('chest', look.glow ?? A, [h.backX - 10.5, h.chestY, 0], [1.5, 3, 3], { lit: 0.8 });
        break;
      case 'barrel_back':
        b.cyl('chest', '#8a5a2a', [h.backX - 8, h.chestY + 3, 0], 9, 9, 24, { seg: 8 });
        for (const yy of [-8, 8]) b.cyl('chest', DARK, [h.backX - 8, h.chestY + 3 + yy, 0], 9.4, 9.4, 2, { seg: 8 });
        b.ell('chest', look.glow ?? A, [h.backX - 8, h.chestY + 16, 0], [5, 3, 5], { lit: 0.8 });
        break;
      case 'quiver':
        b.cyl('chest', shade(S, 0.9), [h.backX - 3, h.chestY + 2, -h.cw * 0.4], 3.4, 3, 24, { rot: [0.45, 0, 0], seg: 6 });
        for (let i = 0; i < 3; i++) b.cone('chest', A, [h.backX - 3, h.chestY + 14, -h.cw * 0.4 - 5 + i * 1.5], [h.backX - 3, h.chestY + 20, -h.cw * 0.4 - 7 + i * 1.5], 1.4, { seg: 3 });
        break;
      case 'banner': {
        const px = h.backX - 3;
        b.tube('chest', WOOD, [px, h.hipY, -h.cw * 0.3], [px, h.top + 30, -h.cw * 0.3], 1.3);
        b.plate('chest', P, [[0, 0], [22, -2], [20, -16], [24, -30], [0, -26]], 1.0, [px, h.top + 28, -h.cw * 0.3], { plane: 'zy', rot: [0, 0.6, 0] });
        b.ell('chest', GOLD, [px, h.top + 31, -h.cw * 0.3], [2, 2, 2], { detail: 0 });
        top(h.top + 31);
        break;
      }
      case 'chains':
        for (let i = 0; i < 6; i++) {
          const t2 = i / 5;
          b.torus('chest', '#8a8a90', [h.cd * 0.9 - t2 * 2, h.hipY + 6 + t2 * h.torso * 0.8, -h.cw * 0.8 + t2 * h.cw * 1.6], 2.6, 0.9, { rot: [i % 2 ? 0 : Math.PI / 2, 0.6, 0], seg: 3, tub: 6 });
        }
        b.box('chest', '#8a5a3a', [h.cd * 0.6, h.chestY + 4, 0], [3, 4, h.cw * 1.8], { rot: [0.6, 0, 0] });
        break;
      case 'rocks':
        for (const [dx, dy, dz, rr] of [[0, 6, -1, 9], [0, 4, 1, 8], [-6, 0, 0, 10]] as [number, number, number, number][]) {
          const side = dz < 0 ? 'armL' : dz > 0 ? 'armR' : 'chest';
          b.ell(side, shade(look.pal[3], 1.08), [h.shX + dx, h.shY + dy, dz * (h.shZ + 2)], [rr, rr * 0.8, rr], { detail: 0 });
        }
        break;
      case 'leaves': {
        const green = '#5a9a3a';
        if (look.head === 'tree') {
          for (const [dx, dy, dz, rr] of [[-4, 14, 0, 22], [4, 10, -14, 15], [2, 8, 14, 15], [-10, 2, 0, 16]] as [number, number, number, number][])
            b.ell('head', shade(green, 0.85 + (rr % 3) * 0.1), [hx + dx, hy + r + dy, hz + dz], [rr, rr * 0.8, rr], { detail: 0 });
          top(hy + r + 36);
        } else {
          for (const s of [-1, 1]) {
            b.ell('arm' + lr(s), green, [h.shX, h.shY + 4, s * (h.shZ + 2)], [6, 4, 6], { detail: 0 });
            b.ell('arm' + lr(s), A, [h.shX + 3, h.shY + 7, s * (h.shZ + 4)], [2.5, 2.5, 2.5], { detail: 0, lit: 0.3 });
          }
          b.ell('head', green, [hx - r * 0.2, hy + r * 0.85, hz], [r * 0.7, r * 0.3, r * 0.8], { detail: 0 });
        }
        break;
      }
      case 'ice':
        for (const [dx, dy, dz, l] of [[0, 2, -1, 16], [0, 2, 1, 16], [-6, -4, 0, 20], [-4, 8, -0.4, 12]] as [number, number, number, number][]) {
          const side = dz < -0.5 ? 'armL' : dz > 0.5 ? 'armR' : 'chest';
          const base: V3 = [h.shX + dx, h.shY + dy, dz * (h.shZ + 1)];
          b.cone(side, '#bfe9ff', base, [base[0] - l * 0.5, base[1] + l, base[2] * 1.3], 3.2, { seg: 4, lit: 0.45 });
        }
        break;
      case 'flames': {
        const F = look.glow ?? '#ff8a2a';
        b.cone('head', F, [hx - r * 0.2, hy + r * 0.4, hz], [hx - r * 0.9, hy + r * 2.6, hz], r * 0.75, { seg: 5, lit: 1 });
        b.cone('head', shade(F, 1.4), [hx - r * 0.1, hy + r * 0.6, hz], [hx - r * 0.5, hy + r * 1.8, hz], r * 0.45, { seg: 5, lit: 1 });
        for (const s of [-1, 1]) b.cone('arm' + lr(s), F, [h.shX, h.shY + 2, s * h.shZ], [h.shX - 4, h.shY + 14, s * (h.shZ + 2)], 3.5, { seg: 5, lit: 1 });
        top(hy + r * 2.6);
        break;
      }
      case 'orbs': {
        if (!b.has('spin')) b.bone('spin', 'root', [0, h.chestY, 0]);
        const cols = ['#7fd6ff', '#d38cff', '#ffa040'];
        cols.forEach((col, i) => {
          const a2 = (i / 3) * Math.PI * 2;
          b.ball('spin', col, [Math.cos(a2) * (h.cw + 14), h.headC[1] + 6, Math.sin(a2) * (h.cw + 14)], [4.5, 4.5, 4.5], { lit: 1, seg: 8 });
        });
        break;
      }
      case 'souls': {
        if (!b.has('spin')) b.bone('spin', 'root', [0, h.chestY, 0]);
        for (let i = 0; i < 4; i++) {
          const a2 = (i / 4) * Math.PI * 2;
          b.ell('spin', look.glow ?? '#ff5a2a', [Math.cos(a2) * (h.cw + 16), h.chestY + (i % 2) * 10, Math.sin(a2) * (h.cw + 16)], [2.8, 3.5, 2.8], { lit: 1, detail: 0 });
        }
        break;
      }
      case 'aura_ring': {
        if (!b.has('spin')) b.bone('spin', 'root', [0, h.chestY, 0]);
        b.torus('spin', look.glow ?? A, [0, h.hipY + 2, 0], h.cw + 12, 1.1, { rot: [Math.PI / 2, 0, 0], lit: 1, tub: 20, seg: 3 });
        for (let i = 0; i < 3; i++) {
          const a2 = (i / 3) * Math.PI * 2;
          b.ell('spin', look.glow ?? A, [Math.cos(a2) * (h.cw + 12), h.hipY + 2, Math.sin(a2) * (h.cw + 12)], [2.2, 2.2, 2.2], { lit: 1, detail: 0 });
        }
        break;
      }
      case 'wisp_pet':
        if (!b.has('spin')) b.bone('spin', 'root', [0, h.chestY, 0]);
        b.ell('spin', look.glow ?? '#b6ff9f', [h.cw + 14, h.headC[1] + 2, 0], [5, 5, 5], { lit: 1 });
        b.cone('spin', look.glow ?? '#b6ff9f', [h.cw + 14, h.headC[1] + 2, -3], [h.cw + 14, h.headC[1] + 1, -14], 3.5, { lit: 0.8, seg: 5 });
        break;
      case 'goblin_rider': {
        const gx = h.shX - 1, gy = h.shY + 6, gz = -(h.shZ - 2);
        const GK = '#7aa84a';
        b.ell('chest', '#5a3a6a', [gx, gy + 6, gz], [5, 7, 5]);
        b.ell('chest', GK, [gx + 1, gy + 16, gz], [5, 5, 5]);
        for (const s of [-1, 1]) b.cone('chest', GK, [gx, gy + 17, gz + s * 3], [gx - 2, gy + 19, gz + s * 11], 2, { seg: 4 });
        b.cone('chest', GK, [gx + 4, gy + 16, gz], [gx + 9, gy + 14, gz], 1.6, { seg: 4 });
        b.cyl('chest', '#8fe14f', [gx + 6, gy + 8, gz - 6], 2.4, 3.4, 8, { lit: 0.6 });
        top(gy + 21);
        break;
      }
      case 'tentacles':
        for (let i = 0; i < 6; i++) {
          const a2 = (i / 6) * Math.PI * 2;
          const ox = Math.cos(a2) * h.cw * 0.8, oz = Math.sin(a2) * h.cw * 0.8;
          b.horn('chest', shade(look.pal[1], 1.3), [[ox * 0.6, h.hipY + 4, oz * 0.6], [ox * 1.3 - 4, h.hipY - 10, oz * 1.4], [ox * 1.6 - 10, h.hipY - 26, oz * 1.8]], 3);
        }
        break;
      case 'mane':
        for (let i = 0; i < 5; i++) b.cone('chest', HAIR, [h.backX + 2, h.neckY - i * 5, 0], [h.backX - 10, h.neckY - i * 5 - 4, 0], 4, { seg: 4 });
        b.ell('head', HAIR, [hx - r * 0.5, hy + r * 0.2, hz], [r * 0.8, r * 1.0, r * 1.05]);
        break;
      case 'saw_chest': {
        b.bone('saw', 'chest', [h.cd + 3, h.chestY, 0]);
        b.cyl('saw', '#d0d0d8', [h.cd + 3, h.chestY, 0], h.cw * 1.15, h.cw * 1.15, 1.6, { rot: [0, 0, Math.PI / 2], seg: 12 });
        for (let i = 0; i < 10; i++) {
          const a2 = (i / 10) * Math.PI * 2;
          b.cone('saw', '#e8e8f0', [h.cd + 3, h.chestY + Math.cos(a2) * h.cw * 1.1, Math.sin(a2) * h.cw * 1.1], [h.cd + 3, h.chestY + Math.cos(a2 + 0.3) * h.cw * 1.4, Math.sin(a2 + 0.3) * h.cw * 1.4], 2.4, { seg: 3 });
        }
        b.cyl('saw', DARK, [h.cd + 4, h.chestY, 0], 4, 4, 3, { rot: [0, 0, Math.PI / 2] });
        break;
      }
      // ------------------------------------------------------------ colas y alas
      case 'tail': case 'tail_fluffy': {
        const fluffy = a === 'tail_fluffy';
        const col = fluffy ? look.pal[3] : h.creature ? K : shade(K, 0.95);
        const tx = -h.cd * 0.8, ty = h.hipY - 2;
        b.bone('tail', 'hips', [tx, ty, 0]);
        b.bone('tail2', 'tail', [tx - 16, ty - 12, 0]);
        if (fluffy) {
          b.ell('tail', col, [tx - 8, ty + 4, 0], [7, 10, 7]);
          b.ell('tail2', shade(col, 1.1), [tx - 14, ty + 22, 0], [9, 14, 8]);
          b.ell('tail2', IVORY, [tx - 12, ty + 34, 0], [5, 6, 5]);
        } else {
          b.tube('tail', col, [tx + 2, ty + 2, 0], [tx - 16, ty - 12, 0], h.legT * 0.8, h.legT * 0.6);
          b.tube('tail2', col, [tx - 16, ty - 12, 0], [tx - 34, ty - 20, 0], h.legT * 0.6, h.legT * 0.35);
          b.cone('tail2', look.glow && look.head === 'demon' ? look.glow : col, [tx - 34, ty - 20, 0], [tx - 44, ty - 20, 0], h.legT * 0.9, { seg: 4, lit: look.head === 'demon' ? 0.4 : 0 });
        }
        break;
      }
      case 'wings_bat': case 'wings_demon': case 'wings_feather': case 'wings_bug': case 'wings_fairy':
        wings(b, look, a, h);
        break;
      default:
        break;
    }
  }
}

function wings(b: Builder, look: Look, kind: Acc, h: Hum) {
  const [P, S, A] = look.pal;
  const big = kind === 'wings_demon' ? 0.95 : kind === 'wings_fairy' ? 0.55 : kind === 'wings_bug' ? 0.8 : 0.9;
  const span = (h.cw + 34) * big, ht = 30 * big;
  const wx = h.backX - 2, wy = h.shY - 2;
  for (const s of [-1, 1]) {
    const bn = 'wing' + lr(s);
    b.bone(bn, 'chest', [wx, wy, s * 5]);
    // Perfiles en el plano ZY: la x del perfil va hacia fuera (z), con signo según el lado.
    const out = (pts: [number, number][]) => pts.map(([x, y]) => [x * s, y] as [number, number]);
    if (kind === 'wings_feather') {
      const tip: V3 = [wx - 8, wy + ht * 0.85, s * span * 0.6];
      b.tube(bn, P, [wx, wy, s * 5], tip, 2.6, 1.8);
      for (let i = 0; i < 6; i++) {
        const t2 = i / 5;
        const base: V3 = [wx - 2 - t2 * 6, wy + ht * 0.85 * t2, s * (6 + span * 0.55 * t2)];
        const L = ht * (0.9 + t2 * 0.5);
        b.plate(bn, i % 2 ? A : shade(P, 1.15), out([[-3.5, 0], [3.5, 0], [2.5, -L], [0, -L - 4], [-2.5, -L]]), 1.1, base, { plane: 'zy', rot: [-s * (0.2 + t2 * 0.5), 0, -0.25] });
      }
    } else if (kind === 'wings_bug' || kind === 'wings_fairy') {
      const col = kind === 'wings_fairy' ? (look.glow ?? A) : shade(A, 1.2);
      for (const k of [0, 1]) b.plate(bn, col, out([[0, 0], [span * 0.5, ht * (0.9 - k * 0.6)], [span, ht * (0.3 - k * 0.7)], [span * 0.6, -ht * (0.2 + k * 0.3)]]), 0.6, [wx - 1, wy - k * 6, s * 4], { plane: 'zy', rot: [0, -s * 0.3, 0], lit: kind === 'wings_fairy' ? 0.7 : 0.25 });
    } else {
      // Membrana de murciélago o de demonio: brazo óseo y membrana en abanico.
      const tip: V3 = [wx - 10, wy + ht * 1.1, s * span];
      b.within(new THREE.Matrix4().makeRotationY(-s * 0.45).premultiply(new THREE.Matrix4().makeTranslation(wx - 3, wy, s * 5)).multiply(new THREE.Matrix4().makeTranslation(-(wx - 3), -wy, -s * 5)), () => {
        b.tube(bn, shade(S, 1.2), [wx, wy, s * 5], [wx - 2, wy + ht * 0.6, s * span * 0.5], 2.2, 1.8);
        b.tube(bn, shade(S, 1.2), [wx - 2, wy + ht * 0.6, s * span * 0.5], tip, 1.8, 1.0);
      });
      b.plate(bn, kind === 'wings_demon' ? shade(P, 0.6) : shade(S, 0.9),
        out([[0, 0], [span * 0.5, ht * 0.6], [span, ht * 1.1], [span * 0.8, -ht * 0.1], [span * 0.55, -ht * 0.05], [span * 0.35, -ht * 0.4], [span * 0.15, -ht * 0.3]]),
        0.8, [wx - 3, wy, s * 5], { plane: 'zy', rot: [0, -s * 0.45, 0] });
    }
  }
  h.top = Math.max(h.top, wy + ht * 1.1);
}

// ---------------------------------------------------------------------------
// Armas

/** Estilo de golpe según el arma. */
export function strikeOf(w: Weapon): Strike {
  switch (w) {
    case 'sword': case 'katana': case 'dagger': case 'glaive': case 'scythe': return 'slash';
    case 'greatsword': case 'axe': case 'greataxe': case 'hammer': case 'warhammer': case 'mace': case 'club':
    case 'cleaver': case 'anchor': case 'totem': case 'shovel': case 'hook': return 'chop';
    case 'spear': case 'trident': case 'rapier': case 'staff_gold': return 'thrust';
    case 'bow': case 'crossbow': return 'bow';
    case 'rifle': case 'pistol': case 'shotgun': case 'mech_arm': return 'gun';
    case 'fists': case 'saw': return 'punch';
    case 'daggers': case 'blades': return 'dual';
    case 'claws': return 'claw';
    case 'whip': case 'flail': return 'whip';
    default: return 'cast';
  }
}

const _hm = new THREE.Matrix4();
const _hq = new THREE.Quaternion();
const _he = new THREE.Euler();
const _hv = new THREE.Vector3();
const _hs = new THREE.Vector3();
function hold(p: V3, rz: number, rx = 0, ry = 0, k = 1) {
  _he.set(rx, ry, rz, 'YXZ');
  return _hm.compose(_hv.set(p[0], p[1], p[2]), _hq.setFromEuler(_he), _hs.set(k, k, k)).clone();
}

/** Arma en la mano (side +1 derecha, -1 izquierda). Espacio del arma: empuñadura en el origen, hoja hacia +Y. */
export function weapon(b: Builder, look: Look, w: Weapon, side: number, h: Hum) {
  if (w === 'none') return;
  const bone = 'hand' + lr(side);
  const hp = h.hand[lr(side) as 'L' | 'R'];
  const M = look.metal ?? '#c9ced8';
  const A = look.pal[2];
  const G = look.glow ?? A;
  const k = h.wk;
  const out = side * 0.12;
  // rz es el ángulo deseado en la pose de reposo: se descuenta el giro de brazo y codo de esa pose.
  const idle = IDLE_ARM[strikeOf(look.weapon)];
  const bend = side > 0 ? idle[0] + idle[1] : idle[2] + idle[3];
  const W = (rz: number, fn: () => void, rx = out, ry = 0) => b.within(hold(hp, rz - bend, rx, ry, k), fn);
  const blade = (len: number, wd: number, col = M, lit = 0) => b.plate(bone, col, [[-wd, 0], [wd, 0], [wd * 0.9, len * 0.85], [0, len], [-wd * 0.9, len * 0.85]], 1.4, [0, 0, 0], { rot: [0, side > 0 ? 0 : Math.PI, 0], lit });
  const grip = (len: number, col = DARK, r = 1.5) => b.tube(bone, col, [0, -len * 0.4, 0], [0, len * 0.6, 0], r);
  switch (w) {
    case 'sword': W(-0.7, () => {
      grip(10); b.box(bone, A, [0, 6, 0], [11, 2.4, 3]);
      b.within(hold([0, 7, 0], 0), () => blade(40, 2.8));
      b.ball(bone, A, [0, -5, 0], [2, 2, 2]);
    }); break;
    case 'greatsword': W(-0.6, () => {
      grip(14); b.box(bone, A, [0, 8, 0], [15, 3, 4]);
      b.within(hold([0, 9, 0], 0), () => blade(54, 4.6, M, look.glow && look.head === 'demon' ? 0.4 : 0));
    }); break;
    case 'katana': W(-0.8, () => {
      grip(12, '#8a2a2a'); b.cyl(bone, GOLD, [0, 6.5, 0], 3.4, 3.4, 1.2, { seg: 8 });
      b.plate(bone, M, [[-1.4, 0], [1.6, 0], [3.5, 30], [2.5, 44], [0.4, 30]], 1.0, [0, 7, 0]);
    }); break;
    case 'rapier': W(-0.9, () => {
      grip(7); b.ball(bone, GOLD, [0, 4, 0], [4, 2.5, 4]);
      b.cone(bone, M, [0, 5, 0], [0, 46, 0], 1.1, { seg: 4 });
    }); break;
    case 'dagger': W(-0.9, () => { grip(6); b.box(bone, A, [0, 3.5, 0], [7, 1.6, 2]); b.within(hold([0, 4, 0], 0), () => blade(18, 2.2, M, look.glow && w === 'dagger' ? 0.15 : 0)); }); break;
    case 'daggers': for (const s of [-1, 1]) weapon(b, look, 'dagger', s, h); return;
    case 'blades': for (const s of [-1, 1]) {
      const bn = 'hand' + lr(s);
      b.within(hold(h.hand[lr(s) as 'L' | 'R'], -1.0 - IDLE_ARM.dual[s > 0 ? 1 : 3] - IDLE_ARM.dual[s > 0 ? 0 : 2], s * 0.15, 0, k), () => {
        b.tube(bn, DARK, [0, -4, 0], [0, 6, 0], 1.6);
        b.plate(bn, M, [[0, 4], [5, 10], [9, 26], [6, 38], [3, 24], [-2, 8]], 1.2, [0, 0, 0], { lit: look.glow ? 0.15 : 0 });
        b.plate(bn, M, [[0, -2], [-5, -8], [-7, -18], [-2, -10]], 1.2, [0, 0, 0]);
      });
    } return;
    case 'axe': W(-0.6, () => {
      b.tube(bone, WOOD, [0, -8, 0], [0, 34, 0], 1.7);
      b.plate(bone, M, [[0, 22], [10, 18], [16, 26], [15, 38], [9, 40], [0, 32]], 2, [0, 0, 0]);
    }); break;
    case 'greataxe': W(-0.45, () => {
      b.tube(bone, WOOD, [0, -18, 0], [0, 46, 0], 2.0);
      for (const s of [-1, 1]) b.plate(bone, M, [[0, 33], [s * 6, 30], [s * 12, 35], [s * 13, 45], [s * 7, 49], [0, 45]], 2, [0, 0, 0]);
      b.cone(bone, M, [0, 46, 0], [0, 54, 0], 2.2, { seg: 4 });
    }); break;
    case 'spear': case 'trident': W(-1.05, () => {
      b.tube(bone, w === 'trident' ? GOLD : WOOD, [0, -40, 0], [0, 62, 0], 1.6);
      if (w === 'spear') {
        b.plate(bone, M, [[-4, 0], [0, -3], [4, 0], [2.5, 14], [0, 22], [-2.5, 14]], 1.6, [0, 62, 0], { lit: look.glow ? 0.1 : 0 });
        b.cyl(bone, A, [0, 60, 0], 2.2, 2.2, 3, { seg: 6 });
      } else {
        b.box(bone, GOLD, [0, 62, 0], [16, 2.4, 2.4]);
        for (const x of [-7, 0, 7]) b.cone(bone, GOLD, [x, 62, 0], [x, 78 + (x === 0 ? 4 : 0), 0], 1.8, { seg: 4 });
      }
    }); break;
    case 'glaive': W(-0.3, () => {
      b.tube(bone, DARK, [0, -3, 0], [0, 4, 0], 1.6);
      b.within(hold([0, 12, 0], 0), () => {
        for (let i = 0; i < 3; i++) b.plate(bone, M, [[0, 0], [4, 4], [14, 3], [6, -2]], 1.2, [0, 0, 0], { rot: [Math.PI / 2, 0, (i / 3) * Math.PI * 2], lit: look.glow ? 0.35 : 0 });
        b.torus(bone, A, [0, 0, 0], 4, 1.2, { rot: [Math.PI / 2, 0, 0], tub: 10 });
      });
    }, side * 0.12, 0); break;
    case 'scythe': W(-0.15, () => {
      b.tube(bone, '#3a2e2a', [0, -40, 0], [0, 64, 0], 1.6);
      b.plate(bone, M, [[0, 60], [-6, 66], [-30, 62], [-44, 50], [-24, 58], [0, 56]], 1.4, [0, 0, 0], { lit: look.glow ? 0.25 : 0 });
    }); break;
    case 'bow': b.within(hold(h.hand.L, -(IDLE_ARM.bow[2] + IDLE_ARM.bow[3]), -0.1, 0, k), () => {
      b.torus('handL', WOOD, [-14, 0, 0], 22, 1.4, { arc: 2.3, rot: [0, 0, -1.15], tub: 9, seg: 4 });
      b.tube('handL', '#e8e8e8', [-5.5, 20.5, 0], [-5.5, -20.5, 0], 0.35, 0.35, { seg: 3 });
      b.box('handL', A, [1, 0, 0], [3, 7, 3]);
    }); return;
    case 'crossbow': W(-Math.PI / 2, () => {
      b.box(bone, WOOD, [0, 8, 0], [3, 26, 3]);
      b.torus(bone, M, [0, 26, 0], 10, 1.2, { rot: [Math.PI / 2, 0, 0], arc: Math.PI, tub: 8 });
      b.ball(bone, A, [0, 2, 0], [2.5, 2.5, 2.5]);
    }, 0); break;
    case 'staff': case 'staff_orb': case 'staff_skull': case 'staff_crook': W(-0.12, () => {
      b.tube(bone, WOOD, [0, -44, 0], [0, 58, 0], 1.7, 1.4);
      if (w === 'staff') {
        b.ell(bone, G, [0, 63, 0], [4.5, 6, 4.5], { lit: 1, detail: 0 });
        for (let i = 0; i < 3; i++) { const a2 = (i / 3) * Math.PI * 2; b.cone(bone, A, [0, 56, 0], [Math.cos(a2) * 5, 68, Math.sin(a2) * 5], 1.1, { seg: 3 }); }
      } else if (w === 'staff_orb') {
        b.torus(bone, A, [0, 64, 0], 6, 1.1, { tub: 10 });
        b.ball(bone, G, [0, 64, 0], [5, 5, 5], { lit: 1, seg: 8 });
      } else if (w === 'staff_skull') {
        b.ell(bone, BONE, [1, 64, 0], [5, 5, 4.5]);
        for (const s of [-1, 1]) b.ell(bone, G, [5, 64.5, s * 1.8], [0.8, 1, 1], { lit: 1, detail: 0 });
        for (const s of [-1, 1]) b.plate(bone, A, [[0, 0], [3, 10], [-1, 9]], 0.8, [0, 58, s * 3], { rot: [s * 0.4, 0, 0] });
      } else {
        b.torus(bone, GOLD, [-6, 60, 0], 7, 1.4, { arc: Math.PI * 1.25, rot: [0, 0, -0.3], tub: 10 });
        b.ell(bone, G, [-1, 56, 0], [2, 2, 2], { lit: 1, detail: 0 });
      }
    }); h.top = Math.max(h.top, hp[1] + 70 * k); break;
    case 'staff_gold': W(-1.2, () => {
      b.tube(bone, GOLD, [0, -46, 0], [0, 58, 0], 1.6);
      for (const y of [-46, 58]) b.cyl(bone, '#c03030', [0, y, 0], 2.3, 2.3, 8, { seg: 7 });
    }); break;
    case 'wand': W(-0.7, () => { b.tube(bone, WOOD, [0, -4, 0], [0, 20, 0], 1.0, 0.7); b.ell(bone, G, [0, 22, 0], [2.6, 2.6, 2.6], { lit: 1, detail: 0 }); }); break;
    case 'orb': b.ball(bone, G, [hp[0] + 6, hp[1] + 8, hp[2]], [6, 6, 6], { lit: 1, seg: 8 }); return;
    case 'hammer': case 'warhammer': W(-0.55, () => {
      b.tube(bone, w === 'warhammer' ? GOLD : WOOD, [0, -14, 0], [0, 40, 0], 1.9);
      if (w === 'hammer') { b.box(bone, M, [0, 42, 0], [18, 9, 9]); b.box(bone, A, [0, 42, 0], [6, 10, 10]); }
      else { b.ell(bone, G, [0, 44, 0], [8, 8, 8], { lit: 1, detail: 0 }); for (let i = 0; i < 5; i++) { const a2 = (i / 5) * Math.PI * 2; b.cone(bone, GOLD, [Math.cos(a2) * 6, 44 + Math.sin(a2) * 6, 0], [Math.cos(a2) * 13, 44 + Math.sin(a2) * 13, 0], 2.4, { seg: 4 }); } }
    }); break;
    case 'mace': W(-0.6, () => {
      b.tube(bone, DARK, [0, -8, 0], [0, 30, 0], 1.8);
      b.ell(bone, M, [0, 34, 0], [7, 8, 7], { detail: 0 });
      for (let i = 0; i < 6; i++) { const a2 = (i / 6) * Math.PI * 2; b.cone(bone, A, [Math.cos(a2) * 5, 34, Math.sin(a2) * 5], [Math.cos(a2) * 12, 34, Math.sin(a2) * 12], 2, { seg: 4 }); }
    }); break;
    case 'club': W(-0.5, () => { b.tube(bone, WOOD, [0, -6, 0], [0, 42, 0], 2.2, 6.5, { seg: 6 }); b.cone(bone, BONE, [3, 34, 3], [9, 38, 8], 1.6, { seg: 3 }); }); break;
    case 'flail': W(-0.5, () => {
      b.tube(bone, DARK, [0, -6, 0], [0, 18, 0], 1.6);
      b.tube(bone, '#8a8a90', [0, 18, 0], [6, 30, 0], 0.7, 0.7, { seg: 3 });
      b.ell(bone, M, [8, 34, 0], [6, 6, 6], { detail: 0 });
      for (let i = 0; i < 6; i++) { const a2 = (i / 6) * Math.PI * 2; b.cone(bone, G, [8 + Math.cos(a2) * 4, 34 + Math.sin(a2) * 4, 0], [8 + Math.cos(a2) * 10, 34 + Math.sin(a2) * 10, 0], 1.6, { seg: 4, lit: 0.5 }); }
    }); break;
    case 'whip': W(-0.5, () => {
      b.tube(bone, DARK, [0, -4, 0], [0, 10, 0], 1.6);
      const pts: V3[] = [[0, 10, 0], [8, 18, 0], [18, 14, 0], [24, 4, 0], [22, -10, 0], [14, -20, 0]];
      for (let i = 0; i < pts.length - 1; i++) b.tube(bone, G, pts[i], pts[i + 1], 1.3 - i * 0.15, 1.15 - i * 0.15, { seg: 4, lit: look.glow ? 0.9 : 0 });
    }); break;
    case 'hook': W(-0.3, () => {
      b.tube(bone, DARK, [0, -5, 0], [0, 8, 0], 1.8);
      for (let i = 0; i < 4; i++) b.torus(bone, '#8a8a90', [0, 10 + i * 4, 0], 2, 0.7, { rot: [0, i % 2 ? Math.PI / 2 : 0, 0], seg: 3, tub: 6 });
      b.torus(bone, M, [-5, 30, 0], 7, 1.8, { arc: Math.PI * 1.3, rot: [0, 0, -0.6], tub: 10 });
      b.cone(bone, M, [-11, 26, 0], [-12, 33, 0], 2, { seg: 4 });
    }); break;
    case 'cleaver': W(-0.8, () => { grip(8, WOOD); b.box(bone, M, [4, 16, 0], [12, 20, 1.6]); }); break;
    case 'anchor': W(-0.35, () => {
      b.tube(bone, M, [0, -10, 0], [0, 56, 0], 2.4);
      b.torus(bone, M, [0, 56, 0], 4, 1.4, { tub: 8 });
      b.box(bone, M, [0, 44, 0], [20, 3, 3]);
      b.torus(bone, M, [0, -2, 0], 16, 2.4, { arc: Math.PI, rot: [0, 0, Math.PI], tub: 10 });
      for (const s of [-1, 1]) b.cone(bone, M, [s * 16, -2, 0], [s * 20, 8, 0], 4, { seg: 3 });
    }); break;
    case 'totem': W(-0.5, () => {
      b.tube(bone, WOOD, [0, -12, 0], [0, 54, 0], 2.6, 4);
      b.box(bone, shade(WOOD, 1.2), [0, 52, 0], [11, 18, 11]);
      b.box(bone, A, [5.8, 54, 0], [1, 4, 8]);
      for (const s of [-1, 1]) b.plate(bone, A, [[0, 0], [3, 12], [-1, 10]], 0.8, [0, 60, s * 4], { rot: [s * 0.5, 0, 0] });
    }); break;
    case 'shovel': W(-0.4, () => { b.tube(bone, WOOD, [0, -24, 0], [0, 30, 0], 1.5); b.plate(bone, M, [[-6, 0], [6, 0], [6, 14], [0, 19], [-6, 14]], 1.2, [0, 30, 0], { plane: 'zy' }); }); break;
    case 'brush': W(-0.5, () => { b.tube(bone, DARK, [0, -12, 0], [0, 34, 0], 1.3); b.cone(bone, '#d03030', [0, 34, 0], [0, 48, 0], 3.6, { seg: 5, lit: 0.4 }); b.ell(bone, '#1a1a1a', [0, 34, 0], [3.8, 3, 3.8]); }); break;
    case 'lute': b.within(hold([h.cd + 6, h.chestY - 4, 0], 0.9, 0, 0, k), () => {
      b.ell('chest', '#a06a2a', [0, 0, 0], [10, 12, 4]);
      b.box('chest', WOOD, [0, 18, 0], [3, 22, 2]);
      b.ell('chest', '#2a1a10', [0, 2, 3.5], [3, 3, 1], { detail: 0 });
    }); return;
    case 'torch': W(-0.5, () => { b.tube(bone, WOOD, [0, -6, 0], [0, 18, 0], 1.4); b.cone(bone, G, [0, 18, 0], [0, 32, 0], 4.5, { lit: 1, seg: 5 }); }); break;
    case 'rifle': W(-Math.PI / 2 + 0.05, () => {
      b.box(bone, WOOD, [0, -6, 0], [4, 18, 3]);
      b.tube(bone, M, [0, 0, 0], [0, 58, 0], 1.6);
      b.cyl(bone, DARK, [3.5, 12, 0], 1.6, 1.6, 12, { seg: 6 });
    }, 0); break;
    case 'pistol': W(-Math.PI / 2 + 0.15, () => { b.box(bone, DARK, [-2, -1, 0], [3, 7, 3], { rot: [0, 0, 0.4] }); b.tube(bone, M, [0, 0, 0], [0, 16, 0], 1.4); b.ell(bone, look.glow ?? A, [0, 17, 0], [1.4, 1.4, 1.4], { lit: look.glow ? 1 : 0, detail: 0 }); }, 0); break;
    case 'shotgun': W(-Math.PI / 2 + 0.1, () => { b.box(bone, WOOD, [0, -4, 0], [4, 14, 3]); for (const z of [-1.3, 1.3]) b.tube(bone, M, [0, 2, z], [0, 34, z], 1.4); }, 0); break;
    case 'fists': for (const s of [-1, 1]) {
      const p = h.hand[lr(s) as 'L' | 'R'];
      b.ell('hand' + lr(s), look.metal ? M : shade(look.pal[3], 0.95), [p[0] + 1, p[1] - 1, p[2]], [h.arm * 1.9, h.arm * 1.8, h.arm * 1.7]);
    } return;
    case 'claws': for (const s of [-1, 1]) {
      const p = h.hand[lr(s) as 'L' | 'R'];
      const col = look.glow && look.head !== 'demon' && look.head !== 'beast' ? look.glow : IVORY;
      const lit = col === look.glow ? 0.9 : 0;
      for (const dz of [-1.6, 0, 1.6]) b.cone('hand' + lr(s), col, [p[0] + 2, p[1] - 2, p[2] + dz], [p[0] + 12, p[1] - 8, p[2] + dz * 1.8], 1.2, { seg: 3, lit });
    } return;
    case 'mech_arm': {
      const p = h.hand.R;
      b.box('handR', M, [p[0] + 2, p[1] + 4, p[2]], [h.arm * 3.4, h.arm * 4.2, h.arm * 3.2]);
      b.ell('handR', shade(M, 0.85), [p[0] + 3, p[1] - 4, p[2]], [h.arm * 2.2, h.arm * 1.9, h.arm * 2.0], { detail: 0 });
      b.cyl('handR', DARK, [p[0] + 9, p[1] + 6, p[2]], 2.4, 2.4, 10, { rot: [0, 0, Math.PI / 2], seg: 6 });
      b.ell('handR', G, [p[0] + 14.5, p[1] + 6, p[2]], [1, 2, 2], { lit: 1, detail: 0 });
      return;
    }
    case 'saw': {
      const p = h.hand.R;
      b.box('handR', M, [p[0] + 1, p[1] + 2, p[2]], [h.arm * 2.6, h.arm * 3.6, h.arm * 2.6]);
      b.cyl('handR', '#e0e0e8', [p[0] + 9, p[1] - 4, p[2]], 11, 11, 1.2, { rot: [Math.PI / 2, 0, 0], seg: 12 });
      return;
    }
    case 'shield': {
      const p = h.hand.L;
      const col = look.metal ?? A;
      b.cyl('handL', col, [p[0] + 2, p[1] + 6, p[2] - 4 * k], 13 * k, 13 * k, 2.2, { rot: [Math.PI / 2, 0, 0], seg: 8 });
      b.cyl('handL', look.pal[0], [p[0] + 2, p[1] + 6, p[2] - 5.4 * k], 9 * k, 9 * k, 1, { rot: [Math.PI / 2, 0, 0], seg: 8 });
      b.ell('handL', GOLD, [p[0] + 2, p[1] + 6, p[2] - 6.4 * k], [3, 3, 2], { detail: 0 });
      return;
    }
    case 'book': {
      const p = h.hand.L;
      b.box('handL', '#5a2a2a', [p[0] + 3, p[1], p[2]], [10, 13, 4]);
      b.box('handL', '#e8dcc0', [p[0] + 3.5, p[1], p[2]], [9, 12, 3.2]);
      b.ell('handL', G, [p[0] + 8.5, p[1], p[2]], [1, 2.4, 2.4], { lit: 0.8, detail: 0 });
      return;
    }
  }
}
