// Ayudas compartidas por los héroes de la tanda A5 (miedo, barreras, sub-habilidades condicionadas…).
import { val } from '../../sim/abilities';
import type { AbilityInst, ModSpec, Modifier } from '../../sim/types';
import { ST } from '../../sim/types';
import type { Unit } from '../../sim/unit';
import { debuff, type Src } from '../util';

/**
 * Miedo: la unidad huye del punto (x, y) sin poder atacar ni lanzar nada.
 * El motor no tiene estado de miedo; se simula con busy + desarme + silencio y movimiento forzado.
 */
export function fear(caster: Unit, t: Unit, duration: number, a: Src, x: number, y: number, name = 'fear') {
  const m = debuff(caster, t, a, {
    name, duration, fx: 'fear',
    states: ST.busy | ST.disarmed | ST.silenced | ST.muted,
    onTick(mm, dt) {
      const u = mm.owner as Unit;
      if (u.has(ST.stunned) || u.has(ST.rooted)) return;
      let dx = u.x - x, dy = u.y - y;
      const d = Math.hypot(dx, dy) || 1;
      dx /= d; dy /= d;
      u.facing = Math.atan2(dy, dx);
      u.w.forceMove(u, u.x + dx * u.s.ms * dt, u.y + dy * u.s.ms * dt);
    },
  });
  if (m) { t.order = null; t.atk.phase = 0; if (t.cast) t.w.interruptCast(t, true); }
  return m;
}

/** Barrera contra todo tipo de daño (Objurgation…). */
export function barrierSpec(name: string, duration: number, amount: number, extra: Partial<ModSpec> = {}): ModSpec {
  return {
    name, duration, fx: 'barrier',
    ...extra,
    data: { left: amount, ...(extra.data ?? {}) },
    onIncomingDamage(m, ev) {
      if (ev.hpRemoval) return;
      const take = Math.min(m.data.left, ev.amount);
      m.data.left -= take; ev.amount -= take;
      if (m.data.left <= 0) m.remaining = 0.001;
    },
  };
}

/**
 * Sub-habilidad que solo se puede lanzar en ciertas condiciones (Primal Spring en el árbol, Untransform…):
 * mientras `ok` sea falso mantiene la habilidad en enfriamiento, así ni bots ni jugadores la lanzan.
 */
export function gate(ok: (a: AbilityInst) => boolean) {
  return (a: AbilityInst): ModSpec => ({
    name: 'gate_' + a.key,
    onTick() { if (!ok(a)) a.cd = Math.max(a.cd, 0.1); },
  });
}

/** Héroe real detrás de una ilusión o un clon. */
export function realHero(u: Unit): Unit {
  let c = u;
  for (let i = 0; i < 3 && c.kind !== 'hero' && c.owner; i++) c = c.owner as Unit;
  return c;
}

/** Número de veces que se repite un hechizo de Ogre (Multicast). */
export function multicastTimes(u: Unit): number {
  const hero = realHero(u);
  const mc = hero.abilities.find((x) => x.key === 'ogre_magi_multicast');
  if (!mc || mc.level <= 0) return 1;
  const bonus = hero.s.str / val(mc, 'strength_for_one_pct');
  const r = u.w.rng() * 100;
  const c4 = val(mc, 'multicast_4_times'), c3 = val(mc, 'multicast_3_times'), c2 = val(mc, 'multicast_2_times');
  if (c4 > 0 && r < c4 + bonus) return 4;
  if (c3 > 0 && u.w.rng() * 100 < c3 + bonus) return 3;
  if (c2 > 0 && u.w.rng() * 100 < c2 + bonus) return 2;
  return 1;
}

/** Recalcula un modificador apilable (stacks) y los stats. */
export function setStacks(m: Modifier, n: number) {
  m.stacks = n;
  (m.owner as Unit).refreshStats();
}

/** Distancia de un punto a un segmento (para golpes en línea). */
export function distToSegment(px: number, py: number, x1: number, y1: number, x2: number, y2: number) {
  const dx = x2 - x1, dy = y2 - y1;
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - x1) * dx + (py - y1) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

/** Enemigos dentro de una línea (ancho total `width`). */
export function enemiesInLine(u: Unit, x1: number, y1: number, x2: number, y2: number, width: number) {
  const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2;
  const r = Math.hypot(x2 - x1, y2 - y1) / 2 + width;
  return u.w.enemiesIn(u.team, cx, cy, r).filter((e) => distToSegment(e.x, e.y, x1, y1, x2, y2) <= width / 2 + e.radius);
}
