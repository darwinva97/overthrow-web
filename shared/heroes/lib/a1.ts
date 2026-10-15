// Ayudas compartidas por los héroes de la tanda A1 (Abaddon … Broodmother).
import { available, castRangeOf, val } from '../../sim/abilities';
import type { AbilityInst, AttackEvent, Modifier, ModSpec } from '../../sim/types';
import { ST } from '../../sim/types';
import type { Unit } from '../../sim/unit';
import { debuff, type Src } from '../util';

/** Valor de una habilidad como si tuviera otro nivel (Primal Split con Scepter, invocaciones). */
export function valAt(a: AbilityInst, key: string, level: number): number {
  return val({ ...a, level } as AbilityInst, key);
}

/** Héroe que controla una unidad (ilusión, invocación, Tempest Double…). */
export function heroOf(u: Unit): Unit {
  let c: Unit = u;
  for (let i = 0; i < 4 && c.kind !== 'hero' && c.owner; i++) c = c.owner as Unit;
  return c;
}

/** Unidad controlada por `owner` (él mismo, sus ilusiones e invocaciones). */
export function controlledBy(u: Unit, owner: Unit): boolean {
  let c: Unit | null = u;
  for (let i = 0; c && i < 4; i++) { if (c === owner) return true; c = c.owner as Unit | null; }
  return false;
}

export const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

/** Distancia de un punto a un segmento. */
export function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
}

/** Héroes enemigos visibles cerca, el más cercano primero. */
export function enemyHeroes(u: Unit, r: number, x = u.x, y = u.y): Unit[] {
  return u.w.enemiesIn(u.team, x, y, r, { heroes: true })
    .filter((e) => e.kind === 'hero' && u.w.canSee(u.team, e))
    .sort((a, b) => dist(a, u) - dist(b, u));
}

/** Patrimonio aproximado: oro más coste de los items. */
export function netWorth(u: Unit): number {
  return u.gold + u.items.reduce((s, it) => s + (it?.def.cost ?? 0), 0);
}

// ---------------- Sub-habilidades con cargas como cerrojo ----------------
// Las sub-habilidades (Throw, Release, Nightmare End…) se bloquean con 0 cargas que no se
// regeneran solas, para que nadie (ni la IA) pueda lanzarlas fuera de su momento.
export const LOCKED: [number, number] = [1, 1e9];
export function lockSub(a: AbilityInst | undefined) { if (a) { a.charges = 0; a.chargeCd = 1e9; } }
export function unlockSub(a: AbilityInst | undefined) { if (a) { a.charges = 1; a.chargeCd = 0; } }

// ---------------- Bots ----------------

export interface BotPick { unit?: Unit; x?: number; y?: number }

/**
 * onTick para habilidades que la IA genérica no sabe usar (aliados, autolanzables, estados).
 * Solo actúa si el dueño es un bot; `pick` decide el objetivo o null.
 */
export function botTick(a: AbilityInst, pick: (u: Unit) => BotPick | null, every = 0.4) {
  return (m: Modifier, dt: number) => {
    const u = m.owner as Unit;
    if (!u.isBot || !u.alive || u.cast) return;
    m.data.botAcc = (m.data.botAcc ?? 0) + dt;
    if (m.data.botAcc < every) return;
    m.data.botAcc = 0;
    if (a.level <= 0 || !available(a) || u.w.castCheck(u, a)) return;
    const t = pick(u);
    if (!t) return;
    u.w.issueOrder(u, { type: 'cast', slot: a.slot, target: t.unit?.id, x: t.x ?? t.unit?.x ?? u.x, y: t.y ?? t.unit?.y ?? u.y });
  };
}

/** Mod pasivo que solo hace de IA (para habilidades sin pasiva propia). */
export function botOnly(a: AbilityInst, pick: (u: Unit) => BotPick | null, every = 0.4): ModSpec {
  return { name: 'bot_' + a.key, onTick: botTick(a, pick, every) };
}

/**
 * IA de invocaciones de un bot: lanza sus habilidades con `ai`, ataca al enemigo cercano
 * (héroes primero) y, si no hay nadie, sigue al dueño o va al trono.
 */
export function summonBrain(s: Unit, leash = 900) {
  s.addMod({
    name: 'a1_summon_ai', persistent: true, interval: 0.3,
    onInterval(m) {
      const u = m.owner as Unit;
      const boss = heroOf(u);
      if (!boss.isBot || !u.alive || u.has(ST.busy) || u.cast) return;
      const w = u.w;
      const foes = w.enemiesIn(u.team, u.x, u.y, 1200).filter((e) => w.canSee(u.team, e) && e.kind !== 'ward');
      foes.sort((a, b) => (Number(b.isHeroLike) - Number(a.isHeroLike)) || dist(a, u) - dist(b, u));
      const hero = foes.find((e) => e.isHeroLike);
      for (const a of u.abilities) {
        const ai = a.impl.ai;
        if (!ai || a.level <= 0 || w.castCheck(u, a) || !hero) continue;
        const d = dist(hero, u);
        if (a.impl.target === 'none') {
          if (d <= (ai.selfRadius ?? 400)) { w.issueOrder(u, { type: 'cast', slot: a.slot }); return; }
        } else if (d <= castRangeOf(a) + 100) {
          if (a.impl.target === 'unit' || a.impl.target === 'unitOrPoint') {
            if (hero.has(ST.magicImmune) && !a.def.bkbPierce) continue;
            w.issueOrder(u, { type: 'cast', slot: a.slot, target: hero.id });
          } else w.issueOrder(u, { type: 'cast', slot: a.slot, x: hero.x, y: hero.y });
          return;
        }
      }
      if (u.has(ST.disarmed) && u.findMod('cannot_attack')) return;
      const e = foes[0];
      if (e && dist(e, u) < leash) {
        if (u.order?.type !== 'attack' || u.order.target !== e.id) w.issueOrder(u, { type: 'attack', target: e.id });
        return;
      }
      if (u.order) return;
      const home = boss.alive && !boss.has(ST.hidden) && boss !== u ? boss : { x: 0, y: 0 };
      if (dist(home, u) > 350) w.issueOrder(u, { type: 'attackMove', x: home.x, y: home.y });
    },
  }, s, null);
}

// ---------------- Efectos ----------------

/** Fallo de ataque (ceguera): el motor no tiene "miss chance", así que el golpe no hace daño. */
export function blindRoll(ev: AttackEvent, chance: number) {
  if (ev.trueStrike || chance <= 0) return;
  const a = ev.attacker as Unit;
  if (a.w.rng() >= chance) return;
  ev.damage = 0; ev.critMult = 1; ev.missed = true;
  a.w.emit({ n: 'miss', x: ev.target.x, y: ev.target.y, u: ev.target.id });
}

/** Miedo: la víctima huye de (fx, fy) sin obedecer órdenes. */
export function fear(caster: Unit, t: Unit, duration: number, a: Src, fx: number, fy: number) {
  const m = debuff(caster, t, a, {
    name: 'feared', duration, states: ST.busy | ST.disarmed | ST.silenced, fx: 'taunt',
    onTick(mm, dt) {
      const v = mm.owner as Unit;
      if (v.has(ST.rooted) || v.has(ST.stunned)) return;
      const dx = v.x - fx, dy = v.y - fy, d = Math.hypot(dx, dy) || 1;
      v.facing = Math.atan2(dy, dx);
      v.w.forceMove(v, v.x + dx / d * v.s.ms * dt, v.y + dy / d * v.s.ms * dt);
    },
  });
  if (m) { t.order = null; t.atk.phase = 0; if (t.cast) t.w.interruptCast(t, true); }
  return m;
}

/** Revela una unidad a un equipo (y la saca de la invisibilidad). El motor busca el nombre 'reveal'. */
export function reveal(caster: Unit, t: Unit, duration: number, a: Src) {
  return t.addMod({ name: 'reveal', duration, debuff: true, purgable: false, states: ST.revealed, data: { team: caster.team } }, caster, a);
}

/** Pila con duraciones independientes en un solo modificador. */
export function addTimedStack(m: Modifier, now: number, duration: number, max = Infinity) {
  const list: number[] = (m.data.exp ??= []);
  list.push(now + duration);
  while (list.length > max) list.shift();
  m.stacks = list.length;
  m.remaining = Math.max(m.remaining, duration);
}
export function pruneTimedStack(m: Modifier, now: number): boolean {
  const list: number[] = m.data.exp ?? [];
  const before = list.length;
  while (list.length && list[0] <= now) list.shift();
  m.stacks = list.length;
  if (!list.length) m.remaining = 0.001;
  return before !== list.length;
}
