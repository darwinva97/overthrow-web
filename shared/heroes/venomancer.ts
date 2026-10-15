import { castRangeOf, defineAbility, defineHero, dmg, dur, hasScepter, hasShard, val } from '../sim/abilities';
import { damage } from '../sim/combat';
import type { AbilityInst, Modifier } from '../sim/types';
import { ST } from '../sim/types';
import type { Unit } from '../sim/unit';
import { rawVal, setSummonStats, stationary, summonBrain } from './lib/a9';
import { canDebuff, castDir, debuff } from './util';

const ward = (u: Unit) => u.abilities.find((x) => x.key === 'venomancer_plague_ward');
const sting = (u: Unit) => u.abilities.find((x) => x.key === 'venomancer_poison_sting');

/** Poison Sting sobre un objetivo; `mult` para las wards (50%). */
function applySting(a: AbilityInst, t: Unit, mult: number) {
  const u = a.owner as Unit;
  if (t.team === u.team || (!t.isHeroLike && t.kind !== 'creep' && t.kind !== 'summon')) return;
  debuff(u, t, a, {
    name: 'poison_sting', duration: dur(a, 'duration'), interval: 1, fx: 'poison',
    props: { msSlow: val(a, 'movement_speed') / 100 * mult, hpRegenAmp: -val(a, 'hp_regen_reduction') / 100 },
    onInterval(m) { damage(u, m.owner as Unit, dmg(a, 'damage') * mult, 'magical', a, { noProc: true }); },
  });
}

/** Plague Ward en (x, y). `scale` multiplica vida y daño (Shard de Gale). */
function spawnWard(a: AbilityInst, x: number, y: number, scale = 1) {
  const u = a.owner as Unit;
  const s = u.w.spawnSummon(u, 'venomancer_plague_ward', x, y, dur(a, 'duration'), {
    abilities: [], bounty: val(a, 'ward_gold_bounty_min'),
  });
  setSummonStats(s, { dmg: val(a, 'ward_base_damage') * scale, spread: val(a, 'ward_damage_spread'), hp: val(a, 'ward_max_health') * scale });
  stationary(s);
  s.addMod({
    name: 'plague_ward', persistent: true, states: val(a, 'magic_immune') ? ST.magicImmune : 0,
    // Perforante: más daño a creeps, menos a héroes. Y aplica Poison Sting al 50%.
    onAttackStart(_m, ev) { ev.damage *= (ev.target as Unit).isHeroLike ? 0.5 : 1.5; },
    onAttackLanded(_m, ev) {
      const st = sting(u);
      if (st && st.level > 0) applySting(st, ev.target as Unit, 0.5);
    },
  }, u, a);
  summonBrain(s, u, 600);
  return s;
}

defineAbility({
  key: 'venomancer_venomous_gale', target: 'point', ai: { role: 'nuke' },
  castRange: (a) => val(a, 'abilitycastrange'),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const [dx, dy] = castDir(u, t.x, t.y);
    u.w.addProjectile({
      kind: 'linear', fx: 'venomous_gale', source: u, x: u.x, y: u.y, dx, dy,
      speed: val(a, 'speed'), left: castRangeOf(a), width: val(a, 'radius') * 2,
      onHit(_p, e) {
        const v = e as Unit;
        if (v.team === u.team || !canDebuff(u, v, a)) return;
        damage(u, v, dmg(a, 'strike_damage'), 'magical', a);
        const tick = val(a, 'tick_interval');
        debuff(u, v, a, {
          name: 'venomous_gale', duration: dur(a, 'duration'), interval: tick, fx: 'poison',
          props: { msSlow: Math.abs(val(a, 'movement_slow')) / 100 },
          onInterval(m) { damage(u, m.owner as Unit, dmg(a, 'tick_damage'), 'magical', a, { noProc: true }); },
        });
        // Shard: crea Plague Wards alrededor de los héroes alcanzados.
        const w = ward(u);
        if (v.isHero && val(a, 'create_wards') > 0 && w && w.level > 0) {
          const n = val(a, 'num_created_wards_tooltip');
          for (let i = 0; i < n; i++) {
            const ang = (i / n) * Math.PI * 2;
            spawnWard(w, v.x + Math.cos(ang) * 150, v.y + Math.sin(ang) * 150, val(a, 'ward_hp_dmg_pct') / 100);
          }
        }
      },
    });
  },
});

defineAbility({
  key: 'venomancer_snakebite', target: 'unit', reflectable: true, ai: { role: 'nuke' },
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const e = t.unit as Unit;
    const hit = dmg(a, 'base_damage');
    damage(u, e, hit, 'magical', a);
    const iv = val(a, 'damage_interval');
    debuff(u, e, a, {
      name: 'snakebite', duration: dur(a, 'duration'), interval: iv, fx: 'poison',
      purgable: !val(a, 'undispellable'),
      onInterval(m) { damage(u, m.owner as Unit, dmg(a, 'tick_damage') * iv, 'magical', a, { noProc: true }); },
      // Atacar estando infectado repite el daño inicial.
      onAttackStart(m) { damage(u, m.owner as Unit, hit, 'magical', a); },
    });
  },
});

defineAbility({
  key: 'venomancer_plague_ward', target: 'point', ai: { role: 'summon' },
  onSpellStart(a, t) { spawnWard(a, t.x, t.y); },
});

defineAbility({
  key: 'venomancer_poison_sting', target: 'passive', innate: true,
  passive: (a) => ({
    name: 'poison_sting_passive',
    onAttackLanded(_m, ev) { applySting(a, ev.target as Unit, 1); },
  }),
});

/** Infecta con la plaga. `impact` es el daño de impacto que corresponde. */
function plague(a: AbilityInst, e: Unit, impact: number, primary: boolean, duration: number) {
  const u = a.owner as Unit;
  if (!canDebuff(u, e, a)) return;
  if (impact > 0) damage(u, e, impact, 'magical', a);
  if (!e.alive && !primary) return;
  const tick = val(a, 'damage_tick_rate');
  const total = duration;
  const spec = {
    name: 'noxious_plague', duration, interval: tick, fx: 'plague', purgable: false,
    props: (m: Modifier) => ({
      // El ralentizado decae con la duración.
      msSlow: val(a, 'movement_slow') / 100 * Math.max(0, m.remaining / total),
      magicResist: -val(a, 'mres_reduce') / 100,
    }),
    onInterval(m: Modifier) {
      const t = m.owner as Unit;
      damage(u, t, t.s.maxHp * val(a, 'damage_per_second') / 100 * tick * a.upg.dmg, 'magical', a, { noProc: true });
      t.refreshStats();
    },
    onDestroy(m: Modifier) {
      if (!primary) return;
      // Al acabar por cualquier motivo, se contagia con todos los debuffs de Venomancer.
      const t = m.owner as Unit;
      const r = val(a, 'debuff_radius');
      const near = u.w.enemiesIn(u.team, t.x, t.y, r).filter((x) => x !== t && x.kind !== 'ward')
        .sort((p, q) => Number(q.isHeroLike) - Number(p.isHeroLike) || Math.hypot(p.x - t.x, p.y - t.y) - Math.hypot(q.x - t.x, q.y - t.y))
        .slice(0, val(a, 'spread_count'));
      const carried = t.mods.filter((x) => x.caster === u && x.debuff && x !== m && Number.isFinite(x.remaining));
      const reduce = val(a, 'impact_damage_reduce') / 100;
      near.forEach((n, i) => {
        u.w.emit({ n: 'plague_spread', x: t.x, y: t.y, x2: n.x, y2: n.y, u: t.id, u2: n.id });
        const full = i === 0 || (hasScepter(u) && t.isHero);
        plague(a, n, full ? dmg(a, 'impact_damage') : dmg(a, 'impact_damage') * (1 - reduce), false,
          dur(a, 'debuff_duration') * val(a, 'debuff_time_transfer') / 100);
        for (const c of carried) {
          const { remaining, stacks, data, owner, acc, ...rest } = c;
          void owner; void acc; void stacks;
          debuff(u, n, c.ability, { ...rest, name: c.name, duration: remaining * val(a, 'debuff_time_transfer') / 100, data: { ...data } });
        }
      });
    },
  };
  debuff(u, e, a, spec);
}

defineAbility({
  key: 'venomancer_noxious_plague', target: 'unit', ult: true, reflectable: true, ai: { role: 'nuke', hpBelow: 0.85 },
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const e = t.unit as Unit;
    u.w.addProjectile({
      kind: 'track', fx: 'noxious_plague', source: u, target: e, x: u.x, y: u.y,
      speed: val(a, 'projectile_speed'), dodgeable: true,
      onHit() { plague(a, e, dmg(a, 'impact_damage'), true, dur(a, 'debuff_duration')); return true; },
    });
  },
});

defineHero('venomancer', ['venomancer_venomous_gale', 'venomancer_snakebite', 'venomancer_plague_ward', 'venomancer_poison_sting', 'venomancer_noxious_plague'], {
  build: ['wraith_band', 'arcane_boots', 'force_staff', 'pipe', 'ultimate_scepter', 'shivas_guard', 'refresher'],
});
