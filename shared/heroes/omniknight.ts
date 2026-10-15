import { cooldownOf, defineAbility, defineHero, dmg, dur, hasScepter, val } from '../sim/abilities';
import { damage, heal, launchAttack } from '../sim/combat';
import type { AbilityInst } from '../sim/types';
import { ST } from '../sim/types';
import type { Unit } from '../sim/unit';
import { slow } from './util';
import { allyRedirect } from './lib/a6';

/** Cura al aliado y daña (puro) a los enemigos de alrededor. `eff` = eficacia (Shard). */
function purify(a: AbilityInst, t: Unit, eff: number) {
  const u = a.owner as Unit;
  const amount = dmg(a, 'heal') * eff;
  heal(t, amount, u);
  const r = val(a, 'radius');
  u.w.emit({ n: 'purification', x: t.x, y: t.y, r, t: u.team });
  for (const e of u.w.enemiesIn(u.team, t.x, t.y, r)) damage(u, e, amount, 'pure', a);
}

defineAbility({
  key: 'omniknight_purification', target: 'unit', team: 'ally', allowSelf: true, ai: { role: 'heal' },
  aoe: (a) => val(a, 'radius'),
  passive: (a) => allyRedirect(a),
  onSpellStart(a, t) {
    const target = (t.unit as Unit) ?? (a.owner as Unit);
    purify(a, target, 1);
    // Shard: segunda purificación tras un retardo, con menos eficacia.
    const delay = val(a, 'recast_delay');
    const eff = val(a, 'recast_effectiveness_pct') / 100;
    if (delay > 0 && eff > 0) (a.owner as Unit).w.after(delay, () => { if (target.alive) purify(a, target, eff); });
  },
});

defineAbility({
  key: 'omniknight_martyr', target: 'unit', team: 'ally', allowSelf: true, ai: { role: 'buff' },
  passive: (a) => allyRedirect(a),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const e = (t.unit as Unit) ?? u;
    e.purge(true, false);
    e.addMod({
      name: 'repel', duration: dur(a, 'duration'), fx: 'repel', purgable: true,
      states: ST.magicImmune,
      props: { magicResist: val(a, 'magic_resist') / 100, hpRegen: val(a, 'base_hpregen') },
    }, u, a);
  },
});

/** Golpe de martillo: daño puro según el daño base, ralentiza y cura parte del daño en el tiempo. */
function hammerHit(a: AbilityInst, t: Unit) {
  const u = a.owner as Unit;
  const base = (u.s.dmgMin + u.s.dmgMax) / 2;
  const dealt = damage(u, t, base * dmg(a, 'base_damage') / 100, 'pure', a);
  slow(u, t, a, 'hammer_of_purity_slow', val(a, 'duration'), val(a, 'movement_slow') / 100);
  const total = dealt * val(a, 'heal_pct') / 100;
  const ticks = Math.max(1, val(a, 'total_ticks'));
  const every = val(a, 'heal_duration') / ticks;
  if (total > 0) u.addMod({
    name: 'hammer_of_purity_heal', duration: val(a, 'heal_duration') + 0.01, interval: every, data: { multi: true },
    onInterval() { heal(u, total / ticks, u, true); },
  }, u, a);
}

defineAbility({
  key: 'omniknight_hammer_of_purity', target: 'unit', reflectable: false, noIllusion: true, ai: { role: 'nuke' },
  // Autocast permanente: el primer ataque con la habilidad lista la consume.
  castRange: (a) => (a.owner as Unit).s.attackRange + val(a, 'attack_range_bonus'),
  passive: (a) => ({
    name: 'hammer_of_purity_orb',
    onAttackStart(m, ev) {
      if (ev.fake && !m.data.forced) return;
      if (m.data.forced || a.cd <= 0) {
        if (!m.data.forced) a.cd = cooldownOf(a);
        m.data.forced = false;
        m.data.pending = ev;
      }
    },
    onAttackLanded(m, ev) {
      if (m.data.pending !== ev) return;
      m.data.pending = null;
      hammerHit(a, ev.target as Unit);
    },
  }),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const e = t.unit as Unit;
    if (a.passiveMod) a.passiveMod.data.forced = true;
    launchAttack(u, e, true);
    if (a.passiveMod) a.passiveMod.data.forced = false;
    u.w.issueOrder(u, { type: 'attack', target: e.id });
  },
});

defineAbility({
  key: 'omniknight_degen_aura', target: 'passive', innate: true, noIllusion: true,
  passive: (a) => ({
    name: 'degen_aura',
    aura: {
      radius: val(a, 'radius'), team: 'enemy',
      apply: () => ({ name: 'degen_aura_slow', debuff: true, fx: 'slow', duration: val(a, 'linger_duration'), props: { msSlow: val(a, 'speed_bonus') / 100 } }),
    },
  }),
});

defineAbility({
  key: 'omniknight_guardian_angel', target: 'none', ult: true, ai: { role: 'buff', selfRadius: 700 },
  aoe: (a) => val(a, 'radius'),
  onSpellStart(a) {
    const u = a.owner as Unit;
    const global = val(a, 'is_global') > 0 || hasScepter(u);
    const r = val(a, 'radius');
    const amp = val(a, 'heal_and_regen_amp') / 100;
    u.w.emit({ n: 'guardian_angel', x: u.x, y: u.y, r: global ? 9999 : r, t: u.team });
    const allies = global ? u.w.list.filter((x) => x.alive && x.team === u.team && u.w.targetable(x) && x.kind !== 'fountain')
      : u.w.alliesIn(u.team, u.x, u.y, r);
    for (const al of allies) {
      al.addMod({
        name: 'guardian_angel', duration: dur(a, 'duration'), fx: 'guardian_angel', purgable: false,
        props: amp > 0 ? { hpRegenAmp: amp } : undefined,
        onIncomingDamage(_m, ev) { if (ev.type === 'physical' && !ev.hpRemoval) ev.amount = 0; },
      }, u, a);
    }
  },
});

defineHero('omniknight', ['omniknight_purification', 'omniknight_martyr', 'omniknight_hammer_of_purity', 'omniknight_degen_aura', 'omniknight_guardian_angel'], {
  build: ['bracer', 'phase_boots', 'holy_locket', 'mekansm', 'blink', 'pipe', 'ultimate_scepter', 'assault'],
});
