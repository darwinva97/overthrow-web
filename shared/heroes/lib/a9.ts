// Ayudas compartidas por los héroes de la tanda A9 (Vengeful Spirit … Zeus).
import { lv } from '../../data';
import type { AbilityInst, ModSpec } from '../../sim/types';
import { ST } from '../../sim/types';
import type { Unit } from '../../sim/unit';

export const pct = (u: Unit) => u.hp / Math.max(1, u.s.maxHp);
export const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * Valor del dataset sin enlaces de Shard/Scepter. Solo para enlaces mal leídos del script de Valve
 * (un "+200" que llegó como "200" y val() trataría como valor fijo).
 */
export function rawVal(a: AbilityInst, key: string): number {
  return lv(a.def.values[key], Math.max(1, a.level)) + (a.bonus[key] ?? 0);
}

/**
 * Los bots siempre apuntan sus hechizos al enemigo. En habilidades sobre aliados, este modificador
 * cambia el objetivo de la orden por el que elija `pick` (o la anula si devuelve null).
 */
export function botAllyTarget(a: AbilityInst, pick: (u: Unit) => Unit | null): ModSpec {
  return {
    name: 'bot_ally_' + a.key,
    onOrder(m, o) {
      const u = m.owner as Unit;
      if (!u.isBot || o.type !== 'cast' || o.slot !== a.slot) return;
      const t = o.target ? u.w.units.get(o.target) : undefined;
      if (t && t.team === u.team) return;
      const p = pick(u);
      // -1: objetivo inexistente, la orden falla sin coste.
      (o as { target?: number }).target = p ? p.id : -1;
    },
  };
}

/** Aliado (héroe primero) más herido en el radio, por debajo de `below` de vida. */
export function hurtAlly(u: Unit, r: number, below: number, self = true): Unit | null {
  const list = u.w.alliesIn(u.team, u.x, u.y, r).filter((x) => (self || x !== u) &&
    (x.isHeroLike || x.kind === 'summon' || x.kind === 'creep') && pct(x) < below);
  list.sort((a, b) => Number(b.isHeroLike) - Number(a.isHeroLike) || pct(a) - pct(b));
  return list[0] ?? null;
}

/** Unidad inmóvil (wards): enraizada para siempre. */
export function stationary(u: Unit) {
  u.addMod({ name: 'stationary', persistent: true, states: ST.rooted | ST.noCollision });
}

/** Unidad voladora (familiares de Visage, nubes). */
export function flying(u: Unit) {
  u.addMod({ name: 'flying', persistent: true, states: ST.flying | ST.noCollision });
}

/** Cambia el daño y la vida base de una invocación tras crearla. */
export function setSummonStats(s: Unit, st: { dmg?: number; spread?: number; hp?: number; armor?: number; ms?: number; range?: number }) {
  if (st.dmg !== undefined) { s.base.dmgMin = st.dmg; s.base.dmgMax = st.dmg + (st.spread ?? 0); }
  if (st.hp !== undefined) s.base.hp = st.hp;
  if (st.armor !== undefined) s.base.armor = st.armor;
  if (st.ms !== undefined) s.base.ms = st.ms;
  if (st.range !== undefined) s.base.range = st.range;
  s.refreshStats();
  s.hp = s.s.maxHp;
}

/**
 * IA de invocaciones de un bot: atacan al objetivo de su dueño (o al enemigo más cercano)
 * y lo siguen si se alejan. Las de jugadores humanos se manejan a mano.
 */
export function summonBrain(s: Unit, owner: Unit, leash = 800, extra?: (s: Unit) => void) {
  s.addMod({
    name: 'summon_brain', persistent: true, interval: 0.4,
    onInterval() {
      if (!owner.isBot || !s.alive || s.has(ST.busy)) return;
      extra?.(s);
      const w = s.w;
      const cur = s.order?.type === 'attack' ? w.units.get(s.order.target) : undefined;
      if (cur && cur.alive && w.targetable(cur) && dist(cur, owner) < leash + 300) return;
      const tid = owner.ai?.target as number | undefined;
      let t = tid ? w.units.get(tid) : undefined;
      if (!t || !t.alive || !w.targetable(t) || !w.canSee(s.team, t) || dist(t, owner) > leash) {
        t = w.enemiesIn(s.team, owner.x, owner.y, leash, { immune: false })
          .filter((e) => e.kind !== 'ward' && w.canSee(s.team, e))
          .sort((a, b) => Number(b.isHeroLike) - Number(a.isHeroLike) || dist(a, s) - dist(b, s))[0];
      }
      if (t) { w.issueOrder(s, { type: 'attack', target: t.id }); return; }
      if (dist(s, owner) > 350 && s.order?.type !== 'follow') w.issueOrder(s, { type: 'follow', target: owner.id });
    },
  });
}

/** Barrera que absorbe daño (de un tipo o de todos) hasta agotarse. */
export function barrierMod(name: string, duration: number, amount: number, type?: 'physical' | 'magical'): ModSpec {
  return {
    name, duration, fx: 'barrier', purgable: true,
    data: { left: amount },
    onIncomingDamage(m, ev) {
      if (ev.hpRemoval || (type && ev.type !== type)) return;
      const take = Math.min(m.data.left, ev.amount);
      m.data.left -= take; ev.amount -= take;
      if (m.data.left <= 0) m.remaining = 0.001;
    },
  };
}

/** Revela invisibles a un equipo (true sight puntual) durante `duration`. */
export function trueSightAt(caster: Unit, x: number, y: number, r: number, duration: number) {
  const w = caster.w;
  w.addVision(caster.team, x, y, r, duration, true);
  for (const e of w.unitsIn(x, y, r, (v) => v.team !== caster.team)) {
    e.addMod({ name: 'reveal', duration, states: ST.revealed, data: { team: caster.team } }, caster, null);
  }
}
