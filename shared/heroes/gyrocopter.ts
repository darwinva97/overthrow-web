import { defineAbility, defineHero, dmg, dur, hasScepter, val } from '../sim/abilities';
import { damage, landAttack, makeAttack } from '../sim/combat';
import type { AbilityInst, AttackEvent } from '../sim/types';
import { ST } from '../sim/types';
import type { Unit } from '../sim/unit';
import { slow, stun } from './util';

const barrageOf = (u: Unit) => u.abilities.find((x) => x.key === 'gyrocopter_rocket_barrage');

/** Un cohete de Rocket Barrage alrededor de (x,y); `prefer` recibe el cohete si está en el radio. */
function rocket(u: Unit, a: AbilityInst, x: number, y: number, r: number, prefer?: Unit | null) {
  const w = u.w;
  let t: Unit | undefined;
  if (prefer && prefer.alive && w.targetable(prefer) && Math.hypot(prefer.x - x, prefer.y - y) <= r + prefer.radius) t = prefer;
  else {
    const list = w.enemiesIn(u.team, x, y, r).filter((e) => e.kind !== 'ward' && !e.has(ST.magicImmune));
    if (!list.length) return;
    t = list[Math.floor(w.rng() * list.length)];
  }
  if (t.has(ST.magicImmune)) return;
  w.emit({ n: 'rocket', x, y, x2: t.x, y2: t.y, u: t.id });
  damage(u, t, dmg(a, 'rocket_damage'), 'magical', a);
}

/** Proyectil de ataque que impacta con un evento ya preparado. */
function shoot(u: Unit, ev: AttackEvent, speed: number) {
  u.w.addProjectile({
    kind: 'track', fx: 'attack:gyrocopter', source: u, target: ev.target as Unit, x: u.x, y: u.y,
    speed, dodgeable: true,
    onHit: () => { landAttack(ev); return true; },
  });
}

defineAbility({
  key: 'gyrocopter_rocket_barrage', target: 'none', ai: { role: 'aoe', selfRadius: 380 },
  aoe: (a) => val(a, 'radius'),
  onSpellStart(a) {
    const u = a.owner as Unit;
    const iv = val(a, 'rocket_interval');
    u.addMod({
      name: 'rocket_barrage', duration: val(a, 'barrage_duration'), fx: 'rocket_barrage', interval: iv,
      onInterval() { if (u.alive) rocket(u, a, u.x, u.y, val(a, 'radius')); },
    }, u, a);
  },
});

defineAbility({
  key: 'gyrocopter_homing_missile', target: 'unit', reflectable: true, ai: { role: 'disable' },
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const e = t.unit as Unit;
    if (!e?.alive) return;
    const w = u.w;
    const pre = val(a, 'pre_flight_time');
    const ms = w.spawnSummon(u, 'gyrocopter_homing_missile', u.x + Math.cos(u.facing) * 100, u.y + Math.sin(u.facing) * 100,
      pre + 12, { abilities: [] });
    const start = w.time;
    const shardDelay = val(a, 'shard_delay');
    const shardR = val(a, 'shard_radius');
    ms.addMod({
      name: 'homing_missile', persistent: true, fx: 'homing_missile', states: ST.busy | ST.noCollision | ST.flying | ST.disarmed,
      data: { speed: val(a, 'speed'), rk: 0, done: false },
      // Solo cae a golpes: los de héroe valen por más.
      onIncomingDamage(_m, ev) {
        if (!ev.isAttack) { ev.amount = 0; return; }
        ev.amount = (ev.source as Unit)?.isHeroLike ? val(a, 'hero_damage') : 1;
      },
      onTick(m, dt) {
        if (m.data.done) return;
        const el = w.time - start;
        // Shard: dispara Rocket Barrage continuamente, priorizando al objetivo.
        const rb = barrageOf(u);
        if (shardR > 0 && el >= shardDelay && rb && rb.level > 0) {
          m.data.rk += dt;
          const iv = val(rb, 'rocket_interval');
          while (m.data.rk >= iv) { m.data.rk -= iv; rocket(u, rb, ms.x, ms.y, shardR, e); }
        }
        if (!e.alive || !w.targetable(e)) { m.data.done = true; ms.expireAt = w.time; return; }
        if (el < pre) { ms.facing = Math.atan2(e.y - ms.y, e.x - ms.x); return; }
        m.data.speed += val(a, 'acceleration') * dt * 30;
        const d = Math.hypot(e.x - ms.x, e.y - ms.y);
        const step = m.data.speed * dt;
        if (d <= step + e.radius) {
          m.data.done = true;
          w.emit({ n: 'homing_missile_hit', x: e.x, y: e.y, u: e.id });
          if (!e.has(ST.magicImmune) || a.def.bkbPierce) {
            damage(u, e, dmg(a, 'hit_damage'), 'magical', a);
            stun(u, e, val(a, 'stun_duration'), a);
          }
          ms.expireAt = w.time;
          return;
        }
        ms.facing = Math.atan2(e.y - ms.y, e.x - ms.x);
        ms.x += (e.x - ms.x) / d * step; ms.y += (e.y - ms.y) / d * step;
      },
    }, u, a);
    w.addVision(e.team, ms.x, ms.y, 300, val(a, 'enemy_vision_time'));
  },
});

defineAbility({
  key: 'gyrocopter_flak_cannon', target: 'none', ai: { role: 'buff', selfRadius: 600 },
  aoe: (a) => val(a, 'radius'),
  onSpellStart(a) {
    const u = a.owner as Unit;
    u.addMod({
      name: 'flak_cannon', duration: dur(a, 'abilityduration'), fx: 'flak_cannon', stacks: val(a, 'max_attacks'),
      props: { damage: val(a, 'bonus_damage') },
      onAttackLanded(m, ev) {
        if (ev.fake) return;
        const t = ev.target as Unit;
        // Los demás enemigos del radio reciben un ataque sin críticos ni modificadores.
        for (const e of u.w.enemiesIn(u.team, u.x, u.y, val(a, 'radius'))) {
          if (e === t || e.kind === 'ward' || !u.w.canSee(u.team, e)) continue;
          const ev2: AttackEvent = {
            attacker: u, target: e, critMult: 1, trueStrike: false, missed: false, fake: true,
            damage: u.s.dmgMin + u.w.rng() * (u.s.dmgMax - u.s.dmgMin) + u.s.dmgBonus,
            distance: Math.hypot(e.x - u.x, e.y - u.y),
          };
          shoot(u, ev2, val(a, 'projectile_speed'));
        }
        m.stacks--;
        if (m.stacks <= 0) m.remaining = 0.001;
      },
    }, u, a);
  },
});

// Afterburner: cada golpe a un enemigo da velocidad durante un rato (acumulable).
defineAbility({
  key: 'gyrocopter_afterburner', target: 'passive', innate: true,
  passive: (a) => ({
    name: 'afterburner', data: { list: [] as [number, number][] },
    props: (m) => ({ msPct: (m.data.list as [number, number][]).reduce((s, x) => s + x[1], 0) / 100 }),
    onDealDamage(m, ev) {
      const u = m.owner as Unit;
      const t = ev.target as Unit;
      if (t.team === u.team || ev.amount <= 0 || !(t.isHeroLike || t.kind === 'creep' || t.kind === 'summon')) return;
      const amt = t.isHeroLike ? val(a, 'bonus_movement_speed_per_hit') : val(a, 'bonus_movement_speed_per_hit_creep');
      m.data.list.push([u.w.time + val(a, 'bonus_movespeed_duration'), amt]);
      u.refreshStats();
    },
    onTick(m) {
      const u = m.owner as Unit;
      const l = m.data.list as [number, number][];
      if (l.length && l[0][0] <= u.w.time) {
        m.data.list = l.filter((x) => x[0] > u.w.time);
        u.refreshStats();
      }
      m.stacks = m.data.list.length;
    },
  }),
});

// Side Gunner (Scepter): ataca al enemigo más lejano del radio cada cierto tiempo.
defineAbility({
  key: 'gyrocopter_side_gunner_spawn_ability', target: 'passive', noIllusion: true,
  passive: (a) => ({
    name: 'side_gunner', interval: val(a, 'sidegunner_fire_rate'),
    onInterval(m) {
      const u = m.owner as Unit;
      if (!u.alive || !hasScepter(u) || u.has(ST.hidden)) return;
      const list = u.w.enemiesIn(u.team, u.x, u.y, val(a, 'abilitycastrange'))
        .filter((e) => e.kind !== 'ward' && u.w.canSee(u.team, e))
        .sort((p, q) => Math.hypot(q.x - u.x, q.y - u.y) - Math.hypot(p.x - u.x, p.y - u.y));
      const n = u.findMod('flak_cannon', u) ? 1 + val(a, 'double_target') : 1;
      for (const e of list.slice(0, n)) shoot(u, makeAttack(u, e, true), u.base.projSpeed);
    },
  }),
});

defineAbility({
  key: 'gyrocopter_call_down', target: 'point', ult: true, ai: { role: 'aoe' },
  aoe: (a) => val(a, 'radius'),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const w = u.w;
    let dx = t.x - u.x, dy = t.y - u.y;
    const len = Math.hypot(dx, dy);
    if (len < 1) { dx = Math.cos(u.facing); dy = Math.sin(u.facing); } else { dx /= len; dy /= len; }
    const r = val(a, 'radius');
    const n = val(a, 'total_strikes');
    for (let i = 0; i < n; i++) {
      const x = t.x + dx * val(a, 'strike_separation') * i, y = t.y + dy * val(a, 'strike_separation') * i;
      const at = val(a, 'strike_delay') * (i + 1);
      w.emit({ n: 'call_down_warn', x, y, r, d: at, t: u.team });
      w.after(at, () => {
        w.emit({ n: 'call_down', x, y, r, t: u.team });
        for (const e of w.enemiesIn(u.team, x, y, r)) {
          if (e.has(ST.magicImmune)) continue;
          damage(u, e, dmg(a, 'damage'), 'magical', a);
          slow(u, e, a, 'call_down_slow', dur(a, 'slow_duration'), val(a, 'slow') / 100);
        }
      });
    }
  },
});

defineHero('gyrocopter', [
  'gyrocopter_rocket_barrage', 'gyrocopter_homing_missile', 'gyrocopter_flak_cannon', 'gyrocopter_afterburner',
  'gyrocopter_side_gunner_spawn_ability', 'gyrocopter_call_down',
], {
  build: ['wraith_band', 'power_treads', 'falcon_blade', 'maelstrom', 'black_king_bar', 'satanic', 'skadi', 'butterfly'],
});
