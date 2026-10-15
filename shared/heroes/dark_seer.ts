import { cooldownOf, defineAbility, defineHero, dmg, dur, hasShard, val } from '../sim/abilities';
import { damage } from '../sim/combat';
import type { AbilityInst } from '../sim/types';
import { ST } from '../sim/types';
import type { Unit } from '../sim/unit';
import { castDir, debuff, push, slow, stun } from './util';
import { aiBy, alliesNear, botCast, replicaFor, segInfo } from './lib/a2';

defineAbility({
  key: 'dark_seer_vacuum', target: 'point', ai: { role: 'disable' },
  aoe: (a) => val(a, 'radius'),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const r = val(a, 'radius');
    const d = val(a, 'duration');
    u.w.emit({ n: 'vacuum', x: t.x, y: t.y, r, d, t: u.team });
    u.w.cutTrees(t.x, t.y, val(a, 'radius_tree'));
    for (const e of u.w.enemiesIn(u.team, t.x, t.y, r)) {
      const dist = Math.hypot(e.x - t.x, e.y - t.y);
      const speed = dist / Math.max(0.05, d);
      e.w.disjoint(e);
      debuff(u, e, a, {
        name: 'vacuum', duration: d, states: ST.stunned, fx: 'vacuum',
        onTick(m, dt) {
          const v = m.owner as Unit;
          const left = Math.hypot(t.x - v.x, t.y - v.y);
          if (left < 5) return;
          const step = Math.min(left, speed * dt);
          v.w.forceMove(v, v.x + (t.x - v.x) / left * step, v.y + (t.y - v.y) / left * step);
        },
        onDestroy(m) { damage(u, m.owner as Unit, dmg(a, 'damage'), 'magical', a); },
      });
      if (e.cast) e.w.interruptCast(e, true);
    }
  },
});

/** Ion Shell sobre una unidad: daña a los enemigos de Dark Seer a su alrededor. */
function ionShell(a: AbilityInst, t: Unit) {
  const u = a.owner as Unit;
  const tick = val(a, 'tick_interval');
  t.addMod({
    name: 'ion_shell', duration: dur(a, 'duration'), fx: 'ion_shell', interval: tick, debuff: t.team !== u.team,
    props: { hp: val(a, 'bonus_health') },
    onInterval(m) {
      const v = m.owner as Unit;
      for (const e of v.w.enemiesIn(u.team, v.x, v.y, val(a, 'radius'))) {
        if (e === v) continue;
        damage(u, e, dmg(a, 'damage_per_second') * tick, 'magical', a, { noProc: true });
      }
    },
  }, u, a);
}

defineAbility({
  key: 'dark_seer_ion_shell', target: 'unit', team: 'any', allowSelf: true, ai: aiBy('buff'),
  charges: (a) => [Math.max(1, val(a, 'abilitycharges')), cooldownOf(a)],
  passive: (a) => botCast(a, (u) => {
    if (!u.w.enemiesIn(u.team, u.x, u.y, 900).length) return null;
    const cands = alliesNear(u, u.x, u.y, 800, false).filter((v) => !v.findMod('ion_shell', u) && (v.isHeroLike || v.kind === 'summon'))
      .sort((x, y) => Number(y.kind === 'hero') - Number(x.kind === 'hero'));
    return cands[0] ? { unit: cands[0] } : null;
  }),
  noIllusion: true,
  onSpellStart(a, t) {
    const e = (t.unit as Unit) ?? (a.owner as Unit);
    if (e.team !== (a.owner as Unit).team && e.has(ST.magicImmune)) return;
    ionShell(a, e);
  },
});

/** Surge sobre un aliado; con Shard deja un rastro que ralentiza y quema. */
function surge(a: AbilityInst, t: Unit) {
  const u = a.owner as Unit;
  t.addMod({
    name: 'surge', duration: dur(a, 'duration'), fx: 'surge', states: ST.noCollision,
    props: { msFixed: val(a, 'speed_boost'), slowResist: 1 },
    onTick(m, dt) {
      if (!hasShard(u) || u.data_surgeTrailOff) return;
      m.data.acc = (m.data.acc ?? 0) + dt;
      if (m.data.acc < 0.25) return;
      m.data.acc = 0;
      const v = m.owner as Unit;
      const r = val(a, 'trail_radius');
      const every = val(a, 'trail_damage_interval') || 0.5;
      u.w.addZone({
        fx: 'surge_trail', x: v.x, y: v.y, r, team: u.team, interval: every, duration: val(a, 'trail_duration'),
        onInterval(z) {
          for (const e of u.w.enemiesIn(u.team, z.x, z.y, r)) {
            slow(u, e, a, 'surge_trail', every + 0.1, Math.abs(val(a, 'trail_move_slow')) / 100);
            damage(u, e, val(a, 'trail_damage') * every, 'magical', a, { noProc: true });
          }
        },
      });
    },
  }, u, a);
}

defineAbility({
  key: 'dark_seer_surge', target: 'unit', team: 'ally', allowSelf: true, ai: aiBy('buff'),
  passive: (a) => botCast(a, (u) => {
    const e = u.w.enemiesIn(u.team, u.x, u.y, 1100, { heroes: true })[0];
    if (!e) return null;
    const d = Math.hypot(e.x - u.x, e.y - u.y);
    return d > 350 || u.hp / u.s.maxHp < 0.4 ? { unit: u } : null;
  }),
  noIllusion: true,
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const e = (t.unit as Unit) ?? u;
    const aoe = val(a, 'aoe_radius');
    const list = aoe > 0 ? alliesNear(u, e.x, e.y, aoe, false).filter((v) => v.isHeroLike || v.kind === 'summon') : [e];
    if (!list.includes(e)) list.push(e);
    for (const v of list) surge(a, v);
  },
});

defineAbility({
  key: 'dark_seer_normal_punch', target: 'passive',
  passive: (a) => ({
    name: 'normal_punch',
    // Distancia recorrida en los últimos segundos.
    onTick(m) {
      const u = m.owner as Unit;
      const h: { t: number; x: number; y: number; d: number }[] = m.data.hist ??= [];
      const last = h[h.length - 1];
      const step = last ? Math.min(200, Math.hypot(u.x - last.x, u.y - last.y)) : 0;
      h.push({ t: u.w.time, x: u.x, y: u.y, d: (last?.d ?? 0) + step });
      const keep = val(a, 'recent_duration');
      while (h.length > 2 && h[0].t < u.w.time - keep) h.shift();
    },
    onAttackStart(m, ev) {
      const t = ev.target as Unit;
      m.data.punch = 0;
      if (a.cd > 0 || !t.isHeroLike || t.team === (m.owner as Unit).team || ev.fake) return;
      ev.trueStrike = true;
      m.data.punch = t.id;
    },
    onAttackLanded(m, ev) {
      const u = m.owner as Unit;
      const t = ev.target as Unit;
      if (!m.data.punch || m.data.punch !== t.id || a.cd > 0) return;
      m.data.punch = 0;
      a.cd = cooldownOf(a);
      const h = m.data.hist as { d: number }[];
      const moved = h.length ? h[h.length - 1].d - h[0].d : 0;
      const f = Math.min(1, moved / val(a, 'max_distance'));
      const ox = t.x, oy = t.y;
      u.w.emit({ n: 'normal_punch', x: t.x, y: t.y, u: t.id, u2: u.id });
      damage(u, t, val(a, 'max_damage') * f, 'magical', a);
      if (!t.alive) return;
      if (f > 0) stun(u, t, val(a, 'max_stun') * f, a);
      const [dx, dy] = castDir(u, t.x, t.y);
      push(t, dx, dy, val(a, 'knockback_distance') * Math.max(0.3, f), 0.3, u, a, 'normal_punch_push');
      // La réplica sale del golpeado y sirve a Dark Seer.
      if (t.kind !== 'hero') return;
      const wall = u.abilities.find((x) => x.key === 'dark_seer_wall_of_replica' && x.level > 0);
      const out = wall ? val(wall, 'replica_damage_outgoing') : -30;
      const inc = wall ? val(wall, 'replica_damage_incoming') : 100;
      u.w.after(val(a, 'normal_punch_illusion_delay'), () => {
        if (!u.alive) return;
        const il = replicaFor(u, t, ox, oy, val(a, 'illusion_duration'), out / 100, inc / 100);
        if (t.alive) u.w.issueOrder(il, { type: 'attack', target: t.id });
      });
    },
  }),
});

defineAbility({
  key: 'dark_seer_aggrandize', target: 'passive', innate: true, noIllusion: false,
  passive: (a) => ({
    name: 'aggrandize', interval: 0.5,
    props: (m) => ({ attackSpeed: ((m.owner as Unit).s?.int ?? 0) * val(a, 'int_to_atkspd') }),
    onInterval(m) {
      const u = m.owner as Unit;
      if (u.kind !== 'hero') return;
      a.data.lvl ??= u.level;
      if (u.level > a.data.lvl) {
        const n = u.level - a.data.lvl;
        a.data.lvl = u.level;
        const pct = val(a, 'heal_pct') / 100 * n;
        u.hp = Math.min(u.s.maxHp, u.hp + u.s.maxHp * pct);
        u.mana = Math.min(u.s.maxMana, u.mana + u.s.maxMana * pct);
      }
      u.refreshStats();
    },
  }),
});

defineAbility({
  key: 'dark_seer_wall_of_replica', target: 'point', ult: true, ai: { role: 'disable' },
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    a.cd = Math.max(0, a.cd - val(a, 'cooldown_reduction'));
    const [dx, dy] = castDir(u, t.x, t.y);
    const half = val(a, 'width') * Math.max(1, val(a, 'scepter_length_multiplier') || 1) / 2;
    const ax = t.x - dy * half, ay = t.y + dx * half, bx = t.x + dy * half, by = t.y - dx * half;
    const duration = val(a, 'duration');
    const until = u.w.time + duration;
    const replicated = new Set<number>();
    u.w.emit({ n: 'wall_of_replica', x: ax, y: ay, x2: bx, y2: by, d: duration, t: u.team });
    u.w.addZone({
      fx: 'wall_of_replica', x: t.x, y: t.y, r: 0, team: u.team, interval: 0.1, duration,
      onInterval() {
        for (const e of u.w.enemiesIn(u.team, t.x, t.y, half + 100)) {
          const s = segInfo(e.x, e.y, ax, ay, bx, by);
          if (s.dist > e.radius + 25) continue;
          slow(u, e, a, 'wall_of_replica_slow', val(a, 'slow_duration'), val(a, 'movement_slow') / 100);
          if (!e.findMod('wall_of_replica_burn', u)) {
            damage(u, e, dmg(a, 'wall_damage'), 'magical', a);
            debuff(u, e, a, { name: 'wall_of_replica_burn', duration: 1 });
          }
          if (e.kind === 'hero' && !replicated.has(e.id)) {
            replicated.add(e.id);
            const il = replicaFor(u, e, e.x, e.y, Math.max(0.5, until - u.w.time),
              val(a, 'replica_damage_outgoing') / 100, val(a, 'replica_damage_incoming') / 100);
            u.w.issueOrder(il, { type: 'attack', target: e.id });
          }
        }
      },
    });
  },
});

defineHero('dark_seer', ['dark_seer_vacuum', 'dark_seer_ion_shell', 'dark_seer_surge', 'dark_seer_normal_punch', 'dark_seer_aggrandize', 'dark_seer_wall_of_replica'], {
  build: ['null_talisman', 'arcane_boots', 'blink', 'pipe', 'black_king_bar', 'shivas_guard', 'ultimate_scepter', 'refresher'],
  upgrades: [
    { slot: 0, key: 'damage', amount: 40, max: 5, label: 'Vacuum: +40 daño' },
    { slot: 0, key: 'radius', amount: 30, max: 4, label: 'Vacuum: +30 radio' },
    { slot: 1, key: 'damage_per_second', amount: 15, max: 5, label: 'Ion Shell: +15 daño por segundo' },
    { slot: 2, key: 'duration', amount: 0.5, max: 4, label: 'Surge: +0,5 s' },
    { slot: 5, key: 'replica_damage_outgoing', amount: 8, max: 4, label: 'Wall of Replica: +8% daño de réplicas' },
  ],
});
