// Objetos neutrales al estilo 7.38+: en cada tier cada héroe elige un trinket y un
// encantamiento. En Overthrow 3.0 no se recogen del mapa: llegan directamente al equipo.
import { ITEMS, NEUTRAL_TIERS, lv } from '../data';
import { NEUTRAL_SLOT, makeItem, removeItem, syncItemPassives } from '../sim/items';
import type { Props } from '../sim/types';
import type { Unit } from '../sim/unit';

/** Overthrow dura ~20 min: los tiers de Dota (0, 15, 25, 35, 60 min) se comprimen a un tercio. */
export const TIER_SCALE = 1 / 3;

export function tierTimes(): number[] {
  return NEUTRAL_TIERS.map((t) => {
    const [m, s] = t.start.split(':').map(Number);
    return (m * 60 + (s || 0)) * TIER_SCALE;
  });
}

const GROUP: Record<string, string> = { str: 'strength', agi: 'agility', int: 'intelligence', all: 'universal' };

export function trinketsOfTier(tier: number) {
  return Object.values(ITEMS).filter((d) => d.tier === tier).map((d) => d.key);
}

export function makeNeutralPick(u: Unit, tier: number, rng: () => number) {
  const t = NEUTRAL_TIERS.find((x) => x.tier === tier);
  if (!t) return null;
  const shuffle = <T,>(a: T[]) => a.map((v) => [rng(), v] as const).sort((x, y) => x[0] - y[0]).map((x) => x[1]);
  const trinkets = shuffle(trinketsOfTier(tier)).slice(0, t.trinkets);
  const pool = [...new Set([...(t.groups.global ?? []), ...(t.groups[GROUP[u.hero?.attr ?? 'all']] ?? [])])];
  const enhancements = shuffle(pool.filter((k) => ITEMS[k])).slice(0, t.enhancements);
  return { tier, trinkets, enhancements };
}

/** Claves de valores de encantamiento → propiedad (pct = viene en %). */
const ENH: Record<string, [keyof Props, boolean]> = {
  health_bonus: ['hp', false], bonus_health: ['hp', false], health_regen: ['hpRegen', false], slow_resist: ['slowResist', true],
  mana_regen: ['manaRegen', false], magic_res: ['magicResist', true], manacost_reduction: ['manaReduce', true],
  attack_lifesteal: ['lifesteal', true], spell_lifesteal: ['spellLifesteal', true], bonus_night_vision: ['vision', false],
  base_attack_damage: ['damage', false], bonus_damage: ['damage', false], status_resistance: ['statusResist', true],
  attack_speed: ['attackSpeed', false], bonus_attack_speed: ['attackSpeed', false], armor: ['armor', false], bonus_armor: ['armor', false],
  move_speed: ['msFlat', false], bonus_movement_speed: ['msFlat', false], movement_speed: ['msFlat', false],
  bonus_strength: ['str', false], bonus_agility: ['agi', false], bonus_intellect: ['int', false], bonus_all_stats: ['allStats', false],
  all_stats: ['allStats', false], spell_amp: ['spellAmp', true], cast_range: ['castRange', false], bonus_mana: ['mana', false],
  mana_bonus: ['mana', false], evasion: ['evasion', true], cooldown_reduction: ['cdr', true], bonus_cooldown: ['cdr', true],
  hp_regen_amp: ['hpRegenAmp', true], bonus_hp_regen: ['hpRegen', false], bonus_mana_regen: ['manaRegen', false],
  xp_bonus: ['xpGain', true], bonus_xp: ['xpGain', true], attack_range: ['attackRange', false], bonus_attack_range: ['attackRange', false],
  max_mana: ['mana', false], movespeed: ['msFlat', false], movespeed_pct: ['msPct', true], incoming_damage: ['incomingPct', true],
  health_restoration: ['hpRegenAmp', true], cast_range_bonus: ['castRange', false], mana_reduction_pct: ['manaReduce', true],
  max_health_regen: ['hpRegenPct', true],
};

export function enhancementProps(key: string, tier: number): Partial<Props> {
  const d = ITEMS[key];
  if (!d) return {};
  const level = Math.max(1, (d.enhancement ?? []).indexOf(tier) + 1);
  const out: Partial<Props> = {};
  for (const [k, arr] of Object.entries(d.values)) {
    const map = ENH[k];
    if (!map) continue;
    (out as any)[map[0]] = ((out as any)[map[0]] ?? 0) + lv(arr, level) / (map[1] ? 100 : 1);
  }
  return out;
}

/** Aplica la elección: el trinket va al hueco neutral y el encantamiento como stats permanentes. */
export function applyNeutralPick(u: Unit, trinket: number, enhancement: number): boolean {
  const p = u.neutralPicks[0];
  if (!p) return false;
  const tk = p.trinkets[trinket], ek = p.enhancements[enhancement];
  if (!tk || !ek) return false;
  u.neutralPicks.shift();
  const old = u.items[NEUTRAL_SLOT];
  if (old) removeItem(u, old);
  const it = makeItem(u, tk);
  it.data.tier = p.tier;
  u.items[NEUTRAL_SLOT] = it;
  u.removeModsByName('enhancement');
  u.addMod({ name: 'enhancement', persistent: true, props: enhancementProps(ek, p.tier), data: { key: ek, tier: p.tier } }, u, null);
  syncItemPassives(u);
  return true;
}
