// Piezas que comparten habilidades e items: aturdir, ralentizar, silenciar, empujar…
import { isItem } from '../sim/abilities';
import { damage as damageFn } from '../sim/combat';
import type { AbilityInst, ItemInst, ModSpec, Props } from '../sim/types';
import { ST } from '../sim/types';
import type { Unit } from '../sim/unit';

export type Src = AbilityInst | ItemInst | null;

/** Un efecto negativo de hechizo no afecta a enemigos con inmunidad a debuffs. */
export function canDebuff(caster: Unit, t: Unit, a: Src) {
  if (t.team === caster.team) return true;
  if (!t.has(ST.magicImmune)) return true;
  return !!a && !(a as ItemInst).isItem && (a as AbilityInst).def.bkbPierce;
}

export function debuff(caster: Unit, t: Unit, a: Src, spec: ModSpec) {
  if (!t.alive || !canDebuff(caster, t, a)) return null;
  return t.addMod({ debuff: true, ...spec }, caster, a);
}

export function stun(caster: Unit, t: Unit, duration: number, a: Src) {
  const m = debuff(caster, t, a, { name: 'stunned', duration, states: ST.stunned, fx: 'stun' });
  if (m) { t.atk.phase = 0; if (t.cast) t.w.interruptCast(t, true); }
  return m;
}

export function slow(caster: Unit, t: Unit, a: Src, name: string, duration: number, ms: number, as = 0, extra: Partial<Props> = {}) {
  return debuff(caster, t, a, {
    name, duration, fx: 'slow',
    props: { msSlow: Math.abs(ms), attackSlow: Math.abs(as), ...extra },
  });
}

export function silence(caster: Unit, t: Unit, duration: number, a: Src, name = 'silence') {
  return debuff(caster, t, a, { name, duration, states: ST.silenced, fx: 'silence' });
}

export function root(caster: Unit, t: Unit, duration: number, a: Src, name = 'root') {
  return debuff(caster, t, a, { name, duration, states: ST.rooted, fx: 'root' });
}

export function hex(caster: Unit, t: Unit, duration: number, a: Src, ms: number) {
  const m = debuff(caster, t, a, {
    name: 'hex', duration, fx: 'hex',
    states: ST.hexed | ST.silenced | ST.disarmed | ST.muted,
    props: { msFixed: ms },
  });
  if (m && t.cast) t.w.interruptCast(t, true);
  return m;
}

/** Empuje en línea recta durante `time` segundos (Force Staff, knockbacks). */
export function push(t: Unit, dx: number, dy: number, distance: number, time: number, caster: Unit | null, a: Src, name = 'pushed') {
  const len = Math.hypot(dx, dy) || 1;
  const nx = dx / len, ny = dy / len;
  const speed = distance / Math.max(0.01, time);
  return t.addMod({
    name, duration: time, states: ST.rooted | ST.disarmed, fx: 'push',
    onTick(m, dt) {
      const u = m.owner as Unit;
      u.w.forceMove(u, u.x + nx * speed * dt, u.y + ny * speed * dt);
    },
  }, caster, a);
}

/** Dirección de lanzamiento: hacia el punto, o hacia donde mira si es el mismo sitio. */
export function castDir(u: Unit, x: number, y: number): [number, number] {
  const dx = x - u.x, dy = y - u.y;
  const d = Math.hypot(dx, dy);
  if (d < 1) return [Math.cos(u.facing), Math.sin(u.facing)];
  return [dx / d, dy / d];
}

export const rand = (u: Unit) => u.w.rng();

/** Busca la unidad atacable más cercana en el radio (para rebotes y Omnislash). */
export function nearestEnemy(u: Unit, x: number, y: number, r: number, exclude: Set<number> = new Set(), heroesFirst = false) {
  const list = u.w.enemiesIn(u.team, x, y, r).filter((e) => !exclude.has(e.id) && e.kind !== 'ward');
  if (!list.length) return null;
  list.sort((a, b) => {
    if (heroesFirst && a.isHeroLike !== b.isHeroLike) return a.isHeroLike ? -1 : 1;
    return Math.hypot(a.x - x, a.y - y) - Math.hypot(b.x - x, b.y - y);
  });
  return list[0];
}

/** Número de ilusiones vivas de un héroe. */
export function illusionsOf(owner: Unit): Unit[] {
  return owner.w.list.filter((u) => u.kind === 'illusion' && u.alive && u.owner === owner);
}

/** Relanza un hechizo con objetivo contra su autor (Counterspell, Lotus Orb). */
export function reflectSpell(by: Unit, caster: Unit, spell: AbilityInst | ItemInst) {
  by.w.emit({ n: 'reflect', x: by.x, y: by.y, u: by.id, u2: caster.id });
  if (!spell.impl?.reflectable || !caster.alive || caster.has(ST.magicImmune) || (spell as AbilityInst).temp) return;
  const copy = { ...spell, owner: by, temp: true, data: {} } as AbilityInst | ItemInst;
  if (!isItem(copy)) copy.passiveMod = null;
  spell.impl.onSpellStart?.(copy as any, { unit: caster, x: caster.x, y: caster.y });
}

/**
 * Desplazamiento rápido hacia un punto (saltos, cargas). El héroe no obedece órdenes mientras dura.
 * `onArrive` se llama al llegar; `onStep` en cada tick (para golpear lo que atraviesa).
 */
export function dash(u: Unit, tx: number, ty: number, speed: number, a: Src, opts: {
  name?: string; states?: number; onArrive?: (u: Unit) => void; onStep?: (u: Unit) => void; maxTime?: number;
} = {}) {
  const dist = Math.hypot(tx - u.x, ty - u.y);
  const time = Math.min(opts.maxTime ?? 5, dist / Math.max(1, speed));
  u.order = null; u.path = [];
  if (u.cast?.phase === 2) u.w.interruptCast(u, true);
  return u.addMod({
    name: opts.name ?? 'dash', duration: time + 0.05, states: ST.busy | ST.noCollision | (opts.states ?? 0), fx: 'push',
    onTick(m, dt) {
      const d = Math.hypot(tx - u.x, ty - u.y);
      const step = speed * dt;
      if (d <= step) { u.w.forceMove(u, tx, ty); m.remaining = 0.001; return; }
      u.facing = Math.atan2(ty - u.y, tx - u.x);
      u.w.forceMove(u, u.x + (tx - u.x) / d * step, u.y + (ty - u.y) / d * step);
      opts.onStep?.(u);
    },
    onDestroy() { opts.onArrive?.(u); },
  }, u, a);
}

/** Daño en el tiempo: `dps` cada `interval` segundos mientras dure el modificador. */
export function dot(caster: Unit, t: Unit, a: Src, name: string, duration: number, dps: number,
  type: 'physical' | 'magical' | 'pure' = 'magical', interval = 1, extra: Partial<ModSpec> = {}) {
  return debuff(caster, t, a, {
    name, duration, interval, fx: extra.fx ?? 'slow',
    onInterval(m) { damageFn(caster, m.owner as Unit, dps * interval, type, a, { noProc: true }); },
    ...extra,
  });
}

/** Miedo: el objetivo huye de `from` (o del lanzador) sin obedecer órdenes. */
export function fear(caster: Unit, t: Unit, duration: number, a: Src, from?: { x: number; y: number }, name = 'fear') {
  const m = debuff(caster, t, a, { name, duration, fx: 'taunt', states: ST.disarmed | ST.silenced, data: { fearFrom: from ?? { x: caster.x, y: caster.y } } });
  if (m && t.cast) t.w.interruptCast(t, true);
  return m;
}
