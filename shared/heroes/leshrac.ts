import { cooldownOf, defineAbility, defineHero, dmg, dur, manaCostOf, val } from '../sim/abilities';
import { damage } from '../sim/combat';
import type { AbilityInst } from '../sim/types';
import { ST } from '../sim/types';
import type { Unit } from '../sim/unit';
import { canDebuff, debuff, slow, stun } from './util';

/** Defilement (innata): las áreas de Leshrac crecen con su inteligencia. */
function area(u: Unit, base: number) {
  const d = u.abilities.find((x) => x.key === 'leshrac_defilement');
  if (!d || d.level <= 0 || u.has(ST.broken)) return base;
  return base + u.s.int * val(d, 'aoe_per_int');
}
const lsOf = (u: Unit) => u.abilities.find((x) => x.key === 'leshrac_lightning_storm');

/** Lightning Storm: rayo al objetivo que salta a enemigos cercanos con un pequeño retraso. */
function lightningStorm(a: AbilityInst, first: Unit) {
  const u = a.owner as Unit;
  const hit = new Set<number>();
  const radius = area(u, val(a, 'radius'));
  let jumps = val(a, 'jump_count');
  const strike = (t: Unit, from: { x: number; y: number }) => {
    hit.add(t.id);
    u.w.emit({ n: 'lightning', x: from.x, y: from.y, x2: t.x, y2: t.y, u: t.id, t: u.team });
    if (canDebuff(u, t, a)) {
      damage(u, t, dmg(a, 'damage'), 'magical', a);
      slow(u, t, a, 'lightning_storm_slow', val(a, 'slow_duration'), val(a, 'movespeed_slow') / 100);
    }
    if (jumps-- <= 0) return;
    const pos = { x: t.x, y: t.y };
    u.w.after(val(a, 'jump_delay'), () => {
      const next = u.w.enemiesIn(u.team, pos.x, pos.y, radius)
        .filter((e) => !hit.has(e.id) && e.kind !== 'ward' && u.w.canSee(u.team, e))
        .sort((p, q) => Math.hypot(p.x - pos.x, p.y - pos.y) - Math.hypot(q.x - pos.x, q.y - pos.y))[0];
      if (next) strike(next, pos);
    });
  };
  strike(first, { x: first.x, y: first.y - 300 });
}

defineAbility({
  key: 'leshrac_split_earth', target: 'point', ai: { role: 'disable' },
  aoe: (a) => area(a.owner as Unit, val(a, 'radius')),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const base = area(u, val(a, 'radius'));
    const boom = (r: number) => {
      u.w.emit({ n: 'split_earth', x: t.x, y: t.y, r, t: u.team });
      u.w.cutTrees(t.x, t.y, r);
      for (const e of u.w.enemiesIn(u.team, t.x, t.y, r)) {
        if (!canDebuff(u, e, a)) continue;
        damage(u, e, dmg(a, 'abilitydamage'), 'magical', a);
        stun(u, e, dur(a, 'duration'), a);
      }
    };
    const delay = val(a, 'delay');
    u.w.after(delay, () => boom(base));
    // Shard: se repite en el mismo sitio con más radio.
    const reps = val(a, 'shard_max_count');
    for (let i = 1; i <= reps; i++) {
      u.w.after(delay + i * val(a, 'shard_secondary_delay'), () => boom(base + i * val(a, 'shard_radius_increase')));
    }
  },
});

defineAbility({
  key: 'leshrac_diabolic_edict', target: 'none', ai: { role: 'aoe', selfRadius: 400 },
  aoe: (a) => area(a.owner as Unit, val(a, 'radius')),
  onSpellStart(a) {
    const u = a.owner as Unit;
    const d = val(a, 'abilityduration');
    const n = val(a, 'num_explosions');
    u.addMod({
      name: 'diabolic_edict', duration: d + 0.05, interval: d / Math.max(1, n), fx: 'diabolic_edict', purgable: false,
      onInterval() {
        const r = area(u, val(a, 'radius'));
        // Cuantas menos unidades haya, más explosiones recibe cada una.
        const pool = u.w.enemiesIn(u.team, u.x, u.y, r);
        for (let k = 0; k < val(a, 'targets') && pool.length; k++) {
          const i = Math.floor(u.w.rng() * pool.length);
          const e = pool.splice(i, 1)[0];
          u.w.emit({ n: 'edict', x: e.x, y: e.y, u: e.id, t: u.team });
          damage(u, e, dmg(a, 'damage'), 'pure', a, { noProc: true });
        }
      },
    }, u, a);
  },
});

defineAbility({
  key: 'leshrac_lightning_storm', target: 'unit', reflectable: true, ai: { role: 'nuke' },
  onSpellStart(a, t) { if (t.unit) lightningStorm(a, t.unit as Unit); },
});

defineAbility({
  key: 'leshrac_greater_lightning_storm', target: 'none', ai: { role: 'aoe', selfRadius: 450 },
  aoe: (a) => area(a.owner as Unit, val(a, 'radius')),
  onSpellStart(a) {
    const u = a.owner as Unit;
    const r = area(u, val(a, 'radius'));
    const d = dur(a, 'duration');
    const amp = val(a, 'magic_amp') / 100;
    u.w.emit({ n: 'nihilism', x: u.x, y: u.y, r, u: u.id, t: u.team });
    // Etéreo propio: no ataca ni recibe daño físico, pero corre más y no sufre la amplificación.
    u.addMod({
      name: 'nihilism', duration: d, fx: 'ethereal', states: ST.disarmed,
      props: { msPct: val(a, 'slow') / 100 },
      onIncomingDamage(_m, ev) { if (ev.type === 'physical' && !ev.hpRemoval) ev.amount = 0; },
    }, u, a);
    for (const e of u.w.enemiesIn(u.team, u.x, u.y, r)) {
      debuff(u, e, a, {
        name: 'nihilism', duration: d, fx: 'ethereal', states: ST.disarmed,
        props: { msSlow: val(a, 'slow') / 100 },
        onIncomingDamage(_m, ev) {
          if (ev.type === 'physical' && !ev.hpRemoval) ev.amount = 0;
          else if (ev.type === 'magical') ev.amount *= 1 + amp;
        },
      });
    }
  },
});

defineAbility({
  key: 'leshrac_defilement', target: 'passive', innate: true,
  passive: () => ({ name: 'defilement' }),
});

/** Un pulso de Pulse Nova. */
function pulse(a: AbilityInst) {
  const u = a.owner as Unit;
  const r = area(u, val(a, 'radius'));
  u.w.emit({ n: 'pulse_nova', x: u.x, y: u.y, r, u: u.id, t: u.team });
  for (const e of u.w.enemiesIn(u.team, u.x, u.y, r)) {
    if (canDebuff(u, e, a)) damage(u, e, dmg(a, 'damage'), 'magical', a, { noProc: true });
  }
}

defineAbility({
  key: 'leshrac_pulse_nova', target: 'toggle', ult: true, ai: { role: 'aoe' },
  onToggle(a, on) {
    const u = a.owner as Unit;
    if (!on) { u.removeModsByName('pulse_nova'); a.cd = cooldownOf(a); return; }
    u.mana -= manaCostOf(a);
    a.cd = cooldownOf(a);
    pulse(a);
    u.addMod({
      name: 'pulse_nova', fx: 'pulse_nova', interval: 1, data: { ls: 0 },
      props: () => ({ incomingPct: -val(a, 'damage_resistance') / 100 }),
      onInterval(m) {
        const cost = val(a, 'mana_cost_per_second');
        if (u.mana < cost) { a.toggled = false; u.removeMod(m); return; }
        u.mana -= cost;
        pulse(a);
        // Talento: cada pocos segundos lanza un Lightning Storm a un enemigo del área.
        const every = val(a, 'pulse_nova_lightning_interval');
        const ls = lsOf(u);
        if (every > 0 && ls && ls.level > 0 && ++m.data.ls >= every) {
          const list = u.w.enemiesIn(u.team, u.x, u.y, area(u, val(a, 'radius'))).filter((e) => e.kind !== 'ward' && canDebuff(u, e, ls));
          if (list.length) { m.data.ls = 0; lightningStorm(ls, list[Math.floor(u.w.rng() * list.length)]); }
        }
      },
      onDestroy() { a.toggled = false; },
    }, u, a);
  },
});

defineHero('leshrac', [
  'leshrac_split_earth', 'leshrac_diabolic_edict', 'leshrac_lightning_storm', 'leshrac_greater_lightning_storm',
  'leshrac_defilement', 'leshrac_pulse_nova',
], {
  build: ['null_talisman', 'tranquil_boots', 'kaya', 'bloodstone', 'black_king_bar', 'ultimate_scepter', 'shivas_guard'],
});
