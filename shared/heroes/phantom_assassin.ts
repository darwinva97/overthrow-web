import { cooldownOf, defineAbility, defineHero, dur, hasShard, hasTalent, val } from '../sim/abilities';
import { damage, landAttack, makeAttack } from '../sim/combat';
import type { AbilityInst } from '../sim/types';
import { ST } from '../sim/types';
import type { Unit } from '../sim/unit';
import { debuff, slow } from './util';
import { abil } from './lib/a6';

/** Una puñalada: ataque falso con el daño reducido de la daga, sin fallo. */
function daggerAttack(a: AbilityInst, e: Unit) {
  const u = a.owner as Unit;
  if (!e.alive) return;
  const coup = abil(u, 'phantom_assassin_coup_de_grace');
  if (coup?.passiveMod) coup.passiveMod.data.dagger = true;
  const ev = makeAttack(u, e, true);
  if (coup?.passiveMod) coup.passiveMod.data.dagger = false;
  ev.damage = val(a, 'base_damage') + ev.damage * (1 + val(a, 'attack_factor') / 100);
  ev.trueStrike = true;
  landAttack(ev);
}

defineAbility({
  key: 'phantom_assassin_stifling_dagger', target: 'unit', reflectable: true, ai: { role: 'nuke' },
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const e = t.unit as Unit;
    u.w.addProjectile({
      kind: 'track', fx: 'stifling_dagger', source: u, target: e, x: u.x, y: u.y,
      speed: val(a, 'dagger_speed'), dodgeable: true,
      onHit() {
        if (e.has(ST.magicImmune) && e.team !== u.team) return true;
        slow(u, e, a, 'stifling_dagger', dur(a, 'duration'), Math.abs(val(a, 'move_slow')) / 100);
        daggerAttack(a, e);
        // Talento: la daga golpea tres veces.
        const extra = hasTalent(u, 'special_bonus_unique_phantom_assassin') ? Math.max(2, val(a, 'extra_daggers')) : 0;
        for (let i = 1; i <= extra; i++) u.w.after(0.15 * i, () => daggerAttack(a, e));
        return true;
      },
    });
  },
});

defineAbility({
  key: 'phantom_assassin_phantom_strike', target: 'unit', team: 'any', ai: { role: 'nuke' },
  charges: (a) => [Math.max(1, val(a, 'abilitycharges')), val(a, 'abilitychargerestoretime') * (1 - (a.owner as Unit).s.cdr)],
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const e = t.unit as Unit;
    u.w.disjoint(u);
    u.w.emit({ n: 'blink', x: u.x, y: u.y, u: u.id });
    // Aparece detrás del objetivo.
    const bx = e.x - Math.cos(e.facing) * (e.radius + u.radius), by = e.y - Math.sin(e.facing) * (e.radius + u.radius);
    u.w.teleport(u, bx, by);
    u.facing = Math.atan2(e.y - u.y, e.x - u.x);
    if (e.team === u.team) return;
    const target = e.id;
    u.addMod({
      name: 'phantom_strike', duration: dur(a, 'duration'), fx: 'phantom_strike',
      props: { attackSpeed: val(a, 'bonus_attack_speed') },
    }, u, a);
    u.w.issueOrder(u, { type: 'attack', target });
  },
});

defineAbility({
  key: 'phantom_assassin_blur', target: 'none', innate: true, ai: { role: 'buff', selfRadius: 1200 },
  castPoint: (a) => (hasShard(a.owner as Unit) ? 0 : val(a, 'abilitycastpoint')),
  passive: (a) => (hasShard(a.owner as Unit) ? {
    // Shard: cada muerte de héroe adelanta el 60% de los enfriamientos.
    name: 'blur_shard',
    onKill(_m, victim) {
      const u = a.owner as Unit;
      if (victim.kind !== 'hero' || victim.team === u.team) return;
      const pct = val(a, 'cooldown_refund_pct') / 100;
      for (const x of u.abilities) {
        if (x.impl.charges) { x.chargeCd = Math.max(0, x.chargeCd - x.impl.charges(x)[1] * pct); continue; }
        if (x.cd > 0 && x.cd < 1e5) x.cd = Math.max(0, x.cd - cooldownOf(x) * pct);
      }
    },
  } : null),
  onSpellStart(a) {
    const u = a.owner as Unit;
    u.w.disjoint(u);
    if (hasShard(u)) u.purge(true, false);
    u.w.emit({ n: 'fade', x: u.x, y: u.y, u: u.id });
    const r = val(a, 'radius');
    u.addMod({
      name: 'blur', duration: dur(a, 'duration'), fx: 'blur', states: ST.invisible,
      props: { msPct: val(a, 'active_movespeed_bonus') / 100 },
      onTick(m) {
        // Visible solo cerca de héroes enemigos.
        const near = u.w.enemiesIn(u.team, u.x, u.y, r, { heroes: true }).some((e) => e.kind === 'hero');
        const want = near ? 0 : ST.invisible;
        if ((m.states ?? 0) !== want) { m.states = want; u.refreshStats(); }
      },
    }, u, a);
  },
});

defineAbility({
  key: 'phantom_assassin_fan_of_knives', target: 'none', ai: { role: 'aoe', selfRadius: 500 },
  aoe: (a) => val(a, 'radius'),
  onSpellStart(a) {
    const u = a.owner as Unit;
    const r = val(a, 'radius');
    u.w.emit({ n: 'fan_of_knives', x: u.x, y: u.y, r, t: u.team });
    const x0 = u.x, y0 = u.y;
    for (const e of u.w.enemiesIn(u.team, x0, y0, r)) {
      const delay = Math.hypot(e.x - x0, e.y - y0) / val(a, 'projectile_speed');
      u.w.after(delay, () => {
        if (!e.alive) return;
        let amt = e.s.maxHp * val(a, 'pct_health_damage_initial') / 100;
        const cap = val(a, 'max_damage_initial');
        if (cap > 0) amt = Math.min(amt, cap);
        damage(u, e, amt, 'physical', a);
        debuff(u, e, a, {
          name: 'fan_of_knives', duration: val(a, 'duration'), fx: 'break', interval: 1,
          states: ST.broken, props: { healAmp: val(a, 'degen') / 100 },
          onInterval(m) { const v = m.owner as Unit; damage(u, v, v.s.maxHp * val(a, 'pct_health_damage') / 100, 'physical', a, { noProc: true }); },
        });
      });
    }
  },
});

defineAbility({
  key: 'phantom_assassin_immaterial', target: 'passive',
  passive: (a) => ({ name: 'immaterial', props: { evasion: val(a, 'evasion') / 100 } }),
});

defineAbility({
  key: 'phantom_assassin_coup_de_grace', target: 'passive', ult: true,
  passive: (a) => ({
    name: 'coup_de_grace', data: { dagger: false },
    onAttackStart(m, ev) {
      const u = ev.attacker as Unit;
      const focus = u.findMod('deadly_focus');
      if (focus) {
        ev.critMult = Math.max(ev.critMult, val(a, 'crit_bonus') / 100);
        u.removeMod(focus);
        u.w.emit({ n: 'coup_de_grace', x: ev.target.x, y: ev.target.y, u: ev.target.id });
        return;
      }
      const chance = (m.data.dagger ? val(a, 'dagger_crit_chance') : val(a, 'crit_chance')) / 100;
      if (u.w.rng() < chance) u.addMod({ name: 'deadly_focus', duration: val(a, 'duration'), fx: 'deadly_focus' }, u, a);
    },
  }),
});

defineHero('phantom_assassin', ['phantom_assassin_stifling_dagger', 'phantom_assassin_phantom_strike', 'phantom_assassin_blur', 'phantom_assassin_fan_of_knives', 'phantom_assassin_immaterial', 'phantom_assassin_coup_de_grace'], {
  build: ['wraith_band', 'phase_boots', 'bfury', 'desolator', 'black_king_bar', 'basher', 'satanic', 'abyssal_blade'],
});
