// Modo 2D: vista cenital en Canvas, con retratos de los héroes.
import type { MapLayout } from '../../../shared/maps';
import type { Fx } from '../../../shared/sim/types';
import { ST } from '../../../shared/sim/types';
import { EffectPainter } from './canvas/effects';
import { UnitPainter } from './canvas/units';
import { Overlay } from './overlay';
import { Fog, TERRAIN_SCALE, terrainCanvas, treeSprites } from './terrain';
import { ROCK, TREE } from '../../../shared/sim/nav';
import { teamColor, type Camera, type Renderer, type View } from './types';

export class Canvas2DRenderer implements Renderer {
  readonly kind = '2d' as const;
  readonly canvas = document.createElement('canvas');
  readonly elements: HTMLElement[] = [this.canvas];
  private ctx = this.canvas.getContext('2d')!;
  private terrain: HTMLCanvasElement;
  private fog: Fog;
  private overlay = new Overlay();
  private units = new UnitPainter();
  private effects = new EffectPainter();
  private W = 1; private H = 1; private dpr = 1;
  private L: MapLayout;
  private clock = 0;
  private trees = treeSprites();
  /** Rocas y muros creados en partida (Fissure…). */
  private newRocks: number[] = [];

  treesChanged(changed: [number, number][]) { this.newRocks = changed.filter(([, v]) => v === ROCK).map(([i]) => i); }

  constructor(L: MapLayout, teamColors: string[], terrain?: HTMLCanvasElement) {
    this.L = L;
    this.canvas.className = 'world';
    this.terrain = terrain ?? terrainCanvas(L, { trees: false, teamColors });
    this.fog = new Fog(L);
  }

  resize(w: number, h: number, dpr: number) {
    this.W = w; this.H = h; this.dpr = dpr;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
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

  render(v: View, cam: Camera, dt: number) {
    this.clock += dt;
    const c = this.ctx, s = this.scale(cam), dpr = this.dpr;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.fillStyle = '#0c0a10';
    c.fillRect(0, 0, this.W, this.H);
    // Suelo: solo el trozo visible del canvas pre-pintado.
    const g = this.L.grid;
    const tl = this.screenToWorld(0, 0, cam);
    const sw = this.W / s, sh = this.H / s;
    c.imageSmoothingEnabled = true;
    c.drawImage(this.terrain, (tl.x - g.ox) * TERRAIN_SCALE, (tl.y - g.oy) * TERRAIN_SCALE, sw * TERRAIN_SCALE, sh * TERRAIN_SCALE, 0, 0, this.W, this.H);

    // A partir de aquí se dibuja en unidades de mundo.
    c.setTransform(dpr * s, 0, 0, dpr * s, dpr * (this.W / 2 - cam.x * s), dpr * (this.H / 2 - cam.y * s));
    const px = 1 / s;

    // Árboles (se pueden talar, así que no van en el suelo pre-pintado).
    const br = this.screenToWorld(this.W, this.H, cam);
    const c0x = Math.max(0, g.cx(tl.x) - 1), c1x = Math.min(g.w - 1, g.cx(br.x) + 1);
    const c0y = Math.max(0, g.cy(tl.y) - 1), c1y = Math.min(g.h - 1, g.cy(br.y) + 1);
    for (let cy = c0y; cy <= c1y; cy++) for (let cx = c0x; cx <= c1x; cx++) {
      if (g.cells[cy * g.w + cx] !== TREE) continue;
      const h = ((cx * 73856093) ^ (cy * 19349663)) >>> 0;
      const jx = ((h % 100) / 100 - 0.5) * 24, jy = (((h >> 8) % 100) / 100 - 0.5) * 24;
      c.drawImage(this.trees[h % 4], g.centerX(cx) - 48 + jx, g.centerY(cy) - 48 + jy, 96, 96);
    }
    for (const i of this.newRocks) {
      const x = g.centerX(i % g.w), y = g.centerY(Math.floor(i / g.w));
      c.fillStyle = '#5a5262'; c.strokeStyle = '#2a2430'; c.lineWidth = 4 * px;
      c.beginPath(); c.arc(x, y, 40, 0, Math.PI * 2); c.fill(); c.stroke();
    }

    this.effects.drawUnder(c, v, px, this.clock);

    // Alcance y área de la habilidad que se está apuntando.
    if (v.targeting && v.hero) {
      c.strokeStyle = '#f6cf7c88'; c.lineWidth = 3 * px; c.setLineDash([18 * px, 12 * px]);
      c.beginPath(); c.arc(v.hero.px, v.hero.py, v.targeting.range, 0, Math.PI * 2); c.stroke();
      c.setLineDash([]);
      if (v.targeting.aoe) {
        c.fillStyle = '#f6cf7c22'; c.strokeStyle = '#f6cf7ccc';
        c.beginPath(); c.arc(v.mouse.x, v.mouse.y, v.targeting.aoe, 0, Math.PI * 2); c.fill(); c.stroke();
      }
    }
    if (v.marker) {
      const k = (performance.now() / 1000 - v.marker.t) / 0.5;
      if (k < 1) {
        c.strokeStyle = v.marker.attack ? `rgba(255,80,60,${1 - k})` : `rgba(120,255,120,${1 - k})`;
        c.lineWidth = 4 * px;
        c.beginPath(); c.arc(v.marker.x, v.marker.y, 40 * (1 - k * 0.6), 0, Math.PI * 2); c.stroke();
      }
    }

    const sorted = [...v.units].sort((a, b) => a.py - b.py);
    for (const u of sorted) {
      const d = this.units.draw(c, v, u, px, this.clock);
      if (d) this.effects.drawOnUnit(c, v, u, d, px);
    }

    this.effects.drawOver(c, v, dt, px);

    // Niebla.
    const eyes = v.units.filter((u) => u.t === v.team && u.v).map((u) => ({ x: u.px, y: u.py, v: u.v!, flying: (u.s & ST.flying) !== 0 }));
    this.fog.update(eyes, v.night, v.vz);
    const size = g.w * 64;
    c.imageSmoothingEnabled = true;
    c.drawImage(this.fog.canvas, g.ox, g.oy, size, size);

    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (v.night) { c.fillStyle = 'rgba(30,40,110,0.16)'; c.fillRect(0, 0, this.W, this.H); }
    this.overlay.draw(c, v, (x, y, h) => this.worldToScreen(x, y, h, cam), dt, (u) => (u.k === 'hero' || u.k === 'illusion' ? 70 : 40));
  }


  dispose() { this.canvas.remove(); }
}
