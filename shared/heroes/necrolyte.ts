import { defineAbility, defineHero, dmg, dur, val } from '../sim/abilities';
import { damage, heal } from '../sim/combat';
import type { AbilityInst } from '../sim/types';
import { ST } from '../sim/types';
import type { Unit } from '../sim/unit';
import { dash, debuff, stun } from './util';

/** Death Pulse desde un punto: proyectiles a cada enemigo (daño) y aliado (cura) del radio. */
function pulse(u: Unit, a: AbilityInst, x: number, y: number, speedMult = 1) {
  const r = val(a, 'area_of_effect');
  u.w.emit({ n: 'death_pulse', x, y, r, t: u.team });
  for (const t of u.w.unitsIn(x, y, r, (v) => u.w.targetable(v) && (v.isHeroLike || v.kind === 'creep' || v.kind === 'summon'))) {
    const enemy = t.team !== u.team;
    if (enemy && t.has(ST.invulnerable)) continue;
    u.w.addProjectile({
      kind: 'track', fx: enemy ? 'death_pulse' : 'death_pulse_heal', source: u, target: t, x, y,
      speed: val(a, 'projectile_speed') * speedMult,
      onHit() {
        if (enemy) damage(u, t, dmg(a, 'abilitydamage'), 'magical', a);
        else heal(t, val(a, 'heal') * a.upg.dmg, u);
        return true;
      },
    });
  }
}

defineAbility({
  key: 'necrolyte_death_pulse', target: 'none', ai: { role: 'aoe', selfRadius: 480 },
  onSpellStart(a) { const u = a.owner as Unit; pulse(u, a, u.x, u.y); },
});

defineAbility({
  key: 'necrolyte_ghost_shroud', target: 'none', ai: { role: 'buff', selfRadius: 500 },
  onSpellStart(a) {
    const u = a.owner as Unit;
    // Etéreo: el motor ya amplifica un 40% el daño mágico; se compensa hasta el valor del dataset.
    const amp = -val(a, 'bonus_damage') / 100;
    u.addMod({
      name: 'ghost_shroud', duration: dur(a, 'duration'), fx: 'ethereal',
      states: ST.ethereal | ST.disarmed,
      props: { healAmp: val(a, 'heal_bonus') / 100, magicResist: 1 - (1 + amp) / 1.4 },
      aura: {
        radius: val(a, 'slow_aoe'), team: 'enemy',
        apply: (_m, t) => ({
          name: 'ghost_shroud_slow', debuff: true, fx: 'slow',
          props: { msSlow: t.has(ST.magicImmune) ? 0 : val(a, 'movement_speed') / 100 },
        }),
      },
    }, u, a);
  },
});

defineAbility({
  key: 'necrolyte_heartstopper_aura', target: 'passive', noIllusion: true,
  passive: (a) => ({
    name: 'heartstopper',
    aura: {
      radius: val(a, 'aura_radius'), team: 'enemy',
      apply: () => ({
        name: 'heartstopper_aura', debuff: true, interval: 0.2,
        props: { healAmp: -val(a, 'heal_reduction_pct') / 100 },
        onInterval(m) {
          const t = m.owner as Unit;
          const u = a.owner as Unit;
          if (!t.isHeroLike && t.kind !== 'creep' && t.kind !== 'summon') return;
          // Scepter: suma un % de la regeneración actual de Necrophos.
          const pct = val(a, 'aura_damage') * a.upg.dmg / 100;
          const extra = u.s.hpRegen * val(a, 'heal_regen_to_damage') / 100;
          damage(u, t, (t.s.maxHp * pct + extra) * 0.2, 'magical', a, { noProc: true });
        },
      }),
    },
  }),
});

// Shard: se convierte en un gran Death Pulse que viaja hasta el objetivo.
defineAbility({
  key: 'necrolyte_death_seeker', target: 'unit', team: 'any', ai: { role: 'nuke' },
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const e = t.unit as Unit;
    const dp = u.abilities.find((x) => x.key === 'necrolyte_death_pulse');
    const speed = (dp && dp.level > 0 ? val(dp, 'projectile_speed') : 400) * val(a, 'projectile_multiplier') / 100;
    u.w.disjoint(u);
    dash(u, e.x, e.y, speed, a, {
      name: 'death_seeker', states: ST.invulnerable | ST.untargetable,
      onArrive() {
        if (e.alive && e.team !== u.team) {
          debuff(u, e, a, {
            name: 'death_seeker_ethereal', duration: val(a, 'ethereal_duration'), fx: 'ethereal',
            states: ST.ethereal | ST.disarmed,
          });
        }
        if (dp && dp.level > 0) pulse(u, dp, u.x, u.y);
      },
    });
  },
});

// Innata: regeneración apilable por cada muerte (los héroes multiplican).
defineAbility({
  key: 'necrolyte_sadist', target: 'passive', innate: true,
  passive: (a) => ({
    name: 'sadist_watch',
    onKill(m, v) {
      const u = m.owner as Unit;
      if (v.team === u.team) return;
      const n = v.kind === 'hero' ? val(a, 'hero_multiplier') : 1;
      const r = val(a, 'regen') * n;
      u.addMod({
        name: 'sadist', duration: val(a, 'regen_duration'), fx: 'sadist', data: { multi: true },
        props: { hpRegen: r, manaRegen: r },
      }, u, a);
    },
  }),
});

defineAbility({
  key: 'necrolyte_reapers_scythe', target: 'unit', ult: true, reflectable: true, ai: { role: 'nuke', hpBelow: 0.55 },
  passive: (a) => ({ name: 'reapers_scythe_regen', props: { hpRegen: a.data.hp ?? 0, manaRegen: a.data.mana ?? 0 } }),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const e = t.unit as Unit;
    const d = val(a, 'stun_duration');
    u.w.emit({ n: 'reapers_scythe', x: e.x, y: e.y, u: e.id, t: u.team });
    stun(u, e, d, a);
    u.w.after(d, () => {
      if (!e.alive) return;
      const missing = e.s.maxHp - e.hp;
      damage(u, e, missing * val(a, 'damage_per_health') * a.upg.dmg, 'magical', a);
      if (!e.alive && e.kind === 'hero' && !a.temp) {
        a.data.hp = (a.data.hp ?? 0) + val(a, 'hp_per_kill');
        a.data.mana = (a.data.mana ?? 0) + val(a, 'mana_per_kill');
        if (a.passiveMod) a.passiveMod.props = { hpRegen: a.data.hp, manaRegen: a.data.mana };
        u.refreshStats();
      }
    });
  },
});

defineHero('necrolyte', ['necrolyte_death_pulse', 'necrolyte_ghost_shroud', 'necrolyte_heartstopper_aura', 'necrolyte_death_seeker', 'necrolyte_sadist', 'necrolyte_reapers_scythe'], {
  build: ['null_talisman', 'arcane_boots', 'holy_locket', 'radiance', 'shivas_guard', 'ultimate_scepter', 'heart'],
});
