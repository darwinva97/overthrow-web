import { defineAbility, defineHero, dmg, dur, hasScepter, hasShard, isItem, val } from '../sim/abilities';
import { damage, heal } from '../sim/combat';
import type { AbilityInst, Modifier } from '../sim/types';
import { ST } from '../sim/types';
import { ATTR, type Unit } from '../sim/unit';
import { debuff, push } from './util';
import { nearestEnemyHero } from './lib/a3';

/** Coste de vida: daño mágico a uno mismo que no puede matar (Blood Magic). */
function hpCost(u: Unit, amount: number, a: AbilityInst | null) {
  if (amount <= 0 || !u.alive) return;
  damage(u, u, amount, 'magical', a, { noProc: true, data: { nonLethal: true, hpCost: true } });
}

defineAbility({
  key: 'huskar_inner_fire', target: 'none', ai: { role: 'disable', selfRadius: 380 },
  aoe: (a) => val(a, 'radius'),
  onSpellStart(a) {
    const u = a.owner as Unit;
    hpCost(u, val(a, 'health_cost'), a);
    const r = val(a, 'radius');
    const far = val(a, 'knockback_distance');
    u.w.emit({ n: 'berserkers_call', x: u.x, y: u.y, r, u: u.id, t: u.team });
    for (const e of u.w.enemiesIn(u.team, u.x, u.y, r)) {
      damage(u, e, dmg(a, 'damage'), 'magical', a);
      if (!e.alive) continue;
      debuff(u, e, a, { name: 'inner_fire_disarm', duration: dur(a, 'disarm_duration'), states: ST.disarmed, fx: 'silence' });
      // Los empuja hasta una distancia fija de Huskar.
      const d = Math.hypot(e.x - u.x, e.y - u.y);
      const dist = Math.max(val(a, 'min_knockback_distance'), far - d);
      const time = Math.max(val(a, 'min_knockback_duration'), val(a, 'knockback_duration') * dist / far);
      const dx = d < 1 ? Math.cos(u.facing) : e.x - u.x, dy = d < 1 ? Math.sin(u.facing) : e.y - u.y;
      push(e, dx, dy, dist, time, u, a, 'inner_fire_knockback');
    }
  },
});

// Orbe con autocast: cada ataque cuesta vida y deja una carga de quemadura independiente.
defineAbility({
  key: 'huskar_burning_spear', target: 'toggle',
  passive: (a) => ({
    name: 'burning_spear_orb', interval: 0.3,
    onInterval(m) { if ((m.owner as Unit).isBot && !a.toggled) a.toggled = true; },
    onAttackStart(m, ev) {
      const u = m.owner as Unit, t = ev.target as Unit;
      if (!a.toggled || ev.fake || t.team === u.team || !(t.isHeroLike || t.kind === 'creep' || t.kind === 'summon')) return;
      (ev as any).spear = true;
      hpCost(u, u.s.maxHp * val(a, 'max_health_cost') / 100, a);
    },
    onAttackLanded(m, ev) {
      if (!(ev as any).spear) return;
      const u = m.owner as Unit, t = ev.target as Unit;
      const d = val(a, 'duration');
      const until = u.w.time + d * (1 - t.s.statusResist);
      const cur = t.findMod('burning_spear', u);
      if (cur) {
        cur.data.until.push(until);
        cur.remaining = Math.max(cur.remaining, until - u.w.time);
        cur.stacks = cur.data.until.length;
        return;
      }
      debuff(u, t, a, {
        name: 'burning_spear', duration: d, interval: 1, fx: 'fiery_soul', data: { until: [until] },
        onTick(mm) {
          const now = (mm.owner as Unit).w.time;
          mm.data.until = mm.data.until.filter((x: number) => x > now);
          mm.stacks = mm.data.until.length;
        },
        onInterval(mm) {
          if (mm.stacks > 0) damage(u, mm.owner as Unit, dmg(a, 'burn_damage') * mm.stacks, 'magical', a, { noProc: true });
        },
      });
    },
  }),
});

// Pasiva por vida perdida; con Shard además es activable (cauterizar).
defineAbility({
  key: 'huskar_berserkers_blood', target: 'none',
  passive: (a) => ({
    name: 'berserkers_blood', interval: 0.1, data: { botAt: 0 },
    props: (m) => {
      const u = m.owner as Unit;
      if (!u || u.has(ST.broken)) return {};
      const thr = val(a, 'hp_threshold_max') / 100;
      const k = Math.max(0, Math.min(1, (1 - u.hp / u.s.maxHp) / (1 - thr)));
      return {
        attackSpeed: k * val(a, 'maximum_attack_speed'),
        magicResist: k * val(a, 'maximum_magic_resist') / 100,
        hpRegen: k * val(a, 'maximum_health_regen') / 100 * u.s.str,
      };
    },
    onInterval(m) {
      const u = m.owner as Unit;
      u.refreshStats();
      // Bots: cauterizan con el Shard cuando van mal de vida o llevan debuffs.
      if (!u.isBot || u.kind !== 'hero' || !hasShard(u) || u.cast || u.w.time < m.data.botAt) return;
      m.data.botAt = u.w.time + 0.4;
      if (u.w.castCheck(u, a)) return;
      const debuffs = u.mods.filter((x) => x.debuff && x.purgable).length;
      if ((u.hp / u.s.maxHp < 0.45 || debuffs >= 2) && nearestEnemyHero(u, 1000)) u.w.issueOrder(u, { type: 'cast', slot: a.slot });
    },
  }),
  onSpellStart(a) {
    const u = a.owner as Unit;
    if (!hasShard(u) || val(a, 'activatable') <= 0) { a.cd = 0; return; }
    const cost = u.hp * val(a, 'activation_healthcost_pct') / 100;
    hpCost(u, cost, a);
    const n = u.mods.filter((x) => x.debuff && x.purgable).length;
    u.purge(true, false);
    a.cd = val(a, 'activation_cooldown') * a.upg.cd * (1 - u.s.cdr);
    u.addMod({
      name: 'berserkers_blood_cauterize', duration: val(a, 'activation_delay'), fx: 'fiery_soul',
      onDestroy(m) {
        const o = m.owner as Unit;
        if (o.alive) heal(o, cost + o.s.maxHp * n * val(a, 'activation_heal_pct_per_debuff') / 100, o);
      },
    }, u, a);
  },
});

// Sin maná: el maná máximo es justo el del objeto más caro y los costes se pagan con vida.
defineAbility({
  key: 'huskar_blood_magic', target: 'passive', innate: true,
  passive: () => ({
    name: 'blood_magic',
    props: (m: Modifier) => {
      const u = m.owner as Unit;
      if (!u) return {};
      let need = 0;
      for (const s of [0, 1, 2, 3, 4, 5, 9]) need = Math.max(need, u.items[s]?.def.mc ?? 0);
      let other = 0;
      for (const o of u.mods) {
        if (o === m || !o.props) continue;
        const p = typeof o.props === 'function' ? o.props(o) : o.props;
        other += p.mana ?? 0;
      }
      return { mana: need - u.base.mana - u.s.int * ATTR.manaPerInt - other };
    },
    onTick(m) {
      const u = m.owner as Unit;
      if (u.mana < u.s.maxMana) u.mana = u.s.maxMana;
    },
    onAbilityExecuted(m, ab) {
      if (isItem(ab) && ab.def.mc > 0) hpCost(m.owner as Unit, ab.def.mc, null);
    },
  }),
});

defineAbility({
  key: 'huskar_life_break', target: 'unit', ult: true, ai: { role: 'nuke' },
  castRange: (a) => val(a, 'abilitycastrange') + val(a, 'cast_range_bonus'),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const e = t.unit as Unit;
    const speed = val(a, 'charge_speed');
    u.order = null; u.path = [];
    u.w.disjoint(u);
    // Salto que persigue al objetivo; durante el salto, inmune a debuffs y 60% de resistencia.
    u.addMod({
      name: 'life_break_charge', duration: 3, fx: 'berserk',
      states: ST.busy | ST.noCollision | ST.magicImmune,
      props: { magicResist: val(a, 'immunity_resist') / 100 },
      onTick(m, dt) {
        if (!e.alive || !u.w.targetable(e)) { m.remaining = 0.001; return; }
        const d = Math.hypot(e.x - u.x, e.y - u.y);
        const reach = u.radius + e.radius + 20;
        if (d <= reach + speed * dt) {
          m.remaining = 0.001;
          m.data.hit = true;
          return;
        }
        u.facing = Math.atan2(e.y - u.y, e.x - u.x);
        u.w.forceMove(u, u.x + (e.x - u.x) / d * speed * dt, u.y + (e.y - u.y) / d * speed * dt);
      },
      onDestroy(m) {
        if (!m.data.hit || !u.alive || !e.alive) return;
        u.w.emit({ n: 'culling_blade', x: e.x, y: e.y, u: e.id });
        damage(u, e, e.hp * val(a, 'health_damage') * a.upg.dmg, 'magical', a);
        hpCost(u, u.hp * val(a, 'health_cost_percent'), a);
        if (!e.alive) return;
        debuff(u, e, a, {
          name: 'life_break_slow', duration: dur(a, 'abilityduration'), fx: 'slow',
          props: { msSlow: Math.abs(val(a, 'movespeed')) / 100, attackSlow: val(a, 'attack_speed') },
        });
        if (hasScepter(u) && val(a, 'taunt_duration') > 0) {
          const tm = debuff(u, e, a, { name: 'taunt', duration: val(a, 'taunt_duration'), states: ST.taunted, fx: 'taunt' });
          if (tm && e.cast) e.w.interruptCast(e, true);
        }
        u.w.issueOrder(u, { type: 'attack', target: e.id });
      },
    }, u, a);
  },
});

defineHero('huskar', ['huskar_inner_fire', 'huskar_burning_spear', 'huskar_berserkers_blood', 'huskar_blood_magic', 'huskar_life_break'], {
  build: ['bracer', 'power_treads', 'armlet', 'dragon_lance', 'black_king_bar', 'satanic', 'heavens_halberd', 'hurricane_pike'],
});
