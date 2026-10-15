// Árbol de talentos de Dota: a nivel 10, 15, 20 y 25 se elige uno de dos (cuesta un punto).
// Los talentos "únicos" que modifican un valor ya los resuelve val() con los enlaces del
// dataset; aquí se aplican los genéricos de stats y los efectos propios definidos por héroe.
import { ABILITIES, lv } from '../data';
import { HERO_OPTS, refreshPassive, syncAutoLevels } from './abilities';
import type { Props } from './types';
import type { Unit } from './unit';

export const TALENT_LEVELS = [10, 15, 20, 25];

/** Talento genérico → propiedad (pct = el valor viene en %). */
const GENERIC: [RegExp, keyof Props, boolean][] = [
  [/^special_bonus_attack_damage_/, 'damage', false],
  [/^special_bonus_hp_regen_/, 'hpRegen', false],
  [/^special_bonus_mp_regen_/, 'manaRegen', false],
  [/^special_bonus_hp_/, 'hp', false],
  [/^special_bonus_mp_/, 'mana', false],
  [/^special_bonus_armor_/, 'armor', false],
  [/^special_bonus_attack_speed_/, 'attackSpeed', false],
  [/^special_bonus_movement_speed_/, 'msFlat', false],
  [/^special_bonus_all_stats_/, 'allStats', false],
  [/^special_bonus_strength_/, 'str', false],
  [/^special_bonus_agility_/, 'agi', false],
  [/^special_bonus_intelligence_/, 'int', false],
  [/^special_bonus_magic_resistance_/, 'magicResist', true],
  [/^special_bonus_spell_amplify_/, 'spellAmp', true],
  [/^special_bonus_cooldown_reduction_/, 'cdr', true],
  [/^special_bonus_evasion_/, 'evasion', true],
  [/^special_bonus_lifesteal_/, 'lifesteal', true],
  [/^special_bonus_spell_lifesteal_/, 'spellLifesteal', true],
  [/^special_bonus_cast_range_/, 'castRange', false],
  [/^special_bonus_attack_range_/, 'attackRange', false],
  [/^special_bonus_status_resistance_/, 'statusResist', true],
  [/^special_bonus_respawn_reduction_/, 'respawnReduce', false],
  [/^special_bonus_exp_boost_/, 'xpGain', true],
  [/^special_bonus_cleave_/, 'cleave', true],
  [/^special_bonus_night_vision_/, 'vision', false],
  [/^special_bonus_attack_base_damage_/, 'damage', false],
  [/^special_bonus_mana_reduction_/, 'manaReduce', true],
  [/^special_bonus_movement_speed_pct_/, 'msPct', true],
];

function talentValue(key: string): number {
  const d = ABILITIES[key];
  const v = d ? lv(d.values.value, 1) : 0;
  if (v) return v;
  const m = /_(\d+)$/.exec(key);
  return m ? +m[1] : 0;
}

export function genericTalent(key: string): Partial<Props> | null {
  for (const [re, prop, pct] of GENERIC) {
    if (re.test(key)) return { [prop]: talentValue(key) / (pct ? 100 : 1) } as Partial<Props>;
  }
  return null;
}

export interface TalentRow { tier: number; level: number; options: { key: string; name: string; picked: boolean }[]; can: boolean }

export function talentRows(u: Unit): TalentRow[] {
  const ts = u.hero?.talents ?? [];
  return TALENT_LEVELS.map((level, i) => {
    const options = ts.filter((t) => t.tier === i + 1).map((t) => ({ key: t.key, name: t.name, picked: u.talents.has(t.key) }));
    const done = options.some((o) => o.picked);
    return { tier: i + 1, level, options, can: !done && u.level >= level && u.abilityPoints > 0 };
  });
}

export function pickTalent(u: Unit, key: string): boolean {
  const t = u.hero?.talents.find((x) => x.key === key);
  if (!t) return false;
  const row = talentRows(u)[t.tier - 1];
  if (!row?.can) return false;
  u.talents.add(key);
  u.abilityPoints--;
  applyTalents(u);
  HERO_OPTS[u.name]?.talents?.[key]?.(u);
  return true;
}

/** Recalcula el modificador de talentos de stats y refresca pasivas (sus valores pueden cambiar). */
export function applyTalents(u: Unit) {
  const props: Partial<Props> = {};
  for (const k of u.talents) {
    const g = genericTalent(k);
    if (g) for (const [p, v] of Object.entries(g)) (props as any)[p] = ((props as any)[p] ?? 0) + v;
  }
  u.removeModsByName('talents');
  if (Object.keys(props).length) u.addMod({ name: 'talents', persistent: true, props }, u, null);
  for (const a of u.abilities) refreshPassive(a);
  syncAutoLevels(u);
}

/** Talentos que eligen los bots: el de daño o stats si lo hay; si no, el primero. */
export function botTalent(u: Unit) {
  for (const row of talentRows(u)) {
    if (!row.can) continue;
    const pick = row.options.find((o) => /damage|attack_speed|all_stats|unique/.test(o.key)) ?? row.options[0];
    if (pick) pickTalent(u, pick.key);
  }
}
