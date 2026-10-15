import { defineAbility, defineHero, dmg, dur, hasScepter, hasShard, val } from '../sim/abilities';
import { damage, heal, landAttack, makeAttack } from '../sim/combat';
import type { AbilityInst } from '../sim/types';
import { ST } from '../sim/types';
import type { Unit } from '../sim/unit';
import { castDir, slow, stun } from './util';
import { aiBy, botCast } from './lib/a2';

/** Golpe de Starbreaker: un ataque con daño extra a cada enemigo del área. */
function strike(u: Unit, a: AbilityInst, x: number, y: number, r: number, bonus: number, stunDur: number) {
  u.data_starbreaker = true;
  for (const e of u.w.enemiesIn(u.team, x, y, r)) {
    const ev = makeAttack(u, e, true);
    ev.damage += bonus;
    landAttack(ev);
    if (e.alive && stunDur > 0) stun(u, e, stunDur, a);
  }
  u.data_starbreaker = false;
}

defineAbility({
  key: 'dawnbreaker_fire_wreath', target: 'point', allowSelf: true, ai: { role: 'aoe' },
  castPoint: (a) => (hasShard(a.owner as Unit) ? val(a, 'shard_cast_point') : val(a, 'abilitycastpoint')),
  castRange: () => 300,
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const [dx, dy] = castDir(u, t.x, t.y);
    u.facing = Math.atan2(dy, dx);
    const d = val(a, 'duration');
    const total = val(a, 'total_attacks');
    const every = d / total;
    const shard = hasShard(u);
    let done = 0;
    u.order = null; u.path = [];
    u.addMod({
      name: 'starbreaker', duration: d, fx: 'starbreaker',
      states: ST.disarmed | (shard ? ST.magicImmune : ST.busy),
      props: shard ? { magicResist: val(a, 'immunity_resist') / 100, msPct: -val(a, 'shard_movement_penalty') / 100 } : {},
      onTick(m, dt) {
        const elapsed = m.duration - m.remaining;
        // Sin Shard avanza hacia delante a velocidad fija.
        if (!shard) u.w.forceMove(u, u.x + Math.cos(u.facing) * val(a, 'movement_speed') * dt, u.y + Math.sin(u.facing) * val(a, 'movement_speed') * dt);
        while (done < total - 1 && elapsed >= done * every) {
          done++;
          strike(u, a, u.x, u.y, val(a, 'swipe_radius'), dmg(a, 'swipe_damage'), val(a, 'sweep_stun_duration'));
          u.w.emit({ n: 'starbreaker_swipe', x: u.x, y: u.y, r: val(a, 'swipe_radius'), u: u.id });
        }
      },
      onDestroy() {
        if (!u.alive) return;
        const off = val(a, 'smash_distance_from_hero');
        const sx = u.x + Math.cos(u.facing) * off, sy = u.y + Math.sin(u.facing) * off;
        u.w.emit({ n: 'starbreaker_smash', x: sx, y: sy, r: val(a, 'smash_radius'), t: u.team });
        strike(u, a, sx, sy, val(a, 'smash_radius'), dmg(a, 'smash_damage'), dur(a, 'smash_stun_duration'));
        if (!shard) u.addMod({ name: 'starbreaker_recover', duration: val(a, 'self_stun_duration'), states: ST.stunned }, u, a);
      },
    }, u, a);
  },
});

/** Estado del martillo lanzado (vive en la habilidad para que Converge lo vea). */
interface Hammer { x: number; y: number; tx: number; ty: number; phase: 'out' | 'pause' | 'back' | 'converge'; until: number; hit: Set<number> }

function trail(a: AbilityInst, x: number, y: number) {
  const u = a.owner as Unit;
  const r = val(a, 'flare_radius');
  const every = val(a, 'burn_interval');
  u.w.addZone({
    fx: 'celestial_flare', x, y, r, team: u.team, interval: every, duration: dur(a, 'flare_debuff_duration'),
    onInterval(z) {
      for (const e of u.w.enemiesIn(u.team, z.x, z.y, r)) {
        if (e.findMod('celestial_burn', u)?.data.at === u.w.time) continue;
        const m = slow(u, e, a, 'celestial_burn', every + 0.05, val(a, 'move_slow') / 100);
        if (!m) continue;
        m.data.at = u.w.time;
        damage(u, e, dmg(a, 'burn_damage') * every, 'magical', a, { noProc: true });
      }
    },
  });
}

defineAbility({
  key: 'dawnbreaker_celestial_hammer', target: 'point', ai: { role: 'nuke' }, castBeyond: true,
  castRange: (a) => val(a, 'range'),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const [dx, dy] = castDir(u, t.x, t.y);
    const dist = Math.min(val(a, 'range') + u.s.castRange, Math.max(100, Math.hypot(t.x - u.x, t.y - u.y)));
    const h: Hammer = { x: u.x, y: u.y, tx: u.x + dx * dist, ty: u.y + dy * dist, phase: 'out', until: 0, hit: new Set() };
    a.data.hammer = h;
    const speed = val(a, 'projectile_speed');
    const r = val(a, 'projectile_radius');
    u.addMod({
      name: 'celestial_hammer', duration: 30, fx: 'hammer',
      onTick(m, dt) {
        const goTo = (x: number, y: number, sp: number) => {
          const d = Math.hypot(x - h.x, y - h.y);
          const step = sp * dt;
          if (d <= step) { h.x = x; h.y = y; return true; }
          h.x += (x - h.x) / d * step; h.y += (y - h.y) / d * step;
          return false;
        };
        if (h.phase === 'out') {
          const arrived = goTo(h.tx, h.ty, speed);
          for (const e of u.w.enemiesIn(u.team, h.x, h.y, r)) {
            if (h.hit.has(e.id)) continue;
            h.hit.add(e.id);
            damage(u, e, dmg(a, 'hammer_damage'), 'magical', a);
          }
          if (arrived) { h.phase = 'pause'; h.until = u.w.time + val(a, 'pause_duration'); }
        } else if (h.phase === 'pause') {
          if (u.w.time >= h.until) h.phase = 'back';
        } else if (h.phase === 'back') {
          // Vuelve dejando un rastro de fuego.
          if (u.w.time - (m.data.trailAt ?? 0) >= 0.08) { m.data.trailAt = u.w.time; trail(a, h.x, h.y); }
          if (goTo(u.x, u.y, speed * val(a, 'travel_speed_pct') / 100) || !u.alive) { m.remaining = 0.001; }
        }
        u.w.emit({ n: 'hammer_pos', x: h.x, y: h.y, u: u.id });
      },
      onDestroy() { a.data.hammer = null; },
    }, u, a);
  },
});

defineAbility({
  key: 'dawnbreaker_luminosity', target: 'passive',
  passive: (a) => ({
    name: 'luminosity', stacks: a.data.count ?? 0,
    onAttackStart(m, ev) {
      const u = ev.attacker as Unit;
      if (ev.fake && !u.data_starbreaker) return;
      if ((a.data.count ?? 0) >= val(a, 'attack_count')) {
        ev.critMult = Math.max(ev.critMult, val(a, 'bonus_damage') / 100);
        m.data.lumi = true;
      }
    },
    onAttackLanded(m, ev) {
      const t = ev.target as Unit;
      if (ev.fake && !(ev.attacker as Unit).data_starbreaker) return;
      if (m.data.lumi || t.team === (ev.attacker as Unit).team) return;
      a.data.count = (a.data.count ?? 0) + 1;
      m.stacks = a.data.count;
    },
    onDealDamage(m, ev) {
      if (!ev.isAttack || !m.data.lumi) return;
      m.data.lumi = false;
      a.data.count = 0; m.stacks = 0;
      const u = m.owner as Unit;
      const t = ev.target as Unit;
      let amount = ev.amount * val(a, 'heal_pct') / 100;
      if (!t.isHeroLike) amount *= val(a, 'heal_from_creeps') / 100;
      heal(u, amount, u);
      u.w.emit({ n: 'luminosity', x: u.x, y: u.y, r: val(a, 'heal_radius'), u: u.id });
      for (const al of u.w.alliesIn(u.team, u.x, u.y, val(a, 'heal_radius'), { heroes: true })) {
        if (al !== u) heal(al, amount * val(a, 'allied_healing_pct') / 100, u);
      }
    },
  }),
});

defineAbility({
  key: 'dawnbreaker_converge', target: 'none', levelWith: 1, ai: aiBy('escape'),
  hidden: (a) => !(a.owner as Unit).abilities.find((x) => x.key === 'dawnbreaker_celestial_hammer')?.data.hammer,
  passive: (a) => botCast(a, (u) => {
    const h = u.abilities.find((x) => x.key === 'dawnbreaker_celestial_hammer')?.data.hammer as Hammer | null;
    if (!h || h.phase !== 'pause') return null;
    const e = u.w.enemiesIn(u.team, h.x, h.y, 500, { heroes: true })[0];
    return e && Math.hypot(h.x - u.x, h.y - u.y) > 500 ? {} : null;
  }),
  noIllusion: true,
  onSpellStart(a) {
    const u = a.owner as Unit;
    const ham = u.abilities.find((x) => x.key === 'dawnbreaker_celestial_hammer');
    const h = ham?.data.hammer as Hammer | null;
    if (!ham || !h || u.has(ST.rooted)) return;
    h.phase = 'converge';
    const speed = val(ham, 'projectile_speed');
    u.order = null; u.path = [];
    u.addMod({
      name: 'converge', duration: 3, states: ST.busy | ST.noCollision, fx: 'converge',
      onTick(m, dt) {
        const d = Math.hypot(h.x - u.x, h.y - u.y);
        if (d < 60 || !u.alive) { m.remaining = 0.001; return; }
        const step = Math.min(d / 2, speed * dt);
        u.facing = Math.atan2(h.y - u.y, h.x - u.x);
        u.w.forceMove(u, u.x + (h.x - u.x) / d * step, u.y + (h.y - u.y) / d * step);
        h.x -= (h.x - u.x) / d * step; h.y -= (h.y - u.y) / d * step;
      },
      onDestroy() { u.removeModsByName('celestial_hammer'); },
    }, u, a);
  },
});

defineAbility({
  key: 'dawnbreaker_break_of_dawn', target: 'passive', innate: true,
  passive: (a) => ({
    name: 'break_of_dawn', interval: 1,
    props: (m) => {
      const u = m.owner as Unit;
      if (!u.w) return {};
      let f = 0;
      if ((u.data_solarDayUntil ?? 0) > u.w.time) f = 1;
      else if (!u.w.isNight()) f = 1 - (u.w.time % 300) / 300;
      return { damagePct: f * val(a, 'max_dmg_pct') / 100, vision: f * u.base.dayVision * val(a, 'max_vision_pct') / 100 };
    },
    onInterval(m) { (m.owner as Unit).refreshStats(); },
  }),
});

/** Pulso de Solar Guardian: daña enemigos y cura aliados. */
function pulse(a: AbilityInst, x: number, y: number) {
  const u = a.owner as Unit;
  const r = val(a, 'radius');
  u.w.emit({ n: 'solar_pulse', x, y, r, t: u.team });
  for (const e of u.w.enemiesIn(u.team, x, y, r)) damage(u, e, dmg(a, 'base_damage'), 'magical', a, { noProc: true });
  for (const al of u.w.alliesIn(u.team, x, y, r)) if (al.isHeroLike || al.kind === 'creep' || al.kind === 'summon') heal(al, val(a, 'base_heal'), u, true);
}

function landSolar(a: AbilityInst) {
  const u = a.owner as Unit;
  const r = val(a, 'radius');
  u.removeModsByName('solar_air');
  u.w.emit({ n: 'solar_land', x: u.x, y: u.y, r, t: u.team });
  for (const e of u.w.enemiesIn(u.team, u.x, u.y, r)) {
    damage(u, e, dmg(a, 'land_damage'), 'magical', a);
    stun(u, e, dur(a, 'land_stun_duration'), a);
  }
  // Scepter: el aura sigue a Dawnbreaker unos segundos.
  const after = val(a, 'scepter_aura_duration');
  if (after > 0) {
    u.addMod({
      name: 'solar_aura', duration: after, interval: val(a, 'pulse_interval'), fx: 'solar_guardian',
      onInterval(m) { const v = m.owner as Unit; pulse(a, v.x, v.y); },
    }, u, a);
  }
}

defineAbility({
  key: 'dawnbreaker_solar_guardian', target: 'point', ult: true, ai: aiBy('heal'),
  castRange: () => 99999,
  aoe: (a) => val(a, 'radius'),
  passive: (a) => botCast(a, (u) => {
    const allies = u.w.list.filter((v) => v.alive && v.team === u.team && v.kind === 'hero');
    for (const v of allies) {
      const e = u.w.enemiesIn(u.team, v.x, v.y, 450, { heroes: true });
      if (e.length && (v.hp / v.s.maxHp < 0.7 || v === u)) return { x: v.x, y: v.y };
    }
    return null;
  }),
  noIllusion: true,
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    // El punto tiene que estar cerca de un héroe aliado: se ajusta al más cercano.
    const max = val(a, 'max_offset_distance');
    const allies = u.w.list.filter((v) => v.alive && v.team === u.team && v.kind === 'hero');
    let best = u, bd = Infinity;
    for (const v of allies) { const d = Math.hypot(v.x - t.x, v.y - t.y); if (d < bd) { bd = d; best = v; } }
    let x = t.x, y = t.y;
    if (bd > max) { x = best.x + (t.x - best.x) / bd * max; y = best.y + (t.y - best.y) / bd * max; }
    const ch = val(a, 'abilitychanneltime');
    u.data_solarDayUntil = u.w.time + ch + val(a, 'daytime_duration');
    u.w.addVision(u.team, x, y, val(a, 'radius'), ch + 1);
    u.order = null; u.path = [];
    u.w.emit({ n: 'solar_guardian', x, y, r: val(a, 'radius'), d: ch, t: u.team });
    // Canalización propia: Dawnbreaker no puede cancelarla, pero un aturdimiento sí.
    u.addMod({
      name: 'solar_guardian_channel', duration: ch, states: ST.busy | ST.disarmed | ST.channeling, fx: 'channel',
      interval: val(a, 'pulse_interval'),
      onInterval() { pulse(a, x, y); },
      onTick(m) { if (u.has(ST.stunned | ST.hexed | ST.silenced)) { m.data.broken = true; m.remaining = 0.001; } },
      onDestroy(m) {
        if (m.data.broken || !u.alive) return;
        const air = val(a, 'airtime_duration');
        const fx0 = u.x, fy0 = u.y;
        const sc = hasScepter(u);
        const t0 = u.w.time;
        u.addMod({
          name: 'solar_air', duration: air + (sc ? val(a, 'airtime_scepter_bonus') : 0),
          states: ST.invulnerable | ST.untargetable | ST.flying | ST.noCollision | ST.disarmed | (sc ? 0 : ST.busy), fx: 'solar_air',
          props: sc ? { msFixed: val(a, 'airtime_scepter_movement_speed') } : {},
          interval: val(a, 'pulse_interval'),
          onInterval() { if (u.w.time - t0 > air) pulse(a, u.x, u.y); },
          onTick(mm) {
            const k = Math.min(1, (mm.duration - mm.remaining) / air);
            if (k < 1) u.w.forceMove(u, fx0 + (x - fx0) * k, fy0 + (y - fy0) * k);
            else if (!sc && !mm.data.landed) { mm.data.landed = true; mm.remaining = 0.001; }
          },
          onDestroy(mm) { if (u.alive && !mm.data.byLand) landSolar(a); },
        }, u, a);
      },
    }, u, a);
  },
});

defineAbility({
  key: 'dawnbreaker_land', target: 'none', levelWith: 5, ai: aiBy('aoe'),
  hidden: (a) => !(a.owner as Unit).findMod('solar_air'),
  passive: (a) => botCast(a, (u) => {
    const m = u.findMod('solar_air');
    return m && m.duration - m.remaining > 1 ? {} : null;
  }),
  noIllusion: true,
  onSpellStart(a) {
    const u = a.owner as Unit;
    const m = u.findMod('solar_air');
    const sg = u.abilities.find((x) => x.key === 'dawnbreaker_solar_guardian');
    if (!m || !sg) return;
    m.data.byLand = true;
    u.removeMod(m);
    landSolar(sg);
  },
});

defineHero('dawnbreaker', ['dawnbreaker_fire_wreath', 'dawnbreaker_celestial_hammer', 'dawnbreaker_luminosity', 'dawnbreaker_converge', 'dawnbreaker_break_of_dawn', 'dawnbreaker_solar_guardian', 'dawnbreaker_land'], {
  build: ['bracer', 'phase_boots', 'echo_sabre', 'black_king_bar', 'desolator', 'assault', 'greater_crit', 'ultimate_scepter'],
  upgrades: [
    { slot: 0, key: 'swipe_damage', amount: 20, max: 5, label: 'Starbreaker: +20 daño de barrido' },
    { slot: 0, key: 'smash_stun_duration', amount: 0.15, max: 4, label: 'Starbreaker: +0,15 s de aturdimiento' },
    { slot: 1, key: 'hammer_damage', amount: 35, max: 5, label: 'Celestial Hammer: +35 daño' },
    { slot: 2, key: 'bonus_damage', amount: 15, max: 5, label: 'Luminosity: +15% crítico' },
    { slot: 5, key: 'land_damage', amount: 50, max: 5, label: 'Solar Guardian: +50 daño al aterrizar' },
  ],
});
