import { defineAbility, defineHero, dmg, dur, hasShard, val } from '../sim/abilities';
import { creditHero, damage, heal } from '../sim/combat';
import { ST } from '../sim/types';
import type { Unit } from '../sim/unit';
import { castDir, debuff } from './util';

defineAbility({
  key: 'pudge_meat_hook', target: 'point', ai: { role: 'disable' },
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const [dx, dy] = castDir(u, t.x, t.y);
    const speed = val(a, 'hook_speed');
    const range = val(a, 'abilitycastrange') * a.upg.range + u.s.castRange;
    u.w.addProjectile({
      kind: 'linear', fx: 'hook', source: u, x: u.x, y: u.y, dx, dy,
      speed, left: range, width: val(a, 'hook_width'),
      onHit(p, e) {
        const v = e as Unit;
        if (v.kind === 'ward' && v.team !== u.team) return false;
        if (v === u || v.kind === 'fountain') return false;
        u.w.addVision(u.team, p.x, p.y, val(a, 'vision_radius'), val(a, 'vision_duration'));
        if (v.team !== u.team) {
          if (v.has(ST.magicImmune) && !a.def.bkbPierce) return false;
          // Mata a los creeps (no ancestrales) y daña al resto.
          if (v.kind === 'creep') damage(u, v, v.hp + 1, 'pure', a, { hpRemoval: true });
          else damage(u, v, dmg(a, 'damage'), 'pure', a);
        } else if (hasShard(u) && v.isHeroLike && !a.temp) {
          // Shard: enganchar a un aliado reduce el enfriamiento.
          a.cd *= 1 - val(a, 'cooldown_reduction_pct_allied_hook') / 100;
        }
        if (!v.alive) return true;
        v.w.disjoint(v);
        if (v.cast) v.w.interruptCast(v, true);
        const sx = v.x, sy = v.y;
        v.addMod({
          name: 'hooked', duration: 2.5, debuff: v.team !== u.team, purgable: false,
          states: ST.stunned, fx: 'hooked', data: { from: u.id },
          onTick(m, dt) {
            const tgt = m.owner as Unit;
            const d = Math.hypot(u.x - tgt.x, u.y - tgt.y);
            if (d < 130 || !u.alive) { tgt.removeMod(m); return; }
            const step = Math.min(d - 120, speed * dt);
            tgt.w.forceMove(tgt, tgt.x + (u.x - tgt.x) / d * step, tgt.y + (u.y - tgt.y) / d * step);
          },
          onDestroy(m) {
            // Shard: daño extra según la distancia arrastrada.
            const tgt = m.owner as Unit;
            if (!hasShard(u) || tgt.team === u.team || !tgt.alive) return;
            const pulled = Math.hypot(tgt.x - sx, tgt.y - sy);
            const bonus = Math.max(val(a, 'min_distance_damage'), pulled * val(a, 'distance_to_damage') / 100);
            if (bonus > 0) damage(u, tgt, bonus, 'pure', a);
          },
        }, u, a);
        return true;
      },
    });
  },
});

defineAbility({
  key: 'pudge_rot', target: 'toggle', ai: { role: 'aoe', selfRadius: 250 },
  onToggle(a, on) {
    const u = a.owner as Unit;
    if (!on) { u.removeModsByName('rot'); return; }
    const tick = val(a, 'rot_tick');
    u.addMod({
      name: 'rot', fx: 'rot', interval: tick,
      aura: {
        radius: val(a, 'rot_radius'), team: 'enemy',
        apply: () => ({ name: 'rot_slow', debuff: true, fx: 'slow', props: {
          msSlow: Math.abs(val(a, 'rot_slow')) / 100,
          // Scepter: reduce la regeneración y curación recibidas.
          hpRegenAmp: -val(a, 'scepter_rot_regen_reduction_pct') / 100,
        } }),
      },
      onInterval() {
        const d = dmg(a, 'rot_damage') * tick;
        for (const e of u.w.enemiesIn(u.team, u.x, u.y, val(a, 'rot_radius'))) damage(u, e, d, 'magical', a, { noProc: true });
        damage(u, u, d, 'magical', a, { noProc: true, data: { nonLethal: true } });
      },
    }, u, a);
  },
});

defineAbility({
  key: 'pudge_flesh_heap', target: 'none', ai: { role: 'buff', selfRadius: 600 },
  onSpellStart(a) {
    const u = a.owner as Unit;
    const block = val(a, 'damage_block');
    u.addMod({
      name: 'meat_shield', duration: dur(a, 'duration'), fx: 'meat_shield',
      onIncomingDamage(_m, ev) { if (!ev.hpRemoval && ev.source !== u) ev.amount = Math.max(0, ev.amount - block); },
    }, u, a);
  },
});

defineAbility({
  key: 'pudge_innate_graft_flesh', target: 'passive', innate: true,
  passive: (a) => ({
    name: 'flesh_heap', stacks: a.data.stacks ?? 0,
    onAnyDeath(m, victim, killer) {
      const u = m.owner as Unit;
      if (victim.kind !== 'hero' || victim.team === u.team) return;
      const near = Math.hypot(victim.x - u.x, victim.y - u.y) <= val(a, 'flesh_heap_range');
      if (creditHero(killer as Unit) !== u && !(near && u.alive)) return;
      a.data.stacks = (a.data.stacks ?? 0) + 1;
      m.stacks = a.data.stacks;
      u.permStr += val(a, 'flesh_heap_strength_buff_amount');
      u.refreshStats();
    },
  }),
});

defineAbility({
  key: 'pudge_dismember', target: 'unit', ult: true, reflectable: true, ai: { role: 'disable' },
  channel: (a) => val(a, 'abilitychanneltime'),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const e = t.unit as Unit;
    a.data.target = e.id;
    a.data.acc = 0;
    debuff(u, e, a, { name: 'dismember', duration: val(a, 'abilitychanneltime'), states: ST.stunned, fx: 'dismember' });
  },
  onChannelTick(a, dt) {
    const u = a.owner as Unit;
    const e = u.w.units.get(a.data.target);
    if (!e || !e.alive || Math.hypot(e.x - u.x, e.y - u.y) > 600) { u.w.interruptCast(u, true); return; }
    const ch = val(a, 'abilitychanneltime');
    const every = ch / val(a, 'ticks');
    a.data.acc += dt;
    if (a.data.acc >= every) {
      a.data.acc -= every;
      const dps = dmg(a, 'dismember_damage') + val(a, 'strength_damage') * u.s.str;
      const dealt = damage(u, e, dps * every, 'magical', a);
      // Pudge se cura lo que inflige.
      heal(u, dealt, u, true);
    }
    const d = Math.hypot(u.x - e.x, u.y - e.y);
    if (d > val(a, 'pull_distance_limit')) {
      const step = val(a, 'pull_units_per_second') * dt;
      e.w.forceMove(e, e.x + (u.x - e.x) / d * step, e.y + (u.y - e.y) / d * step);
    }
  },
  onChannelEnd(a) {
    const u = a.owner as Unit;
    u.w.units.get(a.data.target)?.removeModsByName('dismember');
  },
});

defineHero('pudge', ['pudge_meat_hook', 'pudge_rot', 'pudge_flesh_heap', 'pudge_innate_graft_flesh', 'pudge_dismember'], {
  build: ['bracer', 'phase_boots', 'blink', 'black_king_bar', 'heart', 'shivas_guard', 'refresher'],
});
