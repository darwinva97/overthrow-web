import { cooldownOf, defineAbility, defineHero, dmg, dur, hasScepter, isItem, val } from '../sim/abilities';
import { damage } from '../sim/combat';
import type { AbilityInst } from '../sim/types';
import { ST } from '../sim/types';
import type { Unit } from '../sim/unit';
import { abil, addStacks, barrierSpec, refund, revealTo } from './lib/a7';
import { push, stun } from './util';

const BASH = 'spirit_breaker_greater_bash';
const RUSH = 'spirit_breaker_bull_rush';

/** Bull Rush: velocidad extra cada vez que aturde a un enemigo. */
function bullRush(u: Unit, t: Unit) {
  const a = abil(u, RUSH);
  if (!a || a.level <= 0 || t.team === u.team) return;
  const hero = t.isHeroLike;
  const pct = val(a, hero ? 'hero_movespeed_percent' : 'creep_movespeed_percent') / 100;
  addStacks(u, u, a, { name: hero ? 'bull_rush_hero' : 'bull_rush_creep', fx: 'bull_rush', props: (m) => ({ msPct: m.stacks * pct }) },
    val(a, hero ? 'hero_duration' : 'creep_duration'));
}

/** Aturdimiento propio de Spirit Breaker (alimenta Bull Rush). */
function sbStun(u: Unit, t: Unit, d: number, a: AbilityInst) {
  const m = stun(u, t, d, a);
  if (m) bullRush(u, t);
  return m;
}

/** Greater Bash sobre `t`: daño por velocidad, aturdimiento y empuje. */
function greaterBash(u: Unit, t: Unit, kbMult = 1, cascade = true) {
  const a = abil(u, BASH);
  if (!a || a.level <= 0 || !t.alive || t.team === u.team || t.kind === 'ward') return;
  if (t.has(ST.magicImmune) && !a.def.bkbPierce) return;
  const base = u.s.ms * dmg(a, 'damage') / 100 * (t.isHeroLike ? 1 : val(a, 'creep_multiplier'));
  damage(u, t, base, 'magical', a);
  sbStun(u, t, dur(a, 'duration'), a);
  u.w.emit({ n: 'bash', x: t.x, y: t.y, u: t.id });
  const dx = t.x - u.x, dy = t.y - u.y;
  const kb = val(a, 'knockback_distance') * kbMult;
  const p = push(t, dx, dy, kb, val(a, 'knockback_duration'), u, a, 'greater_bash_push');
  // Scepter: si el empujado choca con otro enemigo, también recibe un Bash.
  if (hasScepter(u) && cascade && p) {
    const hit = new Set<number>([t.id]);
    const orig = p.onTick!;
    p.onTick = (m, dt) => {
      orig(m, dt);
      for (const o of u.w.enemiesIn(u.team, t.x, t.y, val(a, 'cascading_bashes_hero_hitbox'))) {
        if (hit.has(o.id) || o.kind === 'ward') continue;
        if (!o.isHeroLike && Math.hypot(o.x - t.x, o.y - t.y) > val(a, 'cascading_bashes_creep_hitbox')) continue;
        hit.add(o.id);
        greaterBash(u, o, 1, false);
        damage(u, t, base * val(a, 'cascading_bashes_damage_multiplier') / 100, 'magical', a);
      }
    };
  }
  u.addMod({ name: 'greater_bash_speed', duration: val(a, 'movespeed_duration'), props: { msPct: val(a, 'bonus_movespeed_pct') / 100 } }, u, a);
}

defineAbility({
  key: 'spirit_breaker_charge_of_darkness', target: 'unit', reflectable: false, ai: { role: 'disable' },
  // Alcance global (el dataset trae 0).
  castRange: () => 50000,
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    let target = t.unit as Unit;
    const start = u.w.time;
    revealTo(target, u.team, 60, u, a);
    u.order = null; u.path = [];
    const hit = new Set<number>();
    u.addMod({
      name: 'charge_of_darkness', duration: 60, fx: 'charge_of_darkness', states: ST.busy | ST.noCollision,
      onTick(m, dt) {
        if (u.has(ST.stunned) || u.has(ST.rooted) || u.has(ST.hexed) || u.has(ST.hidden)) { u.removeMod(m); return; }
        if (!target.alive || !u.w.targetable(target)) {
          const rv = target.findMod('reveal', u);
          if (rv) target.removeMod(rv);
          // Busca al enemigo más cercano a donde estaba el objetivo.
          const next = u.w.enemiesIn(u.team, target.x, target.y, 4000).filter((e) => e.kind !== 'ward')
            .sort((p, q) => Math.hypot(p.x - target.x, p.y - target.y) - Math.hypot(q.x - target.x, q.y - target.y))[0];
          if (!next) { u.removeMod(m); return; }
          target = next;
          revealTo(target, u.team, 60, u, a);
        }
        // Acelera del 25% al 100% del bonus durante el tiempo de carga.
        const k = Math.min(1, (u.w.time - start) / val(a, 'windup_time'));
        const minK = val(a, 'min_movespeed_bonus_pct') / 100;
        const speed = u.s.ms + val(a, 'movement_speed') * (minK + (1 - minK) * k);
        u.w.moveToward(u, target.x, target.y, dt * speed / Math.max(1, u.s.ms), 1);
        u.w.addVision(u.team, u.x, u.y, val(a, 'vision_radius'), val(a, 'vision_duration'));
        // Golpea a quien atraviesa.
        for (const e of u.w.enemiesIn(u.team, u.x, u.y, u.radius + 60)) {
          if (e === target || hit.has(e.id)) continue;
          hit.add(e.id);
          greaterBash(u, e);
        }
        if (Math.hypot(target.x - u.x, target.y - u.y) <= u.radius + target.radius + 40) {
          u.removeMod(m);
          if (!target.has(ST.magicImmune) || a.def.bkbPierce) sbStun(u, target, dur(a, 'stun_duration'), a);
          greaterBash(u, target);
          u.w.issueOrder(u, { type: 'attack', target: target.id });
        }
      },
      // Cualquier orden la cancela, salvo atacar al propio objetivo.
      onOrder(m, o) {
        // Los bots reordenan ataques a menudo: para ellos atacar no la cancela.
        if (o.type === 'attack' && (o.target === target.id || u.isBot)) return;
        if (o.type === 'cast' && u.abilities[o.slot]?.impl.target === 'none') return;
        u.removeMod(m);
      },
      onDestroy() { const rv = target.findMod('reveal', u); if (rv) target.removeMod(rv); },
    }, u, a);
  },
});

defineAbility({
  key: 'spirit_breaker_bulldoze', target: 'none', ai: { role: 'buff', selfRadius: 900 },
  onSpellStart(a) {
    const u = a.owner as Unit;
    const barrier = val(a, 'damage_barrier');
    u.addMod({
      name: 'bulldoze', duration: dur(a, 'duration'), fx: 'bulldoze', states: ST.noCollision,
      props: { msPct: val(a, 'movement_speed') / 100, statusResist: val(a, 'status_resistance') / 100 },
    }, u, a);
    if (barrier > 0) u.addMod({ name: 'bulldoze_barrier', duration: dur(a, 'duration'), fx: 'barrier', ...barrierSpec(barrier) }, u, a);
  },
});

defineAbility({
  key: 'spirit_breaker_greater_bash', target: 'passive',
  passive: (a) => ({
    name: 'greater_bash',
    onAttackLanded(_m, ev) {
      const u = ev.attacker as Unit, t = ev.target as Unit;
      if (u.kind === 'illusion' || a.cd > 0 || t.team === u.team || t.kind === 'ward') return;
      if (u.w.rng() >= (val(a, 'chance_pct') + val(a, 'bonus_chance_pct')) / 100) return;
      a.cd = cooldownOf(a);
      greaterBash(u, t);
    },
  }),
});

defineAbility({
  key: 'spirit_breaker_planar_pocket', target: 'unit', team: 'any', allowSelf: false, ai: { role: 'buff' },
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const e = t.unit as Unit | undefined;
    if (!e || e === u) { refund(a); return; }
    const d = val(a, 'duration');
    u.addMod({ name: 'planar_pocket_self', duration: d, fx: 'planar_pocket', props: { magicResist: val(a, 'magic_resistance') / 100 } }, u, a);
    e.addMod({
      name: 'planar_pocket', duration: d, fx: 'planar_pocket', debuff: false, purgable: false,
      onTick(m) { const v = m.owner as Unit; if (!u.alive || Math.hypot(v.x - u.x, v.y - u.y) > val(a, 'break_distance')) v.removeMod(m); },
      // Los hechizos con objetivo de héroes enemigos de Spirit Breaker se desvían hacia él.
      onTargeted(_m, caster, spell) {
        if (caster.team === u.team || caster.kind !== 'hero' || !u.alive || !u.w.targetable(u)) return false;
        if (!isItem(spell) && (spell as AbilityInst).temp) return false;
        u.w.emit({ n: 'planar_pocket_redirect', x: u.x, y: u.y, u: u.id, u2: caster.id });
        spell.impl?.onSpellStart?.(spell as any, { unit: u, x: u.x, y: u.y });
        return true;
      },
    }, u, a);
  },
});

defineAbility({ key: 'spirit_breaker_bull_rush', target: 'passive', innate: true });

defineAbility({
  key: 'spirit_breaker_nether_strike', target: 'unit', ult: true, reflectable: true, ai: { role: 'nuke' },
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const e = t.unit as Unit;
    const ang = Math.atan2(e.y - u.y, e.x - u.x);
    const fx = u.x, fy = u.y;
    u.w.disjoint(u);
    u.w.teleport(u, e.x - Math.cos(ang) * 60, e.y - Math.sin(ang) * 60);
    u.facing = ang;
    u.w.emit({ n: 'nether_strike', x: fx, y: fy, x2: u.x, y2: u.y, u: u.id, u2: e.id });
    damage(u, e, dmg(a, 'damage'), 'magical', a);
    const bash = abil(u, BASH);
    if (bash && bash.level > 0) greaterBash(u, e, val(bash, 'bonus_knockback_multiplier'));
    u.w.issueOrder(u, { type: 'attack', target: e.id });
  },
});

defineHero('spirit_breaker', [
  'spirit_breaker_charge_of_darkness', 'spirit_breaker_bulldoze', 'spirit_breaker_greater_bash', 'spirit_breaker_planar_pocket',
  'spirit_breaker_bull_rush', 'spirit_breaker_nether_strike',
], {
  build: ['bracer', 'phase_boots', 'armlet', 'black_king_bar', 'ultimate_scepter', 'heart', 'assault', 'abyssal_blade'],
});

