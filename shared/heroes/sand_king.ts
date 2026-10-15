import { defineAbility, defineHero, dmg, dur, hasScepter, hasShard, val } from '../sim/abilities';
import { damage, landAttack, makeAttack } from '../sim/combat';
import type { AbilityInst } from '../sim/types';
import { ST } from '../sim/types';
import type { Unit } from '../sim/unit';
import { abil, segDist } from './lib/a7';
import { castDir, dash, debuff, slow, stun } from './util';

// Hueco de Caustic Finale en el kit.
const CAUSTIC = 'sandking_caustic_finale';

/** Aplica el veneno de Caustic Finale: si la unidad muere con él, explota. */
function caustic(u: Unit, e: Unit) {
  const a = abil(u, CAUSTIC);
  if (!a || a.level <= 0 || e.team === u.team || e.kind === 'ward') return;
  debuff(u, e, a, {
    name: 'caustic_finale', duration: val(a, 'caustic_finale_duration'), fx: 'caustic',
    onDeath(m) {
      const v = m.owner as Unit;
      const r = val(a, 'caustic_finale_radius');
      const amount = val(a, 'caustic_finale_damage_flat') + v.s.maxHp * val(a, 'caustic_finale_damage_pct') / 100;
      v.w.emit({ n: 'caustic_explode', x: v.x, y: v.y, r, t: u.team });
      for (const x of u.w.enemiesIn(u.team, v.x, v.y, r)) if (x !== v) damage(u, x, amount * a.upg.dmg, 'magical', a);
    },
  });
}

defineAbility({
  key: 'sandking_burrowstrike', target: 'point', ai: { role: 'disable' },
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const [dx, dy] = castDir(u, t.x, t.y);
    const d = Math.min(Math.hypot(t.x - u.x, t.y - u.y), val(a, 'abilitycastrange') * a.upg.range + u.s.castRange);
    const sx = u.x, sy = u.y;
    const ex = u.x + dx * d, ey = u.y + dy * d;
    const hit = new Set<number>();
    const width = val(a, 'burrow_width');
    const strike = () => {
      for (const e of u.w.enemiesIn(u.team, u.x, u.y, width + 200)) {
        if (hit.has(e.id) || segDist(e.x, e.y, sx, sy, u.x, u.y) > width + e.radius) continue;
        hit.add(e.id);
        damage(u, e, dmg(a, 'abilitydamage'), 'magical', a);
        stun(u, e, dur(a, 'burrow_duration'), a);
        if (e.isHeroLike) caustic(u, e);
      }
    };
    u.w.disjoint(u);
    u.w.emit({ n: 'burrowstrike', x: sx, y: sy, x2: ex, y2: ey, u: u.id, t: u.team });
    dash(u, ex, ey, val(a, 'burrow_speed'), a, {
      name: 'burrowstrike', states: ST.invulnerable | ST.untargetable,
      onStep: strike, onArrive: strike,
    });
  },
});

defineAbility({
  key: 'sandking_sand_storm', target: 'none', ai: { role: 'aoe', selfRadius: 400 },
  aoe: (a) => val(a, 'sand_storm_radius'),
  onSpellStart(a) {
    const u = a.owner as Unit;
    const r = val(a, 'sand_storm_radius');
    const tick = val(a, 'damage_tick_rate');
    const cx = u.x, cy = u.y;
    const duration = dur(a, 'abilityduration');
    const zone = u.w.addZone({
      fx: 'sand_storm', x: cx, y: cy, r, team: u.team, interval: tick, duration,
      onInterval(z) {
        for (const e of u.w.enemiesIn(u.team, z.x, z.y, z.r)) {
          damage(u, e, dmg(a, 'sand_storm_damage') * tick, 'magical', a, { noProc: true });
          // Talento: ralentiza y ciega.
          const blind = val(a, 'blind_pct');
          if (blind > 0) debuff(u, e, a, {
            name: 'sand_storm_blind', duration: 0.5, fx: 'slow',
            props: { msSlow: val(a, 'sand_storm_slow') / 100 },
            // Ceguera aproximada: el ataque fallado no hace daño.
            onAttackStart(_m, ev) { if (u.w.rng() < blind / 100) { ev.damage = 0; ev.critMult = 1; } },
          });
        }
      },
    });
    // Invisible mientras siga dentro (tras el retardo de desvanecimiento).
    u.addMod({
      name: 'sand_storm', duration, fx: 'sand_storm',
      onTick(m) {
        const inside = Math.hypot(u.x - cx, u.y - cy) <= r;
        if (!inside) { zone.until = u.w.time; u.removeMod(m); return; }
        const elapsed = m.duration - m.remaining;
        if (elapsed >= val(a, 'fade_delay') && !u.findMod('sand_storm_invis', u)) {
          u.addMod({ name: 'sand_storm_invis', duration: Infinity, states: ST.invisible }, u, a);
        }
      },
      onDestroy() { u.removeModsByName('sand_storm_invis'); },
    }, u, a);
  },
});

defineAbility({
  key: 'sandking_scorpion_strike', target: 'point', ai: { role: 'nuke' },
  aoe: (a) => val(a, 'radius'),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    strikeArea(u, a, t.x, t.y, val(a, 'radius'), 1);
  },
});

/** Ataque de aguijón sobre un área (Scorpion Strike y las púas del Scepter). */
function strikeArea(u: Unit, a: AbilityInst, x: number, y: number, r: number, mult: number) {
  u.w.emit({ n: 'scorpion_strike', x, y, r, t: u.team });
  for (const e of u.w.enemiesIn(u.team, x, y, r)) {
    const ev = makeAttack(u, e, true);
    ev.trueStrike = true;
    let bonus = dmg(a, 'attack_damage');
    if (Math.hypot(e.x - x, e.y - y) <= val(a, 'inner_radius')) {
      ev.damage *= 1 + val(a, 'inner_radius_bonus_damage_pct') / 100;
      bonus *= 1 + val(a, 'inner_radius_bonus_damage_pct') / 100;
    }
    ev.damage = (ev.damage + bonus) * mult;
    landAttack(ev);
    caustic(u, e);
    slow(u, e, a, 'scorpion_strike', val(a, 'debuff_duration'), val(a, 'strike_slow') / 100);
  }
}

defineAbility({ key: 'sandking_caustic_finale', target: 'passive', innate: true,
  passive: (a) => ({
    name: 'caustic_finale_passive',
    onAttackLanded(_m, ev) {
      const u = ev.attacker as Unit;
      if (u.kind === 'illusion' || a.level <= 0) return;
      caustic(u, ev.target as Unit);
    },
  }),
});

/** Un pulso de Epicenter en (x,y) con radio r. */
function pulse(u: Unit, a: AbilityInst, x: number, y: number, r: number) {
  u.w.emit({ n: 'epicenter', x, y, r, t: u.team });
  for (const e of u.w.enemiesIn(u.team, x, y, r)) {
    damage(u, e, dmg(a, 'epicenter_damage'), 'magical', a);
    debuff(u, e, a, {
      name: 'epicenter_slow', duration: val(a, 'linger_duration'), fx: 'slow',
      props: { msSlow: Math.abs(val(a, 'epicenter_slow')) / 100, attackSlow: Math.abs(val(a, 'epicenter_slow_as')) },
    });
  }
}

defineAbility({
  key: 'sandking_epicenter', target: 'none', ult: true, ai: { role: 'aoe', selfRadius: 450 },
  aoe: (a) => val(a, 'epicenter_radius_base'),
  // Shard: cada pocos segundos un pulso pequeño alrededor de Sand King.
  passive: (a) => (hasShard(a.owner as Unit) ? {
    name: 'epicenter_shard', interval: val(a, 'shard_interval'),
    onInterval(m) {
      const u = m.owner as Unit;
      if (u.kind === 'illusion' || !u.alive) return;
      pulse(u, a, u.x, u.y, val(a, 'shard_radius'));
    },
  } : null),
  onSpellStart(a) {
    const u = a.owner as Unit;
    const pulses = val(a, 'epicenter_pulses');
    const duration = val(a, 'abilityduration');
    const every = duration / Math.max(1, pulses);
    const sk = u.abilities.find((x) => x.key === 'sandking_scorpion_strike');
    let n = 0;
    u.addMod({
      name: 'epicenter', duration: duration + 0.05, fx: 'epicenter', interval: every,
      onInterval(m) {
        if (n >= pulses) return;
        const r = val(a, 'epicenter_radius_base') + val(a, 'epicenter_radius_increment') * n;
        n++;
        pulse(u, a, u.x, u.y, r);
        // Scepter: púas de Stinger en puntos aleatorios del radio.
        if (hasScepter(u) && sk && sk.level > 0) {
          m.data.spine = (m.data.spine ?? 0) + every;
          if (m.data.spine >= val(a, 'spine_tick_rate')) {
            m.data.spine = 0;
            const sr = r * val(a, 'scepter_explosion_radius_pct') / 100;
            for (let i = 0; i < val(a, 'scepter_explosions_per_pulse'); i++) {
              const ang = u.w.rng() * Math.PI * 2;
              const d = val(a, 'scepter_explosion_min_dist') + u.w.rng() * Math.max(0, r - val(a, 'scepter_explosion_min_dist'));
              strikeArea(u, sk, u.x + Math.cos(ang) * d, u.y + Math.sin(ang) * d, sr, val(a, 'spine_damage_pct') / 100);
            }
          }
        }
      },
    }, u, a);
  },
});

defineHero('sand_king', ['sandking_burrowstrike', 'sandking_sand_storm', 'sandking_scorpion_strike', 'sandking_caustic_finale', 'sandking_epicenter'], {
  build: ['bracer', 'arcane_boots', 'blink', 'black_king_bar', 'shivas_guard', 'ultimate_scepter', 'octarine_core'],
});
