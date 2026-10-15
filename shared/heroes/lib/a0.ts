// Ayudas compartidas por los héroes de la tanda A0 (barridos, barreras, empujes, ataques simulados).
import { damage } from '../../sim/combat';
import type { ModSpec } from '../../sim/types';
import type { Unit } from '../../sim/unit';
import { push, type Src } from '../util';

/** Daño de ataque medio del héroe (base + bonus), sin crítico. */
export const attackDamage = (u: Unit) => (u.s.dmgMin + u.s.dmgMax) / 2 + u.s.dmgBonus;

/**
 * Barrido en cono delante del atacante (Great Cleave, puño de Lion). Como en Dota, ignora la
 * armadura de las unidades barridas y afecta a inmunes a hechizos.
 */
export function cleave(u: Unit, t: Unit, amount: number, startW: number, endW: number, dist: number, src: Src) {
  if (amount <= 0) return;
  const ang = Math.atan2(t.y - u.y, t.x - u.x);
  for (const e of u.w.enemiesIn(u.team, u.x, u.y, dist)) {
    if (e === t || e.kind === 'ward') continue;
    const d = Math.hypot(e.x - u.x, e.y - u.y);
    const rel = Math.atan2(e.y - u.y, e.x - u.x) - ang;
    const along = d * Math.cos(rel);
    const across = Math.abs(d * Math.sin(rel));
    const width = startW + (endW - startW) * Math.max(0, along) / dist;
    if (along > 0 && across <= width / 2 + e.radius) {
      damage(u, e, amount, 'pure', src, { noProc: true, data: { cleave: true } });
    }
  }
}

/** Barrera que absorbe daño físico (o de cualquier tipo con `any`). Se suma a la que ya hubiera. */
export function addBarrier(u: Unit, caster: Unit, src: Src, name: string, amount: number, duration: number, any = false) {
  if (amount <= 0) return null;
  const old = u.findMod(name, caster);
  const left = (old?.data.left ?? 0) + amount;
  const m = u.addMod({ name, duration, fx: 'barrier', ...barrierSpec(left, any) }, caster, src);
  m.data.left = left;
  m.remaining = Math.max(m.remaining, duration);
  return m;
}

export function barrierSpec(amount: number, any = false): Partial<ModSpec> {
  return {
    data: { left: amount },
    onIncomingDamage(m, ev) {
      if (ev.hpRemoval || (!any && ev.type !== 'physical')) return;
      const a = Math.min(m.data.left, ev.amount);
      m.data.left -= a; ev.amount -= a;
      if (m.data.left <= 0) m.remaining = 0.001;
    },
  };
}

/** Empuje que aleja a `t` del punto (fx, fy). */
export function knockFrom(t: Unit, fx: number, fy: number, distance: number, time: number, caster: Unit, src: Src, name = 'knockback') {
  let dx = t.x - fx, dy = t.y - fy;
  if (Math.hypot(dx, dy) < 1) { dx = Math.cos(caster.facing); dy = Math.sin(caster.facing); }
  if (distance <= 0) return null;
  return push(t, dx, dy, distance, time, caster, src, name);
}

/** Héroe real detrás de una ilusión. */
export const realHero = (u: Unit): Unit => (u.kind === 'illusion' && u.owner ? u.owner as Unit : u);

/** Habilidad del kit por clave (en el propio héroe o, si es ilusión, en su dueño). */
export function abilityOf(u: Unit, key: string) {
  return u.abilities.find((a) => a.key === key) ?? realHero(u).abilities.find((a) => a.key === key);
}
