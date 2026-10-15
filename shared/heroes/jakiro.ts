import { castRangeOf, cooldownOf, defineAbility, defineHero, dmg, dur, manaCostOf, val } from '../sim/abilities';
import { creditHero, damage, landAttack, makeAttack } from '../sim/combat';
import type { AbilityInst, AttackEvent } from '../sim/types';
import { ST } from '../sim/types';
import type { Unit } from '../sim/unit';
import type { World } from '../sim/world';
import { castDir, debuff, dot, slow, stun } from './util';
import { distToSegment } from './lib/a3';

/** Llama a `fn` cada `step` segundos durante `duration` (también en el instante 0). */
function every(w: World, duration: number, step: number, fn: (t: number) => void) {
  let t = 0;
  const run = () => { fn(t); t += step; if (t < duration - 1e-6) w.after(step, run); };
  run();
}

/** Círculos de zona a lo largo de una línea, solo para que el cliente la dibuje. */
function lineZones(w: World, fx: string, team: number, x0: number, y0: number, x1: number, y1: number, r: number, duration: number) {
  const len = Math.hypot(x1 - x0, y1 - y0);
  const n = Math.max(1, Math.ceil(len / (r * 1.4)));
  for (let i = 0; i <= n; i++) {
    const k = i / n;
    w.addZone({ fx, x: x0 + (x1 - x0) * k, y: y0 + (y1 - y0) * k, r, team, interval: 99, duration, onInterval() {} });
  }
}

/** Ralentización de velocidad de ataque en % (el motor la quiere en puntos). */
const asPct = (t: Unit, pct: number) => t.s.as * Math.abs(pct) / 100;

const sibling = (a: AbilityInst, key: string) => (a.owner as Unit).abilities.find((x) => x.key === key);

defineAbility({
  key: 'jakiro_dual_breath', target: 'unitOrPoint', ai: { role: 'nuke' },
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const [dx, dy] = castDir(u, t.x, t.y);
    const range = castRangeOf(a);
    const dur5 = dur(a, 'abilityduration');
    const proj = (fx: string, speed: number, onHit: (e: Unit) => void) => u.w.addProjectile({
      kind: 'linear', fx, source: u, x: u.x, y: u.y, dx, dy, speed, left: range,
      width: val(a, 'start_radius') * 2, widthEnd: val(a, 'end_radius') * 2,
      onHit(_p, e) { if (e.team !== u.team && e.kind !== 'ward') onHit(e as Unit); },
    });
    // Primero el hielo (ralentiza), luego el fuego (quemadura).
    proj('dual_breath_ice', val(a, 'speed'), (e) => {
      slow(u, e, a, 'dual_breath_slow', dur5, Math.abs(val(a, 'slow_movement_speed_pct')) / 100, asPct(e, val(a, 'slow_attack_speed_pct')));
    });
    const sx = u.x, sy = u.y;
    u.w.after(val(a, 'fire_delay'), () => {
      const p = proj('dragon_slave', val(a, 'speed_fire'), (e) => {
        dot(u, e, a, 'dual_breath_burn', dur5, dmg(a, 'burn_damage'), 'magical', 0.5, { fx: 'fiery_soul' });
      });
      p.x = sx; p.y = sy;
    });
  },
});

defineAbility({
  key: 'jakiro_ice_path', target: 'point', ai: { role: 'disable' },
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const [dx, dy] = castDir(u, t.x, t.y);
    const len = castRangeOf(a);
    const x0 = u.x, y0 = u.y, x1 = u.x + dx * len, y1 = u.y + dy * len;
    const r = val(a, 'path_radius');
    const life = dur(a, 'path_duration');
    const hit = new Set<number>();
    u.w.after(val(a, 'path_delay'), () => {
      lineZones(u.w, 'ice_path', u.team, x0, y0, x1, y1, r, life);
      every(u.w, life, 0.1, () => {
        for (const e of u.w.enemiesIn(u.team, (x0 + x1) / 2, (y0 + y1) / 2, len / 2 + r)) {
          if (hit.has(e.id) || distToSegment(e.x, e.y, x0, y0, x1, y1) > r + e.radius) continue;
          hit.add(e.id);
          damage(u, e, dmg(a, 'damage'), 'magical', a);
          stun(u, e, dur(a, 'stun_duration'), a);
        }
      });
    });
  },
});

/** Pone en enfriamiento la habilidad y, si lo comparten, también la otra. */
function spendOrb(a: AbilityInst, other: string) {
  const u = a.owner as Unit;
  u.mana -= manaCostOf(a);
  const cd = cooldownOf(a);
  a.cd = cd;
  if (val(a, 'shares_cooldown') > 0) {
    const o = sibling(a, other);
    if (o) o.cd = Math.max(o.cd, cd);
  }
}

function orbReady(a: AbilityInst, ev: AttackEvent) {
  const u = a.owner as Unit, t = ev.target as Unit;
  return a.toggled && !ev.fake && a.cd <= 0 && u.mana >= manaCostOf(a) && t.team !== u.team &&
    (t.isHeroLike || t.kind === 'creep' || t.kind === 'summon') && !u.has(ST.silenced);
}

defineAbility({
  key: 'jakiro_liquid_fire', target: 'toggle',
  aoe: (a) => val(a, 'radius'),
  passive: (a) => ({
    name: 'liquid_fire_orb', interval: 0.3,
    onInterval(m) { if ((m.owner as Unit).isBot && !a.toggled) a.toggled = true; },
    onAttackStart(_m, ev) {
      if (!orbReady(a, ev) || (val(a, 'shares_cooldown') > 0 && (ev as any).liquidFrost)) return;
      (ev as any).liquidFire = true;
      spendOrb(a, 'jakiro_liquid_ice');
    },
    onAttackLanded(m, ev) {
      if (!(ev as any).liquidFire) return;
      const u = m.owner as Unit, t = ev.target as Unit;
      const tick = val(a, 'tick_rate');
      u.w.emit({ n: 'lsa', x: t.x, y: t.y, r: val(a, 'radius'), t: u.team });
      for (const e of u.w.enemiesIn(u.team, t.x, t.y, val(a, 'radius'))) {
        debuff(u, e, a, {
          name: 'liquid_fire', duration: dur(a, 'abilityduration'), interval: tick, fx: 'fiery_soul',
          props: { attackSlow: asPct(e, val(a, 'slow_attack_speed_pct')) },
          onInterval(mm) {
            const v = mm.owner as Unit;
            const dps = dmg(a, 'damage') + v.s.maxHp * val(a, 'pct_health_damage') / 100;
            damage(u, v, dps * tick, 'magical', a, { noProc: true });
          },
        });
      }
    },
  }),
});

// Liquid Frost: ralentiza, quema y hace que cada golpe o hechizo (no DoT) de Jakiro haga daño extra.
defineAbility({
  key: 'jakiro_liquid_ice', target: 'toggle',
  passive: (a) => ({
    name: 'liquid_frost_orb', interval: 0.3,
    onInterval(m) { if ((m.owner as Unit).isBot && !a.toggled) a.toggled = true; },
    onAttackStart(_m, ev) {
      if (!orbReady(a, ev) || (val(a, 'shares_cooldown') > 0 && (ev as any).liquidFire)) return;
      (ev as any).liquidFrost = true;
      spendOrb(a, 'jakiro_liquid_fire');
    },
    onAttackLanded(m, ev) {
      if (!(ev as any).liquidFrost) return;
      const u = m.owner as Unit, t = ev.target as Unit;
      const tick = val(a, 'tick_rate');
      debuff(u, t, a, {
        name: 'liquid_frost', duration: dur(a, 'duration'), interval: tick, fx: 'frostbite',
        props: { msSlow: val(a, 'movement_slow') / 100 },
        onInterval(mm) {
          const v = mm.owner as Unit;
          const dps = dmg(a, 'damage') + v.s.maxHp * val(a, 'pct_health_damage') / 100;
          damage(u, v, dps * tick, 'magical', a, { noProc: true });
        },
        onTakeDamage(mm, de) {
          if (de.ability === a || de.noProc || de.data?.frostBonus || creditHero(de.source as Unit) !== creditHero(u)) return;
          damage(u, mm.owner as Unit, val(a, 'bonus_instance_damage_from_other_abilities'), 'magical', a,
            { noProc: true, data: { frostBonus: true } });
        },
      });
    },
  }),
});

// Cada ataque sale de las dos cabezas: el segundo, falso y con retardo; ambos con menos daño.
defineAbility({
  key: 'jakiro_double_trouble', target: 'passive', innate: true,
  passive: (a) => ({
    name: 'double_trouble',
    onAttackStart(m, ev) {
      ev.damage *= 1 - val(a, 'attack_damage_reduction') / 100;
      if (ev.fake) return;
      const u = m.owner as Unit, t = ev.target as Unit;
      u.w.after(val(a, 'second_attack_delay'), () => {
        if (!u.alive || !u.w.targetable(t) || u.has(ST.disarmed) || u.has(ST.stunned) || u.has(ST.hexed)) return;
        if (Math.hypot(t.x - u.x, t.y - u.y) > u.s.attackRange + 400) return;
        const ev2 = makeAttack(u, t, true);
        u.w.addProjectile({
          kind: 'track', fx: 'attack:' + (u.hero?.key ?? u.name), source: u, target: t,
          x: u.x, y: u.y, speed: u.base.projSpeed, dodgeable: true,
          onHit: () => { landAttack(ev2); return true; },
        });
      });
    },
  }),
});

defineAbility({
  key: 'jakiro_macropyre', target: 'point', ult: true, ai: { role: 'aoe' },
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const [dx, dy] = castDir(u, t.x, t.y);
    const len = castRangeOf(a);
    const x0 = u.x, y0 = u.y, x1 = u.x + dx * len, y1 = u.y + dy * len;
    const half = val(a, 'path_width') / 2;
    const life = dur(a, 'duration');
    const tick = val(a, 'burn_interval');
    const pure = val(a, 'pure_damage_type') > 0;
    const pierce = val(a, 'pierces_magic_immunity') > 0;
    const edgeR = val(a, 'ice_edge_path_radius');
    const off = half + val(a, 'ice_edge_path_offset');
    // Muros de hielo del Scepter a los dos lados del camino.
    const nx = -dy, ny = dx;
    const edges = edgeR > 0 ? [1, -1].map((s) => [x0 + nx * off * s, y0 + ny * off * s, x1 + nx * off * s, y1 + ny * off * s]) : [];
    lineZones(u.w, 'macropyre', u.team, x0, y0, x1, y1, half, life);
    every(u.w, life, tick, () => {
      for (const e of u.w.enemiesIn(u.team, (x0 + x1) / 2, (y0 + y1) / 2, len / 2 + off + edgeR)) {
        for (const [ax, ay, bx, by] of edges) {
          if (distToSegment(e.x, e.y, ax, ay, bx, by) <= edgeR + e.radius) {
            slow(u, e, a, 'macropyre_ice_edge', val(a, 'ice_edge_linger_duration') + tick, val(a, 'ice_edge_movement_slow') / 100);
          }
        }
        if (distToSegment(e.x, e.y, x0, y0, x1, y1) > half + e.radius) continue;
        const spec = {
          name: 'macropyre_burn', duration: val(a, 'linger_duration'), interval: tick, fx: 'fiery_soul', debuff: true,
          onInterval(mm: any) { damage(u, mm.owner as Unit, dmg(a, 'damage') * tick, pure ? 'pure' : 'magical', a, { noProc: true }); },
        };
        // Se renueva mientras sigue dentro; al salir quema `linger_duration` más.
        if (pierce) e.addMod(spec, u, a);
        else debuff(u, e, a, spec);
      }
    });
  },
});

defineHero('jakiro', ['jakiro_dual_breath', 'jakiro_ice_path', 'jakiro_liquid_fire', 'jakiro_liquid_ice', 'jakiro_double_trouble', 'jakiro_macropyre'], {
  build: ['null_talisman', 'arcane_boots', 'force_staff', 'glimmer_cape', 'aether_lens', 'black_king_bar', 'ultimate_scepter', 'octarine_core'],
});
