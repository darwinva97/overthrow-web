import { castRangeOf, defineAbility, defineHero, dmg, dur, hasScepter, hasShard, val } from '../sim/abilities';
import { creditHero, damage } from '../sim/combat';
import type { AbilityInst } from '../sim/types';
import type { Unit } from '../sim/unit';
import { barrierMod } from './lib/a9';
import { canDebuff, castDir, debuff, stun } from './util';

/** Misil: aturde y daña; con Shard rebota una vez (prioriza héroes). */
function missile(a: AbilityInst, from: { x: number; y: number }, e: Unit, bounce: boolean) {
  const u = a.owner as Unit;
  u.w.addProjectile({
    kind: 'track', fx: 'magic_missile', source: u, target: e, x: from.x, y: from.y,
    speed: val(a, 'magic_missile_speed'), dodgeable: true,
    onHit() {
      if (!canDebuff(u, e, a)) return true;
      damage(u, e, dmg(a, 'magic_missile_damage'), 'magical', a);
      stun(u, e, dur(a, 'magic_missile_stun'), a);
      if (bounce && hasShard(u) && !a.temp) {
        const r = castRangeOf(a) * val(a, 'bounce_range_pct') / 100;
        const next = u.w.enemiesIn(u.team, e.x, e.y, r).filter((v) => v !== e && v.kind !== 'ward' && u.w.canSee(u.team, v))
          .sort((p, q) => Number(q.isHeroLike) - Number(p.isHeroLike) || Math.hypot(p.x - e.x, p.y - e.y) - Math.hypot(q.x - e.x, q.y - e.y))[0];
        if (next) missile(a, e, next, false);
      }
      return true;
    },
  });
}

defineAbility({
  key: 'vengefulspirit_magic_missile', target: 'unit', reflectable: true, ai: { role: 'disable' },
  onSpellStart(a, t) { missile(a, a.owner as Unit, t.unit as Unit, true); },
});

defineAbility({
  key: 'vengefulspirit_wave_of_terror', target: 'point', ai: { role: 'nuke' },
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const [dx, dy] = castDir(u, t.x, t.y);
    const range = val(a, 'abilitycastrange') + u.s.castRange;
    const steal = val(a, 'steal_pct') / 100;
    let heroes = 0;
    // Visión del camino.
    for (let d = 0; d <= range; d += val(a, 'vision_aoe')) {
      u.w.addVision(u.team, u.x + dx * d, u.y + dy * d, val(a, 'vision_aoe'), val(a, 'vision_duration'));
    }
    u.w.addProjectile({
      kind: 'linear', fx: 'wave_of_terror', source: u, x: u.x, y: u.y, dx, dy,
      speed: val(a, 'wave_speed'), left: range, width: val(a, 'wave_width'),
      onHit(_p, e) {
        const v = e as Unit;
        if (v.team === u.team || !canDebuff(u, v, a)) return;
        damage(u, v, dmg(a, 'damage'), 'magical', a);
        const red = val(a, 'attack_reduction') / 100;
        debuff(u, v, a, {
          name: 'wave_of_terror', duration: dur(a, 'abilityduration'), fx: 'armor_down',
          props: { armor: val(a, 'armor_reduction') },
          // Reduce el daño total de ataque.
          onAttackStart(_m, ev) { ev.damage *= 1 - red; },
        });
        if (steal > 0 && v.isHeroLike) {
          heroes++;
          u.addMod({
            name: 'wave_of_terror_steal', duration: dur(a, 'abilityduration'), stacks: heroes,
            props: (m) => ({ armor: -val(a, 'armor_reduction') * steal * m.stacks, damagePct: red * steal * m.stacks }),
          }, u, a);
        }
      },
    });
  },
});

defineAbility({
  key: 'vengefulspirit_command_aura', target: 'passive', noIllusion: true,
  passive: (a) => ({
    name: 'vengeance_aura',
    aura: {
      radius: val(a, 'aura_radius'), team: 'ally', heroesOnly: true,
      apply(m, t) {
        const self = t === m.owner;
        const b = val(a, 'bonus_base_damage') / 100 * (self ? 1 + val(a, 'self_multiplier') / 100 : 1);
        return { name: 'vengeance_aura_buff', props: { damagePct: b } };
      },
    },
    // Scepter: al morir deja una ilusión fuerte que ocupa su sitio si sigue viva al reaparecer.
    onDeath(m) {
      const u = m.owner as Unit;
      if (u.kind !== 'hero' || !hasScepter(u)) return;
      const il = u.w.spawnIllusion(u, u.x, u.y, 30,
        val(a, 'scepter_illusion_damage_out_pct') / 100 - 1, val(a, 'scepter_illusion_damage_in_pct') / 100 - 1);
      il.hp = il.s.maxHp;
      a.data.illusion = il.id;
    },
    onRespawn(m) {
      const u = m.owner as Unit;
      const il = a.data.illusion ? u.w.units.get(a.data.illusion) : undefined;
      a.data.illusion = 0;
      if (!il || !il.alive) return;
      u.w.teleport(u, il.x, il.y);
      u.hp = Math.min(u.s.maxHp, il.hp / il.s.maxHp * u.s.maxHp);
      il.expireAt = u.w.time;
    },
  }),
});

defineAbility({
  key: 'vengefulspirit_retribution', target: 'passive', innate: true, noIllusion: true,
  passive: (a) => ({
    name: 'retribution',
    onDeath(m, killer) {
      const u = m.owner as Unit;
      const k = creditHero(killer as Unit);
      if (u.kind !== 'hero' || !k || k.team === u.team) return;
      // Solo un debuff a la vez.
      for (const x of u.w.list) if (x !== k) x.removeModsByName('retribution_mark');
      k.addMod({
        name: 'retribution_mark', debuff: true, purgable: false, fx: 'retribution',
        onIncomingDamage(_mm, ev) {
          const s = ev.source as Unit | null;
          if (s && (s === u || s.owner === u)) ev.amount *= 1 + val(a, 'bonus_damage') / 100;
        },
      }, u, a);
    },
  }),
});

defineAbility({
  key: 'vengefulspirit_nether_swap', target: 'unit', team: 'any', ult: true, reflectable: true, ai: { role: 'disable' },
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const e = t.unit as Unit;
    if (e === u) return;
    const ux = u.x, uy = u.y;
    u.w.disjoint(u); e.w.disjoint(e);
    u.w.teleport(u, e.x, e.y);
    u.w.teleport(e, ux, uy);
    u.w.emit({ n: 'nether_swap', x: ux, y: uy, x2: u.x, y2: u.y, u: u.id, u2: e.id });
    if (e.cast?.phase === 2) e.w.interruptCast(e, true);
    const d = dur(a, 'damage_reduction_duration');
    if (e.team !== u.team) {
      const dealt = damage(u, e, dmg(a, 'damage'), 'magical', a);
      if (dealt > 0) u.addMod(barrierMod('nether_swap_barrier', d, dealt), u, a);
    } else {
      const amt = dmg(a, 'damage');
      u.addMod(barrierMod('nether_swap_barrier', d, amt), u, a);
      e.addMod(barrierMod('nether_swap_barrier', d, amt), u, a);
    }
  },
});

defineHero('vengefulspirit', ['vengefulspirit_magic_missile', 'vengefulspirit_wave_of_terror', 'vengefulspirit_command_aura', 'vengefulspirit_retribution', 'vengefulspirit_nether_swap'], {
  build: ['wraith_band', 'power_treads', 'dragon_lance', 'maelstrom', 'black_king_bar', 'ultimate_scepter', 'butterfly'],
});
