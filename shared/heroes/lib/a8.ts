// Ayudas compartidas de la tanda A8 (Storm … Undying).
import { manaCostOf } from '../../sim/abilities';
import type { AbilityInst, AttackEvent, ModSpec } from '../../sim/types';
import { ST } from '../../sim/types';
import type { Unit } from '../../sim/unit';
import { debuff, type Src } from '../util';

/** Héroe real detrás de una ilusión. */
export const heroOf = (u: Unit): Unit => (u.kind === 'illusion' && u.owner ? (u.owner as Unit) : u);

/** Unidad "de verdad" a efectos de hechizos de área: héroes, ilusiones, creeps e invocaciones. */
export const isUnitLike = (u: Unit) => u.isHeroLike || u.kind === 'creep' || u.kind === 'summon';

/** Hace fallar un ataque ya lanzado (ceguera). El motor no permite cancelar los efectos al impactar. */
export function missAttack(ev: AttackEvent) {
  ev.damage = 0; ev.critMult = 1;
  (ev as any).blinded = true;
  const t = ev.target as Unit;
  t.w.emit({ n: 'miss', x: t.x, y: t.y, u: t.id });
}

/** Ceguera: los ataques del afectado fallan con probabilidad `pct` (0-1). */
export function blind(caster: Unit, t: Unit, a: Src, name: string, duration: number, pct: number, extra: Partial<ModSpec> = {}) {
  return debuff(caster, t, a, {
    name, duration, fx: 'blind', ...extra,
    onAttackStart(_m, ev) { if (t.w.rng() < pct) missAttack(ev); },
  });
}

/** Miedo: huye del punto, sin poder atacar ni lanzar. */
export function fear(caster: Unit, t: Unit, a: Src, duration: number, fromX: number, fromY: number, name = 'fear') {
  const m = debuff(caster, t, a, {
    name, duration, fx: 'fear', states: ST.busy | ST.disarmed | ST.silenced | ST.muted,
    onTick(mm, dt) {
      const v = mm.owner as Unit;
      if (v.has(ST.stunned) || v.has(ST.rooted)) return;
      let dx = v.x - fromX, dy = v.y - fromY;
      const d = Math.hypot(dx, dy) || 1;
      dx /= d; dy /= d;
      v.w.moveToward(v, v.x + dx * 300, v.y + dy * 300, dt, 0);
    },
  });
  if (m) { t.order = null; t.atk.phase = 0; if (t.cast) t.w.interruptCast(t, true); }
  return m;
}

/** Distancia de un punto al segmento (x0,y0)-(x1,y1). */
export function segDist(px: number, py: number, x0: number, y0: number, x1: number, y1: number) {
  const vx = x1 - x0, vy = y1 - y0;
  const l2 = vx * vx + vy * vy;
  const k = l2 > 0 ? Math.max(0, Math.min(1, ((px - x0) * vx + (py - y0) * vy) / l2)) : 0;
  return Math.hypot(px - (x0 + vx * k), py - (y0 + vy * k));
}

/** Enemigos en un rectángulo que sale de (x,y) en la dirección (dx,dy). */
export function enemiesInLine(u: Unit, x: number, y: number, dx: number, dy: number, len: number, width: number) {
  return u.w.enemiesIn(u.team, x + dx * len / 2, y + dy * len / 2, len / 2 + width).filter((e) =>
    segDist(e.x, e.y, x, y, x + dx * len, y + dy * len) <= width / 2 + e.radius);
}

/**
 * Devuelve el maná y el enfriamiento de un lanzamiento que no ha tenido efecto.
 * A los bots les deja un enfriamiento corto para que no repitan la orden en bucle.
 */
export function refund(a: AbilityInst) {
  const u = a.owner as Unit;
  u.mana = Math.min(u.s.maxMana, u.mana + manaCostOf(a));
  if (u.isBot) { if (!a.impl.charges) a.cd = 2; return; }
  if (a.impl.charges) a.charges = Math.min(a.impl.charges(a)[0], a.charges + 1);
  else a.cd = 0;
}

/** Mantiene una habilidad en enfriamiento mientras no se cumpla la condición (activas de Shard y sub-habilidades). */
export function gate(a: AbilityInst, ok: boolean) {
  if (!ok) a.cd = Math.max(a.cd, 0.25);
}

/** Unidad auxiliar sin IA (minas, remanentes, trampas, torretas…). */
export function helper(owner: Unit, unit: string, x: number, y: number, duration: number, states = 0, opts: { hp?: number; level?: number } = {}) {
  const h = owner.w.spawnSummon(owner, unit, x, y, duration, { kind: 'ward', ...opts });
  if (states) h.addMod({ name: 'helper_state', persistent: true, states });
  return h;
}

/** Muerte limpia de una unidad auxiliar en el siguiente tick. */
export function expire(u: Unit) {
  if (u.alive) u.expireAt = Math.min(u.expireAt, u.w.time);
}

/** Hay algún árbol a menos de `r` del punto. */
export function nearTree(u: Unit, r: number, x = u.x, y = u.y) {
  return !!u.w.nearestTree(x, y, r);
}

/** Vuelo sin colisión hacia un punto en `time` segundos (Toss, Walrus Kick). */
export function fly(t: Unit, tx: () => [number, number], time: number, caster: Unit, a: Src, extraStates: number, onLand: (t: Unit) => void, name = 'airborne') {
  const sx = t.x, sy = t.y;
  t.w.disjoint(t);
  if (t.cast) t.w.interruptCast(t, true);
  t.order = null; t.atk.phase = 0;
  let el = 0;
  return t.addMod({
    name, duration: time + 0.05, states: ST.stunned | ST.noCollision | ST.flying | extraStates, fx: 'airborne', purgable: false,
    onTick(m, dt) {
      el += dt;
      const k = Math.min(1, el / time);
      const [x, y] = tx();
      t.x = sx + (x - sx) * k; t.y = sy + (y - sy) * k;
      if (k >= 1) m.remaining = 0.001;
    },
    onDestroy() { t.w.forceMove(t, t.x, t.y); if (t.alive) onLand(t); },
  }, caster, a);
}
