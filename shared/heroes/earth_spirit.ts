import { defineAbility, defineHero, dmg, dur, hasTalent, val } from '../sim/abilities';
import { damage } from '../sim/combat';
import type { AbilityInst } from '../sim/types';
import { ST } from '../sim/types';
import type { Unit } from '../sim/unit';
import { castDir, debuff, silence, slow, stun } from './util';
import { aiBy, botCast, segInfo } from './lib/a2';

// ---------------- Stone Remnants ----------------

/** Es una piedra (o un héroe convertido en piedra con Enchant Remnant). */
const isRemnant = (v: Unit) => v.alive && (!!v.data_remnant || !!v.findMod('enchant_remnant'));

function remnantsNear(u: Unit, x: number, y: number, r: number) {
  return u.w.list.filter((v) => isRemnant(v) && Math.hypot(v.x - x, v.y - y) <= r + v.radius)
    .sort((p, q) => Math.hypot(p.x - x, p.y - y) - Math.hypot(q.x - x, q.y - y));
}

function spawnRemnant(u: Unit, x: number, y: number, duration: number) {
  const r = u.w.spawnSummon(u, 'earth_spirit_stone', x, y, duration, { name: 'earth_spirit_stone' });
  r.data_remnant = true;
  r.radius = 40;
  r.addMod({ name: 'stone_remnant', persistent: true, states: ST.invulnerable | ST.busy | ST.rooted | ST.disarmed | ST.noCollision, fx: 'remnant' });
  u.w.emit({ n: 'remnant', x: r.x, y: r.y, u: r.id });
  return r;
}

function destroyRemnant(r: Unit) {
  if (!r.data_remnant) { r.removeModsByName('enchant_remnant'); return; }
  if (!r.alive) return;
  r.w.emit({ n: 'remnant_break', x: r.x, y: r.y, u: r.id });
  r.alive = false; r.hp = 0;
  r.w.removeLater(r, 0.1);
}

/** Usar una piedra con una habilidad da +daño temporal a Earth Spirit. */
function remnantUsed(u: Unit) {
  const sc = u.abilities.find((x) => x.key === 'earth_spirit_stone_caller');
  if (!sc) return;
  u.addMod({ name: 'stone_caller_used', duration: val(sc, 'buff_duration'), fx: 'stone_buff',
    props: { damagePct: val(sc, 'attack_damage_per_stone_used') / 100 } }, u, sc);
}

/** Magnetize: si un héroe magnetizado recibe Grip o Boulder Smash, todos lo comparten. */
function shareMagnetize(u: Unit, e: Unit, kind: 'silence' | 'slow', duration: number, a: AbilityInst) {
  if (!e.isHeroLike || !e.findMod('magnetize', u)) return;
  const mag = u.abilities.find((x) => x.key === 'earth_spirit_magnetize');
  if (!mag) return;
  for (const v of u.w.list) {
    if (v === e || !v.alive || !v.findMod('magnetize', u)) continue;
    if (kind === 'silence') silence(u, v, Math.min(duration, val(mag, 'silence_duration')), a, 'grip_silence');
    else slow(u, v, a, 'boulder_smash_slow', Math.min(duration, val(mag, 'slow_duration')), val(a, 'move_slow') / 100);
  }
}

/** Desplaza una unidad o piedra golpeando lo que encuentra. */
function slide(u: Unit, a: AbilityInst, v: Unit, dx: number, dy: number, dist: number, speed: number, onHit: (e: Unit) => void, r: number, stopAt?: Unit) {
  const hit = new Set<number>([v.id]);
  let left = dist;
  const enemy = v.team !== u.team;
  v.w.disjoint(v);
  if (v.cast?.phase === 2) v.w.interruptCast(v, true);
  v.addMod({
    name: 'es_slide', duration: dist / speed + 0.2, debuff: enemy, purgable: false,
    states: ST.rooted | ST.disarmed | ST.noCollision, fx: 'push',
    onTick(m, dt) {
      let ndx = dx, ndy = dy;
      if (stopAt) {
        const d = Math.hypot(stopAt.x - v.x, stopAt.y - v.y);
        if (d < 130 || !stopAt.alive) { m.remaining = 0.001; return; }
        ndx = (stopAt.x - v.x) / d; ndy = (stopAt.y - v.y) / d;
      }
      const step = Math.min(left, speed * dt);
      left -= step;
      v.w.forceMove(v, v.x + ndx * step, v.y + ndy * step);
      for (const e of u.w.enemiesIn(u.team, v.x, v.y, r)) {
        if (hit.has(e.id)) continue;
        hit.add(e.id);
        onHit(e);
      }
      if (left <= 0) m.remaining = 0.001;
    },
  }, u, a);
}

defineAbility({
  key: 'earth_spirit_boulder_smash', target: 'unitOrPoint', team: 'any', ai: { role: 'nuke' },
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    let v = t.unit as Unit | undefined;
    if (!v) {
      // Al suelo: la piedra más cercana o, si no hay, la unidad más cercana.
      const search = val(a, 'rock_search_aoe');
      v = remnantsNear(u, u.x, u.y, search)[0] ??
        u.w.unitsIn(u.x, u.y, search, (x) => x !== u && u.w.targetable(x) && (x.isHeroLike || x.kind === 'creep' || x.kind === 'summon'))
          .sort((p, q) => Math.hypot(p.x - u.x, p.y - u.y) - Math.hypot(q.x - u.x, q.y - u.y))[0];
      if (!v) return;
    }
    if (v.team !== u.team && v.has(ST.magicImmune) && !isRemnant(v)) return;
    const [dx, dy] = t.unit ? [Math.cos(u.facing), Math.sin(u.facing)] : castDir(u, t.x, t.y);
    const rock = isRemnant(v);
    if (rock) remnantUsed(u);
    const dist = rock ? val(a, 'rock_distance') : val(a, 'unit_distance');
    u.w.emit({ n: 'boulder_smash', x: v.x, y: v.y, u: v.id, u2: u.id });
    const hitOne = (e: Unit) => {
      damage(u, e, dmg(a, 'rock_damage') * (e.isHeroLike ? 1 : val(a, 'creep_multiplier')), 'magical', a);
      if (rock) { slow(u, e, a, 'boulder_smash_slow', dur(a, 'duration'), val(a, 'move_slow') / 100); shareMagnetize(u, e, 'slow', dur(a, 'duration'), a); }
      if (val(a, 'stun_duration') > 0) stun(u, e, val(a, 'stun_duration'), a);
    };
    if (v.team !== u.team && !rock) hitOne(v);
    slide(u, a, v, dx, dy, dist, val(a, 'speed'), hitOne, val(a, 'radius'));
  },
});

defineAbility({
  key: 'earth_spirit_rolling_boulder', target: 'point', ai: { role: 'nuke' }, castBeyond: true,
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const [dx, dy] = castDir(u, t.x, t.y);
    u.facing = Math.atan2(dy, dx);
    let left = val(a, 'distance');
    let speed = val(a, 'speed');
    let stunDur = dur(a, 'stun_duration');
    const hit = new Set<number>();
    let rolling = false;
    u.order = null; u.path = [];
    u.addMod({
      name: 'rolling_boulder', duration: val(a, 'delay') + 5, states: ST.busy | ST.disarmed, fx: 'rolling_boulder',
      onTick(m, dt) {
        if (u.has(ST.stunned | ST.rooted | ST.hexed)) { m.remaining = 0.001; return; }
        if (m.duration - m.remaining < val(a, 'delay')) return;
        rolling = true;
        // Pasar por una piedra: más rápido, más lejos y más aturdimiento.
        const rock = remnantsNear(u, u.x, u.y, val(a, 'radius')).find((r) => r !== u);
        if (rock && !m.data.rock) {
          m.data.rock = true;
          remnantUsed(u);
          if (val(a, 'destroy_stone')) destroyRemnant(rock);
          speed = val(a, 'rock_speed');
          left += val(a, 'distance') * (val(a, 'rock_distance_multiplier') - 1);
          stunDur += val(a, 'rock_bonus_duration');
        }
        const step = Math.min(left, speed * dt);
        left -= step;
        u.w.forceMove(u, u.x + dx * step, u.y + dy * step);
        for (const e of u.w.enemiesIn(u.team, u.x, u.y, val(a, 'radius'))) {
          if (hit.has(e.id)) continue;
          hit.add(e.id);
          damage(u, e, dmg(a, 'damage') + val(a, 'damage_str') / 100 * u.s.str, 'magical', a);
          stun(u, e, stunDur, a);
          // Se para al chocar con un héroe enemigo.
          if (e.isHeroLike) { left = 0; break; }
        }
        if (left <= 0) m.remaining = 0.001;
      },
      onDestroy() { if (rolling) u.w.emit({ n: 'rolling_boulder_end', x: u.x, y: u.y, u: u.id }); },
    }, u, a);
  },
});

/** Piedra detrás de un enemigo, en línea con Earth Spirit (para el combo de Grip). */
function gripCombo(u: Unit, a: AbilityInst): { rock: Unit; enemy: Unit } | null {
  for (const e of u.w.enemiesIn(u.team, u.x, u.y, 900, { heroes: true })) {
    for (const r of remnantsNear(u, u.x, u.y, val(a, 'abilitycastrange'))) {
      if (r === e || Math.hypot(r.x - u.x, r.y - u.y) < Math.hypot(e.x - u.x, e.y - u.y)) continue;
      if (segInfo(e.x, e.y, u.x, u.y, r.x, r.y).dist <= val(a, 'radius')) return { rock: r, enemy: e };
    }
  }
  return null;
}

defineAbility({
  key: 'earth_spirit_geomagnetic_grip', target: 'unitOrPoint', team: 'ally', ai: aiBy('disable'),
  passive: (a) => botCast(a, (u) => {
    const c = gripCombo(u, a);
    return c ? { x: c.rock.x, y: c.rock.y } : null;
  }),
  noIllusion: true,
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    let v = t.unit as Unit | undefined;
    if (!v) v = remnantsNear(u, t.x, t.y, 200)[0];
    if (!v || v === u) return;
    const rock = isRemnant(v);
    if (!rock && Math.hypot(v.x - u.x, v.y - u.y) > val(a, 'cast_range_heroes') + 150) { a.cd = 0; u.mana += val(a, '_mc'); return; }
    if (rock) remnantUsed(u);
    const speed = rock ? val(a, 'speed') : val(a, 'pull_units_per_second_heroes');
    const dist = Math.min(val(a, 'total_pull_distance'), Math.hypot(v.x - u.x, v.y - u.y));
    u.w.emit({ n: 'geomagnetic_grip', x: v.x, y: v.y, x2: u.x, y2: u.y, u: v.id, u2: u.id });
    slide(u, a, v, 0, 0, dist, speed, (e) => {
      silence(u, e, dur(a, 'duration'), a, 'grip_silence');
      shareMagnetize(u, e, 'silence', dur(a, 'duration'), a);
      if (rock) damage(u, e, dmg(a, 'rock_damage'), 'magical', a);
    }, val(a, 'radius'), u);
  },
});

defineAbility({
  key: 'earth_spirit_stone_caller', target: 'point', innate: true, ai: aiBy('summon'),
  charges: (a) => [val(a, 'abilitycharges'), val(a, 'abilitychargerestoretime')],
  passive: (a) => botCast(a, (u) => {
    // Piedra junto a un enemigo magnetizado, o detrás de uno para el Grip.
    for (const e of u.w.enemiesIn(u.team, u.x, u.y, val(a, 'abilitycastrange'), { heroes: true })) {
      if (e.findMod('magnetize', u) && !remnantsNear(u, e.x, e.y, 350).length) return { x: e.x, y: e.y };
    }
    const grip = u.abilities.find((x) => x.key === 'earth_spirit_geomagnetic_grip' && x.level > 0);
    if (!grip || u.w.castCheck(u, grip) || gripCombo(u, grip)) return null;
    const e = u.w.enemiesIn(u.team, u.x, u.y, 800, { heroes: true })[0];
    if (!e) return null;
    const d = Math.hypot(e.x - u.x, e.y - u.y) || 1;
    return { x: e.x + (e.x - u.x) / d * 150, y: e.y + (e.y - u.y) / d * 150 };
  }, {
    name: 'stone_caller', interval: 0.5,
    props: () => ({ damagePct: a.charges * val(a, 'attack_damage_per_stone') / 100 }),
    onInterval(m) { if (m.data.c !== a.charges) { m.data.c = a.charges; (m.owner as Unit).refreshStats(); } },
  }),
  noIllusion: true,
  castBeyond: true,
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const r = val(a, 'abilitycastrange') + u.s.castRange;
    let x = t.x, y = t.y;
    const d = Math.hypot(x - u.x, y - u.y);
    if (d > r) { x = u.x + (x - u.x) / d * r; y = u.y + (y - u.y) / d * r; }
    spawnRemnant(u, x, y, val(a, 'duration'));
  },
});

defineAbility({
  key: 'earth_spirit_petrify', target: 'unit', team: 'any', ai: { role: 'disable' },
  castRange: (a) => val(a, 'ally_cast_range'),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const e = t.unit as Unit;
    if (e.data_remnant) {
      // Sobre una piedra: estalla ya y el enfriamiento es corto.
      a.cd = 5;
      shatter(a, e.x, e.y);
      destroyRemnant(e);
      return;
    }
    if (e.team !== u.team && Math.hypot(e.x - u.x, e.y - u.y) > val(a, 'abilitycastrange') + e.radius + u.radius + 100) {
      a.cd = 0; u.mana += val(a, '_mc'); return;
    }
    if (e.cast) e.w.interruptCast(e, true);
    e.addMod({
      name: 'enchant_remnant', duration: val(a, 'duration'), debuff: e.team !== u.team, purgable: false, fx: 'petrify',
      states: ST.stunned | ST.invulnerable,
      onDestroy(m) { const v = m.owner as Unit; if (v.alive) u.w.after(0.01, () => shatter(a, v.x, v.y)); },
    }, u, a);
  },
});

function shatter(a: AbilityInst, x: number, y: number) {
  const u = a.owner as Unit;
  const r = val(a, 'aoe');
  u.w.emit({ n: 'petrify_shatter', x, y, r, t: u.team });
  // Los invulnerables (el propio petrificado) no salen en enemiesIn: se busca a mano.
  for (const e of u.w.unitsIn(x, y, r, (v) => v.team !== u.team && u.w.targetable(v) && v.kind !== 'fountain')) {
    damage(u, e, val(a, 'damage'), 'magical', a);
  }
}

/** Magnetiza a una unidad (o refresca). */
function magnetize(a: AbilityInst, e: Unit) {
  const u = a.owner as Unit;
  return debuff(u, e, a, {
    name: 'magnetize', duration: val(a, 'damage_duration') * (hasTalent(u, 'special_bonus_unique_earth_spirit_8') ? 1.3 : 1), fx: 'magnetize', interval: val(a, 'damage_interval'),
    onInterval(m) { damage(u, m.owner as Unit, dmg(a, 'damage_per_second') * val(a, 'damage_interval'), 'magical', a, { noProc: true }); },
    onTick(m) { explodeNear(a, m.owner as Unit); },
  });
}

/** Las piedras cerca de un magnetizado explotan y refrescan Magnetize alrededor. */
function explodeNear(a: AbilityInst, v: Unit) {
  const u = a.owner as Unit;
  const rock = remnantsNear(u, v.x, v.y, val(a, 'rock_search_radius')).find((r) => r.data_remnant);
  if (!rock) return;
  destroyRemnant(rock);
  const r = val(a, 'rock_explosion_radius');
  u.w.emit({ n: 'magnetize_explode', x: rock.x, y: rock.y, r, t: u.team });
  for (const e of u.w.enemiesIn(u.team, rock.x, rock.y, r)) {
    const m = e.findMod('magnetize', u);
    if (m) m.remaining = m.duration;
    else magnetize(a, e);
  }
}

defineAbility({
  key: 'earth_spirit_magnetize', target: 'none', ult: true, ai: { role: 'aoe', selfRadius: 300 },
  aoe: (a) => val(a, 'cast_radius'),
  onSpellStart(a) {
    const u = a.owner as Unit;
    u.w.emit({ n: 'magnetize', x: u.x, y: u.y, r: val(a, 'cast_radius'), t: u.team });
    for (const e of u.w.enemiesIn(u.team, u.x, u.y, val(a, 'cast_radius'))) magnetize(a, e);
    // Talento: Earth Spirit también hace estallar piedras a su alrededor.
    if (val(a, 'magnetize_self') > 0 || hasTalent(u, 'special_bonus_unique_earth_spirit_2')) {
      u.addMod({ name: 'magnetize_self', duration: val(a, 'damage_duration'), fx: 'magnetize',
        onTick(m) { explodeNear(a, m.owner as Unit); } }, u, a);
    }
  },
});

defineHero('earth_spirit', ['earth_spirit_boulder_smash', 'earth_spirit_rolling_boulder', 'earth_spirit_geomagnetic_grip', 'earth_spirit_stone_caller', 'earth_spirit_petrify', 'earth_spirit_magnetize'], {
  build: ['bracer', 'phase_boots', 'blink', 'black_king_bar', 'pipe', 'shivas_guard', 'ultimate_scepter', 'refresher'],
  upgrades: [
    { slot: 0, key: 'rock_damage', amount: 40, max: 5, label: 'Boulder Smash: +40 daño' },
    { slot: 1, key: 'damage_str', amount: 20, max: 5, label: 'Rolling Boulder: +20% de fuerza como daño' },
    { slot: 2, key: 'duration', amount: 0.3, max: 4, label: 'Geomagnetic Grip: +0,3 s de silencio' },
    { slot: 5, key: 'damage_per_second', amount: 20, max: 5, label: 'Magnetize: +20 daño por segundo' },
    { slot: 5, key: 'cast_radius', amount: 30, max: 4, label: 'Magnetize: +30 radio' },
  ],
});
