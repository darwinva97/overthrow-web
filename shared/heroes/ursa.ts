import { defineAbility, defineHero, dmg, dur, val } from '../sim/abilities';
import { damage } from '../sim/combat';
import type { AbilityInst } from '../sim/types';
import type { Unit } from '../sim/unit';
import { abilityOf } from './lib/a0';
import { dash, debuff, slow, stun } from './util';

/** Suma `n` cargas de Fury Swipes a `t` (las aplica el ataque o el Shard de Earthshock). */
function addSwipes(u: Unit, t: Unit, fs: AbilityInst, n: number) {
  const old = t.findMod('fury_swipes', u);
  const stacks = (old?.stacks ?? 0) + n;
  const m = debuff(u, t, fs, { name: 'fury_swipes', duration: val(fs, 'bonus_reset_time'), stacks, purgable: false, fx: 'battle_hunger' });
  if (!m) return 0;
  m.stacks = stacks;
  m.remaining = m.duration = val(fs, 'bonus_reset_time');
  // Talento (si existe): aturde al llegar a cierto número de cargas.
  const every = val(fs, 'stun_stack_count');
  if (every > 0 && stacks % every === 0) stun(u, t, val(fs, 'stun_duration'), fs);
  return stacks;
}

defineAbility({
  key: 'ursa_earthshock', target: 'none', ai: { role: 'aoe', selfRadius: 380 },
  // El talento da 2 cargas; sin él, una sola carga que se recupera con el enfriamiento normal.
  charges: (a) => [Math.max(1, val(a, 'abilitycharges')), val(a, 'abilitychargerestoretime')],
  onSpellStart(a) {
    const u = a.owner as Unit;
    const hop = val(a, 'hop_distance');
    const tx = u.x + Math.cos(u.facing) * hop, ty = u.y + Math.sin(u.facing) * hop;
    dash(u, tx, ty, hop / Math.max(0.05, val(a, 'hop_duration')), a, {
      name: 'earthshock_hop',
      onArrive() {
        const r = val(a, 'shock_radius');
        u.w.emit({ n: 'nova', x: u.x, y: u.y, r, t: u.team });
        const fs = abilityOf(u, 'ursa_fury_swipes');
        const stacks = val(a, 'fury_swipe_stacks_on_hit');
        for (const e of u.w.enemiesIn(u.team, u.x, u.y, r)) {
          damage(u, e, dmg(a, 'abilitydamage'), 'magical', a);
          slow(u, e, a, 'earthshock', dur(a, 'abilityduration'), Math.abs(val(a, 'movement_slow')) / 100);
          // Shard: aplica cargas de Fury Swipes.
          if (stacks > 0 && fs && fs.level > 0 && e.alive) addSwipes(u, e, fs, stacks);
        }
      },
    });
  },
});

defineAbility({
  key: 'ursa_overpower', target: 'none', ai: { role: 'buff', selfRadius: 300 },
  onSpellStart(a) {
    const u = a.owner as Unit;
    u.addMod({
      name: 'overpower', duration: dur(a, 'abilityduration'), stacks: val(a, 'max_attacks'), fx: 'berserk',
      props: { attackSpeed: val(a, 'attack_speed_bonus_pct'), slowResist: val(a, 'slow_resist') / 100 },
      onAttackStart(m, ev) {
        if (ev.fake) return;
        m.stacks--;
        if (m.stacks <= 0) m.remaining = 0.001;
      },
    }, u, a);
  },
});

defineAbility({
  key: 'ursa_fury_swipes', target: 'passive',
  passive: (a) => ({
    name: 'fury_swipes_passive',
    onAttackLanded(_m, ev) {
      const u = ev.attacker as Unit, t = ev.target as Unit;
      if (t.team === u.team) return;
      const stacks = addSwipes(u, t, a, 1);
      ev.damage += stacks * dmg(a, 'damage_per_stack');
    },
  }),
});

// Innata: daño extra según su vida actual.
defineAbility({
  key: 'ursa_maul', target: 'passive', innate: true,
  passive: (a) => ({
    name: 'maul',
    onAttackStart(_m, ev) { ev.damage += (ev.attacker as Unit).hp * val(a, 'health_as_damage_pct') / 100; },
  }),
});

defineAbility({
  key: 'ursa_enrage', target: 'none', ult: true, ai: { role: 'buff', selfRadius: 350 },
  onSpellStart(a) {
    const u = a.owner as Unit;
    // Disipación fuerte.
    u.purge(true, false, true);
    u.addMod({
      name: 'enrage', duration: dur(a, 'duration'), fx: 'berserk',
      props: { incomingPct: -val(a, 'damage_reduction') / 100, statusResist: val(a, 'status_resistance') / 100 },
    }, u, a);
  },
});

defineHero('ursa', ['ursa_earthshock', 'ursa_overpower', 'ursa_fury_swipes', 'ursa_maul', 'ursa_enrage'], {
  build: ['wraith_band', 'phase_boots', 'blink', 'black_king_bar', 'basher', 'abyssal_blade', 'satanic'],
});
