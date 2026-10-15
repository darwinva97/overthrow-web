import { castRangeOf, defineAbility, defineHero, dmg, dur, hasScepter, hasShard, val } from '../sim/abilities';
import { damage, heal, kill } from '../sim/combat';
import type { AbilityInst, Modifier, Order } from '../sim/types';
import { ST } from '../sim/types';
import type { Unit } from '../sim/unit';
import { castDir, debuff, stun } from './util';
import { abil, enemiesInLine, gate } from './lib/a6';

const DEG = Math.PI / 180;

/** Coste de vida (porcentaje de la vida actual), nunca letal. */
function hpCost(u: Unit, pct: number) {
  damage(u, u, u.hp * pct / 100, 'pure', null, { hpRemoval: true, noProc: true, data: { nonLethal: true } });
}

/** Punto hacia el que gira el jugador (orden actual) o, en bots, su objetivo. */
function aimPoint(u: Unit): { x: number; y: number } | null {
  const o = u.order as Order | null;
  if (o && (o.type === 'move' || o.type === 'attackMove')) return { x: o.x, y: o.y };
  if (o && (o.type === 'attack' || o.type === 'follow')) return u.w.units.get(o.target) ?? null;
  if (u.isBot) {
    const t = u.w.units.get(u.ai?.target ?? 0);
    if (t && t.alive) return t;
  }
  return null;
}

function turnToward(u: Unit, p: { x: number; y: number }, degPerSec: number, dt: number) {
  const want = Math.atan2(p.y - u.y, p.x - u.x);
  let d = want - u.facing;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  const r = degPerSec * DEG * dt;
  u.facing += Math.max(-r, Math.min(r, d));
}

defineAbility({
  key: 'phoenix_icarus_dive', target: 'point', castBeyond: true, ai: { role: 'disable' },
  castRange: (a) => val(a, 'dash_length'),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    hpCost(u, val(a, 'hp_cost_perc'));
    const [fx, fy] = castDir(u, t.x, t.y);
    const L = val(a, 'dash_length') * a.upg.range, W = val(a, 'dash_width');
    const T = val(a, 'dive_duration');
    const ox = u.x, oy = u.y;
    u.order = null; u.path = [];
    u.addMod({
      name: 'icarus_dive', duration: T, fx: 'icarus_dive', states: ST.busy | ST.noCollision | ST.flying,
      data: { t: 0 },
      onTick(m, dt) {
        m.data.t += dt;
        const s = Math.min(1, m.data.t / T);
        // Elipse: sale hasta L y vuelve al punto de partida.
        const f = L * (1 - Math.cos(2 * Math.PI * s)) / 2;
        const l = (W / 2) * Math.sin(2 * Math.PI * s);
        u.w.forceMove(u, ox + fx * f - fy * l, oy + fy * f + fx * l);
        const tick = val(a, 'burn_tick_interval');
        for (const e of u.w.enemiesIn(u.team, u.x, u.y, val(a, 'hit_radius'))) {
          debuff(u, e, a, {
            name: 'icarus_dive_burn', duration: val(a, 'burn_duration'), interval: tick, fx: 'burn',
            props: { msSlow: val(a, 'slow_movement_speed_pct') / 100 },
            onInterval(mm) { damage(u, mm.owner as Unit, dmg(a, 'damage_per_second') * tick, 'magical', a, { noProc: true }); },
          });
        }
      },
      onDestroy() { gate(abil(u, 'phoenix_icarus_dive_stop'), false); },
    }, u, a);
    gate(abil(u, 'phoenix_icarus_dive_stop'), true);
  },
});

defineAbility({
  key: 'phoenix_icarus_dive_stop', target: 'none', levelWith: 0,
  hidden: (a) => !(a.owner as Unit).findMod('icarus_dive'),
  onSpellStart(a) { (a.owner as Unit).removeModsByName('icarus_dive'); gate(a, false); },
});

defineAbility({
  key: 'phoenix_fire_spirits', target: 'none', ai: { role: 'aoe', selfRadius: 1000 },
  onSpellStart(a) {
    const u = a.owner as Unit;
    hpCost(u, val(a, 'hp_cost_perc'));
    u.removeModsByName('fire_spirits');
    u.addMod({
      name: 'fire_spirits', duration: val(a, 'spirit_duration'), fx: 'fire_spirits', stacks: val(a, 'spirit_count'),
      onDestroy() { gate(abil(u, 'phoenix_launch_fire_spirit'), false); },
    }, u, a);
    gate(abil(u, 'phoenix_launch_fire_spirit'), true);
  },
});

defineAbility({
  key: 'phoenix_launch_fire_spirit', target: 'point', levelWith: 1, ai: { role: 'nuke' },
  hidden: (a) => !(a.owner as Unit).findMod('fire_spirits'),
  aoe: (a) => val(a, 'radius'),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const m = u.findMod('fire_spirits');
    if (!m) { gate(a, false); return; }
    m.stacks--;
    if (m.stacks <= 0) u.removeMod(m);
    const parent = abil(u, 'phoenix_fire_spirits') ?? a;
    const delay = Math.hypot(t.x - u.x, t.y - u.y) / val(a, 'spirit_speed');
    u.w.emit({ n: 'fire_spirit', x: u.x, y: u.y, x2: t.x, y2: t.y, d: delay, t: u.team });
    u.w.after(delay, () => {
      const r = val(a, 'radius');
      const tick = val(parent, 'tick_interval');
      u.w.emit({ n: 'fire_spirit_hit', x: t.x, y: t.y, r, t: u.team });
      for (const e of u.w.enemiesIn(u.team, t.x, t.y, r)) {
        debuff(u, e, parent, {
          name: 'fire_spirit_burn', duration: dur(parent, 'duration'), interval: tick, fx: 'burn',
          props: { attackSlow: Math.abs(val(parent, 'attackspeed_slow')) },
          onInterval(mm) { damage(u, mm.owner as Unit, dmg(parent, 'damage_per_second') * tick, 'magical', parent, { noProc: true }); },
        });
      }
    });
  },
});

defineAbility({
  key: 'phoenix_sun_ray', target: 'point', castBeyond: true, ai: { role: 'nuke' },
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    u.facing = Math.atan2(t.y - u.y, t.x - u.x);
    u.order = null; u.path = [];
    const tick = val(a, 'tick_interval');
    const shardSlow = hasShard(u) ? (val(a, 'shard_move_slow_pct') || 10) / 100 : 0;
    u.addMod({
      name: 'sun_ray', duration: val(a, 'abilityduration'), fx: 'sun_ray', states: ST.busy | ST.disarmed,
      data: { t: 0, acc: 0, move: false },
      onTick(m, dt) {
        m.data.t += dt;
        if (u.has(ST.stunned) || u.has(ST.silenced) || u.has(ST.hexed)) { u.removeMod(m); return; }
        const p = aimPoint(u);
        if (p) turnToward(u, p, m.data.t < 0.5 ? val(a, 'turn_rate_initial') : val(a, 'turn_rate'), dt);
        if (m.data.move && !u.has(ST.rooted)) {
          const step = val(a, 'forward_move_speed') * dt;
          u.w.forceMove(u, u.x + Math.cos(u.facing) * step, u.y + Math.sin(u.facing) * step);
        }
        m.data.acc += dt;
        if (m.data.acc < tick) return;
        m.data.acc -= tick;
        hpCost(u, val(a, 'hp_cost_perc_per_second') * tick);
        const len = castRangeOf(a), w = val(a, 'radius') * 2;
        const dx = Math.cos(u.facing), dy = Math.sin(u.facing);
        u.w.emit({ n: 'sun_ray', x: u.x, y: u.y, x2: u.x + dx * len, y2: u.y + dy * len, u: u.id, t: u.team });
        for (const e of enemiesInLine(u, u.x, u.y, dx, dy, len, w)) {
          damage(u, e, (dmg(a, 'base_damage') + e.s.maxHp * val(a, 'hp_perc_damage') / 100) * tick, 'magical', a, { noProc: true });
          if (shardSlow > 0) debuff(u, e, a, { name: 'sun_ray_slow', duration: tick + 0.1, props: { msSlow: shardSlow } });
        }
        for (const al of u.w.alliesIn(u.team, u.x + dx * len / 2, u.y + dy * len / 2, len / 2 + w)) {
          if (al === u || !al.isHeroLike && al.kind !== 'creep') continue;
          const px = al.x - u.x, py = al.y - u.y;
          const along = px * dx + py * dy;
          if (along < 0 || along > len || Math.abs(px * dy - py * dx) > w / 2 + al.radius) continue;
          heal(al, (val(a, 'base_heal') + al.s.maxHp * val(a, 'hp_perc_heal') / 100) * tick, u, true);
        }
      },
      onDestroy() {
        gate(abil(u, 'phoenix_sun_ray_stop'), false);
        gate(abil(u, 'phoenix_sun_ray_toggle_move'), false);
      },
    }, u, a);
    gate(abil(u, 'phoenix_sun_ray_stop'), true);
    gate(abil(u, 'phoenix_sun_ray_toggle_move'), true);
  },
});

defineAbility({
  key: 'phoenix_sun_ray_toggle_move', target: 'none', levelWith: 2,
  hidden: (a) => !(a.owner as Unit).findMod('sun_ray'),
  onSpellStart(a) {
    const m = (a.owner as Unit).findMod('sun_ray');
    if (m) m.data.move = !m.data.move;
    else gate(a, false);
  },
});

defineAbility({
  key: 'phoenix_sun_ray_stop', target: 'none', levelWith: 2,
  hidden: (a) => !(a.owner as Unit).findMod('sun_ray'),
  onSpellStart(a) { (a.owner as Unit).removeModsByName('sun_ray'); gate(a, false); },
});

defineAbility({
  key: 'phoenix_dying_light', target: 'passive', innate: true, noIllusion: true,
  passive: (a) => ({
    name: 'dying_light', interval: val(a, 'tick_interval'),
    onInterval(m) {
      const u = m.owner as Unit;
      if (u.has(ST.hidden)) return;
      const missing = u.s.maxHp - u.hp;
      if (missing <= 1) return;
      const per = missing * val(a, 'damage_pct') / 100 * (m.interval ?? 0.2);
      for (const e of u.w.enemiesIn(u.team, u.x, u.y, val(a, 'radius'))) damage(u, e, per, 'magical', a, { noProc: true });
    },
  }),
});

/** Mete a `h` dentro del sol (oculto e invulnerable). */
function enterSun(h: Unit, u: Unit, a: AbilityInst, d: number): Modifier {
  h.purge(true, false, true);
  for (const n of ['icarus_dive', 'sun_ray', 'gyroshell']) h.removeModsByName(n);
  if (h.cast) h.w.interruptCast(h, true);
  h.w.disjoint(h);
  h.order = null; h.path = []; h.atk.phase = 0;
  return h.addMod({
    name: 'supernova_inside', duration: d, purgable: false,
    states: ST.hidden | ST.invulnerable | ST.untargetable | ST.busy | ST.magicImmune,
  }, u, a);
}

defineAbility({
  key: 'phoenix_supernova', target: 'none', ult: true, ai: { role: 'aoe', selfRadius: 500 },
  aoe: (a) => val(a, 'aura_radius'),
  onSpellStart(a) {
    const u = a.owner as Unit;
    const d = val(a, 'abilityduration');
    const hits = hasScepter(u) && val(a, 'max_hero_attacks_scepter') > 0 ? val(a, 'max_hero_attacks_scepter') : val(a, 'max_hero_attacks');
    // Scepter: se lleva consigo al aliado más herido cercano.
    const inside = [u];
    if (hasScepter(u)) {
      const r = val(a, 'cast_range_tooltip_scepter');
      const ally = u.w.alliesIn(u.team, u.x, u.y, r, { heroes: true })
        .filter((x) => x !== u && x.kind === 'hero' && x.hp / x.s.maxHp < 0.5)
        .sort((p, q) => p.hp / p.s.maxHp - q.hp / q.s.maxHp)[0];
      if (ally) inside.push(ally);
    }
    const sun = u.w.spawnSummon(u, 'phoenix_sun', u.x, u.y, d + 0.5, { hp: hits });
    sun.addMod({ name: 'phoenix_sun_body', persistent: true, states: ST.rooted, fx: 'supernova' });
    const tick = val(a, 'tick_interval');
    let exploded = false;
    sun.addMod({
      name: 'supernova_sun', persistent: true, interval: tick,
      // Solo los ataques de héroes enemigos le quitan "vida" (un golpe cada uno).
      onIncomingDamage(_m, ev) {
        const s = ev.source as Unit | null;
        ev.amount = ev.isAttack && s && s.kind === 'hero' && s.team !== u.team ? 1 : 0;
      },
      onInterval() {
        for (const e of u.w.enemiesIn(u.team, sun.x, sun.y, val(a, 'aura_radius'))) {
          damage(u, e, dmg(a, 'damage_per_sec') * tick, 'magical', a, { noProc: true });
        }
      },
      onDeath(_m, killer) {
        if (exploded) return;
        exploded = true;
        for (const h of inside) { h.removeModsByName('supernova_inside'); if (h.alive) kill(h, killer as Unit | null); }
      },
    }, u, a);
    for (const h of inside) enterSun(h, u, a, d + 1);
    u.w.after(d, () => {
      if (exploded || !sun.alive) return;
      exploded = true;
      const r = val(a, 'aura_radius');
      u.w.emit({ n: 'supernova', x: sun.x, y: sun.y, r, t: u.team });
      for (const e of u.w.enemiesIn(u.team, sun.x, sun.y, r)) stun(u, e, val(a, 'stun_duration'), a);
      for (const h of inside) {
        h.removeModsByName('supernova_inside');
        if (!h.alive) continue;
        h.w.teleport(h, sun.x, sun.y);
        h.hp = h.s.maxHp; h.mana = h.s.maxMana;
        // Renace con las habilidades listas (salvo la propia Supernova).
        if (h === u) for (const x of h.abilities) if (x !== a && x.cd < 1e5) x.cd = 0;
      }
      sun.expireAt = u.w.time;
    });
  },
});

defineHero('phoenix', ['phoenix_icarus_dive', 'phoenix_fire_spirits', 'phoenix_sun_ray', 'phoenix_sun_ray_toggle_move', 'phoenix_dying_light', 'phoenix_supernova', 'phoenix_launch_fire_spirit', 'phoenix_icarus_dive_stop', 'phoenix_sun_ray_stop'], {
  build: ['bracer', 'tranquil_boots', 'veil_of_discord', 'pipe', 'shivas_guard', 'ultimate_scepter', 'heart', 'lotus_orb'],
});
