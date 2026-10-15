import { defineAbility, defineHero, dmg, dur, hasScepter, val } from '../sim/abilities';
import { damage } from '../sim/combat';
import type { AbilityInst } from '../sim/types';
import { ST } from '../sim/types';
import type { Unit } from '../sim/unit';
import { enemiesInLine, expire, gate, helper } from './lib/a8';
import { debuff, silence, slow, stun } from './util';

const ability = (u: Unit, key: string) => u.abilities.find((x) => x.key === key);
const heroOfTrap = (trap: Unit) => (trap.owner as Unit) ?? trap;

defineAbility({
  key: 'templar_assassin_refraction', target: 'none', ai: { role: 'buff', selfRadius: 700 },
  onSpellStart(a) {
    const u = a.owner as Unit;
    if (val(a, 'dispels') > 0) u.purge(true, false);
    const n = val(a, 'instances');
    const d = dur(a, 'duration');
    const shield = val(a, 'shield_per_instance');
    // Barrera: cada instancia absorbe un golpe entero; los golpes pequeños solo la desgastan.
    u.addMod({
      name: 'refraction_absorb', duration: d, stacks: n, fx: 'refraction', data: { shield },
      onIncomingDamage(m, ev) {
        if (ev.hpRemoval || ev.source === u || ev.amount <= 0) return;
        if (ev.amount >= m.data.shield) { m.stacks--; m.data.shield = shield; } else m.data.shield -= ev.amount;
        ev.amount = 0;
        if (m.stacks <= 0) u.removeMod(m);
      },
    }, u, a).stacks = n;
    u.addMod({
      name: 'refraction_damage', duration: d, stacks: n,
      props: { damage: dmg(a, 'bonus_damage') },
      onAttackLanded(m, ev) {
        if (ev.fake) return;
        m.stacks--;
        if (m.stacks <= 0) u.removeMod(m);
      },
    }, u, a).stacks = n;
  },
});

defineAbility({
  key: 'templar_assassin_meld', target: 'none', ai: { role: 'buff', selfRadius: 400 },
  // Golpe desde Meld: reduce la armadura (y aturde con el talento) antes de aplicar el daño.
  passive: (a) => ({
    name: 'meld_strike',
    onAttackLanded(_m, ev) {
      if (!(ev as any).meld) return;
      const u = ev.attacker as Unit, t = ev.target as Unit;
      meldDebuff(u, t, a);
      if (val(a, 'bash_duration') > 0) stun(u, t, val(a, 'bash_duration'), a);
      u.w.emit({ n: 'meld_strike', x: t.x, y: t.y, u: t.id });
    },
  }),
  onSpellStart(a) {
    const u = a.owner as Unit;
    u.order = null; u.queue = []; u.atk.phase = 0;
    const x0 = u.x, y0 = u.y;
    u.addMod({
      name: 'meld', fx: 'meld', states: ST.invisible, data: { breaksOnAttack: true },
      props: { attackRange: val(a, 'attack_range_bonus') },
      onAttackStart(_m, ev) {
        (ev as any).meld = true;
        ev.damage += dmg(a, 'bonus_damage');
      },
      onTick(m) { if (Math.hypot(u.x - x0, u.y - y0) > 8) m.data.breakNow = true; },
    }, u, a);
  },
});

function meldDebuff(u: Unit, t: Unit, a: AbilityInst) {
  debuff(u, t, a, { name: 'meld_armor', duration: val(a, 'debuff_duration'), fx: 'meld_armor', props: { armor: val(a, 'bonus_armor') } });
}

defineAbility({
  key: 'templar_assassin_psi_blades', target: 'passive',
  passive: (a) => ({
    name: 'psi_blades',
    props: { attackRange: val(a, 'bonus_attack_range') },
    onAttackLanded(_m, ev) {
      const u = ev.attacker as Unit, t = ev.target as Unit;
      if ((ev as any).blinded) return;
      const d = Math.hypot(t.x - u.x, t.y - u.y) || 1;
      const dx = (t.x - u.x) / d, dy = (t.y - u.y) / d;
      const meldA = (ev as any).meld && val(a, 'meld_strike_spills') ? ability(u, 'templar_assassin_meld') : null;
      const amount = ev.damage * ev.critMult * val(a, 'attack_spill_pct') / 100;
      for (const e of enemiesInLine(u, t.x, t.y, dx, dy, val(a, 'attack_spill_range'), val(a, 'attack_spill_width'))) {
        if (e === t || e.kind === 'ward') continue;
        if (meldA) meldDebuff(u, e, meldA);
        damage(u, e, amount, 'pure', a, { noProc: true });
      }
      u.w.emit({ n: 'psi_blades', x: t.x, y: t.y, x2: t.x + dx * val(a, 'attack_spill_range'), y2: t.y + dy * val(a, 'attack_spill_range'), u: u.id });
    },
  }),
});

/** Trampas vivas de TA, de la más antigua a la más nueva. */
function trapsOf(u: Unit): Unit[] {
  const pt = ability(u, 'templar_assassin_psionic_trap');
  if (!pt) return [];
  pt.data.traps = ((pt.data.traps ?? []) as Unit[]).filter((t) => t.alive);
  return pt.data.traps;
}

/** Activa una trampa: ralentiza (más cuanto más cargada) y, cargada del todo, hace daño. */
function spring(trap: Unit, full = false, extra = 0) {
  const u = heroOfTrap(trap);
  const a = ability(u, 'templar_assassin_psionic_trap');
  if (!a || !trap.alive) return;
  const w = u.w;
  const charge = full ? 1 : Math.min(1, (w.time - (trap.data_born ?? w.time)) / val(a, 'trap_max_charge_duration'));
  const ms = (val(a, 'movement_speed_min') + (val(a, 'movement_speed_max') - val(a, 'movement_speed_min')) * charge) / 100;
  const R = val(a, 'trap_radius');
  const D = val(a, 'trap_duration');
  const x = trap.x, y = trap.y;
  w.emit({ n: 'psionic_trap', x, y, r: R, t: u.team });
  if (extra > 0) for (const e of w.enemiesIn(u.team, x, y, R)) damage(u, e, extra, 'magical', a);
  if (hasScepter(u)) {
    const sil = val(a, 'min_silence_duration') + (val(a, 'max_silence_duration') - val(a, 'min_silence_duration')) * charge;
    for (const e of w.enemiesIn(u.team, x, y, R)) silence(u, e, sil, a, 'psionic_trap_silence');
  }
  const tick = val(a, 'damage_tick_rate');
  const perTick = charge >= 1 ? dmg(a, 'trap_bonus_damage') * tick / D : 0;
  w.addZone({
    fx: 'psionic_trap', x, y, r: R, team: u.team, interval: tick, duration: D,
    onInterval(z) {
      for (const e of w.enemiesIn(u.team, z.x, z.y, z.r)) {
        slow(u, e, a, 'psionic_trap_slow', tick + 0.1, ms);
        if (perTick > 0) damage(u, e, perTick, 'magical', a, { noProc: true });
      }
    },
  });
  expire(trap);
}

defineAbility({
  key: 'templar_assassin_trap', target: 'none', levelWith: 5, ai: { role: 'aoe', selfRadius: 700 },
  passive: (a) => {
    a.data.keepInvis = true;
    return { name: 'trap_gate', onTick() { gate(a, trapsOf(a.owner as Unit).length > 0); } };
  },
  onSpellStart(a) {
    const u = a.owner as Unit;
    const best = trapsOf(u).sort((p, q) => Math.hypot(p.x - u.x, p.y - u.y) - Math.hypot(q.x - u.x, q.y - u.y))[0];
    if (best) spring(best);
  },
});

// La trampa también se puede activar a sí misma si se selecciona.
defineAbility({
  key: 'templar_assassin_self_trap', target: 'none', ai: { role: 'aoe', selfRadius: 400 },
  onSpellStart(a) { spring(a.owner as Unit); },
});

defineAbility({
  key: 'templar_assassin_trap_teleport', target: 'point', castBeyond: true, ai: { role: 'escape' },
  castRange: () => 1800,
  channel: (a) => val(a, 'abilitychanneltime'),
  passive: (a) => {
    a.data.keepInvis = true;
    return { name: 'trap_teleport_gate', onTick() { gate(a, trapsOf(a.owner as Unit).length > 0); } };
  },
  onSpellStart(a, t) { a.data.tx = t.x; a.data.ty = t.y; },
  onChannelEnd(a, interrupted) {
    if (interrupted) return;
    const u = a.owner as Unit;
    const best = trapsOf(u).sort((p, q) => Math.hypot(p.x - a.data.tx, p.y - a.data.ty) - Math.hypot(q.x - a.data.tx, q.y - a.data.ty))[0];
    if (!best) return;
    u.w.emit({ n: 'blink', x: u.x, y: u.y, x2: best.x, y2: best.y, u: u.id, c: 'ta' });
    u.w.disjoint(u);
    u.w.teleport(u, best.x, best.y);
    spring(best, true, val(a, 'extra_damage'));
  },
});

defineAbility({
  key: 'templar_assassin_psionic_trap', target: 'point', ult: true, ai: { role: 'disable' },
  aoe: (a) => val(a, 'trap_radius'),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const traps = trapsOf(u);
    while (traps.length >= val(a, 'max_traps')) expire(traps.shift()!);
    const trap = helper(u, 'templar_assassin_psionic_trap', t.x, t.y, Infinity, ST.noCollision, { level: 1 });
    trap.data_born = u.w.time;
    trap.addMod({
      name: 'psionic_trap', persistent: true, fx: 'psionic_trap_idle',
      // Se vuelve invisible al cabo de un momento; solo los ataques la destruyen.
      states: 0,
      onTick(m) {
        if (m.states === 0 && u.w.time - trap.data_born >= val(a, 'trap_fade_time')) { m.states = ST.invisible; trap.refreshStats(); }
      },
      onIncomingDamage(_m, ev) { if (!ev.isAttack) ev.amount = 0; },
    });
    traps.push(trap);
  },
});

defineAbility({
  key: 'templar_assassin_inner_peace', target: 'passive', innate: true,
  passive: (a) => ({
    name: 'inner_peace', data: { x: 0, y: 0, since: 0 },
    props: (m) => ({ hpRegen: val(a, 'max_hp_regen') * (m.data.k ?? 0), manaRegen: val(a, 'max_mana_regen') * (m.data.k ?? 0) }),
    onTick(m) {
      const u = m.owner as Unit;
      const w = u.w;
      const moved = Math.hypot(u.x - m.data.x, u.y - m.data.y) > 1;
      m.data.x = u.x; m.data.y = u.y;
      if (moved || u.lastDamageAt > m.data.since || u.atk.phase === 1) m.data.since = w.time;
      const t = w.time - m.data.since - val(a, 'time_until_meditation');
      const k = t <= 0 ? 0 : Math.min(1, t / val(a, 'time_until_max_bonus'));
      if (Math.abs(k - (m.data.k ?? 0)) > 0.02 || (k === 0) !== ((m.data.k ?? 0) === 0)) { m.data.k = k; u.refreshStats(); }
    },
  }),
});

defineHero('templar_assassin', ['templar_assassin_refraction', 'templar_assassin_meld', 'templar_assassin_psi_blades',
  'templar_assassin_trap', 'templar_assassin_trap_teleport', 'templar_assassin_psionic_trap', 'templar_assassin_inner_peace'], {
  build: ['wraith_band', 'power_treads', 'dragon_lance', 'desolator', 'black_king_bar', 'lesser_crit', 'greater_crit', 'hurricane_pike'],
});
