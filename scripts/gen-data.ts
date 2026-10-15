// Genera shared/data/*.json. Los números salen de los scripts de Valve del parche actual
// (data-src/kv, descargados con `npm run fetch-kv`); nombres y descripciones en inglés,
// de dotaconstants. Nunca se editan los JSON a mano: se vuelve a ejecutar `npm run gen-data`.
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nums, parseKV, type KV } from './kv';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dc = join(root, 'node_modules/dotaconstants/build');
const kvDir = join(root, 'data-src/kv');
const out = join(root, 'shared/data');
mkdirSync(out, { recursive: true });

const load = (f: string) => JSON.parse(readFileSync(join(dc, f), 'utf8'));
const kvFile = (f: string) => parseKV(readFileSync(join(kvDir, f), 'utf8'));
const dcHeroes = load('heroes.json');
const dcAbilities = load('abilities.json');
const dcItems = load('items.json');
const xp: number[] = load('xp_level.json');
const aghs: any[] = load('aghs_desc.json');

const obj = (v: unknown): KV => (v && typeof v === 'object' ? (v as KV) : {});
const str = (v: unknown) => (typeof v === 'string' ? v : undefined);

// ---------------- Habilidades: se recogen de todos los ficheros ----------------

const kvAbilities: Record<string, KV> = {};
function collect(o: KV) {
  for (const [k, v] of Object.entries(o)) {
    if (typeof v !== 'object') continue;
    if (!k.startsWith('npc_') && ('AbilityBehavior' in v || 'AbilityValues' in v || 'AbilityType' in v)) kvAbilities[k] = v;
    else collect(v);
  }
}
collect(kvFile('npc_abilities.txt'));
const heroFiles = readdirSync(join(kvDir, 'heroes')).filter((f) => f.endsWith('.txt'));
const heroKV: Record<string, KV> = {};
for (const f of heroFiles) {
  const t = kvFile(join('heroes', f));
  collect(t);
  for (const [k, v] of Object.entries(obj(t.DOTAHeroes))) if (k.startsWith('npc_dota_hero_') && typeof v === 'object') heroKV[k] = v;
}
const heroBase = obj(obj(kvFile('npc_heroes.txt').DOTAHeroes).npc_dota_hero_base);

const flagList = (s: string | undefined, prefix: string) =>
  (s ?? '').split('|').map((x) => x.trim().replace(prefix, '').toLowerCase()).filter(Boolean);

interface Link { t?: Record<string, string>; sc?: string; sh?: string; rs?: 1; rsh?: 1 }

/** Pasa un bloque KV de habilidad al formato del juego. */
function convertAbility(key: string, a: KV) {
  const values: Record<string, number[]> = {};
  const links: Record<string, Link> = {};
  const top: Record<string, string> = {
    AbilityCooldown: '_cd', AbilityManaCost: '_mc', AbilityCastRange: 'abilitycastrange', AbilityCastPoint: 'abilitycastpoint',
    AbilityChannelTime: 'abilitychanneltime', AbilityDuration: 'abilityduration', AbilityDamage: 'abilitydamage',
    AbilityCharges: 'abilitycharges', AbilityChargeRestoreTime: 'abilitychargerestoretime', AbilityHealthCost: '_hc',
  };
  for (const [k, name] of Object.entries(top)) if (str(a[k]) !== undefined) values[name] = nums(str(a[k]));
  const av = obj(a.AbilityValues);
  for (const [k, raw] of Object.entries(av)) {
    const name = top[k] ?? k;
    if (typeof raw === 'string') { values[name] = nums(raw); continue; }
    values[name] = nums(str(raw.value));
    const l: Link = {};
    for (const [lk, lv] of Object.entries(raw)) {
      if (typeof lv !== 'string') continue;
      if (lk.startsWith('special_bonus_scepter')) l.sc = lv;
      else if (lk.startsWith('special_bonus_shard')) l.sh = lv;
      else if (lk === 'RequiresScepter' && lv === '1') l.rs = 1;
      else if (lk === 'RequiresShard' && lv === '1') l.rsh = 1;
      else if (lk.startsWith('special_bonus_') && !lk.startsWith('special_bonus_facet')) (l.t ??= {})[lk] = lv;
    }
    if (Object.keys(l).length) links[name] = l;
  }
  // Formato antiguo.
  for (const v of Object.values(obj(a.AbilitySpecial))) {
    if (typeof v !== 'object') continue;
    for (const [k, raw] of Object.entries(v)) {
      if (k === 'var_type' || k === 'LinkedSpecialBonus' || typeof raw !== 'string') continue;
      values[k] = nums(raw);
    }
  }
  const d = dcAbilities[key] ?? {};
  const behavior = flagList(str(a.AbilityBehavior), 'DOTA_ABILITY_BEHAVIOR_');
  const dmg = (str(a.AbilityUnitDamageType) ?? '').replace('DAMAGE_TYPE_', '').toLowerCase() || null;
  return {
    key,
    name: d.dname ?? key,
    desc: d.desc ?? '',
    behavior,
    dmgType: dmg,
    bkbPierce: str(a.SpellImmunityType) === 'SPELL_IMMUNITY_ENEMIES_YES',
    targetTeam: (str(a.AbilityUnitTargetTeam) ?? '').replace('DOTA_UNIT_TARGET_TEAM_', '').toLowerCase() || null,
    targetType: flagList(str(a.AbilityUnitTargetType), 'DOTA_UNIT_TARGET_'),
    ult: str(a.AbilityType) === 'ABILITY_TYPE_ULTIMATE',
    innate: str(a.Innate) === '1',
    grantedBy: str(a.IsGrantedByScepter) === '1' ? 'scepter' : str(a.IsGrantedByShard) === '1' ? 'shard' : null,
    maxLevel: str(a.MaxLevel) ? +str(a.MaxLevel)! : null,
    breakable: str(a.IsBreakable) !== '0',
    dispellable: (str(a.SpellDispellableType) ?? '').replace('SPELL_DISPELLABLE_', '').toLowerCase() || null,
    cd: values._cd ?? [], mc: values._mc ?? [],
    values, links,
  };
}

// ---------------- Héroes ----------------

const ATTR: Record<string, string> = { DOTA_ATTRIBUTE_STRENGTH: 'str', DOTA_ATTRIBUTE_AGILITY: 'agi', DOTA_ATTRIBUTE_INTELLECT: 'int', DOTA_ATTRIBUTE_ALL: 'all' };
const heroOut: Record<string, unknown> = {};
const abilityOut: Record<string, any> = {};
const talentOwners = new Map<string, string[]>();

for (const [full, raw] of Object.entries(heroKV)) {
  const key = full.replace('npc_dota_hero_', '');
  if (key === 'base' || key === 'target_dummy') continue;
  const h: KV = { ...heroBase, ...raw };
  const n = (k: string, d = 0) => { const v = parseFloat(str(h[k]) ?? ''); return Number.isFinite(v) ? v : d; };
  const dch = Object.values<any>(dcHeroes).find((x) => x.name === full);
  if (str(h.Enabled) === '0' && !dch) continue;
  // Habilidades y talentos se distinguen por el nombre, no por el hueco (Invoker usa más de 9 huecos).
  const abilities: string[] = [];
  const talentKeys: string[] = [];
  for (let i = 1; i <= 35; i++) {
    const a = str(h['Ability' + i]);
    if (!a || a === 'generic_hidden') continue;
    if (a.startsWith('special_bonus')) talentKeys.push(a);
    else abilities.push(a);
  }
  const talents: { key: string; tier: number; name: string; value?: number }[] = talentKeys.slice(0, 8).map((t, i) => {
    talentOwners.set(t, [...(talentOwners.get(t) ?? []), key]);
    return { key: t, tier: Math.floor(i / 2) + 1, name: dcAbilities[t]?.dname ?? t };
  });
  for (const a of [...abilities, ...talents.map((t) => t.key)]) {
    if (kvAbilities[a] && !abilityOut[a]) abilityOut[a] = convertAbility(a, kvAbilities[a]);
  }
  // Habilidades del héroe sin hueco propio (concedidas por Scepter/Shard, sub-habilidades).
  const prefix = key + '_';
  for (const [ak, av] of Object.entries(kvAbilities)) {
    if (ak.startsWith(prefix) && !abilityOut[ak]) abilityOut[ak] = convertAbility(ak, av);
  }
  // Rellena "{s:valor}" en el texto del talento con el valor enlazado; si no hay texto, lo construye.
  for (const t of talents) {
    const ab = abilityOut[t.key];
    if (ab?.values?.value?.length) t.value = ab.values.value[0];
    let op: string | undefined, where = '';
    for (const ad of Object.values<any>(abilityOut)) {
      if (!ad.key.startsWith(prefix) && !abilities.includes(ad.key)) continue;
      for (const [vk, l] of Object.entries<Link>(ad.links)) if (l.t?.[t.key]) { op = l.t[t.key]; where = `${ad.name}: ${vk === '_cd' ? 'enfriamiento' : vk === '_mc' ? 'maná' : vk.replaceAll('_', ' ')}`; }
    }
    const val = (op ?? (t.value !== undefined ? String(t.value) : ''));
    t.name = t.name.replace(/([+-]?)\{s:[^}]+\}/g, (_m, sign) => sign + (sign ? val.replace(/^[+=x-]/, '') : val.replace(/^[=x]/, ''))).replace('%%', '%');
    if (t.name === t.key) t.name = where ? `${where} ${op}` : t.key.replace(/^special_bonus_(unique_)?/, '').replaceAll('_', ' ');
  }
  const g = aghs.find((x) => x.hero_name === full);
  heroOut[key] = {
    key,
    name: dch?.localized_name ?? key,
    attr: ATTR[str(h.AttributePrimary) ?? ''] ?? 'str',
    melee: str(h.AttackCapabilities) === 'DOTA_UNIT_CAP_MELEE_ATTACK',
    roles: dch?.roles ?? [],
    hp: n('StatusHealth', 120), hpRegen: n('StatusHealthRegen'), mana: n('StatusMana', 75), manaRegen: n('StatusManaRegen'),
    armor: n('ArmorPhysical'), mr: n('MagicalResistance', 25),
    dmgMin: n('AttackDamageMin'), dmgMax: n('AttackDamageMax'),
    str: n('AttributeBaseStrength'), agi: n('AttributeBaseAgility'), int: n('AttributeBaseIntelligence'),
    strGain: n('AttributeStrengthGain'), agiGain: n('AttributeAgilityGain'), intGain: n('AttributeIntelligenceGain'),
    range: n('AttackRange', 150), projSpeed: n('ProjectileSpeed', 900) || 900,
    bat: n('AttackRate', 1.7), baseAs: n('BaseAttackSpeed', 100), attackPoint: n('AttackAnimationPoint', 0.4),
    ms: n('MovementSpeed', 300), turnRate: n('MovementTurnRate', 0.6),
    dayVision: n('VisionDaytimeRange', 1800), nightVision: n('VisionNighttimeRange', 800),
    abilities, talents,
    aghs: g ? { scepter: g.scepter_desc ?? '', scepterSkill: g.scepter_skill_name ?? '', scepterNew: !!g.scepter_new_skill,
      shard: g.shard_desc ?? '', shardSkill: g.shard_skill_name ?? '', shardNew: !!g.shard_new_skill } : null,
    allAbilities: abilities,
  };
}

// ---------------- Items ----------------

const kvItems = obj(kvFile('items.txt').DOTAAbilities);
const recipes: Record<string, { cost: number; comps: string[] }> = {};
for (const [k, v] of Object.entries(kvItems)) {
  if (!k.startsWith('item_recipe_') || typeof v !== 'object') continue;
  const res = str(v.ItemResult);
  const req = str(obj(v.ItemRequirements)['01']);
  if (res && req) recipes[res.replace('item_', '')] = {
    cost: +(str(v.ItemCost) ?? 0),
    comps: req.split(';').map((c) => c.trim().replace('item_', '').replace('*', '')).filter(Boolean),
  };
}
const neutralKV = obj(kvFile('neutral_items.txt').neutral_items);
const neutralTier: Record<string, number> = {};
const enhancementTier: Record<string, number[]> = {};
const tiers: { tier: number; start: string; trinkets: number; enhancements: number; groups: Record<string, string[]> }[] = [];
for (const [t, v] of Object.entries(obj(neutralKV.neutral_tiers))) {
  if (typeof v !== 'object') continue;
  const groups: Record<string, string[]> = {};
  for (const [g, grp] of Object.entries(obj(v.enhancements))) {
    if (typeof grp !== 'object') continue;
    groups[g] = Object.keys(grp).map((k) => k.replace('item_', ''));
    for (const k of groups[g]) { const arr = (enhancementTier[k] ??= []); if (!arr.includes(+t)) arr.push(+t); }
  }
  tiers.push({ tier: +t, start: str(v.start_time) ?? '0:00', trinkets: +(str(v.trinket_options) ?? 4), enhancements: +(str(v.enhancement_options) ?? 4), groups });
  for (const k of Object.keys(obj(v.items))) neutralTier[k.replace('item_', '')] = +t;
}

const itemOut: Record<string, any> = {};
const referenced = new Set<string>(Object.values(recipes).flatMap((r) => r.comps));
for (const [full, v] of Object.entries(kvItems)) {
  if (!full.startsWith('item_') || full.startsWith('item_recipe_') || typeof v !== 'object') continue;
  const key = full.replace('item_', '');
  const d = dcItems[key];
  const tier = neutralTier[key] ?? 0;
  const enh = enhancementTier[key];
  const cost = +(str(v.ItemCost) ?? 0);
  const purchasable = str(v.ItemPurchasable) !== '0';
  const inShop = cost > 0 && purchasable && (str(v.ItemQuality) || recipes[key] || referenced.has(key) || d?.qual);
  if (!tier && !enh && !inShop) continue;
  if (!d && !tier && !enh) continue;
  const conv = convertAbility(full, v);
  const recipe = recipes[key];
  itemOut[key] = {
    key, name: d?.dname ?? key, cost, qual: str(v.ItemQuality) ?? d?.qual ?? null, tier,
    enhancement: enh ? enh.sort() : null,
    components: recipe?.comps ?? [],
    recipeCost: recipe?.cost ?? 0,
    cd: conv.cd[0] ?? 0, mc: conv.mc[0] ?? 0,
    charges: +(str(v.ItemInitialCharges) ?? 0),
    active: !conv.behavior.includes('passive') || (d?.abilities ?? []).some((x: any) => x.type === 'active' || x.type === 'toggle'),
    behavior: conv.behavior,
    desc: (d?.abilities ?? []).map((x: any) => `${x.title}: ${x.description}`).join('\n'),
    values: conv.values,
    links: conv.links,
  };
}
for (const it of Object.values<any>(itemOut)) {
  if (it.components.some((c: string) => !itemOut[c])) { it.components = []; it.recipeCost = 0; it.unbuildable = true; }
}

// ---------------- Unidades (invocaciones y neutrales) ----------------

const kvUnits = obj(kvFile('npc_units.txt').DOTAUnits);
const unitOut: Record<string, unknown> = {};
const heroKeys = Object.keys(heroOut);
for (const [k, v] of Object.entries(kvUnits)) {
  if (typeof v !== 'object' || !k.startsWith('npc_dota_')) continue;
  const short = k.replace('npc_dota_', '');
  if (!short.startsWith('neutral_') && !heroKeys.some((h) => short.includes(h)) &&
      !/ward|treant|bear|boar|hawk|golem|spiderling|wolf|eidolon|familiar|clone|tombstone|zombie|serpent|totem|beetle|plague|spirit|roshan/.test(short)) continue;
  const n = (f: string, d = 0) => { const x = parseFloat(str(v[f]) ?? ''); return Number.isFinite(x) ? x : d; };
  const abilities: string[] = [];
  for (let i = 1; i <= 8; i++) { const a = str(v['Ability' + i]); if (a) abilities.push(a); }
  for (const a of abilities) if (kvAbilities[a] && !abilityOut[a]) abilityOut[a] = convertAbility(a, kvAbilities[a]);
  unitOut[short] = {
    key: short, level: n('Level', 1),
    hp: n('StatusHealth', 100), hpRegen: n('StatusHealthRegen'), mana: n('StatusMana'), manaRegen: n('StatusManaRegen'),
    armor: n('ArmorPhysical'), mr: n('MagicalResistance'), dmgMin: n('AttackDamageMin'), dmgMax: n('AttackDamageMax'),
    bat: n('AttackRate', 1.7), attackPoint: n('AttackAnimationPoint', 0.4), range: n('AttackRange', 100),
    projSpeed: n('ProjectileSpeed', 900) || 900, ms: n('MovementSpeed', 300), turnRate: n('MovementTurnRate', 0.6),
    dayVision: n('VisionDaytimeRange', 800), nightVision: n('VisionNighttimeRange', 800),
    melee: str(v.AttackCapabilities) !== 'DOTA_UNIT_CAP_RANGED_ATTACK', canAttack: str(v.AttackCapabilities) !== 'DOTA_UNIT_CAP_NO_ATTACK',
    bountyGold: (n('BountyGoldMin') + n('BountyGoldMax')) / 2, bountyXp: n('BountyXP'),
    flying: str(v.MovementCapabilities) === 'DOTA_UNIT_CAP_MOVE_FLY',
    abilities, scale: n('ModelScale', 1),
  };
}

// Talentos genéricos (special_bonus_attack_damage_25…) con su valor.
for (const t of talentOwners.keys()) if (!abilityOut[t] && kvAbilities[t]) abilityOut[t] = convertAbility(t, kvAbilities[t]);

writeFileSync(join(out, 'heroes.json'), JSON.stringify(heroOut));
writeFileSync(join(out, 'abilities.json'), JSON.stringify(abilityOut));
writeFileSync(join(out, 'items.json'), JSON.stringify(itemOut));
writeFileSync(join(out, 'units.json'), JSON.stringify(unitOut));
writeFileSync(join(out, 'neutral.json'), JSON.stringify(tiers));
writeFileSync(join(out, 'xp.json'), JSON.stringify(xp));
console.log(`héroes ${Object.keys(heroOut).length}, habilidades ${Object.keys(abilityOut).length}, items ${Object.keys(itemOut).length}, unidades ${Object.keys(unitOut).length}, tiers ${tiers.length}`);
