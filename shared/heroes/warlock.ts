import { defineAbility, defineHero, dmg, dur, val } from '../sim/abilities';
import { damage, heal, kill } from '../sim/combat';
import type { AbilityInst, Modifier } from '../sim/types';
import { ST } from '../sim/types';
import type { Unit } from '../sim/unit';
import { dist, setSummonStats, summonBrain } from './lib/a9';
import { canDebuff, debuff, slow, stun } from './util';

const ab = (u: Unit, key: string) => u.abilities.find((x) => x.key === key);
/** Warlock detrás de un golem o imp. */
const warlockOf = (u: Unit) => (u.kind === 'summon' && u.owner ? (u.owner as Unit) : u);

/** Imp menor de Eldritch Summoning: busca presa (antes los ligados) y explota. */
function spawnImp(u: Unit, x: number, y: number, duration: number) {
  const es = ab(u, 'warlock_eldritch_summoning');
  if (!es) return;
  const imp = u.w.spawnSummon(u, 'warlock_minor_imp', x, y, duration, { abilities: ['warlock_imp_explode'], level: 1 });
  setSummonStats(imp, { hp: val(es, 'imp_health'), ms: val(es, 'imp_speed') });
  imp.addMod({
    name: 'minor_imp_seek', persistent: true, interval: 0.25, states: ST.disarmed,
    onInterval() {
      const w = imp.w;
      if (!imp.alive) return;
      const list = w.enemiesIn(imp.team, imp.x, imp.y, 1500).filter((e) => e.kind !== 'ward' && w.canSee(imp.team, e));
      list.sort((p, q) => Number(!!q.findMod('fatal_bonds', u)) - Number(!!p.findMod('fatal_bonds', u)) ||
        Number(q.isHeroLike) - Number(p.isHeroLike) || dist(p, imp) - dist(q, imp));
      const t = list[0];
      if (!t) return;
      if (dist(t, imp) <= 100 + t.radius) { kill(imp, null); return; }
      w.issueOrder(imp, { type: 'move', x: t.x, y: t.y });
    },
  }, u, es);
}

defineAbility({
  key: 'warlock_imp_explode', target: 'passive',
  passive: (a) => ({
    name: 'imp_explode',
    onTick(m) {
      // Al caducar también explota.
      const imp = m.owner as Unit;
      if (!m.data.done && imp.expireAt - imp.w.time <= 1 / 30) { m.data.done = true; explode(a, imp); }
    },
    onDeath(m) { if (!m.data.done) { m.data.done = true; explode(a, m.owner as Unit); } },
  }),
});

function explode(a: AbilityInst, imp: Unit) {
  const u = warlockOf(imp);
  const es = ab(u, 'warlock_eldritch_summoning');
  if (!es) return;
  const x = imp.x, y = imp.y;
  imp.w.after(val(a, 'explosion_delay'), () => {
    const r = val(a, 'explosion_radius');
    imp.w.emit({ n: 'imp_explode', x, y, r, t: u.team });
    for (const e of imp.w.enemiesIn(u.team, x, y, r)) {
      const k = e.isHeroLike ? 1 : 1 - val(a, 'explosion_nonhero_reduce') / 100;
      damage(u, e, dmg(es, 'imp_explode') * k, 'magical', es);
    }
  });
}

defineAbility({
  key: 'warlock_fatal_bonds', target: 'unit', reflectable: true, ai: { role: 'disable' },
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const e = t.unit as Unit;
    const others = u.w.enemiesIn(u.team, e.x, e.y, val(a, 'search_aoe'))
      .filter((x) => x !== e && x.kind !== 'ward' && u.w.canSee(u.team, x))
      .sort((p, q) => Number(q.isHeroLike) - Number(p.isHeroLike) || dist(p, e) - dist(q, e));
    const group = [e, ...others].slice(0, val(a, 'count'));
    const share = val(a, 'damage_share_percentage') / 100;
    for (const g of group) {
      u.w.emit({ n: 'fatal_bonds', x: e.x, y: e.y, x2: g.x, y2: g.y, u: e.id, u2: g.id });
      debuff(u, g, a, {
        name: 'fatal_bonds', duration: dur(a, 'duration'), fx: 'fatal_bonds',
        onTakeDamage(m, ev) {
          if (ev.data?.bond || ev.amount <= 0) return;
          const amt = ev.amount * share;
          for (const o of group) {
            if (o === m.owner || !o.alive || !o.findMod('fatal_bonds', u)) continue;
            damage(u, o, amt, 'pure', a, { noProc: true, data: { bond: true } });
          }
        },
      });
    }
  },
});

defineAbility({
  key: 'warlock_shadow_word', target: 'unit', team: 'any', allowSelf: true, reflectable: true, ai: { role: 'nuke' },
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const e = t.unit as Unit;
    const tick = val(a, 'tick_interval');
    const spec = {
      name: 'shadow_word', duration: dur(a, 'duration'), interval: tick, fx: 'shadow_word',
      onInterval(m: Modifier) {
        const c = m.owner as Unit;
        const amt = dmg(a, 'damage') * tick;
        // Daña a los enemigos de Warlock y cura a sus aliados alrededor del objetivo.
        for (const x of u.w.unitsIn(c.x, c.y, val(a, 'spell_aoe'), (v) => u.w.targetable(v) && v.kind !== 'fountain')) {
          if (x.team === u.team) heal(x, amt, u, true);
          else if (canDebuff(u, x, a)) damage(u, x, amt, 'magical', a, { noProc: true });
        }
      },
    };
    if (e.team === u.team) e.addMod({ ...spec, debuff: false }, u, a);
    else debuff(u, e, a, spec);
  },
});

defineAbility({
  key: 'warlock_upheaval', target: 'point', ai: { role: 'aoe' },
  aoe: (a) => val(a, 'aoe'),
  channel: (a) => val(a, 'abilitychanneltime'),
  onSpellStart(a, t) {
    a.data.x = t.x; a.data.y = t.y; a.data.t = 0; a.data.acc = 0; a.data.imp = 0;
    const u = a.owner as Unit;
    u.w.emit({ n: 'upheaval', x: t.x, y: t.y, r: val(a, 'aoe'), d: val(a, 'abilitychanneltime'), t: u.team });
  },
  onChannelTick(a, dt) {
    const u = a.owner as Unit;
    const w = u.w;
    a.data.t += dt; a.data.acc += dt; a.data.imp += dt;
    const el = a.data.t;
    const r = val(a, 'aoe');
    const ms = Math.min(val(a, 'max_slow'), val(a, 'slow_per_second') * el) / 100;
    for (const e of w.enemiesIn(u.team, a.data.x, a.data.y, r)) slow(u, e, a, 'upheaval', dur(a, 'duration'), ms);
    const as = val(a, 'aspd_per_second') * el;
    if (as > 0) for (const al of w.alliesIn(u.team, a.data.x, a.data.y, r)) {
      al.addMod({ name: 'upheaval_haste', duration: dur(a, 'duration'), props: { attackSpeed: as } }, u, a);
    }
    const every = val(a, 'damage_tick_interval');
    if (a.data.acc >= every) {
      a.data.acc -= every;
      const d = Math.min(dmg(a, 'max_damage'), dmg(a, 'base_damage') + dmg(a, 'damage_per_second') * Math.floor(el));
      for (const e of w.enemiesIn(u.team, a.data.x, a.data.y, r)) damage(u, e, d * every, 'magical', a, { noProc: true });
    }
    if (a.data.imp >= val(a, 'imps_interval')) {
      a.data.imp -= val(a, 'imps_interval');
      const ang = w.rng() * Math.PI * 2, rr = Math.sqrt(w.rng()) * r * 0.8;
      spawnImp(u, a.data.x + Math.cos(ang) * rr, a.data.y + Math.sin(ang) * rr, val(a, 'minor_imp_duration'));
    }
  },
});

/** Golem de Chaotic Offering. */
function spawnGolem(a: AbilityInst, x: number, y: number, scepter: boolean) {
  const u = a.owner as Unit;
  const g = u.w.spawnSummon(u, 'warlock_golem', x, y, dur(a, 'golem_duration'), {
    abilities: ['warlock_golem_flaming_fists', 'warlock_golem_permanent_immolation'], level: a.level,
    bounty: val(a, scepter ? 'golem_gold_bounty_scepter' : 'golem_gold_bounty'),
  });
  setSummonStats(g, {
    hp: val(a, scepter ? 'golem_hp_scepter' : 'golem_hp'), dmg: val(a, scepter ? 'golem_dmg_scepter' : 'golem_dmg'),
    armor: val(a, 'golem_armor') + val(a, 'bonus_armor'), ms: val(a, 'golem_movement_speed'),
  });
  g.base.hpRegen = val(a, 'golem_health_regen');
  g.addMod({
    name: 'warlock_golem', persistent: true,
    props: {
      slowResist: val(a, 'bonus_slow_resistance') / 100,
      magicResist: val(a, 'bonus_magic_resistance') / 100,
      incomingPct: -val(a, 'bonus_damage_resist') / 100,
    },
  }, u, a);
  g.refreshStats(); g.hp = g.s.maxHp;
  summonBrain(g, u, 1000);
  return g;
}

defineAbility({
  key: 'warlock_golem_flaming_fists', target: 'passive',
  passive: (a) => ({
    name: 'flaming_fists',
    onAttackLanded(m, ev) {
      const g = m.owner as Unit, t = ev.target as Unit;
      const u = warlockOf(g);
      for (const e of g.w.enemiesIn(g.team, t.x, t.y, val(a, 'radius'))) damage(u, e, dmg(a, 'damage'), 'magical', a, { noProc: true });
    },
  }),
});

defineAbility({
  key: 'warlock_golem_permanent_immolation', target: 'passive',
  passive: (a) => ({
    name: 'permanent_immolation', interval: val(a, 'tick_interval'), fx: 'immolation',
    onInterval(m) {
      const g = m.owner as Unit;
      const u = warlockOf(g);
      for (const e of g.w.enemiesIn(g.team, g.x, g.y, val(a, 'aura_radius'))) {
        damage(u, e, dmg(a, 'aura_damage') * val(a, 'tick_interval'), 'magical', a, { noProc: true });
      }
    },
  }),
});

defineAbility({
  key: 'warlock_eldritch_summoning', target: 'passive', innate: true, noIllusion: true,
  passive: (a) => ({
    name: 'eldritch_summoning',
    onAnyDeath(m, victim) {
      const u = m.owner as Unit;
      if (!u.alive || victim.team === u.team || victim.kind === 'ward' || victim.name === 'warlock_minor_imp') return;
      if (!victim.isHeroLike && victim.kind !== 'creep' && victim.kind !== 'summon') return;
      const mine = victim.mods.some((x) => x.debuff && x.caster && warlockOf(x.caster as Unit) === u);
      if (mine) spawnImp(u, victim.x, victim.y, val(a, 'minor_imp_duration'));
    },
    // Talento: invoca un golem al morir.
    onDeath(m) {
      const u = m.owner as Unit;
      const r = ab(u, 'warlock_rain_of_chaos');
      if (u.kind === 'hero' && r && r.level > 0 && val(r, 'golem_on_death') > 0) spawnGolem(r, u.x, u.y, false);
    },
  }),
});

defineAbility({
  key: 'warlock_rain_of_chaos', target: 'point', ult: true, ai: { role: 'disable' },
  aoe: (a) => val(a, 'aoe'),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const r = val(a, 'aoe');
    u.w.emit({ n: 'chaotic_offering', x: t.x, y: t.y, r, d: val(a, 'stun_delay'), t: u.team });
    u.w.after(val(a, 'stun_delay'), () => {
      for (const e of u.w.enemiesIn(u.team, t.x, t.y, r, { immune: false })) stun(u, e, dur(a, 'stun_duration'), a);
      const n = Math.max(1, val(a, 'number_of_golems_scepter'));
      for (let i = 0; i < n; i++) spawnGolem(a, t.x + (n > 1 ? (i ? 80 : -80) : 0), t.y, n > 1);
    });
  },
});

defineHero('warlock', ['warlock_fatal_bonds', 'warlock_shadow_word', 'warlock_upheaval', 'warlock_eldritch_summoning', 'warlock_rain_of_chaos'], {
  build: ['null_talisman', 'arcane_boots', 'glimmer_cape', 'force_staff', 'ultimate_scepter', 'refresher', 'shivas_guard'],
});
