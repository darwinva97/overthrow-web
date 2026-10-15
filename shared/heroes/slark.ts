import { castRangeOf, cooldownOf, defineAbility, defineHero, dmg, dur, manaCostOf, val } from '../sim/abilities';
import { damage } from '../sim/combat';
import type { AbilityInst, AttackEvent } from '../sim/types';
import { ST } from '../sim/types';
import type { Unit } from '../sim/unit';
import { abil, addStacks, optCharges, seenByEnemies } from './lib/a7';
import { dash, debuff } from './util';

const ESSENCE = 'slark_essence_shift';
const DANCE = 'slark_shadow_dance';
/** Equipo de los neutrales (world.NEUTRAL). */
const NEUTRAL = -1;

/** Essence Shift: roba atributos a un héroe enemigo (n cargas independientes). */
function essenceShift(u: Unit, t: Unit, n: number) {
  const a = abil(u, ESSENCE);
  if (!a || a.level <= 0 || u.kind !== 'hero' || t.kind !== 'hero' || t.team === u.team) return;
  const d = val(a, 'duration');
  const loss = val(a, 'stat_loss');
  const m = addStacks(t, u, a, {
    name: 'essence_shift_debuff', debuff: true, purgable: false, fx: 'essence_shift',
    props: (mm) => ({ str: -mm.stacks * loss, agi: -mm.stacks * loss, int: -mm.stacks * loss }),
  }, d, n);
  if (!m) return;
  addStacks(u, u, a, { name: 'essence_shift', fx: 'essence_shift', props: (mm) => ({ agi: mm.stacks * val(a, 'agi_gain') }) }, d, n);
}

defineAbility({
  key: 'slark_dark_pact', target: 'none', ai: { role: 'aoe', selfRadius: 325 },
  aoe: (a) => val(a, 'radius'),
  onSpellStart(a) {
    const u = a.owner as Unit;
    const pulses = val(a, 'total_pulses');
    const per = dmg(a, 'total_damage') / pulses;
    u.w.emit({ n: 'dark_pact_warn', x: u.x, y: u.y, r: val(a, 'radius'), d: val(a, 'delay'), u: u.id });
    u.w.after(val(a, 'delay'), () => {
      if (!u.alive) return;
      let n = 0;
      u.addMod({
        name: 'dark_pact', duration: val(a, 'pulse_duration') + 0.05, fx: 'dark_pact', interval: val(a, 'pulse_interval'),
        onInterval() {
          if (n++ >= pulses || !u.alive) return;
          // Disipación fuerte en cada pulso.
          u.purge(true, false, true);
          for (const e of u.w.enemiesIn(u.team, u.x, u.y, val(a, 'radius'))) damage(u, e, per, 'magical', a, { noProc: true });
          damage(u, u, per * val(a, 'self_damage_pct') / 100, 'magical', a, { noProc: true, data: { nonLethal: true } });
        },
      }, u, a);
    });
  },
});

defineAbility({
  key: 'slark_pounce', target: 'none', ai: { role: 'disable', selfRadius: 550 },
  charges: (a) => optCharges(a, 'max_charges', 'charge_restore_time'),
  onSpellStart(a) {
    const u = a.owner as Unit;
    if (u.has(ST.rooted)) return;
    const dist = val(a, 'pounce_distance_scepter') || val(a, 'pounce_distance');
    const dx = Math.cos(u.facing), dy = Math.sin(u.facing);
    const r = val(a, 'pounce_radius');
    let done = false;
    const mod = dash(u, u.x + dx * dist, u.y + dy * dist, val(a, 'pounce_speed'), a, {
      name: 'pounce', states: ST.flying,
      onStep: () => {
        if (done) return;
        const e = u.w.enemiesIn(u.team, u.x, u.y, r, { heroes: true })[0];
        if (!e) return;
        done = true;
        mod.remaining = 0.001;
        leash(u, a, e);
      },
    });
  },
});

function leash(u: Unit, a: AbilityInst, e: Unit) {
  const cx = u.x, cy = u.y;
  const lr = val(a, 'leash_radius');
  const pd = val(a, 'pounce_damage');
  if (pd > 0) damage(u, e, pd, 'magical', a);
  const m = debuff(u, e, a, {
    name: 'pounce_leash', duration: dur(a, 'leash_duration'), fx: 'leash',
    onTick(mm) {
      const v = mm.owner as Unit;
      const d = Math.hypot(v.x - cx, v.y - cy);
      if (d > lr) v.w.forceMove(v, cx + (v.x - cx) / d * lr, cy + (v.y - cy) / d * lr);
    },
  });
  if (m) essenceShift(u, e, val(a, 'essence_stacks'));
}

// Ataques que llevan Saltwater Shiv.
const shived = new WeakSet<AttackEvent>();

defineAbility({
  key: 'slark_saltwater_shiv', target: 'toggle', ai: { role: 'nuke' },
  passive: (a) => ({
    name: 'saltwater_shiv',
    onAttackStart(_m, ev) {
      const u = ev.attacker as Unit;
      if (!a.toggled || a.cd > 0 || ev.fake || u.kind === 'illusion' || u.has(ST.silenced)) return;
      const cost = manaCostOf(a);
      if (u.mana < cost) return;
      u.mana -= cost;
      a.cd = cooldownOf(a);
      shived.add(ev);
    },
    onAttackLanded(_m, ev) {
      if (!shived.has(ev)) return;
      const u = ev.attacker as Unit, t = ev.target as Unit;
      if (t.team === u.team) return;
      const d = val(a, 'duration');
      const ms = val(a, 'ms_steal') / 100, rg = val(a, 'regen_steal') / 100, hr = val(a, 'health_rest_steal') / 100;
      const m = addStacks(t, u, a, {
        name: 'saltwater_shiv_debuff', debuff: true, fx: 'slow',
        props: (mm) => ({ msSlow: mm.stacks * ms, hpRegenAmp: -mm.stacks * rg, healAmp: -mm.stacks * hr }),
      }, d);
      if (m) addStacks(u, u, a, {
        name: 'saltwater_shiv_buff', fx: 'saltwater_shiv',
        props: (mm) => ({ msPct: mm.stacks * ms, hpRegenAmp: mm.stacks * rg, healAmp: mm.stacks * hr }),
      }, d);
    },
  }),
});

defineAbility({
  key: 'slark_depth_shroud', target: 'point', ai: { role: 'escape' }, castBeyond: true,
  aoe: (a) => val(a, 'radius'),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    let x = t.x, y = t.y;
    const range = castRangeOf(a);
    const d = Math.hypot(x - u.x, y - u.y);
    if (d > range) { x = u.x + (x - u.x) / d * range; y = u.y + (y - u.y) / d * range; }
    // Los bots la usan sobre sí mismos para escapar.
    if (u.isBot) { x = u.x; y = u.y; }
    u.w.addZone({
      fx: 'depth_shroud', x, y, r: val(a, 'radius'), team: u.team, interval: 0.1, duration: val(a, 'duration'),
      onInterval(z) {
        for (const al of u.w.alliesIn(u.team, z.x, z.y, z.r)) {
          if (!al.isHeroLike) continue;
          al.addMod({ name: 'depth_shroud', duration: 0.3, fx: 'shadow_dance', states: ST.invisible }, u, a);
          danceBuff(u, al, 0.3);
        }
      },
    });
  },
});

/** Bonus de Shadow Dance activa (velocidad de ataque del talento). */
function danceBuff(u: Unit, t: Unit, d: number) {
  const a = abil(u, DANCE);
  if (!a || a.level <= 0) return;
  const as = val(a, 'attack_speed');
  if (as > 0) t.addMod({ name: 'shadow_dance_as', duration: d, props: { attackSpeed: as } }, u, a);
}

defineAbility({
  key: 'slark_essence_shift', target: 'passive', innate: true,
  passive: (a) => ({
    name: 'essence_shift_passive',
    onAttackLanded(_m, ev) { essenceShift(ev.attacker as Unit, ev.target as Unit, 1); },
    // Robo permanente: muere un héroe afectado a manos de Slark o cerca de él.
    onAnyDeath(m, victim, killer) {
      const u = m.owner as Unit;
      if (u.kind !== 'hero' || victim.kind !== 'hero' || victim.team === u.team || !victim.findMod('essence_shift_debuff', u)) return;
      const near = Math.hypot(victim.x - u.x, victim.y - u.y) <= val(a, 'steal_radius');
      if (killer !== u && !near) return;
      u.permAgi += 1;
      victim.permAgi -= 1;
      u.refreshStats();
    },
  }),
});

defineAbility({
  key: 'slark_shadow_dance', target: 'none', ult: true, ai: { role: 'escape', selfRadius: 500, hpBelow: 1 },
  // Pasiva: sin ser visto por el enemigo, velocidad y regeneración.
  passive: (a) => ({
    name: 'shadow_dance_passive', data: { on: false, hiddenSince: -1, neutralUntil: 0 },
    props: (m) => (m.data.on ? { msPct: val(a, 'bonus_movement_speed') / 100, hpRegen: val(a, 'bonus_regen') } : {}),
    onTakeDamage(m, ev) {
      const src = ev.source as Unit | null;
      if (src && src.team === NEUTRAL) m.data.neutralUntil = (m.owner as Unit).w.time + val(a, 'neutral_disable');
    },
    onTick(m) {
      const u = m.owner as Unit;
      if (u.w.tickN % 3 !== 0) return;
      const now = u.w.time;
      const unseen = !seenByEnemies(u);
      if (!unseen) m.data.hiddenSince = -1;
      else if (m.data.hiddenSince < 0) m.data.hiddenSince = now;
      const on = unseen && now - m.data.hiddenSince >= val(a, 'activation_delay') && now >= m.data.neutralUntil;
      if (on !== m.data.on) { m.data.on = on; u.refreshStats(); }
    },
  }),
  onSpellStart(a) {
    const u = a.owner as Unit;
    const d = dur(a, 'duration');
    u.w.emit({ n: 'shadow_dance', x: u.x, y: u.y, u: u.id });
    // Invisible: atacar o lanzar no lo revela (la true sight sí, limitación del motor).
    u.addMod({ name: 'shadow_dance', duration: d, fx: 'shadow_dance', states: ST.invisible }, u, a);
    danceBuff(u, u, d);
  },
});

defineHero('slark', ['slark_dark_pact', 'slark_pounce', 'slark_saltwater_shiv', 'slark_depth_shroud', 'slark_essence_shift', 'slark_shadow_dance'], {
  build: ['wraith_band', 'power_treads', 'mask_of_madness', 'diffusal_blade', 'black_king_bar', 'skadi', 'abyssal_blade', 'butterfly'],
});
