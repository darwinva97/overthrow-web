import { defineAbility, defineHero, dmg, dur, hasScepter, val } from '../sim/abilities';
import { damage } from '../sim/combat';
import type { AbilityInst } from '../sim/types';
import type { Unit } from '../sim/unit';
import { abilityOf, attackDamage, realHero } from './lib/a0';
import { nearestEnemy, stun } from './util';

/** Rayo de Lucent Beam (el de Eclipse no aturde). */
function beam(a: AbilityInst, e: Unit, stuns: boolean) {
  const u = a.owner as Unit;
  u.w.emit({ n: 'lightning', x: e.x, y: e.y - 400, x2: e.x, y2: e.y, u: e.id, c: 'luna' });
  damage(u, e, dmg(a, 'beam_damage'), 'magical', a);
  if (stuns && e.alive) stun(u, e, dur(a, 'stun_duration'), a);
}

defineAbility({
  key: 'luna_lucent_beam', target: 'unit', reflectable: true, ai: { role: 'nuke' },
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const e = t.unit as Unit;
    beam(a, e, true);
    // Talento: el rayo alcanza a otro enemigo cercano.
    const r = val(a, 'lucent_beam_bounce_range');
    if (r > 0 && !a.temp) {
      const next = nearestEnemy(u, e.x, e.y, r, new Set([e.id]), true);
      if (next) beam(a, next, true);
    }
  },
});

defineAbility({
  key: 'luna_lunar_orbit', target: 'none', ai: { role: 'buff', selfRadius: 450 },
  onSpellStart(a) {
    const u = a.owner as Unit;
    const n = val(a, 'rotating_glaives');
    const radius = val(a, 'rotating_glaives_movement_radius');
    const hitR = val(a, 'rotating_glaives_hit_radius') / 2;
    // Velocidad angular (grados por segundo) y una vuelta por glaive entre golpes a la misma unidad.
    const speed = val(a, 'rotating_glaives_speed') * Math.PI / 180;
    const rehit = (Math.PI * 2 / speed) / Math.max(1, n);
    u.addMod({
      name: 'lunar_orbit', duration: dur(a, 'rotating_glaives_duration'), fx: 'lunar_orbit',
      data: { ang: 0, last: {} as Record<number, number> },
      props: { incomingPct: -val(a, 'rotating_glaives_damage_reduction') / 100, msPct: val(a, 'bonus_movement_speed') / 100 },
      onTick(m, dt) {
        m.data.ang += speed * dt;
        for (let i = 0; i < n; i++) {
          const ang = m.data.ang + i * Math.PI * 2 / n;
          const gx = u.x + Math.cos(ang) * radius, gy = u.y + Math.sin(ang) * radius;
          for (const e of u.w.enemiesIn(u.team, gx, gy, hitR)) {
            if (e.kind === 'ward' || u.w.time - (m.data.last[e.id] ?? -99) < rehit) continue;
            m.data.last[e.id] = u.w.time;
            damage(u, e, attackDamage(u) * val(a, 'rotating_glaives_collision_damage') / 100, 'physical', a);
          }
        }
      },
    }, u, a);
  },
});

defineAbility({
  key: 'luna_moon_glaive', target: 'passive',
  passive: (a) => ({
    name: 'moon_glaive',
    onAttackLanded(_m, ev) {
      const u = ev.attacker as Unit;
      if (u.melee || ev.fake || ev.target.team === u.team) return;
      const hit = new Set<number>([ev.target.id]);
      const red = 1 - val(a, 'damage_reduction_percent') / 100;
      let left = val(a, 'bounces');
      let from = ev.target as Unit;
      let amount = ev.damage * ev.critMult;
      const bounce = () => {
        if (left <= 0 || !u.alive) return;
        const next = nearestEnemy(u, from.x, from.y, val(a, 'range'), hit);
        if (!next) return;
        hit.add(next.id);
        left--;
        amount *= red;
        const amt = amount;
        u.w.addProjectile({
          kind: 'track', fx: 'attack:luna', source: u, target: next, x: from.x, y: from.y,
          speed: u.base.projSpeed || 900, dodgeable: true,
          onHit() {
            damage(u, next, amt, 'physical', null, { isAttack: true });
            from = next;
            bounce();
            return true;
          },
        });
      };
      bounce();
    },
  }),
});

// Innata: daño de ataque por nivel de Luna para ella (doble) y sus aliados; global de noche.
defineAbility({
  key: 'luna_lunar_blessing', target: 'passive', innate: true, noIllusion: true,
  passive: (a) => {
    const night = (u: Unit) => u.w.isNight() || u.w.time < (a.data.eclipseUntil ?? 0);
    const allyDmg = (u: Unit) => realHero(u).level + val(a, 'bonus_damage');
    return {
      name: 'lunar_blessing', interval: 1, data: { night: false },
      props: (m) => ({ vision: m.data.night ? val(a, 'bonus_night_vision') : 0 }),
      onInterval(m) {
        const u = m.owner as Unit;
        if (night(u) !== m.data.night) { m.data.night = night(u); u.refreshStats(); }
      },
      aura: {
        radius: val(a, 'radius'), team: 'ally', heroesOnly: true,
        global: false,
        apply(m, t) {
          const u = m.owner as Unit;
          const self = t === u;
          const bonus = self ? 2 * realHero(u).level + val(a, 'self_bonus_damage') : allyDmg(u);
          return { name: 'lunar_blessing_buff', props: { damage: bonus } };
        },
      },
      onTick(m) {
        // De noche el aura es global.
        if (m.aura) m.aura.global = !!m.data.night;
      },
    };
  },
});

defineAbility({
  key: 'luna_eclipse', target: 'none', ult: true, ai: { role: 'aoe', selfRadius: 550 },
  onSpellStart(a) {
    const u = a.owner as Unit;
    const lb = abilityOf(u, 'luna_lucent_beam');
    const bless = abilityOf(u, 'luna_lunar_blessing');
    if (bless) bless.data.eclipseUntil = u.w.time + val(a, 'night_duration');
    const beams = val(a, 'beams');
    const every = hasScepter(u) ? val(a, 'beam_interval_scepter') : val(a, 'beam_interval');
    const maxHits = val(a, 'hit_count');
    const r = val(a, 'radius');
    const hits: Record<number, number> = {};
    u.w.emit({ n: 'nova', x: u.x, y: u.y, r, t: u.team });
    let n = 0;
    const strike = () => {
      if (!u.alive || n >= beams) return;
      n++;
      const pool = u.w.enemiesIn(u.team, u.x, u.y, r).filter((e) => e.kind !== 'ward' && (hits[e.id] ?? 0) < maxHits && u.w.canSee(u.team, e));
      if (pool.length && lb && lb.level > 0) {
        const e = pool[Math.floor(u.w.rng() * pool.length)];
        hits[e.id] = (hits[e.id] ?? 0) + 1;
        beam(lb, e, false);
      }
      u.w.after(every, strike);
    };
    strike();
  },
});

defineHero('luna', ['luna_lucent_beam', 'luna_lunar_orbit', 'luna_moon_glaive', 'luna_lunar_blessing', 'luna_eclipse'], {
  build: ['wraith_band', 'power_treads', 'mask_of_madness', 'manta', 'black_king_bar', 'butterfly', 'satanic', 'skadi'],
});
