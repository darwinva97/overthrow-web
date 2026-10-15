import { defineAbility, defineHero, dmg, dur, val } from '../sim/abilities';
import type { AbilityInst } from '../sim/types';
import { damage, heal, launchAttack } from '../sim/combat';
import { ST } from '../sim/types';
import type { Unit } from '../sim/unit';
import { abilityOf } from './lib/a0';
import { nearestEnemy } from './util';

defineAbility({
  key: 'juggernaut_blade_fury', target: 'none', ai: { role: 'aoe', selfRadius: 260 },
  onSpellStart(a) {
    const u = a.owner as Unit;
    u.purge(true, false);
    const tick = val(a, 'blade_fury_damage_tick');
    u.addMod({
      name: 'blade_fury', duration: dur(a, 'duration'), fx: 'blade_fury', interval: tick,
      states: ST.magicImmune | ST.disarmed,
      props: { magicResist: val(a, 'immunity_resist') / 100, msFlat: val(a, 'bonus_movespeed') },
      onInterval() {
        // Blade Dance también puede hacer crítico con Blade Fury.
        const bd = abilityOf(u, 'juggernaut_blade_dance');
        for (const e of u.w.enemiesIn(u.team, u.x, u.y, val(a, 'blade_fury_radius'))) {
          const crit = !!bd && bd.level > 0 && u.w.rng() < val(bd, 'blade_dance_crit_chance') / 100;
          const mult = crit ? val(bd!, 'blade_dance_crit_mult') / 100 : 1;
          damage(u, e, dmg(a, 'blade_fury_damage') * tick * mult, 'magical', a, { noProc: true, crit });
        }
      },
      onDestroy() { u.purge(true, false); },
    }, u, a);
  },
});

defineAbility({
  key: 'juggernaut_healing_ward', target: 'point', ai: { role: 'summon' },
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const ward = u.w.addUnit('ward', 'healing_ward', u.team, {
      hp: 1, hpRegen: 0, mana: 0, manaRegen: 0, armor: 0, mr: 0, dmgMin: 0, dmgMax: 0,
      bat: 1, attackPoint: 0, range: 0, projSpeed: 0, ms: val(a, 'healing_ward_movespeed_tooltip'),
      dayVision: 500, nightVision: 500, turnRate: 1, melee: true,
    }, t.x, t.y);
    ward.owner = u;
    ward.playerId = u.playerId;
    ward.expireAt = u.w.time + dur(a, 'abilityduration');
    ward.addMod({
      name: 'healing_ward_aura', persistent: true, fx: 'healing_ward', interval: 0.25,
      states: ST.disarmed,
      onInterval(m) {
        const wd = m.owner as Unit;
        const pct = val(a, 'healing_ward_heal_amount') / 100 * a.upg.dmg;
        for (const al of wd.w.alliesIn(wd.team, wd.x, wd.y, val(a, 'healing_ward_aura_radius'))) {
          if (al.isHeroLike || al.kind === 'creep') heal(al, al.s.maxHp * pct * 0.25, wd, true);
        }
      },
      // Muere de un golpe.
      // Muere a golpes (2 con Shard); el daño de hechizos no le afecta.
      onIncomingDamage(m, ev) {
        if (!ev.isAttack) { ev.amount = 0; return; }
        m.data.hits = (m.data.hits ?? 0) + 1;
        ev.amount = m.data.hits >= val(a, 'healing_ward_hits_to_kill_tooltip') ? 9999 : 0;
      },
    }, u, a);
    u.w.issueOrder(ward, { type: 'follow', target: u.id });
  },
});

defineAbility({
  key: 'juggernaut_blade_dance', target: 'passive',
  passive: (a) => ({
    name: 'blade_dance',
    onAttackStart(_m, ev) {
      if ((ev.attacker as Unit).w.rng() < val(a, 'blade_dance_crit_chance') / 100) {
        ev.critMult = Math.max(ev.critMult, val(a, 'blade_dance_crit_mult') / 100);
        (ev as any).bladeDance = true;
      }
    },
    // Talento: robo de vida en los críticos.
    onAttackLanded(_m, ev) {
      const ls = val(a, 'blade_dance_lifesteal');
      if (ls > 0 && (ev as any).bladeDance) heal(ev.attacker as Unit, ev.damage * ev.critMult * ls / 100, null, true);
    },
  }),
});

defineAbility({
  key: 'juggernaut_bladeform', target: 'passive', innate: true,
  passive: (a) => ({
    name: 'bladeform', stacks: 0, interval: val(a, 'stack_gain_time'),
    props: (m) => ({
      agiBasePct: m.stacks * val(a, 'agi_bonus_pct_per_stack') / 100,
      msPct: m.stacks * val(a, 'movement_speed_pct_per_stack') / 100,
    }),
    onInterval(m) {
      const u = m.owner as Unit;
      if (u.w.time - u.lastDamageAt >= val(a, 'stack_gain_time')) {
        m.stacks = Math.min(val(a, 'max_stacks'), m.stacks + 1);
        u.refreshStats();
      }
    },
    onTakeDamage(m) { m.data.fadeAt = (m.owner as Unit).w.time + val(a, 'linger_duration'); },
    onTick(m) {
      const u = m.owner as Unit;
      if (m.data.fadeAt && u.w.time >= m.data.fadeAt) { m.data.fadeAt = 0; m.stacks = 0; u.refreshStats(); }
    },
  }),
});

/** Omnislash: Juggernaut salta entre enemigos golpeando más rápido; invulnerable mientras dura. */
function omnislash(a: AbilityInst, first: Unit, duration: number, name: string) {
  const u = a.owner as Unit;
  const omni = abilityOf(u, 'juggernaut_omni_slash') ?? a;
  u.purge(true, false);
  u.w.disjoint(u);
  const radius = val(omni, 'omni_slash_radius');
  let target: Unit | null = first;
  const slash = () => {
    if (!target || !target.alive || !u.w.targetable(target) || Math.hypot(target.x - u.x, target.y - u.y) > radius + 200) {
      target = nearestEnemy(u, u.x, u.y, radius, new Set(), true);
    }
    if (!target) return false;
    const ang = u.w.rng() * Math.PI * 2;
    u.w.forceMove(u, target.x + Math.cos(ang) * 60, target.y + Math.sin(ang) * 60);
    u.facing = Math.atan2(target.y - u.y, target.x - u.x);
    u.w.emit({ n: 'omnislash', x: u.x, y: u.y, u: u.id, u2: target.id });
    launchAttack(u, target, true);
    // Cambia de objetivo entre saltos, como en Dota.
    target = nearestEnemy(u, u.x, u.y, radius, new Set([target.id]), true) ?? target;
    return true;
  };
  const mod = u.addMod({
    name, duration, fx: 'omnislash',
    states: ST.invulnerable | ST.busy | ST.noCollision,
    props: { attackSpeed: val(omni, 'bonus_attack_speed'), damage: dmg(omni, 'bonus_damage') },
    onTick(m, dt) {
      m.acc = (m.acc ?? 0) + dt;
      const every = u.attackInterval() / val(omni, 'attack_rate_multiplier');
      while (m.acc >= every) {
        m.acc -= every;
        if (!slash()) { u.removeMod(m); return; }
      }
    },
  }, u, a);
  if (!slash()) u.removeMod(mod);
}

// Aghanim's Scepter: un Omnislash corto.
defineAbility({
  key: 'juggernaut_swift_slash', target: 'unit', ai: { role: 'nuke' },
  onSpellStart(a, t) { omnislash(a, t.unit as Unit, val(a, 'duration'), 'swift_slash'); },
});

defineAbility({
  key: 'juggernaut_omni_slash', target: 'unit', ult: true, ai: { role: 'nuke', hpBelow: 0.7 },
  onSpellStart(a, t) { omnislash(a, t.unit as Unit, dur(a, 'duration'), 'omnislash'); },
});

defineHero('juggernaut', ['juggernaut_blade_fury', 'juggernaut_healing_ward', 'juggernaut_blade_dance', 'juggernaut_swift_slash', 'juggernaut_bladeform', 'juggernaut_omni_slash'], {
  build: ['wraith_band', 'phase_boots', 'maelstrom', 'black_king_bar', 'butterfly', 'greater_crit', 'abyssal_blade'],
});
