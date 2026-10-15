import { castRangeOf, defineAbility, defineHero, dmg, dur, hasScepter, val } from '../sim/abilities';
import { creditHero, damage } from '../sim/combat';
import type { AbilityInst } from '../sim/types';
import { ST } from '../sim/types';
import type { Unit } from '../sim/unit';
import { castDir, dash, debuff, push, slow, stun } from './util';
import { abil, allyRedirect, enemiesInLine, fear, gate, reveal, rollMiss } from './lib/a6';

// ---------------- Tame the Beasts ----------------

/** Restallido del látigo: más daño y miedo cuanto más se canalizó, pero más estrecho. */
function crack(a: AbilityInst) {
  const u = a.owner as Unit;
  const ch = Math.max(0.01, val(a, 'abilitychanneltime'));
  const p = Math.max(0, Math.min(1, (u.w.time - a.data.start) / ch));
  // Crecimiento exponencial hasta `max_multiplier`.
  const mm = val(a, 'max_multiplier');
  const k = mm > 1 ? (Math.pow(mm, p) - 1) / (mm - 1) : p;
  const damageNow = (val(a, 'damage_min') + (val(a, 'damage_max') - val(a, 'damage_min')) * k) * a.upg.dmg;
  const fearDur = val(a, 'fear_duration_min') + (val(a, 'fear_duration_max') - val(a, 'fear_duration_min')) * p;
  const width = val(a, 'start_width') + (val(a, 'end_width') - val(a, 'start_width')) * p;
  const [dx, dy] = castDir(u, a.data.tx, a.data.ty);
  const len = Math.min(castRangeOf(a), Math.hypot(a.data.tx - u.x, a.data.ty - u.y) + width / 2);
  u.w.emit({ n: 'tame_the_beasts', x: u.x, y: u.y, x2: u.x + dx * len, y2: u.y + dy * len, r: width / 2, t: u.team });
  for (const e of enemiesInLine(u, u.x, u.y, dx, dy, len, width)) {
    if (e.has(ST.magicImmune)) continue;
    damage(u, e, damageNow, 'magical', a);
    if (e.alive) fear(u, e, fearDur * a.upg.dur, a, u.x, u.y);
  }
}

defineAbility({
  key: 'ringmaster_tame_the_beasts', target: 'point', castBeyond: true, ai: { role: 'disable' },
  aoe: (a) => val(a, 'start_width') / 2,
  channel: (a) => val(a, 'abilitychanneltime'),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    a.data.start = u.w.time; a.data.tx = t.x; a.data.ty = t.y;
    if (val(a, 'has_debuff_immunity') > 0) {
      u.addMod({ name: 'tame_immunity', duration: val(a, 'abilitychanneltime'), states: ST.magicImmune, props: { magicResist: val(a, 'magic_resist') / 100 } }, u, a);
    }
    gate(abil(u, 'ringmaster_tame_the_beasts_crack'), true);
  },
  onChannelEnd(a) {
    const u = a.owner as Unit;
    u.removeModsByName('tame_immunity');
    gate(abil(u, 'ringmaster_tame_the_beasts_crack'), false);
    if (u.alive) crack(a);
  },
});

defineAbility({
  key: 'ringmaster_tame_the_beasts_crack', target: 'none', levelWith: 0,
  hidden: (a) => (a.owner as Unit).cast?.a.key !== 'ringmaster_tame_the_beasts',
  onSpellStart(a) {
    const u = a.owner as Unit;
    // Suelta el látigo antes de tiempo.
    if (u.cast?.a.key === 'ringmaster_tame_the_beasts') u.w.interruptCast(u, false);
    gate(a, false);
  },
});

// ---------------- Escape Act ----------------

/** Lanza `n` dagas de Impalement Arts en abanico (Escape Act con Scepter). */
function daggerFan(u: Unit, x: number, y: number, n: number, range: number) {
  const ia = abil(u, 'ringmaster_impalement');
  if (!ia || ia.level <= 0) return;
  for (let i = 0; i < n; i++) {
    const ang = i * 2 * Math.PI / n;
    throwDagger(ia, x, y, Math.cos(ang), Math.sin(ang), range);
  }
}

defineAbility({
  key: 'ringmaster_the_box', target: 'unit', team: 'ally', allowSelf: true, ai: { role: 'buff' },
  passive: (a) => allyRedirect(a),
  charges: (a) => {
    const sc = hasScepter(a.owner as Unit);
    const every = sc ? val(a, 'abilitychargerestoretime') : val(a, '_cd');
    return [sc ? Math.max(1, val(a, 'max_charges')) : 1, every * (1 - (a.owner as Unit).s.cdr)];
  },
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const e = (t.unit as Unit) ?? u;
    if (val(a, 'strong_dispel') > 0) e.purge(true, false, true);
    const ox = e.x, oy = e.y;
    const transform = val(a, 'transform_time');
    const flying = val(a, 'grant_flying') > 0 ? ST.flying : 0;
    e.w.disjoint(e);
    e.addMod({
      name: 'escape_act', duration: transform + dur(a, 'invis_duration'), fx: 'escape_act', purgable: true,
      states: ST.untargetable | ST.muted | ST.silenced | ST.disarmed | ST.noCollision | flying,
      props: { magicResist: val(a, 'magic_resist') / 100, slowResist: val(a, 'slow_resist') / 100, msPct: val(a, 'move_speed') / 100 },
      onTick(m) {
        const v = m.owner as Unit;
        if (Math.hypot(v.x - ox, v.y - oy) > val(a, 'leash_radius')) m.remaining = 0.001;
      },
      onDestroy(m) {
        const v = m.owner as Unit;
        if (!v.alive) return;
        v.w.emit({ n: 'escape_act_pop', x: v.x, y: v.y, u: v.id });
        if (flying && !v.w.grid.walkable(v.x, v.y)) v.w.teleport(v, v.x, v.y);
        // Scepter: al abrirse, dagas en todas direcciones y daño alrededor.
        if (hasScepter(u) && val(a, 'launch_daggers_count') > 0) {
          daggerFan(u, v.x, v.y, val(a, 'launch_daggers_count'), val(a, 'launch_daggers_range'));
          for (const en of u.w.enemiesIn(u.team, v.x, v.y, val(a, 'explosion_radius'))) damage(u, en, val(a, 'explosion_damage'), 'magical', a);
        }
      },
    }, u, a);
  },
});

// ---------------- Impalement Arts ----------------

function throwDagger(a: AbilityInst, x: number, y: number, dx: number, dy: number, range: number) {
  const u = a.owner as Unit;
  let pierce = val(a, 'dagger_pass_through');
  u.w.addProjectile({
    kind: 'linear', fx: 'impalement_dagger', source: u, x, y, dx, dy,
    speed: val(a, 'dagger_speed'), left: range, width: val(a, 'dagger_width'),
    onThink(p) { u.w.addVision(u.team, p.x, p.y, val(a, 'dagger_vision'), 0.2); },
    onHit(_p, e) {
      const v = e as Unit;
      if (v.team === u.team || v.kind === 'ward' || v.has(ST.magicImmune)) return false;
      damage(u, v, dmg(a, 'damage_impact'), 'magical', a);
      slow(u, v, a, 'impalement_slow', val(a, 'slow_duration'), val(a, 'slow_percent') / 100);
      const tick = val(a, 'tick_interval');
      debuff(u, v, a, {
        name: 'impalement_bleed', duration: val(a, 'bleed_duration'), interval: tick, fx: 'bleed',
        onInterval(m) {
          const w = m.owner as Unit;
          const per = w.isHeroLike ? w.s.maxHp * val(a, 'bleed_health_pct') / 100 : val(a, 'bleed_creep_dps');
          damage(u, w, per * tick, 'magical', a, { noProc: true });
        },
      });
      if (pierce > 0) { pierce--; return false; }
      return true;
    },
  });
}

defineAbility({
  key: 'ringmaster_impalement', target: 'point', castBeyond: true, ai: { role: 'nuke' },
  // Alcance de apuntado (la daga vuela igualmente sus 2400 de recorrido).
  castRange: (a) => val(a, 'abilitycastrange') / 2,
  charges: (a) => [Math.max(1, val(a, 'abilitycharges')), val(a, 'abilitychargerestoretime') * a.upg.cd * (1 - (a.owner as Unit).s.cdr)],
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const [dx, dy] = castDir(u, t.x, t.y);
    throwDagger(a, u.x, u.y, dx, dy, val(a, 'abilitycastrange') * a.upg.range + u.s.castRange);
  },
});

// ---------------- Souvenirs ----------------

const SOUVENIRS = ['ringmaster_funhouse_mirror', 'ringmaster_strongman_tonic', 'ringmaster_whoopee_cushion', 'ringmaster_summon_unicycle'];
/** Recuerdos que tiene guardados (cada tipo cuenta sus cargas en `data.count`). */
const held = (u: Unit) => SOUVENIRS.reduce((n, k) => n + (abil(u, k)?.data.count ?? 0), 0);

function giveSouvenir(u: Unit) {
  const k = SOUVENIRS[Math.floor(u.w.rng() * SOUVENIRS.length)];
  const s = abil(u, k);
  if (!s) return;
  s.data.count = (s.data.count ?? 0) + 1;
  gate(s, true);
  u.w.emit({ n: 'souvenir', x: u.x, y: u.y, u: u.id });
}

/** Gasta un recuerdo; si no le quedan, el hueco vuelve a bloquearse. */
function spendSouvenir(a: AbilityInst) {
  a.data.count = Math.max(0, (a.data.count ?? 0) - 1);
  if (a.data.count <= 0) gate(a, false);
}

// El hueco vacío solo es visual: se muestra cuando no hay recuerdos.
defineAbility({
  key: 'ringmaster_empty_souvenir', target: 'passive', innate: true,
  hidden: (a) => held(a.owner as Unit) > 0,
  passive: () => null,
});

defineAbility({
  key: 'ringmaster_dark_carnival_souvenirs', target: 'passive', innate: true, noIllusion: true,
  passive: (a) => ({
    name: 'dark_carnival_barker',
    onCreated(m) { for (const k of SOUVENIRS) { const s = abil(m.owner as Unit, k); if (s && !(s.data.count > 0)) gate(s, false); } },
    onAnyDeath(m, victim) {
      const u = m.owner as Unit;
      if (u.kind !== 'hero' || !u.alive || victim.kind !== 'hero' || victim.team === u.team) return;
      if (Math.hypot(victim.x - u.x, victim.y - u.y) <= val(a, 'souvenir_collection_range')) giveSouvenir(u);
    },
    onDeath(m) {
      const u = m.owner as Unit;
      if (u.kind === 'hero' && held(u) === 0) giveSouvenir(u);
    },
  }),
});

defineAbility({
  key: 'ringmaster_funhouse_mirror', target: 'none', innate: true, ai: { role: 'buff', selfRadius: 700 },
  hidden: (a) => !(a.data.count > 0),
  onSpellStart(a) {
    const u = a.owner as Unit;
    spendSouvenir(a);
    const out = u.melee ? val(a, 'images_do_damage_percent_melee') : val(a, 'images_do_damage_percent_ranged');
    for (let i = 0; i < val(a, 'images_count'); i++) {
      const ang = u.w.rng() * Math.PI * 2;
      const il = u.w.spawnIllusion(u, u.x + Math.cos(ang) * 80, u.y + Math.sin(ang) * 80, val(a, 'illusion_duration'), out / 100, val(a, 'images_take_damage_percent') / 100);
      il.addMod({ name: 'funhouse_spawn', duration: val(a, 'invuln_duration'), states: ST.invulnerable }, u, a);
      const t = u.w.units.get(u.atk.target);
      if (t && t.alive && t.team !== u.team) u.w.issueOrder(il, { type: 'attack', target: t.id });
    }
  },
});

defineAbility({
  key: 'ringmaster_strongman_tonic', target: 'unit', team: 'ally', allowSelf: true, innate: true, ai: { role: 'buff' },
  hidden: (a) => !(a.data.count > 0),
  passive: (a) => allyRedirect(a),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const e = (t.unit as Unit) ?? u;
    spendSouvenir(a);
    const amount = val(a, 'strength_bonus_base') + val(a, 'strength_bonus_per_level') * u.level;
    const d = val(a, 'duration'), hold = val(a, 'effect_strength_max_duration');
    u.w.after(Math.hypot(e.x - u.x, e.y - u.y) / val(a, 'projectile_speed'), () => {
      if (!e.alive) return;
      e.addMod({
        name: 'strongman_tonic', duration: d, purgable: true, fx: 'strongman_tonic', data: { k: 1 },
        // Fuerza completa unos segundos y luego se desvanece.
        props: (m) => ({ str: amount * m.data.k }),
        onTick(m) {
          const k = m.remaining > d - hold ? 1 : Math.max(0, m.remaining / Math.max(0.01, d - hold));
          if (Math.abs(k - m.data.k) > 0.05) { m.data.k = k; (m.owner as Unit).refreshStats(); }
        },
      }, u, a);
    });
  },
});

defineAbility({
  key: 'ringmaster_whoopee_cushion', target: 'none', innate: true, ai: { role: 'buff', selfRadius: 500 },
  hidden: (a) => !(a.data.count > 0),
  onSpellStart(a) {
    const u = a.owner as Unit;
    spendSouvenir(a);
    const x0 = u.x, y0 = u.y;
    const d = val(a, 'leap_distance');
    dash(u, u.x + Math.cos(u.facing) * d, u.y + Math.sin(u.facing) * d, val(a, 'leap_speed'), a, { name: 'whoopee_leap' });
    const r = val(a, 'fart_cloud_radius');
    u.w.addZone({
      fx: 'whoopee_cloud', x: x0, y: y0, r, team: u.team, interval: 0.2, duration: val(a, 'fart_cloud_duration'),
      onInterval(z) {
        for (const e of u.w.enemiesIn(u.team, z.x, z.y, r)) {
          debuff(u, e, a, { name: 'whoopee_slow', duration: val(a, 'fart_cloud_aura_linger_duration'), fx: 'slow', props: { msSlow: Math.abs(val(a, 'fart_cloud_slow')) / 100 } });
        }
      },
    });
  },
});

defineAbility({
  key: 'ringmaster_summon_unicycle', target: 'none', innate: true, ai: { role: 'buff', selfRadius: 1000 },
  hidden: (a) => !(a.data.count > 0),
  castPoint: (a) => val(a, 'mount_cast_point'),
  onSpellStart(a) {
    const u = a.owner as Unit;
    spendSouvenir(a);
    const start = u.w.time;
    u.addMod({
      name: 'unicycle', duration: val(a, 'mount_duration'), fx: 'unicycle', data: { t: 0 },
      // Acelera hasta su velocidad máxima (el motor limita la velocidad a 550).
      props: (m) => ({ msFixed: Math.min(val(a, 'max_speed'), u.base.ms + val(a, 'acceleration') * m.data.t) }),
      onTick(m, dt) {
        m.data.t += dt;
        if (Math.floor(m.data.t * 5) !== Math.floor((m.data.t - dt) * 5)) u.refreshStats();
        if (u.cast?.phase === 2) m.remaining = 0.001;
        // Atropella árboles (los tala y frena).
        if (u.w.cutTrees(u.x + Math.cos(u.facing) * 40, u.y + Math.sin(u.facing) * 40, val(a, 'impact_radius')) > 0) {
          m.data.t /= val(a, 'tree_impact_speed_divisor');
          u.refreshStats();
        }
      },
      onAttackStart(m) { m.remaining = 0.001; },
      onTakeDamage(m, ev) {
        const s = ev.source as Unit | null;
        if (u.w.time - start < val(a, 'damage_grace_period')) return;
        if (s && s.team !== u.team && creditHero(s) && ev.amount > val(a, 'damage_threshold')) m.remaining = 0.001;
      },
    }, u, a);
  },
});

// ---------------- Spotlight (Shard) ----------------

defineAbility({
  key: 'ringmaster_spotlight', target: 'point', ai: { role: 'disable' },
  aoe: (a) => val(a, 'sweep_radius') + val(a, 'radius'),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const n = val(a, 'spotlight_count');
    const r = val(a, 'radius'), sweep = val(a, 'sweep_radius');
    const speed = val(a, 'sweep_speed');
    const linger = val(a, 'linger_duration');
    const miss = val(a, 'miss_chance') / 100;
    const start = u.w.time;
    u.w.addZone({
      fx: 'spotlight', x: t.x, y: t.y, r: sweep + r, team: u.team, interval: val(a, 'pulse_interval'), duration: dur(a, 'duration'),
      onInterval(z) {
        const tt = u.w.time - start;
        const lit = new Set<number>();
        for (let i = 0; i < n; i++) {
          // Cada foco gira alrededor del centro.
          const ang = i * 2 * Math.PI / n + tt * speed;
          const sx = z.x + Math.cos(ang) * sweep, sy = z.y + Math.sin(ang) * sweep;
          u.w.emit({ n: 'spotlight_beam', x: sx, y: sy, r, t: u.team });
          for (const e of u.w.enemiesIn(u.team, sx, sy, r)) lit.add(e.id);
          for (const e of u.w.list) {
            if (e.team === u.team || !e.alive || !e.has(ST.invisible)) continue;
            if (Math.hypot(e.x - sx, e.y - sy) <= r + e.radius) { lit.add(e.id); reveal(u, e, linger, a, 'spotlight_reveal'); }
          }
        }
        for (const id of lit) {
          const e = u.w.units.get(id);
          if (!e || !e.alive) continue;
          debuff(u, e, a, {
            name: 'spotlight', duration: linger, fx: 'spotlight',
            onAttackStart(_m, ev) { rollMiss(ev, miss); },
          });
          if (e.kind === 'illusion') damage(u, e, e.s.maxHp * val(a, 'illusion_percent_damage') / 100 * z.interval, 'pure', a, { noProc: true });
        }
      },
    });
  },
});

// ---------------- Wheel of Wonder ----------------

defineAbility({
  key: 'ringmaster_wheel', target: 'point', ult: true, castBeyond: true, ai: { role: 'disable' },
  aoe: (a) => val(a, 'mesmerize_radius'),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const [dx, dy] = castDir(u, t.x, t.y);
    const dist = Math.max(val(a, 'min_range'), Math.min(castRangeOf(a), Math.hypot(t.x - u.x, t.y - u.y)));
    const tx = u.x + dx * dist, ty = u.y + dy * dist;
    const knocked = new Set<number>();
    // La rueda rueda hasta el punto apartando enemigos.
    u.w.addProjectile({
      kind: 'linear', fx: 'wheel_of_wonder', source: u, x: u.x, y: u.y, dx, dy,
      speed: val(a, 'projectile_speed'), left: dist, width: val(a, 'knockback_radius') * 2,
      onHit(_p, e) {
        const v = e as Unit;
        if (v.team === u.team || knocked.has(v.id) || v.has(ST.magicImmune)) return false;
        knocked.add(v.id);
        const side = Math.sign((v.x - u.x) * -dy + (v.y - u.y) * dx) || 1;
        push(v, -dy * side, dx * side, val(a, 'knockback_distance'), val(a, 'knockback_duration'), u, a, 'wheel_knock');
        return false;
      },
      onEnd() { wheelTrap(a, tx, ty); },
    });
  },
});

function wheelTrap(a: AbilityInst, x: number, y: number) {
  const u = a.owner as Unit;
  const r = val(a, 'mesmerize_radius');
  const face = val(a, 'face_duration');
  const cone = Math.acos(Math.max(-1, Math.min(1, val(a, 'vision_cone'))));
  const looking = new Map<number, number>();
  let explodeAt = u.w.time + val(a, 'trap_duration');
  let triggered = false, done = false;
  u.w.addVision(u.team, x, y, val(a, 'vision_radius'), val(a, 'trap_duration') + 0.5);
  const tick = val(a, 'aura_tick_interval');
  let acc = 0;
  const z = u.w.addZone({
    fx: 'wheel_of_wonder', x, y, r, team: u.team, interval: 0.1, duration: val(a, 'trap_duration') + 0.2,
    onInterval() {
      if (done) return;
      acc += 0.1;
      const enemies = u.w.enemiesIn(u.team, x, y, r);
      if (acc >= tick) {
        acc -= tick;
        for (const e of enemies) {
          damage(u, e, dmg(a, 'aura_damage') * tick, 'magical', a, { noProc: true });
          debuff(u, e, a, { name: 'wheel_slow', duration: tick + 0.1, fx: 'slow', props: { msSlow: Math.abs(val(a, 'aura_slow')) / 100 } });
        }
      }
      // Los héroes que miran la rueda quedan hipnotizados y caminan hacia ella.
      for (const e of enemies) {
        if (e.kind !== 'hero' || e.findMod('wheel_mesmerize') || e.has(ST.magicImmune)) continue;
        let diff = Math.abs(Math.atan2(y - e.y, x - e.x) - e.facing) % (Math.PI * 2);
        if (diff > Math.PI) diff = Math.PI * 2 - diff;
        if (diff > cone) { looking.delete(e.id); continue; }
        const since = looking.get(e.id) ?? u.w.time;
        looking.set(e.id, since);
        if (u.w.time - since < face) continue;
        const m = debuff(u, e, a, {
          name: 'wheel_mesmerize', duration: val(a, 'trap_duration'), fx: 'mesmerize',
          states: ST.busy | ST.silenced | ST.disarmed | ST.muted,
          onTick(mm, dt) {
            const v = mm.owner as Unit;
            if (Math.hypot(v.x - x, v.y - y) > 60) v.w.moveToward(v, x, y, dt, 50);
          },
        });
        if (m) {
          if (e.cast) e.w.interruptCast(e, true);
          // El primer hipnotizado pone en marcha la cuenta atrás de la explosión.
          if (!triggered) { triggered = true; explodeAt = Math.min(explodeAt, u.w.time + face * 2); }
        }
      }
      if (u.w.time >= explodeAt) {
        done = true;
        z.until = u.w.time;
        u.w.emit({ n: 'wheel_explode', x, y, r, t: u.team });
        for (const e of u.w.enemiesIn(u.team, x, y, r)) {
          damage(u, e, dmg(a, 'explosion_damage'), 'magical', a);
          if (e.findMod('wheel_mesmerize', u)) { e.removeModsByName('wheel_mesmerize'); stun(u, e, val(a, 'wheel_stun'), a); }
        }
      }
    },
  });
}

defineHero('ringmaster', ['ringmaster_tame_the_beasts', 'ringmaster_the_box', 'ringmaster_impalement', 'ringmaster_empty_souvenir', 'ringmaster_spotlight', 'ringmaster_wheel', 'ringmaster_tame_the_beasts_crack',
  'ringmaster_dark_carnival_souvenirs', 'ringmaster_funhouse_mirror', 'ringmaster_strongman_tonic', 'ringmaster_whoopee_cushion', 'ringmaster_summon_unicycle'], {
  build: ['null_talisman', 'arcane_boots', 'glimmer_cape', 'force_staff', 'aether_lens', 'aghanims_shard', 'ultimate_scepter', 'octarine_core'],
});
