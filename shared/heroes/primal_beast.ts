import { castRangeOf, defineAbility, defineHero, dmg, dur, hasScepter, val } from '../sim/abilities';
import { damage } from '../sim/combat';
import type { AbilityInst, Modifier, Order } from '../sim/types';
import { ST } from '../sim/types';
import { ATTR, type Unit } from '../sim/unit';
import { castDir, debuff, push, stun } from './util';
import { abil, gate } from './lib/a6';

const DEG = Math.PI / 180;
const attackDmg = (u: Unit) => (u.s.dmgMin + u.s.dmgMax) / 2 + u.s.dmgBonus;

/** Colossal: multiplicador de áreas según la vida extra. */
function colossalAoe(u: Unit) {
  const c = abil(u, 'primal_beast_colossal');
  if (!c?.passiveMod) return 1;
  return 1 + (c.passiveMod.data.thresholds ?? 0) * val(c, 'aoe_per_threshold') / 100;
}

function turnToward(u: Unit, x: number, y: number, degPerSec: number, dt: number) {
  let d = Math.atan2(y - u.y, x - u.x) - u.facing;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  const r = degPerSec * DEG * dt;
  u.facing += Math.max(-r, Math.min(r, d));
}

function orderPoint(u: Unit): { x: number; y: number } | null {
  const o = u.order as Order | null;
  if (!o) return null;
  if (o.type === 'move' || o.type === 'attackMove') return { x: o.x, y: o.y };
  if (o.type === 'attack' || o.type === 'follow') return u.w.units.get(o.target) ?? null;
  return null;
}

/** Añade pilas de Uproar (Rock Throw, daño recibido). */
function addUproar(u: Unit, n: number) {
  const up = abil(u, 'primal_beast_uproar');
  const m = up?.passiveMod;
  if (!up || !m) return;
  m.stacks = up.data.stacks = Math.min(val(up, 'stack_limit'), m.stacks + n);
  m.data.expire = up.data.expire = u.w.time + val(up, 'stack_duration');
  gate(up, m.stacks > 0);
}

// ---------------- Onslaught ----------------

function startRun(a: AbilityInst, chargeT: number) {
  const u = a.owner as Unit;
  if (!u.alive || u.has(ST.stunned)) return;
  const frac = Math.max(val(a, 'base_power'), Math.min(1, chargeT / val(a, 'max_charge_time')));
  const dist = val(a, 'max_distance') * frac;
  const speed = val(a, 'charge_speed');
  const hit = new Set<number>();
  u.order = null; u.path = [];
  u.addMod({
    name: 'onslaught_run', duration: dist / speed, fx: 'onslaught', states: ST.busy | ST.noCollision | ST.disarmed,
    onOrder(m, o) { if (o.type === 'stop') m.remaining = 0.001; },
    onTick(m, dt) {
      if (u.has(ST.stunned) || u.has(ST.rooted)) { m.remaining = 0.001; return; }
      const p = orderPoint(u);
      if (p) turnToward(u, p.x, p.y, val(a, 'movement_turn_rate'), dt);
      const step = speed * dt;
      const nx = u.x + Math.cos(u.facing) * step, ny = u.y + Math.sin(u.facing) * step;
      if (!u.w.grid.walkable(nx, ny)) { m.remaining = 0.001; return; }
      u.x = nx; u.y = ny;
      const r = val(a, 'knockback_radius') * colossalAoe(u);
      for (const v of u.w.unitsIn(u.x, u.y, r, (x) => x !== u && u.w.targetable(x) && (x.isHeroLike || x.kind === 'creep'))) {
        if (hit.has(v.id)) continue;
        hit.add(v.id);
        const enemy = v.team !== u.team;
        if (enemy && v.has(ST.magicImmune)) continue;
        // Empuja hacia el lado del que esté respecto a la carga.
        const side = Math.sign((v.x - u.x) * -Math.sin(u.facing) + (v.y - u.y) * Math.cos(u.facing)) || 1;
        const kdx = Math.cos(u.facing) - Math.sin(u.facing) * side, kdy = Math.sin(u.facing) + Math.cos(u.facing) * side;
        push(v, kdx, kdy, val(a, 'knockback_distance'), val(a, 'knockback_duration'), u, a, 'onslaught_knock');
        if (!enemy) continue;
        damage(u, v, dmg(a, 'knockback_damage'), 'physical', a);
        const kd = val(a, 'knockback_duration');
        u.w.after(kd, () => { if (v.alive) stun(u, v, dur(a, 'stun_duration'), a); });
      }
    },
  }, u, a);
}

defineAbility({
  key: 'primal_beast_onslaught', target: 'point', castBeyond: true, ai: { role: 'disable' },
  castRange: (a) => val(a, 'max_distance'),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const [dx, dy] = castDir(u, t.x, t.y);
    u.facing = Math.atan2(dy, dx);
    u.order = null; u.path = [];
    // Los bots sueltan la carga cuando ya alcanza el punto marcado.
    const need = Math.min(1, (Math.hypot(t.x - u.x, t.y - u.y) + 150) / val(a, 'max_distance')) * val(a, 'max_charge_time');
    u.addMod({
      name: 'onslaught_charge', duration: val(a, 'max_charge_time'), fx: 'onslaught_charge',
      states: ST.busy | ST.rooted | ST.disarmed,
      data: { t: 0, tx: t.x, ty: t.y, cancel: false },
      onOrder(m, o) { if (o.type === 'stop') { m.data.cancel = true; m.remaining = 0.001; } },
      onTick(m, dt) {
        m.data.t += dt;
        if (u.has(ST.stunned) || u.has(ST.silenced) || u.has(ST.hexed)) { m.data.cancel = true; m.remaining = 0.001; return; }
        const p = orderPoint(u) ?? { x: m.data.tx, y: m.data.ty };
        turnToward(u, p.x, p.y, val(a, 'turn_rate'), dt);
        if (u.isBot && m.data.t >= need) m.remaining = 0.001;
      },
      onDestroy(m) {
        gate(abil(u, 'primal_beast_onslaught_release'), false);
        if (!m.data.cancel) startRun(a, m.data.t);
      },
    }, u, a);
    gate(abil(u, 'primal_beast_onslaught_release'), true);
  },
});

defineAbility({
  key: 'primal_beast_onslaught_release', target: 'none', levelWith: 0,
  hidden: (a) => !(a.owner as Unit).findMod('onslaught_charge'),
  onSpellStart(a) {
    const m = (a.owner as Unit).findMod('onslaught_charge');
    if (m) m.remaining = 0.001;
    gate(a, false);
  },
});

// ---------------- Trample ----------------

defineAbility({
  key: 'primal_beast_trample', target: 'none', ai: { role: 'aoe', selfRadius: 300 },
  aoe: (a) => val(a, 'effect_radius'),
  onSpellStart(a) {
    const u = a.owner as Unit;
    const step = val(a, 'step_distance');
    const stomp = () => {
      const r = val(a, 'effect_radius') * colossalAoe(u);
      u.w.emit({ n: 'trample', x: u.x, y: u.y, r, t: u.team });
      const d = dmg(a, 'base_damage') + attackDmg(u) * val(a, 'attack_damage') / 100;
      for (const e of u.w.enemiesIn(u.team, u.x, u.y, r)) damage(u, e, d, 'magical', a);
    };
    u.addMod({
      name: 'trample', duration: dur(a, 'duration'), fx: 'trample', states: ST.disarmed,
      props: { magicResist: val(a, 'bonus_magic_resistance') / 100, slowResist: val(a, 'unslowable') > 0 ? 1 : 0 },
      data: { x: u.x, y: u.y, acc: 0 },
      onTick(m) {
        m.data.acc += Math.hypot(u.x - m.data.x, u.y - m.data.y);
        m.data.x = u.x; m.data.y = u.y;
        while (m.data.acc >= step) { m.data.acc -= step; stomp(); }
      },
    }, u, a);
    stomp();
  },
});

// ---------------- Uproar ----------------

/** Proyectil de Uproar con Scepter; se parte en dos tras `split_delay`. */
function uproarProjectile(a: AbilityInst, x: number, y: number, ang: number, dist: number, splits: number) {
  const u = a.owner as Unit;
  const p = u.w.addProjectile({
    kind: 'linear', fx: 'uproar_projectile', source: u, x, y, dx: Math.cos(ang), dy: Math.sin(ang),
    speed: val(a, 'projectile_speed'), left: dist, width: val(a, 'projectile_width'),
    onHit(_p, e) {
      const v = e as Unit;
      if (v.team === u.team || (v.has(ST.magicImmune))) return false;
      damage(u, v, dmg(a, 'projectile_damage'), 'magical', a);
      debuff(u, v, a, { name: 'uproar_break', duration: val(a, 'projectile_break_duration'), states: ST.broken, fx: 'break' });
      return false;
    },
  });
  if (splits <= 0) return;
  const delay = val(a, 'split_delay');
  u.w.after(delay, () => {
    if (p.dead || p.left <= 0) return;
    p.dead = true;
    const sa = val(a, 'splinter_angle') * DEG;
    uproarProjectile(a, p.x, p.y, ang - sa, p.left, splits - 1);
    uproarProjectile(a, p.x, p.y, ang + sa, p.left, splits - 1);
  });
}

defineAbility({
  key: 'primal_beast_uproar', target: 'none', ai: { role: 'buff', selfRadius: 400 },
  passive: (a) => ({
    name: 'uproar', stacks: 0, data: { expire: 0 },
    onCreated(m) { m.stacks = a.data.stacks ?? 0; m.data.expire = a.data.expire ?? 0; gate(a, m.stacks > 0); },
    onTakeDamage(_m, ev) {
      const s = ev.source as Unit | null;
      if (!s || s.team === (a.owner as Unit).team || !s.isHeroLike) return;
      if (ev.amount < val(a, 'damage_limit')) return;
      addUproar(a.owner as Unit, 1);
    },
    onTick(m) {
      if (m.stacks > 0 && (a.owner as Unit).w.time >= m.data.expire) { m.stacks = a.data.stacks = 0; gate(a, false); }
    },
  }),
  onSpellStart(a) {
    const u = a.owner as Unit;
    const m = a.passiveMod;
    const n = m?.stacks ?? 0;
    if (!m || n <= 0) { gate(a, false); return; }
    m.stacks = a.data.stacks = 0;
    gate(a, false);
    if (val(a, 'should_dispell') > 0) u.purge(true, false);
    const r = val(a, 'radius') * colossalAoe(u);
    u.w.emit({ n: 'uproar', x: u.x, y: u.y, r, t: u.team });
    for (const e of u.w.enemiesIn(u.team, u.x, u.y, r)) {
      debuff(u, e, a, { name: 'uproar_slow', duration: val(a, 'slow_duration'), fx: 'slow', props: { msSlow: n * val(a, 'move_slow_per_stack') / 100 } });
    }
    u.addMod({
      name: 'roared', duration: val(a, 'roar_duration'), fx: 'roared', stacks: n,
      props: { damage: n * dmg(a, 'bonus_damage_per_stack'), armor: n * val(a, 'roared_bonus_armor'), attackSpeed: n * val(a, 'roared_bonus_attack_speed') },
    }, u, a);
    if (hasScepter(u) && val(a, 'projectiles_per_stack') > 0) {
      const count = n * val(a, 'projectiles_per_stack');
      for (let w = 0; w < val(a, 'projectile_waves'); w++) {
        u.w.after(w * 0.3, () => {
          if (!u.alive) return;
          const off = w * Math.PI / count;
          for (let i = 0; i < count; i++) {
            uproarProjectile(a, u.x, u.y, off + i * 2 * Math.PI / count, val(a, 'projectile_distance'), val(a, 'max_split_amount') > 0 ? 1 : 0);
          }
        });
      }
    }
  },
});

// ---------------- Rock Throw (Shard) ----------------

defineAbility({
  key: 'primal_beast_rock_throw', target: 'point', ai: { role: 'disable' },
  aoe: (a) => val(a, 'impact_radius'),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const [dx, dy] = castDir(u, t.x, t.y);
    const minR = val(a, 'min_range'), maxR = castRangeOf(a);
    const d = Math.max(minR, Math.min(maxR, Math.hypot(t.x - u.x, t.y - u.y)));
    const x = u.x + dx * d, y = u.y + dy * d;
    const k = Math.max(0, Math.min(1, (d - minR) / Math.max(1, maxR - minR)));
    const travel = val(a, 'min_travel_time') + (val(a, 'max_travel_time') - val(a, 'min_travel_time')) * k;
    const land = (px: number, py: number, r: number) => {
      u.w.emit({ n: 'rock_throw', x: px, y: py, r, t: u.team });
      let heroes = 0;
      for (const e of u.w.enemiesIn(u.team, px, py, r)) {
        damage(u, e, dmg(a, 'base_damage'), 'physical', a);
        stun(u, e, dur(a, 'stun_duration'), a);
        if (e.kind === 'hero') heroes++;
      }
      if (heroes) addUproar(u, heroes);
    };
    u.w.emit({ n: 'rock_throw_warn', x, y, r: val(a, 'impact_radius'), d: travel, t: u.team });
    u.w.after(travel, () => {
      land(x, y, val(a, 'impact_radius'));
      const fd = val(a, 'fragment_impact_distance');
      u.w.after(val(a, 'bounce_travel_time'), () => {
        for (const off of [-0.5, 0, 0.5]) {
          const ang = Math.atan2(dy, dx) + off;
          land(x + Math.cos(ang) * fd, y + Math.sin(ang) * fd, val(a, 'fragment_impact_radius'));
        }
      });
    });
  },
});

// ---------------- Pulverize ----------------

defineAbility({
  key: 'primal_beast_pulverize', target: 'unit', ult: true, reflectable: true, ai: { role: 'disable' },
  channel: (a) => val(a, 'channel_time'),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const e = t.unit as Unit;
    a.data.target = e.id; a.data.acc = 0; a.data.hits = 0;
    debuff(u, e, a, { name: 'pulverize', duration: val(a, 'channel_time'), states: ST.stunned, fx: 'pulverize' });
    if (e.cast) e.w.interruptCast(e, true);
  },
  onChannelTick(a, dt) {
    const u = a.owner as Unit;
    const e = u.w.units.get(a.data.target);
    if (!e || !e.alive || !e.findMod('pulverize')) { u.w.interruptCast(u, true); return; }
    // Lo sostiene delante.
    u.w.forceMove(e, u.x + Math.cos(u.facing) * (u.radius + e.radius), u.y + Math.sin(u.facing) * (u.radius + e.radius));
    a.data.acc += dt;
    const every = val(a, 'interval');
    if (a.data.acc < every) return;
    a.data.acc -= every;
    const r = val(a, 'splash_radius') * colossalAoe(u);
    const d = dmg(a, 'damage') + val(a, 'bonus_damage_per_hit') * a.data.hits;
    a.data.hits++;
    u.w.emit({ n: 'pulverize', x: e.x, y: e.y, r, t: u.team });
    for (const v of u.w.enemiesIn(u.team, e.x, e.y, r)) {
      damage(u, v, d, 'magical', a);
      if (v !== e) stun(u, v, val(a, 'ministun'), a);
    }
  },
  onChannelEnd(a) {
    const u = a.owner as Unit;
    u.w.units.get(a.data.target)?.removeModsByName('pulverize');
  },
});

// ---------------- Colossal (innata) ----------------

defineAbility({
  key: 'primal_beast_colossal', target: 'passive', innate: true,
  passive: (a) => ({
    name: 'colossal', interval: 0.5, data: { thresholds: 0 },
    props: (m: Modifier) => ({ slowResist: (val(a, 'base_slow_resist') + m.data.thresholds * val(a, 'slow_resistance_per_threshold')) / 100 }),
    onInterval(m) {
      const u = m.owner as Unit;
      // Vida por encima de la base de héroe a su nivel.
      const base = u.base.hp + u.baseAttr('str') * ATTR.hpPerStr;
      const th = Math.max(0, Math.floor((u.s.maxHp - base) / val(a, 'hp_per_threshold')));
      if (th !== m.data.thresholds) { m.data.thresholds = th; u.refreshStats(); }
    },
  }),
});

defineHero('primal_beast', ['primal_beast_onslaught', 'primal_beast_trample', 'primal_beast_uproar', 'primal_beast_rock_throw', 'primal_beast_onslaught_release', 'primal_beast_pulverize', 'primal_beast_colossal'], {
  build: ['bracer', 'phase_boots', 'blink', 'black_king_bar', 'heart', 'ultimate_scepter', 'assault', 'shivas_guard'],
});
