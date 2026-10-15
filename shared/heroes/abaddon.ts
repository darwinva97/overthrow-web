import { cooldownOf, defineAbility, defineHero, dmg, dur, hasScepter, val } from '../sim/abilities';
import { damage, heal } from '../sim/combat';
import type { AbilityInst } from '../sim/types';
import { ST } from '../sim/types';
import type { Unit } from '../sim/unit';
import { debuff, dot, slow } from './util';
import { botOnly, botTick, enemyHeroes } from './lib/a1';

const coilOf = (u: Unit) => u.abilities.find((x) => x.key === 'abaddon_death_coil');

/** Lanza un Mist Coil (también los automáticos del Scepter, que no cuestan vida). */
function fireCoil(a: AbilityInst, target: Unit, selfCost: boolean) {
  const u = a.owner as Unit;
  if (selfCost) {
    const cost = target.team === u.team ? val(a, 'self_damage') : val(a, 'self_damage_enemy_target');
    damage(u, u, cost, 'pure', a, { noProc: true, hpRemoval: true, data: { nonLethal: true } });
  }
  u.w.addProjectile({
    kind: 'track', fx: 'death_coil', source: u, target, x: u.x, y: u.y,
    speed: val(a, 'missile_speed'), dodgeable: true,
    onHit() {
      const amount = dmg(a, 'damage_heal');
      const r = val(a, 'effect_radius');
      const hit = r > 0 ? u.w.unitsIn(target.x, target.y, r, (v) => u.w.targetable(v) && v.kind !== 'fountain' && v.kind !== 'ward') : [target];
      if (!hit.includes(target)) hit.push(target);
      for (const v of hit) {
        if (v === u && v !== target) continue;
        if (v.team === u.team) heal(v, amount, u);
        else if (v === target || !v.has(ST.magicImmune)) damage(u, v, amount, 'magical', a);
      }
      return true;
    },
  });
}

defineAbility({
  key: 'abaddon_death_coil', target: 'unit', team: 'any', reflectable: true, ai: { role: 'nuke' },
  onSpellStart(a, t) { fireCoil(a, t.unit as Unit, true); },
});

defineAbility({
  key: 'abaddon_aphotic_shield', target: 'unit', team: 'ally', allowSelf: true,
  // Bots: sobre sí mismo o un aliado herido o aturdido en pelea.
  passive: (a) => botOnly(a, (u) => {
    if (!enemyHeroes(u, 900).length) return null;
    const allies = u.w.alliesIn(u.team, u.x, u.y, 600, { heroes: true }).filter((h) => h.kind === 'hero');
    const t = allies.find((h) => h.hp / h.s.maxHp < 0.75 || h.has(ST.stunned) || h.has(ST.silenced));
    return t ? { unit: t } : null;
  }),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const e = t.unit as Unit;
    e.purge(true, false, true);
    const absorb = dmg(a, 'damage_absorb');
    const radius = val(a, 'radius');
    e.addMod({
      name: 'aphotic_shield', duration: dur(a, 'duration'), fx: 'barrier', data: { left: absorb },
      props: { hpRegen: val(a, 'regen') },
      onIncomingDamage(m, ev) {
        if (ev.hpRemoval || m.data.left <= 0) return;
        const took = Math.min(ev.amount, m.data.left);
        m.data.left -= took;
        ev.amount -= took;
        // Shard: el 75% de lo absorbido daña a los enemigos cercanos.
        const pct = val(a, 'absorb_to_damage') / 100;
        if (pct > 0 && took > 0) {
          const v = m.owner as Unit;
          for (const en of u.w.enemiesIn(v.team, v.x, v.y, val(a, 'absorb_damage_aoe'))) {
            damage(u, en, took * pct, 'magical', a, { noProc: true, data: { reflected: true } });
          }
        }
        if (m.data.left <= 0) m.remaining = 0.001;
      },
      onDestroy(m) {
        const v = m.owner as Unit;
        if (!v.alive) return;
        u.w.emit({ n: 'nova', x: v.x, y: v.y, r: radius, t: u.team });
        for (const en of u.w.enemiesIn(v.team, v.x, v.y, radius)) damage(u, en, absorb, 'magical', a);
      },
    }, u, a);
  },
});

defineAbility({
  key: 'abaddon_frostmourne', target: 'passive',
  passive: (a) => ({
    name: 'frostmourne',
    onAttackLanded(_m, ev) {
      const u = ev.attacker as Unit, t = ev.target as Unit;
      if (t.team === u.team || ev.missed) return;
      const caster = u.kind === 'illusion' ? (u.owner as Unit) : u;
      slow(caster, t, a, 'frostmourne_slow', val(a, 'slow_duration'), val(a, 'curse_slow') / 100);
      dot(caster, t, a, 'curse_of_avernus', val(a, 'curse_duration'), dmg(a, 'curse_dps'), 'magical', val(a, 'curse_interval'), {
        fx: 'frostbite',
        // Quien ataque al maldito gana velocidad de ataque.
        onAttacked(m, aev) {
          const at = aev.attacker as Unit;
          if (at.team !== caster.team) return;
          at.addMod({ name: 'curse_of_avernus_buff', duration: val(a, 'curse_duration'), props: { attackSpeed: val(a, 'curse_attack_speed') } }, caster, a);
          void m;
        },
      });
    },
  }),
});

defineAbility({
  key: 'abaddon_withering_mist', target: 'passive', innate: true, noIllusion: true,
  passive: (a) => ({
    name: 'withering_mist_passive',
    onDealDamage(_m, ev) {
      const u = _m.owner as Unit, t = ev.target as Unit;
      if (t.team === u.team || ev.amount <= 0 || !t.alive || t.kind === 'fountain') return;
      const thr = val(a, 'hp_threshold_pct') / 100;
      const red = val(a, 'heal_reduction_pct') / 100;
      debuff(u, t, a, {
        name: 'withering_mist', duration: val(a, 'duration'), interval: 0.25,
        props: (m) => { const v = m.owner as Unit; return v.hp / v.s.maxHp < thr ? { hpRegenAmp: -red } : {}; },
        onInterval(m) { (m.owner as Unit).refreshStats(); },
      });
    },
  }),
});

function borrowedTime(a: AbilityInst) {
  const u = a.owner as Unit;
  u.purge(true, false, true);
  const coil = coilOf(u);
  const thr = val(a, 'ally_threshold_scepter');
  u.addMod({
    name: 'borrowed_time', duration: dur(a, 'duration'), fx: 'borrowed_time', interval: val(a, 'immolate_tick'),
    onIncomingDamage(_m, ev) {
      if (ev.amount <= 0) return;
      heal(u, ev.amount, u);
      ev.amount = 0;
    },
    onInterval() {
      const d = val(a, 'immolate_damage');
      if (d <= 0) return;
      for (const e of u.w.enemiesIn(u.team, u.x, u.y, val(a, 'immolate_aoe'))) {
        damage(u, e, d * val(a, 'immolate_tick'), 'magical', a, { noProc: true });
      }
    },
    // Scepter: los aliados cercanos que reciben mucho daño reciben un Mist Coil.
    aura: hasScepter(u) && coil && coil.level > 0 ? {
      radius: val(coil, 'abilitycastrange') + u.s.castRange, team: 'ally', heroesOnly: true, includeSelf: false,
      apply: () => ({
        name: 'borrowed_time_ally',
        onTakeDamage(m, ev) {
          m.data.acc = (m.data.acc ?? 0) + ev.amount;
          if (m.data.acc >= thr) { m.data.acc -= thr; fireCoil(coil, m.owner as Unit, false); }
        },
      }),
    } : undefined,
  }, u, a);
}

defineAbility({
  key: 'abaddon_borrowed_time', target: 'none', ult: true, noIllusion: true,
  passive: (a) => ({
    name: 'borrowed_time_passive',
    // Se activa sola al bajar del umbral si no está en enfriamiento (no con Break).
    onIncomingDamage(_m, ev) {
      const u = a.owner as Unit;
      if (a.cd > 0 || u.has(ST.broken) || u.findMod('borrowed_time') || ev.amount <= 0) return;
      if (u.hp - ev.amount >= val(a, 'hp_threshold')) return;
      a.cd = cooldownOf(a);
      borrowedTime(a);
      heal(u, ev.amount, u);
      ev.amount = 0;
    },
    onTick: botTick(a, (u) => (u.hp / u.s.maxHp < 0.4 && enemyHeroes(u, 700).length ? {} : null)),
  }),
  onSpellStart(a) { borrowedTime(a); },
});

defineHero('abaddon', ['abaddon_death_coil', 'abaddon_aphotic_shield', 'abaddon_frostmourne', 'abaddon_withering_mist', 'abaddon_borrowed_time'], {
  build: ['bracer', 'phase_boots', 'echo_sabre', 'radiance', 'black_king_bar', 'ultimate_scepter', 'assault'],
});
