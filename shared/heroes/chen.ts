import { UNITS } from '../data';
import { defineAbility, defineHero, dmg, dur, hasScepter, hasTalent, val } from '../sim/abilities';
import { damage, heal } from '../sim/combat';
import type { AbilityInst } from '../sim/types';
import { ST } from '../sim/types';
import type { Unit } from '../sim/unit';
import { slow } from './util';
import { aiBy, alliesNear, botCast } from './lib/a2';

/** Unidades de Chen: creeps convertidos y zealots. */
const chenUnits = (u: Unit) => u.w.list.filter((c) => c.alive && c.owner === u && (c.data_chen || c.data_zealot));
const persuaded = (u: Unit) => u.w.list.filter((c) => c.alive && c.owner === u && c.data_chen);

/** IA de las unidades de Chen cuando Chen es un bot: atacan a su objetivo y le siguen. */
function followAi(c: Unit, owner: Unit) {
  c.addMod({
    name: 'chen_unit_ai', persistent: true, interval: 0.5,
    onInterval(m) {
      const v = m.owner as Unit;
      if (!owner.isBot || !v.alive || v.cast) return;
      const tgt = owner.ai?.target ? v.w.units.get(owner.ai.target) : null;
      if (tgt && tgt.alive && v.w.targetable(tgt) && Math.hypot(tgt.x - v.x, tgt.y - v.y) < 1200) {
        if (v.order?.type !== 'attack' || v.order.target !== tgt.id) v.w.issueOrder(v, { type: 'attack', target: tgt.id });
        return;
      }
      if (Math.hypot(owner.x - v.x, owner.y - v.y) > 450) {
        v.w.issueOrder(v, { type: 'move', x: owner.x + (v.id % 3 - 1) * 80, y: owner.y + 60 });
      }
    },
  }, owner, null);
}

defineAbility({
  key: 'chen_penitence', target: 'unit', reflectable: true, ai: { role: 'disable' },
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const e = t.unit as Unit;
    u.w.addProjectile({
      kind: 'track', fx: 'penitence', source: u, target: e, x: u.x, y: u.y, speed: val(a, 'speed'), dodgeable: true,
      onHit() {
        if (e.has(ST.magicImmune) && e.team !== u.team) return true;
        damage(u, e, dmg(a, 'damage'), 'pure', a);
        slow(u, e, a, 'penitence', dur(a, 'duration'), Math.abs(val(a, 'bonus_movement_speed')) / 100, 0, {});
        const m = e.findMod('penitence', u);
        if (m) {
          // Los aliados de Chen que le atacan ganan velocidad de ataque.
          m.interval = 0.2;
          m.onInterval = (mm) => {
            const v = mm.owner as Unit;
            for (const al of v.w.list) {
              if (!al.alive || al.team !== u.team || al.atk.target !== v.id) continue;
              if (Math.hypot(al.x - v.x, al.y - v.y) > al.s.attackRange + 300) continue;
              al.addMod({ name: 'penitence_haste', duration: 0.3, props: { attackSpeed: val(a, 'bonus_attack_speed') } }, u, a);
            }
          };
        }
        return true;
      },
    });
  },
});

defineAbility({
  key: 'chen_holy_persuasion', target: 'unit', team: 'any', ai: aiBy('summon'),
  passive: (a) => botCast(a, (u) => {
    if (persuaded(u).length >= val(a, 'max_units')) return null;
    let best: Unit | null = null, bd = 1600;
    for (const c of u.w.list) {
      if (!c.alive || c.kind !== 'creep' || c.team === u.team || !u.w.targetable(c)) continue;
      if ((UNITS[c.name]?.level ?? 1) > val(a, 'level_req')) continue;
      const d = Math.hypot(c.x - u.x, c.y - u.y);
      if (d < bd) { bd = d; best = c; }
    }
    return best ? { unit: best } : null;
  }),
  noIllusion: true,
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const c = t.unit as Unit;
    // Sobre un creep propio: lo retira (si no ha recibido daño) y reduce el enfriamiento.
    if (c.owner === u && c.data_chen) {
      if (u.w.time - c.lastDamageAt >= val(a, 'unsummon_time')) {
        u.w.emit({ n: 'blink', x: c.x, y: c.y, u: c.id });
        c.alive = false; c.hp = 0;
        u.w.removeLater(c, 0.1);
        a.cd = Math.max(0, a.cd - val(a, 'unsummon_cooldown_reduction'));
      }
      return;
    }
    const lvl = UNITS[c.name]?.level ?? 1;
    if (c.kind !== 'creep' || c.team === u.team || lvl > val(a, 'level_req') || a.temp) { a.cd = 0; u.mana += val(a, '_mc'); return; }
    // Máximo de unidades: la más antigua muere.
    const mine = persuaded(u).sort((x, y) => (x.data_chenAt ?? 0) - (y.data_chenAt ?? 0));
    while (mine.length >= val(a, 'max_units')) { const old = mine.shift()!; damage(null, old, old.hp + 1, 'pure', null, { hpRemoval: true }); }
    u.gold += Math.round(c.bountyGold * val(a, 'gold_pct') / 100);
    c.team = u.team; c.kind = 'summon'; c.owner = u; c.playerId = u.playerId; c.home = null;
    c.order = null; c.atk.target = 0; c.data_chen = true; c.data_chenAt = u.w.time;
    c.purge(true, true);
    if (c.s.maxHp < val(a, 'health_min')) c.base = { ...c.base, hp: c.base.hp + val(a, 'health_min') - c.s.maxHp };
    c.addMod({
      name: 'holy_persuasion', persistent: true, fx: 'persuaded',
      props: { msPct: val(a, 'movement_speed_bonus') / 100, damagePct: val(a, 'damage_bonus') / 100 },
    }, u, a);
    c.refreshStats(); c.hp = c.s.maxHp;
    u.w.emit({ n: 'persuade', x: c.x, y: c.y, u: c.id, u2: u.id });
    followAi(c, u);
  },
});

/** Divine Favor sobre una unidad. */
function favor(a: AbilityInst, t: Unit) {
  const u = a.owner as Unit;
  t.addMod({
    name: 'divine_favor', duration: dur(a, 'duration'), fx: 'divine_favor',
    props: { armor: val(a, 'bonus_armor'), healAmp: val(a, 'heal_amp') / 100 },
  }, u, a);
}

defineAbility({
  key: 'chen_divine_favor', target: 'unit', team: 'ally', allowSelf: true, ai: aiBy('heal'),
  passive: (a) => botCast(a, (u) => {
    const low = alliesNear(u, u.x, u.y, 1200).filter((v) => v.kind === 'hero' && v.hp / v.s.maxHp < 0.6)
      .sort((x, y) => x.hp / x.s.maxHp - y.hp / y.s.maxHp)[0];
    if (low) return { unit: low };
    if (u.w.enemiesIn(u.team, u.x, u.y, 700, { heroes: true }).length && chenUnits(u).length) return { unit: u };
    return null;
  }, {
    name: 'divine_favor_aura',
    aura: {
      radius: val(a, 'aura_radius'), team: 'ally', includeSelf: true,
      apply: (_m, t) => ({ name: 'divine_favor_regen', props: { hpRegen: val(a, 'heal_rate') * (t.isHeroLike ? 1 : val(a, 'creep_bonus')) } }),
    },
  }),
  noIllusion: true,
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const e = (t.unit as Unit) ?? u;
    favor(a, e);
    if (e === u) for (const c of chenUnits(u)) favor(a, c);
  },
});

/** Zealots: invocaciones permanentes de Chen que reaparecen al morir. */
function spawnZealot(a: AbilityInst) {
  const u = a.owner as Unit;
  const ang = u.w.rng() * Math.PI * 2;
  const z = u.w.spawnSummon(u, 'chen_zealot', u.x + Math.cos(ang) * 150, u.y + Math.sin(ang) * 150, Infinity, { bounty: UNITS.chen_zealot?.bountyGold });
  z.data_zealot = true;
  const hpPct = val(a, 'bonus_hp') / 100;
  z.addMod({
    name: 'zealot', persistent: true,
    props: { hp: z.base.hp * hpPct, damagePct: hasTalent(u, 'special_bonus_unique_chen_zealot') ? 0.25 : 0 },
  }, u, a);
  z.refreshStats(); z.hp = z.s.maxHp;
  followAi(z, u);
  // IA del zealot: se sacrifica con poca vida si hay un héroe enemigo cerca.
  z.addMod({
    name: 'zealot_ai', persistent: true, interval: 0.4,
    onInterval(m) {
      const v = m.owner as Unit;
      if (!u.isBot || v.cast || v.hp / v.s.maxHp > 0.35) return;
      const mart = v.abilities.find((x) => x.key === 'chen_martyrdom');
      const e = v.w.enemiesIn(v.team, v.x, v.y, 500, { heroes: true })[0];
      if (mart && e && !v.w.castCheck(v, mart)) v.w.issueOrder(v, { type: 'cast', slot: mart.slot, target: e.id });
    },
  }, u, a);
  return z;
}

defineAbility({
  key: 'chen_zealot', target: 'unit', team: 'ally', allowSelf: true, innate: true, ai: aiBy('summon'),
  castRange: () => 99999,
  passive: (a) => botCast(a, (u) => {
    const z = u.w.list.find((c) => c.alive && c.owner === u && c.data_zealot);
    return z && Math.hypot(z.x - u.x, z.y - u.y) > 900 ? { unit: u } : null;
  }, {
    name: 'zealot_keeper', interval: 0.5,
    onInterval(m) {
      const u = m.owner as Unit;
      if (!u.alive || u.kind !== 'hero') return;
      const alive = u.w.list.filter((c) => c.alive && c.owner === u && c.data_zealot).length;
      const want = val(a, 'zealots');
      if (alive >= want) { a.data.deadAt = 0; return; }
      // Reaparece pasado su tiempo (el primero sale al momento).
      if (a.data.spawned && !a.data.deadAt) a.data.deadAt = u.w.time;
      if (!a.data.spawned || u.w.time - a.data.deadAt >= val(a, 'zealot_respawn_time')) {
        a.data.spawned = true; a.data.deadAt = 0;
        spawnZealot(a);
      }
    },
  }),
  noIllusion: true,
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const e = (t.unit as Unit) ?? u;
    const zs = u.w.list.filter((c) => c.alive && c.owner === u && c.data_zealot);
    for (const z of zs) {
      z.addMod({ name: 'zealot_teleport', duration: val(a, 'teleport_delay'), fx: 'teleport' }, u, a);
      u.w.emit({ n: 'teleport', x: z.x, y: z.y, x2: e.x, y2: e.y, u: z.id, d: val(a, 'teleport_delay') });
    }
    u.w.after(val(a, 'teleport_delay'), () => {
      for (const z of zs) if (z.alive && e.alive) { u.w.teleport(z, e.x + 80, e.y); z.order = null; }
    });
  },
});

// Habilidad del Zealot.
defineAbility({
  key: 'chen_martyrdom', target: 'unit', team: 'any', ai: { role: 'nuke', hpBelow: 0.4 },
  onSpellStart(a, t) {
    const z = a.owner as Unit;
    const e = t.unit as Unit;
    const value = val(a, 'base_value') + z.hp * val(a, 'current_hp_pct') / 100;
    const owner = (z.owner as Unit) ?? z;
    z.w.addProjectile({
      kind: 'track', fx: 'martyrdom', source: z, target: e, x: z.x, y: z.y, speed: val(a, 'speed'),
      onHit() {
        if (e.team === z.team) heal(e, value * val(a, 'heal_factor') / 100, owner);
        else damage(owner, e, value, 'magical', a);
        return true;
      },
    });
    damage(null, z, z.hp + 1, 'pure', null, { hpRemoval: true });
  },
});

defineAbility({
  key: 'chen_hand_of_god', target: 'none', ult: true, ai: aiBy('heal'),
  channel: (a) => (hasScepter(a.owner as Unit) ? val(a, 'abilitychanneltime') : 0),
  passive: (a) => botCast(a, (u) => {
    const heroes = u.w.list.filter((v) => v.alive && v.team === u.team && v.kind === 'hero');
    return heroes.some((v) => v.hp / v.s.maxHp < 0.35 && v.w.enemiesIn(v.team, v.x, v.y, 900, { heroes: true }).length) ? {} : null;
  }),
  noIllusion: true,
  onSpellStart(a) {
    const u = a.owner as Unit;
    const targets = [...u.w.list.filter((v) => v.alive && v.team === u.team && v.kind === 'hero'), ...chenUnits(u)];
    const full = val(a, 'full_heal_on_chen_and_creeps') > 0;
    const purge = val(a, 'does_purge') > 0;
    u.w.emit({ n: 'hand_of_god', x: u.x, y: u.y, u: u.id, t: u.team });
    for (const v of targets) {
      if (purge) v.purge(true, false, true);
      if (full && (v === u || v.owner === u)) heal(v, v.s.maxHp, u);
      else heal(v, dmg(a, 'heal_amount'), u);
      v.addMod({
        name: 'hand_of_god', duration: val(a, 'hot_duration'), fx: 'heal', interval: 0.25,
        onInterval(m) {
          const w = m.owner as Unit;
          const boosted = u.cast?.a === a && Math.hypot(w.x - u.x, w.y - u.y) <= val(a, 'debuff_immune_radius');
          heal(w, val(a, 'heal_per_second') * 0.25 * (boosted ? 1 + val(a, 'nearby_hot_boost') / 100 : 1), u, true);
        },
      }, u, a);
    }
  },
  onChannelTick(a) {
    // Scepter: aliados cercanos inmunes a debuffs con resistencia mágica.
    const u = a.owner as Unit;
    for (const v of alliesNear(u, u.x, u.y, val(a, 'debuff_immune_radius'), false)) {
      if (v === u) continue;
      v.addMod({ name: 'hand_of_god_immunity', duration: 0.2, fx: 'bkb', states: ST.magicImmune,
        props: { magicResist: val(a, 'debuff_immune_resist') / 100 } }, u, a);
    }
  },
});

defineHero('chen', ['chen_penitence', 'chen_holy_persuasion', 'chen_divine_favor', 'chen_zealot', 'chen_hand_of_god'], {
  build: ['null_talisman', 'arcane_boots', 'mekansm', 'force_staff', 'glimmer_cape', 'guardian_greaves', 'pipe', 'ultimate_scepter'],
  upgrades: [
    { slot: 0, key: 'damage', amount: 40, max: 5, label: 'Penitence: +40 daño' },
    { slot: 1, key: 'max_units', amount: 1, max: 2, label: 'Holy Persuasion: +1 creep' },
    { slot: 1, key: 'damage_bonus', amount: 8, max: 5, label: 'Holy Persuasion: +8% daño de creeps' },
    { slot: 2, key: 'bonus_armor', amount: 3, max: 5, label: 'Divine Favor: +3 armadura' },
    { slot: 4, key: 'heal_amount', amount: 75, max: 5, label: 'Hand of God: +75 curación' },
  ],
});
