import { defineAbility, defineHero, dmg, dur, val } from '../sim/abilities';
import { damage } from '../sim/combat';
import type { AbilityInst } from '../sim/types';
import type { Unit } from '../sim/unit';
import { slow, stun, dot } from './util';
import { multicastTimes } from './lib/a5';

/** Repite `fn` con el retardo de Multicast; `fn(i)` recibe el número de repetición (0 = original). */
function multicast(u: Unit, a: AbilityInst, fn: (i: number) => void) {
  const n = a.temp ? 1 : multicastTimes(u);
  fn(0);
  if (n > 1) u.w.emit({ n: 'multicast', x: u.x, y: u.y, u: u.id, v: n });
  for (let i = 1; i < n; i++) u.w.after(val(a, 'multicast_delay') * i, () => fn(i));
}

/** Otros objetivos al azar para repeticiones de Multicast. */
function randomOthers(u: Unit, x: number, y: number, r: number, exclude: Set<number>, allies = false) {
  const list = (allies ? u.w.alliesIn(u.team, x, y, r, { heroes: true }) : u.w.enemiesIn(u.team, x, y, r))
    .filter((e) => !exclude.has(e.id) && e.kind !== 'ward' && u.w.canSee(u.team, e));
  return list.length ? list[Math.floor(u.w.rng() * list.length)] : null;
}

/** Autolanzamiento de los bots sobre aliados (el bot genérico solo apunta a enemigos). */
function botAlly(a: AbilityInst, pick: (u: Unit) => Unit | null) {
  return {
    name: 'autocast_' + a.key, interval: 0.5,
    onInterval() {
      const u = a.owner as Unit;
      if (!u.isBot || u.cast || u.w.castCheck(u, a)) return;
      const t = pick(u);
      if (t) u.w.issueOrder(u, { type: 'cast', slot: a.slot, target: t.id });
    },
  };
}

function fireblastHit(u: Unit, a: AbilityInst, e: Unit, amount: number) {
  if (!e.alive) return;
  u.w.emit({ n: 'fireblast', x: e.x, y: e.y, u: e.id, t: u.team });
  damage(u, e, amount, 'magical', a);
  stun(u, e, val(a, 'stun_duration') * a.upg.dur, a);
}

defineAbility({
  key: 'ogre_magi_fireblast', target: 'unit', reflectable: true, ai: { role: 'disable' },
  // Talento: los ataques pueden lanzar Fireblast.
  passive: (a) => ({
    name: 'fireblast_proc',
    onAttackLanded(_m, ev) {
      const u = ev.attacker as Unit;
      const pct = val(a, 'fireblast_proc');
      if (pct <= 0 || ev.fake || u.kind !== 'hero' || u.w.rng() >= pct / 100) return;
      fireblastHit(u, a, ev.target as Unit, dmg(a, 'fireblast_damage'));
    },
  }),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const e = t.unit as Unit;
    multicast(u, a, () => fireblastHit(u, a, e, dmg(a, 'fireblast_damage')));
  },
});

function igniteOn(u: Unit, a: AbilityInst, e: Unit) {
  u.w.addProjectile({
    kind: 'track', fx: 'ignite', source: u, target: e, x: u.x, y: u.y, speed: val(a, 'projectile_speed'), dodgeable: true,
    onHit() {
      const d = dur(a, 'duration');
      dot(u, e, a, 'ignite', d, dmg(a, 'burn_damage'), 'magical', 1, { fx: 'ignite' });
      slow(u, e, a, 'ignite_slow', d, val(a, 'slow_movement_speed_pct') / 100);
      return true;
    },
  });
}

defineAbility({
  key: 'ogre_magi_ignite', target: 'unit', reflectable: true, ai: { role: 'nuke' },
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const e = t.unit as Unit;
    const done = new Set<number>([e.id]);
    igniteOn(u, a, e);
    // Empapa también a otra unidad al azar; Multicast añade más.
    const other = randomOthers(u, e.x, e.y, val(a, 'ignite_multicast_aoe'), done);
    if (other) { done.add(other.id); igniteOn(u, a, other); }
    multicast(u, a, (i) => {
      if (i === 0) return;
      const o = randomOthers(u, u.x, u.y, val(a, 'ignite_multicast_aoe'), done);
      if (o) { done.add(o.id); igniteOn(u, a, o); }
    });
  },
});

function bloodlustOn(u: Unit, a: AbilityInst, t: Unit) {
  const self = t === u;
  t.addMod({
    name: 'bloodlust', duration: dur(a, 'duration'), fx: 'bloodlust',
    props: { msPct: val(a, 'bonus_movement_speed') / 100, attackSpeed: self ? val(a, 'self_bonus') : val(a, 'bonus_attack_speed') },
  }, u, a);
}

defineAbility({
  key: 'ogre_magi_bloodlust', target: 'unit', team: 'ally', allowSelf: true, ai: { role: 'buff' },
  passive: (a) => botAlly(a, (u) => {
    if (!u.findMod('bloodlust')) return u;
    return u.w.alliesIn(u.team, u.x, u.y, val(a, 'abilitycastrange'), { heroes: true }).find((x) => !x.findMod('bloodlust')) ?? null;
  }),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const e = (t.unit as Unit) ?? u;
    const done = new Set<number>([e.id]);
    multicast(u, a, (i) => {
      if (i === 0) { bloodlustOn(u, a, e); return; }
      const o = randomOthers(u, e.x, e.y, val(a, 'multicast_bloodlust_aoe'), done, true);
      if (o) { done.add(o.id); bloodlustOn(u, a, o); }
    });
  },
});

// Scepter: Fireblast que cuesta un % del maná actual y escala con la fuerza.
defineAbility({
  key: 'ogre_magi_unrefined_fireblast', target: 'unit', reflectable: true, ai: { role: 'nuke' },
  passive: (a) => ({
    name: 'unrefined_cost',
    onTick() {
      const u = a.owner as Unit;
      a.mult._mc = Math.max(0, u.mana * val(a, 'scepter_mana') / 100) / 400;
    },
  }),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const e = t.unit as Unit;
    multicast(u, a, () => fireblastHit(u, a, e, (val(a, 'base_damage') + val(a, 'str_multiplier') * u.s.str) * a.upg.dmg));
  },
});

// Shard: escudo que absorbe parte de los próximos ataques de héroes y responde con bolas de fuego.
function fireShieldOn(u: Unit, a: AbilityInst, t: Unit) {
  t.addMod({
    name: 'fire_shield', duration: val(a, 'duration'), fx: 'fire_shield', stacks: val(a, 'attacks'),
    onIncomingDamage(m, ev) {
      const src = ev.source as Unit | null;
      if (!ev.isAttack || !src || src.team === t.team || !src.isHeroLike) return;
      ev.amount *= 1 - val(a, 'damage_absorb_pct') / 100;
      u.w.addProjectile({
        kind: 'track', fx: 'fireball', source: t, target: src, x: t.x, y: t.y, speed: val(a, 'projectile_speed'),
        onHit() { damage(u, src, dmg(a, 'damage'), 'magical', a); return true; },
      });
      m.stacks--;
      if (m.stacks <= 0) m.remaining = 0.001;
    },
  }, u, a);
}

defineAbility({
  key: 'ogre_magi_smash', target: 'unit', team: 'ally', allowSelf: true, ai: { role: 'buff' },
  passive: (a) => botAlly(a, (u) => {
    if (!u.w.enemiesIn(u.team, u.x, u.y, 700, { heroes: true }).length) return null;
    if (!u.findMod('fire_shield')) return u;
    return u.w.alliesIn(u.team, u.x, u.y, val(a, 'abilitycastrange'), { heroes: true }).find((x) => !x.findMod('fire_shield')) ?? null;
  }),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const e = (t.unit as Unit) ?? u;
    const done = new Set<number>([e.id]);
    multicast(u, a, (i) => {
      if (i === 0) { fireShieldOn(u, a, e); return; }
      const o = randomOthers(u, e.x, e.y, val(a, 'multicast_fireshield_aoe'), done, true);
      if (o) { done.add(o.id); fireShieldOn(u, a, o); }
    });
  },
});

// Innata: maná por fuerza y puntos de habilidad extra a nivel 1 y 2.
defineAbility({
  key: 'ogre_magi_dumb_luck', target: 'passive', innate: true,
  passive: (a) => ({
    name: 'dumb_luck',
    props: () => {
      const u = a.owner as Unit;
      const str = u.s?.str ?? 0;
      return { mana: str * val(a, 'mana_per_str'), manaRegen: str * val(a, 'mana_regen_per_str') };
    },
    onTick() {
      const u = a.owner as Unit;
      if (u.kind !== 'hero') return;
      if (!a.data.p1 && u.level >= 1) { a.data.p1 = true; u.abilityPoints += val(a, 'level_one_ability_points'); }
      if (!a.data.p2 && u.level >= 2) { a.data.p2 = true; u.abilityPoints += val(a, 'level_two_ability_points'); }
      if (a.data.str !== u.s.str) { a.data.str = u.s.str; u.refreshStats(); }
    },
  }),
});

defineAbility({ key: 'ogre_magi_multicast', target: 'passive', ult: true });

defineHero('ogre_magi', ['ogre_magi_fireblast', 'ogre_magi_ignite', 'ogre_magi_bloodlust', 'ogre_magi_unrefined_fireblast', 'ogre_magi_smash', 'ogre_magi_dumb_luck', 'ogre_magi_multicast'], {
  build: ['bracer', 'phase_boots', 'hand_of_midas', 'blink', 'black_king_bar', 'ultimate_scepter', 'heart'],
});
