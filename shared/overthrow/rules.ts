// Reglas de Overthrow 3.0: kill goal, Midas Throne, Kobold King con orbes capturables,
// orbes comunes por tiempo (más rápidos para quien va perdiendo), orbe raro por kills,
// entregas de orbes épicos, campamentos neutrales y fuentes que defienden la base.
import { UNITS, abilityIcon, lv } from '../data';
import { HERO_OPTS, available, refreshPassive, type UpgradeDef } from '../sim/abilities';
import { makeNeutralPick, tierTimes } from './neutrals';
import type { MapLayout } from '../maps';
import { ST } from '../sim/types';
import type { OrbPick, Unit, BaseStats } from '../sim/unit';
import { NEUTRAL, type Rules, type World } from '../sim/world';

import { TEAM_COLORS, TEAM_NAMES } from './teams';
export { TEAM_COLORS, TEAM_NAMES };

export const THRONE_RADIUS = 650;
const THRONE_GOLD = 7, THRONE_XP = 22;
const PASSIVE_GOLD = 3;
const KOBOLD_FIRST = 60, KOBOLD_EVERY = 50;
const COMMON_EVERY = 150;
const RARE_EVERY_KILLS = 8;
const EPIC_EVERY = 300;

const base = (o: Partial<BaseStats>): BaseStats => ({
  hp: 500, hpRegen: 1, mana: 0, manaRegen: 0, armor: 2, mr: 25, dmgMin: 20, dmgMax: 24,
  bat: 1.4, attackPoint: 0.4, range: 100, projSpeed: 900, ms: 330,
  dayVision: 800, nightVision: 600, turnRate: 0.6, melee: true, ...o,
});

/** Campamentos con los creeps neutrales reales de Dota (stats de npc_units). */
const CAMPS: Record<number, string[]> = {
  1: ['neutral_kobold', 'neutral_kobold', 'neutral_kobold_taskmaster'],
  2: ['neutral_giant_wolf', 'neutral_giant_wolf', 'neutral_alpha_wolf'],
  3: ['neutral_satyr_trickster', 'neutral_satyr_soulstealer', 'neutral_satyr_hellcaller'],
  4: ['neutral_centaur_outrunner', 'neutral_centaur_khan'],
};
/** Recompensa por nivel de creep cuando el dataset no la trae. */
const BOUNTY = (level: number) => [14 + level * 6, 20 + level * 14] as const;

interface Orb {
  unit: Unit;
  rarity: OrbPick['rarity'];
  progress: Map<number, number>;
  landed: boolean;
}

export class OverthrowRules implements Rules {
  w: World;
  map: MapLayout;
  orbs: Orb[] = [];
  kobold: Unit;
  throne: Unit;
  private nextKobold = KOBOLD_FIRST;
  private nextEpic = EPIC_EVERY;
  private nextCamps = 0;
  private nextTier = 0;
  private overtime = false;
  campUnits: Unit[][] = [];

  constructor(w: World, map: MapLayout) {
    this.w = w;
    this.map = map;
    w.rules = this;
    const N = map.def.teams;
    for (let i = 0; i < N; i++) {
      w.teams.push({
        id: i, name: TEAM_NAMES[i], color: TEAM_COLORS[i], kills: 0, fountain: map.fountains[i],
        data: { nextCommon: COMMON_EVERY, rareAt: RARE_EVERY_KILLS, orbs: 0 },
      });
      this.spawnFountain(i);
    }
    this.throne = w.addUnit('throne', 'midas_throne', NEUTRAL, base({ hp: 1, ms: 0 }), 0, 0);
    this.throne.x = 0; this.throne.y = 0;
    this.throne.addMod({ name: 'structure', persistent: true, states: ST.invulnerable | ST.untargetable });
    this.kobold = w.addUnit('kobold', 'kobold_king', NEUTRAL, base({ hp: 1, ms: 0 }), 0, -60);
    this.kobold.x = 0; this.kobold.y = -150;
    this.kobold.addMod({ name: 'structure', persistent: true, states: ST.invulnerable | ST.untargetable });
    this.campUnits = map.camps.map(() => []);
  }

  private spawnFountain(team: number) {
    const f = this.map.fountains[team];
    const u = this.w.addUnit('fountain', 'fountain', team, base({
      hp: 1, dmgMin: 260, dmgMax: 260, bat: 0.2, attackPoint: 0, range: 1050, melee: false,
      projSpeed: 2200, ms: 0, dayVision: 1300, nightVision: 1300, armor: 0, turnRate: 10,
    }), f.x, f.y);
    u.x = f.x; u.y = f.y;
    u.radius = 60;
    u.addMod({
      name: 'fountain', persistent: true, states: ST.invulnerable | ST.rooted,
      aura: {
        radius: 650, team: 'ally', heroesOnly: true,
        apply: (_m, t) => ({ name: 'fountain_heal', fx: 'fountain_heal', props: { hpRegenPct: 0.06, manaRegen: t.s.maxMana * 0.06 } }),
      },
    });
  }

  heroes(team?: number) { return this.w.list.filter((u) => u.kind === 'hero' && (team === undefined || u.team === team)); }

  tick(dt: number) {
    const w = this.w;
    if (w.over) return;
    // Oro pasivo y Midas Throne.
    for (const h of this.heroes()) {
      if (!h.alive) continue;
      h.gold += PASSIVE_GOLD * dt;
      if (Math.hypot(h.x, h.y) <= THRONE_RADIUS) {
        h.gold += THRONE_GOLD * dt;
        h.addXp(THRONE_XP * dt);
        if (w.tickN % 30 === 0) w.emit({ n: 'throne', x: h.x, y: h.y, u: h.id });
      }
    }
    if (w.time >= this.nextCamps) { this.nextCamps = w.time + 60; this.spawnCamps(); }
    this.tickNeutrals();
    if (w.time >= this.nextKobold) { this.nextKobold = w.time + KOBOLD_EVERY; this.throwOrb('common'); }
    if (w.time >= this.nextEpic) { this.nextEpic = w.time + EPIC_EVERY; this.throwOrb('epic', true); }
    this.tickOrbs(dt);
    this.tickCatchUp(dt);
    // Fin por tiempo.
    if (w.time >= this.map.def.timeLimit && !this.overtime) {
      const top = Math.max(...w.teams.map((t) => t.kills));
      const leaders = w.teams.filter((t) => t.kills === top);
      if (leaders.length === 1) this.finish(leaders[0].id, 'Tiempo agotado');
      else { this.overtime = true; w.emit({ n: 'announce', x: 0, y: 0, c: 'overtime' }); }
    }
  }

  /** Orbes comunes por tiempo: el líder espera el intervalo completo; el último, el 55%. */
  private tickCatchUp(dt: number) {
    const teams = [...this.w.teams].sort((a, b) => b.kills - a.kills);
    const n = teams.length;
    teams.forEach((t, rank) => {
      const factor = n > 1 ? 1 - 0.45 * (rank / (n - 1)) : 1;
      t.data.nextCommon -= dt / factor;
      if (t.data.nextCommon <= 0) {
        t.data.nextCommon = COMMON_EVERY;
        this.grantOrb(t.id, 'common');
      }
    });
  }

  private spawnCamps() {
    const minutes = this.w.time / 60;
    this.map.camps.forEach((c, i) => {
      if (this.campUnits[i].some((u) => u.alive)) return;
      const kind = c.tier === 3 ? (i % 4 === 1 ? 4 : 3) : c.tier;
      this.campUnits[i] = CAMPS[kind].map((name, k) => {
        const d = UNITS[name];
        const ang = (k / 3) * Math.PI * 2;
        const u = this.w.spawnSummon(this.kobold, name, c.x + Math.cos(ang) * 90, c.y + Math.sin(ang) * 90, Infinity, { kind: 'summon' });
        // Son neutrales, no del Kobold King.
        u.kind = 'creep'; u.team = NEUTRAL; u.owner = null; u.playerId = null;
        // Los neutrales mejoran con el tiempo (como cada 7,5 min en Dota, aquí más rápido).
        const scale = 1 + Math.floor(minutes / 2.5) * 0.1;
        u.base = { ...u.base, hp: u.base.hp * scale, dmgMin: u.base.dmgMin * scale, dmgMax: u.base.dmgMax * scale };
        u.refreshStats(); u.hp = u.s.maxHp;
        const [g, x] = BOUNTY(d?.level ?? 1);
        u.bountyGold = Math.round((d?.bountyGold || g) * (1 + minutes * 0.05));
        u.bountyXp = Math.round((d?.bountyXp || x) * (1 + minutes * 0.08));
        u.home = { x: u.x, y: u.y };
        return u;
      });
    });
  }

  /** Reparto de objetos neutrales por tiempo. */
  private tickNeutrals() {
    const times = tierTimes();
    while (this.nextTier < times.length && this.w.time >= times[this.nextTier]) {
      const tier = this.nextTier + 1;
      this.nextTier++;
      for (const h of this.heroes()) {
        const p = makeNeutralPick(h, tier, this.w.rng);
        if (p) h.neutralPicks.push(p);
      }
      if (tier > 1) this.w.emit({ n: 'announce', x: 0, y: 0, c: 'neutral', v: tier });
    }
  }

  throwOrb(rarity: OrbPick['rarity'], delivery = false) {
    const w = this.w;
    if (this.orbs.filter((o) => o.rarity === rarity).length >= 2) return;
    const [r0, r1] = this.map.orbRing;
    let p = { x: 0, y: 0 };
    for (let i = 0; i < 20; i++) {
      const ang = w.rng() * Math.PI * 2, r = r0 + w.rng() * (r1 - r0);
      p = w.grid.nearestFree(Math.cos(ang) * r, Math.sin(ang) * r);
      if (Math.hypot(p.x, p.y) > r0 * 0.8) break;
    }
    const u = w.addUnit('orb', 'orb_' + rarity, NEUTRAL, base({ hp: 1, ms: 0 }), p.x, p.y);
    u.addMod({ name: 'structure', persistent: true, states: ST.invulnerable | ST.untargetable });
    const orb: Orb = { unit: u, rarity, progress: new Map(), landed: false };
    this.orbs.push(orb);
    const from = delivery ? { x: p.x, y: p.y - 1500 } : this.kobold;
    w.emit({ n: 'orb_throw', x: from.x, y: from.y, x2: p.x, y2: p.y, d: 1.5, c: rarity });
    w.emit({ n: 'announce', x: p.x, y: p.y, c: delivery ? 'epic_orb' : 'orb' });
    w.after(1.5, () => { orb.landed = true; });
  }

  private tickOrbs(dt: number) {
    const w = this.w;
    for (const o of [...this.orbs]) {
      if (!o.landed) continue;
      const near = w.list.filter((u) => u.kind === 'hero' && u.alive && Math.hypot(u.x - o.unit.x, u.y - o.unit.y) <= 220);
      const teams = new Set(near.map((u) => u.team));
      if (teams.size === 1) {
        const t = [...teams][0];
        const v = (o.progress.get(t) ?? 0) + dt;
        o.progress.set(t, v);
        // El progreso de otros equipos se va perdiendo.
        for (const [k, pv] of o.progress) if (k !== t) o.progress.set(k, Math.max(0, pv - dt));
        if (v >= this.map.def.captureTime) {
          this.orbs.splice(this.orbs.indexOf(o), 1);
          w.removeUnit(o.unit);
          w.emit({ n: 'orb_capture', x: o.unit.x, y: o.unit.y, t, c: o.rarity });
          this.grantOrb(t, o.rarity);
        }
      } else if (teams.size === 0) {
        for (const [k, pv] of o.progress) o.progress.set(k, Math.max(0, pv - dt * 0.5));
      }
    }
  }

  grantOrb(team: number, rarity: OrbPick['rarity']) {
    this.w.teams[team].data.orbs++;
    for (const h of this.heroes(team)) h.orbPicks.push(makePick(h, rarity, this.w.rng));
  }

  onHeroKilled(victim: Unit, killer: Unit | null) {
    if (!killer || killer.team === victim.team) return;
    const t = this.w.teams[killer.team];
    t.kills++;
    this.w.emit({ n: 'kill', x: victim.x, y: victim.y, u: victim.id, u2: killer.id, t: killer.team });
    if (t.kills >= t.data.rareAt) { t.data.rareAt += RARE_EVERY_KILLS; this.grantOrb(t.id, 'rare'); }
    if (t.kills >= this.map.def.killGoal) this.finish(t.id, 'Kill goal');
    else if (this.overtime) this.finish(t.id, 'Prórroga');
  }

  finish(team: number, reason: string) {
    if (this.w.over) return;
    this.w.over = { winner: team, reason };
  }
}

// ---------------- Mejoras de orbe ----------------

type Opt = OrbPick['options'][number] & { apply(h: Unit): void };
const MULT = { common: 1, rare: 2, epic: 4 } as const;

/** Mejora permanente de stats que sobrevive a la muerte. */
function bonusMod(h: Unit) {
  let m = h.findMod('orb_bonus');
  if (!m) m = h.addMod({ name: 'orb_bonus', persistent: true, props: {} as any, data: { multi: false } }, h, null);
  return m;
}
function addBonus(h: Unit, key: string, v: number) {
  const m = bonusMod(h);
  const p = m.props as Record<string, number>;
  p[key] = (p[key] ?? 0) + v;
  h.refreshStats();
}

/** Mejoras automáticas cuando el héroe no define las suyas: daño, enfriamiento, radio y duración. */
export function autoUpgrades(h: Unit): UpgradeDef[] {
  const out: UpgradeDef[] = [];
  for (const a of h.abilities) {
    if (a.impl.hidden || a.impl.sub) continue;
    const name = a.def.name;
    const keys = Object.keys(a.def.values);
    const dmgKey = keys.find((k) => /damage|dmg/.test(k) && !/pct|percent|tooltip|reduction|type|delay|interval|threshold|duration|radius|block|_per_|bonus_.*_pct/.test(k) && lv(a.def.values[k], 4) > 0);
    if (dmgKey) out.push({ slot: a.slot, key: dmgKey, amount: 15, pct: true, max: 5, label: `${name}: +15% ${dmgKey.replaceAll('_', ' ')}` });
    if (lv(a.def.values._cd ?? a.def.cd, 4) > 0) out.push({ slot: a.slot, key: '_cd', amount: -8, pct: true, max: 5, label: `${name}: −8% enfriamiento` });
    const rKey = keys.find((k) => /radius|aoe|width/.test(k) && !/tooltip|vision/.test(k) && lv(a.def.values[k], 4) > 0);
    if (rKey) out.push({ slot: a.slot, key: rKey, amount: 12, pct: true, max: 4, label: `${name}: +12% ${rKey.replaceAll('_', ' ')}` });
    const dKey = keys.find((k) => /duration/.test(k) && !/tooltip|linger|fade|_slow_|vision/.test(k) && lv(a.def.values[k], 4) > 0);
    if (dKey) out.push({ slot: a.slot, key: dKey, amount: 12, pct: true, max: 4, label: `${name}: +12% ${dKey.replaceAll('_', ' ')}` });
  }
  return out;
}

export function pickOptions(h: Unit, rarity: OrbPick['rarity']): Opt[] {
  const k = MULT[rarity];
  const opts: Opt[] = [];
  const defs = HERO_OPTS[h.name]?.upgrades ?? autoUpgrades(h);
  for (const d of defs) {
    const a = h.abilities[d.slot];
    if (!a || !available(a)) continue;
    const id = `v:${d.slot}:${d.key}:${d.label}`;
    if (d.max !== undefined && (h.orbCounts[id] ?? 0) >= d.max) continue;
    const amount = d.amount * k;
    const shown = d.pct ? `${amount > 0 ? '+' : ''}${amount}%` : `${amount > 0 ? '+' : ''}${amount}`;
    opts.push({
      id, icon: abilityIcon(a.key),
      label: d.label.replace(/[+−-]?\d+(\.\d+)?%?/, shown),
      desc: rarity === 'common' ? 'Mejora permanente' : `Mejora ${rarity === 'rare' ? 'rara (×2)' : 'épica (×4)'}`,
      apply: (hh) => {
        hh.orbCounts[id] = (hh.orbCounts[id] ?? 0) + 1;
        const ab = hh.abilities[d.slot];
        if (d.pct) ab.mult[d.key] = Math.max(0.2, (ab.mult[d.key] ?? 1) * (1 + amount / 100));
        else ab.bonus[d.key] = (ab.bonus[d.key] ?? 0) + amount;
        refreshPassive(ab);
      },
    });
  }
  const stat = (id: string, label: string, key: string, v: number, icon: string) =>
    opts.push({ id, label, desc: 'Permanente', icon, apply: (hh) => addBonus(hh, key, v) });
  stat('allstats', `+${4 * k} a todos los atributos`, 'allStats', 4 * k, 'ultimate_orb');
  stat('as', `+${20 * k} velocidad de ataque`, 'attackSpeed', 20 * k, 'gloves');
  stat('dmg', `+${12 * k} daño`, 'damage', 12 * k, 'blades_of_attack');
  stat('armor', `+${3 * k} armadura`, 'armor', 3 * k, 'chainmail');
  stat('hp', `+${200 * k} vida`, 'hp', 200 * k, 'vitality_booster');
  stat('mana', `+${150 * k} maná`, 'mana', 150 * k, 'energy_booster');
  stat('ms', `+${10 * k} velocidad`, 'msFlat', 10 * k, 'boots');
  stat('spell', `+${5 * k}% amplificación`, 'spellAmp', 0.05 * k, 'kaya');
  return opts;
}

function makePick(h: Unit, rarity: OrbPick['rarity'], rng: () => number): OrbPick {
  const all = pickOptions(h, rarity);
  const out: OrbPick['options'] = [];
  const used = new Set<number>();
  while (out.length < 3 && used.size < all.length) {
    const i = Math.floor(rng() * all.length);
    if (used.has(i)) continue;
    used.add(i);
    const { id, label, desc, icon } = all[i];
    out.push({ id, label, desc, icon });
  }
  return { rarity, options: out };
}

export function applyPick(h: Unit, index: number): boolean {
  const pick = h.orbPicks[0];
  if (!pick || !pick.options[index]) return false;
  const chosen = pick.options[index];
  const opt = pickOptions(h, pick.rarity).find((o) => o.id === chosen.id);
  h.orbPicks.shift();
  if (!opt) return false;
  opt.apply(h);
  return true;
}
