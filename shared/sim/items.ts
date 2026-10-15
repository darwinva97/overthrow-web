// Items: stats genéricos sacados del dataset, registro de mecánicas propias,
// tienda (compra con recetas, venta) y pasivas al equipar.
import { ITEMS, lv, type ItemData } from '../data';
import type { ItemImpl, ItemInst, Props } from './types';
import type { Unit } from './unit';
import { hasScepter, refreshPassive, syncAutoLevels } from './abilities';

const IMPLS = new Map<string, ItemImpl>();
export function defineItem(impl: ItemImpl) { IMPLS.set(impl.key, impl); return impl; }
export const itemImpl = (k: string) => IMPLS.get(k);

/** Clave del dataset → propiedad. `pct` divide entre 100. */
const STAT_KEYS: Record<string, [keyof Props, boolean]> = {
  bonus_strength: ['str', false], bonus_agility: ['agi', false], bonus_intellect: ['int', false],
  bonus_all_stats: ['allStats', false], bonus_stats: ['allStats', false],
  bonus_damage: ['damage', false], bonus_attack_speed: ['attackSpeed', false], bonus_speed: ['attackSpeed', false],
  bonus_armor: ['armor', false], armor: ['armor', false],
  bonus_magical_armor: ['magicResist', true], bonus_spell_resist: ['magicResist', true],
  magic_resistance: ['magicResist', true], bonus_magic_resistance: ['magicResist', true],
  bonus_movement_speed: ['msFlat', false], bonus_movement: ['msFlat', false],
  movement_speed_percent_bonus: ['msPct', true],
  bonus_health: ['hp', false], bonus_mana: ['mana', false],
  bonus_health_regen: ['hpRegen', false], health_regen: ['hpRegen', false], bonus_hp_regen: ['hpRegen', false],
  bonus_regen: ['hpRegen', false],
  bonus_mana_regen: ['manaRegen', false], bonus_mana_regen_pct: ['manaRegenAmp', true], mana_regen: ['manaRegen', false],
  bonus_mp_regen: ['manaRegen', false],
  bonus_evasion: ['evasion', true], evasion: ['evasion', true],
  spell_amp: ['spellAmp', true], bonus_spell_amp: ['spellAmp', true], cast_range_bonus: ['castRange', false],
  status_resistance: ['statusResist', true], bonus_status_resistance: ['statusResist', true],
  slow_resistance: ['slowResist', true], hp_regen_amp: ['hpRegenAmp', true],
  mana_regen_multiplier: ['manaRegenAmp', true], lifesteal_percent: ['lifesteal', true],
  spell_lifesteal: ['spellLifesteal', true], base_attack_range: ['attackRange', false],
  bonus_attack_range: ['attackRange', false],
};
const IGNORED = /tooltip|model_scale|max_level|^max_charges$|^initial_charges$/;

/** Item con número de nivel en la clave (dagon_3 → 3). */
export function itemLevel(key: string) {
  const m = /_(\d)$/.exec(key);
  return m ? +m[1] : 1;
}

export function genericProps(def: ItemData): Partial<Props> {
  if (def.qual === 'consumable') return {};
  const out: Partial<Props> = {};
  const level = itemLevel(def.key);
  for (const [k, arr] of Object.entries(def.values)) {
    const map = STAT_KEYS[k];
    if (!map) continue;
    const v = lv(arr, level) / (map[1] ? 100 : 1);
    (out as any)[map[0]] = ((out as any)[map[0]] ?? 0) + v;
  }
  return out;
}

/** Un item funciona solo con stats si no tiene activa ni claves desconocidas. */
export function isStatsOnly(def: ItemData): boolean {
  if (def.active || def.tier || def.enhancement) return false;
  return Object.keys(def.values).every((k) => STAT_KEYS[k] || IGNORED.test(k));
}

/** Items que la tienda ofrece: los que funcionan de verdad en esta versión. */
/** Aghanim's de Roshan, mensajeros y similares no se venden en Overthrow. */
const NOT_SOLD = /roshan|courier|^tango_single$|^cheese$|^royale_with_cheese$|^ward_dispenser$|^pocket_roshan$/;
export const isShopItem = (key: string) => {
  const d = ITEMS[key];
  return !!d && !d.unbuildable && !d.tier && !d.enhancement && d.cost > 0 && !NOT_SOLD.test(key) &&
    (IMPLS.has(key) || isStatsOnly(d) || key === 'aghanims_shard' || key === 'ultimate_scepter_2');
};
export function shopItems(): ItemData[] {
  return Object.values(ITEMS).filter((d) => isShopItem(d.key));
}

export function makeItem(owner: Unit, key: string): ItemInst {
  const def = ITEMS[key];
  const impl = IMPLS.get(key) ?? null;
  return {
    key, def, impl, owner, cd: 0,
    charges: def.charges || 0, toggled: false, mode: 0,
    passiveMod: null, boughtAt: owner.w.time, data: {}, slot: -1, isItem: true,
  };
}

export const SHOP_RADIUS = 900;

export function atShop(u: Unit): boolean {
  const f = u.w.teams[u.team]?.fountain;
  return !!f && Math.hypot(u.x - f.x, u.y - f.y) <= SHOP_RADIUS;
}

/** Equipa o quita la pasiva según el hueco: los 6 primeros y el neutral están activos. */
export function syncItemPassives(u: Unit) {
  const hadScepter = !!u.data_scepter;
  for (let s = 0; s < u.items.length; s++) {
    const it = u.items[s];
    if (!it) continue;
    it.slot = s;
    const active = s < 6 || s === NEUTRAL_SLOT;
    if (active && !it.passiveMod) {
      const props = genericProps(it.def);
      const extra = it.impl?.passive?.(it) ?? null;
      it.passiveMod = u.addMod({
        name: 'item_' + it.key, persistent: true,
        ...(extra ?? {}),
        props: mergeProps(props, extra?.props),
        data: { ...(extra?.data ?? {}), multi: true },
      }, u, it);
    } else if (!active && it.passiveMod) {
      u.removeMod(it.passiveMod);
      it.passiveMod = null;
    }
  }
  const nowScepter = hasScepter(u);
  if (nowScepter !== hadScepter) { u.data_scepter = nowScepter; onAghsChange(u); }
}

export const NEUTRAL_SLOT = 9;

/** Al ganar o perder Scepter/Shard cambian valores, pasivas y habilidades disponibles. */
export function onAghsChange(u: Unit) {
  syncAutoLevels(u);
  for (const a of u.abilities) { refreshPassive(a); a.impl.onAghs?.(a); }
  u.refreshStats();
}

function mergeProps(base: Partial<Props>, extra: any): any {
  if (!extra) return base;
  if (typeof extra === 'function') {
    return (m: any) => {
      const e = extra(m);
      const o: any = { ...base };
      for (const k in e) o[k] = (o[k] ?? 0) + e[k];
      return o;
    };
  }
  const o: any = { ...base };
  for (const k in extra) o[k] = (o[k] ?? 0) + extra[k];
  return o;
}

export function removeItem(u: Unit, it: ItemInst) {
  if (it.passiveMod) { u.removeMod(it.passiveMod); it.passiveMod = null; }
  const i = u.items.indexOf(it);
  if (i >= 0) u.items[i] = null;
  const j = u.stash.indexOf(it);
  if (j >= 0) u.stash.splice(j, 1);
}

/** Coste de comprar `key` usando los componentes que ya tiene; devuelve qué consume. */
function planPurchase(key: string, pool: ItemInst[]): { cost: number; used: ItemInst[] } {
  const owned = pool.find((p) => p.key === key);
  if (owned) {
    pool.splice(pool.indexOf(owned), 1);
    return { cost: 0, used: [owned] };
  }
  const d = ITEMS[key];
  if (!d) return { cost: Infinity, used: [] };
  if (!d.components.length) return { cost: d.cost, used: [] };
  let cost = d.recipeCost;
  const used: ItemInst[] = [];
  for (const c of d.components) {
    const p = planPurchase(c, pool);
    cost += p.cost;
    used.push(...p.used);
  }
  return { cost, used };
}

export function purchaseCost(u: Unit, key: string) {
  const pool = [...u.items.filter((i): i is ItemInst => !!i), ...u.stash];
  // El propio item no cuenta como componente de sí mismo.
  const top = ITEMS[key];
  if (!top) return { cost: Infinity, used: [] as ItemInst[] };
  if (!top.components.length) return { cost: top.cost, used: [] as ItemInst[] };
  let cost = top.recipeCost;
  const used: ItemInst[] = [];
  for (const c of top.components) {
    const p = planPurchase(c, pool);
    cost += p.cost; used.push(...p.used);
  }
  return { cost, used };
}

export function buyItem(u: Unit, key: string): string | null {
  if (!isShopItem(key)) return 'Ese item aún no está disponible';
  if (u.kind !== 'hero') return 'Solo los héroes compran';
  const def = ITEMS[key];
  // Shard y Aghanim's Blessing se consumen al comprarlos.
  if (key === 'aghanims_shard' || key === 'ultimate_scepter_2') {
    const cost = key === 'ultimate_scepter_2' ? purchaseCost(u, key).cost : def.cost;
    if (u.gold < cost) return 'Oro insuficiente';
    if (key === 'aghanims_shard') { if (u.shard) return 'Ya tienes el Shard'; u.shard = true; }
    else {
      if (u.blessing) return 'Ya tienes la bendición';
      for (const c of purchaseCost(u, key).used) removeItem(u, c);
      u.blessing = true;
    }
    u.gold -= cost;
    onAghsChange(u);
    syncItemPassives(u);
    return null;
  }
  // Consumibles con cargas se apilan.
  if (def.qual === 'consumable' && def.charges > 0) {
    if (u.gold < def.cost) return 'Oro insuficiente';
    const stack = [...u.items, ...u.stash].find((i) => i?.key === key);
    if (stack) { stack.charges += def.charges; u.gold -= def.cost; return null; }
  }
  const { cost, used } = purchaseCost(u, key);
  if (u.gold < cost) return 'Oro insuficiente';
  const it = makeItem(u, key);
  for (const c of used) removeItem(u, c);
  const here = atShop(u) || !u.alive;
  const slot = u.freeSlot();
  if (here && slot >= 0) {
    u.items[slot] = it;
  } else {
    if (u.stash.length >= 6) return 'Alijo lleno';
    u.stash.push(it);
  }
  u.gold -= cost;
  syncItemPassives(u);
  return null;
}

export function sellItem(u: Unit, slot: number): string | null {
  const it = u.items[slot];
  if (!it) return 'Hueco vacío';
  if (slot === NEUTRAL_SLOT || it.def.tier) return 'Los objetos neutrales no se venden';
  const full = u.w.time - it.boughtAt <= 10;
  let value = it.def.cost * (full ? 1 : 0.5);
  if (it.def.qual === 'consumable' && it.def.charges > 0) value *= it.charges / it.def.charges;
  u.gold += Math.floor(value);
  removeItem(u, it);
  return null;
}

/** Pasa el alijo al inventario si el héroe está en la tienda. */
export function deliverStash(u: Unit) {
  if (!u.stash.length || !u.alive || !atShop(u)) return;
  let moved = false;
  while (u.stash.length) {
    const s = u.freeSlot();
    if (s < 0) break;
    u.items[s] = u.stash.shift()!;
    moved = true;
  }
  if (moved) syncItemPassives(u);
}

export function swapItems(u: Unit, a: number, b: number) {
  if (a < 0 || b < 0 || a > 8 || b > 8 || a === b) return;
  // El hueco neutral (9) solo admite objetos neutrales.
  [u.items[a], u.items[b]] = [u.items[b], u.items[a]];
  syncItemPassives(u);
}
