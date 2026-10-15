import { defineAbility, defineHero, dmg, dur, hasScepter, hasShard, hasTalent, manaCostOf, val } from '../sim/abilities';
import { damage, giveMana, heal, launchAttack } from '../sim/combat';
import { syncItemPassives } from '../sim/items';
import type { AbilityInst } from '../sim/types';
import { ST } from '../sim/types';
import type { Unit } from '../sim/unit';
import { botBrain, currentTarget } from './lib/a4';
import { dash, debuff, silence, slow, stun } from './util';

const UNLEASH = 4;

/** Pulso de Unleash alrededor de un punto (último golpe de cada ráfaga y, con Scepter, al lanzar). */
function unleashPulse(a: AbilityInst, x: number, y: number) {
  const u = a.owner as Unit;
  const r = val(a, 'pulse_radius');
  u.w.emit({ n: 'unleash_pulse', x, y, r, t: u.team });
  const d = val(a, 'pulse_debuff_duration');
  for (const e of u.w.enemiesIn(u.team, x, y, r)) {
    damage(u, e, dmg(a, 'pulse_damage'), 'magical', a);
    slow(u, e, a, 'unleash_pulse_slow', d, val(a, 'pulse_move_slow_pct') / 100, val(a, 'pulse_attack_slow_pct'));
    if (val(a, 'pulse_silence_duration') > 0) silence(u, e, val(a, 'pulse_silence_duration'), a, 'unleash_silence');
  }
}

/** Golpe al aterrizar (Dispose y Rebound): daño y efecto a los enemigos del radio. */
function impact(u: Unit, a: AbilityInst, x: number, y: number, r: number, amount: number, effect: (e: Unit) => void, skip?: Unit) {
  u.w.emit({ n: 'marci_impact', x, y, r, t: u.team });
  for (const e of u.w.enemiesIn(u.team, x, y, r)) {
    if (e === skip) continue;
    damage(u, e, amount, 'magical', a);
    if (e.alive) effect(e);
  }
}

defineAbility({
  key: 'marci_grapple', target: 'unit', team: 'any', reflectable: true, ai: { role: 'disable' },
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const e = t.unit as Unit;
    const enemy = e.team !== u.team;
    // La lanza por encima de Marci, detrás de ella.
    let dx = u.x - e.x, dy = u.y - e.y;
    const l = Math.hypot(dx, dy) || 1;
    if (l < 2) { dx = -Math.cos(u.facing); dy = -Math.sin(u.facing); } else { dx /= l; dy /= l; }
    const tx = u.x + dx * val(a, 'throw_distance_behind'), ty = u.y + dy * val(a, 'throw_distance_behind');
    const air = val(a, 'air_duration');
    const sx = e.x, sy = e.y;
    if (e.cast) u.w.interruptCast(e, true);
    e.w.disjoint(e);
    e.addMod({
      name: 'marci_dispose', duration: air, debuff: enemy, purgable: false, fx: 'thrown',
      states: ST.stunned | ST.noCollision | ST.flying, data: { t: 0 },
      onTick(m, dt) {
        m.data.t += dt;
        const k = Math.min(1, m.data.t / air);
        u.w.forceMove(e, sx + (tx - sx) * k, sy + (ty - sy) * k);
      },
      onDestroy() {
        u.w.forceMove(e, tx, ty);
        const r = val(a, 'landing_radius');
        const sl = (v: Unit) => slow(u, v, a, 'marci_dispose_slow', dur(a, 'debuff_duration'), val(a, 'movement_slow_pct') / 100);
        if (enemy && e.alive) { damage(u, e, dmg(a, 'impact_damage'), 'magical', a); if (e.alive) sl(e); }
        impact(u, a, tx, ty, r, dmg(a, 'impact_damage'), sl, e);
      },
    }, u, a);
  },
});

defineAbility({
  key: 'marci_companion_run', target: 'unit', team: 'any',
  // Salta hacia el aliado y rebota hasta el punto elegido (sin vector: en la misma dirección).
  passive: (a) => botBrain(a, (u) => {
    const t = currentTarget(u);
    if (!t) return null;
    const range = val(a, 'abilitycastrange') + u.s.castRange;
    const jump = val(a, 'max_jump_distance');
    const pads = u.w.alliesIn(u.team, u.x, u.y, range).filter((x) => x !== u && (x.isHeroLike || x.kind === 'creep' || x.kind === 'summon'));
    if (hasShard(u) && Math.hypot(t.x - u.x, t.y - u.y) <= range) pads.push(t);
    const pad = pads.find((p) => Math.hypot(p.x - t.x, p.y - t.y) <= jump);
    if (!pad) return null;
    a.data.botLand = { x: t.x, y: t.y };
    return { target: pad };
  }, 0.4),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const pad = t.unit as Unit;
    const enemy = pad.team !== u.team;
    if (pad === u || (enemy && val(a, 'can_jump_off_allies') <= 0)) {
      // Sin Shard solo vale un aliado: se devuelve el coste.
      a.cd = 0; giveMana(u, manaCostOf(a)); return;
    }
    const jump = val(a, 'max_jump_distance');
    let lx: number, ly: number;
    const bl = a.data.botLand as { x: number; y: number } | undefined;
    a.data.botLand = undefined;
    if (bl && Math.hypot(bl.x - pad.x, bl.y - pad.y) <= jump) { lx = bl.x; ly = bl.y; }
    else {
      let dx = pad.x - u.x, dy = pad.y - u.y;
      const l = Math.hypot(dx, dy) || 1;
      if (l < 2) { dx = Math.cos(u.facing); dy = Math.sin(u.facing); } else { dx /= l; dy /= l; }
      lx = pad.x + dx * jump; ly = pad.y + dy * jump;
    }
    const speed = val(a, 'move_speed');
    const buffs = (v: Unit) => {
      v.addMod({ name: 'marci_rebound_speed', duration: val(a, 'ally_buff_duration'), fx: 'haste',
        props: { msPct: val(a, 'ally_movespeed_pct') / 100, armor: val(a, 'scepter_armor') } }, u, a);
      if (val(a, 'scepter_heal') > 0) heal(v, val(a, 'scepter_heal'), u);
    };
    dash(u, pad.x, pad.y, speed, a, {
      name: 'marci_rebound', maxTime: val(a, 'target_abort_distance') / speed + 0.5,
      onArrive() {
        if (!u.alive) return;
        if (!enemy) buffs(pad);
        if (hasShard(u)) buffs(u);
        dash(u, lx, ly, speed, a, {
          name: 'marci_rebound_lunge', states: ST.flying,
          onArrive() {
            if (!u.alive) return;
            impact(u, a, lx, ly, val(a, 'landing_radius'), dmg(a, 'impact_damage'), (e) => stun(u, e, dur(a, 'debuff_duration'), a));
          },
        });
      },
    });
  },
});

/** Bonos de Bodyguard: daño en % y robo de vida (reducido contra creeps). */
function guardProps(a: AbilityInst, mult: number) {
  return {
    damagePct: val(a, 'bonus_damage') / 100 * mult,
  };
}
function guardLifesteal(a: AbilityInst, mult: number) {
  return (m: { owner?: Unit }, ev: { target: Unit; amount: number; isAttack: boolean; source: Unit | null }) => {
    const o = m.owner as Unit;
    if (!ev.isAttack || ev.source !== o || ev.target.team === o.team) return;
    const pct = val(a, 'lifesteal_pct') / 100 * mult * (ev.target.isHeroLike ? 1 : 1 - val(a, 'creep_lifesteal_reduction_pct') / 100);
    heal(o, ev.amount * pct, o, true);
  };
}

defineAbility({
  key: 'marci_bodyguard', target: 'unit', team: 'ally',
  passive: (a) => {
    const brain = botBrain(a, (u) => {
      const t = currentTarget(u);
      if (!t || Math.hypot(t.x - u.x, t.y - u.y) > 900) return null;
      const range = val(a, 'abilitycastrange') + u.s.castRange;
      const al = u.w.alliesIn(u.team, u.x, u.y, range, { heroes: true }).find((x) => x !== u && x.kind === 'hero');
      return al ? { target: al } : null;
    });
    return {
      name: 'bodyguard', props: guardProps(a, 1),
      onDealDamage: guardLifesteal(a, 1) as any,
      onTick: brain.onTick,
    };
  },
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const al = t.unit as Unit;
    if (!al || al === u) { a.cd = 0; giveMana(u, manaCostOf(a)); return; }
    if (val(a, 'strong_dispel') > 0) al.purge(true, false, true);
    const d = dur(a, 'bodyguard_duration');
    const mult = val(a, 'max_partner_penalty') / 100;
    // Barrera compartida por Marci y su protegido.
    const pool = { hp: val(a, 'shared_barrier') };
    const absorb = (_m: unknown, ev: { amount: number; hpRemoval?: boolean }) => {
      if (ev.hpRemoval || pool.hp <= 0) return;
      const cut = Math.min(pool.hp, ev.amount);
      pool.hp -= cut; ev.amount -= cut;
    };
    u.removeModsByName('bodyguard_barrier');
    u.addMod({
      name: 'bodyguard_barrier', duration: d, fx: 'barrier', onIncomingDamage: absorb as any,
      onDealDamage(_m, ev) {
        if (!ev.isAttack || !ev.target.isHeroLike || ev.target.team === u.team) return;
        pool.hp = Math.min(val(a, 'shared_barrier'), pool.hp + ev.amount * val(a, 'shared_barrier_replenish_amount') / 100);
      },
    }, u, a);
    al.addMod({
      name: 'bodyguard_partner', duration: d, fx: 'bodyguard', props: guardProps(a, mult),
      onDealDamage: guardLifesteal(a, mult) as any,
      onIncomingDamage: absorb as any,
      // Marci contraataca a quien pegue a su protegido si lo tiene a mano.
      onAttacked(m, ev) {
        const at = ev.attacker as Unit;
        if (at.team === u.team || !u.alive || u.has(ST.disarmed) || u.has(ST.stunned) || u.w.time < (m.data.next ?? 0)) return;
        if (Math.hypot(at.x - u.x, at.y - u.y) > u.s.attackRange + val(a, 'bodyguard_attack_range_buffer') + u.radius + at.radius) return;
        m.data.next = u.w.time + val(a, 'counter_cooldown');
        launchAttack(u, at);
      },
    }, u, a);
  },
});

defineAbility({
  key: 'marci_special_delivery', target: 'none', innate: true,
  // Sin mensajero en Overthrow: los objetos del alijo llegan al instante.
  passive: (a) => botBrain(a, (u) => (u.stash.length && u.freeSlot() >= 0 ? { x: u.x, y: u.y } : null), 1),
  onSpellStart(a) {
    const u = a.owner as Unit;
    let moved = false;
    while (u.stash.length) {
      const s = u.freeSlot();
      if (s < 0) break;
      u.items[s] = u.stash.shift()!;
      moved = true;
    }
    if (moved) { syncItemPassives(u); u.w.emit({ n: 'courier', x: u.x, y: u.y, u: u.id }); } else a.cd = Math.min(a.cd, 5);
  },
});

defineAbility({
  key: 'marci_unleash', target: 'none', ult: true, ai: { role: 'buff', selfRadius: 500 },
  onSpellStart(a) {
    const u = a.owner as Unit;
    if (hasScepter(u)) {
      a.cd = Math.max(0, a.cd - val(a, 'scepter_cooldown_reduction') * (1 - u.s.cdr));
      if (val(a, 'dispel') > 0) u.purge(true, false);
    }
    const per = val(a, 'charges_per_flurry');
    u.addMod({
      name: 'unleash', duration: dur(a, 'duration'), fx: 'unleash', purgable: false,
      data: { charges: per },
      props: (m) => ({
        msPct: val(a, 'bonus_movespeed') / 100,
        attackSpeed: m.data.charges > 0 ? val(a, 'flurry_bonus_attack_speed') : 0,
      }),
      onAttackLanded(m, ev) {
        const t = ev.target as Unit;
        if (ev.fake || t.team === u.team || m.data.charges <= 0) return;
        m.data.charges--;
        if (m.data.charges > 0) return;
        unleashPulse(a, t.x, t.y);
        // Pausa entre ráfagas: no puede atacar.
        u.addMod({ name: 'unleash_recovery', duration: val(a, 'time_between_flurries'), states: ST.disarmed, fx: 'disarm',
          onDestroy() { const mm = u.findMod('unleash'); if (mm) { mm.data.charges = per; u.refreshStats(); } } }, u, a);
        u.refreshStats();
      },
      // Scepter: cada habilidad lanzada durante Unleash suelta un pulso.
      onAbilityExecuted(_m, ab) {
        if (!hasScepter(u) || (ab as any).isItem || ab === a) return;
        unleashPulse(a, u.x, u.y);
      },
      onKill(m, victim) {
        if (victim.kind === 'hero' && hasTalent(u, 'special_bonus_unique_marci_unleash_extend_duration')) {
          m.remaining += val(a, 'extend_duration');
        }
      },
    }, u, a);
  },
});

void UNLEASH;

defineHero('marci', ['marci_grapple', 'marci_companion_run', 'marci_bodyguard', 'marci_special_delivery', 'marci_unleash'], {
  build: ['bracer', 'phase_boots', 'black_king_bar', 'basher', 'desolator', 'assault', 'abyssal_blade'],
  upgrades: [
    { slot: 0, key: 'impact_damage', amount: 40, max: 5, label: 'Dispose: +40 daño' },
    { slot: 1, key: 'impact_damage', amount: 40, max: 5, label: 'Rebound: +40 daño' },
    { slot: 1, key: 'debuff_duration', amount: 0.2, max: 4, label: 'Rebound: +0.2 s de aturdimiento' },
    { slot: 2, key: 'bonus_damage', amount: 5, max: 5, label: 'Bodyguard: +5% daño' },
    { slot: 2, key: 'lifesteal_pct', amount: 5, max: 5, label: 'Bodyguard: +5% robo de vida' },
    { slot: 4, key: 'pulse_damage', amount: 25, max: 5, label: 'Unleash: +25 daño de pulso' },
    { slot: 4, key: 'duration', amount: 1, max: 4, label: 'Unleash: +1 s de duración' },
  ],
});
