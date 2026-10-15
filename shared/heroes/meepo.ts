import { HEROES } from '../data';
import { HERO_KITS, defineAbility, defineHero, dmg, dur, hasTalent, makeAbility, refreshPassive, val } from '../sim/abilities';
import { damage, heal, kill } from '../sim/combat';
import { syncItemPassives } from '../sim/items';
import type { AbilityInst, ItemInst } from '../sim/types';
import { ST } from '../sim/types';
import type { Unit } from '../sim/unit';
import { heroBase } from '../sim/world';
import { dash, root, slow } from './util';
import { gate } from './lib/a5';

// Los clones son unidades 'summon' con los datos de héroe de Meepo: pueden lanzar habilidades
// (las ilusiones del motor no) y comparten nivel, atributos, talentos e items con el Meepo principal.

const mainOf = (u: Unit): Unit => (u.meepoClone && u.owner ? (u.owner as Unit) : u);
const clonesOf = (main: Unit): Unit[] => main.w.list.filter((c) => c.meepoClone && c.owner === main && c.alive);
const allMeepos = (u: Unit): Unit[] => { const m = mainOf(u); return [m, ...clonesOf(m)].filter((x) => x.alive); };
const ability = (u: Unit, key: string) => u.abilities.find((x) => x.key === key);
const mounted = (main: Unit): Unit[] => clonesOf(main).filter((c) => c.findMod('megameepo_mounted'));

/** Copia estado del principal al clon: nivel, atributos, talentos, habilidades e items. */
function syncClone(main: Unit, c: Unit) {
  let changed = false;
  if (c.level !== main.level) { c.level = main.level; changed = true; }
  if (c.permStr !== main.permStr || c.permAgi !== main.permAgi || c.permInt !== main.permInt) {
    c.permStr = main.permStr; c.permAgi = main.permAgi; c.permInt = main.permInt; changed = true;
  }
  if (c.talents.size !== main.talents.size) { c.talents = new Set(main.talents); changed = true; }
  if (c.shard !== main.shard || c.blessing !== main.blessing) { c.shard = main.shard; c.blessing = main.blessing; changed = true; }
  // Bonus de talentos genéricos y mejoras de orbe: se leen en vivo del principal.
  for (const name of ['talents', 'orb_bonus']) {
    if (!main.findMod(name) || c.findMod(name)) continue;
    c.addMod({
      name, persistent: true,
      props: () => { const mm = main.findMod(name); return (mm ? (typeof mm.props === 'function' ? mm.props(mm) : mm.props) : null) ?? {}; },
    }, c, null);
  }
  // Items compartidos (y sus enfriamientos).
  const sig = [0, 1, 2, 3, 4, 5, 9].map((s) => main.items[s]?.key ?? '').join(',');
  if (sig !== c.meepoItems) {
    c.meepoItems = sig;
    for (let s = 0; s < c.items.length; s++) {
      const it = c.items[s];
      if (it?.passiveMod) c.removeMod(it.passiveMod);
      c.items[s] = null;
    }
    for (const s of [0, 1, 2, 3, 4, 5, 9]) {
      const it = main.items[s];
      if (it) c.items[s] = { ...it, owner: c, passiveMod: null, data: {} } as ItemInst;
    }
    syncItemPassives(c);
    changed = true;
  }
  for (const s of [0, 1, 2, 3, 4, 5, 9]) {
    const a = main.items[s], b = c.items[s];
    if (!a || !b) continue;
    const cd = Math.max(a.cd, b.cd);
    a.cd = cd; b.cd = cd;
    b.charges = a.charges;
  }
  main.abilities.forEach((ma, i) => {
    const ca = c.abilities[i];
    if (!ca || ca.level === ma.level) return;
    ca.level = ma.level;
    ca.upg = { ...ma.upg }; ca.bonus = { ...ma.bonus }; ca.mult = { ...ma.mult };
    refreshPassive(ca);
  });
  if (changed) syncAutoLevelsClone(c);
  c.refreshStats();
}

function syncAutoLevelsClone(c: Unit) {
  for (const a of c.abilities) refreshPassive(a);
}

function spawnClone(main: Unit) {
  const h = HEROES.meepo;
  const ang = main.w.rng() * Math.PI * 2;
  const c = main.w.addUnit('summon', 'meepo', main.team, heroBase(h), main.x + Math.cos(ang) * 80, main.y + Math.sin(ang) * 80, h);
  c.owner = main;
  c.playerId = main.playerId;
  c.meepoClone = true;
  c.radius = main.radius;
  c.facing = main.facing;
  (HERO_KITS.meepo ?? []).forEach((k, i) => {
    const a = makeAbility(c, k, i);
    if (!a) return;
    a.level = main.abilities[i]?.level ?? a.level;
    c.abilities.push(a);
  });
  c.addMod({
    name: 'meepo_clone', persistent: true, interval: 0.3,
    // Si muere un Meepo, mueren todos.
    onDeath(_m, killer) { if (main.alive) kill(main, killer as Unit | null); },
    onInterval() { if (main.isBot) cloneBrain(main, c); },
  }, c, null);
  syncClone(main, c);
  c.refreshStats();
  c.hp = c.s.maxHp * Math.max(0.1, main.hp / main.s.maxHp);
  c.mana = c.s.maxMana * (main.s.maxMana > 0 ? main.mana / main.s.maxMana : 1);
  main.w.emit({ n: 'blink', x: c.x, y: c.y, u: c.id, c: 'meepo' });
  return c;
}

/** IA mínima de los clones de un bot: pelean con el objetivo del principal y le siguen. */
function cloneBrain(main: Unit, c: Unit) {
  if (c.cast || c.has(ST.busy) || !c.alive) return;
  const w = c.w;
  const t = main.ai?.target ? w.units.get(main.ai.target) : null;
  if (t && t.alive && w.targetable(t) && w.canSee(c.team, t) && Math.hypot(t.x - c.x, t.y - c.y) < 1400 && main.ai && !main.ai.retreat) {
    const eb = ability(c, 'meepo_earthbind');
    if (eb && eb.level > 0 && !w.castCheck(c, eb) && Math.hypot(t.x - c.x, t.y - c.y) < 900 && !t.has(ST.rooted)) {
      w.issueOrder(c, { type: 'cast', slot: eb.slot, x: t.x, y: t.y });
      return;
    }
    if (c.order?.type !== 'attack' || c.order.target !== t.id) w.issueOrder(c, { type: 'attack', target: t.id });
    return;
  }
  const d = Math.hypot(main.x - c.x, main.y - c.y);
  // Lejos del principal: Poof hacia él.
  const poof = ability(c, 'meepo_poof');
  if (d > 1800 && poof && poof.level > 0 && !w.castCheck(c, poof)) { w.issueOrder(c, { type: 'cast', slot: poof.slot, x: main.x, y: main.y }); return; }
  if (d > 300) w.issueOrder(c, { type: 'move', x: main.x + (c.id % 3 - 1) * 60, y: main.y + (c.id % 2) * 60 });
}

defineAbility({
  key: 'meepo_earthbind', target: 'point', ai: { role: 'disable' },
  aoe: (a) => val(a, 'radius'),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const r = val(a, 'radius');
    const nets: [number, number][] = [[t.x, t.y]];
    // MegaMeepo: una red extra por cada Meepo montado.
    const n = mounted(mainOf(u)).length;
    for (let i = 0; i < n; i++) {
      const ang = (i / Math.max(1, n)) * Math.PI * 2;
      nets.push([t.x + Math.cos(ang) * val(a, 'megameepo_net_offset'), t.y + Math.sin(ang) * val(a, 'megameepo_net_offset')]);
    }
    for (const [x, y] of nets) {
      const delay = Math.hypot(x - u.x, y - u.y) / val(a, 'speed');
      u.w.emit({ n: 'earthbind', x: u.x, y: u.y, x2: x, y2: y, d: delay, r, t: u.team });
      u.w.after(delay, () => {
        u.w.emit({ n: 'earthbind_land', x, y, r, t: u.team });
        for (const e of u.w.enemiesIn(u.team, x, y, r)) {
          if (e.findMod('earthbind')) continue;
          root(u, e, dur(a, 'duration'), a, 'earthbind');
          if (e.cast?.a && (e.cast.a as AbilityInst).impl?.castBeyond) e.w.interruptCast(e, true);
        }
      });
    }
  },
});

defineAbility({
  key: 'meepo_poof', target: 'point', castBeyond: true, ai: { role: 'nuke' },
  castPoint: (a) => val(a, 'cast_duration'),
  aoe: (a) => val(a, 'radius'),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const main = mainOf(u);
    // Va al Meepo más cercano al punto (puede ser él mismo).
    const dest = allMeepos(u).filter((m) => !m.findMod('megameepo_mounted'))
      .sort((p, q) => Math.hypot(p.x - t.x, p.y - t.y) - Math.hypot(q.x - t.x, q.y - t.y))[0] ?? u;
    const r = val(a, 'radius');
    const amount = dmg(a, 'poof_damage') * (1 + mounted(main).length * val(a, 'megameepo_poof_scaling') / 100);
    const hit = new Set<number>();
    const blast = (x: number, y: number) => {
      u.w.emit({ n: 'poof', x, y, r, t: u.team });
      for (const e of u.w.enemiesIn(u.team, x, y, r)) {
        if (hit.has(e.id)) continue;
        hit.add(e.id);
        damage(u, e, amount, 'magical', a);
      }
    };
    blast(u.x, u.y);
    if (dest !== u) {
      u.w.disjoint(u);
      u.w.teleport(u, dest.x + Math.cos(dest.facing) * 60, dest.y + Math.sin(dest.facing) * 60);
      blast(u.x, u.y);
    }
  },
});

defineAbility({
  key: 'meepo_ransack', target: 'passive',
  passive: (a) => ({
    name: 'ransack',
    onAttackStart(_m, ev) {
      // Talento: true strike contra objetivos bajo Earthbind.
      if (hasTalent(ev.attacker as Unit, 'special_bonus_unique_meepo_4') && (ev.target as Unit).findMod('earthbind')) ev.trueStrike = true;
    },
    onAttackLanded(_m, ev) {
      const u = ev.attacker as Unit, t = ev.target as Unit;
      if (t.team === u.team || !(t.isHeroLike || t.kind === 'creep' || t.kind === 'summon')) return;
      const amt = val(a, 'health_steal_heroes') * (t.isHeroLike ? 1 : 0.6) * a.upg.dmg;
      const got = damage(u, t, amt, 'pure', a, { noProc: true });
      if (got <= 0) return;
      for (const m of allMeepos(u)) heal(m, got, u, true);
    },
  }),
});

// Shard: se entierra, se disipa y recupera vida siendo invulnerable.
defineAbility({
  key: 'meepo_petrify', target: 'none', ai: { role: 'summon', selfRadius: 900 },
  onSpellStart(a) {
    const u = a.owner as Unit;
    const d = val(a, 'duration');
    u.purge(true, false);
    u.w.disjoint(u);
    u.order = null; u.atk.phase = 0;
    u.addMod({
      name: 'dig', duration: d, fx: 'dig', interval: 0.25,
      states: ST.invulnerable | ST.untargetable | ST.rooted | ST.disarmed | ST.silenced | ST.muted,
      onInterval() { heal(u, u.s.maxHp * val(a, 'hp_restore') / 100 * 0.25 / d, u, true); },
    }, u, a);
  },
});

// Scepter: monta a los demás Meepos sobre los hombros.
defineAbility({
  key: 'meepo_megameepo', target: 'none', ai: { role: 'buff', selfRadius: 600 },
  onSpellStart(a) {
    const u = a.owner as Unit;
    const main = mainOf(u);
    const riders = clonesOf(main).filter((c) => c !== u && Math.hypot(c.x - u.x, c.y - u.y) <= val(a, 'radius'));
    if (u !== main && main.alive && Math.hypot(main.x - u.x, main.y - u.y) <= val(a, 'radius')) riders.push(main);
    const k = val(a, 'stats_pct') / 100 * riders.length;
    const d = val(a, 'duration');
    for (const c of riders) {
      c.order = null; c.atk.phase = 0; c.w.disjoint(c);
      if (c.cast) c.w.interruptCast(c, true);
      c.addMod({
        name: 'megameepo_mounted', duration: d, states: ST.hidden | ST.invulnerable | ST.untargetable | ST.busy | ST.noCollision,
        onTick() { c.x = u.x; c.y = u.y; },
        onDestroy() {
          // Al terminar salen despedidos alrededor.
          const ang = c.w.rng() * Math.PI * 2;
          c.w.teleport(c, u.x, u.y);
          dash(c, u.x + Math.cos(ang) * val(a, 'end_knockback_distance'), u.y + Math.sin(ang) * val(a, 'end_knockback_distance'),
            val(a, 'end_knockback_distance') / val(a, 'end_knockback_duration'), a, { name: 'megameepo_knockback' });
        },
      }, u, a);
    }
    u.addMod({
      name: 'megameepo', duration: d, fx: 'megameepo',
      props: { str: u.s.str * k, agi: u.s.agi * k, int: u.s.int * k },
      onTick(m) { if (!riders.some((c) => c.alive && c.findMod('megameepo_mounted'))) m.remaining = Math.min(m.remaining, 0.01); },
      onDestroy() { for (const c of riders) c.removeModsByName('megameepo_mounted'); },
    }, u, a);
  },
});

defineAbility({
  key: 'meepo_divided_we_stand', target: 'passive', ult: true, sub: true, noIllusion: true,
  passive: (a) => ({
    name: 'divided_we_stand', interval: 0.25,
    onInterval(m) {
      const u = m.owner as Unit;
      if (u.kind !== 'hero') return;
      const clones = clonesOf(u);
      const want = val(a, 'tooltip_clones');
      for (let i = clones.length; i < want; i++) clones.push(spawnClone(u));
      for (const c of clones) syncClone(u, c);
    },
    onDeath(_m, killer) {
      const u = a.owner as Unit;
      for (const c of clonesOf(u)) kill(c, killer as Unit | null);
    },
  }),
});

// Innata: bonus por terreno. Solo hay árboles en el mapa del motor: regeneración por cada Meepo junto a un árbol.
// También sube Divided We Stand a los niveles del dataset (3, 10, 17, 24), gastando punto de habilidad.
defineAbility({
  key: 'meepo_geomancy', target: 'passive', innate: true, noIllusion: true,
  passive: (a) => ({
    name: 'geomancy', interval: 0.5,
    onInterval() {
      const u = a.owner as Unit;
      if (u.kind !== 'hero') return;
      const ult = ability(u, 'meepo_divided_we_stand');
      if (ult) {
        const req = val(ult, 'required_level'), every = val(ult, 'levels_between_upgrades');
        const lvl = u.level >= req ? Math.min(val(ult, 'max_level'), 1 + Math.floor((u.level - req) / every)) : 0;
        if (lvl > ult.level) {
          ult.data.owed = (ult.data.owed ?? 0) + lvl - ult.level;
          ult.level = lvl;
          refreshPassive(ult);
        }
        while (ult.data.owed > 0 && u.abilityPoints > 0) { u.abilityPoints--; ult.data.owed--; }
      }
      const all = allMeepos(u);
      const n = all.filter((m) => !m.has(ST.hidden) && u.w.nearestTree(m.x, m.y, val(a, 'tree_radius'))).length;
      for (const m of all) {
        const g = m.findMod('geomancy_bonus') ?? m.addMod({ name: 'geomancy_bonus', persistent: true, props: (mm) => ({ hpRegen: mm.data.regen ?? 0 }) }, u, a);
        if (g.data.regen !== n * val(a, 'tree_regen')) { g.data.regen = n * val(a, 'tree_regen'); m.refreshStats(); }
      }
    },
  }),
});

defineAbility({
  key: 'meepo_megameepo_fling', target: 'unit', reflectable: true, ai: { role: 'nuke' },
  hidden: (a) => !(a.owner as Unit).findMod('megameepo'),
  passive: gate((a) => {
    const u = a.owner as Unit;
    return !!u.findMod('megameepo') && allMeepos(u).some((c) => c !== u && !!c.findMod('megameepo_mounted', u));
  }),
  onSpellStart(a, t) {
    const u = a.owner as Unit;
    const e = t.unit as Unit;
    const rider = allMeepos(u).find((c) => c !== u && c.findMod('megameepo_mounted', u));
    if (!rider) return;
    const m = rider.findMod('megameepo_mounted', u)!;
    m.onDestroy = undefined;
    rider.removeMod(m);
    rider.w.teleport(rider, u.x, u.y);
    dash(rider, e.x, e.y, val(a, 'fling_movespeed'), a, {
      name: 'fling', states: ST.flying | ST.invulnerable,
      onArrive() {
        const r = val(a, 'fling_radius');
        u.w.emit({ n: 'fling', x: rider.x, y: rider.y, r, t: u.team });
        for (const v of u.w.enemiesIn(u.team, rider.x, rider.y, r)) {
          damage(u, v, dmg(a, 'fling_damage'), 'magical', a);
          slow(u, v, a, 'fling_slow', val(a, 'fling_slow_duration'), -val(a, 'movement_slow') / 100);
        }
      },
    });
  },
});

defineHero('meepo', ['meepo_earthbind', 'meepo_poof', 'meepo_ransack', 'meepo_petrify', 'meepo_megameepo', 'meepo_divided_we_stand', 'meepo_geomancy', 'meepo_megameepo_fling'], {
  build: ['wraith_band', 'power_treads', 'dragon_lance', 'blink', 'black_king_bar', 'skadi', 'heart'],
});
