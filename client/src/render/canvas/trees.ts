// Árboles del modo 2D por bloques: el mapa se parte en bloques de N×N celdas y cada bloque se
// pinta una vez (a la resolución de pantalla actual) con todos sus árboles y rocas nuevas.
// En cada frame solo se copian los bloques visibles. Talar o crear rocas invalida los bloques
// afectados, que se repintan poco a poco (unos pocos por frame) mientras se dibujan árbol a árbol.
import type { MapLayout } from '../../../../shared/maps';
import { ROCK, TREE } from '../../../../shared/sim/nav';
import { cache, makeSprite, spriteGen, spriteRes, type Sprite } from './sprites';

const CELL = 64;
/** Mitad del lado del sprite de árbol y desplazamiento máximo dentro de su celda. */
const HALF = 58, JIT = 12;
const VARIANTS = 6;
/** Bloques nuevos que se pintan como mucho en un frame. */
const BUILDS_PER_FRAME = 4;

interface Block { c: HTMLCanvasElement | null; used: number }

function hash(cx: number, cy: number) { return ((cx * 73856093) ^ (cy * 19349663)) >>> 0; }

const treeCache = cache<number, Sprite>();
/** Copa de árbol vista desde arriba: racimos de hojas con luz desde arriba a la izquierda. */
function treeSprite(k: number): Sprite {
  let s = treeCache.get(k);
  if (s) return s;
  s = makeSprite(-HALF, -HALF, HALF * 2, HALF * 2, (g) => {
    const r = 33 + (k % 3) * 3.5;
    const hue = [104, 118, 96, 130, 110, 88][k];
    // Sombra proyectada hacia abajo a la derecha.
    const sg = g.createRadialGradient(9, 11, r * 0.3, 9, 11, r * 1.15);
    sg.addColorStop(0, 'rgba(0,0,0,0.5)'); sg.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = sg; g.beginPath(); g.arc(9, 11, r * 1.15, 0, Math.PI * 2); g.fill();
    // Silueta oscura y racimos.
    g.fillStyle = `hsl(${hue} 42% 11%)`;
    g.beginPath(); g.arc(0, 0, r + 1.5, 0, Math.PI * 2); g.fill();
    const n = 6 + (k % 2);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + k * 0.7;
      const d = r * 0.5, cr = r * (0.5 + ((i * 7 + k) % 3) * 0.06);
      const x = Math.cos(a) * d, y = Math.sin(a) * d;
      g.fillStyle = `hsl(${hue} 42% 12%)`;
      g.beginPath(); g.arc(x, y, cr + 1.6, 0, Math.PI * 2); g.fill();
      const gr = g.createRadialGradient(x - cr * 0.4, y - cr * 0.45, cr * 0.1, x, y, cr);
      gr.addColorStop(0, `hsl(${hue - 6} 38% ${38 + (i % 2) * 4}%)`);
      gr.addColorStop(0.7, `hsl(${hue} 40% 22%)`);
      gr.addColorStop(1, `hsl(${hue + 6} 44% 14%)`);
      g.fillStyle = gr; g.beginPath(); g.arc(x, y, cr, 0, Math.PI * 2); g.fill();
    }
    const cg = g.createRadialGradient(-r * 0.25, -r * 0.3, r * 0.05, 0, 0, r * 0.62);
    cg.addColorStop(0, `hsl(${hue - 10} 40% 44%)`); cg.addColorStop(1, `hsl(${hue} 40% 22%)`);
    g.fillStyle = cg; g.beginPath(); g.arc(0, 0, r * 0.58, 0, Math.PI * 2); g.fill();
    // Brillos.
    g.fillStyle = `hsla(${hue - 20} 50% 70% / 0.18)`;
    g.beginPath(); g.arc(-r * 0.32, -r * 0.36, r * 0.22, 0, Math.PI * 2); g.fill();
  });
  treeCache.set(k, s);
  return s;
}

function rockSprite(): Sprite {
  let s = treeCache.get(-1);
  if (s) return s;
  s = makeSprite(-48, -48, 96, 96, (g) => {
    g.fillStyle = 'rgba(0,0,0,0.45)'; g.beginPath(); g.ellipse(6, 8, 40, 36, 0, 0, Math.PI * 2); g.fill();
    const gr = g.createLinearGradient(-30, -30, 30, 30);
    gr.addColorStop(0, '#8a8294'); gr.addColorStop(0.5, '#5a5262'); gr.addColorStop(1, '#2e2834');
    g.fillStyle = gr; g.strokeStyle = '#1e1a24'; g.lineWidth = 3; g.lineJoin = 'round';
    g.beginPath();
    const pts = [[-34, -8], [-20, -32], [8, -38], [32, -20], [38, 8], [22, 32], [-8, 36], [-32, 22]];
    for (const [x, y] of pts) g.lineTo(x, y);
    g.closePath(); g.fill(); g.stroke();
    g.strokeStyle = 'rgba(20,16,26,0.6)'; g.lineWidth = 2;
    g.beginPath(); g.moveTo(-14, -18); g.lineTo(2, -2); g.lineTo(-4, 18); g.moveTo(2, -2); g.lineTo(20, -6); g.stroke();
  });
  treeCache.set(-1, s);
  return s;
}

export class TreeLayer {
  private g: MapLayout['grid'];
  private blocks = new Map<number, Block>();
  private gen = -1;
  /** Celdas por lado de bloque a la resolución actual. */
  private bc = 8;
  private nbx = 1;
  private frame = 0;
  /** Rocas creadas en partida (Fissure…): la roca del mapa ya va en el suelo. */
  private rocks = new Set<number>();
  private prev = new Map<number, number>();
  private maxBlocks = 64;
  /** Estadísticas del último frame. */
  drawnBlocks = 0; directTrees = 0; built = 0;

  constructor(L: MapLayout) { this.g = L.grid; }

  /** Lista completa de celdas que difieren del mapa inicial (la cuadrícula ya está al día). */
  changed(list: [number, number][]) {
    const now = new Map<number, number>();
    for (const [i, v] of list) now.set(i, v);
    const touch = (i: number) => this.invalidateCell(i % this.g.w, Math.floor(i / this.g.w));
    for (const [i, v] of now) if (this.prev.get(i) !== v) touch(i);
    for (const i of this.prev.keys()) if (!now.has(i)) touch(i);
    this.prev = now;
    this.rocks.clear();
    for (const [i, v] of list) if (v === ROCK) this.rocks.add(i);
  }

  private invalidateCell(cx: number, cy: number) {
    const bc = this.bc;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const bx = Math.floor((cx + dx) / bc), by = Math.floor((cy + dy) / bc);
      if (bx >= 0 && by >= 0 && bx < this.nbx && by < this.nbx) this.blocks.delete(by * this.nbx + bx);
    }
  }

  /**
   * Dibuja los árboles del rectángulo de mundo visible. (m, ox, oy) es la transformación
   * mundo → píxel de dispositivo; al terminar deja el contexto con ella puesta.
   */
  draw(c: CanvasRenderingContext2D, m: number, ox: number, oy: number, x0: number, y0: number, x1: number, y1: number, screenPx: number) {
    this.frame++;
    const g = this.g;
    if (this.gen !== spriteGen()) {
      this.gen = spriteGen();
      this.blocks.clear();
      // Bloques de ~256-512 px de lado, sea cual sea el zoom.
      const r = spriteRes();
      this.bc = Math.max(4, Math.min(16, 2 ** Math.round(Math.log2(384 / (CELL * r)))));
      this.nbx = Math.ceil(g.w / this.bc);
      const side = this.bc * CELL * r;
      this.maxBlocks = Math.max(24, Math.ceil((screenPx * 4) / (side * side)));
    }
    const bc = this.bc, bw = bc * CELL, nbx = this.nbx;
    const bx0 = Math.max(0, Math.floor((x0 - g.ox) / bw)), bx1 = Math.min(nbx - 1, Math.floor((x1 - g.ox) / bw));
    const by0 = Math.max(0, Math.floor((y0 - g.oy) / bw)), by1 = Math.min(nbx - 1, Math.floor((y1 - g.oy) / bw));
    let builds = 0;
    this.drawnBlocks = 0; this.directTrees = 0; this.built = 0;
    c.setTransform(1, 0, 0, 1, 0, 0);
    for (let by = by0; by <= by1; by++) for (let bx = bx0; bx <= bx1; bx++) {
      const key = by * nbx + bx;
      let b = this.blocks.get(key);
      if (!b && builds < BUILDS_PER_FRAME) { b = this.build(bx, by); builds++; this.built++; }
      if (b) {
        b.used = this.frame;
        if (!b.c) continue;
        // Bordes redondeados al píxel: los bloques vecinos encajan sin costuras.
        const wx = g.ox + bx * bw, wy = g.oy + by * bw;
        const X0 = Math.round(m * wx + ox), X1 = Math.round(m * (wx + bw) + ox);
        const Y0 = Math.round(m * wy + oy), Y1 = Math.round(m * (wy + bw) + oy);
        c.drawImage(b.c, X0, Y0, X1 - X0, Y1 - Y0);
        this.drawnBlocks++;
      } else {
        c.setTransform(m, 0, 0, m, ox, oy);
        this.paintTrees(c, bx * bc, by * bc, bc, false);
        c.setTransform(1, 0, 0, 1, 0, 0);
      }
    }
    c.setTransform(m, 0, 0, m, ox, oy);
    if (this.blocks.size > this.maxBlocks) this.evict();
  }

  private build(bx: number, by: number): Block {
    const g = this.g, bc = this.bc, bw = bc * CELL, r = spriteRes();
    const cx0 = bx * bc, cy0 = by * bc;
    let any = false;
    for (let cy = Math.max(0, cy0 - 1); cy <= Math.min(g.h - 1, cy0 + bc) && !any; cy++)
      for (let cx = Math.max(0, cx0 - 1); cx <= Math.min(g.w - 1, cx0 + bc); cx++) {
        const i = cy * g.w + cx;
        if (g.cells[i] === TREE || this.rocks.has(i)) { any = true; break; }
      }
    let canvas: HTMLCanvasElement | null = null;
    if (any) {
      canvas = document.createElement('canvas');
      canvas.width = canvas.height = Math.max(1, Math.round(bw * r));
      const x = canvas.getContext('2d')!;
      const k = canvas.width / bw;
      x.setTransform(k, 0, 0, k, -(g.ox + cx0 * CELL) * k, -(g.oy + cy0 * CELL) * k);
      this.paintTrees(x, cx0, cy0, bc, true);
    }
    const b = { c: canvas, used: this.frame };
    this.blocks.set(by * this.nbx + bx, b);
    return b;
  }

  /**
   * Pinta los árboles cuyo sprite toca el bloque de celdas [cx0, cx0+n). En orden global
   * por filas, así los árboles que asoman a dos bloques quedan igual en los dos.
   */
  private paintTrees(x: CanvasRenderingContext2D, cx0: number, cy0: number, n: number, overlap: boolean) {
    const g = this.g;
    const e = overlap ? 1 : 0;
    const ya = Math.max(0, cy0 - e), yb = Math.min(g.h - 1, cy0 + n - 1 + e);
    const xa = Math.max(0, cx0 - e), xb = Math.min(g.w - 1, cx0 + n - 1 + e);
    for (let cy = ya; cy <= yb; cy++) for (let cx = xa; cx <= xb; cx++) {
      const i = cy * g.w + cx;
      const t = g.cells[i];
      if (t === TREE) {
        const h = hash(cx, cy);
        const s = treeSprite(h % VARIANTS);
        const jx = ((h % 100) / 100 - 0.5) * JIT * 2, jy = (((h >> 8) % 100) / 100 - 0.5) * JIT * 2;
        x.drawImage(s.c, g.centerX(cx) + jx + s.x, g.centerY(cy) + jy + s.y, s.w, s.h);
        this.directTrees += overlap ? 0 : 1;
      } else if (t === ROCK && this.rocks.has(i)) {
        const s = rockSprite();
        x.drawImage(s.c, g.centerX(cx) + s.x, g.centerY(cy) + s.y, s.w, s.h);
      }
    }
  }

  private evict() {
    // Se quitan los bloques menos usados hasta volver al límite (solo cuando se pasa).
    const list: [number, number][] = [];
    this.blocks.forEach((b, k) => list.push([b.used, k]));
    list.sort((a, b) => a[0] - b[0]);
    for (let i = 0; i < list.length - this.maxBlocks; i++) this.blocks.delete(list[i][1]);
  }
}

export { HALF as TREE_HALF };
