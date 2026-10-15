import { defineAbility, defineHero, dmg, dur, hasShard, val } from '../sim/abilities';
import { damage } from '../sim/combat';
import type { AbilityInst } from '../sim/types';
import { ST } from '../sim/types';
import type { Unit } from '../sim/unit';
import { abil } from './lib/a7';
import { debuff, stun } from './util';

const HAZE = 'slardar_amplify_damage';
const PUDDLE_FX = 'slardar_puddle';

/** Charco de agua (Slithereen Crush, rastro de Corrosive Haze): es una zona sin efecto propio. */
function puddle(u: Unit, x: number, y: number, r: number, duration: number) {
  u.w.addZone({ fx: PUDDLE_FX, x, y, r, team: u.team, interval: 999, duration, onInterval() {} });
}

const inPuddle = (u: Unit) => u.w.zones.some((z) => z.fx === PUDDLE_FX && z.until > u.w.time && Math.hypot(z.x - u.x, z.y - u.y) <= z.r);

/** Corrosive Haze sobre `e` durante `d` segundos. */
function haze(u: Unit, a: AbilityInst, e: Unit, d: number, trail: boolean) {
  const m = debuff(u, e, a, {
    name: 'corrosive_haze', duration: d, fx: 'corrosive_haze', states: ST.revealed,
    purgable: val(a, 'undispellable') <= 0,
    props: { armor: val(a, 'armor_reduction') },
    interval: 0.5,
    // El objetivo deja un rastro de agua.
    onInterval(mm) {
      if (!trail) return;
      const v = mm.owner as Unit;
      puddle(u, v.x, v.y, val(a, 'puddle_radius'), val(a, 'puddle_duration'));
    },
  });
  if (m) e.addMod({ name: 'reveal', duration: m.remaining, data: { team: u.team }, purgable: m.purgable }, u, a);
  return m;
}

defineAbility({
  key: 'slardar_sprint', target: 'none', ai: { role: 'buff', selfRadius: 900 },
  onSpellStart(a) {
    const u = a.owner as Unit;
    const d = dur(a, 'duration');
    const burst = val(a, 'speed_burst_max_duration');
    u.addMod({
      name: 'guardian_sprint', duration: d, fx: 'sprint', states: ST.noCollision,
      props: (m) => {
        const t = m.duration - m.remaining;
        const res = t <= burst ? 1 : Math.max(0, 1 - (t - burst) / Math.max(0.1, m.duration - burst));
        return { msPct: val(a, 'bonus_speed') / 100, slowResist: res * val(a, 'slow_resistance_tooltip') / 100 };
      },
      onTick(m) { if (u.w.tickN % 6 === 0) (m.owner as Unit).refreshStats(); },
    }, u, a);
  },
});

defineAbility({
  key: 'slardar_slithereen_crush', target: 'none', ai: { role: 'disable', selfRadius: 300 },
  aoe: (a) => val(a, 'crush_radius'),
  onSpellStart(a) {
    const u = a.owner as Unit;
    const r = val(a, 'crush_radius');
    const st = dur(a, 'stun_duration');
    const hz = abil(u, HAZE);
    u.w.emit({ n: 'slithereen_crush', x: u.x, y: u.y, r, u: u.id, t: u.team });
    puddle(u, u.x, u.y, val(a, 'puddle_radius'), val(a, 'puddle_duration'));
    for (const e of u.w.enemiesIn(u.team, u.x, u.y, r)) {
      damage(u, e, dmg(a, 'crush_damage'), 'physical', a);
      stun(u, e, st, a);
      debuff(u, e, a, {
        name: 'crush_slow', duration: st + val(a, 'crush_extra_slow_duration'), fx: 'slow',
        props: (m) => (m.duration - m.remaining < st ? {} : {
          msSlow: Math.abs(val(a, 'crush_extra_slow')) / 100, attackSlow: Math.abs(val(a, 'crush_attack_slow_tooltip')),
        }),
        onTick(m) { if (Math.abs(m.duration - m.remaining - st) < 0.04) (m.owner as Unit).refreshStats(); },
      });
      // Shard: aplica Corrosive Haze unos segundos.
      if (hasShard(u) && hz && hz.level > 0) haze(u, hz, e, val(a, 'shard_amp_duration'), false);
    }
  },
});

defineAbility({
  key: 'slardar_bash', target: 'passive',
  passive: (a) => ({
    name: 'bash_of_the_deep', stacks: 0, data: { count: 0 },
    onAttackLanded(m, ev) {
      const u = ev.attacker as Unit, t = ev.target as Unit;
      if (u.kind === 'illusion' || t.team === u.team || t.kind === 'ward') return;
      if (m.data.count >= val(a, 'attack_count')) {
        m.data.count = 0;
        ev.damage += dmg(a, 'bonus_damage');
        stun(u, t, dur(a, 'duration'), a);
        u.w.emit({ n: 'bash', x: t.x, y: t.y, u: t.id });
      } else m.data.count++;
      m.stacks = m.data.count;
    },
  }),
});

defineAbility({
  key: 'slardar_seaborn_sentinel', target: 'passive', innate: true,
  passive: (a) => ({
    name: 'seaborn_sentinel', data: { inside: false },
    props: (m) => (m.data.inside ? {
      msFlat: val(a, 'river_speed'), hpRegen: val(a, 'puddle_regen'), armor: val(a, 'puddle_armor'),
      damagePct: val(a, 'river_damage_pct') / 100, statusResist: val(a, 'puddle_status_resistance') / 100,
    } : {}),
    onTick(m) {
      const u = m.owner as Unit;
      if (u.w.tickN % 6 !== 0) return;
      const inside = inPuddle(u);
      if (inside !== m.data.inside) { m.data.inside = inside; m.fx = inside ? 'seaborn' : undefined; u.refreshStats(); }
    },
  }),
});

defineAbility({
  key: 'slardar_amplify_damage', target: 'unit', ult: true, reflectable: true, ai: { role: 'nuke' },
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    haze(u, a, t.unit as Unit, dur(a, 'duration'), true);
  },
});

defineHero('slardar', ['slardar_sprint', 'slardar_slithereen_crush', 'slardar_bash', 'slardar_seaborn_sentinel', 'slardar_amplify_damage'], {
  build: ['bracer', 'phase_boots', 'blink', 'black_king_bar', 'assault', 'ultimate_scepter', 'abyssal_blade'],
});
