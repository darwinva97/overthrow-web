import { defineAbility, defineHero, dmg, dur, hasScepter, hasShard, isItem, manaCostOf, val } from '../sim/abilities';
import { damage } from '../sim/combat';
import type { AbilityInst, ModSpec } from '../sim/types';
import { ST } from '../sim/types';
import type { Unit } from '../sim/unit';
import { expire, gate, heroOf, helper } from './lib/a8';
import { debuff, slow } from './util';

/** Remanente: camina hasta el punto y explota cuando un enemigo se acerca. */
function spawnRemnant(u: Unit, a: AbilityInst, tx: number, ty: number) {
  const w = u.w;
  const r = helper(u, 'stormspirit_remnant', u.x, u.y, val(a, 'abilityduration'), ST.invulnerable | ST.untargetable | ST.noCollision);
  const born = w.time;
  r.addMod({
    name: 'static_remnant', persistent: true, fx: 'static_remnant',
    onTick(_m, dt) {
      const d = Math.hypot(tx - r.x, ty - r.y);
      const step = val(a, 'static_remnant_travel_speed') * dt;
      if (d > 1) { const k = Math.min(1, step / d); r.x += (tx - r.x) * k; r.y += (ty - r.y) * k; }
      if (w.time - born < val(a, 'static_remnant_delay') || !r.alive) return;
      const near = w.enemiesIn(u.team, r.x, r.y, val(a, 'static_remnant_radius')).filter((e) => e.kind !== 'ward');
      if (!near.length) return;
      const R = val(a, 'static_remnant_damage_radius');
      w.emit({ n: 'static_remnant_blast', x: r.x, y: r.y, r: R, t: u.team });
      for (const e of w.enemiesIn(u.team, r.x, r.y, R)) damage(u, e, dmg(a, 'static_remnant_damage'), 'magical', a);
      expire(r);
    },
  });
  w.addVision(u.team, r.x, r.y, val(a, 'static_remnant_vision_radius_day'), 0.1);
  return r;
}

defineAbility({
  key: 'storm_spirit_static_remnant', target: 'point', ai: { role: 'aoe' },
  aoe: (a) => val(a, 'static_remnant_damage_radius'),
  onSpellStart(a, t) { spawnRemnant(a.owner as Unit, a, t.x, t.y); },
});

defineAbility({
  key: 'storm_spirit_electric_vortex', target: 'unit', reflectable: true, ai: { role: 'disable' },
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const targets = new Set<Unit>([t.unit as Unit]);
    // Scepter: atrae a todos los enemigos del radio.
    if (hasScepter(u)) for (const e of u.w.enemiesIn(u.team, u.x, u.y, val(a, 'radius_scepter'))) if (e.kind !== 'ward') targets.add(e);
    const d = dur(a, 'abilityduration');
    const cx = u.x, cy = u.y;
    for (const e of targets) {
      const total = Math.min(val(a, 'electric_vortex_pull_distance'), Math.max(0, Math.hypot(e.x - cx, e.y - cy) - 60));
      const speed = total / Math.max(0.1, d);
      let moved = 0;
      const m = debuff(u, e, a, {
        name: 'electric_vortex', duration: d, states: ST.stunned, fx: 'electric_vortex',
        onTick(mm, dt) {
          const v = mm.owner as Unit;
          const dd = Math.hypot(cx - v.x, cy - v.y);
          if (moved >= total || dd < 60) return;
          const step = Math.min(speed * dt, total - moved, dd - 60);
          moved += step;
          v.w.forceMove(v, v.x + (cx - v.x) / dd * step, v.y + (cy - v.y) / dd * step);
        },
      });
      if (m && e.cast) e.w.interruptCast(e, true);
    }
    u.addMod({ name: 'electric_vortex_self_slow', duration: val(a, 'electric_vortex_self_slow_duration'), fx: 'slow',
      props: { msSlow: Math.abs(val(a, 'electric_vortex_self_slow')) / 100 } }, u, a);
  },
});

/** Carga de Overload: el siguiente ataque la libera en área. */
function overloadCharge(a: AbilityInst, stacks: number, duration = Infinity, as = 0): ModSpec {
  return {
    name: 'overload', duration, stacks, fx: 'overload', props: as ? { attackSpeed: as } : undefined,
    onAttackLanded(m, ev) {
      if (ev.fake) return;
      const u = ev.attacker as Unit, t = ev.target as Unit;
      const storm = a.owner as Unit;
      const burst = (x: number, y: number, k: number) => {
        const r = val(a, 'overload_aoe');
        u.w.emit({ n: 'overload', x, y, r, t: u.team });
        for (const e of u.w.enemiesIn(u.team, x, y, r)) {
          damage(storm, e, dmg(a, 'overload_damage') * k, 'magical', a);
          slow(storm, e, a, 'overload_slow', val(a, 'abilityduration'),
            Math.abs(val(a, 'overload_move_slow')) / 100, Math.abs(val(a, 'overload_attack_slow')));
        }
      };
      burst(t.x, t.y, 1);
      // Talento: la descarga rebota a otros enemigos con menos daño.
      const bounces = val(a, 'overload_bounces');
      if (bounces > 0) {
        const hit = new Set([t.id]);
        let from = t;
        for (let i = 0; i < bounces; i++) {
          const next = u.w.enemiesIn(u.team, from.x, from.y, 600).filter((e) => !hit.has(e.id) && e.kind !== 'ward')
            .sort((p, q) => Math.hypot(p.x - from.x, p.y - from.y) - Math.hypot(q.x - from.x, q.y - from.y))[0];
          if (!next) break;
          hit.add(next.id);
          burst(next.x, next.y, val(a, 'overload_damage_pct') / 100);
          from = next;
        }
      }
      m.stacks--;
      if (m.stacks <= 0) u.removeMod(m);
    },
  };
}

defineAbility({
  key: 'storm_spirit_overload', target: 'none', ai: { role: 'buff', selfRadius: 700 },
  passive: (a) => ({
    name: 'overload_passive',
    onAbilityExecuted(_m, ab) {
      const u = a.owner as Unit;
      if (isItem(ab) || ab === a) return;
      const cur = u.findMod('overload', u);
      if (cur) cur.stacks = Math.max(cur.stacks, 1);
      else u.addMod(overloadCharge(a, 1), u, a);
    },
    // La activa solo existe con Shard.
    onTick() { gate(a, hasShard(a.owner as Unit)); },
  }),
  onSpellStart(a) {
    const u = a.owner as Unit;
    const cost = val(a, 'shard_manacost') * (1 - u.s.manaReduce);
    if (!hasShard(u) || u.mana < cost) { a.cd = 0.5; return; }
    u.mana -= cost;
    a.cd = val(a, 'shard_cooldown') * a.upg.cd * (1 - u.s.cdr);
    const r = val(a, 'shard_activation_radius');
    u.w.emit({ n: 'overload', x: u.x, y: u.y, r, t: u.team });
    for (const al of u.w.alliesIn(u.team, u.x, u.y, r, { heroes: true })) {
      al.removeModsByName('overload');
      al.addMod(overloadCharge(a, val(a, 'shard_activation_charges'), val(a, 'shard_activation_duration'), val(a, 'shard_attack_speed_bonus')), u, a);
    }
  },
});

defineAbility({
  key: 'storm_spirit_ball_lightning', target: 'point', ult: true, castBeyond: true, ai: { role: 'escape' },
  // Alcance ilimitado (castBeyond); el valor solo orienta a los bots.
  castRange: () => 1200,
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const w = u.w;
    // Coste real: base + % del maná máximo (el motor ya cobró el coste fijo del dataset).
    u.mana = Math.min(u.s.maxMana, u.mana + manaCostOf(a));
    const init = (val(a, 'ball_lightning_initial_mana_base') + u.s.maxMana * val(a, 'ball_lightning_initial_mana_percentage') / 100) * (1 - u.s.manaReduce);
    u.mana = Math.max(0, u.mana - init);
    const tx = t.x, ty = t.y;
    const hit = new Set<number>();
    let travelled = 0, sinceRemnant = 0;
    w.disjoint(u);
    u.order = null; u.path = [];
    u.removeModsByName('ball_lightning');
    u.addMod({
      name: 'ball_lightning', duration: 30, fx: 'ball_lightning',
      states: ST.invulnerable | ST.untargetable | ST.busy | ST.noCollision | ST.flying | ST.disarmed | ST.silenced | ST.muted,
      onTick(m, dt) {
        const d = Math.hypot(tx - u.x, ty - u.y);
        let step = Math.min(d, val(a, 'ball_lightning_move_speed') * dt);
        const per100 = (val(a, 'ball_lightning_travel_cost_base') + u.s.maxMana * val(a, 'ball_lightning_travel_cost_percent') / 100) * (1 - u.s.manaReduce);
        const afford = u.mana / per100 * 100;
        if (afford < step) step = afford;
        u.mana = Math.max(0, u.mana - per100 * step / 100);
        if (d > 0.5) {
          u.facing = Math.atan2(ty - u.y, tx - u.x);
          u.x += (tx - u.x) / d * step; u.y += (ty - u.y) / d * step;
        }
        travelled += step; sinceRemnant += step;
        for (const e of w.enemiesIn(u.team, u.x, u.y, val(a, 'ball_lightning_aoe'))) {
          if (hit.has(e.id) || e.kind === 'ward') continue;
          hit.add(e.id);
          damage(u, e, dmg(a, 'abilitydamage') * travelled / 100, 'magical', a);
        }
        w.addVision(u.team, u.x, u.y, val(a, 'ball_lightning_vision_radius'), 0.2);
        // Talento: deja remanentes por el camino.
        const every = val(a, 'auto_remnant_interval');
        const rem = u.abilities.find((x) => x.key === 'storm_spirit_static_remnant');
        if (every > 0 && sinceRemnant >= every && rem && rem.level > 0) { sinceRemnant = 0; spawnRemnant(u, rem, u.x, u.y); }
        if (step < 0.5 || Math.hypot(tx - u.x, ty - u.y) < 1) m.remaining = 0.001;
      },
      onDestroy() { w.forceMove(u, u.x, u.y); },
    }, u, a);
  },
});

defineAbility({
  key: 'storm_spirit_galvanized', target: 'passive', innate: true, noIllusion: true,
  passive: (a) => ({
    name: 'galvanized', stacks: a.data.charges ?? 0,
    props: () => ({ manaRegen: (a.data.charges ?? 0) * val(a, 'mp_per_kill') + (a.data.perm ?? 0) }),
    onAnyDeath(m, victim, killer) {
      const u = m.owner as Unit;
      if (victim.kind !== 'hero' || victim.team === u.team) return;
      const k = killer ? heroOf(killer as Unit) : null;
      if (k !== u && !(u.alive && Math.hypot(victim.x - u.x, victim.y - u.y) <= val(a, 'aoe'))) return;
      a.data.charges = (a.data.charges ?? 0) + 1;
      a.data.perm = (a.data.perm ?? 0) + val(a, 'perma_mp_per_kill');
      m.stacks = a.data.charges;
      u.refreshStats();
    },
    onDeath(m) {
      a.data.charges = Math.max(0, (a.data.charges ?? 0) - val(a, 'charges_per_death'));
      m.stacks = a.data.charges;
    },
  }),
});

defineHero('storm_spirit', ['storm_spirit_static_remnant', 'storm_spirit_electric_vortex', 'storm_spirit_overload', 'storm_spirit_ball_lightning', 'storm_spirit_galvanized'], {
  build: ['null_talisman', 'power_treads', 'kaya', 'orchid', 'black_king_bar', 'ultimate_scepter', 'sheepstick', 'bloodthorn'],
});

