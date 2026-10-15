// Acceso tipado a los JSON generados por scripts/gen-data.ts.
import heroesJson from './heroes.json';
import abilitiesJson from './abilities.json';
import itemsJson from './items.json';
import xpJson from './xp.json';
import unitsJson from './units.json';
import neutralJson from './neutral.json';

export type Attr = 'str' | 'agi' | 'int' | 'all';

export interface HeroData {
  key: string; name: string; attr: Attr; melee: boolean; roles: string[];
  hp: number; hpRegen: number; mana: number; manaRegen: number; armor: number; mr: number;
  dmgMin: number; dmgMax: number;
  str: number; agi: number; int: number; strGain: number; agiGain: number; intGain: number;
  range: number; projSpeed: number; bat: number; baseAs: number; attackPoint: number;
  ms: number; turnRate: number; dayVision: number; nightVision: number;
  abilities: string[];
  talents: { key: string; tier: number; name: string; value?: number }[];
  aghs: { scepter: string; scepterSkill: string; scepterNew: boolean; shard: string; shardSkill: string; shardNew: boolean } | null;
  allAbilities: string[];
}

/** Enlace de un valor con talentos (t), Scepter (sc) o Shard (sh): "+30", "-3", "x2", "+20%", o valor fijo. */
export interface ValueLink { t?: Record<string, string>; sc?: string; sh?: string; rs?: 1; rsh?: 1 }

export interface AbilityData {
  key: string; name: string; desc: string;
  /** Flags de comportamiento de Valve en minúsculas: passive, no_target, unit_target, point, aoe, channelled, toggle, autocast, hidden… */
  behavior: string[];
  dmgType: string | null; bkbPierce: boolean; targetTeam: string | null; targetType: string[];
  ult: boolean; innate: boolean; grantedBy: 'scepter' | 'shard' | null; maxLevel: number | null;
  breakable: boolean; dispellable: string | null;
  cd: number[]; mc: number[]; values: Record<string, number[]>; links: Record<string, ValueLink>;
}

export interface UnitData {
  key: string; level: number; hp: number; hpRegen: number; mana: number; manaRegen: number;
  armor: number; mr: number; dmgMin: number; dmgMax: number; bat: number; attackPoint: number;
  range: number; projSpeed: number; ms: number; turnRate: number; dayVision: number; nightVision: number;
  melee: boolean; canAttack: boolean; bountyGold: number; bountyXp: number; flying: boolean;
  abilities: string[]; scale: number;
}

export interface NeutralTier { tier: number; start: string; trinkets: number; enhancements: number; groups: Record<string, string[]> }

export interface ItemData {
  key: string; name: string; cost: number; qual: string | null;
  components: string[]; recipeCost: number; cd: number; mc: number; charges: number;
  active: boolean; desc: string; values: Record<string, number[]>; unbuildable?: boolean;
  links: Record<string, ValueLink>; behavior: string[];
  /** Tiers en los que aparece si es un encantamiento neutral. */
  enhancement: number[] | null;
  /** Tier de objeto neutral (1-5); 0 si es de tienda. */
  tier: number;
}

export const HEROES = heroesJson as unknown as Record<string, HeroData>;
export const ABILITIES = abilitiesJson as unknown as Record<string, AbilityData>;
export const ITEMS = itemsJson as unknown as Record<string, ItemData>;
/** XP acumulada necesaria para cada nivel: XP_TABLE[n-1] es la del nivel n. */
export const XP_TABLE = xpJson as number[];
export const UNITS = unitsJson as unknown as Record<string, UnitData>;
export const NEUTRAL_TIERS = neutralJson as unknown as NeutralTier[];
export const MAX_LEVEL = XP_TABLE.length;

// Las imágenes de Valve pasan por el servidor (/cdn) porque su CDN no permite CORS
// y WebGL no puede usar texturas de otro origen sin él.
export const STEAM_CDN = 'https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react';
const CDN = '/cdn';
export const heroIcon = (k: string) => `${CDN}/heroes/icons/${k}.png`;
export const heroPortrait = (k: string) => `${CDN}/heroes/${k}.png`;
export const abilityIcon = (k: string) => `${CDN}/abilities/${k}.png`;
export const itemIcon = (k: string) => `${CDN}/items/${k}.png`;

/** Valor por nivel (1-based); si hay menos valores que niveles se usa el último. */
export function lv(arr: number[] | undefined, level: number): number {
  if (!arr || arr.length === 0) return 0;
  return arr[Math.max(0, Math.min(arr.length - 1, level - 1))];
}
