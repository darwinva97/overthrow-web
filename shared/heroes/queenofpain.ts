import { castRangeOf, defineAbility, defineHero, dmg, dur, hasShard, val } from '../sim/abilities';
import { damage } from '../sim/combat';
import type { AbilityInst } from '../sim/types';
import { ST } from '../sim/types';
import type { Unit } from '../sim/unit';
import { castDir, debuff, push, silence } from './util';
import { abil } from './lib/a6';

/** Grito de dolor desde (x,y): lo usan Scream of Pain y la Shadow Strike con Scepter. */
function scream(a: AbilityInst, x: number, y: number) {
  const u = a.owner as Unit;
  const r = val(a, 'area_of_effect');
  u.w.emit({ n: 'scream_of_pain', x, y, r, t: u.team });
  const amount = dmg(a, 'damage');
  for (const e of u.w.enemiesIn(u.team, x, y, r)) {
    u.w.after(Math.hypot(e.x - x, e.y - y) / val(a, 'projectile_speed'), () => {
      if (!e.alive) return;
      const d = damage(u, e, amount, 'magical', a);
      // Parte del daño a héroes vuelve a ella (no letal).
      const back = e.isHeroLike ? d * val(a, 'damage_reflected_to_self') / 100 : 0;
      if (back > 0 && u.alive) damage(u, u, back, 'magical', a, { noProc: true, data: { nonLethal: true } });
    });
  }
}

function shadowStrike(a: AbilityInst, e: Unit) {
  const u = a.owner as Unit;
  if (e.has(ST.magicImmune)) return;
  const prev = e.findMod('shadow_strike', u);
  // Scepter: al reaplicarse o terminar en un héroe, grita.
  const sc = val(a, 'generate_scream') > 0;
  const sop = abil(u, 'queenofpain_scream_of_pain');
  if (prev && sc && e.kind === 'hero' && sop && sop.level > 0) scream(sop, e.x, e.y);
  damage(u, e, dmg(a, 'strike_damage'), 'magical', a);
  if (!e.alive) return;
  const d = dur(a, 'duration');
  const slowMax = Math.abs(val(a, 'movement_slow')) / 100;
  const every = val(a, 'damage_interval');
  if (prev) e.removeMod(prev);
  debuff(u, e, a, {
    name: 'shadow_strike', duration: d, fx: 'shadow_strike', interval: every,
    // El ralentizado decae a lo largo de la duración.
    props: (m) => ({ msSlow: slowMax * Math.max(0, m.remaining / m.duration) }),
    onInterval(m) {
      const v = m.owner as Unit;
      damage(u, v, dmg(a, 'duration_damage'), 'magical', a, { noProc: true });
      v.refreshStats();
    },
    onDestroy(m) {
      const v = m.owner as Unit;
      if (sc && m.remaining <= 0.02 && v.alive && v.kind === 'hero' && sop && sop.level > 0) scream(sop, v.x, v.y);
    },
  });
}

defineAbility({
  key: 'queenofpain_shadow_strike', target: 'unit', reflectable: true, ai: { role: 'nuke' },
  aoe: (a) => val(a, 'aoe_radius'),
  passive: (a) => ({
    // Talento: velocidad de ataque contra objetivos con Shadow Strike.
    name: 'shadow_strike_aspd', interval: 0.2,
    props: (m) => ({ attackSpeed: m.data.on ? val(a, 'attack_speed') : 0 }),
    onInterval(m) {
      const u = m.owner as Unit;
      const t = u.w.units.get(u.atk.target);
      const on = !!t && !!t.findMod('shadow_strike', u);
      if (on !== !!m.data.on) { m.data.on = on; u.refreshStats(); }
    },
  }),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const main = t.unit as Unit;
    const r = val(a, 'aoe_radius');
    const targets = r > 0 ? u.w.enemiesIn(u.team, main.x, main.y, r) : [main];
    if (!targets.includes(main)) targets.push(main);
    for (const e of targets) {
      u.w.addProjectile({
        kind: 'track', fx: 'shadow_strike', source: u, target: e, x: u.x, y: u.y,
        speed: val(a, 'projectile_speed'), dodgeable: true,
        onHit() { shadowStrike(a, e); return true; },
      });
    }
  },
});

defineAbility({
  key: 'queenofpain_blink', target: 'point', castBeyond: true, ai: { role: 'escape' },
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const [dx, dy] = castDir(u, t.x, t.y);
    const max = castRangeOf(a);
    const d = Math.max(val(a, 'min_blink_range'), Math.min(max, Math.hypot(t.x - u.x, t.y - u.y)));
    const boom = (x: number, y: number) => {
      const r = val(a, 'shard_aoe');
      u.w.emit({ n: 'sonic_boom', x, y, r, t: u.team });
      for (const e of u.w.enemiesIn(u.team, x, y, r)) {
        damage(u, e, val(a, 'shard_damage'), 'magical', a);
        silence(u, e, val(a, 'shard_duration'), a, 'qop_blink_silence');
      }
    };
    if (hasShard(u)) boom(u.x, u.y);
    u.w.disjoint(u);
    u.w.emit({ n: 'blink', x: u.x, y: u.y, u: u.id });
    u.w.teleport(u, u.x + dx * d, u.y + dy * d);
    u.w.emit({ n: 'blink', x: u.x, y: u.y, u: u.id });
    if (hasShard(u)) boom(u.x, u.y);
  },
});

defineAbility({
  key: 'queenofpain_scream_of_pain', target: 'none', ai: { role: 'aoe', selfRadius: 450 },
  aoe: (a) => val(a, 'area_of_effect'),
  onSpellStart(a) { const u = a.owner as Unit; scream(a, u.x, u.y); },
});

defineAbility({
  key: 'queenofpain_succubus', target: 'passive', innate: true, noIllusion: true,
  passive: (a) => ({
    name: 'succubus', interval: 0.25, data: { ls: val(a, 'spell_lifesteal') / 100 },
    props: (m) => ({ spellLifesteal: m.data.ls }),
    onInterval(m) {
      const u = m.owner as Unit;
      const close = val(a, 'close_radius'), far = val(a, 'max_radius');
      let best = Infinity;
      for (const e of u.w.enemiesIn(u.team, u.x, u.y, far + 50, { heroes: true })) best = Math.min(best, Math.hypot(e.x - u.x, e.y - u.y));
      const k = best === Infinity ? 0 : Math.max(0, Math.min(1, (far - best) / Math.max(1, far - close)));
      const ls = (val(a, 'spell_lifesteal') + (val(a, 'spell_lifesteal_close') - val(a, 'spell_lifesteal')) * k) / 100;
      if (Math.abs(ls - m.data.ls) > 0.002) { m.data.ls = ls; u.refreshStats(); }
    },
  }),
});

defineAbility({
  key: 'queenofpain_sonic_wave', target: 'point', castBeyond: true, ult: true, ai: { role: 'nuke' },
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const [dx, dy] = castDir(u, t.x, t.y);
    u.w.addProjectile({
      kind: 'linear', fx: 'sonic_wave', source: u, x: u.x, y: u.y, dx, dy,
      speed: val(a, 'speed'), left: val(a, 'distance'), width: val(a, 'starting_aoe') * 2, widthEnd: val(a, 'final_aoe') * 2,
      onHit(_p, e) {
        const v = e as Unit;
        if (v.team === u.team) return false;
        damage(u, v, dmg(a, 'damage'), 'pure', a);
        if (v.alive) push(v, dx, dy, val(a, 'knockback_distance'), val(a, 'knockback_duration'), u, a, 'sonic_wave_knock');
        return false;
      },
    });
  },
});

defineHero('queenofpain', ['queenofpain_shadow_strike', 'queenofpain_blink', 'queenofpain_scream_of_pain', 'queenofpain_succubus', 'queenofpain_sonic_wave'], {
  build: ['null_talisman', 'power_treads', 'kaya_and_sange', 'black_king_bar', 'aghanims_shard', 'ultimate_scepter', 'sheepstick', 'octarine_core'],
});
