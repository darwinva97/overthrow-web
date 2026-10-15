import { cooldownOf, defineAbility, defineHero, dmg, dur, hasScepter, val } from '../sim/abilities';
import { creditHero, damage, heal } from '../sim/combat';
import type { Unit } from '../sim/unit';
import { debuff, silence } from './util';
import { dist, reveal } from './lib/a1';

defineAbility({
  key: 'bloodseeker_bloodrage', target: 'none', ai: { role: 'buff', selfRadius: 600 },
  onSpellStart(a) {
    const u = a.owner as Unit;
    u.addMod({
      name: 'bloodrage', duration: dur(a, 'duration'), fx: 'berserk', interval: 0.25,
      props: { attackSpeed: val(a, 'attack_speed'), spellAmp: val(a, 'spell_amp') / 100 },
      // Cuesta un % de la vida máxima por segundo (no letal).
      onInterval() {
        damage(u, u, u.s.maxHp * val(a, 'damage_pct') / 100 * 0.25, 'pure', a, { noProc: true, hpRemoval: true, data: { nonLethal: true } });
      },
      // Shard: los ataques hacen un % de la vida máxima del objetivo como daño puro.
      onAttackLanded(_m, ev) {
        const t = ev.target as Unit;
        const pct = val(a, 'max_health_dmg_pct');
        if (pct > 0 && !ev.missed && t.team !== u.team && t.alive) damage(u, t, t.s.maxHp * pct / 100, 'pure', a, { noProc: true });
      },
    }, u, a);
  },
});

defineAbility({
  key: 'bloodseeker_blood_bath', target: 'point', ai: { role: 'aoe' },
  aoe: (a) => val(a, 'radius'),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const r = val(a, 'radius');
    const delay = val(a, 'delay');
    u.w.emit({ n: 'lsa_warn', x: t.x, y: t.y, r, d: delay, t: u.team });
    u.w.addVision(u.team, t.x, t.y, r, delay + 1);
    u.w.after(delay, () => {
      u.w.emit({ n: 'blood_rite', x: t.x, y: t.y, r, t: u.team });
      for (const e of u.w.enemiesIn(u.team, t.x, t.y, r)) {
        damage(u, e, dmg(a, 'damage'), 'pure', a);
        if (e.alive) silence(u, e, dur(a, 'silence_duration'), a, 'blood_rite');
      }
    });
  },
});

defineAbility({
  key: 'bloodseeker_thirst', target: 'passive',
  passive: (a) => ({
    name: 'thirst', interval: 0.25, data: { bonus: 0 },
    props: (m) => ({ msPct: m.data.bonus }),
    onInterval(m) {
      const u = m.owner as Unit;
      let bonus = 0;
      const minP = val(a, 'min_bonus_pct'), maxP = val(a, 'max_bonus_pct');
      for (const e of u.w.list) {
        if (e.kind !== 'hero' || e.team === u.team || !e.alive) continue;
        const p = e.hp / e.s.maxHp * 100;
        if (p >= minP) continue;
        bonus += val(a, 'bonus_movement_speed') / 100 * Math.min(1, (minP - p) / (minP - maxP));
        // Por debajo del umbral: visión y True Sight sobre ese héroe.
        if (p <= val(a, 'visibility_threshold_pct')) reveal(u, e, 0.5, a);
      }
      if (Math.abs(bonus - m.data.bonus) > 1e-3) { m.data.bonus = bonus; u.refreshStats(); }
    },
  }),
});

defineAbility({
  key: 'bloodseeker_sanguivore', target: 'passive', innate: true, noIllusion: true,
  passive: (a) => ({
    name: 'sanguivore',
    onAnyDeath(m, victim, killer) {
      const u = m.owner as Unit;
      if (!u.alive || victim.team === u.team || victim.kind === 'fountain') return;
      const amount = val(a, 'base_heal') + victim.s.maxHp * val(a, 'heal_hp_pct') / 100;
      if (creditHero(killer as Unit) === u) {
        heal(u, amount * (victim.isHeroLike ? 1 : 1 - val(a, 'creep_lifesteal_reduction_pct') / 100), u);
      } else if (victim.kind === 'hero' && killer && killer.team === u.team && dist(victim, u) <= val(a, 'half_bonus_aoe')) {
        heal(u, amount / 2, u);
      }
    },
  }),
});

defineAbility({
  key: 'bloodseeker_rupture', target: 'unit', ult: true, reflectable: true, ai: { role: 'nuke', hpBelow: 0.8 },
  // Con Scepter tiene cargas.
  charges: (a) => [hasScepter(a.owner as Unit) ? Math.max(1, val(a, 'abilitycharges')) : 1, cooldownOf(a) / a.upg.cd],
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const e = t.unit as Unit;
    damage(u, e, e.hp * val(a, 'hp_pct') / 100, 'pure', a);
    if (!e.alive) return;
    let lx = e.x, ly = e.y;
    debuff(u, e, a, {
      name: 'rupture', duration: dur(a, 'duration'), fx: 'rupture', interval: 0.25,
      onInterval(m) {
        const v = m.owner as Unit;
        const moved = Math.hypot(v.x - lx, v.y - ly);
        lx = v.x; ly = v.y;
        // Los saltos grandes (blink, teletransporte) no cuentan.
        if (moved <= 0 || moved > val(a, 'damage_cap_amount')) return;
        damage(u, v, moved * val(a, 'movement_damage_pct') / 100 * a.upg.dmg, 'pure', a, { noProc: true });
      },
    });
  },
});

defineHero('bloodseeker', ['bloodseeker_bloodrage', 'bloodseeker_blood_bath', 'bloodseeker_thirst', 'bloodseeker_sanguivore', 'bloodseeker_rupture'], {
  build: ['wraith_band', 'phase_boots', 'maelstrom', 'black_king_bar', 'basher', 'mjollnir', 'abyssal_blade'],
});
