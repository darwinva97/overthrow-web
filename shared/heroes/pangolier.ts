import { defineAbility, defineHero, dmg, dur, hasScepter, val } from '../sim/abilities';
import { damage } from '../sim/combat';
import { TREE } from '../sim/nav';
import type { AbilityInst, Order } from '../sim/types';
import { ST } from '../sim/types';
import type { Unit } from '../sim/unit';
import { castDir, dash, push, slow, stun } from './util';
import { abil, barrierSpec, enemiesInLine, gate } from './lib/a6';

const DEG = Math.PI / 180;
const attackDmg = (u: Unit) => (u.s.dmgMin + u.s.dmgMax) / 2 + u.s.dmgBonus;

/** Tajos de Swashbuckle en línea desde (x,y) hacia (dx,dy). `mult` = eficacia (Scepter 75%). */
function slashes(a: AbilityInst, x: number, y: number, dx: number, dy: number, strikes: number, mult: number) {
  const u = a.owner as Unit;
  const every = val(a, 'attack_interval');
  const len = val(a, 'range');
  const width = val(a, 'start_radius');
  for (let i = 0; i < strikes; i++) {
    u.w.after(every * i, () => {
      if (!u.alive) return;
      u.w.emit({ n: 'swashbuckle', x, y, x2: x + dx * len, y2: y + dy * len, u: u.id, t: u.team });
      const per = (dmg(a, 'damage') + attackDmg(u) * val(a, 'attack_damage') / 100) * mult;
      for (const e of enemiesInLine(u, x, y, dx, dy, len, width)) {
        damage(u, e, per, 'physical', a);
        slow(u, e, a, 'swashbuckle_slow', val(a, 'slow_duration'), val(a, 'slow_percent') / 100);
      }
    });
  }
}

defineAbility({
  key: 'pangolier_swashbuckle', target: 'point', castBeyond: true, ai: { role: 'nuke' },
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const [dx, dy] = castDir(u, t.x, t.y);
    const d = Math.min(val(a, 'dash_range') * a.upg.range, Math.hypot(t.x - u.x, t.y - u.y));
    dash(u, u.x + dx * d, u.y + dy * d, val(a, 'dash_speed'), a, {
      name: 'swashbuckle_dash',
      onArrive: (v) => { if (v.alive) slashes(a, v.x, v.y, dx, dy, val(a, 'strikes'), 1); },
    });
  },
});

/** Golpe de Shield Crash al aterrizar. */
function crashLand(a: AbilityInst) {
  const u = a.owner as Unit;
  if (!u.alive) return;
  const r = val(a, 'radius');
  u.w.emit({ n: 'shield_crash', x: u.x, y: u.y, r, t: u.team });
  let heroes = 0;
  for (const e of u.w.enemiesIn(u.team, u.x, u.y, r)) {
    damage(u, e, dmg(a, 'damage'), 'physical', a);
    if (e.kind === 'hero') heroes++;
  }
  if (heroes > 0) u.addMod(barrierSpec('shield_crash_barrier', dur(a, 'duration'), val(a, 'hero_shield')), u, a);
  // Scepter: un Swashbuckle de 2 tajos cada 90 grados.
  const sw = abil(u, 'pangolier_swashbuckle');
  if (hasScepter(u) && sw && sw.level > 0) {
    for (let k = 0; k < 4; k++) {
      const ang = u.facing + k * Math.PI / 2;
      slashes(sw, u.x, u.y, Math.cos(ang), Math.sin(ang), 2, val(a, 'scepter_damage_outgoing_tooltip') / 100);
    }
  }
}

defineAbility({
  key: 'pangolier_shield_crash', target: 'none', ai: { role: 'aoe', selfRadius: 400 },
  aoe: (a) => val(a, 'radius'),
  onSpellStart(a) {
    const u = a.owner as Unit;
    if (u.findMod('gyroshell')) { u.w.after(val(a, 'jump_duration_gyroshell'), () => crashLand(a)); return; }
    const dist = val(a, 'jump_horizontal_distance');
    const time = val(a, 'jump_duration');
    const x = u.x + Math.cos(u.facing) * dist, y = u.y + Math.sin(u.facing) * dist;
    dash(u, x, y, dist / time, a, { name: 'shield_crash_jump', states: ST.flying, onArrive: () => crashLand(a) });
  },
});

defineAbility({
  key: 'pangolier_lucky_shot', target: 'passive',
  passive: (a) => ({
    name: 'lucky_shot',
    onDealDamage(_m, ev) {
      const u = a.owner as Unit;
      const t = ev.target as Unit;
      if (t.team === u.team || !t.alive || ev.amount <= 0) return;
      const mine = ev.isAttack || (!!ev.ability && (ev.ability as AbilityInst).owner === u && !(ev.ability as any).isItem);
      if (!mine || u.w.rng() >= val(a, 'chance_pct') / 100) return;
      if (t.has(ST.magicImmune)) return;
      t.addMod({
        name: 'lucky_shot', duration: dur(a, 'duration'), debuff: true, fx: 'lucky_shot',
        props: { attackSlow: val(a, 'attack_slow'), armor: -val(a, 'armor') },
      }, u, a);
    },
  }),
});

/** Golpe de bola (Rolling Thunder y rebote de Roll Up): daño, empuje y aturdimiento. */
function ballHit(u: Unit, a: AbilityInst, e: Unit, stunDur: number) {
  const g = abil(u, 'pangolier_gyroshell');
  const src = g && g.level > 0 ? g : a;
  const base = src === g ? dmg(g, 'abilitydamage') + attackDmg(u) * val(g, 'damage_pct') / 100 : attackDmg(u);
  damage(u, e, base, 'physical', src);
  if (!e.alive || e.has(ST.magicImmune)) return;
  const bounce = val(src, 'bounce_duration');
  push(e, e.x - u.x, e.y - u.y, val(src, 'knockback_radius'), bounce, u, src, 'rolling_thunder_knock');
  u.w.after(bounce, () => { if (e.alive) stun(u, e, stunDur, src); });
}

/** Punto al que quiere ir el jugador según su orden actual. */
function steerPoint(u: Unit): { x: number; y: number } | null {
  const o = u.order as Order | null;
  if (!o) return null;
  if (o.type === 'move' || o.type === 'attackMove') return { x: o.x, y: o.y };
  if (o.type === 'attack' || o.type === 'follow') { const t = u.w.units.get(o.target); return t && t.alive ? t : null; }
  if ((o.type === 'cast' || o.type === 'item') && o.x !== undefined && o.y !== undefined) return { x: o.x, y: o.y };
  return null;
}

defineAbility({
  key: 'pangolier_gyroshell', target: 'none', ult: true, ai: { role: 'disable', selfRadius: 900 },
  onSpellStart(a) {
    const u = a.owner as Unit;
    u.purge(true, false);
    u.removeModsByName('rollup');
    u.order = null; u.path = [];
    const hitCd = new Map<number, number>();
    const tick = val(a, 'tick_interval');
    u.addMod({
      name: 'gyroshell', duration: dur(a, 'duration'), fx: 'gyroshell', purgable: false,
      states: ST.magicImmune | ST.busy | ST.noCollision | ST.disarmed,
      props: { magicResist: val(a, 'magic_resistance') / 100 },
      data: { t: 0, pauseUntil: 0, acc: 0 },
      onTick(m, dt) {
        const w = u.w;
        m.data.t += dt;
        if (u.has(ST.stunned) || u.findMod('rollup')) return;
        if (w.time < m.data.pauseUntil) return;
        // Gira poco a poco hacia donde ordena el jugador (más rápido el primer segundo).
        const p = steerPoint(u) ?? (u.isBot ? w.units.get(u.ai?.target ?? 0) ?? null : null);
        if (p) {
          const want = Math.atan2(p.y - u.y, p.x - u.x);
          let diff = want - u.facing;
          while (diff > Math.PI) diff -= 2 * Math.PI;
          while (diff < -Math.PI) diff += 2 * Math.PI;
          const rate = (m.data.t < val(a, 'move_speed_ramp_up_time') ? val(a, 'turn_rate_boosted') : val(a, 'turn_rate')) * DEG * dt;
          u.facing += Math.max(-rate, Math.min(rate, diff));
        }
        const ramp = Math.min(1, m.data.t / Math.max(0.01, val(a, 'move_speed_ramp_up_time')));
        const step = val(a, 'forward_move_speed') * (0.3 + 0.7 * ramp) * dt;
        const nx = u.x + Math.cos(u.facing) * step, ny = u.y + Math.sin(u.facing) * step;
        const g = w.grid;
        if (g.walkable(nx, ny) || g.cellAt(g.cx(nx), g.cy(ny)) === TREE) { u.x = nx; u.y = ny; }
        else {
          // Choca con un muro: pausa y media vuelta.
          u.facing += Math.PI;
          m.data.pauseUntil = w.time + val(a, 'jump_recover_time') + val(a, 'bounce_duration');
          w.emit({ n: 'gyro_bounce', x: u.x, y: u.y, u: u.id });
        }
        m.data.acc += dt;
        if (m.data.acc < tick) return;
        m.data.acc = 0;
        const recover = val(a, 'stun_duration') + val(a, 'bounce_duration');
        for (const e of w.enemiesIn(u.team, u.x, u.y, val(a, 'hit_radius'), { immune: false })) {
          if ((hitCd.get(e.id) ?? -99) > w.time) continue;
          hitCd.set(e.id, w.time + recover);
          ballHit(u, a, e, val(a, 'stun_duration'));
        }
      },
      onDestroy() {
        // Puede acabar dentro de un árbol: sale al suelo libre más cercano.
        if (!u.w.grid.walkable(u.x, u.y)) u.w.teleport(u, u.x, u.y);
        gate(abil(u, 'pangolier_gyroshell_stop'), false);
      },
    }, u, a);
    gate(abil(u, 'pangolier_gyroshell_stop'), true);
  },
});

defineAbility({
  key: 'pangolier_gyroshell_stop', target: 'none', levelWith: 4,
  hidden: (a) => !(a.owner as Unit).findMod('gyroshell'),
  onSpellStart(a) { (a.owner as Unit).removeModsByName('gyroshell'); gate(a, false); },
});

defineAbility({
  key: 'pangolier_rollup', target: 'none', ai: { role: 'buff', selfRadius: 350 },
  castPoint: (a) => ((a.owner as Unit).findMod('gyroshell') ? 0 : val(a, 'abilitycastpoint')),
  onSpellStart(a) {
    const u = a.owner as Unit;
    u.purge(true, false);
    u.order = null; u.path = [];
    u.addMod({
      name: 'rollup', duration: val(a, 'duration'), fx: 'rollup', purgable: false,
      states: ST.magicImmune | ST.rooted | ST.disarmed,
      props: { magicResist: val(a, 'magic_resistance') / 100 },
      data: { next: 0 },
      onAttacked(m, ev) {
        // Si le pegan, rueda lejos del atacante golpeando lo que encuentre.
        const att = ev.attacker as Unit;
        if (att.team === u.team || u.w.time < m.data.next || u.findMod('gyroshell')) return;
        const bounce = val(a, 'rollup_bounce_duration');
        m.data.next = u.w.time + bounce;
        const dx = u.x - att.x, dy = u.y - att.y, d = Math.hypot(dx, dy) || 1;
        const dist = val(a, 'forward_move_speed') * bounce;
        const hit = new Set<number>();
        dash(u, u.x + dx / d * dist, u.y + dy / d * dist, val(a, 'forward_move_speed'), a, {
          name: 'rollup_roll', states: ST.magicImmune,
          onStep: (v) => {
            for (const e of v.w.enemiesIn(v.team, v.x, v.y, val(a, 'hit_radius'), { immune: false })) {
              if (hit.has(e.id)) continue;
              hit.add(e.id);
              ballHit(v, a, e, val(a, 'stun_duration'));
            }
          },
        });
      },
      onDestroy() { gate(abil(u, 'pangolier_rollup_stop'), false); },
    }, u, a);
    gate(abil(u, 'pangolier_rollup_stop'), true);
  },
});

defineAbility({
  key: 'pangolier_rollup_stop', target: 'none', levelWith: 3,
  hidden: (a) => !(a.owner as Unit).findMod('rollup'),
  onSpellStart(a) { (a.owner as Unit).removeModsByName('rollup'); gate(a, false); },
});

// Fortune Favors the Bold: los críticos enemigos tienen la mitad de probabilidad contra él.
defineAbility({
  key: 'pangolier_fortune_favors_the_bold', target: 'passive', innate: true,
  passive: (a) => ({
    name: 'fortune_favors_the_bold',
    onAttacked(_m, ev) {
      const u = a.owner as Unit;
      if (ev.critMult > 1 && u.w.rng() < -val(a, 'chance_reduce') / 100) { ev.critMult = 1; }
    },
  }),
});

defineHero('pangolier', ['pangolier_swashbuckle', 'pangolier_shield_crash', 'pangolier_lucky_shot', 'pangolier_rollup', 'pangolier_gyroshell', 'pangolier_gyroshell_stop', 'pangolier_rollup_stop', 'pangolier_fortune_favors_the_bold'], {
  build: ['wraith_band', 'phase_boots', 'diffusal_blade', 'blink', 'black_king_bar', 'basher', 'ultimate_scepter', 'abyssal_blade'],
});
