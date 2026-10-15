import { cooldownOf, defineAbility, defineHero, dmg, dur, hasScepter, val } from '../sim/abilities';
import { damage, kill } from '../sim/combat';
import type { AbilityInst } from '../sim/types';
import { ST } from '../sim/types';
import type { Unit } from '../sim/unit';
import type { World } from '../sim/world';
import { castDir, debuff, push, silence } from './util';
import { segInfo } from './lib/a2';

/** Historial de posiciones de los héroes (para Glimpse), compartido por mundo. */
const HISTORY = new WeakMap<World, { at: number; pos: Map<number, { t: number; x: number; y: number }[]> }>();
function record(w: World) {
  let h = HISTORY.get(w);
  if (!h) { h = { at: -1, pos: new Map() }; HISTORY.set(w, h); }
  if (h.at === w.time) return h;
  h.at = w.time;
  for (const u of w.list) {
    if (!u.isHeroLike || !u.alive) continue;
    let arr = h.pos.get(u.id);
    if (!arr) { arr = []; h.pos.set(u.id, arr); }
    arr.push({ t: w.time, x: u.x, y: u.y });
    while (arr.length > 2 && arr[0].t < w.time - 6) arr.shift();
  }
  return h;
}
function positionAgo(u: Unit, secs: number) {
  const arr = HISTORY.get(u.w)?.pos.get(u.id);
  if (!arr || !arr.length) return { x: u.x, y: u.y };
  const want = u.w.time - secs;
  for (const p of arr) if (p.t >= want) return p;
  return arr[arr.length - 1];
}

defineAbility({
  key: 'disruptor_thunder_strike', target: 'unit', reflectable: true, ai: { role: 'nuke' },
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const e = t.unit as Unit;
    const n = val(a, 'strikes');
    const every = val(a, 'strike_interval');
    let count = 0;
    const strikeOnce = (v: Unit) => {
      const bonus = val(a, 'strike_damage_bonus') * count;
      count++;
      u.w.emit({ n: 'thunder_strike', x: v.x, y: v.y, r: val(a, 'radius'), u: v.id, t: u.team });
      for (const x of u.w.enemiesIn(u.team, v.x, v.y, val(a, 'radius'))) {
        damage(u, x, dmg(a, 'strike_damage') + bonus, 'magical', a);
        debuff(u, x, a, { name: 'thunder_strike_slow', duration: val(a, 'slow_duration'), fx: 'slow',
          props: { msSlow: val(a, 'slow_amount') / 100, attackSlow: val(a, 'slow_amount') * 10 } });
      }
    };
    const m = debuff(u, e, a, {
      name: 'thunder_strike', duration: every * (n - 1) + 0.1, interval: every, fx: 'thunder_strike',
      data: { team: u.team },
      onInterval(mm) { if (count < n) strikeOnce(mm.owner as Unit); },
      onTick(mm) { const v = mm.owner as Unit; u.w.addVision(u.team, v.x, v.y, 300, 0.2); },
    });
    if (m) strikeOnce(e);
  },
});

defineAbility({
  key: 'disruptor_glimpse', target: 'unit', reflectable: true, ai: { role: 'disable' },
  charges: (a) => [Math.max(1, val(a, 'abilitycharges')), cooldownOf(a)],
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const e = t.unit as Unit;
    if (e.kind === 'illusion') { kill(e, u); return; }
    const p = positionAgo(e, val(a, 'backtrack_time'));
    const dist = Math.hypot(p.x - e.x, p.y - e.y);
    const delay = Math.min(1.8, dist / 600);
    u.w.emit({ n: 'glimpse', x: e.x, y: e.y, x2: p.x, y2: p.y, u: e.id, d: delay });
    debuff(u, e, a, { name: 'glimpse', duration: delay + 0.05, fx: 'glimpse', purgable: false });
    u.w.after(delay, () => {
      if (!e.alive || !e.findMod('glimpse', u)) return;
      if (e.cast?.phase === 2) e.w.interruptCast(e, true);
      e.w.disjoint(e);
      e.w.teleport(e, p.x, p.y);
      const amt = Math.max(val(a, 'min_damage'), Math.min(val(a, 'max_damage'), dist * val(a, 'damage_to_distance_pct') / 100));
      damage(u, e, amt * a.upg.dmg, 'magical', a);
      if (val(a, 'silence_duration') > 0) silence(u, e, val(a, 'silence_duration'), a, 'glimpse_silence');
    });
  },
});

/** Barrera: los enemigos no pueden cruzar de un lado a otro. `side` dice en qué lado está cada uno. */
function barrier(a: AbilityInst, cx: number, cy: number, reach: number, duration: number, formation: number,
  sideOf: (x: number, y: number) => number, clamp: (v: Unit, side: number) => void, fx: { r?: number; x2?: number; y2?: number }) {
  const u = a.owner as Unit;
  const sides = new Map<number, number>();
  u.w.emit({ n: 'kinetic_warn', x: cx, y: cy, d: formation, t: u.team, ...fx });
  u.w.after(formation, () => {
    u.w.emit({ n: 'kinetic_field', x: cx, y: cy, d: duration, t: u.team, ...fx });
    u.w.addZone({
      fx: 'kinetic_field', x: cx, y: cy, r: fx.r ?? 0, team: u.team, interval: 1 / 30, duration,
      onInterval() {
        for (const e of u.w.enemiesIn(u.team, cx, cy, reach + 200)) {
          const s = sideOf(e.x, e.y);
          const prev = sides.get(e.id);
          if (prev === undefined) { sides.set(e.id, s); continue; }
          if (s !== prev) clamp(e, prev);
          if (val(a, 'damage_per_second') > 0) {
            damage(u, e, val(a, 'damage_per_second') / 30, 'magical', a, { noProc: true });
          }
        }
      },
    });
  });
}

defineAbility({
  key: 'disruptor_kinetic_field', target: 'point', ai: { role: 'disable' },
  aoe: (a) => val(a, 'radius'),
  onSpellStart(a, t) {
    const r = val(a, 'radius');
    const half = val(a, 'wall_thickness') / 2;
    barrier(a, t.x, t.y, r, dur(a, 'duration'), val(a, 'formation_time'),
      // 1 dentro, 0 fuera (con margen del grosor del muro).
      (x, y) => (Math.hypot(x - t.x, y - t.y) < r ? 1 : 0),
      (v, side) => {
        const d = Math.hypot(v.x - t.x, v.y - t.y) || 1;
        const to = side === 1 ? r - half - v.radius : r + half + v.radius;
        v.w.forceMove(v, t.x + (v.x - t.x) / d * to, t.y + (v.y - t.y) / d * to);
      }, { r });
  },
});

defineAbility({
  key: 'disruptor_kinetic_fence', target: 'point', ai: { role: 'disable' },
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const [dx, dy] = castDir(u, t.x, t.y);
    const half = val(a, 'wall_width') / 2;
    const ax = t.x - dy * half, ay = t.y + dx * half, bx = t.x + dy * half, by = t.y - dx * half;
    const thick = val(a, 'wall_thickness') / 2;
    barrier(a, t.x, t.y, half, dur(a, 'duration'), val(a, 'formation_time'),
      (x, y) => {
        const s = segInfo(x, y, ax, ay, bx, by);
        // Fuera de los extremos del muro no hay lado que respetar.
        return s.t <= 0 || s.t >= 1 ? 2 : s.side;
      },
      (v, side) => {
        if (side === 2) return;
        const s = segInfo(v.x, v.y, ax, ay, bx, by);
        if (s.t <= 0 || s.t >= 1) return;
        // Normal hacia el lado original.
        let nx = dx, ny = dy;
        const test = segInfo(t.x + nx * 10, t.y + ny * 10, ax, ay, bx, by).side;
        if (test !== side) { nx = -nx; ny = -ny; }
        v.w.forceMove(v, s.cx + nx * (thick + v.radius), s.cy + ny * (thick + v.radius));
      }, { x2: bx, y2: by, r: 0 });
    u.w.emit({ n: 'kinetic_fence', x: ax, y: ay, x2: bx, y2: by, t: u.team });
  },
});

defineAbility({
  key: 'disruptor_electromagnetic_repulsion', target: 'passive', innate: true, noIllusion: true,
  passive: (a) => ({
    name: 'electromagnetic_repulsion',
    // También guarda el historial de posiciones para Glimpse.
    onTick(m) { record((m.owner as Unit).w); },
    onTakeDamage(m, ev) {
      const u = m.owner as Unit;
      const src = ev.source as Unit | null;
      if (!src || src.team === u.team || Math.hypot(src.x - u.x, src.y - u.y) > val(a, 'effect_radius')) return;
      if (u.w.time - (m.data.since ?? -99) > val(a, 'damage_reset_interval')) { m.data.since = u.w.time; m.data.acc = 0; }
      m.data.acc += ev.amount;
      if (m.data.acc < val(a, 'damage_threshold') || a.cd > 0) return;
      m.data.acc = 0;
      a.cd = cooldownOf(a);
      const r = val(a, 'effect_radius');
      u.w.emit({ n: 'repulsion', x: u.x, y: u.y, r, u: u.id });
      for (const e of u.w.enemiesIn(u.team, u.x, u.y, r)) {
        damage(u, e, u.s.int * val(a, 'damage_per_int'), 'magical', a);
        const d = Math.hypot(e.x - u.x, e.y - u.y);
        const [dx, dy] = d > 1 ? [(e.x - u.x) / d, (e.y - u.y) / d] : [Math.cos(u.facing), Math.sin(u.facing)];
        if (e.alive && !e.has(ST.magicImmune)) push(e, dx, dy, Math.max(0, r - d), val(a, 'knockback_duration'), u, a, 'repulsion_push');
      }
    },
  }),
});

defineAbility({
  key: 'disruptor_static_storm', target: 'point', ult: true, ai: { role: 'aoe' },
  aoe: (a) => val(a, 'radius'),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const r = val(a, 'radius');
    const pulses = val(a, 'pulses');
    const d = dur(a, 'duration');
    const every = val(a, 'duration') / pulses;
    const mute = hasScepter(u);
    let k = 0;
    u.w.emit({ n: 'static_storm', x: t.x, y: t.y, r, d, t: u.team });
    u.w.addZone({
      fx: 'static_storm', x: t.x, y: t.y, r, team: u.team, interval: every, duration: d,
      onInterval() {
        k = Math.min(pulses, k + 1);
        const dps = dmg(a, 'damage_max') * k / pulses;
        for (const e of u.w.enemiesIn(u.team, t.x, t.y, r)) {
          debuff(u, e, a, { name: 'static_storm', duration: every + 0.1, fx: 'silence',
            states: ST.silenced | (mute ? ST.muted : 0) });
          damage(u, e, dps * every, 'magical', a, { noProc: true });
        }
      },
    });
  },
});

defineHero('disruptor', ['disruptor_thunder_strike', 'disruptor_glimpse', 'disruptor_kinetic_field', 'disruptor_kinetic_fence', 'disruptor_electromagnetic_repulsion', 'disruptor_static_storm'], {
  build: ['null_talisman', 'arcane_boots', 'glimmer_cape', 'force_staff', 'aether_lens', 'ultimate_scepter', 'black_king_bar', 'refresher'],
  upgrades: [
    { slot: 0, key: 'strike_damage', amount: 20, max: 5, label: 'Thunder Strike: +20 daño por golpe' },
    { slot: 1, key: 'max_damage', amount: 50, max: 5, label: 'Glimpse: +50 daño máximo' },
    { slot: 2, key: 'duration', amount: 0.4, max: 4, label: 'Kinetic Field: +0,4 s' },
    { slot: 5, key: 'damage_max', amount: 50, max: 5, label: 'Static Storm: +50 daño por segundo máximo' },
    { slot: 5, key: 'radius', amount: 40, max: 4, label: 'Static Storm: +40 radio' },
  ],
});
