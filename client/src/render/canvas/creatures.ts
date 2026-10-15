// Siluetas procedurales de creeps, invocaciones y wards para el modo 2D, vistas desde arriba.
// Cada forma se pinta mirando a +x en un espacio donde el cuerpo mide ~1 de radio, y se
// guarda como sprite por tamaño; en cada frame solo se gira y se copia.
import { cache, makeSprite, mix, type Sprite } from './sprites';

export type Shape =
  | 'wolf' | 'bear' | 'treant' | 'golem' | 'spider' | 'kobold' | 'satyr' | 'centaur' | 'skeleton' | 'zombie'
  | 'humanoid' | 'spirit' | 'bird' | 'boar' | 'imp' | 'cog' | 'stone' | 'missile' | 'ward' | 'plague' | 'serpent'
  | 'deathward' | 'healward' | 'eye' | 'tomb' | 'spire' | 'sun' | 'blob' | 'panda' | 'swarm' | 'beast';

export interface CreatureDef {
  shape: Shape;
  col: string;
  /** Escala visual sobre el radio de colisión. */
  k: number;
  /** No gira con la orientación (wards, engranajes…). */
  fixed?: boolean;
}

/** Reglas por nombre de unidad, de más concreta a más general. */
const RULES: [RegExp, CreatureDef][] = [
  [/bear/, { shape: 'bear', col: '#7a5634', k: 1.5 }],
  [/treant/, { shape: 'treant', col: '#4f8a3a', k: 1.45 }],
  [/alpha_wolf/, { shape: 'wolf', col: '#a09888', k: 1.55 }],
  [/wolf/, { shape: 'wolf', col: '#6e685e', k: 1.5 }],
  [/golem/, { shape: 'golem', col: '#5a4440', k: 1.45 }],
  [/spider/, { shape: 'spider', col: '#3e2c40', k: 1.55 }],
  [/kobold_(taskmaster|foreman)/, { shape: 'kobold', col: '#b08a5a', k: 1.5 }],
  [/kobold/, { shape: 'kobold', col: '#8a6a4a', k: 1.45 }],
  [/satyr_hellcaller/, { shape: 'satyr', col: '#a050c0', k: 1.5 }],
  [/satyr/, { shape: 'satyr', col: '#8a5ab0', k: 1.45 }],
  [/centaur_khan/, { shape: 'centaur', col: '#c09040', k: 1.5 }],
  [/centaur/, { shape: 'centaur', col: '#a8803a', k: 1.45 }],
  [/skeleton|clinkz|archer|warrior/, { shape: 'skeleton', col: '#d8d0b8', k: 1.45 }],
  [/zombie/, { shape: 'zombie', col: '#6a8a5a', k: 1.45 }],
  [/ember_spirit/, { shape: 'spirit', col: '#ff7a2a', k: 1.35 }],
  [/forged_spirit/, { shape: 'spirit', col: '#ff5030', k: 1.4 }],
  [/ancestral/, { shape: 'spirit', col: '#7fd8ff', k: 1.4 }],
  [/eidolon/, { shape: 'spirit', col: '#b07bff', k: 1.4 }],
  [/wisp/, { shape: 'spirit', col: '#d8f0ff', k: 1.3 }],
  [/hawk|familiar/, { shape: 'bird', col: '#8a7a6a', k: 1.6 }],
  [/boar/, { shape: 'boar', col: '#7a5a44', k: 1.5 }],
  [/imp/, { shape: 'imp', col: '#c0402a', k: 1.4 }],
  [/cog/, { shape: 'cog', col: '#b08a4a', k: 1.3, fixed: true }],
  [/missile/, { shape: 'missile', col: '#b0b8c0', k: 1.5 }],
  [/plague_ward/, { shape: 'plague', col: '#7ab83a', k: 1.5 }],
  [/serpent|shaman_ward/, { shape: 'serpent', col: '#5aa04a', k: 1.5 }],
  [/death_ward/, { shape: 'deathward', col: '#8a4ab0', k: 1.5, fixed: true }],
  [/healing_ward/, { shape: 'healward', col: '#6ae86a', k: 1.4, fixed: true }],
  [/nether_ward/, { shape: 'eye', col: '#a05ae0', k: 1.4, fixed: true }],
  [/sentry|observer/, { shape: 'eye', col: '#6ab0ff', k: 1.3, fixed: true }],
  [/tombstone/, { shape: 'tomb', col: '#8a8494', k: 1.4, fixed: true }],
  [/stone/, { shape: 'stone', col: '#6a6a5a', k: 1.4, fixed: true }],
  [/ice_spire/, { shape: 'spire', col: '#a8e0ff', k: 1.45, fixed: true }],
  [/phoenix_sun/, { shape: 'sun', col: '#ff9a2a', k: 1.3, fixed: true }],
  [/ink/, { shape: 'blob', col: '#1a1a24', k: 1.4 }],
  [/brewling|brewmaster/, { shape: 'panda', col: '#8a6a4a', k: 1.5 }],
  [/swarm/, { shape: 'swarm', col: '#6a5a3a', k: 1.4 }],
  [/zealot|chen/, { shape: 'humanoid', col: '#d0b070', k: 1.45 }],
  [/furbolg/, { shape: 'bear', col: '#c8c0b0', k: 1.5 }],
  [/harpy|wildkin/, { shape: 'bird', col: '#7a8ab0', k: 1.5 }],
  [/ghost/, { shape: 'spirit', col: '#c0d8e8', k: 1.35 }],
  [/troll|gnoll|ogre|prowler|shaman|raider/, { shape: 'humanoid', col: '#7a8a6a', k: 1.45 }],
  [/drake|dragon|lizard|frog|tadpole|fel_beast|stalker/, { shape: 'beast', col: '#5a7a4a', k: 1.45 }],
];
const WARD: CreatureDef = { shape: 'ward', col: '#7aa86a', k: 1.4, fixed: true };
const BEAST: CreatureDef = { shape: 'beast', col: '#8a7a6a', k: 1.45 };

const defs = new Map<string, CreatureDef>();
export function creatureDef(name: string, kind: string): CreatureDef {
  let d = defs.get(name);
  if (!d) {
    d = RULES.find(([re]) => re.test(name))?.[1] ?? (kind === 'ward' ? WARD : BEAST);
    // Pistas de color por elemento (brewlings, espíritus).
    if (d.shape === 'panda') {
      if (/fire/.test(name)) d = { ...d, col: '#c0502a' };
      else if (/storm/.test(name)) d = { ...d, col: '#4a7ac0' };
      else if (/void/.test(name)) d = { ...d, col: '#5a3a8a' };
    }
    defs.set(name, d);
  }
  return d;
}

const sprites = cache<CreatureDef, Map<number, Sprite>>();
/** Sprite de la criatura con radio visual L (unidades de mundo). */
export function creatureSprite(d: CreatureDef, L: number): Sprite {
  let m = sprites.get(d);
  if (!m) { m = new Map(); sprites.set(d, m); }
  const lk = Math.max(6, Math.round(L));
  let s = m.get(lk);
  if (!s) {
    const E = lk * 1.55;
    s = makeSprite(-E, -E, E * 2, E * 2, (g) => {
      g.scale(lk, lk);
      g.lineJoin = 'round'; g.lineCap = 'round';
      g.lineWidth = 0.09;
      g.strokeStyle = INK;
      PAINT[d.shape](g, d.col);
    });
    m.set(lk, s);
  }
  return s;
}

// ---------------------------------------------------------------------------------------------

const TAU = Math.PI * 2;
const INK = '#140e0c';

function el(g: CanvasRenderingContext2D, x: number, y: number, rx: number, ry: number, fill: string | CanvasGradient, rot = 0, stroke = true) {
  g.fillStyle = fill;
  g.beginPath(); g.ellipse(x, y, rx, ry, rot, 0, TAU); g.fill();
  if (stroke) g.stroke();
}
function tri(g: CanvasRenderingContext2D, ax: number, ay: number, bx: number, by: number, cx: number, cy: number, fill: string) {
  g.fillStyle = fill;
  g.beginPath(); g.moveTo(ax, ay); g.lineTo(bx, by); g.lineTo(cx, cy); g.closePath(); g.fill(); g.stroke();
}
/** Relleno con luz desde arriba a la izquierda. */
function shade(g: CanvasRenderingContext2D, c: string, r = 1, x = 0, y = 0) {
  const gr = g.createRadialGradient(x - 0.35 * r, y - 0.4 * r, 0.05, x, y, r * 1.15);
  gr.addColorStop(0, mix(c, '#ffffff', 0.35)); gr.addColorStop(0.55, c); gr.addColorStop(1, mix(c, '#000000', 0.45));
  return gr;
}
function eyes(g: CanvasRenderingContext2D, x: number, dy: number, r: number, col = '#ffe066') {
  g.fillStyle = col;
  g.beginPath(); g.arc(x, -dy, r, 0, TAU); g.arc(x, dy, r, 0, TAU); g.fill();
}
function weapon(g: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number, tip = '#d8dce6') {
  g.strokeStyle = INK; g.lineWidth = 0.16; g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke();
  g.strokeStyle = '#8a6a40'; g.lineWidth = 0.08; g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke();
  g.lineWidth = 0.07; g.strokeStyle = INK;
  const a = Math.atan2(y1 - y0, x1 - x0), c = Math.cos(a), s = Math.sin(a);
  tri(g, x1 + c * 0.3, y1 + s * 0.3, x1 - s * 0.12, y1 + c * 0.12, x1 + s * 0.12, y1 - c * 0.12, tip);
  g.lineWidth = 0.09;
}
function legs4(g: CanvasRenderingContext2D, c: string, fx: number, bx: number, w: number, r: number) {
  const d = mix(c, '#000000', 0.35);
  for (const x of [fx, bx]) for (const s of [-1, 1]) el(g, x, s * w, r * 1.2, r, d);
}
function humanoid(g: CanvasRenderingContext2D, c: string, head: string, armsFwd = 0.45) {
  const d = mix(c, '#000000', 0.25);
  el(g, armsFwd, -0.62, 0.3, 0.17, d, 0.3);
  el(g, armsFwd, 0.62, 0.3, 0.17, d, -0.3);
  el(g, -0.05, 0, 0.42, 0.72, shade(g, c, 0.7, -0.05, 0));
  el(g, 0.12, 0, 0.32, 0.32, shade(g, head, 0.35, 0.12, 0));
}

const PAINT: Record<Shape, (g: CanvasRenderingContext2D, c: string) => void> = {
  wolf(g, c) {
    const d = mix(c, '#000000', 0.3), l = mix(c, '#ffffff', 0.35);
    el(g, -0.86, 0.06, 0.34, 0.18, shade(g, d, 0.34, -0.86, 0.06), 0.2);
    legs4(g, c, 0.38, -0.42, 0.4, 0.14);
    el(g, -0.15, 0, 0.58, 0.38, shade(g, c, 0.6, -0.15, 0));
    el(g, 0.2, 0, 0.36, 0.45, shade(g, c, 0.45, 0.2, 0));
    g.strokeStyle = d; g.lineWidth = 0.1; g.beginPath(); g.moveTo(-0.6, 0); g.lineTo(0.1, 0); g.stroke();
    g.strokeStyle = INK; g.lineWidth = 0.09;
    tri(g, 0.48, -0.17, 0.26, -0.48, 0.66, -0.3, d);
    tri(g, 0.48, 0.17, 0.26, 0.48, 0.66, 0.3, d);
    el(g, 0.6, 0, 0.33, 0.31, shade(g, c, 0.33, 0.6, 0));
    el(g, 0.95, 0, 0.2, 0.15, l);
    g.fillStyle = INK; g.beginPath(); g.arc(1.12, 0, 0.06, 0, TAU); g.fill();
    eyes(g, 0.76, 0.13, 0.055, '#ffd060');
  },
  beast(g, c) {
    legs4(g, c, 0.45, -0.45, 0.42, 0.16);
    el(g, -0.05, 0, 0.8, 0.52, shade(g, c, 0.85, -0.05, 0));
    el(g, 0.72, 0, 0.36, 0.32, shade(g, c, 0.4, 0.72, 0));
    eyes(g, 0.92, 0.14, 0.06);
  },
  bear(g, c) {
    const d = mix(c, '#000000', 0.35);
    for (const [x, y] of [[0.5, -0.62], [0.5, 0.62], [-0.55, -0.55], [-0.55, 0.55]]) el(g, x, y, 0.24, 0.2, d);
    el(g, -0.12, 0, 0.88, 0.74, shade(g, c, 0.9, -0.12, 0));
    el(g, 0.58, -0.34, 0.14, 0.14, d); el(g, 0.58, 0.34, 0.14, 0.14, d);
    el(g, 0.72, 0, 0.4, 0.38, shade(g, c, 0.42, 0.72, 0));
    el(g, 1.06, 0, 0.16, 0.14, mix(c, '#e8d0a0', 0.5));
    g.fillStyle = INK; g.beginPath(); g.arc(1.17, 0, 0.06, 0, TAU); g.fill();
    // Armadura de espíritu: hombreras.
    g.strokeStyle = '#d8c8a0'; g.lineWidth = 0.1;
    g.beginPath(); g.arc(-0.1, 0, 0.55, -1.2, -0.4); g.stroke();
    g.beginPath(); g.arc(-0.1, 0, 0.55, 0.4, 1.2); g.stroke();
    g.strokeStyle = INK; g.lineWidth = 0.09;
  },
  treant(g, c) {
    const bark = '#5a3e26';
    g.strokeStyle = bark; g.lineWidth = 0.22;
    for (let k = 0; k < 5; k++) { const a = (k / 5) * TAU + 0.3; g.beginPath(); g.moveTo(0, 0); g.lineTo(Math.cos(a) * 1.05, Math.sin(a) * 1.05); g.stroke(); }
    g.strokeStyle = INK; g.lineWidth = 0.09;
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * TAU, r = 0.55;
      el(g, Math.cos(a) * r, Math.sin(a) * r, 0.42, 0.42, shade(g, mix(c, '#1e3a12', (k % 3) * 0.18), 0.42, Math.cos(a) * r, Math.sin(a) * r));
    }
    el(g, 0, 0, 0.5, 0.5, shade(g, mix(c, '#ffffff', 0.08), 0.5));
    el(g, 0.45, 0, 0.26, 0.3, bark);
    eyes(g, 0.6, 0.11, 0.065, '#d8ff70');
  },
  golem(g, c) {
    const d = mix(c, '#000000', 0.35);
    el(g, 0.5, -0.78, 0.34, 0.3, d); el(g, 0.5, 0.78, 0.34, 0.3, d);
    g.fillStyle = shade(g, c, 0.95);
    g.beginPath();
    const pts = [[0.55, -0.5], [0.1, -0.85], [-0.5, -0.7], [-0.85, -0.2], [-0.8, 0.35], [-0.4, 0.8], [0.15, 0.82], [0.6, 0.45]];
    for (const [x, y] of pts) g.lineTo(x, y);
    g.closePath(); g.fill(); g.stroke();
    g.strokeStyle = '#ff8a2a'; g.lineWidth = 0.08;
    g.beginPath(); g.moveTo(-0.5, -0.35); g.lineTo(-0.1, -0.1); g.lineTo(-0.3, 0.35); g.moveTo(-0.1, -0.1); g.lineTo(0.3, 0.05); g.stroke();
    g.strokeStyle = INK; g.lineWidth = 0.09;
    el(g, 0.55, 0, 0.26, 0.26, d);
    eyes(g, 0.7, 0.1, 0.06, '#ffb030');
  },
  spider(g, c) {
    const d = mix(c, '#000000', 0.25);
    g.strokeStyle = INK; g.lineWidth = 0.12;
    for (const s of [-1, 1]) for (let i = 0; i < 4; i++) {
      const a = (0.55 + i * 0.5) * s;
      const kx = 0.1 + Math.cos(a) * 0.7, ky = Math.sin(a) * 0.7;
      g.beginPath(); g.moveTo(0.1, 0); g.lineTo(kx, ky); g.lineTo(kx + Math.cos(a - 0.5 * s) * 0.45, ky + Math.sin(a - 0.5 * s) * 0.6); g.stroke();
    }
    g.lineWidth = 0.09;
    el(g, -0.5, 0, 0.62, 0.48, shade(g, c, 0.6, -0.5, 0));
    g.fillStyle = '#c02a2a'; g.beginPath(); g.moveTo(-0.75, -0.14); g.lineTo(-0.3, 0.14); g.lineTo(-0.3, -0.14); g.lineTo(-0.75, 0.14); g.closePath(); g.fill();
    el(g, 0.22, 0, 0.3, 0.27, d);
    eyes(g, 0.4, 0.08, 0.05, '#ff6a4a');
  },
  kobold(g, c) {
    const h = mix(c, '#f0c890', 0.35), d = mix(c, '#000000', 0.3);
    weapon(g, -0.1, 0.5, 1.15, 0.45);
    el(g, 0.3, 0.52, 0.18, 0.13, d); el(g, 0.3, -0.5, 0.18, 0.13, d);
    el(g, -0.15, 0, 0.36, 0.56, shade(g, c, 0.6, -0.15, 0));
    tri(g, 0.12, -0.2, -0.12, -0.56, 0.3, -0.27, h);
    tri(g, 0.12, 0.2, -0.12, 0.56, 0.3, 0.27, h);
    el(g, 0.22, 0, 0.32, 0.3, shade(g, h, 0.32, 0.22, 0));
    el(g, 0.52, 0, 0.15, 0.13, mix(h, '#ffffff', 0.25));
    const fg = g.createRadialGradient(0.12, 0, 0.01, 0.12, 0, 0.32);
    fg.addColorStop(0, 'rgba(255,240,170,0.95)'); fg.addColorStop(0.35, 'rgba(255,190,80,0.6)'); fg.addColorStop(1, 'rgba(255,170,60,0)');
    g.fillStyle = fg; g.beginPath(); g.arc(0.12, 0, 0.32, 0, TAU); g.fill();
    g.fillStyle = '#fff6d0'; g.beginPath(); g.arc(0.12, 0, 0.07, 0, TAU); g.fill();
    eyes(g, 0.4, 0.12, 0.045, '#1a120c');
  },
  satyr(g, c) {
    weapon(g, 0.2, -0.55, 1.15, -0.55, '#b0ff70');
    humanoid(g, c, mix(c, '#e0c0a0', 0.4));
    g.strokeStyle = '#e8dcc0'; g.lineWidth = 0.1;
    g.beginPath(); g.arc(-0.05, -0.18, 0.2, -0.3, 2.2); g.stroke();
    g.beginPath(); g.arc(-0.05, 0.18, 0.2, -2.2, 0.3); g.stroke();
    g.strokeStyle = INK; g.lineWidth = 0.09;
    eyes(g, 0.38, 0.11, 0.05, '#c0ff60');
  },
  centaur(g, c) {
    const d = mix(c, '#000000', 0.3);
    g.fillStyle = d; g.beginPath(); g.moveTo(-1.0, -0.08); g.quadraticCurveTo(-1.45, 0, -1.35, 0.25); g.quadraticCurveTo(-1.15, 0.1, -1.0, 0.1); g.fill(); g.stroke();
    legs4(g, c, 0.15, -0.8, 0.36, 0.13);
    el(g, -0.4, 0, 0.72, 0.42, shade(g, c, 0.75, -0.4, 0));
    el(g, 0.45, -0.52, 0.22, 0.14, d, 0.4); el(g, 0.45, 0.52, 0.22, 0.14, d, -0.4);
    el(g, 0.3, 0, 0.3, 0.5, shade(g, mix(c, '#d0a080', 0.4), 0.5, 0.3, 0));
    el(g, 0.45, 0, 0.2, 0.2, mix(c, '#e0b890', 0.5));
    weapon(g, 0.55, 0.5, 1.25, 0.5, '#e8e8e8');
  },
  skeleton(g, c) {
    weapon(g, 0.35, 0.55, 1.2, 0.5, '#e0e4ea');
    humanoid(g, c, c);
    g.strokeStyle = '#5a5444'; g.lineWidth = 0.06;
    for (let k = -2; k <= 2; k++) { g.beginPath(); g.moveTo(-0.3, k * 0.17); g.lineTo(0.0, k * 0.17); g.stroke(); }
    g.strokeStyle = INK; g.lineWidth = 0.09;
    g.fillStyle = INK; g.beginPath(); g.arc(0.25, -0.1, 0.07, 0, TAU); g.arc(0.25, 0.1, 0.07, 0, TAU); g.fill();
    eyes(g, 0.25, 0.1, 0.035, '#7fe0ff');
  },
  zombie(g, c) {
    humanoid(g, c, mix(c, '#c0d090', 0.3), 0.75);
    eyes(g, 0.33, 0.1, 0.05, '#ff5040');
  },
  humanoid(g, c) {
    weapon(g, 0.3, 0.55, 1.2, 0.55);
    humanoid(g, c, mix(c, '#f0d0b0', 0.5));
    eyes(g, 0.36, 0.1, 0.045, '#ffffff');
  },
  spirit(g, c) {
    const gr = g.createRadialGradient(0, 0, 0.05, 0, 0, 1.3);
    gr.addColorStop(0, mix(c, '#ffffff', 0, 0.6)); gr.addColorStop(1, mix(c, '#ffffff', 0, 0));
    g.fillStyle = gr; g.beginPath(); g.arc(0, 0, 1.3, 0, TAU); g.fill();
    g.fillStyle = mix(c, '#ffffff', 0.15, 0.85);
    g.beginPath(); g.moveTo(-1.35, 0); g.quadraticCurveTo(-0.4, -0.75, 0.3, -0.52); g.arc(0.25, 0, 0.55, -1.5, 1.5); g.quadraticCurveTo(-0.4, 0.75, -1.35, 0); g.fill();
    const cg = g.createRadialGradient(0.15, -0.1, 0.02, 0.25, 0, 0.5);
    cg.addColorStop(0, '#ffffff'); cg.addColorStop(1, mix(c, '#ffffff', 0.3));
    g.fillStyle = cg; g.beginPath(); g.arc(0.25, 0, 0.42, 0, TAU); g.fill();
    eyes(g, 0.45, 0.13, 0.06, mix(c, '#000000', 0.6));
  },
  bird(g, c) {
    const d = mix(c, '#000000', 0.3);
    for (const s of [-1, 1]) {
      g.fillStyle = shade(g, c, 1.2);
      g.beginPath(); g.moveTo(0.25, 0.1 * s); g.quadraticCurveTo(0.2, 1.1 * s, -0.55, 1.35 * s); g.lineTo(-0.3, 0.75 * s); g.lineTo(-0.6, 0.6 * s); g.lineTo(-0.25, 0.15 * s); g.closePath(); g.fill(); g.stroke();
    }
    tri(g, -0.4, 0, -0.95, -0.25, -0.95, 0.25, d);
    el(g, 0, 0, 0.5, 0.2, shade(g, c, 0.5));
    el(g, 0.5, 0, 0.18, 0.16, mix(c, '#ffffff', 0.4));
    tri(g, 0.65, -0.06, 0.88, 0, 0.65, 0.06, '#e8b040');
  },
  boar(g, c) {
    legs4(g, c, 0.42, -0.45, 0.42, 0.15);
    el(g, -0.1, 0, 0.82, 0.58, shade(g, c, 0.85, -0.1, 0));
    g.strokeStyle = mix(c, '#000000', 0.5); g.lineWidth = 0.08;
    for (let k = 0; k < 5; k++) { g.beginPath(); g.moveTo(-0.6 + k * 0.22, -0.08); g.lineTo(-0.5 + k * 0.22, 0.08); g.stroke(); }
    g.strokeStyle = INK; g.lineWidth = 0.09;
    el(g, 0.72, 0, 0.32, 0.3, shade(g, c, 0.35, 0.72, 0));
    el(g, 1.0, 0, 0.12, 0.16, mix(c, '#e0a0a0', 0.4));
    tri(g, 0.85, -0.2, 1.15, -0.32, 0.92, -0.08, '#f0e8d0');
    tri(g, 0.85, 0.2, 1.15, 0.32, 0.92, 0.08, '#f0e8d0');
  },
  imp(g, c) {
    const d = mix(c, '#000000', 0.45);
    for (const s of [-1, 1]) { g.fillStyle = d; g.beginPath(); g.moveTo(0, 0.2 * s); g.lineTo(-0.4, 1.0 * s); g.lineTo(-0.25, 0.55 * s); g.lineTo(-0.7, 0.75 * s); g.lineTo(-0.3, 0.2 * s); g.closePath(); g.fill(); g.stroke(); }
    el(g, 0, 0, 0.45, 0.4, shade(g, c, 0.45));
    tri(g, 0.2, -0.2, 0.05, -0.5, 0.35, -0.25, '#e8dcc0');
    tri(g, 0.2, 0.2, 0.05, 0.5, 0.35, 0.25, '#e8dcc0');
    eyes(g, 0.3, 0.12, 0.06, '#ffe066');
  },
  cog(g, c) {
    g.fillStyle = shade(g, c, 1);
    g.beginPath();
    for (let k = 0; k < 20; k++) { const a = (k / 20) * TAU, r = k % 2 ? 0.8 : 1.0; g.lineTo(Math.cos(a - 0.08) * r, Math.sin(a - 0.08) * r); g.lineTo(Math.cos(a + 0.08) * r, Math.sin(a + 0.08) * r); }
    g.closePath(); g.fill(); g.stroke();
    el(g, 0, 0, 0.42, 0.42, mix(c, '#000000', 0.35));
    el(g, 0, 0, 0.16, 0.16, '#d8dce6');
  },
  stone(g, c) {
    g.fillStyle = shade(g, c, 1);
    g.beginPath();
    for (let k = 0; k < 9; k++) { const a = (k / 9) * TAU, r = 0.82 + ((k * 37) % 7) * 0.035; g.lineTo(Math.cos(a) * r, Math.sin(a) * r); }
    g.closePath(); g.fill(); g.stroke();
    g.strokeStyle = '#6aff9a'; g.lineWidth = 0.07;
    g.beginPath(); g.moveTo(-0.4, -0.3); g.lineTo(0, 0); g.lineTo(0.35, -0.2); g.moveTo(0, 0); g.lineTo(-0.1, 0.45); g.stroke();
  },
  missile(g, c) {
    const fl = g.createLinearGradient(-1.3, 0, -0.6, 0);
    fl.addColorStop(0, 'rgba(255,200,80,0)'); fl.addColorStop(1, '#ffd060');
    g.fillStyle = fl; g.beginPath(); g.moveTo(-0.6, -0.18); g.lineTo(-1.35, 0); g.lineTo(-0.6, 0.18); g.fill();
    tri(g, -0.55, -0.15, -0.8, -0.5, -0.3, -0.18, '#c03a2a');
    tri(g, -0.55, 0.15, -0.8, 0.5, -0.3, 0.18, '#c03a2a');
    el(g, 0, 0, 0.75, 0.22, shade(g, c, 0.7));
    tri(g, 0.68, -0.15, 1.1, 0, 0.68, 0.15, '#c03a2a');
  },
  ward(g, c) {
    el(g, 0, 0, 0.75, 0.75, '#3a3026');
    el(g, 0, 0, 0.5, 0.5, shade(g, c, 0.5));
    g.strokeStyle = mix(c, '#ffffff', 0.6); g.lineWidth = 0.1;
    g.beginPath(); g.moveTo(-0.25, 0); g.lineTo(0.25, 0); g.moveTo(0, -0.25); g.lineTo(0, 0.25); g.stroke();
  },
  plague(g, c) {
    g.strokeStyle = INK;
    for (let k = 0; k < 8; k++) { const a = (k / 8) * TAU; tri(g, Math.cos(a) * 0.5, Math.sin(a) * 0.5, Math.cos(a + 0.2) * 1.05, Math.sin(a + 0.2) * 1.05, Math.cos(a + 0.4) * 0.5, Math.sin(a + 0.4) * 0.5, mix(c, '#000000', 0.35)); }
    el(g, 0, 0, 0.62, 0.62, shade(g, c, 0.62));
    el(g, 0.25, 0, 0.32, 0.24, mix(c, '#d8ff70', 0.4));
    eyes(g, 0.38, 0.1, 0.06, '#ff3a2a');
  },
  serpent(g, c) {
    g.strokeStyle = INK; g.lineWidth = 0.42;
    g.beginPath(); for (let t = 0; t < 1; t += 0.04) { const a = t * TAU * 1.6, r = 0.15 + t * 0.7; g.lineTo(Math.cos(a) * r, Math.sin(a) * r); } g.stroke();
    g.strokeStyle = c; g.lineWidth = 0.3;
    g.beginPath(); for (let t = 0; t < 1; t += 0.04) { const a = t * TAU * 1.6, r = 0.15 + t * 0.7; g.lineTo(Math.cos(a) * r, Math.sin(a) * r); } g.stroke();
    g.strokeStyle = INK; g.lineWidth = 0.09;
    el(g, 0.62, 0, 0.32, 0.26, shade(g, mix(c, '#e8d060', 0.3), 0.3, 0.62, 0));
    eyes(g, 0.72, 0.1, 0.05, '#ff3a2a');
  },
  deathward(g, c) {
    const gr = g.createRadialGradient(0, 0, 0.1, 0, 0, 1.2);
    gr.addColorStop(0, mix(c, '#ffffff', 0, 0.7)); gr.addColorStop(1, mix(c, '#ffffff', 0, 0));
    g.fillStyle = gr; g.beginPath(); g.arc(0, 0, 1.2, 0, TAU); g.fill();
    el(g, 0, 0, 0.62, 0.62, '#2a1a30');
    el(g, 0, 0, 0.42, 0.46, '#e8e0d0');
    g.fillStyle = INK; g.beginPath(); g.arc(-0.14, -0.06, 0.1, 0, TAU); g.arc(0.14, -0.06, 0.1, 0, TAU); g.fill();
    g.fillRect(-0.15, 0.2, 0.3, 0.06);
    eyes(g, 0, 0.14, 0.04, mix(c, '#ffffff', 0.4));
  },
  healward(g, c) {
    const gr = g.createRadialGradient(0, 0, 0.1, 0, 0, 1.25);
    gr.addColorStop(0, mix(c, '#ffffff', 0, 0.65)); gr.addColorStop(1, mix(c, '#ffffff', 0, 0));
    g.fillStyle = gr; g.beginPath(); g.arc(0, 0, 1.25, 0, TAU); g.fill();
    el(g, 0, 0, 0.6, 0.6, '#3a3026');
    g.fillStyle = mix(c, '#ffffff', 0.4);
    g.beginPath(); g.roundRect(-0.14, -0.45, 0.28, 0.9, 0.06); g.roundRect(-0.45, -0.14, 0.9, 0.28, 0.06); g.fill();
  },
  eye(g, c) {
    el(g, 0, 0, 0.75, 0.75, '#2a2430');
    g.fillStyle = '#f0ece0';
    g.beginPath(); g.moveTo(-0.62, 0); g.quadraticCurveTo(0, -0.62, 0.62, 0); g.quadraticCurveTo(0, 0.62, -0.62, 0); g.fill(); g.stroke();
    el(g, 0, 0, 0.26, 0.26, shade(g, c, 0.26), 0, false);
    g.fillStyle = INK; g.beginPath(); g.arc(0, 0, 0.11, 0, TAU); g.fill();
  },
  tomb(g, c) {
    g.fillStyle = shade(g, c, 0.9);
    g.beginPath(); g.moveTo(-0.6, 0.75); g.lineTo(-0.6, -0.3); g.arc(0, -0.3, 0.6, Math.PI, 0); g.lineTo(0.6, 0.75); g.closePath(); g.fill(); g.stroke();
    g.fillStyle = mix(c, '#000000', 0.45);
    g.fillRect(-0.07, -0.55, 0.14, 0.75); g.fillRect(-0.28, -0.32, 0.56, 0.13);
  },
  spire(g, c) {
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * TAU, b = a + TAU / 12;
      tri(g, 0, 0, Math.cos(a) * 1.05, Math.sin(a) * 1.05, Math.cos(b) * 0.45, Math.sin(b) * 0.45, mix(c, '#ffffff', 0.5));
      tri(g, 0, 0, Math.cos(b) * 0.45, Math.sin(b) * 0.45, Math.cos(a + TAU / 6) * 1.05, Math.sin(a + TAU / 6) * 1.05, mix(c, '#2a6a9a', 0.35));
    }
  },
  sun(g, c) {
    const gr = g.createRadialGradient(0, 0, 0.1, 0, 0, 1.4);
    gr.addColorStop(0, '#fff6c0'); gr.addColorStop(0.45, c); gr.addColorStop(1, mix(c, '#ffffff', 0, 0));
    g.fillStyle = gr; g.beginPath(); g.arc(0, 0, 1.4, 0, TAU); g.fill();
    g.strokeStyle = '#fff1a0'; g.lineWidth = 0.08;
    for (let k = 0; k < 12; k++) { const a = (k / 12) * TAU; g.beginPath(); g.moveTo(Math.cos(a) * 0.7, Math.sin(a) * 0.7); g.lineTo(Math.cos(a) * 1.1, Math.sin(a) * 1.1); g.stroke(); }
  },
  blob(g, c) {
    g.fillStyle = c;
    for (let k = 0; k < 7; k++) { const a = (k / 7) * TAU; g.beginPath(); g.arc(Math.cos(a) * 0.55, Math.sin(a) * 0.55, 0.32, 0, TAU); g.fill(); }
    el(g, 0, 0, 0.7, 0.65, c, 0, false);
    eyes(g, 0.35, 0.16, 0.08, '#f0f0ff');
  },
  panda(g, c) {
    el(g, 0.45, -0.6, 0.24, 0.18, mix(c, '#000000', 0.4)); el(g, 0.45, 0.6, 0.24, 0.18, mix(c, '#000000', 0.4));
    el(g, -0.1, 0, 0.78, 0.72, shade(g, c, 0.8, -0.1, 0));
    el(g, 0.42, -0.32, 0.13, 0.13, '#2a1e18'); el(g, 0.42, 0.32, 0.13, 0.13, '#2a1e18');
    el(g, 0.55, 0, 0.36, 0.36, shade(g, '#e8dcc8', 0.38, 0.55, 0));
    eyes(g, 0.7, 0.13, 0.07, '#2a1e18');
  },
  swarm(g, c) {
    g.fillStyle = 'rgba(220,230,255,0.45)';
    g.beginPath(); g.ellipse(-0.1, -0.45, 0.55, 0.28, -0.4, 0, TAU); g.ellipse(-0.1, 0.45, 0.55, 0.28, 0.4, 0, TAU); g.fill();
    el(g, -0.1, 0, 0.6, 0.38, shade(g, c, 0.6, -0.1, 0));
    el(g, 0.5, 0, 0.22, 0.22, mix(c, '#000000', 0.3));
    g.beginPath(); g.moveTo(0.65, -0.1); g.lineTo(0.95, -0.25); g.moveTo(0.65, 0.1); g.lineTo(0.95, 0.25); g.stroke();
  },
};
