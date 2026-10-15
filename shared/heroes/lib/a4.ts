// Ayudas compartidas de la tanda A4 (Invoker, Kez, Kunkka, Largo, Legion, Leshrac, Lich,
// Lifestealer, Lone Druid, Lycan, Magnus, Marci, Mars).
import type { AbilityInst, ModSpec } from '../../sim/types';
import { ST } from '../../sim/types';
import type { Unit } from '../../sim/unit';

/** Se puede lanzar ahora mismo (enfriamiento, maná, silencio…). */
export const ready = (a: AbilityInst) => !(a.owner as Unit).w.castCheck(a.owner as Unit, a);

/** Héroe real detrás de una ilusión o invocación. */
export function heroOf(u: Unit): Unit {
  let c: Unit = u;
  for (let i = 0; i < 4 && c.kind !== 'hero' && c.owner; i++) c = c.owner as Unit;
  return c;
}

/** Objetivo actual del bot (o de la orden de ataque del jugador). */
export function currentTarget(u: Unit): Unit | null {
  const w = u.w;
  const id = u.order?.type === 'attack' ? u.order.target : (u.ai?.target ?? u.atk.target);
  const t = id ? w.units.get(id) : undefined;
  return t && t.alive && t.team !== u.team && w.targetable(t) ? t : null;
}

/** Enemigo héroe visible más cercano dentro de `r`. */
export function nearestEnemyHero(u: Unit, r: number): Unit | null {
  let best: Unit | null = null, bd = Infinity;
  for (const e of u.w.enemiesIn(u.team, u.x, u.y, r, { heroes: true })) {
    if (!u.w.canSee(u.team, e)) continue;
    const d = Math.hypot(e.x - u.x, e.y - u.y);
    if (d < bd) { bd = d; best = e; }
  }
  return best;
}

/**
 * IA propia para habilidades que la IA genérica no sabe usar (objetivo aliado, combos…).
 * Se añade como `passive` de la propia habilidad: cada `every` segundos, si el dueño es un bot
 * y la habilidad está lista, `think` puede devolver una orden de lanzamiento.
 */
export function botBrain(a: AbilityInst, think: (u: Unit, a: AbilityInst) => { target?: Unit; x?: number; y?: number } | null,
  every = 0.3, name = 'bot_brain_' + a.key): ModSpec {
  return {
    name,
    onTick(m, dt) {
      const u = m.owner as Unit;
      m.data.t = (m.data.t ?? 0) - dt;
      if (m.data.t > 0) return;
      m.data.t = every;
      if (!u.isBot || !u.alive || u.cast || u.kind !== 'hero' || !ready(a)) return;
      const o = think(u, a);
      if (!o) return;
      u.w.issueOrder(u, { type: 'cast', slot: a.slot, target: o.target?.id, x: o.target ? undefined : o.x, y: o.target ? undefined : o.y });
    },
  };
}

/** Aliado héroe (o uno mismo) más herido en el radio, por debajo de `below` de vida. */
export function hurtAlly(u: Unit, r: number, below = 0.7, self = true): Unit | null {
  let best: Unit | null = null, bp = below;
  for (const al of u.w.alliesIn(u.team, u.x, u.y, r, { heroes: true })) {
    if (!self && al === u) continue;
    const p = al.hp / al.s.maxHp;
    if (p < bp) { bp = p; best = al; }
  }
  return best;
}

/**
 * Invocación de un bot: ataca al objetivo de su dueño o le sigue si se aleja. A los jugadores
 * no se les tocan las órdenes.
 */
export function summonFollow(s: Unit, leash = 900): ModSpec {
  return {
    name: 'summon_follow', persistent: true,
    onTick(m, dt) {
      m.data.t = (m.data.t ?? 0) - dt;
      if (m.data.t > 0) return;
      m.data.t = 0.4;
      const o = s.owner as Unit | null;
      if (!o || !s.alive || !o.isBot || s.has(ST.busy)) return;
      const t = o.alive ? currentTarget(o) : null;
      const w = s.w;
      if (t && Math.hypot(t.x - s.x, t.y - s.y) < 1400) {
        if (s.order?.type !== 'attack' || s.order.target !== t.id) w.issueOrder(s, { type: 'attack', target: t.id });
        return;
      }
      if (o.alive && Math.hypot(o.x - s.x, o.y - s.y) > leash && s.order?.type !== 'move') {
        w.issueOrder(s, { type: 'move', x: o.x + (w.rng() - 0.5) * 200, y: o.y + (w.rng() - 0.5) * 200 });
      }
    },
  };
}

/** Distancia de un punto a un segmento (para muros y barridos). */
export function distToSegment(px: number, py: number, x1: number, y1: number, x2: number, y2: number) {
  const dx = x2 - x1, dy = y2 - y1;
  const l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / l2)) : 0;
  return Math.hypot(px - (x1 + dx * t), py - (y1 + dy * t));
}

/** ¿Está (px,py) dentro del cono que sale de (x,y) en dirección (dx,dy)? */
export function inCone(x: number, y: number, dx: number, dy: number, px: number, py: number, range: number, halfAngleDeg: number) {
  const vx = px - x, vy = py - y;
  const d = Math.hypot(vx, vy);
  if (d > range) return false;
  if (d < 1) return true;
  const cos = (vx * dx + vy * dy) / d / (Math.hypot(dx, dy) || 1);
  return cos >= Math.cos(halfAngleDeg * Math.PI / 180);
}

/** Barrido en trapecio (cleave de Dota): ancho inicial → final a lo largo de `dist`. */
export function inTrapezoid(x: number, y: number, dx: number, dy: number, px: number, py: number,
  startW: number, endW: number, dist: number) {
  const l = Math.hypot(dx, dy) || 1;
  const nx = dx / l, ny = dy / l;
  const vx = px - x, vy = py - y;
  const along = vx * nx + vy * ny;
  if (along < 0 || along > dist) return false;
  const side = Math.abs(-vx * ny + vy * nx);
  return side <= (startW + (endW - startW) * (along / dist)) / 2;
}
