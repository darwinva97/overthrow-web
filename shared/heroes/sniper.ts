import { defineAbility, defineHero, dmg, dur, hasScepter, val } from '../sim/abilities';
import { damage, landAttack, makeAttack } from '../sim/combat';
import { ST } from '../sim/types';
import type { Unit } from '../sim/unit';
import { knockFrom } from './lib/a0';
import { debuff, push, slow, stun } from './util';

defineAbility({
  key: 'sniper_shrapnel', target: 'point', ai: { role: 'aoe' },
  charges: (a) => [val(a, 'abilitycharges'), val(a, 'abilitychargerestoretime')],
  aoe: (a) => val(a, 'radius'),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const r = val(a, 'radius');
    const delay = val(a, 'damage_delay');
    u.w.emit({ n: 'shrapnel_warn', x: t.x, y: t.y, r, d: delay, t: u.team });
    // Revela la zona desde el lanzamiento hasta que termina.
    u.w.addVision(u.team, t.x, t.y, r, delay + dur(a, 'duration'));
    u.w.after(delay, () => {
      u.w.addZone({
        fx: 'shrapnel', x: t.x, y: t.y, r, team: u.team, interval: 1, duration: dur(a, 'duration'),
        onInterval(z) {
          for (const e of u.w.enemiesIn(u.team, z.x, z.y, z.r)) {
            damage(u, e, dmg(a, 'shrapnel_damage'), 'magical', a, { noProc: true });
            slow(u, e, a, 'shrapnel_slow', val(a, 'slow_duration'), val(a, 'slow_movement_speed') / 100);
          }
        },
      });
    });
  },
});

defineAbility({
  key: 'sniper_headshot', target: 'passive',
  passive: (a) => ({
    name: 'headshot',
    onAttackLanded(_m, ev) {
      const u = ev.attacker as Unit, t = ev.target as Unit;
      const aim = u.findMod('take_aim_active');
      const chance = aim ? aim.data.chance : val(a, 'proc_chance');
      if (u.w.rng() >= chance / 100) return;
      ev.damage += dmg(a, 'damage');
      // −100% de velocidad de movimiento y de ataque durante un instante.
      slow(u, t, a, 'headshot_slow', val(a, 'slow_duration'), Math.abs(val(a, 'slow')) / 100, t.s.as);
      // El empuje es mayor cuanto más cerca está el objetivo.
      const near = Math.max(0.2, 1 - ev.distance / Math.max(1, u.s.attackRange));
      if (t.alive && !t.has(ST.magicImmune)) push(t, t.x - u.x, t.y - u.y, val(a, 'knockback_distance') * near, 0.1, u, a, 'headshot_push');
    },
  }),
});

defineAbility({
  key: 'sniper_take_aim', target: 'none', ai: { role: 'buff', selfRadius: 900 },
  passive: (a) => ({ name: 'take_aim', props: { attackRange: val(a, 'passive_attack_range_bonus') } }),
  onSpellStart(a) {
    const u = a.owner as Unit;
    u.addMod({
      name: 'take_aim_active', duration: dur(a, 'duration'), fx: 'take_aim', data: { chance: val(a, 'headshot_chance') },
      states: val(a, 'does_root') > 0 ? ST.rooted : 0,
      props: {
        attackRange: val(a, 'active_attack_range_bonus'), msSlow: val(a, 'slow') / 100,
        vision: val(a, 'bonus_vision'), attackSpeed: val(a, 'attack_speed'),
      },
    }, u, a);
  },
});

// Shard: granada que daña, empuja a los enemigos (y a Sniper) y luego los desarma y ralentiza.
defineAbility({
  key: 'sniper_concussive_grenade', target: 'point', ai: { role: 'disable' },
  aoe: (a) => val(a, 'radius'),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const r = val(a, 'radius');
    const kb = val(a, 'knockback_distance'), kt = val(a, 'knockback_duration');
    u.w.emit({ n: 'nova', x: t.x, y: t.y, r, t: u.team });
    for (const e of u.w.enemiesIn(u.team, t.x, t.y, r)) {
      damage(u, e, dmg(a, 'damage'), 'magical', a);
      if (!e.alive) continue;
      knockFrom(e, t.x, t.y, kb, kt, u, a, 'grenade_push');
      u.w.after(kt, () => {
        if (!e.alive) return;
        debuff(u, e, a, {
          name: 'concussive_grenade', duration: val(a, 'debuff_duration'), states: ST.disarmed, fx: 'slow',
          props: { msSlow: val(a, 'slow') / 100 },
        });
      });
    }
    if (val(a, 'self_push') > 0) knockFrom(u, t.x, t.y, kb, kt, u, a, 'grenade_self_push');
  },
});

defineAbility({
  key: 'sniper_keen_scope', target: 'passive', innate: true,
  passive: (a) => ({
    name: 'keen_scope',
    onAttackStart(_m, ev) {
      const steps = Math.floor(ev.distance / val(a, 'bonus_damage_distance'));
      ev.damage *= 1 + steps * val(a, 'bonus_damage_for_range') / 100;
    },
  }),
});

defineAbility({
  key: 'sniper_assassinate', target: 'unit', ult: true, reflectable: true, ai: { role: 'nuke', hpBelow: 0.5 },
  // Scepter: apunta mucho más rápido.
  castPoint: (a) => (hasScepter(a.owner as Unit) ? val(a, 'scepter_cast_point') : val(a, 'abilitycastpoint')),
  passive: (a) => ({
    name: 'assassinate_refresh',
    onKill(_m, v) { if (v.kind === 'hero') a.cd = 0; },
  }),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const e = t.unit as Unit;
    u.w.addProjectile({
      kind: 'track', fx: 'assassinate', source: u, target: e, x: u.x, y: u.y,
      speed: val(a, 'projectile_speed'), dodgeable: true,
      onHit() {
        if (e.has(ST.magicImmune)) return true;
        damage(u, e, dmg(a, 'damage'), 'magical', a);
        if (!e.alive) return true;
        // Además del daño, un ataque normal que no falla.
        const ev = makeAttack(u, e, true);
        ev.trueStrike = true;
        landAttack(ev);
        const sd = hasScepter(u) ? val(a, 'scepter_stun_duration') : 0;
        stun(u, e, Math.max(0.1, sd), a);
        return true;
      },
    });
  },
});

defineHero('sniper', ['sniper_shrapnel', 'sniper_headshot', 'sniper_take_aim', 'sniper_concussive_grenade', 'sniper_keen_scope', 'sniper_assassinate'], {
  build: ['wraith_band', 'power_treads', 'maelstrom', 'dragon_lance', 'black_king_bar', 'mjollnir', 'greater_crit', 'satanic'],
});
