import { ITEMS } from '../data';
import { defineAbility, defineHero, dmg, dur, hasShard, val } from '../sim/abilities';
import { damage } from '../sim/combat';
import type { AbilityInst } from '../sim/types';
import { ST } from '../sim/types';
import type { Unit } from '../sim/unit';
import { slow, stun } from './util';
import { aiBy, alliesNear, botCast } from './lib/a2';

defineAbility({
  key: 'centaur_hoof_stomp', target: 'none', ai: { role: 'disable', selfRadius: 280 },
  aoe: (a) => val(a, 'radius'),
  onSpellStart(a) {
    const u = a.owner as Unit;
    const r = val(a, 'radius');
    // Preparación: desarmado pero puede moverse; un aturdimiento la cancela.
    u.addMod({
      name: 'hoof_stomp_windup', duration: val(a, 'windup_time'), states: ST.disarmed, fx: 'windup',
      onTick(m) { if (u.has(ST.stunned | ST.hexed)) { m.data.cancel = true; m.remaining = 0.001; } },
      onDestroy(m) {
        if (m.data.cancel || !u.alive) return;
        u.w.emit({ n: 'hoof_stomp', x: u.x, y: u.y, r, t: u.team });
        for (const e of u.w.enemiesIn(u.team, u.x, u.y, r)) {
          damage(u, e, dmg(a, 'stomp_damage'), 'magical', a);
          stun(u, e, dur(a, 'stun_duration'), a);
        }
      },
    }, u, a);
  },
});

defineAbility({
  key: 'centaur_double_edge', target: 'unit', reflectable: true, ai: { role: 'nuke' },
  aoe: (a) => val(a, 'radius'),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const e = t.unit as Unit;
    const total = dmg(a, 'edge_damage') + val(a, 'strength_damage') / 100 * u.s.str;
    const r = val(a, 'radius');
    u.w.emit({ n: 'double_edge', x: e.x, y: e.y, r, u: u.id, u2: e.id });
    let heroes = 0;
    for (const v of u.w.enemiesIn(u.team, e.x, e.y, r)) {
      damage(u, v, total, 'magical', a);
      if (v.isHeroLike && hasShard(u)) {
        heroes++;
        slow(u, v, a, 'double_edge_slow', val(a, 'shard_movement_slow_duration'), val(a, 'shard_movement_slow') / 100);
      }
    }
    // Centaur no puede morir por su propio golpe.
    if (!a.temp) damage(u, u, total, 'magical', a, { noProc: true, data: { nonLethal: true } });
    // Shard: +% de fuerza por héroe golpeado, acumulable (refresca la duración).
    if (heroes > 0 && !a.temp) {
      const cur = u.findMod('double_edge_str', u);
      const stacks = Math.min(val(a, 'shard_max_stacks'), (cur?.stacks ?? 0) + heroes);
      const m = u.addMod({
        name: 'double_edge_str', duration: val(a, 'shard_str_duration'), stacks, fx: 'double_edge',
        props: (mm) => ({ str: Math.round(u.baseAttr('str') * mm.stacks * val(a, 'shard_str_pct') / 100) }),
      }, u, a);
      m.stacks = stacks; m.remaining = m.duration = val(a, 'shard_str_duration');
      u.refreshStats();
    }
  },
});

/** Devuelve el daño de Retaliate al atacante. */
function retaliate(a: AbilityInst, holder: Unit, attacker: Unit) {
  const u = a.owner as Unit;
  if (attacker.team === holder.team || !attacker.alive || attacker.kind === 'fountain') return;
  if (Math.hypot(attacker.x - holder.x, attacker.y - holder.y) > 1500) return;
  const amount = dmg(a, 'return_damage') + val(a, 'return_damage_str') / 100 * u.s.str;
  damage(u, attacker, amount, 'physical', a, { noProc: true });
}

defineAbility({
  key: 'centaur_return', target: 'passive',
  passive: (a) => ({
    name: 'retaliate',
    onAttacked(_m, ev) { if (!ev.missed) retaliate(a, ev.target as Unit, ev.attacker as Unit); },
    // Talento: aura de Retaliate para los aliados.
    aura: val(a, 'aura_enabled') ? {
      radius: val(a, 'aura_radius'), team: 'ally', heroesOnly: true, includeSelf: false,
      apply: () => ({
        name: 'retaliate_aura',
        onAttacked(_m, ev) { if (!ev.missed) retaliate(a, ev.target as Unit, ev.attacker as Unit); },
      }),
    } : undefined,
  }),
  noIllusion: true,
});

/** Efecto de Stampede sobre un aliado: velocidad máxima, atraviesa unidades y pisotea. */
function stampedeBuff(a: AbilityInst, ally: Unit, duration: number) {
  const u = a.owner as Unit;
  const hit = new Set<number>();
  ally.addMod({
    name: 'stampede', duration, fx: 'stampede', states: ST.noCollision,
    props: { msFixed: 550, slowResist: 1 },
    onTick(m) {
      const v = m.owner as Unit;
      for (const e of v.w.enemiesIn(v.team, v.x, v.y, val(a, 'radius') + v.radius)) {
        if (hit.has(e.id)) continue;
        hit.add(e.id);
        damage(u, e, dmg(a, 'base_damage') + val(a, 'strength_damage') * u.s.str, 'magical', a);
        slow(u, e, a, 'stampede_slow', val(a, 'slow_duration'), val(a, 'slow_movement_speed') / 100);
      }
    },
  }, u, a);
}

defineAbility({
  key: 'centaur_work_horse', target: 'none', ai: { role: 'buff', selfRadius: 700 },
  onSpellStart(a) {
    const u = a.owner as Unit;
    const st = u.abilities.find((x) => x.key === 'centaur_stampede');
    u.addMod({ name: 'work_horse', duration: val(a, 'duration'), fx: 'work_horse' }, u, a);
    u.w.emit({ n: 'cart', x: u.x, y: u.y, u: u.id });
    if (st && st.level > 0) stampedeBuff(st, u, val(a, 'duration'));
  },
});

// Hitch a Ride: sube a un aliado al carro (solo con Work Horse activo).
defineAbility({
  key: 'centaur_mount', target: 'unit', team: 'ally', requires: 'scepter', ai: aiBy('buff'),
  hidden: (a) => !(a.owner as Unit).findMod('work_horse'),
  passive: (a) => botCast(a, (u) => {
    if (!u.findMod('work_horse')) return null;
    const al = alliesNear(u, u.x, u.y, 600).find((v) => v !== u && v.kind === 'hero' && !v.findMod('hitched'));
    return al ? { unit: al } : null;
  }),
  noIllusion: true,
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const e = t.unit as Unit;
    const wh = u.findMod('work_horse');
    if (!wh || e === u) { a.cd = 0; u.mana += val(a, '_mc'); return; }
    const extra = e.melee ? val(a, 'melee_attack_range') : 0;
    e.order = null; e.path = [];
    e.w.disjoint(e);
    e.addMod({
      name: 'hitched', duration: Math.min(val(a, 'duration'), wh.remaining), fx: 'cart',
      states: ST.invulnerable | ST.untargetable | ST.rooted | ST.noCollision,
      props: { meleeRange: extra },
      onTick(m) {
        const v = m.owner as Unit;
        if (!u.alive || !u.findMod('work_horse')) { m.remaining = 0.001; return; }
        const bx = u.x - Math.cos(u.facing) * 90, by = u.y - Math.sin(u.facing) * 90;
        if (Math.hypot(v.x - bx, v.y - by) > val(a, 'break_distance')) { m.remaining = 0.001; return; }
        v.x = bx; v.y = by;
      },
      onDestroy(m) {
        const v = m.owner as Unit;
        v.w.teleport(v, v.x, v.y);
      },
    }, u, a);
  },
});

defineAbility({
  key: 'centaur_stampede', target: 'none', ult: true, ai: { role: 'buff', selfRadius: 900 },
  onSpellStart(a) {
    const u = a.owner as Unit;
    const d = dur(a, 'duration') + val(a, 'scepter_bonus_duration');
    u.w.emit({ n: 'stampede', x: u.x, y: u.y, u: u.id, t: u.team });
    for (const al of u.w.list) {
      if (al.team !== u.team || !al.alive || !al.isHeroLike) continue;
      stampedeBuff(a, al, d);
    }
  },
});

/** Bono de velocidad de las botas que lleva (Horsepower no se acumula con él). */
function bootsBonus(u: Unit): number {
  let best = 0;
  for (let s = 0; s < 6; s++) {
    const it = u.items[s];
    if (!it || !/boots|treads|greaves/.test(it.key)) continue;
    const v = ITEMS[it.key]?.values;
    const ms = v?.bonus_movement_speed?.[0] ?? v?.bonus_movement_speed_melee?.[0] ?? v?.bonus_movement?.[0] ?? v?.movement_speed?.[0] ?? 0;
    best = Math.max(best, ms);
  }
  return best;
}

defineAbility({
  key: 'centaur_horsepower', target: 'passive', innate: true,
  passive: (a) => ({
    name: 'horsepower', interval: 1,
    props: (m) => {
      const u = m.owner as Unit;
      return { msFlat: Math.max(0, (u.s?.str ?? 0) * val(a, 'strength_to_movement_pct') / 100 - bootsBonus(u)) };
    },
    onInterval(m) { (m.owner as Unit).refreshStats(); },
  }),
});

defineHero('centaur', ['centaur_hoof_stomp', 'centaur_double_edge', 'centaur_return', 'centaur_work_horse', 'centaur_mount', 'centaur_stampede', 'centaur_horsepower'], {
  build: ['bracer', 'phase_boots', 'blink', 'blade_mail', 'crimson_guard', 'heart', 'ultimate_scepter', 'shivas_guard'],
  upgrades: [
    { slot: 0, key: 'stomp_damage', amount: 40, max: 5, label: 'Hoof Stomp: +40 daño' },
    { slot: 0, key: 'radius', amount: 25, max: 4, label: 'Hoof Stomp: +25 radio' },
    { slot: 1, key: 'strength_damage', amount: 15, max: 5, label: 'Double Edge: +15% de fuerza como daño' },
    { slot: 2, key: 'return_damage_str', amount: 6, max: 5, label: 'Retaliate: +6% de fuerza devuelta' },
    { slot: 5, key: 'duration', amount: 0.5, max: 4, label: 'Stampede: +0,5 s de duración' },
  ],
});
