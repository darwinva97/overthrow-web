import { ABILITIES, UNITS, lv } from '../data';
import { cooldownOf, defineAbility, defineHero, dmg, dur, hasShard, refreshPassive, val } from '../sim/abilities';
import { burnMana, damage, dealDamage } from '../sim/combat';
import type { AbilityImpl, AbilityInst, ModSpec } from '../sim/types';
import { ST } from '../sim/types';
import type { Unit } from '../sim/unit';
import { castDir, debuff, stun } from './util';
import { aiBy, botCast, type BotPick } from './lib/a2';

// ---------------- Habilidades de creeps que Devour puede robar ----------------

interface Stolen {
  kind: 'passive' | 'none' | 'unit' | 'point';
  /** Efecto al lanzarla desde el hueco de Doom. */
  cast?(u: Unit, slot: AbilityInst, sv: (k: string) => number, t: { unit?: Unit; x: number; y: number }): void;
  /** Modificador pasivo (auras, críticos). */
  passive?(u: Unit, slot: AbilityInst, sv: (k: string) => number): ModSpec;
  /** Para los bots: buscar objetivo. */
  pick?(u: Unit, sv: (k: string) => number): BotPick;
}

const enemyHeroNear = (u: Unit, r: number) => u.w.enemiesIn(u.team, u.x, u.y, r, { heroes: true })
  .filter((e) => !e.has(ST.magicImmune) && u.w.canSee(u.team, e))[0];

const auraOf = (name: string, props: (sv: (k: string) => number, t: Unit) => ModSpec['props']) =>
  (_u: Unit, _s: AbilityInst, sv: (k: string) => number): ModSpec => ({
    name: 'devoured_' + name,
    aura: { radius: sv('radius') || 1200, team: 'ally', includeSelf: true, apply: (_m, t) => ({ name, props: props(sv, t as Unit) }) },
  });

const STOLEN: Record<string, Stolen> = {
  centaur_khan_war_stomp: {
    kind: 'none',
    cast(u, slot, sv) {
      const r = sv('radius');
      u.w.emit({ n: 'hoof_stomp', x: u.x, y: u.y, r, t: u.team });
      for (const e of u.w.enemiesIn(u.team, u.x, u.y, r)) {
        damage(u, e, sv('abilitydamage'), 'magical', slot);
        stun(u, e, e.isHeroLike ? sv('hero_stun_duration') : sv('non_hero_stun_duration'), slot);
      }
    },
    pick: (u, sv) => (enemyHeroNear(u, sv('radius') - 30) ? {} : null),
  },
  giant_wolf_intimidate: {
    kind: 'none',
    cast(u, slot, sv) {
      for (const e of u.w.enemiesIn(u.team, u.x, u.y, sv('radius'))) {
        debuff(u, e, slot, { name: 'intimidate', duration: sv('duration'), fx: 'intimidate',
          onAttackStart(_m, ev) { ev.damage *= 1 - sv('damage_reduction') / 100; } });
      }
    },
    pick: (u, sv) => (enemyHeroNear(u, sv('radius') - 30) ? {} : null),
  },
  satyr_trickster_purge: {
    kind: 'unit',
    cast(u, slot, sv, t) {
      const e = t.unit;
      if (!e) return;
      if (e.team === u.team) { e.purge(true, false); return; }
      if (e.has(ST.magicImmune)) return;
      e.purge(false, true);
      if (e.kind === 'summon' || e.kind === 'illusion') damage(u, e, sv('summon_damage'), 'magical', slot);
      // Ralentización que se desvanece.
      debuff(u, e, slot, { name: 'satyr_purge', duration: sv('duration'), fx: 'slow',
        props: (m) => ({ msSlow: Math.max(0, m.remaining / sv('duration')) }), interval: 0.25,
        onInterval(m) { (m.owner as Unit).refreshStats(); } });
    },
    pick: (u, sv) => { const e = enemyHeroNear(u, sv('abilitycastrange') + 200); return e ? { unit: e } : null; },
  },
  satyr_soulstealer_mana_burn: {
    kind: 'unit',
    cast(u, slot, sv, t) {
      const e = t.unit;
      if (!e || e.team === u.team || e.has(ST.magicImmune)) return;
      const burned = burnMana(e, sv('burn_amount') + sv('int_multiplier') * e.s.int);
      u.w.emit({ n: 'manaburn', x: e.x, y: e.y, u: e.id });
      damage(u, e, burned, 'magical', slot);
    },
    pick: (u, sv) => { const e = enemyHeroNear(u, sv('abilitycastrange') + 200); return e && e.mana > 50 ? { unit: e } : null; },
  },
  satyr_hellcaller_shockwave: {
    kind: 'point',
    cast(u, slot, sv, t) {
      const [dx, dy] = castDir(u, t.x, t.y);
      u.w.addProjectile({
        kind: 'linear', fx: 'shockwave', source: u, x: u.x, y: u.y, dx, dy, speed: sv('speed'), left: sv('distance'),
        width: sv('radius_start') * 2, widthEnd: sv('radius_end') * 2,
        onHit(_p, e) { const v = e as Unit; if (v.team !== u.team && !v.has(ST.magicImmune)) damage(u, v, sv('abilitydamage'), 'magical', slot); },
      });
    },
    pick: (u, sv) => { const e = enemyHeroNear(u, sv('abilitycastrange') + 200); return e ? { unit: e, x: e.x, y: e.y } : null; },
  },
  kobold_taskmaster_speed_aura: { kind: 'passive', passive: auraOf('speed_aura', (sv) => ({ msPct: sv('bonus_movement_speed') / 100 })) },
  alpha_wolf_command_aura: { kind: 'passive', passive: auraOf('command_aura', (sv) => ({ damagePct: sv('bonus_damage_pct') / 100 })) },
  satyr_hellcaller_unholy_aura: { kind: 'passive', passive: auraOf('unholy_aura', (sv) => ({ hpRegen: sv('health_regen') })) },
  forest_troll_high_priest_mana_aura: { kind: 'passive', passive: auraOf('mana_aura', (sv) => ({ manaRegen: sv('mana_regen') })) },
  mudgolem_cloak_aura: {
    kind: 'passive',
    passive: auraOf('cloak_aura', (sv, t) => ({ magicResist: (t.isHeroLike ? sv('bonus_magical_armor') : sv('bonus_magical_armor_creeps')) / 100 })),
  },
  alpha_wolf_critical_strike: {
    kind: 'passive',
    passive: (_u, _s, sv) => ({
      name: 'devoured_crit',
      onAttackStart(m, ev) {
        if ((m.owner as Unit).w.rng() < sv('crit_chance') / 100) ev.critMult = Math.max(ev.critMult, sv('crit_mult') / 100);
      },
    }),
  },
  kobold_tunneler_prospecting: {
    kind: 'passive',
    passive: (_u, _s, sv) => ({
      name: 'devoured_prospecting', interval: 1,
      onInterval(m) {
        const u = m.owner as Unit;
        for (const h of u.w.alliesIn(u.team, u.x, u.y, sv('radius'), { heroes: true })) if (h.kind === 'hero') h.gold += sv('gpm_aura') / 60;
      },
    }),
  },
};

/** Valor de la habilidad robada: nivel de Devour, con las mejoras del Shard. */
function stolenValues(slot: AbilityInst): (k: string) => number {
  const u = slot.owner as Unit;
  const dev = u.abilities.find((x) => x.key === 'doom_bringer_devour');
  const key = slot.data.stolen as string;
  const level = Math.max(1, dev?.level ?? 1);
  const aoe = dev ? 1 + val(dev, 'bonus_aoe_pct') / 100 : 1;
  const amp = dev ? 1 + val(dev, 'bonus_spell_amp_pct') / 100 : 1;
  return (k: string) => {
    const v = lv(ABILITIES[key]?.values[k], level);
    if (/radius|distance/.test(k)) return v * aoe;
    if (/damage|burn_amount/.test(k) && !/reduction|pct/.test(k)) return v * amp;
    return v;
  };
}

/** Hueco vacío de Doom: hace de la habilidad robada a un creep. */
function emptySlot(key: string): AbilityImpl {
  return {
    key, target: 'unitOrPoint', team: 'any', allowSelf: true, ai: aiBy('nuke'),
    hidden: (a) => !a.data.stolen,
    castRange: (a) => {
      const st = STOLEN[a.data.stolen];
      if (!st) return 0;
      const sv = stolenValues(a);
      return st.kind === 'none' ? Math.max(100, sv('radius') - 50) : sv('abilitycastrange') || 600;
    },
    passive: (a) => {
      const st = STOLEN[a.data.stolen];
      if (!st) return null;
      const sv = stolenValues(a);
      if (st.kind === 'passive') return st.passive ? st.passive(a.owner as Unit, a, sv) : null;
      return botCast(a, (u) => {
        const def = ABILITIES[a.data.stolen];
        if (a.cd > 0 || u.mana < lv(def?.values._mc, 1)) return null;
        return st.pick ? st.pick(u, sv) : null;
      });
    },
    noIllusion: true,
    onSpellStart(a, t) {
      const u = a.owner as Unit;
      const st = STOLEN[a.data.stolen];
      if (!st || st.kind === 'passive' || !st.cast) return;
      const sv = stolenValues(a);
      const mc = sv('_mc');
      if (u.mana < mc) { u.w.error(u, 'Sin maná'); return; }
      u.mana -= mc;
      a.cd = sv('_cd') * (1 - u.s.cdr);
      st.cast(u, a, sv, { unit: t.unit as Unit | undefined, x: t.x, y: t.y });
    },
  };
}
defineAbility(emptySlot('doom_bringer_empty1'));
defineAbility(emptySlot('doom_bringer_empty2'));

const devourable = (u: Unit, c: Unit, a: AbilityInst) => c.alive && c.kind === 'creep' && c.team !== u.team &&
  (UNITS[c.name]?.level ?? 1) <= val(a, 'creep_level') && u.w.targetable(c);

defineAbility({
  key: 'doom_bringer_devour', target: 'unit', team: 'any', ai: aiBy('summon'),
  charges: (a) => (hasShard(a.owner as Unit) ? [val(a, 'abilitycharges'), val(a, 'abilitychargerestoretime')] : [1, cooldownOf(a)]),
  passive: (a) => botCast(a, (u) => {
    if (u.w.enemiesIn(u.team, u.x, u.y, 700, { heroes: true }).length) return null;
    let best: Unit | null = null, bs = -Infinity;
    for (const c of u.w.list) {
      if (!devourable(u, c, a)) continue;
      const d = Math.hypot(c.x - u.x, c.y - u.y);
      if (d > 1800) continue;
      const actives = (UNITS[c.name]?.abilities ?? []).filter((k) => STOLEN[k] && STOLEN[k].kind !== 'passive').length;
      const score = actives * 1000 - d;
      if (score > bs) { bs = score; best = c; }
    }
    return best ? { unit: best } : null;
  }),
  noIllusion: true,
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const c = t.unit as Unit;
    if (!devourable(u, c, a) || a.temp) { a.charges++; u.mana += val(a, '_mc'); return; }
    const stolen = (UNITS[c.name]?.abilities ?? []).filter((k) => STOLEN[k]);
    u.w.emit({ n: 'devour', x: c.x, y: c.y, u: c.id, u2: u.id });
    // Muere a manos de Doom: se lleva su recompensa y el oro extra.
    dealDamage({ source: u, target: c, amount: c.hp + 10, type: 'pure', ability: a, isAttack: false, hpRemoval: true, noProc: true });
    u.gold += val(a, 'bonus_gold');
    const digest = hasShard(u) ? val(a, 'abilitychargerestoretime') : cooldownOf(a);
    u.addMod({ name: 'devour', duration: digest, fx: 'devour', props: { magicResist: val(a, 'magic_resist') / 100 } }, u, a);
    // Las habilidades robadas se quedan hasta el siguiente Devour.
    if (!stolen.length) return;
    const slots = u.abilities.filter((x) => x.key === 'doom_bringer_empty1' || x.key === 'doom_bringer_empty2');
    slots.forEach((s, i) => {
      s.data.stolen = stolen[i] ?? null;
      s.level = s.data.stolen ? 1 : 0;
      s.cd = 0;
      refreshPassive(s);
    });
  },
});

defineAbility({
  key: 'doom_bringer_scorched_earth', target: 'none', ai: { role: 'aoe', selfRadius: 600 },
  onSpellStart(a) {
    const u = a.owner as Unit;
    const permanent = val(a, 'is_permanent') > 0;
    const r = val(a, 'radius');
    u.addMod({
      name: 'scorched_earth', duration: permanent ? Infinity : dur(a, 'duration'), fx: 'scorched_earth', interval: 1,
      persistent: permanent,
      props: { hpRegen: val(a, 'bonus_health_regen'), msPct: val(a, 'bonus_movement_speed_pct') / 100 },
      onInterval(m) {
        const v = m.owner as Unit;
        if (!v.alive) return;
        for (const e of v.w.enemiesIn(v.team, v.x, v.y, r)) damage(u, e, dmg(a, 'damage_per_second'), 'magical', a, { noProc: true });
      },
    }, u, a);
  },
});

// Orbe con autocast: interruptor; los bots lo usan siempre.
defineAbility({
  key: 'doom_bringer_infernal_blade', target: 'toggle',
  passive: (a) => ({
    name: 'infernal_blade',
    onAttackStart(m, ev) {
      const u = ev.attacker as Unit;
      const t = ev.target as Unit;
      m.data.proc = 0;
      if (ev.fake || u.kind !== 'hero' || !(a.toggled || u.isBot) || a.cd > 0 || u.has(ST.silenced)) return;
      if (t.team === u.team || !(t.isHeroLike || t.kind === 'creep' || t.kind === 'summon')) return;
      const mc = val(a, '_mc');
      if (u.mana < mc) return;
      u.mana -= mc;
      a.cd = cooldownOf(a);
      m.data.proc = t.id;
    },
    onAttackLanded(m, ev) {
      const u = ev.attacker as Unit;
      const t = ev.target as Unit;
      if (m.data.proc !== t.id) return;
      m.data.proc = 0;
      if (t.has(ST.magicImmune)) return;
      stun(u, t, val(a, 'ministun_duration'), a);
      debuff(u, t, a, {
        name: 'infernal_blade', duration: val(a, 'burn_duration'), fx: 'burn', interval: 1,
        onInterval(mm) {
          const v = mm.owner as Unit;
          damage(u, v, dmg(a, 'burn_damage') + v.s.maxHp * val(a, 'burn_damage_pct') / 100, 'magical', a, { noProc: true });
        },
      });
    },
  }),
  onToggle() {},
});

/** Efectos de Doom sobre una unidad. */
function doomSpec(a: AbilityInst, duration: number): ModSpec {
  const u = a.owner as Unit;
  let states = ST.silenced | ST.disarmedSpells;
  if (val(a, 'does_break') > 0) states |= ST.broken;
  if (val(a, 'does_mute') > 0) states |= ST.muted;
  return {
    name: 'doom', duration, fx: 'doom', states, purgable: false, interval: 1,
    props: { hpRegenAmp: -1 },
    onInterval(m) { damage(u, m.owner as Unit, dmg(a, 'damage'), 'pure', a, { noProc: true }); },
  };
}

defineAbility({
  key: 'doom_bringer_doom', target: 'unit', team: 'any', allowSelf: true, ult: true, reflectable: true, ai: { role: 'disable' },
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const e = (t.unit as Unit) ?? u;
    const d = dur(a, 'duration');
    const spread = val(a, 'scepter_aura_radius');
    // Scepter sobre sí mismo: Doom a los enemigos que le rodean.
    if (e === u) {
      if (!spread) { a.cd = 0; u.mana += val(a, '_mc'); return; }
      u.addMod({
        name: 'doom_self', duration: d, fx: 'doom',
        aura: { radius: spread, team: 'enemy', apply: () => ({ ...doomSpec(a, 0.5), name: 'doom', debuff: true }) },
      }, u, a);
      return;
    }
    if (e.team === u.team) { a.cd = 0; u.mana += val(a, '_mc'); return; }
    e.purge(false, true);
    const m = debuff(u, e, a, doomSpec(a, d));
    if (!m) return;
    if (e.cast?.phase === 2) e.w.interruptCast(e, true);
    // Scepter: los aliados del condenado cerca también lo sufren.
    if (spread > 0) {
      m.aura = { radius: spread, team: 'ally', includeSelf: false, apply: () => ({ ...doomSpec(a, 0.5), name: 'doom_spread', debuff: true }) };
    }
  },
});

defineAbility({
  key: 'doom_bringer_lvl_pain', target: 'passive', innate: true,
  passive: (a) => ({
    name: 'lvl_pain',
    onAttackLanded(m, ev) {
      const u = m.owner as Unit;
      const t = ev.target as Unit;
      if (t.kind !== 'hero' || t.team === u.team || t.findMod('lvl_pain_curse', u)) return;
      const strong = t.level % val(a, 'level_multiplier') === 0;
      const mult = strong ? 1 + val(a, 'bonus_at_level_pct') / 100 : 1;
      t.addMod({
        name: 'lvl_pain_curse', duration: val(a, 'damage_debuff_duration'), debuff: true, purgable: false, fx: 'lvl_pain',
        data: { taken: 0 },
        onTakeDamage(cm, dev) { if (dev.source === u || (dev.source as Unit | null)?.owner === u) cm.data.taken += dev.amount; },
        onDestroy(cm) {
          const v = cm.owner as Unit;
          if (cm.remaining > 0.0001 || !v.alive) return;
          const amt = cm.data.taken * val(a, 'bonus_damage_pct_base') / 100 * mult;
          if (amt <= 0) return;
          const r = val(a, 'spread_radius') * mult;
          v.w.emit({ n: 'lvl_pain', x: v.x, y: v.y, r, t: u.team });
          for (const x of v.w.enemiesIn(u.team, v.x, v.y, r)) damage(u, x, amt, 'pure', a, { noProc: true });
        },
      }, u, a);
    },
  }),
});

defineHero('doom_bringer', ['doom_bringer_devour', 'doom_bringer_scorched_earth', 'doom_bringer_infernal_blade', 'doom_bringer_empty1', 'doom_bringer_empty2', 'doom_bringer_doom', 'doom_bringer_lvl_pain'], {
  build: ['bracer', 'phase_boots', 'blink', 'black_king_bar', 'shivas_guard', 'heart', 'ultimate_scepter', 'refresher'],
  upgrades: [
    { slot: 0, key: 'bonus_gold', amount: 25, max: 5, label: 'Devour: +25 de oro' },
    { slot: 1, key: 'damage_per_second', amount: 12, max: 5, label: 'Scorched Earth: +12 daño por segundo' },
    { slot: 2, key: 'burn_damage_pct', amount: 0.5, max: 5, label: 'Infernal Blade: +0,5% de la vida máxima' },
    { slot: 5, key: 'damage', amount: 12, max: 5, label: 'Doom: +12 daño por segundo' },
    { slot: 5, key: 'duration', amount: 1, max: 4, label: 'Doom: +1 s' },
  ],
});
