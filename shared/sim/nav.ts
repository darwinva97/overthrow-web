// Cuadrícula de navegación: celdas libres, roca y árboles. A* con 8 vecinos y
// suavizado de ruta por línea de visión.

export const CELL = 64;
export const FREE = 0, ROCK = 1, TREE = 2;

export class Grid {
  readonly w: number;
  readonly h: number;
  /** Origen en unidades de mundo de la celda (0,0). */
  readonly ox: number;
  readonly oy: number;
  readonly cells: Uint8Array;
  /** Árboles talados: índice → instante en que vuelven a crecer. */
  readonly felled = new Map<number, number>();
  version = 0;

  constructor(w: number, h: number, ox: number, oy: number, cells?: Uint8Array) {
    this.w = w; this.h = h; this.ox = ox; this.oy = oy;
    this.cells = cells ?? new Uint8Array(w * h);
  }

  cx(x: number) { return Math.floor((x - this.ox) / CELL); }
  cy(y: number) { return Math.floor((y - this.oy) / CELL); }
  centerX(cx: number) { return this.ox + (cx + 0.5) * CELL; }
  centerY(cy: number) { return this.oy + (cy + 0.5) * CELL; }

  cellAt(cx: number, cy: number): number {
    if (cx < 0 || cy < 0 || cx >= this.w || cy >= this.h) return ROCK;
    return this.cells[cy * this.w + cx];
  }
  walkableCell(cx: number, cy: number) { return this.cellAt(cx, cy) === FREE; }
  walkable(x: number, y: number) { return this.walkableCell(this.cx(x), this.cy(y)); }

  cutTree(cx: number, cy: number, now: number, regrow = 180) {
    const i = cy * this.w + cx;
    if (this.cells[i] !== TREE) return false;
    this.cells[i] = FREE;
    this.felled.set(i, now + regrow);
    this.version++;
    return true;
  }

  /** Vuelve a plantar los árboles cuyo tiempo ha pasado. Devuelve si cambió algo. */
  regrow(now: number): boolean {
    let changed = false;
    for (const [i, t] of this.felled) {
      if (t <= now) { this.cells[i] = TREE; this.felled.delete(i); changed = true; }
    }
    if (changed) this.version++;
    return changed;
  }

  /** Celda libre más cercana a (x,y), buscando en anillos. */
  nearestFree(x: number, y: number): { x: number; y: number } {
    const cx = this.cx(x), cy = this.cy(y);
    if (this.walkableCell(cx, cy)) return { x, y };
    for (let r = 1; r < 40; r++) {
      let best: [number, number] | null = null, bd = Infinity;
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        if (!this.walkableCell(cx + dx, cy + dy)) continue;
        const d = dx * dx + dy * dy;
        if (d < bd) { bd = d; best = [cx + dx, cy + dy]; }
      }
      if (best) return { x: this.centerX(best[0]), y: this.centerY(best[1]) };
    }
    return { x, y };
  }

  /** Recorre las celdas atravesadas por el segmento; false si alguna está bloqueada. */
  lineFree(x0: number, y0: number, x1: number, y1: number): boolean {
    const dist = Math.hypot(x1 - x0, y1 - y0);
    const steps = Math.ceil(dist / (CELL / 3));
    for (let i = 0; i <= steps; i++) {
      const t = steps === 0 ? 0 : i / steps;
      if (!this.walkable(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t)) return false;
    }
    return true;
  }

  /** Línea de visión: árboles y roca la cortan (salvo en la celda de destino). */
  sightClear(x0: number, y0: number, x1: number, y1: number): boolean {
    const dist = Math.hypot(x1 - x0, y1 - y0);
    const steps = Math.floor((dist - 40) / 32);
    for (let i = 1; i <= steps; i++) {
      const t = (i * 32) / dist;
      const c = this.cellAt(this.cx(x0 + (x1 - x0) * t), this.cy(y0 + (y1 - y0) * t));
      if (c === TREE || c === ROCK) return false;
    }
    return true;
  }

  /** Índices de celdas taladas ahora mismo (para mandarlas a los clientes). */
  felledList(): number[] { return [...this.felled.keys()]; }

  /** Ruta de (sx,sy) a (tx,ty) como lista de puntos; vacía si no hay camino. */
  findPath(sx: number, sy: number, tx: number, ty: number): { x: number; y: number }[] {
    if (this.lineFree(sx, sy, tx, ty)) return [{ x: tx, y: ty }];
    const start = this.nearestFree(sx, sy);
    const goal = this.nearestFree(tx, ty);
    const scx = this.cx(start.x), scy = this.cy(start.y);
    const gcx = this.cx(goal.x), gcy = this.cy(goal.y);
    const W = this.w, N = W * this.h;
    const g = new Float32Array(N).fill(Infinity);
    const from = new Int32Array(N).fill(-1);
    const closed = new Uint8Array(N);
    const heap = new MinHeap();
    const si = scy * W + scx, gi = gcy * W + gcx;
    g[si] = 0;
    heap.push(si, 0);
    const h = (i: number) => {
      const dx = Math.abs((i % W) - gcx), dy = Math.abs(((i / W) | 0) - gcy);
      return Math.max(dx, dy) + 0.414 * Math.min(dx, dy);
    };
    let found = false, iter = 0;
    while (heap.size && iter++ < 20000) {
      const i = heap.pop();
      if (i === gi) { found = true; break; }
      if (closed[i]) continue;
      closed[i] = 1;
      const x = i % W, y = (i / W) | 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = x + dx, ny = y + dy;
        if (!this.walkableCell(nx, ny)) continue;
        // Sin cortar esquinas en diagonal.
        if (dx && dy && (!this.walkableCell(x + dx, y) || !this.walkableCell(x, y + dy))) continue;
        const ni = ny * W + nx;
        const ng = g[i] + (dx && dy ? 1.414 : 1);
        if (ng < g[ni]) { g[ni] = ng; from[ni] = i; heap.push(ni, ng + h(ni)); }
      }
    }
    if (!found) return [];
    const cellsPath: { x: number; y: number }[] = [];
    for (let i = gi; i !== -1 && i !== si; i = from[i]) {
      cellsPath.push({ x: this.centerX(i % W), y: this.centerY((i / W) | 0) });
    }
    cellsPath.reverse();
    if (cellsPath.length) cellsPath[cellsPath.length - 1] = goal;
    else cellsPath.push(goal);
    // Suavizado: salta a la última celda visible en línea recta.
    const out: { x: number; y: number }[] = [];
    let cx = sx, cy = sy, k = 0;
    while (k < cellsPath.length) {
      let far = k;
      for (let j = cellsPath.length - 1; j > k; j--) {
        if (this.lineFree(cx, cy, cellsPath[j].x, cellsPath[j].y)) { far = j; break; }
      }
      out.push(cellsPath[far]);
      cx = cellsPath[far].x; cy = cellsPath[far].y;
      k = far + 1;
    }
    return out;
  }
}

class MinHeap {
  private ids: number[] = [];
  private pr: number[] = [];
  get size() { return this.ids.length; }
  push(id: number, p: number) {
    const a = this.ids, b = this.pr;
    a.push(id); b.push(p);
    let i = a.length - 1;
    while (i > 0) {
      const par = (i - 1) >> 1;
      if (b[par] <= b[i]) break;
      [a[par], a[i]] = [a[i], a[par]]; [b[par], b[i]] = [b[i], b[par]];
      i = par;
    }
  }
  pop(): number {
    const a = this.ids, b = this.pr;
    const top = a[0];
    const lastId = a.pop()!, lastP = b.pop()!;
    if (a.length) {
      a[0] = lastId; b[0] = lastP;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && b[l] < b[m]) m = l;
        if (r < a.length && b[r] < b[m]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]]; [b[m], b[i]] = [b[i], b[m]];
        i = m;
      }
    }
    return top;
  }
}
