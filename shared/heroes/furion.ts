import { UNITS } from '../data';
import { castRangeOf, defineAbility, defineHero, dmg, dur, hasScepter, val } from '../sim/abilities';
import { damage } from '../sim/combat';
import type { AbilityInst, ModSpec } from '../sim/types';
import { ST } from '../sim/types';
import type { BaseStats, Unit } from '../sim/unit';
import { debuff, root } from './util';
import { barrier, botCast, botCommand, foes, nearestEnemyHero, plantRing, summonsOf, treesIn } from './lib/a3';

const ab = (u: Unit, key: string) => u.abilities.find((x) => x.key === key && x.level > 0);

defineAbility({
  key: 'furion_sprout', target: 'unitOrPoint', team: 'any', ai: { role: 'disable' },
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const x = t.unit ? t.unit.x : t.x, y = t.unit ? t.unit.y : t.y;
    const d = dur(a, 'duration');
    u.w.emit({ n: 'sprout', x, y, r: 150, d, t: u.team });
    plantRing(u.w, x, y, 150, d);
    for (const v of u.w.list) if (v.alive && !u.w.grid.walkable(v.x, v.y)) u.w.teleport(v, v.x, v.y);
    u.w.addVision(u.team, x, y, val(a, 'vision_range'), d);
    for (const e of foes(u, x, y, val(a, 'sprout_damage_radius'), a)) damage(u, e, dmg(a, 'sprout_damage'), 'magical', a);
  },
});

defineAbility({
  key: 'furion_teleportation', target: 'point',
  castRange: () => 0,
  // Bot: vuelve a la fuente si está muy herido, o salta a una pelea lejana si está sano.
  passive: (a) => botCast(a, (u) => {
    if (nearestEnemyHero(u, 600)) return null;
    const f = u.w.teams[u.team]?.fountain;
    if (u.hp / u.s.maxHp < 0.35) return f && Math.hypot(f.x - u.x, f.y - u.y) > 1500 ? f : null;
    if (u.hp / u.s.maxHp < 0.85) return null;
    for (const e of u.w.list) {
      if (e.kind !== 'hero' || e.team === u.team || !e.alive || !u.w.canSee(u.team, e)) continue;
      const d = Math.hypot(e.x - u.x, e.y - u.y);
      if (d > 1800 && d < 6000) return { x: e.x + (u.x - e.x) / d * 500, y: e.y + (u.y - e.y) / d * 500 };
    }
    return null;
  }, 1),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    u.w.emit({ n: 'blink', x: u.x, y: u.y, x2: t.x, y2: t.y, u: u.id, c: 'furion' });
    u.w.disjoint(u);
    u.w.teleport(u, t.x, t.y);
    u.addMod(barrier('teleportation_barrier', val(a, 'barrier'), val(a, 'buff_duration')), u, a);
  },
});

/** Stats de un treant según el nivel de Force of Nature. */
function treantBase(a: AbilityInst): BaseStats {
  const d = UNITS['furion_treant'];
  const dmgv = val(a, 'treant_damage');
  return {
    hp: val(a, 'treant_health'), hpRegen: d?.hpRegen ?? 0, mana: 0, manaRegen: 0, armor: d?.armor ?? 0, mr: d?.mr ?? 0,
    dmgMin: dmgv, dmgMax: dmgv + 2, bat: d?.bat ?? 1.6, attackPoint: d?.attackPoint ?? 0.467, range: d?.range ?? 125,
    projSpeed: 900, ms: val(a, 'treant_movespeed'), dayVision: val(a, 'treant_vision_day'),
    nightVision: val(a, 'treant_vision_night'), turnRate: d?.turnRate ?? 0.5, melee: true,
  };
}

defineAbility({
  key: 'furion_force_of_nature', target: 'point', aoe: (a) => val(a, 'area_of_effect'),
  // Bot: convierte el bosque más cercano cuando hay pelea.
  passive: (a) => botCast(a, (u) => {
    if (!nearestEnemyHero(u, 1200)) return null;
    const tr = u.w.nearestTree(u.x, u.y, castRangeOf(a));
    return tr ? { x: tr.x, y: tr.y } : null;
  }, 0.5),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const r = val(a, 'area_of_effect');
    const n = Math.min(val(a, 'max_treants'), u.w.cutTrees(t.x, t.y, r));
    const life = dur(a, 'treant_duration');
    const bonus = val(a, 'treant_bonus_hero_damage');
    const out: Unit[] = [];
    for (let i = 0; i < n; i++) {
      const ang = (i / Math.max(1, n)) * Math.PI * 2;
      const tr = u.w.spawnSummon(u, treantBase(a), t.x + Math.cos(ang) * 60, t.y + Math.sin(ang) * 60, life, {
        name: 'furion_treant', abilities: ['furion_spirit_of_the_forest'],
        bounty: Math.round(val(a, 'treant_gold_bounty_min') + u.w.rng() * (val(a, 'treant_gold_bounty_max') - val(a, 'treant_gold_bounty_min'))),
        xp: val(a, 'treant_xp_bounty'),
      });
      tr.addMod({
        name: 'treant_hero_damage', persistent: true,
        onAttackStart(_m, ev) { if (ev.target.isHeroLike) ev.damage += bonus; },
      }, u, a);
      out.push(tr);
    }
    u.w.emit({ n: 'force_of_nature', x: t.x, y: t.y, r, t: u.team });
    botCommand(u, out);
  },
});

defineAbility({
  key: 'furion_curse_of_the_forest', target: 'none', ai: { role: 'disable', selfRadius: 800 },
  onSpellStart(a) {
    const u = a.owner as Unit;
    const range = val(a, 'range');
    u.w.emit({ n: 'curse_forest', x: u.x, y: u.y, r: range, t: u.team });
    for (const e of foes(u, u.x, u.y, range, a, true)) {
      if (e.kind !== 'hero' && e.kind !== 'illusion') continue;
      const m = debuff(u, e, a, {
        name: 'curse_of_the_forest', duration: dur(a, 'duration'), fx: 'curse', interval: 1, stacks: 0,
        props: (mm) => ({ msSlow: mm.stacks * val(a, 'slow_per_tree') / 100 }),
        onTick(mm) {
          const v = mm.owner as Unit;
          const r = val(a, 'radius');
          const n = treesIn(v.w, v.x, v.y, r) + summonsOf(u, 'furion_treant').filter((s) => Math.hypot(s.x - v.x, s.y - v.y) <= r).length;
          if (n !== mm.stacks) { mm.stacks = n; v.refreshStats(); }
        },
        onInterval(mm) {
          if (mm.stacks > 0) damage(u, mm.owner as Unit, mm.stacks * dmg(a, 'damage_per_tree'), 'magical', a, { noProc: true });
        },
      });
      // Se le ve aunque esté en la niebla.
      if (m) e.addMod({ name: 'reveal', duration: dur(a, 'duration'), data: { team: u.team } }, u, a);
    }
  },
});

// Innata: daño extra por cada árbol cercano; los treants cuentan doble y también la tienen.
function forestSpec(a: AbilityInst): ModSpec {
  return {
    name: 'spirit_of_the_forest', interval: 0.5, stacks: 0,
    props: (m) => ({ damagePct: m.stacks * val(a, 'damage_per_tree_pct') / 100 }),
    onInterval(m) {
      const u = m.owner as Unit;
      const hero = u.kind === 'summon' ? (u.owner as Unit) : u;
      const isTreant = u.kind === 'summon';
      const k = val(a, 'multiplier');
      const r = val(a, 'radius_base') * (isTreant ? k : 1);
      const treants = hero ? summonsOf(hero, 'furion_treant').filter((s) => s !== u && Math.hypot(s.x - u.x, s.y - u.y) <= r).length : 0;
      const n = Math.round((treesIn(u.w, u.x, u.y, r) + treants * k) * (isTreant ? k : 1));
      if (n !== m.stacks) { m.stacks = n; u.refreshStats(); }
    },
  };
}
defineAbility({
  key: 'furion_spirit_of_the_forest', target: 'passive', innate: true,
  passive: (a) => forestSpec(a),
});

defineAbility({
  key: 'furion_wrath_of_nature', target: 'unitOrPoint', ult: true, ai: { role: 'nuke' },
  castRange: () => 0,
  // Bot: alcance global, lo lanza sobre el héroe enemigo visible más tocado.
  passive: (a) => botCast(a, (u) => {
    let best: Unit | null = null;
    for (const e of u.w.list) {
      if (e.kind !== 'hero' || e.team === u.team || !e.alive || !u.w.canSee(u.team, e) || !u.w.targetable(e)) continue;
      if (e.hp / e.s.maxHp < 0.5 && (!best || e.hp < best.hp)) best = e;
    }
    return best;
  }, 1),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const w = u.w;
    const max = val(a, 'max_targets');
    const hit = new Set<number>();
    let x = t.unit ? t.unit.x : t.x, y = t.unit ? t.unit.y : t.y;
    let first: Unit | null = t.unit && t.unit.team !== u.team ? (t.unit as Unit) : null;
    let n = 0;
    const jump = () => {
      if (n >= max) return;
      let next = first;
      first = null;
      if (!next || !next.alive) {
        let bd = Infinity;
        next = null;
        for (const e of w.list) {
          if (e.team === u.team || hit.has(e.id) || !w.targetable(e) || e.has(ST.invulnerable) || e.kind === 'fountain' || e.kind === 'ward') continue;
          if (e.has(ST.magicImmune) || !w.canSee(u.team, e)) continue;
          const d = Math.hypot(e.x - x, e.y - y);
          if (d < bd) { bd = d; next = e; }
        }
      }
      if (!next) return;
      hit.add(next.id);
      w.emit({ n: 'wrath_of_nature', x, y, x2: next.x, y2: next.y, u2: next.id, t: u.team });
      const amount = dmg(a, 'damage') * (1 + n * val(a, 'damage_percent_add') / 100);
      damage(u, next, amount, 'magical', a);
      if (hasScepter(u)) {
        const lo = val(a, 'scepter_min_entangle_duration'), hi = val(a, 'scepter_max_entangle_duration');
        root(u, next, lo + (hi - lo) * Math.min(1, n / Math.max(1, max - 1)), a, 'wrath_entangle');
      }
      x = next.x; y = next.y;
      n++;
      w.after(val(a, 'jump_delay'), jump);
    };
    jump();
  },
});

defineHero('furion', ['furion_sprout', 'furion_teleportation', 'furion_force_of_nature', 'furion_curse_of_the_forest', 'furion_spirit_of_the_forest', 'furion_wrath_of_nature'], {
  build: ['wraith_band', 'power_treads', 'maelstrom', 'orchid', 'black_king_bar', 'mjollnir', 'ultimate_scepter', 'sheepstick'],
  upgrades: [
    { slot: 0, key: 'sprout_damage', amount: 40, max: 5, label: 'Sprout: +40 daño' },
    { slot: 0, key: 'duration', amount: 0.4, max: 4, label: 'Sprout: +0,4 s de duración' },
    { slot: 1, key: 'barrier', amount: 60, max: 5, label: 'Teleportation: +60 de barrera' },
    { slot: 2, key: 'max_treants', amount: 1, max: 3, label: 'Nature\'s Call: +1 treant' },
    { slot: 2, key: 'treant_damage', amount: 8, max: 5, label: 'Nature\'s Call: +8 daño de treant' },
    { slot: 5, key: 'damage', amount: 20, max: 5, label: 'Wrath of Nature: +20 daño' },
    { slot: 5, key: '_cd', amount: -8, max: 4, label: 'Wrath of Nature: −8 s de enfriamiento' },
  ],
});
