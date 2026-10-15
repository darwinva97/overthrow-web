// Registro de habilidades y valores por nivel. Un valor del dataset puede estar enlazado
// a talentos, Aghanim's Scepter o Shard (como en los scripts de Valve) y a mejoras de orbe.
import { ABILITIES, lv, type ValueLink } from '../data';
import type { AbilityImpl, AbilityInst, ItemInst, ModSpec } from './types';
import type { Unit } from './unit';

const IMPLS = new Map<string, AbilityImpl>();

export function defineAbility(impl: AbilityImpl) {
  IMPLS.set(impl.key, impl);
  return impl;
}
export const abilityImpl = (key: string) => IMPLS.get(key);
export const hasAbilityImpl = (key: string) => IMPLS.has(key);

/** Mejora de orbe sobre un valor concreto de una habilidad, como en Overthrow 3.0. */
export interface UpgradeDef {
  /** Hueco de la habilidad en el kit. */
  slot: number;
  /** Clave del valor ('_cd' enfriamiento, '_mc' maná, o una de AbilityValues). */
  key: string;
  /** Cantidad por mejora común. Con `pct`, porcentaje del valor base. */
  amount: number;
  pct?: boolean;
  /** Veces máximas que se puede coger. */
  max?: number;
  label: string;
}

export interface HeroOpts {
  /** Compra de los bots, en orden. */
  build?: string[];
  /** Mejoras de orbe propias del héroe; si no hay, se generan desde sus valores. */
  upgrades?: UpgradeDef[];
  /** Efectos de talentos que no son un simple enlace de valor (se aplican al cogerlos). */
  talents?: Record<string, (u: Unit) => void>;
}

/** Héroes jugables: héroe → claves de habilidad en orden de hueco. */
export const HERO_KITS: Record<string, string[]> = {};
export const HERO_OPTS: Record<string, HeroOpts> = {};
export function defineHero(hero: string, kit: string[], opts: HeroOpts = {}) {
  HERO_KITS[hero] = kit;
  HERO_OPTS[hero] = opts;
}

export const isItem = (a: AbilityInst | ItemInst): a is ItemInst => (a as ItemInst).isItem === true;

/** Héroe "real" detrás de una ilusión o invocación, para Scepter, Shard y talentos. */
function source(u: Unit): Unit {
  return u.kind === 'illusion' && u.owner ? (u.owner as Unit) : u;
}
export function hasScepter(u: Unit): boolean {
  const s = source(u);
  return s.blessing || s.items.some((i, k) => k < 6 && i?.key === 'ultimate_scepter');
}
export const hasShard = (u: Unit) => source(u).shard;
export const hasTalent = (u: Unit, key: string) => source(u).talents.has(key);

/** Aplica una operación de enlace de Valve ("+30", "-20%", "x2", "=5", "0.8 1.0 1.2", que suma por nivel). */
export function applyOp(base: number, op: string, level: number): number {
  const s = op.trim();
  const tokens = s.split(/\s+/);
  const t = tokens.length > 1 ? tokens[Math.max(0, Math.min(tokens.length - 1, level - 1))] : s;
  const n = parseFloat(t.replace(/^[+=x]/, '').replace('%', ''));
  if (!Number.isFinite(n)) return base;
  if (t.startsWith('x')) return base * n;
  if (t.startsWith('=')) return n;
  // Como en Valve: sin signo también suma ("200" = "+200"); "%" es sobre el valor base.
  if (t.endsWith('%')) return base * (1 + n / 100);
  return base + n;
}

function linked(u: Unit, link: ValueLink | undefined, base: number, level: number): number {
  if (!link) return base;
  let v = base;
  if (link.rs && !hasScepter(u)) return 0;
  if (link.rsh && !hasShard(u)) return 0;
  if (link.t) for (const [t, op] of Object.entries(link.t)) if (hasTalent(u, t)) v = applyOp(v, op, level);
  if (link.sc && hasScepter(u)) v = applyOp(v, link.sc, level);
  if (link.sh && hasShard(u)) v = applyOp(v, link.sh, level);
  return v;
}

/** Valor de la habilidad a su nivel actual (mínimo 1), con talentos, Aghanim's y mejoras. */
export function val(a: AbilityInst, key: string): number {
  const level = Math.max(1, a.level);
  const base = lv(a.def.values[key], level);
  const v = linked(a.owner as Unit, a.def.links?.[key], base, level);
  return (v + (a.bonus[key] ?? 0)) * (a.mult[key] ?? 1);
}
/** Valor de daño con la mejora genérica de orbe aplicada. */
export const dmg = (a: AbilityInst, key: string) => val(a, key) * a.upg.dmg;
/** Valor de duración con la mejora genérica de orbe aplicada. */
export const dur = (a: AbilityInst, key: string) => val(a, key) * a.upg.dur;

export function maxLevel(a: AbilityInst): number {
  if (a.impl.innate || a.def.innate || a.impl.requires || a.def.grantedBy) return a.def.maxLevel ?? 1;
  if (a.def.maxLevel) return a.def.maxLevel;
  if (a.impl.ult || a.def.ult) return 3;
  return 4;
}

/** Está disponible ahora mismo (las de Scepter/Shard se ocultan sin el objeto). */
export function available(a: AbilityInst): boolean {
  const req = a.impl.requires ?? a.def.grantedBy;
  if (req === 'scepter') return hasScepter(a.owner as Unit);
  if (req === 'shard') return hasShard(a.owner as Unit);
  return true;
}

/** No consume puntos: innatas, concedidas por Aghanim's o que siguen a otra habilidad. */
export function autoLeveled(a: AbilityInst) {
  return !!(a.impl.innate || a.def.innate || a.impl.requires || a.def.grantedBy || a.impl.levelWith !== undefined || a.impl.sub);
}

/** Regla de Dota: una básica a nivel n exige nivel de héroe 2n-1; la ulti, 6/12/18. */
export function canLevelAbility(u: Unit, a: AbilityInst): boolean {
  if (u.abilityPoints <= 0 || autoLeveled(a) || a.impl.hidden === true) return false;
  if (a.level >= maxLevel(a)) return false;
  if (a.impl.ult || a.def.ult) return u.level >= [6, 12, 18, 24, 30][a.level];
  return u.level >= 2 * a.level + 1;
}

export function levelAbility(u: Unit, a: AbilityInst) {
  if (!canLevelAbility(u, a)) return false;
  a.level++;
  u.abilityPoints--;
  a.impl.onLevelUp?.(a);
  if (a.impl.charges && a.level === 1) a.charges = a.impl.charges(a)[0];
  refreshPassive(a);
  syncAutoLevels(u);
  return true;
}

/** Ajusta el nivel de las habilidades que no se aprenden a mano. */
export function syncAutoLevels(u: Unit) {
  for (const a of u.abilities) {
    let lvl = a.level;
    if (a.impl.levelWith !== undefined) lvl = u.abilities[a.impl.levelWith]?.level ?? 0;
    else if (a.impl.requires || a.def.grantedBy) {
      const ult = u.abilities.find((x) => x.impl.ult || x.def.ult);
      lvl = available(a) ? (maxLevel(a) > 1 ? Math.max(1, ult?.level ?? 1) : 1) : 0;
    } else if (a.impl.innate || a.def.innate) lvl = 1;
    if (lvl !== a.level) {
      a.level = lvl;
      if (a.impl.charges && a.level > 0 && a.charges === 0) a.charges = a.impl.charges(a)[0];
      refreshPassive(a);
    }
  }
}

export function refreshPassive(a: AbilityInst) {
  const u = a.owner as Unit;
  if (a.passiveMod) { u.removeMod(a.passiveMod); a.passiveMod = null; }
  if (a.level <= 0 || !a.impl.passive || !available(a)) return;
  if (u.kind === 'illusion' && a.impl.noIllusion) return;
  const spec = a.impl.passive(a);
  if (!spec) return;
  a.passiveMod = u.addMod({ persistent: true, ...spec } as ModSpec, u, a);
}

export function makeAbility(owner: Unit, key: string, slot: number): AbilityInst | null {
  const impl = IMPLS.get(key);
  const def = ABILITIES[key];
  if (!impl || !def) return null;
  return {
    key, def, impl, owner, slot,
    level: impl.innate || def.innate ? 1 : 0,
    cd: 0, charges: 0, chargeCd: 0, toggled: false,
    upg: { dmg: 1, cd: 1, dur: 1, range: 1 },
    bonus: {}, mult: {},
    passiveMod: null, data: {},
  };
}

export function cooldownOf(a: AbilityInst): number {
  const base = a.def.values._cd ? val(a, '_cd') : lv(a.def.cd, a.level);
  return base * a.upg.cd * (1 - (a.owner as Unit).s.cdr);
}
export function manaCostOf(a: AbilityInst): number {
  const base = a.def.values._mc ? val(a, '_mc') : lv(a.def.mc, a.level);
  return base * (1 - (a.owner as Unit).s.manaReduce);
}
export function castRangeOf(a: AbilityInst): number {
  const base = a.impl.castRange ? a.impl.castRange(a) : val(a, 'abilitycastrange');
  return base * a.upg.range + (a.owner as Unit).s.castRange;
}
export function castPointOf(a: AbilityInst): number {
  return a.impl.castPoint ? a.impl.castPoint(a) : val(a, 'abilitycastpoint');
}
