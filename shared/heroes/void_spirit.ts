import { ATTR } from '../sim/unit';
import { defineAbility, defineHero, dmg, dur, hasScepter, val } from '../sim/abilities';
import { damage, landAttack, makeAttack } from '../sim/combat';
import type { AbilityInst } from '../sim/types';
import { ST } from '../sim/types';
import type { Unit } from '../sim/unit';
import { barrierMod, dist, trueSightAt } from './lib/a9';
import { canDebuff, castDir, debuff, root, silence } from './util';

/** Distancia de un punto a un segmento. */
function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const vx = bx - ax, vy = by - ay;
  const l2 = vx * vx + vy * vy || 1;
  const k = Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / l2));
  return Math.hypot(px - (ax + vx * k), py - (ay + vy * k));
}

/** Remanente en (x, y) mirando en (dx, dy). */
function remnantAt(a: AbilityInst, x: number, y: number, dx: number, dy: number) {
  const u = a.owner as Unit;
  const w = u.w;
  const len = val(a, 'remnant_watch_distance'), wr = val(a, 'remnant_watch_radius');
  const shard = val(a, 'pierces_creeps') > 0;
  const rot = val(a, 'rotation_speed');
  const start = w.time;
  let creepAcc = 0;
  w.emit({ n: 'aether_remnant', x, y, x2: x + dx * len, y2: y + dy * len, d: dur(a, 'duration'), t: u.team });
  w.addVision(u.team, x + dx * len / 2, y + dy * len / 2, val(a, 'watch_path_vision_radius') + len / 2, dur(a, 'duration'));
  const zone = w.addZone({
    fx: 'aether_remnant', x, y, r: val(a, 'remnant_watch_radius'), team: u.team, interval: val(a, 'think_interval') || 0.1,
    duration: dur(a, 'duration'),
    onInterval(z) {
      if (w.time - start < val(a, 'activation_delay')) return;
      const paths: [number, number][] = [[dx, dy]];
      if (shard) {
        const ang = Math.atan2(dy, dx) + rot * (w.time - start);
        paths.push([Math.cos(ang), Math.sin(ang)]);
        if (val(a, 'truesight_range') > 0) trueSightAt(u, x, y, val(a, 'truesight_range'), 0.2);
      }
      const on = (e: Unit) => paths.some(([px, py]) => segDist(e.x, e.y, x, y, x + px * len, y + py * len) <= wr + e.radius);
      const list = w.enemiesIn(u.team, x, y, len + wr).filter(on);
      // Con Shard los creeps no lo activan: reciben daño periódico.
      if (shard) {
        creepAcc += z.interval;
        const tick = val(a, 'damage_tick_rate');
        if (tick > 0 && creepAcc >= tick) {
          creepAcc -= tick;
          for (const c of list) if (!c.isHeroLike) damage(u, c, dmg(a, 'impact_damage') * val(a, 'creep_damage_pct') / 100 * tick, 'magical', a, { noProc: true });
        }
      }
      const victim = list.find((e) => e.isHeroLike) ?? (shard ? undefined : list.find((e) => e.kind === 'creep'));
      if (!victim) return;
      z.until = w.time;
      damage(u, victim, dmg(a, 'impact_damage'), 'magical', a);
      const pd = dur(a, 'pull_duration');
      const k = val(a, 'pull_destination') / 100;
      const tx = victim.x + (x - victim.x) * k, ty = victim.y + (y - victim.y) * k;
      const speed = Math.hypot(tx - victim.x, ty - victim.y) / Math.max(0.1, pd);
      w.emit({ n: 'aether_pull', x, y, u: victim.id });
      debuff(u, victim, a, {
        name: 'aether_remnant_pull', duration: pd, states: ST.stunned, fx: 'pull',
        onTick(m, dt) {
          const v = m.owner as Unit;
          const d = Math.hypot(tx - v.x, ty - v.y);
          if (d < 4) return;
          const s = Math.min(d, speed * dt);
          w.forceMove(v, v.x + (tx - v.x) / d * s, v.y + (ty - v.y) / d * s);
        },
      });
    },
  });
  return zone;
}

defineAbility({
  key: 'void_spirit_aether_remnant', target: 'point', ai: { role: 'disable' },
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const [dx, dy] = castDir(u, t.x, t.y);
    const delay = dist(u, t) / val(a, 'projectile_speed');
    u.w.emit({ n: 'aether_remnant_proj', x: u.x, y: u.y, x2: t.x, y2: t.y, u: u.id });
    u.w.after(delay, () => remnantAt(a, t.x, t.y, dx, dy));
  },
});

defineAbility({
  key: 'void_spirit_dissimilate', target: 'none', ai: { role: 'aoe', selfRadius: 600 },
  onSpellStart(a) {
    const u = a.owner as Unit;
    const w = u.w;
    const cx = u.x, cy = u.y;
    const off = val(a, 'first_ring_distance_offset');
    const n = val(a, 'portals_per_ring');
    const step = val(a, 'angle_per_ring_portal') * Math.PI / 180;
    const portals: [number, number][] = [[cx, cy]];
    const base = u.facing;
    for (let i = 0; i < n; i++) portals.push([cx + Math.cos(base + i * step) * off, cy + Math.sin(base + i * step) * off]);
    if (val(a, 'has_outer_ring') > 0) {
      for (let i = 0; i < n; i++) portals.push([cx + Math.cos(base + (i + 0.5) * step) * off * 2, cy + Math.sin(base + (i + 0.5) * step) * off * 2]);
    }
    for (const [px, py] of portals) w.emit({ n: 'dissimilate_portal', x: px, y: py, r: val(a, 'destination_fx_radius'), d: val(a, 'phase_duration'), t: u.team });
    w.disjoint(u);
    u.atk.phase = 0;
    u.addMod({
      name: 'dissimilate', duration: val(a, 'phase_duration'), fx: 'dissimilate',
      states: ST.hidden | ST.invulnerable | ST.untargetable | ST.noCollision,
      onDestroy() {
        // Sale por el portal más cercano a donde se le ha mandado ir.
        const o = u.order;
        let gx = cx, gy = cy;
        if (o && (o.type === 'move' || o.type === 'attackMove')) { gx = o.x; gy = o.y; } else if (o && (o.type === 'attack' || o.type === 'follow')) {
          const t = w.units.get(o.target); if (t) { gx = t.x; gy = t.y; }
        } else if (u.isBot && u.ai?.target) {
          const t = w.units.get(u.ai.target); if (t) { gx = t.x; gy = t.y; }
        }
        const [px, py] = portals.reduce((b, p) => (Math.hypot(p[0] - gx, p[1] - gy) < Math.hypot(b[0] - gx, b[1] - gy) ? p : b));
        w.teleport(u, px, py);
        const r = val(a, 'damage_radius');
        w.emit({ n: 'dissimilate_exit', x: u.x, y: u.y, r, t: u.team });
        for (const e of w.enemiesIn(u.team, u.x, u.y, r)) {
          damage(u, e, dmg(a, 'abilitydamage'), 'magical', a);
          if (val(a, 'root_duration') > 0) root(u, e, val(a, 'root_duration'), a);
        }
      },
    }, u, a);
  },
});

defineAbility({
  key: 'void_spirit_resonant_pulse', target: 'none', ai: { role: 'aoe', selfRadius: 450 },
  charges: (a) => hasScepter(a.owner as Unit)
    ? [val(a, 'max_charges'), val(a, 'charge_restore_time') * (1 - (a.owner as Unit).s.cdr)]
    : [1, val(a, '_cd') * (1 - (a.owner as Unit).s.cdr)],
  onSpellStart(a) {
    const u = a.owner as Unit;
    const w = u.w;
    const r = val(a, 'radius');
    const shield = u.addMod(barrierMod('resonant_pulse', dur(a, 'buff_duration'), dmg(a, 'base_absorb_amount'),
      val(a, 'is_all_barrier') ? undefined : 'physical'), u, a);
    shield.data.left = dmg(a, 'base_absorb_amount');
    w.emit({ n: 'resonant_pulse', x: u.x, y: u.y, r, t: u.team });
    for (const e of w.enemiesIn(u.team, u.x, u.y, r)) {
      w.after(dist(u, e) / val(a, 'speed'), () => {
        if (!e.alive || !canDebuff(u, e, a)) return;
        damage(u, e, dmg(a, 'damage'), 'magical', a);
        if (hasScepter(u)) silence(u, e, val(a, 'silence_duration_scepter'), a);
        if (e.isHeroLike && u.mods.includes(shield)) shield.data.left += dmg(a, 'absorb_per_hero_hit');
      });
    }
  },
});

defineAbility({
  key: 'void_spirit_intrinsic_edge', target: 'passive', innate: true,
  passive: (a) => ({
    name: 'intrinsic_edge', interval: 1,
    props: (m) => {
      const s = (m.owner as Unit).s;
      const k = val(a, 'secondary_stat_bonus_pct') / 100;
      return {
        damage: (s.str + s.agi + s.int) * ATTR.universalDmg * val(a, 'damage_stat_bonus_pct') / 100,
        hpRegen: s.str * ATTR.hpRegenPerStr * k,
        attackSpeed: s.agi * ATTR.asPerAgi * k,
        manaRegen: s.int * ATTR.manaRegenPerInt * k,
      };
    },
    onInterval(m) { (m.owner as Unit).refreshStats(); },
  }),
});

defineAbility({
  key: 'void_spirit_astral_step', target: 'point', ult: true, castBeyond: true, ai: { role: 'nuke' },
  charges: (a) => [val(a, 'abilitycharges'), val(a, 'abilitychargerestoretime')],
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const w = u.w;
    const [dx, dy] = castDir(u, t.x, t.y);
    const go = Math.max(val(a, 'min_travel_distance'), Math.min(val(a, 'max_travel_distance') + u.s.castRange, dist(u, t)));
    const fx = u.x, fy = u.y;
    w.disjoint(u);
    w.teleport(u, fx + dx * go, fy + dy * go);
    w.emit({ n: 'astral_step', x: fx, y: fy, x2: u.x, y2: u.y, u: u.id, t: u.team });
    const r = val(a, 'radius');
    const crit = val(a, 'crit_damage') / 100;
    for (const e of w.enemiesIn(u.team, (fx + u.x) / 2, (fy + u.y) / 2, go / 2 + r)) {
      if (segDist(e.x, e.y, fx, fy, u.x, u.y) > r + e.radius || e.kind === 'ward') continue;
      const ev = makeAttack(u, e, true);
      ev.trueStrike = true;
      if (crit > 1) ev.critMult = Math.max(ev.critMult, crit);
      landAttack(ev);
      if (!e.alive) continue;
      debuff(u, e, a, {
        name: 'astral_step_mark', duration: val(a, 'pop_damage_delay'), fx: 'void_mark', purgable: false,
        props: { msSlow: val(a, 'movement_slow_pct') / 100 },
        onDestroy(m) { if (m.remaining <= 0.05 && (m.owner as Unit).alive) damage(u, m.owner as Unit, dmg(a, 'pop_damage'), 'magical', a); },
      });
    }
  },
});

defineHero('void_spirit', ['void_spirit_aether_remnant', 'void_spirit_dissimilate', 'void_spirit_resonant_pulse', 'void_spirit_intrinsic_edge', 'void_spirit_astral_step'], {
  build: ['bracer', 'phase_boots', 'kaya', 'orchid', 'black_king_bar', 'ultimate_scepter', 'bloodthorn'],
});
