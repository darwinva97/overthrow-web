// Modo 2D: vista cenital en Canvas, con fichas de héroe sobre un tablero.
// Orden de dibujo: suelo → árboles (por bloques) → effects.drawUnder → unidades (+ effects.drawOnUnit)
// → effects.drawOver → niebla → overlay. Los sprites se precalculan a la escala de pantalla y en cada
// frame no se reserva memoria: arrays y objetos se reutilizan.
import type { MapLayout } from '../../../shared/maps';
import type { Fx } from '../../../shared/sim/types';
import { ST } from '../../../shared/sim/types';
import type { VUnit } from '../game/state';
import { EffectPainter } from './canvas/effects';
import { setSpriteScale, spriteRes } from './canvas/sprites';
import { TreeLayer } from './canvas/trees';
import { UnitPainter } from './canvas/units';
import { Overlay } from './overlay';
import { Fog, TERRAIN_SCALE, terrainCanvas } from './terrain';
import { type Camera, type Renderer, type View } from './types';

interface Eye { x: number; y: number; v: number; flying: boolean }

const byY = (a: VUnit, b: VUnit) => a.py - b.py;
/** La niebla se recalcula si algún ojo se mueve más que esto (la textura tiene 24 u/px)… */
const FOG_MOVE = [24, 16, 10];
/** …y como mucho cada tantos segundos, según la calidad (0 baja … 2 alta). */
const FOG_EVERY = [0.12, 0.08, 0.05];

export class Canvas2DRenderer implements Renderer {
  readonly kind = '2d' as const;
  readonly canvas = document.createElement('canvas');
  readonly elements: HTMLElement[] = [this.canvas];
  private ctx = this.canvas.getContext('2d', { alpha: false })!;
  private terrain: HTMLCanvasElement;
  private fog: Fog;
  private overlay = new Overlay();
  private units = new UnitPainter();
  private effects = new EffectPainter();
  private trees: TreeLayer;
  private W = 1; private H = 1; private dpr = 1;
  private L: MapLayout;
  private clock = 0;
  private vignette: HTMLCanvasElement | null = null;
  private detail: CanvasPattern | null = null;
  // Reutilizados entre frames.
  private sorted: VUnit[] = [];
  private eyes: Eye[] = [];
  private eyePool: Eye[] = [];
  private fogX = new Float64Array(256); private fogY = new Float64Array(256);
  private fogN = -1; private fogNight = false; private fogVz = -1; private fogAge = 0; private fogDirty = true;
  private fogUpdates = 0;
  private dashRange = [0, 0];
  private project = (x: number, y: number, h: number) => this.worldToScreen(x, y, h, this.cam);
  private heightOf = (u: VUnit) => (u.k === 'hero' || u.k === 'illusion' ? 70 : 40);
  private cam: Camera = { x: 0, y: 0, zoom: 1 };
  private lastJs = 0;
  private quality: 0 | 1 | 2 = 2;

  treesChanged(changed: [number, number][]) {
    this.trees.changed(changed);
    this.fogDirty = true;
  }

  constructor(L: MapLayout, teamColors: string[], terrain?: HTMLCanvasElement) {
    this.L = L;
    this.canvas.className = 'world';
    this.terrain = terrain ?? terrainCanvas(L, { trees: false, teamColors });
    this.fog = new Fog(L);
    this.trees = new TreeLayer(L);
  }

  resize(w: number, h: number, dpr: number) {
    this.W = w; this.H = h; this.dpr = dpr;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.vignette = null;
  }

  private scale(cam: Camera) { return (this.H / 1500) * cam.zoom; }

  screenToWorld(sx: number, sy: number, cam: Camera) {
    const s = this.scale(cam);
    return { x: cam.x + (sx - this.W / 2) / s, y: cam.y + (sy - this.H / 2) / s };
  }
  worldToScreen(x: number, y: number, h: number, cam: Camera) {
    const s = this.scale(cam);
    return { x: (x - cam.x) * s + this.W / 2, y: (y - cam.y) * s + this.H / 2 - h * s * 0.55 };
  }

  fx(f: Fx, v: View) {
    this.overlay.fx(f, v);
    this.units.onFx(f, v);
    this.effects.fx(f, v);
  }

  setQuality(q: 0 | 1 | 2) { this.quality = q; this.effects.setQuality(q); }

  stats() {
    const fx = (this.effects as { stats?: () => Record<string, number> }).stats?.() ?? {};
    return {
      ...fx,
      units: this.units.drawnCount, culled: this.units.culled, treeBlocks: this.trees.drawnBlocks,
      treesDirect: this.trees.directTrees, fogUpdates: this.fogUpdates, res: spriteRes(), js: Math.round(this.lastJs * 100) / 100,
    };
  }

  render(v: View, cam: Camera, dt: number) {
    const t0 = performance.now();
    this.cam = cam;
    this.clock += dt;
    const c = this.ctx, s = this.scale(cam), dpr = this.dpr, W = this.W, H = this.H;
    // Mundo → píxel de dispositivo: X = m·x + ox.
    const m = s * dpr, ox = dpr * (W / 2 - cam.x * s), oy = dpr * (H / 2 - cam.y * s);
    const x0 = cam.x - W / 2 / s, y0 = cam.y - H / 2 / s, x1 = cam.x + W / 2 / s, y1 = cam.y + H / 2 / s;
    setSpriteScale(m);

    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.globalAlpha = 1;
    c.fillStyle = '#0c0a10';
    c.fillRect(0, 0, W, H);
    // Suelo: solo el trozo visible del canvas pre-pintado, recortado a sus bordes
    // (pedir fuera de la imagen obliga al navegador a recortar en cada frame).
    const g = this.L.grid;
    const T = TERRAIN_SCALE, tw = this.terrain.width;
    const sx0 = Math.max(0, (x0 - g.ox) * T), sy0 = Math.max(0, (y0 - g.oy) * T);
    const sx1 = Math.min(tw, (x1 - g.ox) * T), sy1 = Math.min(this.terrain.height, (y1 - g.oy) * T);
    c.imageSmoothingEnabled = true;
    if (sx1 > sx0 && sy1 > sy0) {
      c.setTransform(m, 0, 0, m, ox, oy);
      c.drawImage(this.terrain, sx0, sy0, sx1 - sx0, sy1 - sy0, g.ox + sx0 / T, g.oy + sy0 / T, (sx1 - sx0) / T, (sy1 - sy0) / T);
    }

    // Textura fina y marcas de tablero encima del suelo (el suelo pre-pintado es de baja resolución).
    if (this.quality > 0) {
      c.fillStyle = this.detail ??= makeDetail(c);
      c.fillRect(x0, y0, x1 - x0, y1 - y0);
    }

    // Árboles por bloques precompuestos (deja puesta la transformación de mundo).
    this.trees.draw(c, m, ox, oy, x0, y0, x1, y1, this.canvas.width * this.canvas.height);
    const px = 1 / s;

    this.effects.drawUnder(c, v, px, this.clock);

    // Alcance y área de la habilidad que se está apuntando.
    if (v.targeting && v.hero) {
      c.strokeStyle = '#f6cf7c88'; c.lineWidth = 3 * px;
      this.dashRange[0] = 18 * px; this.dashRange[1] = 12 * px;
      c.setLineDash(this.dashRange);
      c.beginPath(); c.arc(v.hero.px, v.hero.py, v.targeting.range, 0, Math.PI * 2); c.stroke();
      c.setLineDash(NO_DASH);
      if (v.targeting.aoe) {
        c.fillStyle = '#f6cf7c22'; c.strokeStyle = '#f6cf7ccc';
        c.beginPath(); c.arc(v.mouse.x, v.mouse.y, v.targeting.aoe, 0, Math.PI * 2); c.fill(); c.stroke();
      }
    }
    if (v.marker) {
      const k = (performance.now() / 1000 - v.marker.t) / 0.5;
      if (k < 1) {
        c.strokeStyle = v.marker.attack ? '#ff503c' : '#78ff78';
        c.globalAlpha = 1 - k;
        c.lineWidth = 4 * px;
        c.beginPath(); c.arc(v.marker.x, v.marker.y, 40 * (1 - k * 0.6), 0, Math.PI * 2); c.stroke();
        c.globalAlpha = 1;
      }
    }

    // Unidades de arriba abajo (las de más abajo tapan a las de detrás).
    const sorted = this.sorted;
    sorted.length = v.units.length;
    for (let i = 0; i < v.units.length; i++) sorted[i] = v.units[i];
    sorted.sort(byY);
    this.units.begin(m, ox, oy, x0, y0, x1, y1, this.clock);
    this.units.drawDying(c);
    for (let i = 0; i < sorted.length; i++) {
      const u = sorted[i];
      const d = this.units.draw(c, v, u, px, this.clock);
      if (d) this.effects.drawOnUnit(c, v, u, d, px);
    }

    this.effects.drawOver(c, v, dt, px);

    // Niebla: se recalcula solo si algo cambió (los rayos contra los árboles son lo caro).
    this.updateFog(v, dt);
    const size = g.w * 64;
    c.setTransform(m, 0, 0, m, ox, oy);
    c.globalAlpha = 1;
    c.imageSmoothingEnabled = true;
    c.drawImage(this.fog.canvas, g.ox, g.oy, size, size);

    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (v.night) { c.fillStyle = 'rgba(30,40,110,0.16)'; c.fillRect(0, 0, W, H); }
    // Viñeta: centra la mirada en el tablero.
    c.drawImage(this.vignette ??= makeVignette(W, H), 0, 0, W, H);
    this.overlay.draw(c, v, this.project, dt, this.heightOf);
    this.lastJs = performance.now() - t0;
  }

  private updateFog(v: View, dt: number) {
    this.fogAge += dt;
    if (!this.fogDirty && this.fogAge < FOG_EVERY[this.quality]) return;
    const move = FOG_MOVE[this.quality];
    // Ojos del equipo, en objetos reutilizados.
    let n = 0;
    let changed = this.fogDirty || v.night !== this.fogNight || v.vz.length !== this.fogVz || this.fogAge > 0.5;
    for (let i = 0; i < v.units.length; i++) {
      const u = v.units[i];
      if (u.t !== v.team || !u.v) continue;
      const e = this.eyePool[n] ??= { x: 0, y: 0, v: 0, flying: false };
      e.x = u.px; e.y = u.py; e.v = u.v; e.flying = (u.s & ST.flying) !== 0;
      if (n >= this.fogX.length || Math.abs(this.fogX[n] - e.x) > move || Math.abs(this.fogY[n] - e.y) > move) changed = true;
      this.eyes[n] = e;
      n++;
    }
    if (n !== this.fogN) changed = true;
    if (!changed) return;
    this.eyes.length = n;
    for (let i = 0; i < n && i < this.fogX.length; i++) { this.fogX[i] = this.eyes[i].x; this.fogY[i] = this.eyes[i].y; }
    this.fogN = n; this.fogNight = v.night; this.fogVz = v.vz.length; this.fogAge = 0; this.fogDirty = false;
    this.fogUpdates++;
    this.fog.update(this.eyes, v.night, v.vz);
  }

  dispose() { this.canvas.remove(); }
}

const NO_DASH: number[] = [];

/** Patrón de 512 u de lado: grano de piedra y una cruz de tablero cada 256 u. */
function makeDetail(ctx: CanvasRenderingContext2D) {
  const S = 512, R = 0.5;
  const c = document.createElement('canvas');
  c.width = c.height = S * R;
  const x = c.getContext('2d')!;
  x.scale(R, R);
  let seed = 7;
  const rnd = () => ((seed = Math.imul(seed ^ (seed >>> 15), 2246822519) + 0x9e3779b9 | 0) >>> 0) / 4294967296;
  for (let i = 0; i < 900; i++) {
    const px = rnd() * S, py = rnd() * S, r = 1.5 + rnd() * 5;
    x.fillStyle = rnd() < 0.55 ? `rgba(0,0,0,${0.05 + rnd() * 0.07})` : `rgba(255,240,210,${0.025 + rnd() * 0.04})`;
    x.beginPath(); x.ellipse(px, py, r * (1 + rnd()), r, rnd() * Math.PI, 0, Math.PI * 2); x.fill();
  }
  // Grietas finas.
  x.strokeStyle = 'rgba(0,0,0,0.12)'; x.lineWidth = 1.6; x.lineCap = 'round';
  for (let i = 0; i < 10; i++) {
    let px = rnd() * S, py = rnd() * S;
    x.beginPath(); x.moveTo(px, py);
    for (let k = 0; k < 4; k++) { px += (rnd() - 0.5) * 60; py += (rnd() - 0.5) * 60; x.lineTo(px, py); }
    x.stroke();
  }
  // Cruces del tablero.
  for (const [cx, cy] of [[0, 0], [256, 0], [0, 256], [256, 256], [512, 0], [0, 512], [512, 512], [256, 512], [512, 256]]) {
    x.strokeStyle = 'rgba(0,0,0,0.22)'; x.lineWidth = 6;
    x.beginPath(); x.moveTo(cx - 14, cy); x.lineTo(cx + 14, cy); x.moveTo(cx, cy - 14); x.lineTo(cx, cy + 14); x.stroke();
    x.strokeStyle = 'rgba(255,236,200,0.16)'; x.lineWidth = 2.5;
    x.beginPath(); x.moveTo(cx - 12, cy); x.lineTo(cx + 12, cy); x.moveTo(cx, cy - 12); x.lineTo(cx, cy + 12); x.stroke();
  }
  const p = ctx.createPattern(c, 'repeat')!;
  p.setTransform(new DOMMatrix([1 / R, 0, 0, 1 / R, 0, 0]));
  return p;
}

function makeVignette(w: number, h: number) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w / 4)); c.height = Math.max(1, Math.round(h / 4));
  const x = c.getContext('2d')!;
  const r = Math.hypot(c.width, c.height) / 2;
  const gr = x.createRadialGradient(c.width / 2, c.height / 2, r * 0.55, c.width / 2, c.height / 2, r);
  gr.addColorStop(0, 'rgba(6,4,10,0)');
  gr.addColorStop(1, 'rgba(6,4,10,0.5)');
  x.fillStyle = gr;
  x.fillRect(0, 0, c.width, c.height);
  return c;
}
