// Ayudas compartidas por los héroes de la tanda A7 (Rubick … Spirit Breaker).
import { manaCostOf, val } from '../../sim/abilities';
import type { AbilityInst, DamageEvent, ItemInst, ModSpec, Modifier, Props } from '../../sim/types';
import { ST } from '../../sim/types';
import type { Unit } from '../../sim/unit';
import { canDebuff, debuff } from '../util';

export type Src = AbilityInst | ItemInst | null;

/** Héroe real detrás de una ilusión. */
export const realHero = (u: Unit): Unit => (u.kind === 'illusion' && u.owner ? (u.owner as Unit) : u);

/** Devuelve el maná y el enfriamiento de un lanzamiento que no debía ocurrir (objetivo no válido). */
export function refund(a: AbilityInst) {
  const u = a.owner as Unit;
  u.mana = Math.min(u.s.maxMana, u.mana + manaCostOf(a));
  if (a.impl.charges) a.charges = Math.min(a.impl.charges(a)[0], a.charges + 1);
  else a.cd = 0;
}

/** Lanzamiento sin efecto (sub-habilidad sin estado): evita que los bots la repitan cada tick. */
export function idle(a: AbilityInst, secs = 1) { a.cd = Math.max(a.cd, secs); }

/**
 * Cargas opcionales: si `maxKey` vale más de 0 (talento o Scepter) da esas cargas;
 * si no, una sola carga con el enfriamiento normal (equivale a no tener cargas).
 */
export function optCharges(a: AbilityInst, maxKey: string, timeKey: string): [number, number] {
  const u = a.owner as Unit;
  const max = val(a, maxKey);
  if (max > 0) return [max, val(a, timeKey) * (1 - u.s.cdr)];
  return [1, val(a, '_cd') * (1 - u.s.cdr)];
}

/** Lista de cargas con duración independiente dentro de un único modificador. */
export function addStacks(t: Unit, caster: Unit, a: Src, spec: ModSpec, duration: number, n = 1, max = Infinity): Modifier | null {
  if (n <= 0) return null;
  const isDebuff = !!spec.debuff && caster.team !== t.team;
  if (isDebuff && !canDebuff(caster, t, a)) return null;
  const d = isDebuff ? duration * (1 - t.s.statusResist) : duration;
  let m = t.mods.find((x) => x.name === spec.name && x.caster === caster) ?? null;
  if (!m) {
    const userTick = spec.onTick;
    m = t.addMod({
      ...spec, duration: Infinity, stacks: 0, data: { ...(spec.data ?? {}), list: [] as number[] },
      onTick(mm, dt) {
        const list = mm.data.list as number[];
        const now = (mm.owner as Unit).w.time;
        let changed = false;
        while (list.length && list[0] <= now) { list.shift(); changed = true; }
        if (changed) {
          mm.stacks = list.length;
          if (!list.length) { (mm.owner as Unit).removeMod(mm); return; }
          (mm.owner as Unit).refreshStats();
        }
        userTick?.(mm, dt);
      },
    }, caster, a);
  }
  const list = m.data.list as number[];
  for (let i = 0; i < n; i++) list.push(t.w.time + d);
  list.sort((x, y) => x - y);
  while (list.length > max) list.shift();
  m.stacks = list.length;
  t.refreshStats();
  return m;
}

/**
 * Evita una muerte: si el golpe va a matar y `ready()` lo permite, el daño se anula y se llama a `fn`
 * (reencarnar, convertirse en pollo…). Se resuelve antes de kill(), así que no cuenta como muerte.
 */
export function deathGuard(ready: (u: Unit, ev: DamageEvent) => boolean, fn: (u: Unit, ev: DamageEvent) => void): Partial<ModSpec> {
  return {
    onIncomingDamage(m, ev) {
      const u = m.owner as Unit;
      if (ev.amount <= 0 || ev.amount < u.hp || ev.data?.nonLethal || !u.alive) return;
      if (!ready(u, ev)) return;
      ev.amount = 0;
      fn(u, ev);
    },
  };
}

/** Barrera contra todo tipo de daño (o solo mágico). */
export function barrierSpec(amount: number, magicOnly = false): Partial<ModSpec> {
  return {
    data: { left: amount },
    onIncomingDamage(m, ev) {
      if (ev.hpRemoval || (magicOnly && ev.type !== 'magical') || m.data.left <= 0) return;
      const take = Math.min(m.data.left, ev.amount);
      m.data.left -= take; ev.amount -= take;
      if (m.data.left <= 0) m.remaining = 0.001;
    },
  };
}

/** Miedo: la unidad huye de (fx, fy) sin poder actuar. */
export function fear(caster: Unit, t: Unit, a: Src, duration: number, fx: number, fy: number, extra: Partial<Props> = {}) {
  const m = debuff(caster, t, a, {
    name: 'feared', duration, fx: 'fear', states: ST.busy | ST.disarmed | ST.silenced | ST.muted, props: extra,
    onTick(mm, dt) {
      const v = mm.owner as Unit;
      if (v.has(ST.rooted) || v.has(ST.stunned)) return;
      const dx = v.x - fx, dy = v.y - fy;
      const d = Math.hypot(dx, dy) || 1;
      const step = v.s.ms * dt;
      v.facing = Math.atan2(dy, dx);
      v.w.forceMove(v, v.x + dx / d * step, v.y + dy / d * step);
    },
  });
  if (m) { t.order = null; t.atk.phase = 0; if (t.cast) t.w.interruptCast(t, true); }
  return m;
}

/** Enemigos héroe (reales) vivos de todo el mapa. */
export function enemyHeroes(u: Unit): Unit[] {
  return u.w.list.filter((e) => e.alive && e.kind === 'hero' && e.team !== u.team && u.w.targetable(e));
}

/** Distancia de un punto a un segmento. */
export function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  const k = l2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
  return Math.hypot(px - (ax + dx * k), py - (ay + dy * k));
}

/** Está dentro de un cono/trapecio que sale de (x,y) en dirección (dx,dy). */
export function inCone(u: Unit, x: number, y: number, dx: number, dy: number, len: number, w0: number, w1: number) {
  const rx = u.x - x, ry = u.y - y;
  const along = rx * dx + ry * dy;
  if (along < -u.radius || along > len + u.radius) return false;
  const side = Math.abs(rx * -dy + ry * dx);
  const half = (w0 + (w1 - w0) * Math.max(0, Math.min(1, along / len))) / 2;
  return side <= half + u.radius;
}

/** Revela a la unidad para un equipo (visión, no true sight). */
export function revealTo(t: Unit, team: number, duration: number, caster: Unit, a: Src) {
  return t.addMod({ name: 'reveal', duration, data: { team }, debuff: false, purgable: false }, caster, a);
}

/** ¿Lo ve algún equipo enemigo? */
export function seenByEnemies(u: Unit) {
  return u.w.teams.some((t) => t.id !== u.team && u.w.canSee(t.id, u));
}

/**
 * Hechizo de aliado (Demonic Cleanse, Firesnap Cookie…): devuelve el aliado objetivo.
 * Los bots apuntan siempre al enemigo con el que pelean; para ellos se lanza sobre sí mismos.
 * A un jugador que apunte a un enemigo se le devuelve el lanzamiento.
 */
export function allyTarget(a: AbilityInst, e: Unit | undefined): Unit | null {
  const u = a.owner as Unit;
  if (e && e.team === u.team) return e;
  if (u.isBot) return u;
  refund(a);
  return null;
}

/** Habilidad del héroe por clave (no por hueco: así funciona también en manos de Rubick). */
export const abil = (u: Unit, key: string): AbilityInst | undefined => u.abilities.find((a) => a.key === key);
