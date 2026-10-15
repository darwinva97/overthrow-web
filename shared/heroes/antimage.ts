import { castRangeOf, defineAbility, defineHero, dmg, dur, hasScepter, hasShard, val } from '../sim/abilities';
import { burnMana, damage } from '../sim/combat';
import type { Unit } from '../sim/unit';
import { debuff, reflectSpell, slow, stun } from './util';

defineAbility({
  key: 'antimage_mana_break', target: 'passive',
  passive: (a) => ({
    name: 'mana_break',
    onAttackLanded(_m, ev) {
      const u = ev.attacker as Unit, t = ev.target as Unit;
      if (t.s.maxMana <= 0 || !t.isHeroLike && t.kind !== 'creep') return;
      let amount = val(a, 'mana_per_hit') + t.s.maxMana * val(a, 'mana_per_hit_pct') / 100;
      if (u.kind === 'illusion') amount *= val(a, 'illusion_percentage') / 100;
      // Scepter: el primer golpe tras Blink quema un % extra de maná y corta su regeneración.
      const emp = u.findMod('empowered_mana_break');
      if (emp) {
        u.removeMod(emp);
        amount += t.s.maxMana * val(a, 'empowered_max_burn_pct') / 100;
        debuff(u, t, a, {
          name: 'mana_break_drain', duration: val(a, 'empowered_mana_break_debuff_duration'), purgable: false, fx: 'slow',
          props: { manaRegenAmp: -1 },
        });
      }
      const burned = burnMana(t, amount * a.upg.dmg);
      if (burned > 0) {
        ev.damage += burned * val(a, 'percent_damage_per_burn') / 100;
        u.w.emit({ n: 'manaburn', x: t.x, y: t.y, u: t.id });
      }
    },
  }),
});

// Más allá del alcance no camina: Blink se recorta al máximo.
defineAbility({
  key: 'antimage_blink', target: 'point', ai: { role: 'escape' }, castBeyond: true,
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const range = castRangeOf(a);
    let dx = t.x - u.x, dy = t.y - u.y;
    let d = Math.hypot(dx, dy);
    if (d < 1) { dx = Math.cos(u.facing); dy = Math.sin(u.facing); d = 1; }
    const go = Math.max(val(a, 'min_blink_range'), Math.min(range, d));
    const fromX = u.x, fromY = u.y;
    u.w.disjoint(u);
    u.w.teleport(u, u.x + dx / d * go, u.y + dy / d * go);
    u.w.emit({ n: 'blink', x: fromX, y: fromY, x2: u.x, y2: u.y, u: u.id, c: 'am' });
    if (hasScepter(u)) u.addMod({ name: 'empowered_mana_break', duration: val(a, 'empowered_mana_break_duration'), fx: 'haste' }, u, a);
  },
});

defineAbility({
  key: 'antimage_counterspell', target: 'none', ai: { role: 'buff' },
  passive: (a) => ({ name: 'counterspell_passive', props: { magicResist: val(a, 'magic_resistance') / 100 } }),
  onSpellStart(a) {
    const u = a.owner as Unit;
    u.addMod({
      name: 'counterspell', duration: dur(a, 'duration'), fx: 'counterspell',
      onTargeted(_m, caster, spell) {
        const c = caster as Unit;
        reflectSpell(u, c, spell);
        // Shard: un fragmento de Anti-Mage aparece junto al lanzador y lo ataca.
        if (hasShard(u) && c.alive && c.team !== u.team) {
          const ang = u.w.rng() * Math.PI * 2;
          const il = u.w.spawnIllusion(u, c.x + Math.cos(ang) * 100, c.y + Math.sin(ang) * 100, val(a, 'duration_illusion'),
            val(a, 'outgoing_damage') / 100, val(a, 'incoming_damage') / 100);
          u.w.issueOrder(il, { type: 'attack', target: c.id });
        }
        return true;
      },
    }, u, a);
  },
});

defineAbility({
  key: 'antimage_persectur', target: 'passive', innate: true,
  passive: (a) => ({
    name: 'persecutor',
    onAttackLanded(_m, ev) {
      const t = ev.target as Unit;
      if (t.s.maxMana <= 0) return;
      const pct = t.mana / t.s.maxMana * 100;
      const thr = val(a, 'mana_threshold');
      if (pct > thr) return;
      const k = 1 - pct / thr;
      const s = val(a, 'move_slow_min') + (val(a, 'move_slow_max') - val(a, 'move_slow_min')) * k;
      slow(ev.attacker as Unit, t, a, 'persecutor', val(a, 'slow_duration'), s / 100);
    },
  }),
});

defineAbility({
  key: 'antimage_mana_void', target: 'unit', ult: true, reflectable: true, ai: { role: 'nuke', hpBelow: 0.5 },
  aoe: (a) => val(a, 'mana_void_aoe_radius'),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const e = t.unit as Unit;
    const amount = Math.max(0, e.s.maxMana - e.mana) * dmg(a, 'mana_void_damage_per_mana');
    stun(u, e, val(a, 'mana_void_ministun'), a);
    const r = val(a, 'mana_void_aoe_radius');
    u.w.emit({ n: 'mana_void', x: e.x, y: e.y, r, t: u.team });
    for (const v of u.w.enemiesIn(u.team, e.x, e.y, r)) damage(u, v, amount, 'magical', a);
  },
});

defineHero('antimage', ['antimage_mana_break', 'antimage_blink', 'antimage_counterspell', 'antimage_persectur', 'antimage_mana_void'], {
  build: ['wraith_band', 'power_treads', 'bfury', 'manta', 'black_king_bar', 'skadi', 'butterfly'],
});
