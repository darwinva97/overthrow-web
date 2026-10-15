import { castRangeOf, defineAbility, defineHero, dmg, dur, hasScepter, val } from '../sim/abilities';
import { damage } from '../sim/combat';
import type { AbilityInst } from '../sim/types';
import { ST } from '../sim/types';
import type { Unit } from '../sim/unit';
import { debuff } from './util';

/** Un anillo de Plasma Field: crece hasta el radio y vuelve; golpea a cada uno en cada sentido. */
function plasmaRing(a: AbilityInst, eff: number) {
  const u = a.owner as Unit;
  const R = val(a, 'radius');
  const T = val(a, 'total_ability_time');
  const hitOut = new Set<number>(), hitIn = new Set<number>();
  u.w.emit({ n: 'plasma_field', x: u.x, y: u.y, r: R, d: T, u: u.id, t: u.team });
  u.addMod({
    name: 'plasma_field', duration: T, data: { t: 0, multi: true },
    onTick(m, dt) {
      m.data.t += dt;
      const s = Math.min(1, m.data.t / (T / 2));
      const out = m.data.t <= T / 2;
      const r = out ? R * s : R * Math.max(0, 2 - m.data.t / (T / 2));
      const set = out ? hitOut : hitIn;
      for (const e of u.w.enemiesIn(u.team, u.x, u.y, R + 30)) {
        if (set.has(e.id)) continue;
        const d = Math.hypot(e.x - u.x, e.y - u.y);
        if (out ? d > r : d < r) continue;
        set.add(e.id);
        const k = Math.min(1, d / R);
        damage(u, e, (val(a, 'damage_min') + (val(a, 'damage_max') - val(a, 'damage_min')) * k) * a.upg.dmg * eff, 'magical', a);
        const sl = (val(a, 'slow_min') + (val(a, 'slow_max') - val(a, 'slow_min')) * k) / 100;
        debuff(u, e, a, { name: 'plasma_field_slow', duration: val(a, 'slow_duration'), fx: 'slow', props: { msSlow: sl * eff } });
      }
    },
  }, u, a);
}

defineAbility({
  key: 'razor_plasma_field', target: 'none', ai: { role: 'aoe', selfRadius: 600 },
  aoe: (a) => val(a, 'radius'),
  onSpellStart(a) {
    const u = a.owner as Unit;
    plasmaRing(a, 1);
    // Talento: segundo anillo retrasado y algo más débil.
    const delay = val(a, 'second_ring_delay');
    if (delay > 0) u.w.after(delay, () => { if (u.alive) plasmaRing(a, 1 - val(a, 'second_ring_reduction') / 100); });
  },
});

defineAbility({
  key: 'razor_static_link', target: 'unit', reflectable: true, ai: { role: 'nuke' },
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const e = t.unit as Unit;
    if (e.kind !== 'hero' && e.kind !== 'illusion') return;
    const keep = dur(a, 'drain_duration');
    const rate = val(a, 'drain_rate');
    const aspd = val(a, 'attack_speed_factor') > 0;
    const buff = u.addMod({
      name: 'static_link_buff', duration: val(a, 'drain_length') + keep, fx: 'static_link', data: { amt: 0, multi: true },
      props: (m) => ({ damage: m.data.amt, attackSpeed: aspd ? m.data.amt : 0 }),
    }, u, a);
    const deb = e.addMod({
      name: 'static_link_debuff', duration: val(a, 'drain_length') + keep, debuff: true, purgable: false, data: { amt: 0, multi: true },
      props: (m) => ({ damage: -m.data.amt, attackSlow: aspd ? m.data.amt : 0 }),
    }, u, a);
    const maxD = castRangeOf(a) + val(a, 'drain_range_buffer');
    u.addMod({
      name: 'static_link', duration: val(a, 'drain_length'), fx: 'static_link_beam', interval: 0.1, data: { multi: true, target: e.id },
      onInterval(m) {
        if (!e.alive || !u.alive || Math.hypot(e.x - u.x, e.y - u.y) > maxD) { m.remaining = 0.001; return; }
        buff.data.amt += rate * 0.1; deb.data.amt += rate * 0.1;
        u.w.addVision(u.team, e.x, e.y, 200, val(a, 'vision_duration'));
        u.refreshStats(); e.refreshStats();
      },
      onDestroy() {
        // El robo dura `drain_duration` desde que se corta el enlace.
        buff.remaining = keep; deb.remaining = keep;
      },
    }, u, a);
  },
});

/** Rayo de Storm Surge: golpea al objetivo y a otros cercanos. */
function surge(a: AbilityInst, first: Unit | null) {
  const u = a.owner as Unit;
  const eye = u.findMod('eye_of_the_storm');
  const shardEye = eye && val(a, 'hit_targets_inside_eye_of_the_storm') > 0;
  const r = val(a, 'strike_search_radius');
  let targets: Unit[];
  if (shardEye) targets = u.w.enemiesIn(u.team, u.x, u.y, eye!.data.radius);
  else {
    const all = u.w.enemiesIn(u.team, u.x, u.y, r).filter((e) => e !== first && e.kind !== 'ward');
    // Prioriza el tipo de unidad del atacante.
    const pref = first?.isHeroLike ?? true;
    all.sort((p, q) => Number(q.isHeroLike === pref) - Number(p.isHeroLike === pref) || Math.hypot(p.x - u.x, p.y - u.y) - Math.hypot(q.x - u.x, q.y - u.y));
    targets = (first && first.alive ? [first] : []).concat(all).slice(0, val(a, 'strike_target_count'));
  }
  for (const e of targets) {
    if (e.has(ST.magicImmune)) continue;
    u.w.emit({ n: 'lightning', x: u.x, y: u.y, x2: e.x, y2: e.y, u: u.id, u2: e.id });
    damage(u, e, dmg(a, 'strike_damage'), 'magical', a);
    debuff(u, e, a, { name: 'storm_surge_slow', duration: val(a, 'strike_slow_duration'), fx: 'slow', props: { msSlow: val(a, 'strike_move_slow_pct') / 100 } });
  }
}

defineAbility({
  key: 'razor_storm_surge', target: 'passive', noIllusion: true,
  passive: (a) => ({
    name: 'storm_surge', data: { next: 0 },
    onAttacked(m, ev) {
      const u = a.owner as Unit;
      const att = ev.attacker as Unit;
      if (att.team === u.team || u.w.time < m.data.next) return;
      const eye = !!u.findMod('eye_of_the_storm');
      const mult = eye && val(a, 'eye_of_the_storm_chance_multiplier') > 0 ? val(a, 'eye_of_the_storm_chance_multiplier') : 1;
      if (u.w.rng() >= val(a, 'strike_pct_chance') / 100 * mult) return;
      m.data.next = u.w.time + val(a, 'strike_internal_cd') - (eye ? val(a, 'strike_cd_reduction_during_storm') : 0);
      surge(a, att);
    },
    onTargeted(m, caster) {
      const u = a.owner as Unit;
      if (caster.team === u.team || u.w.time < m.data.next) return false;
      const eye = !!u.findMod('eye_of_the_storm');
      m.data.next = u.w.time + val(a, 'strike_internal_cd') - (eye ? val(a, 'strike_cd_reduction_during_storm') : 0);
      surge(a, caster as Unit);
      return false;
    },
  }),
});

// Unstable Current: velocidad de movimiento según los datos (0 en este parche).
defineAbility({
  key: 'razor_unstable_current', target: 'passive', innate: true,
  passive: (a) => ({ name: 'unstable_current', props: { msPct: val(a, 'movespeed_pct') / 100 } }),
});

defineAbility({
  key: 'razor_eye_of_the_storm', target: 'none', ult: true, ai: { role: 'aoe', selfRadius: 450 },
  aoe: (a) => val(a, 'radius'),
  onSpellStart(a) {
    const u = a.owner as Unit;
    const r = val(a, 'radius');
    const d = dur(a, 'duration');
    u.removeModsByName('eye_of_the_storm');
    u.addMod({
      name: 'eye_of_the_storm', duration: d, fx: 'eye_of_the_storm', interval: val(a, 'strike_interval'), purgable: false,
      data: { radius: r },
      onInterval() {
        // Al de menos vida; con Scepter, a dos distintos.
        const list = u.w.enemiesIn(u.team, u.x, u.y, r).filter((e) => e.kind !== 'ward' && u.w.canSee(u.team, e))
          .sort((p, q) => p.hp - q.hp);
        for (const e of list.slice(0, hasScepter(u) ? 2 : 1)) {
          u.w.emit({ n: 'lightning', x: u.x, y: u.y, x2: e.x, y2: e.y, u: u.id, u2: e.id });
          damage(u, e, dmg(a, 'damage'), 'physical', a);
          const had = !!e.findMod('eye_of_the_storm_armor', u);
          const m = e.addMod({
            name: 'eye_of_the_storm_armor', duration: d, debuff: true, purgable: false,
            props: (mm) => ({ armor: -mm.stacks * val(a, 'armor_reduction') }),
          }, u, a);
          if (had) m.stacks++;
          e.refreshStats();
        }
      },
    }, u, a);
  },
});

defineHero('razor', ['razor_plasma_field', 'razor_static_link', 'razor_storm_surge', 'razor_unstable_current', 'razor_eye_of_the_storm'], {
  build: ['wraith_band', 'power_treads', 'dragon_lance', 'sange_and_yasha', 'black_king_bar', 'satanic', 'ultimate_scepter', 'skadi'],
});
