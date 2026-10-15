// Suelo pintado una vez en un canvas: lo usa el modo 2D como imagen de fondo,
// el modo 3D como textura del terreno y el minimapa en pequeño.
import type { MapLayout } from '../../../shared/maps';
import { FREE, ROCK, TREE } from '../../../shared/sim/nav';

export const TERRAIN_SCALE = 0.25;

function hash(x: number, y: number) {
  let n = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263);
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}

export function terrainCanvas(L: MapLayout, opts: { trees: boolean; teamColors: string[] }): HTMLCanvasElement {
  // Los árboles se pintan aparte (se pueden talar); aquí solo su sombra en el suelo.
  const drawTrees = opts.trees;
  const g = L.grid;
  const S = TERRAIN_SCALE;
  const W = Math.round(g.w * 64 * S);
  const c = document.createElement('canvas');
  c.width = W; c.height = W;
  const x = c.getContext('2d')!;
  const wx = (v: number) => (v - g.ox) * S;
  const cell = 64 * S;

  // Suelo de necrópolis: piedra violácea con manchas de musgo.
  x.fillStyle = '#3b3442';
  x.fillRect(0, 0, W, W);
  for (let cy = 0; cy < g.h; cy++) for (let cx = 0; cx < g.w; cx++) {
    const h = hash(cx, cy);
    const moss = hash(cx >> 2, cy >> 2);
    x.fillStyle = moss > 0.55 ? `hsl(${95 + h * 20} 18% ${22 + h * 6}%)` : `hsl(${270 + h * 20} 9% ${23 + h * 6}%)`;
    x.fillRect(cx * cell, cy * cell, cell + 0.5, cell + 0.5);
  }
  x.filter = 'blur(6px)';
  x.drawImage(c, 0, 0);
  x.filter = 'none';

  // Caminos: anillo y radios de tierra clara.
  x.lineCap = 'round';
  x.strokeStyle = '#6b5a48';
  x.lineWidth = 300 * S;
  for (const f of L.fountains) { x.beginPath(); x.moveTo(wx(0), wx(0)); x.lineTo(wx(f.x), wx(f.y)); x.stroke(); }
  x.beginPath(); x.arc(wx(0), wx(0), L.ringR * S, 0, Math.PI * 2); x.stroke();
  x.strokeStyle = '#7b6852';
  x.lineWidth = 170 * S;
  for (const f of L.fountains) { x.beginPath(); x.moveTo(wx(0), wx(0)); x.lineTo(wx(f.x), wx(f.y)); x.stroke(); }
  x.beginPath(); x.arc(wx(0), wx(0), L.ringR * S, 0, Math.PI * 2); x.stroke();

  // Plaza del trono: losas doradas en anillos.
  const plaza = x.createRadialGradient(wx(0), wx(0), 0, wx(0), wx(0), L.plaza * S);
  plaza.addColorStop(0, '#8a6a3a');
  plaza.addColorStop(0.7, '#5e4a33');
  plaza.addColorStop(1, '#5e4a3300');
  x.fillStyle = plaza;
  x.beginPath(); x.arc(wx(0), wx(0), L.plaza * S, 0, Math.PI * 2); x.fill();
  x.strokeStyle = '#c99a4a55';
  x.lineWidth = 2;
  for (let r = 160; r < L.plaza; r += 130) { x.beginPath(); x.arc(wx(0), wx(0), r * S, 0, Math.PI * 2); x.stroke(); }
  x.strokeStyle = '#e0a84a88';
  x.setLineDash([8, 6]);
  x.beginPath(); x.arc(wx(0), wx(0), 650 * S, 0, Math.PI * 2); x.stroke();
  x.setLineDash([]);

  // Bases con el color de su equipo.
  L.fountains.forEach((f, i) => {
    const col = opts.teamColors[i] ?? '#888';
    const gr = x.createRadialGradient(wx(f.x), wx(f.y), 0, wx(f.x), wx(f.y), 560 * S);
    gr.addColorStop(0, col + '66');
    gr.addColorStop(0.75, col + '22');
    gr.addColorStop(1, col + '00');
    x.fillStyle = gr;
    x.beginPath(); x.arc(wx(f.x), wx(f.y), 560 * S, 0, Math.PI * 2); x.fill();
  });
  for (const cp of L.camps) {
    x.fillStyle = '#2a2219aa';
    x.beginPath(); x.arc(wx(cp.x), wx(cp.y), 170 * S, 0, Math.PI * 2); x.fill();
  }

  // Roca y árboles: la roca se pinta aparte y se difumina para que no salgan cuadros.
  const rock = document.createElement('canvas');
  rock.width = rock.height = W;
  const rx = rock.getContext('2d')!;
  for (let cy = 0; cy < g.h; cy++) for (let cx = 0; cx < g.w; cx++) {
    const t = g.cells[cy * g.w + cx];
    if (t === FREE) continue;
    const px = cx * cell, py = cy * cell;
    if (t === ROCK) {
      const h = hash(cx + 7, cy + 3);
      rx.fillStyle = `hsl(260 9% ${12 + h * 8}%)`;
      rx.beginPath(); rx.arc(px + cell / 2, py + cell / 2, cell * 0.85, 0, Math.PI * 2); rx.fill();
    } else if (t === TREE) {
      x.fillStyle = '#1b2a1c88';
      x.beginPath(); x.arc(px + cell / 2, py + cell / 2, cell * 0.7, 0, Math.PI * 2); x.fill();
    }
  }
  x.filter = 'blur(3px)';
  x.drawImage(rock, 0, 0);
  x.filter = 'none';
  x.globalAlpha = 0.5;
  x.drawImage(rock, 0, 0);
  x.globalAlpha = 1;
  // Bordes de roca suavizados.
  x.globalCompositeOperation = 'source-over';
  if (drawTrees) {
    for (let cy = 0; cy < g.h; cy++) for (let cx = 0; cx < g.w; cx++) {
      if (g.cells[cy * g.w + cx] !== TREE) continue;
      const h = hash(cx, cy + 11);
      const px = (cx + 0.5) * cell + (h - 0.5) * cell * 0.5, py = (cy + 0.5) * cell + (hash(cy, cx) - 0.5) * cell * 0.5;
      const r = cell * (0.62 + h * 0.3);
      const gr = x.createRadialGradient(px - r * 0.3, py - r * 0.3, r * 0.1, px, py, r);
      gr.addColorStop(0, `hsl(${100 + h * 30} 32% 34%)`);
      gr.addColorStop(1, `hsl(${110 + h * 20} 40% 13%)`);
      x.fillStyle = '#0006';
      x.beginPath(); x.arc(px + r * 0.25, py + r * 0.3, r, 0, Math.PI * 2); x.fill();
      x.fillStyle = gr;
      x.beginPath(); x.arc(px, py, r, 0, Math.PI * 2); x.fill();
    }
  }
  // Viñeta fuera del círculo jugable.
  const v = x.createRadialGradient(wx(0), wx(0), L.outer * S * 0.92, wx(0), wx(0), L.outer * S * 1.15);
  v.addColorStop(0, '#0000');
  v.addColorStop(1, '#000c');
  x.fillStyle = v;
  x.fillRect(0, 0, W, W);
  return c;
}

/** Niebla de guerra: oscuro en todo el mapa salvo donde ve el propio equipo (los árboles tapan). */
export class Fog {
  readonly canvas = document.createElement('canvas');
  private x: CanvasRenderingContext2D;
  readonly scale: number;
  readonly ox: number;
  private grid: MapLayout['grid'];

  constructor(L: MapLayout) {
    const size = L.grid.w * 64;
    this.scale = 1 / 24;
    this.ox = L.grid.ox;
    this.grid = L.grid;
    this.canvas.width = this.canvas.height = Math.round(size * this.scale);
    this.x = this.canvas.getContext('2d')!;
  }

  /** Polígono de visión lanzando rayos que se paran en árboles y roca. */
  private sightPolygon(ex: number, ey: number, r: number): [number, number][] {
    const g = this.grid;
    const rays = 96, step = 32;
    const pts: [number, number][] = [];
    for (let i = 0; i < rays; i++) {
      const a = (i / rays) * Math.PI * 2;
      const dx = Math.cos(a), dy = Math.sin(a);
      let d = 0;
      while (d < r) {
        const nd = d + step;
        const c = g.cellAt(g.cx(ex + dx * nd), g.cy(ey + dy * nd));
        if ((c === TREE || c === ROCK) && nd > 40) { d = nd + 20; break; }
        d = nd;
      }
      d = Math.min(d, r);
      pts.push([ex + dx * d, ey + dy * d]);
    }
    return pts;
  }

  update(eyes: { x: number; y: number; v: number; flying?: boolean }[], night: boolean, extra: { x: number; y: number; r: number }[] = []) {
    const x = this.x, s = this.scale;
    x.globalCompositeOperation = 'source-over';
    x.clearRect(0, 0, this.canvas.width, this.canvas.height);
    x.fillStyle = night ? 'rgba(4,4,16,0.74)' : 'rgba(8,6,14,0.6)';
    x.fillRect(0, 0, this.canvas.width, this.canvas.height);
    x.globalCompositeOperation = 'destination-out';
    x.fillStyle = 'rgba(0,0,0,1)';
    const P = (wx: number, wy: number): [number, number] => [(wx - this.ox) * s, (wy - this.ox) * s];
    for (const e of eyes) {
      if (e.flying) { const [cx, cy] = P(e.x, e.y); x.beginPath(); x.arc(cx, cy, e.v * s, 0, Math.PI * 2); x.fill(); continue; }
      const poly = this.sightPolygon(e.x, e.y, e.v);
      x.beginPath();
      poly.forEach(([px, py], i) => { const [cx, cy] = P(px, py); if (i) x.lineTo(cx, cy); else x.moveTo(cx, cy); });
      x.closePath(); x.fill();
    }
    for (const v of extra) { const [cx, cy] = P(v.x, v.y); x.beginPath(); x.arc(cx, cy, v.r * s, 0, Math.PI * 2); x.fill(); }
  }
}

/** Sprites de copa de árbol para el modo 2D (4 variantes). */
export function treeSprites(): HTMLCanvasElement[] {
  return [0, 1, 2, 3].map((k) => {
    const c = document.createElement('canvas');
    c.width = c.height = 96;
    const x = c.getContext('2d')!;
    const r = 30 + k * 3;
    x.fillStyle = '#0006';
    x.beginPath(); x.arc(56, 58, r, 0, Math.PI * 2); x.fill();
    const gr = x.createRadialGradient(40, 38, 4, 48, 48, r);
    gr.addColorStop(0, `hsl(${100 + k * 8} 34% 36%)`);
    gr.addColorStop(1, `hsl(${112 + k * 5} 42% 13%)`);
    x.fillStyle = gr;
    x.beginPath(); x.arc(48, 48, r, 0, Math.PI * 2); x.fill();
    return c;
  });
}
