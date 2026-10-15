import { cooldownOf, defineAbility, defineHero, dmg, dur, hasScepter, hasTalent, val } from '../sim/abilities';
import { damage, heal, launchAttack } from '../sim/combat';
import type { AbilityInst } from '../sim/types';
import { ST } from '../sim/types';
import type { Unit } from '../sim/unit';
import { abil, deathGuard, inCone, refund } from './lib/a7';
import { debuff, hex } from './util';

const SHOCK = 'shadow_shaman_ether_shock';
const WARDS = 'shadow_shaman_mass_serpent_ward';

/** Ether Shock en cono desde (x,y) hacia (dx,dy), con objetivo principal opcional. */
function etherShock(u: Unit, a: AbilityInst, main: Unit | null, dx: number, dy: number) {
  const len = val(a, 'end_distance');
  const max = val(a, 'targets');
  const list = u.w.enemiesIn(u.team, u.x, u.y, len + 100)
    .filter((e) => e !== main && e.kind !== 'ward' && inCone(e, u.x, u.y, dx, dy, len, val(a, 'start_radius') * 2, val(a, 'end_radius') * 2))
    .sort((p, q) => Math.hypot(p.x - u.x, p.y - u.y) - Math.hypot(q.x - u.x, q.y - u.y));
  const hits = (main ? [main, ...list] : list).slice(0, max);
  for (const e of hits) {
    u.w.emit({ n: 'ether_shock', x: u.x, y: u.y, x2: e.x, y2: e.y, u: u.id, u2: e.id });
    damage(u, e, dmg(a, 'damage'), 'magical', a);
  }
}

defineAbility({
  key: 'shadow_shaman_ether_shock', target: 'unit', reflectable: true, ai: { role: 'nuke' },
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const e = t.unit as Unit;
    const d = Math.hypot(e.x - u.x, e.y - u.y) || 1;
    etherShock(u, a, e, (e.x - u.x) / d, (e.y - u.y) / d);
  },
});

defineAbility({
  key: 'shadow_shaman_voodoo', target: 'unit', reflectable: true, ai: { role: 'disable' },
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const e = t.unit as Unit;
    const m = hex(u, e, dur(a, 'duration'), a, val(a, 'movespeed'));
    // Talento: el hex también aplica Break.
    if (m && hasTalent(u, 'special_bonus_unique_shadow_shaman_7')) m.states = (m.states ?? 0) | ST.broken, e.refreshStats();
  },
});

defineAbility({
  key: 'shadow_shaman_shackles', target: 'unit', team: 'any', reflectable: true, ai: { role: 'disable' },
  channel: (a) => val(a, 'channel_time'),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const e = t.unit as Unit;
    const ally = e.team === u.team;
    // Con Scepter también sobre aliados (sin inmovilizarlos): emiten Ether Shock.
    if (ally && !hasScepter(u)) { refund(a); u.w.after(0, () => u.w.interruptCast(u, true)); return; }
    a.data.target = e.id;
    a.data.acc = 0;
    a.data.shock = 0;
    if (!ally) {
      const m = debuff(u, e, a, { name: 'shackles', duration: val(a, 'channel_time'), states: ST.stunned, fx: 'shackles' });
      if (!m) { u.w.after(0, () => u.w.interruptCast(u, true)); return; }
      if (e.cast) e.w.interruptCast(e, true);
    } else e.addMod({ name: 'shackles_ally', duration: val(a, 'channel_time'), fx: 'shackles' }, u, a);
  },
  onChannelTick(a, dt) {
    const u = a.owner as Unit;
    const e = u.w.units.get(a.data.target);
    if (!e || !e.alive) { u.w.interruptCast(u, true); return; }
    const ally = e.team === u.team;
    if (ally && Math.hypot(e.x - u.x, e.y - u.y) > val(a, 'ally_break_range')) { u.w.interruptCast(u, true); return; }
    const tick = val(a, 'tick_interval');
    a.data.acc += dt;
    while (a.data.acc >= tick) {
      a.data.acc -= tick;
      if (!ally) {
        const per = dmg(a, 'total_damage') * tick / val(a, 'channel_time');
        const done = damage(u, e, per, 'magical', a, { noProc: true });
        heal(u, done * val(a, 'heal_percentage') / 100, u, true);
      }
    }
    // Scepter: Ether Shock radial alrededor del encadenado.
    const shock = abil(u, SHOCK);
    if (hasScepter(u) && shock && shock.level > 0) {
      a.data.shock += dt;
      if (a.data.shock >= val(a, 'scepter_shock_interval')) {
        a.data.shock = 0;
        const r = val(a, 'scepter_shock_radius');
        for (const x of u.w.enemiesIn(u.team, e.x, e.y, r)) {
          if (x === e) continue;
          u.w.emit({ n: 'ether_shock', x: e.x, y: e.y, x2: x.x, y2: x.y, u: e.id, u2: x.id });
          damage(u, x, dmg(shock, 'damage') * val(a, 'scepter_shock_pct') / 100, 'magical', shock);
        }
      }
    }
  },
  onChannelEnd(a) {
    const u = a.owner as Unit;
    const e = u.w.units.get(a.data.target);
    e?.removeModsByName('shackles');
    e?.removeModsByName('shackles_ally');
    a.data.target = 0;
  },
});

defineAbility({
  key: 'shadow_shaman_fowl_play', target: 'passive', innate: true,
  passive: (a) => ({
    name: 'fowl_play',
    onRespawn() { a.cd = 0; },
    ...deathGuard((u) => a.cd <= 0 && u.kind === 'hero' && !u.has(ST.broken), (u) => {
      a.cd = cooldownOf(a);
      u.hp = 1;
      u.purge(true, false, true);
      if (u.cast) u.w.interruptCast(u, true);
      u.w.emit({ n: 'fowl_play', x: u.x, y: u.y, u: u.id });
      const hexD = val(a, 'hex_duration');
      u.addMod({
        name: 'fowl_play_chicken', duration: hexD, fx: 'hex',
        states: ST.hexed | ST.silenced | ST.disarmed | ST.muted,
        props: { msPct: val(a, 'movespeed_bonus_pct') / 100 },
      }, u, a);
      u.addMod({
        name: 'fowl_play_shield', duration: val(a, 'damage_reduction_duration'),
        onIncomingDamage(_m, ev) { ev.amount *= 1 - val(a, 'damage_reduction_pct') / 100; },
      }, u, a);
      // Pollos extra para confundir.
      const extra = val(a, 'total_chickens') - 1 + Math.floor(u.level / Math.max(1, val(a, 'levels_per_chicken')));
      for (let i = 0; i < extra; i++) {
        const ang = u.w.rng() * Math.PI * 2;
        const il = u.w.spawnIllusion(u, u.x + Math.cos(ang) * 100, u.y + Math.sin(ang) * 100, hexD, -1, val(a, 'ally_chicken_images_take_damage_percent') / 100);
        il.hp = 1;
        il.addMod({ name: 'fowl_play_chicken', duration: hexD, fx: 'hex', states: ST.hexed | ST.disarmed }, u, a);
        u.w.issueOrder(il, { type: 'move', x: il.x + Math.cos(ang) * 600, y: il.y + Math.sin(ang) * 600 });
      }
    }),
  }),
});

/** Crea un Serpent Ward (o el Mega Ward de Urnaconda con `mult`). */
function serpentWard(u: Unit, a: AbilityInst, x: number, y: number, duration: number, mult = 1) {
  const w = u.w.spawnSummon(u, 'shadow_shaman_ward_1', x, y, duration, { name: 'serpent_ward' });
  const dmgV = val(a, 'ward_damage_tooltip') * mult * a.upg.dmg;
  w.base = { ...w.base, dmgMin: dmgV, dmgMax: dmgV };
  const hits = val(a, 'ward_health') * mult;
  w.base.hp = hits;
  w.addMod({
    name: 'serpent_ward', persistent: true, fx: 'serpent_ward',
    states: ST.rooted | ST.magicImmune,
    props: { attackRange: val(a, 'bonus_attack_range') },
    // La vida cuenta golpes: los héroes quitan 2, el resto 1.
    onIncomingDamage(_m, ev) {
      if (!ev.isAttack) { if (!ev.hpRemoval) ev.amount = 0; return; }
      const src = ev.source as Unit | null;
      ev.amount = src && (src.isHeroLike || src.kind === 'summon') ? 2 : 1;
    },
    // Talento: ataques a objetivos extra.
    onAttackLanded(_m, ev) {
      const extra = val(a, 'bonus_attack_targets');
      if (ev.fake || extra <= 0) return;
      const t = ev.target as Unit;
      const others = u.w.enemiesIn(w.team, w.x, w.y, w.s.attackRange + 50).filter((e) => e !== t && e.kind !== 'ward').slice(0, extra);
      for (const o of others) launchAttack(w, o, true);
    },
  }, u, a);
  w.refreshStats();
  w.hp = w.s.maxHp;
  return w;
}

defineAbility({
  key: 'shadow_shaman_urnaconda', target: 'point', ai: { role: 'aoe' },
  aoe: (a) => val(a, 'impact_radius'),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const wards = abil(u, WARDS);
    const time = Math.hypot(t.x - u.x, t.y - u.y) / val(a, 'speed');
    u.w.emit({ n: 'urnaconda', x: u.x, y: u.y, x2: t.x, y2: t.y, d: time, u: u.id });
    u.w.after(time, () => {
      const r = val(a, 'impact_radius');
      u.w.emit({ n: 'aoe', x: t.x, y: t.y, r, t: u.team });
      for (const e of u.w.enemiesIn(u.team, t.x, t.y, r)) damage(u, e, dmg(a, 'impact_damage'), 'magical', a);
      if (wards && wards.level > 0) serpentWard(u, wards, t.x, t.y, val(a, 'ward_duration'), val(wards, 'mega_ward_multiplier_damage'));
    });
  },
});

defineAbility({
  key: 'shadow_shaman_mass_serpent_ward', target: 'point', ult: true, ai: { role: 'aoe' },
  aoe: (a) => val(a, 'spawn_radius'),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const n = val(a, 'ward_count');
    const r = val(a, 'spawn_radius');
    for (let i = 0; i < n; i++) {
      const ang = (i / n) * Math.PI * 2;
      serpentWard(u, a, t.x + Math.cos(ang) * r, t.y + Math.sin(ang) * r, dur(a, 'duration'));
    }
  },
});

defineHero('shadow_shaman', [
  'shadow_shaman_ether_shock', 'shadow_shaman_voodoo', 'shadow_shaman_shackles', 'shadow_shaman_fowl_play',
  'shadow_shaman_urnaconda', 'shadow_shaman_mass_serpent_ward',
], {
  build: ['null_talisman', 'arcane_boots', 'blink', 'aether_lens', 'ultimate_scepter', 'refresher', 'octarine_core'],
});
