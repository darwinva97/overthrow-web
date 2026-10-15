// Unidad y cálculo de stats con las fórmulas de Dota 7.39.
import { MAX_LEVEL, XP_TABLE, type HeroData } from '../data';
import type {
  AbilityInst, ItemInst, ModSpec, Modifier, Order, Props, Stats, UnitKind,
  Unit as UnitT,
} from './types';
import { ST } from './types';
import type { World } from './world';

/** Stats base de unidades que no son héroes (creeps, wards…). */
export interface BaseStats {
  hp: number; hpRegen: number; mana: number; manaRegen: number;
  armor: number; mr: number; dmgMin: number; dmgMax: number;
  bat: number; attackPoint: number; range: number; projSpeed: number;
  ms: number; dayVision: number; nightVision: number; turnRate: number;
  melee: boolean;
}

export const ATTR = {
  hpPerStr: 22, hpRegenPerStr: 0.1,
  armorPerAgi: 1 / 6, asPerAgi: 1,
  manaPerInt: 12, manaRegenPerInt: 0.05, mrPerInt: 0.001,
  universalDmg: 0.45,
};

export const armorMult = (armor: number) => 1 - (0.06 * armor) / (1 + 0.06 * Math.abs(armor));

const zeroProps = (): Props => ({
  str: 0, agi: 0, int: 0, allStats: 0, agiBasePct: 0,
  damage: 0, damagePct: 0, attackSpeed: 0, armor: 0, magicResist: 0,
  msFlat: 0, msPct: 0, msSlow: 0, msFixed: 0, hp: 0, mana: 0, hpRegen: 0, manaRegen: 0,
  hpRegenPct: 0, hpRegenAmp: 0, manaRegenAmp: 0, evasion: 0, spellAmp: 0, attackRange: 0,
  castRange: 0, statusResist: 0, slowResist: 0, lifesteal: 0, spellLifesteal: 0,
  incomingPct: 0, outgoingPct: 0, damageBlock: 0, vision: 0, attackSlow: 0,
  cdr: 0, manaReduce: 0, healAmp: 0, xpGain: 0, respawnReduce: 0, trueSight: 0, cleave: 0, msMax: 0, meleeRange: 0, missChance: 0, batOverride: 0,
});

let nextModId = 1;

export class Unit implements UnitT {
  [k: string]: any;
  id: number;
  w: World;
  kind: UnitKind;
  team: number;
  name: string;
  hero: HeroData | null;
  base: BaseStats;
  playerId: string | null = null;
  x: number; y: number; facing = 0;
  radius: number;
  alive = true;
  hp = 1; mana = 0;
  level = 1; xp = 0; gold = 0;
  /** Atributos permanentes ganados (Flesh Heap, tomos, mejoras de orbe). */
  permStr = 0; permAgi = 0; permInt = 0;
  abilities: AbilityInst[] = [];
  /** 0-5 inventario, 6-8 mochila, 9 objeto neutral. */
  items: (ItemInst | null)[] = new Array(10).fill(null);
  talents = new Set<string>();
  shard = false;
  blessing = false;
  /** Veces que se ha elegido cada mejora de orbe (para su máximo). */
  orbCounts: Record<string, number> = {};
  neutralPicks: NeutralPick[] = [];
  stash: ItemInst[] = [];
  mods: Modifier[] = [];
  s: Stats;
  owner: Unit | null = null;
  order: Order | null = null;
  /** Órdenes encoladas con Shift. */
  queue: Order[] = [];
  path: { x: number; y: number }[] = [];
  pathFor = '';
  /** Estado de ataque. */
  atk = { target: 0, phase: 0 as 0 | 1, t: 0, cd: 0 };
  /** Estado de lanzamiento: fase 1 = cast point, 2 = canalizando. */
  cast: null | {
    a: AbilityInst | ItemInst; tu: number; tx: number; ty: number;
    phase: 1 | 2; t: number; channel: number;
  } = null;
  respawnAt = 0;
  expireAt = Infinity;
  kills = 0; deaths = 0; assists = 0; lastHits = 0;
  /** Quién le ha hecho daño y cuándo, para asistencias. */
  damagedBy = new Map<number, number>();
  lastHeroDamageAt = -99;
  lastDamageAt = -99;
  bountyGold = 0; bountyXp = 0;
  /** Área de campamento para creeps neutrales. */
  home: { x: number; y: number } | null = null;
  abilityPoints = 0;
  orbPicks: OrbPick[] = [];
  isBot = false;
  ai: any = null;

  constructor(w: World, id: number, kind: UnitKind, team: number, name: string, base: BaseStats, hero: HeroData | null, x: number, y: number) {
    this.w = w; this.id = id; this.kind = kind; this.team = team; this.name = name;
    this.base = base; this.hero = hero; this.x = x; this.y = y;
    this.radius = kind === 'hero' || kind === 'illusion' ? 24 : kind === 'creep' ? 20 : 16;
    this.s = this.computeStats();
    this.hp = this.s.maxHp;
    this.mana = this.s.maxMana;
  }

  get isHero() { return this.kind === 'hero'; }
  get isIllusion() { return this.kind === 'illusion'; }
  /** Clon de héroe (Meepo, Tempest Double): cuenta como héroe a efectos de objetivos. */
  heroClone = false;
  get isHeroLike() { return this.kind === 'hero' || this.kind === 'illusion' || this.heroClone; }
  get melee() { return this.base.melee; }

  has(state: number) { return (this.s.states & state) !== 0; }

  /** Modificadores cuyos eventos cuentan: con Break, las pasivas de habilidad no. */
  hooks(): Modifier[] {
    if (!this.has(ST.broken)) return [...this.mods];
    return this.mods.filter((m) => !isBreakable(m));
  }

  /** Atributo base de héroe al nivel actual, sin bonus. */
  baseAttr(a: 'str' | 'agi' | 'int'): number {
    const h = this.hero;
    if (!h) return 0;
    const gain = a === 'str' ? h.strGain : a === 'agi' ? h.agiGain : h.intGain;
    const perm = a === 'str' ? this.permStr : a === 'agi' ? this.permAgi : this.permInt;
    return h[a] + gain * (this.level - 1) + perm;
  }

  computeStats(): Stats {
    const p = zeroProps();
    let mrMult = 1 - this.base.mr / 100;
    let evMult = 1;
    let cdMult = 1;
    let states = 0;
    for (const m of this.mods) states |= m.states ?? 0;
    const broken = (states & ST.broken) !== 0;
    for (const m of this.mods) {
      if (broken && isBreakable(m)) continue;
      const mp = typeof m.props === 'function' ? m.props(m) : m.props;
      if (!mp) continue;
      for (const k in mp) {
        const v = (mp as any)[k] as number;
        if (k === 'magicResist') mrMult *= 1 - v;
        else if (k === 'evasion') evMult *= 1 - v;
        else if (k === 'cdr') cdMult *= 1 - v;
        else if (k === 'batOverride') { if (v > 0 && (p.batOverride === 0 || v < p.batOverride)) p.batOverride = v; }
        else (p as any)[k] += v;
      }
    }
    p.cdr = 1 - cdMult;
    const b = this.base;
    let str = 0, agi = 0, int = 0;
    if (this.hero) {
      str = this.baseAttr('str') + p.str + p.allStats;
      agi = this.baseAttr('agi') * (1 + p.agiBasePct) + p.agi + p.allStats;
      int = this.baseAttr('int') + p.int + p.allStats;
    }
    const primary = !this.hero ? 0
      : this.hero.attr === 'all' ? (str + agi + int) * ATTR.universalDmg
      : this.hero.attr === 'str' ? str : this.hero.attr === 'agi' ? agi : int;
    mrMult *= 1 - int * ATTR.mrPerInt;
    if (states & ST.magicImmune) mrMult *= 1; // la inmunidad se resuelve en el daño
    const maxHp = Math.max(1, b.hp + str * ATTR.hpPerStr + p.hp);
    const maxMana = Math.max(0, b.mana + int * ATTR.manaPerInt + p.mana);
    const hpRegen = (b.hpRegen + str * ATTR.hpRegenPerStr + p.hpRegen + maxHp * p.hpRegenPct) * (1 + p.hpRegenAmp);
    const manaRegen = (b.manaRegen + int * ATTR.manaRegenPerInt + p.manaRegen) * (1 + p.manaRegenAmp);
    const as = Math.max(20, Math.min(700, 100 + agi * ATTR.asPerAgi + p.attackSpeed - p.attackSlow));
    const slow = p.msSlow * (1 - Math.min(1, p.slowResist));
    let ms = (b.ms + p.msFlat) * Math.max(0.1, 1 + p.msPct - slow);
    if (p.msFixed > 0) ms = p.msFixed;
    ms = Math.max(100, Math.min(Math.max(550, p.msMax), ms));
    const baseDmg = (1 + p.damagePct);
    const night = this.w ? this.w.isNight() : false;
    return {
      str, agi, int, maxHp, maxMana, hpRegen, manaRegen,
      armor: b.armor + agi * ATTR.armorPerAgi + p.armor,
      mr: 1 - mrMult,
      dmgMin: (b.dmgMin + primary) * baseDmg,
      dmgMax: (b.dmgMax + primary) * baseDmg,
      dmgBonus: p.damage,
      as, bat: p.batOverride > 0 ? p.batOverride : b.bat,
      attackRange: b.range + (b.melee ? 0 : p.attackRange) + p.meleeRange,
      ms,
      evasion: 1 - evMult,
      spellAmp: p.spellAmp,
      castRange: p.castRange,
      statusResist: Math.min(0.9, p.statusResist),
      slowResist: p.slowResist,
      lifesteal: p.lifesteal,
      spellLifesteal: p.spellLifesteal,
      incomingPct: p.incomingPct,
      outgoingPct: p.outgoingPct,
      damageBlock: p.damageBlock,
      vision: (night ? b.nightVision : b.dayVision) + p.vision,
      cdr: p.cdr, manaReduce: Math.min(0.9, p.manaReduce), healAmp: p.healAmp + p.hpRegenAmp, xpGain: p.xpGain,
      respawnReduce: p.respawnReduce, trueSight: p.trueSight, cleave: p.cleave, missChance: Math.min(1, p.missChance),
      states,
    };
  }

  /** Recalcula stats manteniendo el % de vida y maná. */
  refreshStats() {
    const oldHp = this.s.maxHp, oldMana = this.s.maxMana;
    this.s = this.computeStats();
    if (this.s.maxHp !== oldHp) this.hp = Math.min(this.s.maxHp, this.hp * this.s.maxHp / oldHp);
    if (this.s.maxMana !== oldMana && oldMana > 0) this.mana = Math.min(this.s.maxMana, this.mana * this.s.maxMana / oldMana);
    else this.mana = Math.min(this.mana, this.s.maxMana);
  }

  /** Tiempo entre ataques y punto de ataque reales. */
  attackInterval() { return this.s.bat / (this.s.as / 100); }
  attackPointTime() { return this.base.attackPoint / (this.s.as / 100); }

  // ---------------- Modificadores ----------------

  addMod(spec: ModSpec, caster: UnitT | null = null, ability: Modifier['ability'] = null): Modifier {
    let duration = spec.duration ?? Infinity;
    const debuff = spec.debuff ?? false;
    if (debuff && caster && caster.team !== this.team && Number.isFinite(duration)) {
      duration *= 1 - this.s.statusResist;
    }
    const existing = this.mods.find((m) => m.name === spec.name && m.caster === caster);
    if (existing && !spec.data?.multi) {
      existing.remaining = Math.max(existing.remaining, duration);
      existing.duration = Math.max(existing.duration, duration);
      // Renovar una aura solo cambia la duración: no hace falta recalcular stats.
      if (spec.stacks !== undefined && spec.stacks !== existing.stacks) { existing.stacks = spec.stacks; this.refreshStats(); }
      else if (spec.props && typeof spec.props === 'object' && existing.props !== spec.props) {
        const a = existing.props as Record<string, number> | undefined, b = spec.props as Record<string, number>;
        let same = !!a && typeof a === 'object';
        if (same) for (const k in b) if (a![k] !== b[k]) { same = false; break; }
        if (!same) { existing.props = spec.props; this.refreshStats(); }
      }
      return existing;
    }
    const m: Modifier = {
      ...spec,
      name: spec.name,
      caster: caster as any,
      ability: spec.ability ?? ability,
      remaining: duration,
      duration,
      stacks: spec.stacks ?? 1,
      debuff,
      purgable: spec.purgable ?? debuff,
      data: { ...(spec.data ?? {}), _id: nextModId++ },
      acc: 0,
      owner: this,
    };
    this.mods.push(m);
    m.onCreated?.(m);
    this.refreshStats();
    return m;
  }

  removeMod(m: Modifier) {
    const i = this.mods.indexOf(m);
    if (i < 0) return;
    this.mods.splice(i, 1);
    m.onDestroy?.(m);
    this.refreshStats();
  }

  findMod(name: string, caster?: UnitT | null): Modifier | undefined {
    return this.mods.find((m) => m.name === name && (caster === undefined || m.caster === caster));
  }

  removeModsByName(name: string) {
    for (const m of [...this.mods]) if (m.name === name) this.removeMod(m);
  }

  /** Disipación: básica quita buffs purgables de enemigos o debuffs propios. */
  purge(debuffs: boolean, buffs: boolean, strong = false) {
    for (const m of [...this.mods]) {
      if (!m.purgable && !(strong && m.debuff && m.data.strongPurgable)) continue;
      if ((m.debuff && debuffs) || (!m.debuff && buffs)) this.removeMod(m);
    }
  }

  // ---------------- Nivel ----------------

  addXp(amount: number) {
    if (!this.isHero || this.level >= MAX_LEVEL) return;
    this.xp += amount * (1 + this.s.xpGain);
    while (this.level < MAX_LEVEL && this.xp >= XP_TABLE[this.level]) {
      this.level++;
      this.abilityPoints++;
      this.refreshStats();
      this.w.emit({ n: 'levelup', x: this.x, y: this.y, u: this.id });
    }
  }

  // ---------------- Inventario ----------------

  item(slot: number) { return this.items[slot] ?? null; }
  hasItem(key: string) { return this.items.some((i, s) => i?.key === key && s < 6); }
  /** Hueco libre de inventario (nunca el neutral). */
  freeSlot(includeBackpack = true): number {
    const n = includeBackpack ? 9 : 6;
    for (let i = 0; i < n; i++) if (!this.items[i]) return i;
    return -1;
  }
}

/** Pasiva de habilidad que Break desactiva. */
function isBreakable(m: Modifier) {
  const a = m.ability as AbilityInst | null;
  return !!a && !(a as any).isItem && a.impl?.target === 'passive' && a.def?.breakable !== false && m === a.passiveMod;
}

export interface NeutralPick {
  tier: number;
  trinkets: string[];
  enhancements: string[];
}

export interface OrbPick {
  rarity: 'common' | 'rare' | 'epic';
  options: { id: string; label: string; desc: string; icon: string }[];
}
