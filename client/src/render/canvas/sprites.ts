// Sprites precalculados del modo 2D. Todo lo que no cambia de un frame a otro (fichas de héroe,
// siluetas, estructuras, halos, sombras) se pinta una vez en un canvas pequeño y luego solo se
// copia con drawImage. Los sprites se pintan en unidades de mundo a la resolución de pantalla
// actual (redondeada a medios pasos de log2) para que se vean nítidos sin gastar memoria.
import { HEROES, ITEMS, abilityIcon, heroIcon, heroPortrait, itemIcon } from '../../../../shared/data';
import { ATTR_COLOR, ORB_COLOR } from '../fxstyle';
import { img, ready } from '../images';

/** Imagen ya pintada; (x, y) es la esquina superior izquierda relativa a su origen, en unidades de mundo. */
export interface Sprite { c: HTMLCanvasElement | ImageBitmap; x: number; y: number; w: number; h: number }

const TAU = Math.PI * 2;

// ---------------------------------------------------------------------------------------------
// Resolución y generación

let res = 1;
let gen = 0;
const caches: Map<unknown, unknown>[] = [];
/** Mapa que se vacía cuando cambia la resolución. */
export function cache<K, V>(): Map<K, V> { const m = new Map<K, V>(); caches.push(m as Map<unknown, unknown>); return m; }

/** Resolución de los sprites (px de dispositivo por unidad de mundo). */
export const spriteRes = () => res;
/** Sube cada vez que cambia la resolución: quien guarde sprites debe volver a pedirlos. */
export const spriteGen = () => gen;

/**
 * Adapta la resolución a la escala de pantalla m (px de dispositivo por unidad de mundo).
 * Sube en cuanto hace falta más detalle y solo baja si sobra más del doble, para no
 * repintar en cada paso de la rueda del ratón.
 */
export function setSpriteScale(m: number) {
  const want = Math.ceil(Math.log2(Math.max(0.3, Math.min(3, m))) * 2 - 0.15) / 2;
  const cur = Math.log2(res);
  if (gen > 0 && want <= cur && want > cur - 1) return;
  res = 2 ** want;
  gen++;
  for (const c of caches) c.clear();
}

/** Crea un sprite que cubre [x0, x0+w] × [y0, y0+h] en unidades de mundo. */
export function makeSprite(x0: number, y0: number, w: number, h: number, paint: (g: CanvasRenderingContext2D) => void, r = res): Sprite {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.ceil(w * r));
  c.height = Math.max(1, Math.ceil(h * r));
  const g = c.getContext('2d')!;
  const sx = c.width / w, sy = c.height / h;
  g.setTransform(sx, 0, 0, sy, -x0 * sx, -y0 * sy);
  g.imageSmoothingQuality = 'high';
  paint(g);
  const s: Sprite = { c, x: x0, y: y0, w, h };
  // Como ImageBitmap se copia algo más rápido; mientras llega se usa el canvas.
  if (typeof createImageBitmap === 'function') {
    createImageBitmap(c).then((b) => { s.c = b; c.width = c.height = 0; }, () => {});
  }
  return s;
}

/** Dibuja el sprite con su origen en (x, y) del sistema de coordenadas actual. */
export function blit(c: CanvasRenderingContext2D, s: Sprite, x: number, y: number) {
  c.drawImage(s.c, x + s.x, y + s.y, s.w, s.h);
}

// ---------------------------------------------------------------------------------------------
// Color

const rgbCache = new Map<string, [number, number, number]>();
export function rgb(col: string): [number, number, number] {
  let v = rgbCache.get(col);
  if (v) return v;
  let s = col.trim().replace('#', '');
  if (s.length === 3 || s.length === 4) s = s.split('').map((ch) => ch + ch).join('');
  const n = parseInt(s.slice(0, 6), 16);
  v = Number.isFinite(n) ? [(n >> 16) & 255, (n >> 8) & 255, n & 255] : [150, 140, 120];
  rgbCache.set(col, v);
  return v;
}
/** Mezcla col con otro color (t = 0 → col, 1 → otro). */
export function mix(col: string, other: string, t: number, a = 1) {
  const p = rgb(col), q = rgb(other);
  const f = (i: number) => Math.round(p[i] + (q[i] - p[i]) * t);
  return `rgba(${f(0)},${f(1)},${f(2)},${a})`;
}
export const alpha = (col: string, a: number) => mix(col, col, 0, a);

// ---------------------------------------------------------------------------------------------
// Piezas genéricas (resolución fija: son difusas y se escalan)

let shadowSpr: Sprite | null = null;
/** Sombra difusa de radio 1 centrada en el origen. */
export function shadow(): Sprite {
  return shadowSpr ??= makeSprite(-1.2, -1.2, 2.4, 2.4, (g) => {
    const gr = g.createRadialGradient(0, 0, 0, 0, 0, 1.2);
    gr.addColorStop(0, 'rgba(0,0,0,0.62)');
    gr.addColorStop(0.62, 'rgba(0,0,0,0.42)');
    gr.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gr; g.fillRect(-1.2, -1.2, 2.4, 2.4);
  }, 40);
}

let diskSpr: Sprite | null = null;
/** Disco blanco de radio 1 (destellos de golpe). */
export function whiteDisk(): Sprite {
  return diskSpr ??= makeSprite(-1.05, -1.05, 2.1, 2.1, (g) => {
    g.fillStyle = '#fff'; g.beginPath(); g.arc(0, 0, 1, 0, TAU); g.fill();
  }, 64);
}

let darkSpr: Sprite | null = null;
/** Disco negro de radio 1 (oscurecer al morir). */
export function darkDisk(): Sprite {
  return darkSpr ??= makeSprite(-1.05, -1.05, 2.1, 2.1, (g) => {
    g.fillStyle = '#0a0608'; g.beginPath(); g.arc(0, 0, 1, 0, TAU); g.fill();
  }, 64);
}

const glows = new Map<string, Sprite>();
/** Halo radial de radio 1 del color dado. */
export function glow(col: string): Sprite {
  let s = glows.get(col);
  if (!s) {
    s = makeSprite(-1, -1, 2, 2, (g) => {
      const gr = g.createRadialGradient(0, 0, 0, 0, 0, 1);
      gr.addColorStop(0, alpha(col, 0.85));
      gr.addColorStop(0.35, alpha(col, 0.45));
      gr.addColorStop(1, alpha(col, 0));
      g.fillStyle = gr; g.fillRect(-1, -1, 2, 2);
    }, 48);
    glows.set(col, s);
  }
  return s;
}

const rings = new Map<string, Sprite>();
/** Anillo fino de radio 1 (ondas de fuentes, halos de lanzamiento). */
export function ring(col: string): Sprite {
  let s = rings.get(col);
  if (!s) {
    s = makeSprite(-1.1, -1.1, 2.2, 2.2, (g) => {
      g.strokeStyle = col; g.lineWidth = 0.05;
      g.beginPath(); g.arc(0, 0, 1, 0, TAU); g.stroke();
      g.strokeStyle = alpha(col, 0.35); g.lineWidth = 0.12;
      g.beginPath(); g.arc(0, 0, 1, 0, TAU); g.stroke();
    }, 128);
    rings.set(col, s);
  }
  return s;
}

// ---------------------------------------------------------------------------------------------
// Fichas de héroe

/** Radios de la ficha de héroe (unidades de mundo). */
export const TOKEN = { portrait: 23, frame: 28, team: 34, edge: 36.5 };

const ATTR_SHAPE: Record<string, (g: CanvasRenderingContext2D) => void> = {
  // Fuerza: marco octogonal con remaches.
  str: (g) => {
    const c = ATTR_COLOR.str;
    g.fillStyle = metal(g, c);
    poly(g, 8, TOKEN.frame + 1.2, Math.PI / 8); g.fill();
    g.fillStyle = mix(c, '#ffffff', 0.55);
    for (let k = 0; k < 8; k++) { const a = (k / 8) * TAU + Math.PI / 8; dot(g, Math.cos(a) * 26.2, Math.sin(a) * 26.2, 1.25); }
  },
  // Agilidad: aro con muescas en diagonal, como de hojas.
  agi: (g) => {
    const c = ATTR_COLOR.agi;
    g.fillStyle = metal(g, c);
    g.beginPath(); g.arc(0, 0, TOKEN.frame, 0, TAU); g.fill();
    g.strokeStyle = mix(c, '#000000', 0.55); g.lineWidth = 1.1;
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * TAU;
      g.beginPath(); g.moveTo(Math.cos(a) * 23.8, Math.sin(a) * 23.8); g.lineTo(Math.cos(a + 0.18) * 27.6, Math.sin(a + 0.18) * 27.6); g.stroke();
    }
  },
  // Inteligencia: aro con cuatro gemas en rombo.
  int: (g) => {
    const c = ATTR_COLOR.int;
    g.fillStyle = metal(g, c);
    g.beginPath(); g.arc(0, 0, TOKEN.frame, 0, TAU); g.fill();
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * TAU - Math.PI / 2, x = Math.cos(a) * 25.8, y = Math.sin(a) * 25.8;
      g.fillStyle = '#dff1ff'; g.strokeStyle = mix(c, '#000000', 0.5); g.lineWidth = 0.8;
      g.beginPath(); g.moveTo(x + Math.cos(a) * 3.4, y + Math.sin(a) * 3.4); g.lineTo(x - Math.sin(a) * 2.4, y + Math.cos(a) * 2.4);
      g.lineTo(x - Math.cos(a) * 3.4, y - Math.sin(a) * 3.4); g.lineTo(x + Math.sin(a) * 2.4, y - Math.cos(a) * 2.4); g.closePath(); g.fill(); g.stroke();
    }
  },
  // Universal: aro dorado partido en los tres colores.
  all: (g) => {
    g.fillStyle = metal(g, ATTR_COLOR.all);
    g.beginPath(); g.arc(0, 0, TOKEN.frame, 0, TAU); g.fill();
    const cols = [ATTR_COLOR.str, ATTR_COLOR.agi, ATTR_COLOR.int];
    g.lineWidth = 2.2;
    cols.forEach((c, k) => {
      const a0 = -Math.PI / 2 + (k / 3) * TAU + 0.18;
      g.strokeStyle = c; g.beginPath(); g.arc(0, 0, 25.8, a0, a0 + TAU / 3 - 0.36); g.stroke();
    });
  },
};

function metal(g: CanvasRenderingContext2D, c: string) {
  const gr = g.createLinearGradient(-20, -28, 20, 28);
  gr.addColorStop(0, mix(c, '#ffffff', 0.45));
  gr.addColorStop(0.45, c);
  gr.addColorStop(1, mix(c, '#000000', 0.5));
  return gr;
}
function poly(g: CanvasRenderingContext2D, n: number, r: number, a0 = 0) {
  g.beginPath();
  for (let k = 0; k < n; k++) { const a = a0 + (k / n) * TAU; g.lineTo(Math.cos(a) * r, Math.sin(a) * r); }
  g.closePath();
}
function dot(g: CanvasRenderingContext2D, x: number, y: number, r: number) { g.beginPath(); g.arc(x, y, r, 0, TAU); g.fill(); }

export interface HeroSprites {
  body: Sprite;
  /** Variante tintada para ilusiones propias. */
  ill: Sprite | null;
  /** Qué cara llevaba al pintarla: 0 ninguna, 1 icono, 2 retrato (se repinta cuando carga algo mejor). */
  face: number;
}

/** Imagen y recorte para la ficha: el retrato grande (centrado) o el icono del minimapa mientras carga. */
const faces = new Map<string, [HTMLImageElement, HTMLImageElement]>();
function faceImgs(hero: string) {
  let f = faces.get(hero);
  if (!f) { f = [img(heroPortrait(hero)), img(heroIcon(hero))]; faces.set(hero, f); }
  return f;
}
function faceSource(hero: string): { im: HTMLImageElement; sx: number; sy: number; sw: number; sh: number } | null {
  const p = faceImgs(hero)[0];
  if (ready(p)) {
    const s = p.naturalHeight * 0.96;
    return { im: p, sx: (p.naturalWidth - s) / 2, sy: p.naturalHeight * 0.02, sw: s, sh: s };
  }
  const i = faceImgs(hero)[1];
  if (ready(i)) return { im: i, sx: 0, sy: 0, sw: i.naturalWidth, sh: i.naturalHeight };
  return null;
}

/** Sombra de contacto horneada (abajo a la derecha). */
function bakedShadow(g: CanvasRenderingContext2D, r: number) {
  const gr = g.createRadialGradient(4, 7, r * 0.5, 4, 7, r * 1.12);
  gr.addColorStop(0, 'rgba(0,0,0,0.55)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = gr; g.beginPath(); g.arc(4, 7, r * 1.12, 0, TAU); g.fill();
}

function paintToken(g: CanvasRenderingContext2D, hero: string, team: string, own: boolean, tint: string | null) {
  const T = TOKEN;
  bakedShadow(g, T.edge);
  // Canto exterior y anillo de equipo con bisel.
  g.fillStyle = '#100c12';
  g.beginPath(); g.arc(0, 0, T.edge, 0, TAU); g.fill();
  const tg = g.createLinearGradient(0, -T.team, 0, T.team);
  tg.addColorStop(0, mix(team, '#ffffff', 0.4));
  tg.addColorStop(0.5, team);
  tg.addColorStop(1, mix(team, '#000000', 0.45));
  g.fillStyle = tg;
  g.beginPath(); g.arc(0, 0, T.team, 0, TAU); g.fill();
  g.fillStyle = '#100c12';
  g.beginPath(); g.arc(0, 0, T.frame + 1.6, 0, TAU); g.fill();
  // Marco del atributo.
  (ATTR_SHAPE[HEROES[hero]?.attr ?? 'all'] ?? ATTR_SHAPE.all)(g);
  // Retrato.
  g.save();
  g.beginPath(); g.arc(0, 0, T.portrait, 0, TAU); g.clip();
  g.fillStyle = '#2a2430'; g.fillRect(-T.portrait, -T.portrait, T.portrait * 2, T.portrait * 2);
  const f = faceSource(hero);
  if (f) g.drawImage(f.im, f.sx, f.sy, f.sw, f.sh, -T.portrait, -T.portrait, T.portrait * 2, T.portrait * 2);
  else {
    g.fillStyle = '#e8dcc0'; g.font = 'bold 22px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText((HEROES[hero]?.name ?? hero).slice(0, 1).toUpperCase(), 0, 1);
  }
  if (tint) { g.fillStyle = tint; g.fillRect(-T.portrait, -T.portrait, T.portrait * 2, T.portrait * 2); }
  // Viñeta interior y brillo superior: la ficha parece abombada.
  const vg = g.createRadialGradient(0, -4, T.portrait * 0.55, 0, 0, T.portrait);
  vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,0.5)');
  g.fillStyle = vg; g.fillRect(-T.portrait, -T.portrait, T.portrait * 2, T.portrait * 2);
  const hg = g.createLinearGradient(0, -T.portrait, 0, 0);
  hg.addColorStop(0, 'rgba(255,255,255,0.22)'); hg.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = hg;
  g.beginPath(); g.ellipse(0, -T.portrait * 0.45, T.portrait * 0.8, T.portrait * 0.5, 0, 0, TAU); g.fill();
  g.restore();
  g.strokeStyle = 'rgba(0,0,0,0.65)'; g.lineWidth = 1.2;
  g.beginPath(); g.arc(0, 0, T.portrait, 0, TAU); g.stroke();
  if (own) {
    g.strokeStyle = '#fff3c9'; g.lineWidth = 1.6;
    g.beginPath(); g.arc(0, 0, T.edge - 0.6, 0, TAU); g.stroke();
  }
}

const heroCache = cache<string, Map<string, HeroSprites>>();
/** Fichas del héroe para un color de equipo; propias con un filo claro. */
export function heroSprites(hero: string, team: string, own: boolean): HeroSprites {
  let byTeam = heroCache.get(hero);
  if (!byTeam) { byTeam = new Map(); heroCache.set(hero, byTeam); }
  const key = own ? team + '*' : team;
  let s = byTeam.get(key);
  if (!s || (s.face < 2 && faceLevel(hero) > s.face)) {
    const R = TOKEN.edge + 1;
    s = {
      body: makeSprite(-R, -R, R * 2 + 12, R * 2 + 14, (g) => paintToken(g, hero, team, own, null)),
      ill: null,
      face: faceLevel(hero),
    };
    byTeam.set(key, s);
  }
  return s;
}
export function illusionSprite(hero: string, team: string, s: HeroSprites): Sprite {
  if (!s.ill) { const R = TOKEN.edge + 1; s.ill = makeSprite(-R, -R, R * 2 + 12, R * 2 + 14, (g) => paintToken(g, hero, team, true, 'rgba(70,150,255,0.42)')); }
  return s.ill;
}
const faceLevel = (hero: string) => { const f = faceImgs(hero); return ready(f[0]) ? 2 : ready(f[1]) ? 1 : 0; };

/** Arma que señala hacia dónde mira la ficha (local: apunta a +x). */
export function weaponSprite(melee: boolean, team: string): Sprite {
  const key = (melee ? 'm' : 'r') + team;
  let s = weapons.get(key);
  if (s) return s;
  const R = TOKEN.edge;
  s = makeSprite(R - 9, -16, 42, 32, (g) => {
    g.lineJoin = 'round'; g.lineCap = 'round';
    const dark = '#120e12';
    if (melee) {
      // Espada: hoja de acero, guarda del color del equipo.
      const x0 = R - 4, x1 = R + 27;
      const bg = g.createLinearGradient(0, -4, 0, 4);
      bg.addColorStop(0, '#ffffff'); bg.addColorStop(0.5, '#c9ced8'); bg.addColorStop(1, '#7c8494');
      g.fillStyle = bg; g.strokeStyle = dark; g.lineWidth = 1.6;
      g.beginPath(); g.moveTo(x0, -4.2); g.lineTo(x1 - 8, -4.2); g.lineTo(x1, 0); g.lineTo(x1 - 8, 4.2); g.lineTo(x0, 4.2); g.closePath();
      g.fill(); g.stroke();
      g.strokeStyle = 'rgba(80,90,110,0.8)'; g.lineWidth = 0.8;
      g.beginPath(); g.moveTo(x0 + 1, 0); g.lineTo(x1 - 5, 0); g.stroke();
      g.fillStyle = team; g.strokeStyle = dark; g.lineWidth = 1.4;
      g.beginPath(); g.roundRect(x0 - 3, -10.5, 5, 21, 2); g.fill(); g.stroke();
    } else {
      // Arco tensado con flecha: la punta, del color del equipo.
      const bx = R - 6, br = 14;
      g.strokeStyle = dark; g.lineWidth = 5;
      g.beginPath(); g.arc(bx, 0, br, -1.15, 1.15); g.stroke();
      g.strokeStyle = '#d8a860'; g.lineWidth = 2.8;
      g.beginPath(); g.arc(bx, 0, br, -1.15, 1.15); g.stroke();
      const ax = bx + Math.cos(1.15) * br, ay = Math.sin(1.15) * br;
      g.strokeStyle = 'rgba(255,255,255,0.85)'; g.lineWidth = 0.8;
      g.beginPath(); g.moveTo(ax, -ay); g.lineTo(R - 2, 0); g.lineTo(ax, ay); g.stroke();
      g.strokeStyle = dark; g.lineWidth = 3.4;
      g.beginPath(); g.moveTo(R - 2, 0); g.lineTo(R + 20, 0); g.stroke();
      g.strokeStyle = '#efe4c8'; g.lineWidth = 1.6;
      g.beginPath(); g.moveTo(R - 2, 0); g.lineTo(R + 20, 0); g.stroke();
      g.fillStyle = team; g.strokeStyle = dark; g.lineWidth = 1.6;
      g.beginPath(); g.moveTo(R + 31, 0); g.lineTo(R + 17, -8); g.lineTo(R + 20.5, 0); g.lineTo(R + 17, 8); g.closePath(); g.fill(); g.stroke();
    }
  });
  weapons.set(key, s);
  return s;
}
const weapons = cache<string, Sprite>();

/** Arco de tajo (local: centrado en +x, abarca ±1.2 rad entre los radios 38 y 62). */
export function slashSprite(): Sprite {
  let s = slashes.get(0);
  if (s) return s;
  s = makeSprite(-66, -66, 132, 132, (g) => {
    const A = 1.25, N = 28;
    const cg = g.createConicGradient(-A, 0, 0);
    const span = (2 * A) / TAU;
    cg.addColorStop(0, 'rgba(255,240,210,0)');
    cg.addColorStop(span * 0.6, 'rgba(255,248,230,0.55)');
    cg.addColorStop(span, 'rgba(255,255,255,0.98)');
    cg.addColorStop(Math.min(1, span + 0.001), 'rgba(255,255,255,0)');
    g.fillStyle = cg;
    g.beginPath();
    for (let i = 0; i <= N; i++) { const t = i / N, a = -A + 2 * A * t, w = 1 + 15 * Math.sin(Math.PI * t ** 0.8) ** 0.8; g.lineTo(Math.cos(a) * (52 + w / 2), Math.sin(a) * (52 + w / 2)); }
    for (let i = N; i >= 0; i--) { const t = i / N, a = -A + 2 * A * t, w = 1 + 15 * Math.sin(Math.PI * t ** 0.8) ** 0.8; g.lineTo(Math.cos(a) * (52 - w / 2), Math.sin(a) * (52 - w / 2)); }
    g.closePath(); g.fill();
    g.strokeStyle = 'rgba(255,255,255,0.9)'; g.lineWidth = 1.4;
    g.beginPath(); g.arc(0, 0, 59, 0.1, A - 0.05); g.stroke();
  });
  slashes.set(0, s);
  return s;
}
const slashes = cache<number, Sprite>();

const iconCache = cache<string, Sprite>();
const iconImgs = new Map<string, HTMLImageElement>();
/** Icono redondo de la habilidad o item que se lanza (null mientras carga). */
export function castIcon(key: string): Sprite | null {
  const s = iconCache.get(key);
  if (s) return s;
  let im = iconImgs.get(key);
  if (!im) { im = img(ITEMS[key] ? itemIcon(key) : abilityIcon(key)); iconImgs.set(key, im); }
  if (!ready(im)) return null;
  const r = 13;
  const sp = makeSprite(-r - 2, -r - 2, r * 2 + 4, r * 2 + 4, (g) => {
    g.fillStyle = '#100c12'; g.beginPath(); g.arc(0, 0, r + 1.8, 0, TAU); g.fill();
    g.save(); g.beginPath(); g.arc(0, 0, r - 0.8, 0, TAU); g.clip();
    const s0 = Math.min(im.naturalWidth, im.naturalHeight);
    g.drawImage(im, (im.naturalWidth - s0) / 2, (im.naturalHeight - s0) / 2, s0, s0, -r, -r, r * 2, r * 2);
    g.restore();
    g.strokeStyle = '#f6cf7c'; g.lineWidth = 1.8;
    g.beginPath(); g.arc(0, 0, r, 0, TAU); g.stroke();
  });
  iconCache.set(key, sp);
  return sp;
}

// ---------------------------------------------------------------------------------------------
// Peanas de criaturas y estructuras

const bases = cache<string, Map<number, Sprite>>();
/** Peana redonda bajo criaturas e invocaciones: borde del color del equipo. */
export function baseSprite(r: number, col: string): Sprite {
  let m = bases.get(col);
  if (!m) { m = new Map(); bases.set(col, m); }
  const rk = Math.round(r);
  let s = m.get(rk);
  if (!s) {
    s = makeSprite(-rk - 3, -rk - 3, rk * 2 + 12, rk * 2 + 14, (g) => {
      bakedShadow(g, rk);
      const gr = g.createRadialGradient(0, -rk * 0.3, rk * 0.2, 0, 0, rk);
      gr.addColorStop(0, 'rgba(46,38,34,0.55)'); gr.addColorStop(1, 'rgba(18,14,14,0.78)');
      g.fillStyle = gr; g.beginPath(); g.arc(0, 0, rk, 0, TAU); g.fill();
      const lg = g.createLinearGradient(0, -rk, 0, rk);
      lg.addColorStop(0, mix(col, '#ffffff', 0.35)); lg.addColorStop(1, mix(col, '#000000', 0.4));
      g.strokeStyle = '#0e0a0c'; g.lineWidth = 5.5;
      g.beginPath(); g.arc(0, 0, rk - 0.5, 0, TAU); g.stroke();
      g.strokeStyle = lg; g.lineWidth = 3.4;
      g.beginPath(); g.arc(0, 0, rk - 0.5, 0, TAU); g.stroke();
    });
    m.set(rk, s);
  }
  return s;
}

/** Midas Throne visto desde arriba: estrado octogonal escalonado, asiento y gemas. */
export function throneSprite(): Sprite {
  let s = structures.get('throne');
  if (s) return s;
  s = makeSprite(-150, -150, 300, 300, (g) => {
    const gold = (r: number) => {
      const gr = g.createLinearGradient(-r, -r, r, r);
      gr.addColorStop(0, '#fff1c2'); gr.addColorStop(0.35, '#e8b85a'); gr.addColorStop(0.75, '#a8701e'); gr.addColorStop(1, '#5a3a10');
      return gr;
    };
    // Escalones.
    g.fillStyle = 'rgba(0,0,0,0.45)'; poly(g, 8, 140, Math.PI / 8); g.fill();
    g.fillStyle = '#3a2814'; poly(g, 8, 132, Math.PI / 8); g.fill();
    g.fillStyle = '#7a5424'; poly(g, 8, 126, Math.PI / 8); g.fill();
    g.fillStyle = gold(120); poly(g, 8, 118, Math.PI / 8); g.fill();
    g.strokeStyle = '#3a240a'; g.lineWidth = 3; g.stroke();
    g.fillStyle = '#5a3a10'; poly(g, 8, 98, Math.PI / 8); g.fill();
    g.fillStyle = gold(95); poly(g, 8, 92, Math.PI / 8); g.fill();
    // Grabado radial.
    g.strokeStyle = 'rgba(90,56,14,0.7)'; g.lineWidth = 1.6;
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * TAU;
      g.beginPath(); g.moveTo(Math.cos(a) * 52, Math.sin(a) * 52); g.lineTo(Math.cos(a) * 88, Math.sin(a) * 88); g.stroke();
    }
    g.beginPath(); g.arc(0, 0, 52, 0, TAU); g.stroke();
    // Gemas en las esquinas.
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * TAU + Math.PI / 8;
      const x = Math.cos(a) * 107, y = Math.sin(a) * 107;
      const gr = g.createRadialGradient(x - 2, y - 2, 0.5, x, y, 7);
      gr.addColorStop(0, '#ffffff'); gr.addColorStop(0.4, k % 2 ? '#ff5a4a' : '#5ab0ff'); gr.addColorStop(1, k % 2 ? '#6a0e0a' : '#0a2a6a');
      g.fillStyle = gr; g.beginPath(); g.arc(x, y, 6.5, 0, TAU); g.fill();
      g.strokeStyle = '#3a240a'; g.lineWidth = 1.5; g.stroke();
    }
    // Asiento: respaldo al norte, cojín rojo y monedas.
    g.fillStyle = '#3a240a';
    g.beginPath(); g.roundRect(-34, -50, 68, 24, 8); g.fill();
    g.fillStyle = gold(40);
    g.beginPath(); g.roundRect(-31, -48, 62, 19, 6); g.fill();
    g.fillStyle = '#3a240a'; g.beginPath(); g.roundRect(-30, -28, 60, 50, 10); g.fill();
    const cg = g.createLinearGradient(0, -26, 0, 20);
    cg.addColorStop(0, '#e05a4a'); cg.addColorStop(1, '#7a1a14');
    g.fillStyle = cg; g.beginPath(); g.roundRect(-26, -25, 52, 43, 8); g.fill();
    g.fillStyle = '#ffd36a';
    for (let k = 0; k < 6; k++) { dot(g, -60 + (k % 3) * 8 + (k > 2 ? 4 : 0), 34 - (k > 2 ? 6 : 0), 5); dot(g, 44 + (k % 3) * 7, 30 + (k > 2 ? -6 : 0), 5); }
    g.strokeStyle = '#8a5a14'; g.lineWidth = 1;
    for (let k = 0; k < 6; k++) { g.beginPath(); g.arc(-60 + (k % 3) * 8 + (k > 2 ? 4 : 0), 34 - (k > 2 ? 6 : 0), 5, 0, TAU); g.stroke(); }
    // Corona tallada en el respaldo.
    g.fillStyle = '#fff1c2';
    g.beginPath(); g.moveTo(-14, -34); g.lineTo(-10, -44); g.lineTo(-4, -37); g.lineTo(0, -46); g.lineTo(4, -37); g.lineTo(10, -44); g.lineTo(14, -34); g.closePath(); g.fill();
  });
  structures.set('throne', s);
  return s;
}
const structures = cache<string, Sprite>();

/** Kobold King desde arriba (local: mira a +x). */
export function koboldKingSprite(): Sprite {
  let s = structures.get('kobold');
  if (s) return s;
  s = makeSprite(-60, -60, 120, 120, (g) => {
    g.lineJoin = 'round'; g.lineCap = 'round';
    const dark = '#1a120c', fur = '#86603c', head = '#c4935c';
    g.strokeStyle = dark; g.lineWidth = 2.2;
    // Capa corta a la espalda.
    const cg = g.createLinearGradient(-40, 0, 0, 0);
    cg.addColorStop(0, '#4a0e1a'); cg.addColorStop(1, '#8a2234');
    g.fillStyle = cg;
    g.beginPath(); g.ellipse(-14, 0, 24, 34, 0, Math.PI * 0.5, Math.PI * 1.5); g.closePath(); g.fill(); g.stroke();
    // Brazos y cetro.
    g.fillStyle = fur;
    g.beginPath(); g.ellipse(10, -27, 10, 8, -0.4, 0, TAU); g.fill(); g.stroke();
    g.beginPath(); g.ellipse(10, 27, 10, 8, 0.4, 0, TAU); g.fill(); g.stroke();
    g.strokeStyle = dark; g.lineWidth = 5.5; g.beginPath(); g.moveTo(6, 30); g.lineTo(44, 34); g.stroke();
    g.strokeStyle = '#e0b860'; g.lineWidth = 3; g.beginPath(); g.moveTo(6, 30); g.lineTo(44, 34); g.stroke();
    const og = g.createRadialGradient(44, 33, 0.5, 46, 34, 7);
    og.addColorStop(0, '#ffffff'); og.addColorStop(0.5, '#7fe0ff'); og.addColorStop(1, '#2a6a9a');
    g.fillStyle = og; g.strokeStyle = dark; g.lineWidth = 1.6; dot(g, 46, 34, 6.5); g.stroke();
    // Cuerpo.
    const bg = g.createRadialGradient(-8, -10, 3, -2, 0, 30);
    bg.addColorStop(0, '#a87c50'); bg.addColorStop(1, '#5a3c22');
    g.fillStyle = bg; g.lineWidth = 2.2;
    g.beginPath(); g.ellipse(-2, 0, 22, 27, 0, 0, TAU); g.fill(); g.stroke();
    // Orejas largas hacia atrás.
    g.fillStyle = head;
    g.beginPath(); g.moveTo(12, -10); g.lineTo(-14, -34); g.lineTo(20, -16); g.closePath(); g.fill(); g.stroke();
    g.beginPath(); g.moveTo(12, 10); g.lineTo(-14, 34); g.lineTo(20, 16); g.closePath(); g.fill(); g.stroke();
    // Cabeza y hocico.
    const hg = g.createRadialGradient(12, -6, 2, 16, 0, 18);
    hg.addColorStop(0, '#e0b07a'); hg.addColorStop(1, '#9a6a3a');
    g.fillStyle = hg; g.beginPath(); g.ellipse(16, 0, 17, 16, 0, 0, TAU); g.fill(); g.stroke();
    g.fillStyle = '#e8c08a'; g.beginPath(); g.ellipse(32, 0, 8, 7, 0, 0, TAU); g.fill(); g.stroke();
    g.fillStyle = dark; dot(g, 39, 0, 2.4);
    // Corona.
    g.fillStyle = '#ffd36a'; g.strokeStyle = '#6a4416'; g.lineWidth = 1.8;
    g.beginPath();
    for (let k = 0; k < 10; k++) { const a = (k / 10) * TAU, r = k % 2 ? 7 : 14; g.lineTo(14 + Math.cos(a) * r, Math.sin(a) * r); }
    g.closePath(); g.fill(); g.stroke();
    g.fillStyle = '#fff6d0';
    for (let k = 0; k < 5; k++) { const a = (k / 5) * TAU; dot(g, 14 + Math.cos(a) * 12, Math.sin(a) * 12, 1.8); }
    g.fillStyle = '#e0303a'; dot(g, 14, 0, 3.6);
  });
  structures.set('kobold', s);
  return s;
}

const fountains = cache<string, Sprite>();
/** Fuente de la base: pila de piedra con agua tintada del equipo. */
export function fountainSprite(team: string): Sprite {
  let s = fountains.get(team);
  if (s) return s;
  s = makeSprite(-100, -100, 200, 200, (g) => {
    g.fillStyle = 'rgba(0,0,0,0.4)'; g.beginPath(); g.arc(5, 7, 92, 0, TAU); g.fill();
    // Brocal con bloques.
    const sg = g.createLinearGradient(0, -90, 0, 90);
    sg.addColorStop(0, '#8a8094'); sg.addColorStop(1, '#3a3442');
    g.fillStyle = sg; g.beginPath(); g.arc(0, 0, 90, 0, TAU); g.fill();
    g.strokeStyle = '#1a1520'; g.lineWidth = 3; g.stroke();
    g.lineWidth = 2;
    for (let k = 0; k < 16; k++) { const a = (k / 16) * TAU; g.beginPath(); g.moveTo(Math.cos(a) * 72, Math.sin(a) * 72); g.lineTo(Math.cos(a) * 90, Math.sin(a) * 90); g.stroke(); }
    // Agua.
    const wg = g.createRadialGradient(-20, -20, 6, 0, 0, 72);
    wg.addColorStop(0, mix(team, '#ffffff', 0.75)); wg.addColorStop(0.5, mix(team, '#3a6aa0', 0.35)); wg.addColorStop(1, mix(team, '#0a1020', 0.6));
    g.fillStyle = wg; g.beginPath(); g.arc(0, 0, 72, 0, TAU); g.fill();
    g.strokeStyle = '#1a1520'; g.lineWidth = 3; g.stroke();
    // Pilar central con gema.
    g.fillStyle = '#5a5262'; poly(g, 6, 22); g.fill(); g.stroke();
    const cg = g.createRadialGradient(-4, -4, 1, 0, 0, 13);
    cg.addColorStop(0, '#ffffff'); cg.addColorStop(0.5, team); cg.addColorStop(1, mix(team, '#000000', 0.5));
    g.fillStyle = cg; poly(g, 6, 13, Math.PI / 6); g.fill();
  });
  fountains.set(team, s);
  return s;
}

const orbs = cache<string, Sprite>();
/** Gema facetada del orbe del Kobold King. */
export function orbSprite(rarity: string): Sprite {
  let s = orbs.get(rarity);
  if (s) return s;
  const col = ORB_COLOR[rarity] ?? '#7fe0ff';
  s = makeSprite(-40, -40, 80, 80, (g) => {
    g.lineJoin = 'round';
    const pts: [number, number][] = [[0, -34], [24, -6], [0, 34], [-24, -6]];
    g.fillStyle = mix(col, '#000000', 0.55); g.strokeStyle = '#ffffff'; g.lineWidth = 2;
    g.beginPath(); for (const [x, y] of pts) g.lineTo(x, y); g.closePath(); g.fill(); g.stroke();
    g.fillStyle = mix(col, '#ffffff', 0.55);
    g.beginPath(); g.moveTo(0, -34); g.lineTo(24, -6); g.lineTo(0, 2); g.closePath(); g.fill();
    g.fillStyle = col;
    g.beginPath(); g.moveTo(0, -34); g.lineTo(-24, -6); g.lineTo(0, 2); g.closePath(); g.fill();
    g.fillStyle = mix(col, '#000000', 0.3);
    g.beginPath(); g.moveTo(-24, -6); g.lineTo(0, 34); g.lineTo(0, 2); g.closePath(); g.fill();
    g.fillStyle = 'rgba(255,255,255,0.85)';
    g.beginPath(); g.moveTo(-6, -20); g.lineTo(0, -28); g.lineTo(3, -18); g.closePath(); g.fill();
  });
  orbs.set(rarity, s);
  return s;
}
