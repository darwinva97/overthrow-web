// Ayudas compartidas de la tanda A2: miedo, réplicas controladas por otro equipo,
// lanzamiento de habilidades aliadas por los bots y utilidades de geometría.
import { available } from '../../sim/abilities';
import type { AbilityInst, AiHint, ModSpec, Modifier } from '../../sim/types';
import { ST } from '../../sim/types';
import type { Unit } from '../../sim/unit';
import { debuff, type Src } from '../util';

/**
 * Pista de IA para habilidades que el bot genérico no sabe usar (objetivo aliado, creeps…):
 * `hpBelow: -1` hace que castAbilities nunca la lance y la lanza `botCast` desde la pasiva.
 */
export const aiBy = (role: string): AiHint => ({ role, hpBelow: -1 });

/** Objetivo que devuelve la función de elección del bot. */
export type BotPick = { unit?: Unit; x?: number; y?: number } | null;

/**
 * Pasiva que hace que un bot lance la habilidad cuando `pick` encuentra objetivo.
 * Se combina con otra pasiva (`base`) si la habilidad ya tiene una.
 */
export function botCast(a: AbilityInst, pick: (u: Unit) => BotPick, base: ModSpec | null = null, every = 0.3): ModSpec {
  const spec: ModSpec = base ? { ...base } : { name: 'bot_' + a.key };
  const prev = base?.onTick;
  spec.onTick = (m: Modifier, dt: number) => {
    prev?.(m, dt);
    const u = m.owner as Unit;
    if (!u.isBot || u.kind !== 'hero' || !u.alive) return;
    m.data.botAcc = (m.data.botAcc ?? 0) + dt;
    if (m.data.botAcc < every) return;
    m.data.botAcc = 0;
    if (u.cast || a.level <= 0 || !available(a) || u.w.castCheck(u, a)) return;
    const o = u.order;
    if (o && (o.type === 'cast' || o.type === 'item')) return;
    const t = pick(u);
    if (!t) return;
    u.w.issueOrder(u, { type: 'cast', slot: a.slot, target: t.unit?.id, x: t.x ?? t.unit?.x, y: t.y ?? t.unit?.y });
  };
  return spec;
}

/** Miedo: la unidad huye hacia su fuente (o lejos de quien lo causa) sin poder actuar. */
export function fear(caster: Unit, t: Unit, duration: number, a: Src, name = 'fear') {
  const m = debuff(caster, t, a, {
    name, duration, fx: 'fear', states: ST.busy | ST.disarmed | ST.silenced | ST.muted,
    onTick(mm, dt) {
      const v = mm.owner as Unit;
      if (v.has(ST.stunned | ST.rooted)) return;
      const f = v.w.teams[v.team]?.fountain;
      if (f) { v.w.moveToward(v, f.x, f.y, dt); return; }
      const d = Math.hypot(v.x - caster.x, v.y - caster.y) || 1;
      v.w.moveToward(v, v.x + (v.x - caster.x) / d * 300, v.y + (v.y - caster.y) / d * 300, dt);
    },
  });
  if (m) {
    t.order = null; t.path = []; t.atk.phase = 0;
    if (t.cast) t.w.interruptCast(t, true);
  }
  return m;
}

/** Ilusión de `of` que obedece a `owner` (réplicas de Dark Seer). */
export function replicaFor(owner: Unit, of: Unit, x: number, y: number, duration: number, outPct: number, inPct: number) {
  const il = owner.w.spawnIllusion(of, x, y, duration, outPct, inPct, owner);
  il.team = owner.team;
  il.owner = owner;
  il.playerId = owner.playerId;
  il.order = null;
  return il;
}

/** Distancia de un punto a un segmento y lado (signo) respecto a su recta. */
export function segInfo(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const vx = bx - ax, vy = by - ay;
  const len2 = vx * vx + vy * vy || 1;
  const t = Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / len2));
  const cx = ax + vx * t, cy = ay + vy * t;
  const side = Math.sign(vx * (py - ay) - vy * (px - ax));
  return { dist: Math.hypot(px - cx, py - cy), t, cx, cy, side };
}

/** Unidades que cuentan como "creep" para habilidades que lo exigen. */
export const isCreep = (u: Unit) => u.kind === 'creep' || (u.kind === 'summon' && !u.has(ST.invulnerable));

/** Héroe real dueño de una invocación o ilusión. */
export function heroOf(u: Unit): Unit {
  let c: Unit = u;
  for (let i = 0; i < 4 && c.kind !== 'hero' && c.owner; i++) c = c.owner as Unit;
  return c;
}

/** Aliados del equipo en un radio, sin estructuras ni invocaciones invulnerables. */
export function alliesNear(u: Unit, x: number, y: number, r: number, heroes = true) {
  return u.w.alliesIn(u.team, x, y, r, { heroes }).filter((v) => v.alive);
}
