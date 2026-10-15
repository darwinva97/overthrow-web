import { UNITS } from '../data';
import { cooldownOf, defineAbility, defineHero, dmg, dur, manaCostOf, val } from '../sim/abilities';
import { damage, heal, landAttack, makeAttack } from '../sim/combat';
import type { AbilityInst, AttackEvent } from '../sim/types';
import { ST } from '../sim/types';
import type { Unit } from '../sim/unit';
import { NEUTRAL } from '../sim/world';
import { botCast, botCommand, nearestEnemyHero } from './lib/a3';
import { dash, debuff, root, slow } from './util';

// Rabble-Rouser no trae damage_amp en el dataset: valor de 7.39 como respaldo.
const RABBLE_AMP_FALLBACK = 10;

const impetusOf = (u: Unit) => u.abilities.find((x) => x.key === 'enchantress_impetus');

/** Criaturas controladas por Enchant. */
function enchanted(u: Unit): Unit[] {
  return u.w.list.filter((s) => s.alive && s.owner === u && s.data_enchanted);
}

/** Daño de Impetus según la distancia (se aplica al impactar). */
function impetusHit(imp: AbilityInst, ev: AttackEvent) {
  const u = ev.attacker as Unit, t = ev.target as Unit;
  if (!t.alive || t.team === u.team) return;
  const d = Math.min(ev.distance, val(imp, 'distance_cap'));
  let amount = d * val(imp, 'distance_damage_pct') / 100 * imp.upg.dmg;
  if (t.kind === 'illusion') amount *= val(imp, 'illusion_damage_multiplier');
  u.w.emit({ n: 'impetus', x: t.x, y: t.y, u: t.id });
  damage(u, t, amount, 'pure', imp);
}

/** Ataque extra con Impetus garantizado (Sproink). */
function impetusShot(u: Unit, t: Unit) {
  const ev = makeAttack(u, t, true);
  const imp = impetusOf(u);
  if (imp && imp.level > 0) (ev as any).impetus = imp;
  u.w.addProjectile({
    kind: 'track', fx: 'attack:enchantress', source: u, target: t, x: u.x, y: u.y,
    speed: u.base.projSpeed, dodgeable: true,
    onHit: () => { landAttack(ev); return true; },
  });
}

// Impetus: autocast tipo orbe; enfriamiento por disparo en niveles bajos.
defineAbility({
  key: 'enchantress_impetus', target: 'toggle',
  passive: (a) => ({
    name: 'impetus',
    onAttackStart(_m, ev) {
      const u = ev.attacker as Unit;
      if (ev.fake || u.kind === 'illusion') return;
      if (u.isBot) a.toggled = true;
      const t = ev.target as Unit;
      if (!a.toggled || a.cd > 0 || t.team === u.team || !(t.isHeroLike || t.kind === 'creep' || t.kind === 'summon')) return;
      if (u.has(ST.silenced) || u.mana < manaCostOf(a)) return;
      u.mana -= manaCostOf(a);
      a.cd = cooldownOf(a);
      (ev as any).impetus = a;
    },
    onAttackLanded(_m, ev) {
      const imp = (ev as any).impetus as AbilityInst | undefined;
      if (imp) impetusHit(imp, ev);
    },
  }),
});

defineAbility({
  key: 'enchantress_enchant', target: 'unit', reflectable: true, ai: { role: 'disable' },
  // Bonos de talento para ella misma (+armadura, +vel. ataque, +vida/daño).
  passive: (a) => ({
    name: 'enchant_talents',
    props: { armor: val(a, 'bonus_armor'), attackSpeed: val(a, 'bonus_attackspeed'), hp: val(a, 'bonus_health'), damage: val(a, 'bonus_damage') },
    interval: 0.5,
    onInterval(m) {
      const u = m.owner as Unit;
      if (!u.isBot || !u.alive || u.cast || u.kind !== 'hero') return;
      botCommand(u, enchanted(u));
      // Fuera de pelea, el bot se adueña de un neutral.
      if (u.w.castCheck(u, a) || nearestEnemyHero(u, 1200) || enchanted(u).length >= val(a, 'max_creeps')) return;
      const c = u.w.list.find((e) => e.alive && e.kind === 'creep' && e.team === NEUTRAL && u.w.targetable(e) &&
        Math.hypot(e.x - u.x, e.y - u.y) < 900 && (UNITS[e.name]?.level ?? 1) <= val(a, 'level_req'));
      if (c) u.w.issueOrder(u, { type: 'cast', slot: a.slot, target: c.id });
    },
  }),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const e = t.unit as Unit;
    if (!e || !e.alive) return;
    u.w.emit({ n: 'enchant', x: e.x, y: e.y, u: e.id, u2: u.id });
    if (e.isHeroLike || a.temp || e.kind !== 'creep') {
      // Héroe: disipación básica, ralentizado y alcance extra contra él.
      if (e.team !== u.team) e.purge(false, true);
      const d = dur(a, 'slow_duration');
      slow(u, e, a, 'enchant_slow', d, Math.abs(val(a, 'slow_movement_speed')) / 100);
      if (e.team === u.team || a.temp) return;
      const mark = debuff(u, e, a, { name: 'enchant_mark', duration: d });
      if (!mark) return;
      u.addMod({
        name: 'enchant_range', duration: d, data: { on: false },
        props: (m) => (m.data.on ? { attackRange: val(a, 'attack_range_bonus') } : {}),
        onTick(m) {
          const id = u.order?.type === 'attack' ? u.order.target : u.atk.target;
          const on = id === e.id && e.alive && !!e.findMod('enchant_mark', u);
          if (on !== m.data.on) { m.data.on = on; u.refreshStats(); }
        },
      }, u, a);
      return;
    }
    // Creep neutral: pasa a su control.
    if ((UNITS[e.name]?.level ?? 1) > val(a, 'level_req')) return;
    const old = enchanted(u);
    while (old.length >= val(a, 'max_creeps')) {
      const o = old.shift()!;
      o.expireAt = u.w.time;
    }
    const rules = u.w.rules as any;
    if (rules?.campUnits) for (const c of rules.campUnits as Unit[][]) { const i = c.indexOf(e); if (i >= 0) c.splice(i, 1); }
    u.addXp(e.bountyXp * val(a, 'xp_gain_pct') / 100);
    e.team = u.team; e.owner = u; e.playerId = u.playerId; e.home = null;
    e.kind = 'summon'; e.data_enchanted = true;
    e.order = null; e.atk.target = 0; e.atk.phase = 0; e.damagedBy.clear();
    e.expireAt = u.w.time + dur(a, 'dominate_duration');
    e.addMod({
      name: 'enchanted', persistent: true, fx: 'enchant',
      props: {
        hp: val(a, 'enchant_health') + val(a, 'bonus_health'), damage: val(a, 'enchant_damage') + val(a, 'bonus_damage'),
        armor: val(a, 'bonus_armor'), attackSpeed: val(a, 'bonus_attackspeed'),
      },
    }, u, a);
    e.hp = e.s.maxHp;
  },
});

defineAbility({
  key: 'enchantress_natures_attendants', target: 'none',
  aoe: (a) => val(a, 'radius'),
  passive: (a) => botCast(a, (u) => {
    const hurt = u.w.alliesIn(u.team, u.x, u.y, val(a, 'radius'), { heroes: true }).filter((x) => x.hp / x.s.maxHp < 0.55);
    return hurt.length ? u : null;
  }),
  onSpellStart(a) {
    const u = a.owner as Unit;
    const iv = val(a, 'heal_interval');
    u.addMod({
      name: 'natures_attendants', duration: dur(a, 'heal_duration'), fx: 'natures_attendants', interval: iv,
      props: { msFlat: val(a, 'movespeed') },
      onInterval() {
        // Las wisps se reparten entre los aliados heridos del radio.
        const hurt = u.w.alliesIn(u.team, u.x, u.y, val(a, 'radius'))
          .filter((x) => x.hp < x.s.maxHp && (x.isHeroLike || x.kind === 'creep' || x.kind === 'summon'));
        if (!hurt.length) return;
        const wisps = val(a, 'wisp_count');
        const per = dmg(a, 'heal') * iv;
        for (let i = 0; i < wisps; i++) heal(hurt[i % hurt.length], per, u, true);
      },
    }, u, a);
  },
});

// Sproink (Shard): salto atrás que esquiva y dispara Impetus a los dos más lejanos.
defineAbility({
  key: 'enchantress_bunny_hop', target: 'none', ai: { role: 'escape', selfRadius: 350 },
  onSpellStart(a) {
    const u = a.owner as Unit;
    u.w.disjoint(u);
    const dist = val(a, 'hop_distance');
    const tx = u.x - Math.cos(u.facing) * dist, ty = u.y - Math.sin(u.facing) * dist;
    dash(u, tx, ty, dist / val(a, 'hop_duration'), a, {
      name: 'bunny_hop', states: ST.flying,
      onArrive() {
        const r = u.s.attackRange + val(a, 'bonus_attack_range');
        const list = u.w.enemiesIn(u.team, u.x, u.y, r).filter((e) => e.kind !== 'ward' && u.w.canSee(u.team, e))
          .sort((p, q) => Math.hypot(q.x - u.x, q.y - u.y) - Math.hypot(p.x - u.x, p.y - u.y));
        for (const e of list.slice(0, val(a, 'attack_targets'))) impetusShot(u, e);
      },
    });
  },
});

// Little Friends (Scepter): enraiza y todas las criaturas cercanas atacan al objetivo.
defineAbility({
  key: 'enchantress_little_friends', target: 'unit', reflectable: true, ai: { role: 'disable' },
  aoe: (a) => val(a, 'radius'),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const e = t.unit as Unit;
    if (!e?.alive) return;
    const d = val(a, 'duration');
    const friends = u.w.unitsIn(e.x, e.y, val(a, 'radius'), (c) => c !== e && c.team !== e.team &&
      (c.kind === 'creep' || c.kind === 'summon') && u.w.targetable(c) && !c.has(ST.disarmed));
    for (const c of friends) {
      c.addMod({
        name: 'taunt', duration: d, fx: 'little_friends',
        props: { attackSpeed: val(a, 'bonus_attack_speed'), msFlat: val(a, 'bonus_move_speed') },
      }, e, a);
    }
    const r = Math.min(val(a, 'max_root'), val(a, 'root_base_duration') + val(a, 'root_per_target') * friends.length);
    root(u, e, r, a, 'little_friends_root');
    u.w.emit({ n: 'little_friends', x: e.x, y: e.y, r: val(a, 'radius'), u: e.id, t: u.team });
  },
});

defineAbility({
  key: 'enchantress_untouchable', target: 'passive', ult: true, noIllusion: true,
  passive: (a) => ({
    name: 'untouchable',
    onAttacked(m, ev) {
      const u = m.owner as Unit;
      const at = ev.attacker as Unit;
      if (at.team === u.team) return;
      debuff(u, at, a, {
        name: 'untouchable_slow', duration: val(a, 'slow_duration'), fx: 'slow',
        props: { attackSlow: Math.abs(val(a, 'slow_attack_speed')) },
      });
    },
  }),
});

// Rabble-Rouser: neutrales y unidades suyas hacen más daño a héroes enemigos.
defineAbility({
  key: 'enchantress_rabblerouser', target: 'passive', innate: true, noIllusion: true,
  passive: (a) => ({
    name: 'rabblerouser',
    aura: {
      radius: 0, global: true, team: 'enemy', heroesOnly: true,
      apply: (m) => ({
        name: 'rabblerouser_amp',
        onIncomingDamage(_mm, ev) {
          const s = ev.source as Unit | null;
          if (!s || s.isHeroLike || ev.hpRemoval) return;
          if (s.team === NEUTRAL || s.owner === m.owner) ev.amount *= 1 + (val(a, 'damage_amp') || RABBLE_AMP_FALLBACK) / 100;
        },
      }),
    },
  }),
});

defineHero('enchantress', [
  'enchantress_impetus', 'enchantress_enchant', 'enchantress_natures_attendants', 'enchantress_bunny_hop',
  'enchantress_little_friends', 'enchantress_untouchable', 'enchantress_rabblerouser',
], {
  build: ['null_talisman', 'power_treads', 'dragon_lance', 'hurricane_pike', 'black_king_bar', 'ultimate_scepter', 'sheepstick'],
});
