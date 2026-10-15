import { defineAbility, defineHero, dmg, dur, hasScepter, hasShard, isItem, makeAbility, refreshPassive, val } from '../sim/abilities';
import { damage } from '../sim/combat';
import type { AbilityInst } from '../sim/types';
import { ST } from '../sim/types';
import type { Unit } from '../sim/unit';
import { abil, refund } from './lib/a7';
import { debuff, stun } from './util';

// Huecos del kit (orden de heroes.json).
const SLOT_EMPTY = [3, 4];

/** Telekinesis activa de este Rubick: objetivo, punto de aterrizaje y origen. */
interface Lift { target: number; x: number; y: number; ox: number; oy: number; maxD: number }

defineAbility({
  key: 'rubick_telekinesis', target: 'unit', team: 'any', reflectable: true, ai: { role: 'disable' },
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const e = t.unit as Unit;
    const ally = e.team === u.team;
    // Con Shard se puede lanzar sobre uno mismo o aliados (los lanza tras un retardo menor).
    if (ally && !hasShard(u)) { refund(a); return; }
    const lift = ally ? val(a, 'shard_teammate_throw_delay') || 0.5 : dur(a, 'lift_duration');
    const maxD = val(a, 'max_land_distance');
    a.data.lift = { target: e.id, x: e.x, y: e.y, ox: e.x, oy: e.y, maxD } as Lift;
    e.w.disjoint(e);
    if (e.cast && !ally) e.w.interruptCast(e, true);
    const spec = {
      name: 'telekinesis', duration: lift + val(a, 'fall_duration'), fx: 'telekinesis',
      states: ST.stunned,
      onDestroy(m: any) {
        const v = m.owner as Unit;
        const l = a.data.lift as Lift | undefined;
        a.data.lift = undefined;
        if (!l || !v.alive) return;
        v.w.forceMove(v, l.x, l.y);
        const r = val(a, 'radius');
        v.w.emit({ n: 'telekinesis_land', x: v.x, y: v.y, r, t: u.team });
        for (const en of u.w.enemiesIn(u.team, v.x, v.y, r)) {
          if (en === v && ally) continue;
          stun(u, en, dur(a, 'stun_duration'), a);
          const ld = val(a, 'landing_damage');
          if (ld > 0) damage(u, en, ld, 'magical', a);
        }
      },
    };
    if (ally) e.addMod(spec, u, a);
    else if (!debuff(u, e, a, spec)) a.data.lift = undefined;
  },
});

// Eligen el punto donde cae el objetivo de Telekinesis (sub-habilidades; la segunda para uno mismo).
for (const key of ['rubick_telekinesis_land', 'rubick_telekinesis_land_self']) {
  defineAbility({
    key, target: 'point', levelWith: 0, castBeyond: true,
    hidden: (a) => {
      const l = abil(a.owner as Unit, 'rubick_telekinesis')?.data.lift as Lift | undefined;
      return !l || (key === 'rubick_telekinesis_land_self') !== (l.target === a.owner.id);
    },
    onSpellStart(a, t) {
      const tk = abil(a.owner as Unit, 'rubick_telekinesis');
      const l = tk?.data.lift as Lift | undefined;
      if (!l) { a.cd = 0.5; return; }
      const dx = t.x - l.ox, dy = t.y - l.oy;
      const d = Math.hypot(dx, dy);
      const k = d > l.maxD ? l.maxD / d : 1;
      l.x = l.ox + dx * k; l.y = l.oy + dy * k;
    },
  });
}

defineAbility({
  key: 'rubick_fade_bolt', target: 'unit', reflectable: true, ai: { role: 'nuke' },
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const hit = new Set<number>();
    let dmgNow = dmg(a, 'damage');
    const red = val(a, 'jump_damage_reduction_pct') / 100;
    const jump = (from: Unit, e: Unit) => {
      hit.add(e.id);
      u.w.emit({ n: 'fade_bolt', x: from.x, y: from.y, x2: e.x, y2: e.y, u: from.id, u2: e.id });
      damage(u, e, dmgNow, 'magical', a);
      debuff(u, e, a, {
        name: 'fade_bolt', duration: dur(a, 'duration'), fx: 'fade_bolt',
        props: { outgoingPct: -val(a, 'damage_reduction') / 100 },
      });
      dmgNow *= 1 - red;
      u.w.after(val(a, 'jump_delay'), () => {
        const next = u.w.enemiesIn(u.team, e.x, e.y, val(a, 'radius'), { immune: false })
          .filter((x) => !hit.has(x.id) && x.kind !== 'ward')
          .sort((p, q) => Math.hypot(p.x - e.x, p.y - e.y) - Math.hypot(q.x - e.x, q.y - e.y))[0];
        if (next) jump(e, next);
      });
    };
    jump(u, t.unit as Unit);
  },
});

defineAbility({
  key: 'rubick_arcane_supremacy', target: 'passive',
  passive: (a) => ({
    name: 'arcane_supremacy',
    props: { castRange: val(a, 'cast_range'), spellAmp: val(a, 'spell_amp') / 100 },
  }),
});

// Huecos vacíos: los ocupa Spell Steal.
for (const key of ['rubick_empty1', 'rubick_empty2', 'rubick_hidden1', 'rubick_hidden2', 'rubick_hidden3', 'rubick_hidden4', 'rubick_hidden5']) {
  defineAbility({ key, target: 'passive', hidden: true, sub: true });
}

/** Quita el hechizo robado de un hueco y devuelve el hueco vacío. */
function dropStolen(u: Unit, slot: number) {
  const cur = u.abilities[slot];
  const orig = u.data_rubickEmpty?.[slot] as AbilityInst | undefined;
  if (!cur || !orig || cur === orig) return;
  if (cur.passiveMod) { u.removeMod(cur.passiveMod); cur.passiveMod = null; }
  if (cur.toggled) { cur.toggled = false; cur.impl.onToggle?.(cur, false); }
  if (u.cast?.a === cur) u.w.interruptCast(u, true);
  u.abilities[slot] = orig;
}

/** Copia la habilidad `key` (nivel `level`) en un hueco de Rubick. */
function steal(a: AbilityInst, key: string, level: number) {
  const u = a.owner as Unit;
  u.data_rubickEmpty ??= {};
  for (const s of SLOT_EMPTY) if (!u.data_rubickEmpty[s] && u.abilities[s]) u.data_rubickEmpty[s] = u.abilities[s];
  // Ya la tiene: solo se refresca la duración.
  const have = SLOT_EMPTY.find((s) => u.abilities[s]?.key === key && u.abilities[s] !== u.data_rubickEmpty[s]);
  const slots = hasScepter(u) ? SLOT_EMPTY : [SLOT_EMPTY[0]];
  let slot = have ?? slots.find((s) => u.abilities[s] === u.data_rubickEmpty[s]);
  if (slot === undefined) {
    // Sin hueco libre: sustituye la más antigua.
    slot = slots.slice().sort((p, q) => (u.abilities[p].data.stolenAt ?? 0) - (u.abilities[q].data.stolenAt ?? 0))[0];
  }
  if (have === undefined) {
    dropStolen(u, slot);
    const inst = makeAbility(u, key, slot);
    if (!inst) return;
    // Copia de la implementación: no se sube con puntos ni sigue a otros huecos.
    inst.impl = { ...inst.impl, sub: true, levelWith: undefined, innate: false };
    inst.level = Math.max(1, level);
    inst.upg.cd = 1 - val(a, 'stolen_spell_cooldown_percent') / 100;
    const red = val(a, 'stolen_mana_reduction') / 100;
    if (red > 0) inst.mult._mc = 1 - red;
    if (inst.impl.charges) inst.charges = inst.impl.charges(inst)[0];
    inst.data.stolen = true;
    u.abilities[slot] = inst;
    refreshPassive(inst);
  }
  u.abilities[slot].data.stolenAt = u.w.time;
  // El modificador marca la duración; al expirar (o morir) se pierde el hechizo.
  const s = slot;
  u.addMod({
    name: 'spell_steal_' + s, duration: dur(a, 'duration'), fx: 'spell_steal', data: { key },
    onDestroy(m) { if (u.abilities[s]?.key === m.data.key) dropStolen(u, s); },
  }, u, a).remaining = dur(a, 'duration');
}

defineAbility({
  key: 'rubick_spell_steal', target: 'unit', ult: true, reflectable: true, ai: { role: 'nuke' },
  castRange: (a) => (hasScepter(a.owner as Unit) ? val(a, 'cast_range_scepter') : val(a, 'abilitycastrange')),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const e = t.unit as Unit;
    const last = e.data_lastSpell as { key: string; level: number } | undefined;
    u.w.addProjectile({
      kind: 'track', fx: 'spell_steal', source: e, target: u, x: e.x, y: e.y,
      speed: val(a, 'projectile_speed'), dodgeable: false,
      onHit() { if (last && u.alive) steal(a, last.key, last.level); return true; },
    });
  },
});

const CURIOSITY = 'rubick_curiosity';

/** Curiosity: cargas temporales al ver lanzar a un héroe enemigo cerca. */
function curiosityGain(r: Unit, from: Unit) {
  const a = abil(r, CURIOSITY);
  const m = a?.passiveMod;
  if (!a || !m || r.kind !== 'hero') return;
  const list = m.data.temp as { from: number; until: number }[];
  for (let i = 0; i < val(a, 'curiosity_per_spell_cast'); i++) list.push({ from: from.id, until: r.w.time + val(a, 'curiosity_duration') });
  r.refreshStats();
}

// Curiosity (innata): daño base por nivel, cargas temporales y permanentes por muertes.
// El aumento de duración de buffs/debuffs y de áreas no está modelado.
defineAbility({
  key: 'rubick_curiosity', target: 'passive', innate: true,
  passive: (a) => ({
    // Vigila los hechizos de todos los héroes enemigos (para Spell Steal y Curiosity).
    aura: {
      radius: 0, team: 'enemy', global: true, heroesOnly: true,
      apply: () => ({
        name: 'rubick_watch',
        onAbilityExecuted(m, ab) {
          if (isItem(ab)) return;
          const caster = m.owner as Unit;
          const inst = ab as AbilityInst;
          if (inst.impl.target === 'passive' || inst.impl.innate || inst.impl.sub || inst.temp || inst.data.stolen) return;
          caster.data_lastSpell = { key: inst.key, level: inst.level };
          const r = m.caster as Unit;
          if (r?.alive && Math.hypot(r.x - caster.x, r.y - caster.y) <= val(a, 'charge_radius')) curiosityGain(r, caster);
        },
        // Talento: amplificación de hechizo solo para los robados.
        onIncomingDamage(m, ev) {
          const ss = m.caster ? abil(m.caster as Unit, 'rubick_spell_steal') : undefined;
          const amp = ss && ss.level > 0 ? val(ss, 'spell_amp_percent') : 0;
          if (amp > 0 && ev.source === m.caster && (ev.ability as AbilityInst | null)?.data?.stolen) ev.amount *= 1 + amp / 100;
        },
      }),
    },
    name: 'curiosity', data: { temp: [] as { from: number; until: number }[], perm: a.data.perm ?? 0 },
    props: (m) => {
      const u = m.owner as Unit;
      const f = val(a, 'curiosity_factor') || 1;
      m.stacks = u.level * val(a, 'curiosity_per_level') + m.data.temp.length + m.data.perm;
      return { damage: m.stacks * val(a, 'curiosity_attack_damage') * f };
    },
    onTick(m) {
      const u = m.owner as Unit;
      const before = m.data.temp.length;
      m.data.temp = (m.data.temp as { until: number }[]).filter((x) => x.until > u.w.time);
      if (m.data.temp.length !== before) u.refreshStats();
    },
    onAnyDeath(m, victim) {
      const u = m.owner as Unit;
      if (victim.kind !== 'hero' || victim.team === u.team) return;
      const has = (m.data.temp as { from: number }[]).some((x) => x.from === victim.id);
      const recent = u.w.time - (victim.damagedBy.get(u.id) ?? -99) <= val(a, 'grace_period');
      if (!has || !recent) return;
      a.data.perm = (a.data.perm ?? 0) + val(a, 'curiosity_per_kill');
      m.data.perm = a.data.perm;
      u.refreshStats();
    },
  }),
});

defineHero('rubick', [
  'rubick_telekinesis', 'rubick_fade_bolt', 'rubick_arcane_supremacy', 'rubick_empty1', 'rubick_empty2',
  'rubick_spell_steal', 'rubick_telekinesis_land', 'rubick_hidden1', 'rubick_hidden2', 'rubick_curiosity',
  'rubick_telekinesis_land_self', 'rubick_hidden3', 'rubick_hidden4', 'rubick_hidden5',
], {
  build: ['null_talisman', 'arcane_boots', 'force_staff', 'blink', 'aether_lens', 'ultimate_scepter', 'black_king_bar', 'octarine_core'],
});

