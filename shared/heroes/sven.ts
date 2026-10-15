import { lv } from '../data';
import { defineAbility, defineHero, dmg, dur, hasScepter, hasShard, val } from '../sim/abilities';
import { damage } from '../sim/combat';
import type { Unit } from '../sim/unit';
import { abilityOf, barrierSpec, cleave } from './lib/a0';
import { stun } from './util';

defineAbility({
  key: 'sven_storm_bolt', target: 'unit', reflectable: true, ai: { role: 'disable' },
  aoe: (a) => val(a, 'bolt_aoe'),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const e = t.unit as Unit;
    u.w.addProjectile({
      kind: 'track', fx: 'storm_bolt', source: u, target: e, x: u.x, y: u.y,
      speed: val(a, 'bolt_speed'), dodgeable: true,
      onHit() {
        const r = val(a, 'bolt_aoe');
        u.w.emit({ n: 'nova', x: e.x, y: e.y, r, t: u.team });
        u.w.addVision(u.team, e.x, e.y, val(a, 'vision_radius'), 2);
        const amount = dmg(a, 'abilitydamage') * (1 + val(a, 'bonus_damage_pct') / 100);
        const targets = u.w.enemiesIn(u.team, e.x, e.y, r);
        // Scepter: también alcanza al objetivo invulnerable y le quita los buffs.
        if (hasScepter(u) && e.alive && !targets.includes(e)) targets.push(e);
        for (const v of targets) {
          if (v === e && hasScepter(u)) v.purge(false, true);
          damage(u, v, amount, 'magical', a);
          stun(u, v, dur(a, 'bolt_stun_duration'), a);
        }
        return true;
      },
    });
  },
});

defineAbility({
  key: 'sven_great_cleave', target: 'passive',
  passive: (a) => ({
    name: 'great_cleave',
    onAttackLanded(_m, ev) {
      const u = ev.attacker as Unit;
      if (!u.melee || ev.target.team === u.team) return;
      cleave(u, ev.target as Unit, ev.damage * ev.critMult * val(a, 'great_cleave_damage') / 100,
        val(a, 'cleave_starting_width'), val(a, 'cleave_ending_width'), val(a, 'cleave_distance'), a);
    },
  }),
});

defineAbility({
  key: 'sven_warcry', target: 'none', ai: { role: 'buff', selfRadius: 700 },
  aoe: (a) => val(a, 'radius'),
  onSpellStart(a) {
    const u = a.owner as Unit;
    const radius = val(a, 'radius');
    const undispellable = val(a, 'undispellable') > 0;
    const barrier = val(a, 'base_barrier_amount') + val(a, 'barrier_per_strength') * u.s.str;
    u.w.emit({ n: 'berserkers_call', x: u.x, y: u.y, r: radius, u: u.id, t: u.team });
    for (const al of u.w.alliesIn(u.team, u.x, u.y, radius, { heroes: true })) {
      al.addMod({
        name: 'warcry', duration: dur(a, 'duration'), fx: 'haste', purgable: !undispellable,
        props: { armor: val(a, 'bonus_armor'), msPct: val(a, 'movespeed') / 100 },
      }, u, a);
      if (barrier > 0) al.addMod({ name: 'warcry_barrier', duration: dur(a, 'duration'), fx: 'barrier', ...barrierSpec(barrier) }, u, a);
    }
  },
});

defineAbility({
  key: 'sven_gods_strength', target: 'none', ult: true, ai: { role: 'buff', selfRadius: 500 },
  onSpellStart(a) {
    const u = a.owner as Unit;
    const wrath = abilityOf(u, 'sven_wrath_of_god');
    u.addMod({
      name: 'gods_strength', duration: dur(a, 'abilityduration'), fx: 'berserk',
      props: () => {
        const pct = val(a, 'gods_strength_damage') / 100;
        // También multiplica el daño base que añade Wrath of God.
        const extra = (wrath?.passiveMod?.data.bonus ?? 0) * pct;
        return { damagePct: pct, damage: extra, slowResist: val(a, 'bonus_slow_resistance') / 100 };
      },
    }, u, a);
  },
});

// Innata: daño base extra por cada punto de fuerza (0,08 + 0,02 por nivel).
defineAbility({
  key: 'sven_wrath_of_god', target: 'passive', innate: true,
  passive: (a) => ({
    name: 'wrath_of_god', interval: 0.5, data: { bonus: 0 },
    props: (m) => ({ damage: m.data.bonus }),
    onInterval(m) {
      const u = m.owner as Unit;
      const per = val(a, 'bonus_damage_per_str') + 0.02 * u.level;
      const bonus = Math.round(u.s.str * per);
      if (bonus !== m.data.bonus) { m.data.bonus = bonus; u.refreshStats(); }
    },
  }),
});

defineHero('sven', ['sven_storm_bolt', 'sven_great_cleave', 'sven_warcry', 'sven_gods_strength', 'sven_wrath_of_god'], {
  build: ['bracer', 'phase_boots', 'mask_of_madness', 'blink', 'black_king_bar', 'greater_crit', 'assault', 'satanic'],
});
