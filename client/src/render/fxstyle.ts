// Catálogo visual compartido por los dos modos: qué forma y color tiene cada efecto.

export type FxKind = 'ring' | 'burst' | 'beam' | 'warn' | 'flash' | 'bolt';
export interface FxStyle { k: FxKind; c: string; d: number; w?: number }

export const FX: Record<string, FxStyle> = {
  lsa_warn: { k: 'warn', c: '#ff8a3a', d: 0.5 },
  lsa: { k: 'burst', c: '#ff7a2a', d: 0.5 },
  shrapnel_warn: { k: 'warn', c: '#d9b36a', d: 1.2 },
  nova: { k: 'burst', c: '#a8dcff', d: 0.6 },
  frost_explosion: { k: 'burst', c: '#d4f0ff', d: 0.35 },
  mana_void: { k: 'burst', c: '#7b62ff', d: 0.7 },
  laguna: { k: 'beam', c: '#ff5a1f', d: 0.4, w: 22 },
  dagon: { k: 'beam', c: '#ff3a3a', d: 0.35, w: 14 },
  lightning: { k: 'bolt', c: '#b3dcff', d: 0.25, w: 4 },
  blink: { k: 'flash', c: '#8fb6ff', d: 0.4 },
  berserkers_call: { k: 'ring', c: '#ff5050', d: 0.5 },
  helix: { k: 'ring', c: '#ff4b3b', d: 0.35 },
  culling_blade: { k: 'burst', c: '#ff2a2a', d: 0.6 },
  mekansm: { k: 'ring', c: '#9cff9c', d: 0.7 },
  pipe: { k: 'ring', c: '#9fb8ff', d: 0.7 },
  arcane_boots: { k: 'ring', c: '#8ab8ff', d: 0.7 },
  shivas: { k: 'ring', c: '#cfefff', d: 2 },
  dust: { k: 'ring', c: '#e8d9a0', d: 0.8 },
  omnislash: { k: 'flash', c: '#ffd27a', d: 0.25 },
  hit: { k: 'flash', c: '#ffffff', d: 0.12 },
  bash: { k: 'burst', c: '#ffe066', d: 0.3 },
  manaburn: { k: 'flash', c: '#8a6cff', d: 0.3 },
  reflect: { k: 'ring', c: '#c9b8ff', d: 0.4 },
  linkens: { k: 'ring', c: '#5fd1ff', d: 0.4 },
  orb_capture: { k: 'burst', c: '#f6cf7c', d: 1.2 },
  tp: { k: 'warn', c: '#7fd8ff', d: 3 },
  levelup: { k: 'ring', c: '#f6cf7c', d: 0.8 },
  death: { k: 'burst', c: '#3a2a40', d: 0.8 },
  respawn: { k: 'ring', c: '#f6cf7c', d: 0.8 },
  refresher: { k: 'ring', c: '#7fffd4', d: 0.6 },
  fade: { k: 'flash', c: '#a99ab8', d: 0.4 },
  midas: { k: 'burst', c: '#f6cf7c', d: 0.6 },
};

/** Cómo se ve un modificador sobre la unidad. */
export type StatusKind = 'stars' | 'feet' | 'area' | 'shell' | 'spin' | 'alpha' | 'lift';
export interface StatusStyle { k: StatusKind; c: string; r?: number }

export const STATUS: Record<string, StatusStyle> = {
  stun: { k: 'stars', c: '#ffe066' },
  slow: { k: 'feet', c: '#7fb8ff' },
  silence: { k: 'feet', c: '#c08cff' },
  root: { k: 'feet', c: '#8a6a3a' },
  hex: { k: 'feet', c: '#f0f0f0' },
  frostbite: { k: 'shell', c: '#bfe9ff' },
  blade_fury: { k: 'spin', c: '#ffb347', r: 260 },
  rot: { k: 'area', c: '#8bc34a', r: 250 },
  freezing_field: { k: 'area', c: '#cfefff', r: 810 },
  healing_ward: { k: 'area', c: '#7dff7d', r: 400 },
  radiance: { k: 'area', c: '#ffae42', r: 650 },
  meat_shield: { k: 'shell', c: '#e88a8a' },
  omnislash: { k: 'shell', c: '#ffd27a' },
  cyclone: { k: 'lift', c: '#e8f2ff' },
  ethereal: { k: 'alpha', c: '#8fffc8' },
  invis: { k: 'alpha', c: '#ffffff' },
  doppel: { k: 'alpha', c: '#8fb6ff' },
  bkb: { k: 'shell', c: '#f6cf7c' },
  taunt: { k: 'feet', c: '#ff4040' },
  battle_hunger: { k: 'feet', c: '#ff6a3a' },
  counterspell: { k: 'shell', c: '#b49cff' },
  fountain_heal: { k: 'feet', c: '#7dff7d' },
  fiery_soul: { k: 'feet', c: '#ff8a3a' },
  satanic: { k: 'shell', c: '#ff3030' },
  armlet: { k: 'feet', c: '#ff3030' },
  haste: { k: 'feet', c: '#ffffff' },
  corruption: { k: 'feet', c: '#5a3a5a' },
  barrier: { k: 'shell', c: '#8fb6ff' },
  lotus: { k: 'shell', c: '#ff9fd8' },
  static_charge: { k: 'shell', c: '#b3dcff' },
  dismember: { k: 'feet', c: '#aa2020' },
  phantom_rush: { k: 'feet', c: '#8fb6ff' },
  berserk: { k: 'feet', c: '#ff5050' },
  blade_mail: { k: 'shell', c: '#d0d0d0' },
  take_aim: { k: 'feet', c: '#ffe066' },
  hooked: { k: 'feet', c: '#aa5a2a' },
  push: { k: 'feet', c: '#ffffff' },
};

export const PROJ_COLOR: Record<string, string> = {
  dragon_slave: '#ff7a2a', hook: '#c9b48a', spirit_lance: '#8fb6ff', assassinate: '#ffe066',
  ethereal: '#8fffc8', atos: '#c08cff',
};
export function projColor(fx: string) {
  if (PROJ_COLOR[fx]) return PROJ_COLOR[fx];
  if (fx.startsWith('attack:')) {
    const h = fx.slice(7);
    return ({ lina: '#ff8a3a', crystal_maiden: '#bfe9ff', sniper: '#ffe066', fountain: '#9fe0ff', satyr: '#b0ff70' } as Record<string, string>)[h] ?? '#f0e6d0';
  }
  return '#ffffff';
}
export const projSize = (fx: string) =>
  fx === 'dragon_slave' ? 110 : fx === 'hook' ? 26 : fx.startsWith('attack:') ? 10 : 22;

export const ORB_COLOR: Record<string, string> = { common: '#7fe0ff', rare: '#6a8cff', epic: '#c27bff' };
export const ATTR_COLOR: Record<string, string> = { str: '#d4483b', agi: '#4fae4a', int: '#3f8fe0', all: '#d9a441' };
