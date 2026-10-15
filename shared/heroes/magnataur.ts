import { castRangeOf, defineAbility, defineHero, dmg, dur, val } from '../sim/abilities';
import { damage } from '../sim/combat';
import { ROCK, TREE } from '../sim/nav';
import type { AbilityInst, ModSpec } from '../sim/types';
import { ST } from '../sim/types';
import { armorMult, type Unit } from '../sim/unit';
import { botBrain, inCone, inTrapezoid } from './lib/a4';
import { canDebuff, castDir, debuff, push, slow, stun } from './util';

defineAbility({
  key: 'magnataur_shockwave', target: 'unitOrPoint', ai: { role: 'nuke' },
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const tx = t.unit ? t.unit.x : t.x, ty = t.unit ? t.unit.y : t.y;
    const [dx, dy] = castDir(u, tx, ty);
    const range = castRangeOf(a) + val(a, 'return_shockwave_bonus_distance');
    const hitOne = (e: Unit, pct: number, toward: boolean) => {
      if (e.team === u.team || e.kind === 'ward' || !canDebuff(u, e, a)) return;
      damage(u, e, dmg(a, 'shock_damage') * pct, 'magical', a);
      if (toward) push(e, u.x - e.x, u.y - e.y, Math.max(0, Math.min(val(a, 'pull_distance'), Math.hypot(u.x - e.x, u.y - e.y) - 100)),
        val(a, 'pull_duration'), u, a, 'shockwave_pull');
      const time = e.isHeroLike ? val(a, 'basic_slow_duration') : val(a, 'slow_duration');
      slow(u, e, a, 'shockwave_slow', time, val(a, 'movement_slow') / 100);
    };
    u.w.addProjectile({
      kind: 'linear', fx: 'shockwave', source: u, x: u.x, y: u.y, dx, dy,
      speed: val(a, 'shock_speed'), left: range, width: val(a, 'shock_width'),
      onHit(_p, e) { hitOne(e as Unit, 1, true); return false; },
      // Talento: la onda vuelve hacia Magnus.
      onEnd(p) {
        const back = val(a, 'return_damage_pct') / 100;
        if (back <= 0 || !u.alive) return;
        const bx = u.x - p.x, by = u.y - p.y;
        const d = Math.hypot(bx, by) || 1;
        u.w.addProjectile({
          kind: 'linear', fx: 'shockwave', source: u, x: p.x, y: p.y, dx: bx / d, dy: by / d,
          speed: val(a, 'shock_speed'), left: d, width: val(a, 'shock_width'),
          onHit(_q, e) { hitOne(e as Unit, back, false); return false; },
        });
      },
    });
  },
});

/** Modificador de Empower: daño base y barrido para cuerpo a cuerpo. */
function empowerSpec(a: AbilityInst, mult: number, duration: number): ModSpec {
  return {
    name: 'empower', duration, fx: duration === Infinity ? undefined : 'empower',
    props: { damagePct: val(a, 'bonus_damage_pct') / 100 * mult },
    onAttackLanded(_m, ev) {
      const at = ev.attacker as Unit, t = ev.target as Unit;
      if (!at.melee || ev.missed || t.team === at.team) return;
      const sw = val(a, 'cleave_starting_width'), ew = val(a, 'cleave_ending_width'), dist = val(a, 'cleave_distance');
      const amount = ev.damage * ev.critMult * val(a, 'cleave_damage_pct') / 100 * mult * armorMult(t.s.armor);
      const [dx, dy] = [t.x - at.x, t.y - at.y];
      for (const e of at.w.enemiesIn(at.team, at.x, at.y, dist + 50)) {
        if (e === t || e.kind === 'ward' || !inTrapezoid(at.x, at.y, dx, dy, e.x, e.y, sw, ew, dist)) continue;
        damage(at, e, amount, 'pure', null, { noProc: true, data: { cleave: true } });
      }
    },
  };
}

defineAbility({
  key: 'magnataur_empower', target: 'unit', team: 'ally', allowSelf: true,
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const al = t.unit as Unit;
    // Siempre activo en Magnus: lanzarlo sobre sí mismo no cambia nada.
    if (!al || al === u) return;
    al.addMod(empowerSpec(a, 1, dur(a, 'empower_duration')), u, a);
  },
  // Siempre activo en Magnus (+30%); el bot lo pone en aliados que no lo tengan.
  passive: (a) => {
    const self = empowerSpec(a, 1 + val(a, 'self_multiplier') / 100, Infinity);
    const brain = botBrain(a, (u) => {
      const range = val(a, 'abilitycastrange') + u.s.castRange;
      const al = u.w.alliesIn(u.team, u.x, u.y, range, { heroes: true })
        .find((x) => x !== u && x.kind === 'hero' && (x.findMod('empower')?.remaining ?? 0) < 3);
      return al ? { target: al } : null;
    });
    return { ...self, name: 'empower_self', onTick: brain.onTick };
  },
});

defineAbility({
  key: 'magnataur_skewer', target: 'point', castBeyond: true, ai: { role: 'escape' },
  castRange: (a) => val(a, 'range'),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    if (u.has(ST.rooted)) return;
    const [dx, dy] = castDir(u, t.x, t.y);
    const dist = Math.min(val(a, 'range') + u.s.castRange, Math.hypot(t.x - u.x, t.y - u.y) || val(a, 'range'));
    const sx = u.x, sy = u.y;
    const dragged = new Map<number, Unit>();
    const lastHit = new Map<number, number>();
    const g = u.w.grid;
    const r = val(a, 'skewer_radius');
    rush(u, sx + dx * dist, sy + dy * dist);
    function rush(m: Unit, tx: number, ty: number) {
      m.addMod({
        name: 'skewer', duration: dist / val(a, 'skewer_speed') + 0.05, states: ST.busy | ST.noCollision, fx: 'skewer',
        onTick(mm, dt) {
          const d = Math.hypot(tx - u.x, ty - u.y);
          const step = val(a, 'skewer_speed') * dt;
          const fin = d <= step;
          u.facing = Math.atan2(dy, dx);
          u.w.forceMove(u, fin ? tx : u.x + dx * step, fin ? ty : u.y + dy * step);
          // Engancha a los héroes enemigos del camino.
          for (const e of u.w.enemiesIn(u.team, u.x, u.y, r, { heroes: true })) {
            if (dragged.has(e.id) || !canDebuff(u, e, a)) continue;
            const md = debuff(u, e, a, { name: 'skewered', duration: 5, states: ST.stunned, fx: 'skewered', purgable: false });
            if (!md) continue;
            if (e.cast) e.w.interruptCast(e, true);
            dragged.set(e.id, e);
          }
          for (const e of dragged.values()) {
            if (!e.alive) continue;
            const px = u.x + dx * (u.radius + e.radius), py = u.y + dy * (u.radius + e.radius);
            // Shard: choque contra árboles o acantilados.
            const ahead = g.cellAt(g.cx(px + dx * 40), g.cy(py + dy * 40));
            const hitDmg = ahead === TREE ? val(a, 'tree_hit_damage') : ahead === ROCK ? val(a, 'cliff_hit_damage') : 0;
            if (hitDmg > 0 && u.w.time - (lastHit.get(e.id) ?? -9) >= val(a, 'terrain_hit_cooldown')) {
              lastHit.set(e.id, u.w.time);
              damage(u, e, hitDmg, 'magical', a);
              u.w.emit({ n: 'skewer_impact', x: px, y: py, u: e.id });
            }
            e.w.forceMove(e, px, py);
          }
          u.w.cutTrees(u.x, u.y, val(a, 'tree_radius'));
          if (fin) mm.remaining = 0.001;
        },
        onDestroy() {
          const travelled = Math.hypot(u.x - sx, u.y - sy);
          const total = dmg(a, 'skewer_damage') + travelled * val(a, 'damage_distance_pct') / 100;
          for (const e of dragged.values()) {
            e.removeModsByName('skewered');
            if (!e.alive) continue;
            damage(u, e, total, 'magical', a);
            slow(u, e, a, 'skewer_slow', dur(a, 'slow_duration'), val(a, 'slow_pct') / 100);
          }
        },
      }, u, a);
    }
  },
});

defineAbility({
  key: 'magnataur_horn_toss', target: 'none', ai: { role: 'disable', selfRadius: 250 },
  aoe: (a) => val(a, 'radius'),
  onSpellStart(a) {
    const u = a.owner as Unit;
    const fx = Math.cos(u.facing), fy = Math.sin(u.facing);
    const air = val(a, 'air_duration');
    // Destino: detrás de Magnus.
    const bx = u.x - fx * val(a, 'destination_offset'), by = u.y - fy * val(a, 'destination_offset');
    u.w.emit({ n: 'horn_toss', x: u.x, y: u.y, r: val(a, 'radius'), u: u.id, t: u.team });
    for (const e of u.w.enemiesIn(u.team, u.x, u.y, val(a, 'radius'))) {
      if (e.kind === 'ward' || !canDebuff(u, e, a) || !inCone(u.x, u.y, fx, fy, e.x, e.y, val(a, 'radius') + e.radius, 90)) continue;
      if (e.cast) e.w.interruptCast(e, true);
      const ox = e.x, oy = e.y;
      debuff(u, e, a, {
        name: 'horn_toss', duration: air, states: ST.stunned | ST.flying | ST.noCollision, fx: 'tossed', data: { t: 0 },
        onTick(m, dt) {
          m.data.t = Math.min(air, m.data.t + dt);
          const k = m.data.t / air;
          e.w.forceMove(e, ox + (bx - ox) * k, oy + (by - oy) * k);
        },
        onDestroy() {
          if (!e.alive) return;
          damage(u, e, dmg(a, 'damage'), 'magical', a);
          stun(u, e, dur(a, 'stun_duration'), a);
          // Ralentizado que se desvanece.
          const sd = val(a, 'slow_duration');
          debuff(u, e, a, {
            name: 'horn_toss_slow', duration: sd, fx: 'slow',
            props: (m2) => ({ msSlow: val(a, 'horn_toss_slow_pct') / 100 * Math.max(0, m2.remaining / sd) }),
            onTick(m2) { (m2.owner as Unit).refreshStats(); },
          });
        },
      });
    }
  },
});

defineAbility({
  key: 'magnataur_solid_core', target: 'passive', innate: true,
  passive: (a) => ({ name: 'solid_core', props: { slowResist: val(a, 'slow_resistance') / 100 } }),
});

defineAbility({
  key: 'magnataur_reverse_polarity', target: 'none', ult: true, ai: { role: 'disable', selfRadius: 300 },
  aoe: (a) => val(a, 'pull_radius'),
  onSpellStart(a) {
    const u = a.owner as Unit;
    const fx = Math.cos(u.facing), fy = Math.sin(u.facing);
    const r = val(a, 'pull_radius');
    u.w.emit({ n: 'reverse_polarity', x: u.x, y: u.y, r, u: u.id, t: u.team });
    let heroes = 0;
    for (const e of u.w.enemiesIn(u.team, u.x, u.y, r)) {
      if (e.kind === 'ward' || !canDebuff(u, e, a)) continue;
      // Todos acaban delante de Magnus.
      const side = (u.w.rng() - 0.5) * 80;
      u.w.teleport(e, u.x + fx * (u.radius + e.radius + 40) - fy * side, u.y + fy * (u.radius + e.radius + 40) + fx * side);
      if (!e.has(ST.magicImmune)) damage(u, e, dmg(a, 'polarity_damage'), 'magical', a);
      stun(u, e, dur(a, 'hero_stun_duration'), a);
      if (e.kind === 'hero') heroes++;
    }
    // Talento: atributos por héroe alcanzado.
    const sd = val(a, 'stat_buff_duration');
    for (let i = 0; i < heroes && sd > 0; i++) {
      u.addMod({ name: 'reverse_polarity_stats', duration: sd, data: { multi: true }, props: { allStats: val(a, 'stats_per_stack') } }, u, a);
    }
  },
});

defineHero('magnataur', [
  'magnataur_shockwave', 'magnataur_empower', 'magnataur_skewer', 'magnataur_horn_toss', 'magnataur_solid_core',
  'magnataur_reverse_polarity',
], {
  build: ['bracer', 'phase_boots', 'blink', 'black_king_bar', 'ultimate_scepter', 'assault', 'refresher'],
});
