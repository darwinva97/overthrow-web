// Modo 2D: vista cenital en Canvas, con retratos de los héroes.
import { heroIcon } from '../../../shared/data';
import type { MapLayout } from '../../../shared/maps';
import type { Fx } from '../../../shared/sim/types';
import { ST } from '../../../shared/sim/types';
import type { VUnit } from '../game/state';
import { FX, ORB_COLOR, STATUS, projColor, projSize, type FxStyle } from './fxstyle';
import { img, ready } from './images';
import { Overlay } from './overlay';
import { Fog, TERRAIN_SCALE, terrainCanvas, treeSprites } from './terrain';
import { ROCK, TREE } from '../../../shared/sim/nav';
import { teamColor, type Camera, type Renderer, type View } from './types';

interface LiveFx { f: Fx; s: FxStyle; t: number; d: number }

const CREEP_COLOR: Record<string, string> = {
  kobold: '#8a6a4a', kobold_foreman: '#a07a4a', wolf: '#8c8c96', alpha_wolf: '#b0b0c0', satyr: '#8a5ab0', centaur: '#b08a3a',
};

export class Canvas2DRenderer implements Renderer {
  readonly kind = '2d' as const;
  readonly canvas = document.createElement('canvas');
  readonly elements: HTMLElement[] = [this.canvas];
  private ctx = this.canvas.getContext('2d')!;
  private terrain: HTMLCanvasElement;
  private fog: Fog;
  private overlay = new Overlay();
  private live: LiveFx[] = [];
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
    if (f.n === 'orb_throw') { this.live.push({ f, s: { k: 'flash', c: ORB_COLOR[f.c ?? 'common'], d: f.d ?? 1.5 }, t: 0, d: f.d ?? 1.5 }); return; }
    const s = FX[f.n];
    if (s) this.live.push({ f, s, t: 0, d: f.d ?? s.d });
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

    for (const z of v.zones) {
      const col = z.fx === 'shrapnel' ? '#d9b36a' : '#ffffff';
      c.fillStyle = col + '22'; c.strokeStyle = col + '88'; c.lineWidth = 2 * px;
      c.beginPath(); c.arc(z.x, z.y, z.r, 0, Math.PI * 2); c.fill(); c.stroke();
    }
    for (const u of v.units) for (const fx of u.fx ?? []) {
      const st = STATUS[fx];
      if (!st || (st.k !== 'area' && st.k !== 'spin')) continue;
      c.fillStyle = st.c + (st.k === 'spin' ? '30' : '1c'); c.strokeStyle = st.c + '77'; c.lineWidth = 2 * px;
      c.beginPath(); c.arc(u.px, u.py, st.r ?? 300, 0, Math.PI * 2); c.fill(); c.stroke();
      if (st.k === 'spin') {
        c.lineWidth = 10 * px; c.strokeStyle = st.c + 'cc';
        for (let k = 0; k < 3; k++) {
          const a0 = this.clock * 14 + (k * Math.PI * 2) / 3;
          c.beginPath(); c.arc(u.px, u.py, (st.r ?? 300) * 0.8, a0, a0 + 0.7); c.stroke();
        }
      }
    }

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
    for (const u of sorted) this.drawUnit(c, v, u, px);

    for (const p of v.projs) {
      const col = projColor(p.fx);
      const size = projSize(p.fx);
      if (p.fx === 'hook') {
        const src = v.byId.get(p.s);
        if (src) {
          c.strokeStyle = '#a89a7a'; c.lineWidth = 6 * px; c.setLineDash([10 * px, 6 * px]);
          c.beginPath(); c.moveTo(src.px, src.py); c.lineTo(p.x, p.y); c.stroke(); c.setLineDash([]);
        }
      }
      const gr = c.createRadialGradient(p.x, p.y, 0, p.x, p.y, size);
      gr.addColorStop(0, '#ffffff');
      gr.addColorStop(0.35, col);
      gr.addColorStop(1, col + '00');
      c.fillStyle = gr;
      c.beginPath(); c.arc(p.x, p.y, size, 0, Math.PI * 2); c.fill();
    }

    this.drawFx(c, v, dt, px);

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

  private drawUnit(c: CanvasRenderingContext2D, v: View, u: VUnit, px: number) {
    if (u.s & ST.hidden) return;
    const fx = u.fx ?? [];
    let x = u.px, y = u.py;
    if (u.a) { x += Math.cos(u.pf) * 10; y += Math.sin(u.pf) * 10; }
    const lifted = fx.includes('cyclone');
    if (lifted) y -= 40 + Math.sin(this.clock * 6) * 8;
    c.save();
    if (fx.includes('invis') || fx.includes('ethereal') || fx.includes('doppel')) c.globalAlpha = 0.45;
    const team = teamColor(v, u.t);
    switch (u.k) {
      case 'throne': {
        c.fillStyle = '#00000055';
        c.beginPath(); c.ellipse(x + 10, y + 14, 130, 110, 0, 0, Math.PI * 2); c.fill();
        const gr = c.createRadialGradient(x - 30, y - 30, 10, x, y, 120);
        gr.addColorStop(0, '#fff1c2'); gr.addColorStop(0.5, '#e0a84a'); gr.addColorStop(1, '#6a4416');
        c.fillStyle = gr;
        c.beginPath();
        for (let k = 0; k < 8; k++) { const a = (k / 8) * Math.PI * 2 + Math.PI / 8; c.lineTo(x + Math.cos(a) * 110, y + Math.sin(a) * 110); }
        c.closePath(); c.fill();
        c.strokeStyle = '#3a240a'; c.lineWidth = 6 * px; c.stroke();
        break;
      }
      case 'kobold': {
        c.fillStyle = '#6b4a2a'; c.beginPath(); c.arc(x, y, 34, 0, Math.PI * 2); c.fill();
        c.fillStyle = '#f6cf7c';
        c.beginPath(); c.moveTo(x - 22, y - 26); c.lineTo(x - 14, y - 48); c.lineTo(x, y - 32); c.lineTo(x + 14, y - 48); c.lineTo(x + 22, y - 26); c.closePath(); c.fill();
        break;
      }
      case 'orb': {
        const o = v.orbs.find((q) => q.i === u.i);
        const col = ORB_COLOR[o?.r ?? 'common'] ?? '#7fe0ff';
        c.strokeStyle = col + '88'; c.lineWidth = 3 * px; c.setLineDash([14 * px, 10 * px]);
        c.beginPath(); c.arc(x, y, 220, 0, Math.PI * 2); c.stroke(); c.setLineDash([]);
        for (const [t, p] of o?.p ?? []) {
          c.strokeStyle = teamColor(v, t); c.lineWidth = 12 * px;
          c.beginPath(); c.arc(x, y, 220, -Math.PI / 2, -Math.PI / 2 + (p / v.captureTime) * Math.PI * 2); c.stroke();
        }
        const pulse = 1 + Math.sin(this.clock * 4) * 0.08;
        const gr = c.createRadialGradient(x, y, 0, x, y, 70 * pulse);
        gr.addColorStop(0, '#ffffff'); gr.addColorStop(0.3, col); gr.addColorStop(1, col + '00');
        c.fillStyle = gr; c.beginPath(); c.arc(x, y, 70 * pulse, 0, Math.PI * 2); c.fill();
        c.fillStyle = col;
        c.beginPath(); c.moveTo(x, y - 30); c.lineTo(x + 22, y); c.lineTo(x, y + 30); c.lineTo(x - 22, y); c.closePath(); c.fill();
        break;
      }
      case 'fountain': {
        const gr = c.createRadialGradient(x, y, 10, x, y, 110);
        gr.addColorStop(0, '#ffffff'); gr.addColorStop(0.4, team); gr.addColorStop(1, team + '00');
        c.fillStyle = gr; c.beginPath(); c.arc(x, y, 110, 0, Math.PI * 2); c.fill();
        c.strokeStyle = '#1a1520'; c.lineWidth = 8 * px;
        c.beginPath(); c.arc(x, y, 62, 0, Math.PI * 2); c.stroke();
        break;
      }
      case 'ward': {
        c.fillStyle = '#2a5a2a'; c.beginPath(); c.arc(x, y, 22, 0, Math.PI * 2); c.fill();
        c.fillStyle = '#9cff9c'; c.fillRect(x - 4, y - 14, 8, 28); c.fillRect(x - 14, y - 4, 28, 8);
        break;
      }
      case 'summon':
      case 'creep': {
        if ((u.s & ST.flying) !== 0) y -= 30;
        c.fillStyle = '#0006'; c.beginPath(); c.ellipse(x + 4, y + 6, u.r * 1.2, u.r, 0, 0, Math.PI * 2); c.fill();
        c.fillStyle = CREEP_COLOR[u.n.replace('neutral_', '')] ?? (u.k === 'summon' ? '#6a7a8a' : '#888');
        c.strokeStyle = u.k === 'summon' ? team : '#1a1410'; c.lineWidth = (u.k === 'summon' ? 6 : 4) * px;
        c.beginPath(); c.arc(x, y, u.r * 1.3, 0, Math.PI * 2); c.fill(); c.stroke();
        c.fillStyle = '#1a1410';
        c.beginPath(); c.arc(x + Math.cos(u.pf) * u.r, y + Math.sin(u.pf) * u.r, 6, 0, Math.PI * 2); c.fill();
        break;
      }
      default: {
        const r = 34;
        c.fillStyle = '#0007'; c.beginPath(); c.ellipse(x + 6, y + 9, r * 1.05, r * 0.9, 0, 0, Math.PI * 2); c.fill();
        // Indicador de orientación.
        c.fillStyle = team;
        c.beginPath();
        c.moveTo(x + Math.cos(u.pf) * (r + 16), y + Math.sin(u.pf) * (r + 16));
        c.lineTo(x + Math.cos(u.pf + 0.45) * (r + 2), y + Math.sin(u.pf + 0.45) * (r + 2));
        c.lineTo(x + Math.cos(u.pf - 0.45) * (r + 2), y + Math.sin(u.pf - 0.45) * (r + 2));
        c.closePath(); c.fill();
        const icon = img(heroIcon(u.n));
        c.save();
        c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.clip();
        c.fillStyle = '#222'; c.fill();
        if (ready(icon)) c.drawImage(icon, x - r, y - r, r * 2, r * 2);
        if (u.il) { c.fillStyle = '#3c8ce055'; c.fill(); }
        c.restore();
        c.strokeStyle = team; c.lineWidth = (u.o ? 7 : 5) * px;
        c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.stroke();
        if (v.hover === u.i) { c.strokeStyle = '#ffffffaa'; c.lineWidth = 2 * px; c.beginPath(); c.arc(x, y, r + 8, 0, Math.PI * 2); c.stroke(); }
      }
    }
    // Estados encima de la unidad.
    for (const f of fx) {
      const st = STATUS[f];
      if (!st) continue;
      const rr = (u.k === 'hero' || u.k === 'illusion' ? 34 : u.r * 1.3);
      if (st.k === 'feet') {
        c.strokeStyle = st.c + 'bb'; c.lineWidth = 5 * px;
        c.beginPath(); c.arc(x, y, rr + 10, 0, Math.PI * 2); c.stroke();
      } else if (st.k === 'shell') {
        c.fillStyle = st.c + '22'; c.strokeStyle = st.c + 'cc'; c.lineWidth = 3 * px;
        c.beginPath(); c.arc(x, y, rr + 16, 0, Math.PI * 2); c.fill(); c.stroke();
      } else if (st.k === 'stars') {
        c.fillStyle = st.c;
        for (let k = 0; k < 3; k++) {
          const a = this.clock * 5 + (k * Math.PI * 2) / 3;
          c.beginPath(); c.arc(x + Math.cos(a) * 26, y - rr - 14 + Math.sin(a) * 8, 6, 0, Math.PI * 2); c.fill();
        }
      } else if (st.k === 'lift') {
        c.strokeStyle = st.c + 'aa'; c.lineWidth = 4 * px;
        for (let k = 0; k < 3; k++) { c.beginPath(); c.arc(x, y + 40, 30 + k * 14, this.clock * 8 + k, this.clock * 8 + k + 2); c.stroke(); }
      }
    }
    if (u.c === 2) {
      c.strokeStyle = '#f6cf7c'; c.lineWidth = 3 * px;
      c.beginPath(); c.arc(x, y, 50, this.clock * 3, this.clock * 3 + 4); c.stroke();
    }
    c.restore();
  }

  private drawFx(c: CanvasRenderingContext2D, v: View, dt: number, px: number) {
    for (const l of this.live) {
      l.t += dt;
      const k = Math.min(1, l.t / l.d);
      const { f, s } = l;
      const r = f.r ?? 260;
      c.globalAlpha = 1 - k;
      switch (s.k) {
        case 'ring':
          c.strokeStyle = s.c; c.lineWidth = 10 * px;
          c.beginPath(); c.arc(f.x, f.y, Math.max(1, r * (0.2 + k * 0.8)), 0, Math.PI * 2); c.stroke();
          break;
        case 'burst': {
          const gr = c.createRadialGradient(f.x, f.y, 0, f.x, f.y, r);
          gr.addColorStop(0, '#ffffff'); gr.addColorStop(0.3, s.c); gr.addColorStop(1, s.c + '00');
          c.fillStyle = gr; c.beginPath(); c.arc(f.x, f.y, r * (0.6 + 0.4 * k), 0, Math.PI * 2); c.fill();
          break;
        }
        case 'warn':
          c.globalAlpha = 0.5 + 0.4 * Math.sin(l.t * 18);
          c.strokeStyle = s.c; c.lineWidth = 5 * px; c.fillStyle = s.c + '22';
          c.beginPath(); c.arc(f.x, f.y, r, 0, Math.PI * 2); c.fill(); c.stroke();
          break;
        case 'beam': case 'bolt': {
          const a = f.u ? v.byId.get(f.u) : undefined, b = f.u2 ? v.byId.get(f.u2) : undefined;
          const x1 = a?.px ?? f.x, y1 = a?.py ?? f.y, x2 = b?.px ?? f.x2 ?? f.x, y2 = b?.py ?? f.y2 ?? f.y;
          c.strokeStyle = s.c; c.lineWidth = (s.w ?? 8) * px * 3; c.lineCap = 'round';
          c.beginPath(); c.moveTo(x1, y1);
          if (s.k === 'bolt') {
            for (let i = 1; i < 6; i++) {
              const t = i / 6;
              c.lineTo(x1 + (x2 - x1) * t + (Math.random() - 0.5) * 50, y1 + (y2 - y1) * t + (Math.random() - 0.5) * 50);
            }
          }
          c.lineTo(x2, y2); c.stroke();
          break;
        }
        case 'flash': {
          if (f.n === 'orb_throw') {
            const t = k;
            const x = f.x + ((f.x2 ?? f.x) - f.x) * t, y = f.y + ((f.y2 ?? f.y) - f.y) * t - Math.sin(t * Math.PI) * 500;
            c.globalAlpha = 1; c.fillStyle = s.c;
            c.beginPath(); c.arc(x, y, 30, 0, Math.PI * 2); c.fill();
            break;
          }
          for (const [x, y] of [[f.x, f.y], [f.x2, f.y2]] as [number | undefined, number | undefined][]) {
            if (x === undefined || y === undefined) continue;
            const gr = c.createRadialGradient(x, y, 0, x, y, 90);
            gr.addColorStop(0, '#ffffff'); gr.addColorStop(0.4, s.c); gr.addColorStop(1, s.c + '00');
            c.fillStyle = gr; c.beginPath(); c.arc(x, y, 90, 0, Math.PI * 2); c.fill();
          }
          break;
        }
      }
    }
    c.globalAlpha = 1;
    this.live = this.live.filter((l) => l.t < l.d);
  }

  dispose() { this.canvas.remove(); }
}
