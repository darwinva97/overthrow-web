import { defineAbility, defineHero, dmg, dur, hasShard, val } from '../sim/abilities';
import { damage } from '../sim/combat';
import type { AbilityInst } from '../sim/types';
import { ST } from '../sim/types';
import type { Unit } from '../sim/unit';
import { dist, flying, stationary, trueSightAt } from './lib/a9';
import { canDebuff, dash, debuff, stun } from './util';

const ab = (u: Unit, key: string) => u.abilities.find((x) => x.key === key);
/** Zeus real detrás de una ilusión o una nube. */
const zeusOf = (u: Unit) => (u.kind !== 'hero' && u.owner ? (u.owner as Unit) : u);

/** Arc Lightning desde `first`, saltando a enemigos cercanos no alcanzados. `mult` para Lightning Hands. */
function arc(a: AbilityInst, src: Unit, first: Unit, mult: number) {
  const w = src.w;
  const hit = new Set<number>();
  let jumps = val(a, 'jump_count');
  const strike = (from: Unit, t: Unit) => {
    hit.add(t.id);
    w.emit({ n: 'arc_lightning', x: from.x, y: from.y, x2: t.x, y2: t.y, u: from.id, u2: t.id });
    if (canDebuff(src, t, a)) damage(src, t, dmg(a, 'arc_damage') * mult, 'magical', a);
    if (jumps-- <= 0 && !val(a, 'has_unlimited_jumps')) return;
    w.after(val(a, 'jump_delay'), () => {
      const next = w.enemiesIn(src.team, t.x, t.y, val(a, 'radius'))
        .filter((e) => !hit.has(e.id) && e.kind !== 'ward' && w.canSee(src.team, e))
        .sort((p, q) => dist(p, t) - dist(q, t))[0];
      if (next) strike(t, next);
    });
  };
  strike(src, first);
}

defineAbility({
  key: 'zuus_arc_lightning', target: 'unit', reflectable: true, ai: { role: 'nuke' },
  onSpellStart(a, t) { arc(a, a.owner as Unit, t.unit as Unit, 1); },
});

/** Rayo en (x, y) sobre `t` (o en área con el talento). */
function bolt(a: AbilityInst, src: Unit, x: number, y: number, t: Unit | null) {
  const w = src.w;
  const z = zeusOf(src);
  if (t) { x = t.x; y = t.y; }
  w.emit({ n: 'lightning_bolt', x, y, u: t?.id, t: src.team });
  trueSightAt(z, x, y, val(a, 'true_sight_radius'), val(a, 'sight_duration'));
  const area = val(a, 'aoe_radius');
  const victims = area > 0 ? w.enemiesIn(src.team, x, y, area) : t ? [t] : [];
  if (t && !victims.includes(t)) victims.push(t);
  for (const v of victims) {
    if (!canDebuff(z, v, a)) continue;
    damage(z, v, dmg(a, 'damage') * (v.isHeroLike ? 1 : 1 + val(a, 'creep_damage_bonus_pct') / 100), 'magical', a);
    stun(z, v, dur(a, 'ministun_duration'), a);
  }
}

defineAbility({
  key: 'zuus_lightning_bolt', target: 'unitOrPoint', reflectable: true, ai: { role: 'nuke' },
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    let e = (t.unit as Unit) ?? null;
    // En el suelo: el héroe enemigo más cercano en el radio.
    if (!e) e = u.w.enemiesIn(u.team, t.x, t.y, val(a, 'spread_aoe'), { heroes: true }).sort((p, q) => dist(p, t) - dist(q, t))[0] ?? null;
    bolt(a, u, t.x, t.y, e);
  },
});

defineAbility({
  key: 'zuus_heavenly_jump', target: 'none', ai: { role: 'nuke', selfRadius: 700 },
  charges: (a) => [Math.max(1, val(a, 'abilitycharges')), val(a, 'abilitychargerestoretime') * (1 - (a.owner as Unit).s.cdr)],
  onSpellStart(a) {
    const u = a.owner as Unit;
    const w = u.w;
    const targets = w.enemiesIn(u.team, u.x, u.y, val(a, 'range'))
      .filter((e) => e.kind !== 'ward' && w.canSee(u.team, e))
      .sort((p, q) => Number(q.isHeroLike) - Number(p.isHeroLike) || dist(p, u) - dist(q, u))
      .slice(0, val(a, 'targets'));
    for (const e of targets) {
      w.emit({ n: 'arc_lightning', x: u.x, y: u.y, x2: e.x, y2: e.y, u: u.id, u2: e.id });
      damage(u, e, dmg(a, 'damage'), 'magical', a);
      debuff(u, e, a, { name: 'heavenly_jump_slow', duration: dur(a, 'duration'), fx: 'slow', props: { msSlow: val(a, 'move_slow') / 100, attackSlow: val(a, 'aspd_slow') } });
    }
    w.addVision(u.team, u.x, u.y, val(a, 'vision_radius'), val(a, 'vision_duration'));
    const d = val(a, 'hop_distance');
    const tx = u.x + Math.cos(u.facing) * d, ty = u.y + Math.sin(u.facing) * d;
    dash(u, tx, ty, d / val(a, 'hop_duration'), a, { name: 'heavenly_jump', states: ST.flying });
  },
});

defineAbility({
  key: 'zuus_cloud', target: 'point', ai: { role: 'aoe' },
  aoe: (a) => val(a, 'cloud_radius'),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const w = u.w;
    const c = w.spawnSummon(u, {
      hp: val(a, 'hits_to_kill_tooltip'), hpRegen: 0, mana: 0, manaRegen: 0, armor: 0, mr: 0, dmgMin: 0, dmgMax: 0,
      bat: 1, attackPoint: 0, range: 0, projSpeed: 0, ms: 100, dayVision: val(a, 'cloud_radius'), nightVision: val(a, 'cloud_radius'),
      turnRate: 1, melee: true,
    }, t.x, t.y, val(a, 'cloud_duration'), { name: 'zeus_cloud', abilities: [], bounty: val(a, 'cloud_bounty_tooltip') });
    stationary(c);
    flying(c);
    const perCreep = val(a, 'hits_to_kill_tooltip') / val(a, 'creep_hits_to_kill_tooltip');
    c.addMod({
      name: 'nimbus', persistent: true, interval: val(a, 'cloud_bolt_interval'), fx: 'nimbus', states: ST.disarmed,
      // Solo muere a golpes: los héroes quitan 1 y los creeps menos.
      onIncomingDamage(_m, ev) { ev.amount = !ev.isAttack ? 0 : (ev.source as Unit | null)?.isHeroLike ? 1 : perCreep; },
      onInterval() {
        const b = ab(u, 'zuus_lightning_bolt');
        if (!b || b.level <= 0) return;
        const e = w.enemiesIn(u.team, c.x, c.y, val(a, 'cloud_radius'))
          .filter((x) => x.kind !== 'ward' && w.canSee(u.team, x))
          .sort((p, q) => Number(q.isHeroLike) - Number(p.isHeroLike) || dist(p, c) - dist(q, c))[0];
        if (e) bolt(b, c, e.x, e.y, e);
      },
    }, u, a);
  },
});

defineAbility({
  key: 'zuus_lightning_hands', target: 'toggle',
  passive: (a) => ({
    name: 'lightning_hands',
    props: () => ({ attackSpeed: a.toggled ? val(a, 'attack_speed_bonus') : 0 }),
    onAttackLanded(_m, ev) {
      const by = ev.attacker as Unit, t = ev.target as Unit;
      if (by.isBot && !a.toggled) { a.toggled = true; by.refreshStats(); }
      if (!a.toggled || t.team === by.team || ev.fake) return;
      const al = ab(by, 'zuus_arc_lightning');
      if (!al || al.level <= 0) return;
      const pct = by.kind === 'illusion' ? val(a, 'arc_lightning_damage_illusion_pct') : val(a, 'arc_lightning_damage_pct');
      arc(al, by, t, pct / 100);
    },
  }),
  onToggle(a) { (a.owner as Unit).refreshStats(); },
  // Al conseguir el Shard empieza activada.
  onAghs(a) { if (hasShard(a.owner as Unit) && !a.data.init) { a.data.init = true; a.toggled = true; (a.owner as Unit).refreshStats(); } },
});

defineAbility({
  key: 'zuus_thundergods_wrath', target: 'none', ult: true, ai: { role: 'nuke', selfRadius: 99999, hpBelow: 0.6 },
  onSpellStart(a) {
    const u = a.owner as Unit;
    const w = u.w;
    for (const e of w.list) {
      if (e.kind !== 'hero' || e.team === u.team || !e.alive || e.has(ST.hidden)) continue;
      trueSightAt(u, e.x, e.y, val(a, 'sight_radius_day'), val(a, 'sight_duration'));
      w.emit({ n: 'lightning_bolt', x: e.x, y: e.y, u: e.id, t: u.team });
      if (canDebuff(u, e, a) && !e.has(ST.invulnerable)) damage(u, e, dmg(a, 'damage'), 'magical', a);
    }
  },
});

defineAbility({
  key: 'zuus_static_field', target: 'passive', innate: true,
  passive: (a) => ({
    name: 'static_field',
    onDealDamage(m, ev) {
      const t = ev.target as Unit;
      const by = m.owner as Unit;
      if (ev.data?.static || t.team === by.team || !t.alive) return;
      const s = ev.ability as AbilityInst | null;
      const fromZeus = ev.isAttack || (!!s && !(s as { isItem?: boolean }).isItem && s.key?.startsWith('zuus_'));
      if (!fromZeus) return;
      damage(by, t, t.hp * val(a, 'damage_health_pct') / 100, 'magical', a, { data: { static: true } });
    },
  }),
});

defineHero('zuus', ['zuus_arc_lightning', 'zuus_lightning_bolt', 'zuus_heavenly_jump', 'zuus_cloud', 'zuus_lightning_hands', 'zuus_thundergods_wrath', 'zuus_static_field'], {
  build: ['null_talisman', 'arcane_boots', 'kaya', 'aether_lens', 'black_king_bar', 'ultimate_scepter', 'refresher'],
});
