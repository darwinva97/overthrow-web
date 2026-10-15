// Ayudas compartidas por los héroes de la tanda A6 (Omniknight … Ringmaster).
import { castRangeOf } from '../../sim/abilities';
import type { AbilityInst, AttackEvent, ModSpec, Order } from '../../sim/types';
import { ST } from '../../sim/types';
import type { Unit } from '../../sim/unit';
import { debuff, type Src } from '../util';

/** Activa o bloquea una sub-habilidad (Stop, Launch, Release…): bloqueada = enfriamiento enorme. */
export function gate(a: AbilityInst | undefined, usable: boolean) {
  if (!a) return;
  if (usable) { if (a.cd >= 1e5) a.cd = 0; }
  else a.cd = 1e6;
}

export const abil = (u: Unit, key: string) => u.abilities.find((x) => x.key === key);

/**
 * Los bots lanzan todo sobre su objetivo enemigo: para hechizos solo de aliados, la orden se
 * redirige al aliado más herido a su alcance (o a sí mismo). Se pone como `passive` de la activa.
 */
export function allyRedirect(a: AbilityInst, allowSelf = true): ModSpec {
  return {
    name: 'bot_ally_redirect_' + a.key,
    onOrder(_m, o: Order) {
      const u = a.owner as Unit;
      if (!u.isBot || o.type !== 'cast' || o.slot !== a.slot || !o.target) return;
      const t = u.w.units.get(o.target);
      if (!t || t.team === u.team) return;
      const r = castRangeOf(a) + 200;
      const allies = u.w.alliesIn(u.team, u.x, u.y, r, { heroes: true })
        .filter((x) => x.kind === 'hero' && (allowSelf || x !== u));
      allies.sort((p, q) => p.hp / p.s.maxHp - q.hp / q.s.maxHp);
      const pick = allies[0] ?? (allowSelf ? u : null);
      if (pick) o.target = pick.id;
    },
  };
}

/** El ataque del dueño del modificador falla con probabilidad `p` (Smoke Screen, Spotlight). */
export function rollMiss(ev: AttackEvent, p: number) {
  const u = ev.attacker as Unit;
  if (ev.trueStrike || u.w.rng() >= p) return;
  ev.damage = 0; ev.critMult = 1;
  u.w.emit({ n: 'miss', x: ev.target.x, y: ev.target.y, u: ev.target.id });
}

/** El atacante está a la espalda del objetivo (ángulo total del cono trasero en grados). */
export function behind(att: Unit, t: Unit, angleDeg: number) {
  const toAtt = Math.atan2(att.y - t.y, att.x - t.x);
  let d = Math.abs(toAtt - t.facing) % (Math.PI * 2);
  if (d > Math.PI) d = Math.PI * 2 - d;
  return d >= Math.PI - (angleDeg / 2) * Math.PI / 180;
}

/** Barrera de daño de todo tipo (Shield Crash): absorbe hasta `amount`. */
export function barrierSpec(name: string, duration: number, amount: number): ModSpec {
  return {
    name, duration, fx: 'barrier', data: { left: amount },
    onIncomingDamage(m, ev) {
      if (ev.hpRemoval || ev.amount <= 0) return;
      const b = Math.min(m.data.left, ev.amount);
      ev.amount -= b; m.data.left -= b;
      if (m.data.left <= 0) m.remaining = 0.001;
    },
  };
}

/** Miedo: el objetivo huye de (fx, fy) sin obedecer órdenes. */
export function fear(caster: Unit, t: Unit, duration: number, a: Src, fx: number, fy: number) {
  const m = debuff(caster, t, a, {
    name: 'fear', duration, fx: 'fear',
    states: ST.busy | ST.silenced | ST.disarmed | ST.muted,
    onTick(mm, dt) {
      const v = mm.owner as Unit;
      if (v.has(ST.stunned) || v.has(ST.rooted)) return;
      const dx = v.x - fx, dy = v.y - fy;
      const d = Math.hypot(dx, dy) || 1;
      v.facing = Math.atan2(dy, dx);
      v.w.moveToward(v, v.x + dx / d * 300, v.y + dy / d * 300, dt, 4);
    },
  });
  if (m) { t.order = null; t.atk.phase = 0; if (t.cast) t.w.interruptCast(t, true); }
  return m;
}

/** Distancia de un punto a un segmento, y la proyección a lo largo (0..len). */
export function segDist(px: number, py: number, x0: number, y0: number, dx: number, dy: number, len: number) {
  const t = Math.max(0, Math.min(len, (px - x0) * dx + (py - y0) * dy));
  return { d: Math.hypot(px - (x0 + dx * t), py - (y0 + dy * t)), t };
}

/** Enemigos dentro de un rectángulo (línea con anchura) desde (x0,y0) en la dirección (dx,dy). */
export function enemiesInLine(u: Unit, x0: number, y0: number, dx: number, dy: number, len: number, width: number) {
  return u.w.enemiesIn(u.team, x0 + dx * len / 2, y0 + dy * len / 2, len / 2 + width).filter((e) => {
    const s = segDist(e.x, e.y, x0, y0, dx, dy, len);
    return s.d <= width / 2 + e.radius;
  });
}

/** Revela invisibles (true sight de área) durante un rato. */
export function reveal(caster: Unit, t: Unit, duration: number, a: Src, name = 'revealed_by') {
  return t.addMod({ name, duration, debuff: true, purgable: false, states: ST.revealed }, caster, a);
}

/** Unidad dueña real (para ilusiones). */
export const realOwner = (u: Unit): Unit => (u.kind === 'illusion' && u.owner ? (u.owner as Unit) : u);
