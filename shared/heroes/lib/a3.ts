// Ayudas compartidas por los héroes de la tanda A3.
import { CELL, FREE, ROCK, TREE } from '../../sim/nav';
import type { AbilityInst, ModSpec } from '../../sim/types';
import { ST } from '../../sim/types';
import type { Unit } from '../../sim/unit';
import type { World } from '../../sim/world';

/**
 * Pasiva de apoyo para los bots: la IA genérica solo sabe lanzar sobre enemigos, así que
 * los hechizos sobre aliados (o con lógica especial) se disparan desde aquí.
 * `pick` devuelve el objetivo (unidad o punto) o null si no toca lanzar.
 */
export function botCast(a: AbilityInst, pick: (u: Unit) => Unit | { x: number; y: number } | null | undefined,
  every = 0.4, name = 'bot_cast_' + a.key): ModSpec {
  return {
    name, interval: every,
    onInterval(m) {
      const u = m.owner as Unit;
      if (!u.isBot || !u.alive || u.cast || u.kind !== 'hero') return;
      if (u.w.castCheck(u, a)) return;
      const t = pick(u);
      if (!t) return;
      if ('id' in t) u.w.issueOrder(u, { type: 'cast', slot: a.slot, target: (t as Unit).id });
      else u.w.issueOrder(u, { type: 'cast', slot: a.slot, x: t.x, y: t.y });
    },
  };
}

/** Héroe enemigo visible más cercano dentro de `r` (para las decisiones de los bots). */
export function nearestEnemyHero(u: Unit, r: number): Unit | null {
  let best: Unit | null = null, bd = Infinity;
  for (const e of u.w.enemiesIn(u.team, u.x, u.y, r, { heroes: true })) {
    if (e.kind !== 'hero' || !u.w.canSee(u.team, e)) continue;
    const d = Math.hypot(e.x - u.x, e.y - u.y);
    if (d < bd) { bd = d; best = e; }
  }
  return best;
}

/** Aliado héroe (incluido uno mismo) con menos vida en el radio. */
export function weakestAlly(u: Unit, r: number): Unit | null {
  let best: Unit | null = null, bp = Infinity;
  for (const al of u.w.alliesIn(u.team, u.x, u.y, r, { heroes: true })) {
    if (al.kind !== 'hero') continue;
    const p = al.hp / al.s.maxHp;
    if (p < bp) { bp = p; best = al; }
  }
  return best;
}

/** Las invocaciones de un bot atacan a lo que ataca su dueño (o al enemigo más cercano). */
export function botCommand(owner: Unit, units: Unit[]) {
  if (!owner.isBot) return;
  const w = owner.w;
  const tid = owner.ai?.target;
  const t = tid ? w.units.get(tid) : null;
  for (const s of units) {
    if (!s.alive || s.order) continue;
    if (t && t.alive && w.targetable(t) && Math.hypot(t.x - s.x, t.y - s.y) < 1600) w.issueOrder(s, { type: 'attack', target: t.id });
    else w.issueOrder(s, { type: 'attackMove', x: owner.x, y: owner.y });
  }
}

/** Unidades vivas invocadas por `owner` con ese nombre. */
export function summonsOf(owner: Unit, name: string): Unit[] {
  return owner.w.list.filter((s) => s.alive && s.owner === owner && s.name === name);
}

/**
 * Planta un árbol temporal en la celda de (x,y) si está libre y sin unidades encima.
 * Desaparece pasados `duration` segundos. Devuelve si lo ha plantado.
 */
export function plantTree(w: World, x: number, y: number, duration: number, avoidUnits = true): boolean {
  const g = w.grid;
  const cx = g.cx(x), cy = g.cy(y);
  if (g.cellAt(cx, cy) !== FREE) return false;
  const px = g.centerX(cx), py = g.centerY(cy);
  if (avoidUnits && w.list.some((u) => u.alive && !u.has(ST.hidden) && Math.abs(u.x - px) < CELL / 2 + u.radius * 0.5 &&
    Math.abs(u.y - py) < CELL / 2 + u.radius * 0.5)) return false;
  const i = cy * g.w + cx;
  g.cells[i] = TREE;
  g.version++;
  w.after(duration, () => {
    // Si alguien lo taló, también deja de contar para volver a crecer.
    g.felled.delete(i);
    if (g.cells[i] === TREE) g.cells[i] = FREE;
    g.version++;
  });
  return true;
}

/** Anillo de árboles alrededor de un punto (Sprout). */
export function plantRing(w: World, x: number, y: number, radius: number, duration: number): number {
  let n = 0;
  const steps = Math.max(8, Math.round((2 * Math.PI * radius) / (CELL * 0.8)));
  const done = new Set<string>();
  for (let i = 0; i < steps; i++) {
    const ang = (i / steps) * Math.PI * 2;
    const px = x + Math.cos(ang) * radius, py = y + Math.sin(ang) * radius;
    const k = `${w.grid.cx(px)},${w.grid.cy(py)}`;
    if (done.has(k)) continue;
    done.add(k);
    if (plantTree(w, px, py, duration, false)) n++;
  }
  return n;
}

/** Número de árboles en un radio. */
export function treesIn(w: World, x: number, y: number, r: number): number {
  const g = w.grid;
  let n = 0;
  const c0x = g.cx(x - r), c1x = g.cx(x + r), c0y = g.cy(y - r), c1y = g.cy(y + r);
  for (let cy = c0y; cy <= c1y; cy++) for (let cx = c0x; cx <= c1x; cx++) {
    if (g.cellAt(cx, cy) !== TREE) continue;
    if (Math.hypot(g.centerX(cx) - x, g.centerY(cy) - y) <= r + CELL / 2) n++;
  }
  return n;
}

/** Ángulo (rad) entre hacia dónde mira `v` y la dirección hacia (x,y). */
export function angleTo(v: Unit, x: number, y: number): number {
  const to = Math.atan2(y - v.y, x - v.x);
  let d = Math.abs(to - v.facing) % (Math.PI * 2);
  if (d > Math.PI) d = Math.PI * 2 - d;
  return d;
}

/** Distancia de un punto a un segmento. */
export function distToSegment(px: number, py: number, x0: number, y0: number, x1: number, y1: number): number {
  const dx = x1 - x0, dy = y1 - y0;
  const l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((px - x0) * dx + (py - y0) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x0 + dx * t), py - (y0 + dy * t));
}

/** Barrera que absorbe daño (todo, o solo de un tipo). Devuelve el ModSpec. */
export function barrier(name: string, amount: number, duration: number, type: 'any' | 'magical' | 'physical' = 'any',
  extra: Partial<ModSpec> = {}): ModSpec {
  return {
    name, duration, fx: 'barrier', data: { left: amount },
    onIncomingDamage(m, ev) {
      if (ev.hpRemoval || (type !== 'any' && ev.type !== type)) return;
      const take = Math.min(m.data.left, ev.amount);
      m.data.left -= take;
      ev.amount -= take;
      if (m.data.left <= 0) m.remaining = 0.001;
    },
    ...extra,
  };
}

/** Enemigos de un área respetando la inmunidad a hechizos según la habilidad. */
export function foes(u: Unit, x: number, y: number, r: number, a: AbilityInst | null, heroes = false): Unit[] {
  const pierce = !!a && a.def.bkbPierce;
  return u.w.enemiesIn(u.team, x, y, r, { heroes, immune: pierce ? undefined : false }).filter((e) => e.kind !== 'ward' || !heroes);
}

/**
 * Muro temporal infranqueable (Fissure) a lo largo de un segmento. Las unidades que queden
 * encima se apartan a la celda libre más cercana. Devuelve las celdas ocupadas.
 */
export function placeWall(w: World, x0: number, y0: number, x1: number, y1: number, duration: number): number[] {
  const g = w.grid;
  const len = Math.hypot(x1 - x0, y1 - y0);
  const steps = Math.max(1, Math.ceil(len / (CELL / 2)));
  const cells: number[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const cx = g.cx(x0 + (x1 - x0) * t), cy = g.cy(y0 + (y1 - y0) * t);
    if (g.cellAt(cx, cy) !== FREE) continue;
    const idx = cy * g.w + cx;
    if (cells.includes(idx)) continue;
    g.cells[idx] = ROCK;
    cells.push(idx);
  }
  g.version++;
  for (const u of w.list) if (u.alive && !g.walkable(u.x, u.y)) w.teleport(u, u.x, u.y);
  w.after(duration, () => {
    for (const i of cells) if (g.cells[i] === ROCK) g.cells[i] = FREE;
    g.version++;
  });
  return cells;
}
