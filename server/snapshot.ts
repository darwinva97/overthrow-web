// Construye lo que ve cada jugador: solo unidades visibles para su equipo.
import { XP_TABLE, MAX_LEVEL } from '../shared/data';
import type { BoardRow, SMe, SUnit, Snapshot } from '../shared/net/protocol';
import type { OverthrowRules } from '../shared/overthrow/rules';
import {
  available, canLevelAbility, castRangeOf, cooldownOf, hasScepter, manaCostOf, maxLevel,
} from '../shared/sim/abilities';
import { talentRows } from '../shared/sim/talents';
import { atShop } from '../shared/sim/items';
import type { Fx } from '../shared/sim/types';
import type { Unit } from '../shared/sim/unit';
import type { World } from '../shared/sim/world';

const r1 = (v: number) => Math.round(v * 10) / 10;

function encodeUnit(w: World, u: Unit, viewer: Unit | null, team: number): SUnit {
  const fx: string[] = [];
  for (const m of u.mods) if (m.fx && !fx.includes(m.fx)) fx.push(m.fx);
  const s: SUnit = {
    i: u.id, k: u.kind === 'illusion' && u.team !== team ? 'hero' : u.kind, n: u.name, t: u.team,
    x: Math.round(u.x), y: Math.round(u.y), f: Math.round(u.facing * 100) / 100,
    h: Math.ceil(u.hp), H: Math.round(u.s.maxHp), m: Math.round(u.mana), M: Math.round(u.s.maxMana),
    l: u.level, s: u.s.states, r: u.radius,
  };
  if (fx.length) s.fx = fx;
  if (viewer && u.playerId && u.playerId === viewer.playerId) s.o = 1;
  if (u.atk.phase === 1) s.a = 1;
  if (u.cast) { s.c = u.cast.phase; s.ck = u.cast.a.key; }
  if (u.team === team) s.v = Math.round(u.s.vision);
  if (u.kind === 'illusion' && u.team === team) s.il = 1;
  void w;
  return s;
}

export function board(w: World): BoardRow[] {
  return w.list.filter((u) => u.kind === 'hero').map((u) => ({
    id: u.id, name: (u as any).displayName ?? u.name, hero: u.name, team: u.team,
    k: u.kills, d: u.deaths, a: u.assists, lvl: u.level, alive: u.alive,
    respawn: u.alive ? 0 : Math.max(0, Math.ceil(u.respawnAt - w.time)), bot: u.isBot,
  }));
}

function encodeMe(w: World, h: Unit): SMe {
  const lvl = h.level;
  return {
    id: h.id, gold: Math.floor(h.gold), lvl,
    xp: Math.floor(h.xp), xpPrev: XP_TABLE[lvl - 1] ?? 0, xpNext: lvl >= MAX_LEVEL ? 0 : XP_TABLE[lvl],
    ap: h.abilityPoints,
    ab: h.abilities.map((a) => ({
      k: a.key, l: a.level, max: maxLevel(a), cd: r1(a.cd), mcd: r1(a.impl.charges ? a.chargeCd : cooldownOf(a)),
      mc: Math.round(manaCostOf(a)), ch: a.impl.charges ? a.charges : -1, tg: a.toggled,
      can: canLevelAbility(h, a), tk: a.impl.target,
      rng: a.impl.target === 'none' || a.impl.target === 'passive' ? 0 : Math.round(castRangeOf(a)),
      aoe: a.impl.aoe && a.level > 0 ? Math.round(a.impl.aoe(a)) : 0,
      ult: !!(a.impl.ult || a.def.ult), innate: !!(a.impl.innate || a.def.innate),
      av: available(a), req: a.impl.requires ?? a.def.grantedBy ?? null, hidden: typeof a.impl.hidden === 'function' ? a.impl.hidden(a) : !!a.impl.hidden,
    })),
    it: h.items.map((it) => it && ({
      k: it.key, cd: r1(it.cd), mcd: it.def.cd, ch: it.def.charges || it.key === 'magic_stick' || it.key === 'magic_wand' ? it.charges : -1,
      tg: it.toggled, md: it.mode, tk: it.impl?.target ?? null,
      rng: it.impl?.castRange ? Math.round(it.impl.castRange(it) + h.s.castRange) : 0,
    })),
    st: h.stash.map((s) => s.key),
    shop: atShop(h),
    orb: h.orbPicks[0] ?? null, orbN: h.orbPicks.length,
    buffs: h.mods.filter((m) => m.fx || Number.isFinite(m.remaining)).filter((m) => !m.name.startsWith('item_') && m.name !== 'channeling')
      .slice(0, 14).map((m) => ({
        n: m.name, fx: m.fx, r: r1(Number.isFinite(m.remaining) ? m.remaining : -1), d: r1(Number.isFinite(m.duration) ? m.duration : -1),
        s: m.stacks, db: m.debuff, src: m.ability ? m.ability.key : '',
      })),
    dead: h.alive ? 0 : Math.max(0, Math.ceil(h.respawnAt - w.time)),
    stats: {
      dmg: `${Math.round(h.s.dmgMin)}-${Math.round(h.s.dmgMax)}${h.s.dmgBonus ? ` +${Math.round(h.s.dmgBonus)}` : ''}`,
      as: Math.round(h.s.as), armor: r1(h.s.armor), mr: Math.round(h.s.mr * 100), ms: Math.round(h.s.ms),
      str: Math.round(h.s.str), agi: Math.round(h.s.agi), int: Math.round(h.s.int), range: Math.round(h.s.attackRange),
      spell: Math.round(h.s.spellAmp * 100), hpr: r1(h.s.hpRegen), mpr: r1(h.s.manaRegen), evasion: Math.round(h.s.evasion * 100),
    },
    units: w.list.filter((u) => u.alive && u.playerId === h.playerId && u !== h && (u.kind === 'illusion' || u.kind === 'summon')).map((u) => u.id),
    kda: [h.kills, h.deaths, h.assists, h.lastHits],
    talents: talentRows(h),
    scepter: hasScepter(h), shard: h.shard,
    neutral: h.neutralPicks[0] ?? null,
    enhancement: (() => { const m = h.findMod('enhancement'); return m ? { key: m.data.key, tier: m.data.tier } : null; })(),
  };
}

/** Un efecto se manda si lo ve el equipo: unidad visible o punto dentro de su visión. */
function fxVisible(w: World, f: Fx, team: number) {
  if (f.n === 'announce' || f.n === 'kill' || f.n === 'orb_throw' || f.n === 'orb_capture') return true;
  if (f.t === team) return true;
  if (f.u) { const u = w.units.get(f.u); if (u && w.canSee(team, u)) return true; }
  return w.pointVisible(team, f.x, f.y);
}

/** Parte del snapshot que comparten todos los jugadores de un equipo (sin "me" ni propiedad). */
export function buildTeamSnapshot(w: World, rules: OverthrowRules, team: number, fx: Fx[], boardRows: BoardRow[]): Snapshot {
  const vis = w.visible.get(team);
  const units: SUnit[] = [];
  for (const u of w.list) {
    if (!u.alive) continue;
    if (u.team !== team && !vis?.has(u.id)) continue;
    units.push(encodeUnit(w, u, null, team));
  }
  const shown = new Set(units.map((u) => u.i));
  return {
    tm: Math.round(w.time * 100) / 100,
    vz: w.visionSources.filter((v) => v.team === team).map((v) => ({ x: Math.round(v.x), y: Math.round(v.y), r: v.r })),
    night: w.isNight(),
    u: units,
    p: w.projectiles.filter((p) => p.team === team || w.pointVisible(team, p.x, p.y)).map((p) => ({
      i: p.id, fx: p.fx, x: Math.round(p.x), y: Math.round(p.y), s: p.source.id, tu: p.target?.id, a: p.ability, w: p.kind === 'linear' ? Math.round(p.width) : undefined,
    })),
    z: w.zones.filter((z) => z.team === team || w.pointVisible(team, z.x, z.y)).map((z) => ({
      i: z.id, fx: z.fx, x: Math.round(z.x), y: Math.round(z.y), r: z.r, t: z.team, e: r1(z.until - w.time), a: z.ability,
    })),
    fx: fx.filter((f) => fxVisible(w, f, team)),
    orbs: rules.orbs.filter((o) => shown.has(o.unit.id)).map((o) => ({
      i: o.unit.id, r: o.rarity, landed: o.landed, p: [...o.progress.entries()].filter(([, v]) => v > 0).map(([t, v]) => [t, r1(v)]),
    })),
    kills: w.teams.map((t) => t.kills),
    board: boardRows,
    me: null,
  };
}

/** Completa la parte de equipo para un jugador: sus unidades y su "me". */
export function forPlayer(w: World, part: Snapshot, hero: Unit | null): Snapshot {
  if (!hero?.playerId) return part;
  const pid = hero.playerId;
  const owned = new Set<number>();
  for (const u of w.list) if (u.playerId === pid) owned.add(u.id);
  return { ...part, u: part.u.map((x) => (owned.has(x.i) ? { ...x, o: 1 as const } : x)), me: encodeMe(w, hero) };
}

export function buildSnapshot(w: World, rules: OverthrowRules, team: number, hero: Unit | null, fx: Fx[], boardRows: BoardRow[]): Snapshot {
  return forPlayer(w, buildTeamSnapshot(w, rules, team, fx, boardRows), hero);
}
