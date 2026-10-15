// Catálogo declarativo de efectos visuales, compartido por los modos 2D y 3D.
//
// Cuatro familias, cada una con entradas escritas a mano y un respaldo automático:
//   FX      eventos `Fx` del servidor (w.emit({ n, … })) y el evento 'cast' de cada lanzamiento
//   STATUS  fx de modificadores sobre una unidad (u.fx)
//   PROJ    proyectiles (p.fx), incluidos los ataques 'attack:<héroe>'
//   ZONE    zonas persistentes (z.fx)
//
// Búsqueda de un evento: FX['n.c'] → FX['n@habilidad'] → FX[n] → respaldo(n, habilidad, campos).
// En las entradas a mano el color es opcional: si falta, sale del nombre del efecto o de la
// habilidad (palette.ts), así que una entrada a mano puede fijar solo la forma y el ritmo.
import type { Fx } from '../../../../shared/sim/types';
import { ABILITIES, HEROES } from '../../../../shared/data';
import { SH, type Shape } from './atlas';
import inventory from './inventory.json';
import { abilityLook, ELEM, elemLook, elemOf, nameLook, type Elem, type Look } from './palette';

// ---------------------------------------------------------------- tipos

export type FxKind =
  | 'burst'   // estallido: destello + chispas radiales
  | 'nova'    // onda expansiva: anillo que crece
  | 'pillar'  // columna de luz o erupción vertical
  | 'beam'    // haz entre dos puntos (sigue a las unidades u/u2)
  | 'chain'   // rayo en zigzag (o desde el cielo con sky)
  | 'cone'    // cono hacia x2,y2
  | 'line'    // onda en línea de x,y a x2,y2 con ancho r
  | 'warn'    // aviso en el suelo con cuenta atrás d
  | 'field'   // área persistente d segundos
  | 'blink'   // destello en origen y destino
  | 'impact'  // golpe pequeño sobre una unidad
  | 'slash'   // tajos cruzados sobre una unidad
  | 'bubble'  // burbuja que destella (bloqueo, escudo instantáneo)
  | 'arc'     // objeto en parábola de x,y a x2,y2 en d segundos
  | 'rise'    // partículas que suben alrededor de una unidad (curas, subida de nivel)
  | 'spin'    // hojas girando alrededor
  | 'fall'    // algo que cae del cielo y estalla
  | 'spikes'  // púas que brotan en un anillo que crece
  | 'portal'  // círculo de teletransporte en origen y destino
  | 'none';   // lo pinta otra capa (números, oro, anuncios)

export interface FxDef {
  k: FxKind;
  /** Color principal y de núcleo. Si faltan, salen del nombre o de la habilidad. */
  c?: string; c2?: string;
  /** Duración por defecto (el campo d del evento manda si viene). */
  d?: number;
  /** Radio por defecto (el campo r del evento manda). */
  r?: number;
  /** Ancho de haz o línea; en conos, semiángulo en grados. */
  w?: number;
  /** Densidad de partículas (1 = normal). */
  n?: number;
  /** Altura (pilares, arcos, caídas). */
  h?: number;
  sh?: Shape;
  /** Polvo o humo con mezcla normal. */
  dark?: boolean;
  /** Añade un anillo expansivo. */
  ring?: boolean;
  /** El rayo baja del cielo. */
  sky?: boolean;
  /** Estela entre origen y destino (blink). */
  trail?: boolean;
  /** La onda vuelve al centro (Plasma Field). */
  back?: boolean;
  /** Remolino en el área. */
  swirl?: boolean;
  /** Efecto al terminar (arc, fall, warn). */
  end?: FxDef;
  /** Dura lo que dure la canalización del lanzador (cast@habilidad). */
  chan?: boolean;
}

export type StatusKind =
  | 'stun' | 'shield' | 'aura' | 'field' | 'spin' | 'mark' | 'motes' | 'burn' | 'drip' | 'lift'
  | 'ghost' | 'frozen' | 'root' | 'sleep' | 'hex' | 'slow' | 'trail' | 'glow' | 'none';

export interface StatusDef {
  k: StatusKind;
  c?: string; c2?: string;
  /** Radio de las áreas (field, spin). */
  r?: number;
  sh?: Shape;
  n?: number;
  /** Icono sobre la cabeza (mark). */
  mark?: Shape;
  /** Estallidos por segundo en puntos al azar del área (field). */
  pops?: number;
  also?: StatusDef;
}

export interface ProjDef {
  c?: string; c2?: string;
  /** Tamaño del núcleo (unidades de mundo). */
  s: number;
  sh?: Shape;
  /** Partículas de estela por cada 100 unidades recorridas. */
  trail?: number;
  /** Ancho de una onda lineal (Dragon Slave, Shockwave…). */
  wave?: number;
  /** Altura de vuelo. */
  z?: number;
  /** Cadena desde el lanzador (Meat Hook): color. */
  chain?: string;
  dark?: boolean;
  /** Gira (shuriken, chakram, hachas). */
  spin?: boolean;
  /** Alargado en la dirección de vuelo (flechas, balas). */
  arrow?: boolean;
}

export interface ZoneDef {
  c?: string; c2?: string;
  sh?: Shape;
  n?: number;
  dark?: boolean;
  /** Cúpula (Chronosphere) o remolino (Black Hole, Twister). */
  dome?: boolean;
  swirl?: boolean;
  /** Borde marcado (muros, campos). */
  edge?: boolean;
  /** Puntos de lluvia o caída (Rain of Destiny, Mystic Flare). */
  rain?: boolean;
}

/** Definición ya resuelta: colores concretos y forma de partícula. */
export interface Resolved<T> { def: T; c: string; c2: string; sh: Shape; dark: boolean; auto: boolean }

// ---------------------------------------------------------------- ayudantes

const E = (el: Elem) => ELEM[el].c;
const E2 = (el: Elem) => ELEM[el].c2;
type O = Omit<FxDef, 'k'>;
const mkFx = (k: FxKind) => (c?: string | O, o: O = {}): FxDef => (typeof c === 'string' ? { k, c, ...o } : { k, ...(c ?? {}), ...o });
const burst = mkFx('burst'), nova = mkFx('nova'), pillar = mkFx('pillar'), beam = mkFx('beam'), chain = mkFx('chain');
const cone = mkFx('cone'), line = mkFx('line'), warn = mkFx('warn'), field = mkFx('field'), blink = mkFx('blink');
const impact = mkFx('impact'), slash = mkFx('slash'), bubble = mkFx('bubble'), arc = mkFx('arc'), rise = mkFx('rise');
const spin = mkFx('spin'), fall = mkFx('fall'), spikes = mkFx('spikes'), portal = mkFx('portal');
const NONE: FxDef = { k: 'none' };

// ---------------------------------------------------------------- eventos (a mano)

export const FX: Record<string, FxDef> = {
  // Sistema y HUD: los pinta la capa de texto o el HUD.
  num: NONE, gold: NONE, miss: NONE, kill: NONE, announce: NONE,
  hit: impact('#fff4e0', { d: 0.14, n: 0.35, r: 22 }),
  death: burst('#2a1a34', { d: 0.9, r: 90, dark: true, n: 0.8, sh: SH.SMOKE }),
  respawn: rise(E('gold'), { d: 1.3, r: 120, ring: true }),
  levelup: rise(E('gold'), { d: 1.2, r: 110, sh: SH.STAR, ring: true }),
  throne: rise(E('gold'), { d: 0.6, r: 60, n: 0.2, sh: SH.STAR, h: 0 }),
  orb_capture: burst(E('gold'), { d: 1.2, r: 260, ring: true, n: 2, sh: SH.STAR }),
  orb_throw: arc({ h: 700, sh: SH.STAR }),
  midas: burst(E('gold'), { d: 0.7, r: 90, sh: SH.STAR }),
  tp: portal('#7fd8ff', { d: 3, r: 110 }),
  teleport: portal('#8fd0ff', { d: 1.5, r: 100 }),
  courier: blink(E('gold'), { d: 0.5 }),
  souvenir: impact(E('gold'), { d: 0.4 }),
  cart: burst(E('earth'), { d: 0.5, r: 90, dark: true }),

  // Items.
  blink: blink('#8fb6ff', { d: 0.45 }),
  'blink.am': blink('#a886ff', { d: 0.45, c2: '#e9fff0' }),
  'blink.ember': blink(E('fire'), { d: 0.5 }),
  'blink.furion': blink(E('nature'), { d: 0.6 }),
  'blink.wisp': blink('#cfeaff', { d: 0.5 }),
  'blink.arc': blink(E('lightning'), { d: 0.4 }),
  'blink.ta': blink(E('psi'), { d: 0.4 }),
  'blink.spectre': blink(E('spectral'), { d: 0.6, trail: true }),
  'blink.meepo': blink('#9fb8e8', { d: 0.5 }),
  'blink.pl': blink('#9fc4ff', { d: 0.4 }),
  'blink.mk': blink(E('gold'), { d: 0.4, trail: true }),
  'blink.xmark': blink(E('water'), { d: 0.5, trail: true }),
  'blink.warp': blink('#b07aff', { d: 0.5, trail: true }),
  overwhelming_blink: nova(E('blood'), { d: 0.6, ring: true }),
  dagon: beam('#ff3434', { d: 0.4, w: 22, c2: '#ffd0c0' }),
  linkens: bubble('#5fd1ff', { d: 0.5 }),
  reflect: bubble('#c9b8ff', { d: 0.5 }),
  aeon_disk: bubble(E('gold'), { d: 1 }),
  raindrop: bubble(E('water'), { d: 0.35, n: 0.4 }),
  phylactery: impact(E('mana'), { d: 0.45, r: 50 }),
  angels_demise: impact(E('mana'), { d: 0.45, r: 50 }),
  arcane_boots: nova(E('mana'), { d: 0.7 }),
  mekansm: nova(E('heal'), { d: 0.8, ring: true }),
  pipe: nova('#9fb8ff', { d: 0.8, ring: true }),
  crimson_guard: nova('#ff6040', { d: 0.7 }),
  shivas: nova(E('ice'), { d: 1.6, n: 2, ring: true, sh: SH.SNOW }),
  guardian_angel: nova(E('holy'), { d: 1, ring: true }),
  refresher: nova('#7fffd4', { d: 0.7 }),
  dust: burst(E('gold'), { d: 0.9, sh: SH.STAR, n: 1.5 }),
  gungir: nova(E('lightning'), { d: 0.5, sh: SH.SPARK }),
  meteor_hammer: fall(E('fire'), { d: 0.6, h: 900, n: 1.5, ring: true }),
  meteor_hammer_channel: warn(E('fire'), {}),
  blood_grenade: arc(E('blood'), { h: 260, end: burst(E('blood'), { r: 220, d: 0.5 }) }),
  bash: burst(E('steel'), { d: 0.3, r: 70, c: '#ffe066' }),
  stun: impact('#ffe066', { d: 0.3, r: 45 }),
  root: burst(E('nature'), { d: 0.5, r: 70, sh: SH.LEAF }),
  manaburn: impact('#8a6cff', { d: 0.35, r: 40 }),

  // Abaddon, Alchemist, Ancient Apparition, Anti-Mage.
  nova: nova({ d: 0.6, ring: true }),
  frost_explosion: burst(E('ice'), { d: 0.5, sh: SH.SNOW, n: 1.3 }),
  mana_void: burst('#7b62ff', { d: 0.9, ring: true, n: 2, c2: '#f0eaff', r: 500 }),
  // Axe.
  berserkers_call: nova(E('blood'), { d: 0.6, ring: true, n: 1.5 }),
  helix: spin('#ff4b3b', { d: 0.4, r: 260 }),
  culling_blade: burst('#ff2020', { d: 0.7, r: 170, n: 1.6 }),
  'culling_blade.kill': burst('#ff1414', { d: 1, r: 300, n: 2.6, ring: true }),
  // Bane, Batrider, Beastmaster, Bloodseeker.
  brain_sap: beam(E('void'), { d: 0.5, w: 12, c: '#7a3cff' }),
  sticky_napalm: burst(E('fire'), { d: 0.5, dark: false, sh: SH.DROP }),
  wild_axe: impact('#e0c0a0', { d: 0.16, r: 34, n: 0.1, sh: SH.CROSS }),
  blood_rite: pillar(E('blood'), { d: 0.7, h: 500, n: 1.5 }),
  // Brewmaster, Bristleback, Centaur.
  cinder_brew: burst('#e0a040', { d: 0.6, sh: SH.DROP, dark: true }),
  quill_spray: nova('#e8d8b0', { d: 0.4, sh: SH.SHARD, n: 1.5 }),
  hoof_stomp: nova(E('earth'), { d: 0.6, ring: true, n: 1.5, dark: true }),
  double_edge: burst(E('earth'), { d: 0.5, r: 190, c: '#ffb050' }),
  stampede: rise(E('earth'), { d: 0.8, r: 100, dark: true }),
  // Chaos Knight, Chen.
  chaos_bolt: impact(E('chaos'), { d: 0.5, r: 70 }),
  reality_rift: beam(E('chaos'), { d: 0.5, w: 18 }),
  persuade: beam(E('holy'), { d: 0.6, w: 10 }),
  hand_of_god: rise('#ffe9a0', { d: 1.3, r: 100, n: 1.6, sh: SH.STAR, ring: true }),
  // Clinkz, Dark Seer, Dark Willow.
  death_pact: beam(E('fire'), { d: 0.6, w: 10, c: '#ff6a2a' }),
  vacuum: nova(E('psi'), { d: 0.6, back: true, swirl: true }),
  wall_of_replica: line(E('psi'), { d: 8, w: 70 }),
  normal_punch: burst(E('psi'), { d: 0.5, r: 120 }),
  cursed_crown: warn(E('psi'), { d: 4 }),
  terrorize: nova(E('shadow'), { d: 0.8, ring: true }),
  terrorize_impact: burst(E('shadow'), { d: 0.6, sh: SH.SKULL }),
  // Dawnbreaker.
  starbreaker_smash: burst(E('sun'), { d: 0.6, ring: true, n: 1.6 }),
  starbreaker_swipe: spin(E('sun'), { d: 0.35 }),
  hammer_pos: impact(E('sun'), { d: 0.3 }),
  luminosity: nova(E('holy'), { d: 0.5 }),
  solar_guardian: warn(E('sun'), { d: 1.7 }),
  solar_land: burst(E('sun'), { d: 0.7, ring: true, n: 2 }),
  solar_pulse: nova(E('sun'), { d: 0.5 }),
  // Dazzle, Death Prophet, Disruptor.
  poison_touch: cone(E('poison'), { d: 0.5, w: 20 }),
  shadow_wave: chain('#ff7ad8', { d: 0.4, w: 9 }),
  nothl_body: field(E('shadow'), { r: 70 }),
  dp_silence: burst(E('spectral'), { d: 0.6, sh: SH.CROSS }),
  thunder_strike: chain(E('lightning'), { d: 0.35, sky: true, w: 9, ring: true }),
  glimpse: blink(E('lightning'), { trail: true }),
  kinetic_warn: warn(E('lightning'), {}),
  kinetic_field: field(E('lightning'), { r: 340 }),
  kinetic_fence: line(E('lightning'), { d: 0.6, w: 40 }),
  repulsion: nova(E('lightning'), { d: 0.5, ring: true }),
  static_storm: nova(E('lightning'), { d: 0.5 }),
  // Doom, Dragon Knight.
  devour: beam(E('demon'), { d: 0.5, w: 16 }),
  lvl_pain: burst(E('demon'), { d: 0.5 }),
  dragon_tail: burst(E('fire'), { d: 0.4, r: 90, c: '#ffd05a' }),
  fireball: burst(E('fire'), { d: 0.5 }),
  elder_dragon_form: rise(E('fire'), { d: 1, r: 140, n: 1.6, ring: true }),
  // Earth Spirit, Earthshaker, Elder Titan.
  boulder_smash: burst(E('earth'), { d: 0.4, dark: true }),
  rolling_boulder_end: burst(E('earth'), { d: 0.5, r: 150, dark: true }),
  geomagnetic_grip: beam(E('nature'), { d: 0.5, w: 14 }),
  magnetize: nova('#5cf0c8', { d: 0.5 }),
  magnetize_explode: burst('#5cf0c8', { d: 0.5 }),
  petrify_shatter: burst(E('earth'), { d: 0.6, n: 1.6, sh: SH.SHARD, dark: true }),
  fissure: line(E('earth'), { d: 1.2, dark: true, n: 1.6 }),
  echo_slam: nova(E('earth'), { d: 0.9, ring: true, n: 2.2, dark: true }),
  echo: beam('#c8a060', { d: 0.4, w: 9 }),
  echo_stomp_warn: warn(E('moon'), {}),
  echo_stomp: nova(E('moon'), { d: 0.7, ring: true, n: 1.5 }),
  astral_spirit: blink(E('moon'), { d: 0.6, trail: true }),
  earth_splitter: line('#7fe0ff', { n: 1.2 }),
  earth_splitter_hit: line('#7fe0ff', { d: 0.8, n: 2, ring: true }),
  // Ember Spirit, Enchantress, Enigma.
  searing_chains: nova(E('fire'), { d: 0.5, sh: SH.FLAME }),
  sleight_of_fist: slash(E('fire'), { d: 0.5, r: 120 }),
  fire_remnant_explode: burst(E('fire'), { d: 0.5 }),
  enchant: beam(E('nature'), { d: 0.5, w: 10, c: '#c0ff80' }),
  little_friends: nova(E('nature'), { d: 0.6 }),
  malefice: impact(E('void'), { d: 0.5, r: 70 }),
  demonic_conversion: burst(E('void'), { d: 0.6, r: 120 }),
  black_hole: field('#5a2ab8', { swirl: true, n: 2, c2: '#e0c8ff' }),
  // Faceless Void.
  time_walk: blink(E('time'), { d: 0.6, trail: true }),
  backtrack: impact(E('time'), { d: 0.4, r: 60 }),
  time_dilation: nova(E('time'), { d: 0.7, ring: true }),
  time_lock: burst(E('time'), { d: 0.5, r: 80, sh: SH.RING }),
  chronosphere: nova(E('time'), { d: 0.7, ring: true }),
  // Nature's Prophet, Grimstroke, Gyrocopter.
  sprout: field(E('nature'), { sh: SH.LEAF }),
  force_of_nature: nova(E('nature'), { d: 0.6, sh: SH.LEAF }),
  curse_forest: nova(E('nature'), { d: 0.7, c: '#80c040' }),
  wrath_of_nature: chain(E('nature'), { d: 0.5, w: 10 }),
  phantom_pop: burst(E('ink'), { d: 0.5 }),
  ink_swell_burst: burst(E('ink'), { d: 0.6, ring: true }),
  soul_chain: nova(E('ink'), { d: 0.5 }),
  soulbind: beam('#4a6cff', { d: 0.6, w: 8 }),
  soulbind_copy: impact(E('ink'), { d: 0.4 }),
  homing_missile_hit: burst(E('fire'), { d: 0.5, r: 120 }),
  call_down_warn: warn(E('fire'), {}),
  call_down: fall(E('fire'), { d: 0.6, h: 1000, ring: true, n: 1.6 }),
  // Huskar, Invoker.
  invoke: impact(E('arcane'), { d: 0.4, r: 60 }),
  'invoker_orb.q': impact(E('ice'), { d: 0.35, r: 40 }),
  'invoker_orb.w': impact('#d070ff', { d: 0.35, r: 40 }),
  'invoker_orb.e': impact('#ffb030', { d: 0.35, r: 40 }),
  emp: warn('#b088ff', { sh: SH.SPARK }),
  emp_blast: nova('#b088ff', { d: 0.6, ring: true, n: 1.6, sh: SH.SPARK }),
  meteor_fall: fall(E('fire'), { d: 0.8, h: 1100, n: 2, ring: true }),
  sun_strike_warn: warn(E('sun'), {}),
  sun_strike: pillar(E('sun'), { d: 0.8, h: 1100, n: 2, c2: '#ffffff' }),
  // Kez, Kunkka, Largo.
  echo_slash: line(E('steel'), { d: 0.4, n: 1.2 }),
  raptor_slash: slash(E('steel'), { d: 0.35 }),
  ravens_veil: nova('#3a3a6a', { d: 0.6, dark: true, sh: SH.SMOKE }),
  kez_switch: impact(E('steel'), { d: 0.3 }),
  parry: bubble(E('steel'), { d: 0.35 }),
  torrent_bubbles: warn(E('water'), { sh: SH.BUBBLE }),
  torrent: pillar(E('water'), { d: 0.8, h: 600, n: 2, ring: true }),
  tidebringer: cone(E('water'), { d: 0.4, w: 40 }),
  x_mark: warn(E('water'), { r: 70, sh: SH.CROSS }),
  ghostship_crash: burst(E('water'), { d: 0.8, ring: true, n: 2 }),
  lick: beam('#ff7ab0', { d: 0.4, w: 10 }),
  frog_toss: arc(E('water'), { d: 0.6, h: 300 }),
  frogstomp: nova(E('water'), { d: 0.5 }),
  strum: nova('#ff9a5a', { d: 0.5, sh: SH.STAR }),
  // Legion Commander, Leshrac, Lich.
  overwhelming_odds: nova(E('gold'), { d: 0.6, ring: true, n: 1.6 }),
  moment_of_courage: impact(E('gold'), { d: 0.35 }),
  duel: beam(E('gold'), { d: 1, w: 8 }),
  duel_win: rise(E('gold'), { d: 1.4, r: 120, n: 2, ring: true }),
  split_earth: pillar('#b48cff', { d: 0.7, h: 380, n: 1.6, ring: true }),
  edict: burst(E('lightning'), { d: 0.35, r: 60, c: '#c8a0ff' }),
  nihilism: nova(E('arcane'), { d: 0.6 }),
  pulse_nova: burst(E('lightning'), { d: 0.45, r: 120 }),
  frost_shield_pulse: nova(E('ice'), { d: 0.5, sh: SH.SNOW }),
  sacrifice: beam(E('ice'), { d: 0.4, w: 12 }),
  // Lifestealer, Lina, Lion.
  infest: beam(E('blood'), { d: 0.4, w: 10 }),
  infest_burst: burst(E('blood'), { d: 0.6, ring: true }),
  lsa_warn: warn(E('fire'), {}),
  lsa: pillar(E('fire'), { d: 0.65, h: 560, n: 1.6, c2: '#ffe08a', ring: true }),
  laguna: beam(E('fire'), { d: 0.55, w: 46, c2: '#fff1b0', n: 1.6 }),
  'laguna.lion': chain('#ff2a14', { d: 0.6, w: 16, n: 1.6, c2: '#ffd080' }),
  // Lone Druid, Lycan, Magnus.
  entangle: burst(E('nature'), { d: 0.5, sh: SH.LEAF }),
  entangle_cast: nova(E('nature'), { d: 0.5, sh: SH.LEAF }),
  true_form: rise(E('nature'), { d: 0.8, r: 120, ring: true }),
  summon_wolves: burst('#a0a0c0', { d: 0.6, r: 120, dark: true }),
  howl: nova(E('blood'), { d: 0.8, ring: true }),
  wolf_bite: beam(E('blood'), { d: 0.4, w: 8 }),
  shapeshift: rise(E('blood'), { d: 0.8, r: 120, ring: true, dark: true, sh: SH.SMOKE }),
  skewer_impact: burst(E('ice'), { d: 0.4, r: 120 }),
  horn_toss: nova(E('ice'), { d: 0.5 }),
  reverse_polarity: nova('#a8e0ff', { d: 0.9, ring: true, n: 2.4, c2: '#ffffff' }),
  // Mars, Medusa, Meepo.
  spear_impale: burst(E('gold'), { d: 0.5, r: 90 }),
  gods_rebuke: cone(E('gold'), { d: 0.45, w: 55, c: '#ffcf60' }),
  arena_of_blood: nova(E('gold'), { d: 0.8, ring: true }),
  arena_spear: impact(E('gold'), { d: 0.3 }),
  gorgon_warn: warn(E('water'), { c: '#5cf0a0' }),
  gorgon_grasp: burst('#5cf0a0', { d: 0.5, sh: SH.DROP }),
  earthbind: arc('#c9a46a', { h: 180, end: burst('#c9a46a', { d: 0.4, sh: SH.RING }) }),
  earthbind_land: burst('#c9a46a', { d: 0.5, sh: SH.RING }),
  poof: burst('#9fb8e8', { d: 0.6, dark: true, n: 1.4, sh: SH.SMOKE }),
  fling: burst(E('earth'), { d: 0.4, dark: true }),
  // Monkey King, Morphling, Naga, Necrophos, Shadow Fiend.
  boundless_strike: line(E('gold'), { d: 0.5, n: 1.6, dark: true }),
  primal_spring_warn: warn(E('gold'), {}),
  primal_spring: burst(E('gold'), { d: 0.6, ring: true, dark: true }),
  mischief: burst('#d0d0ff', { d: 0.5, dark: true, sh: SH.SMOKE }),
  wukong_soldier: blink(E('gold'), { d: 0.4 }),
  morph: rise(E('water'), { d: 0.5, r: 80 }),
  rip_tide: nova(E('water'), { d: 0.5, ring: true }),
  reapers_scythe: pillar(E('shadow'), { d: 1.2, h: 450, n: 1.4, c: '#6a2ab8', ring: true }),
  death_pulse: nova(E('poison'), { d: 0.6, ring: true }),
  soul: beam(E('demon'), { d: 0.45, w: 6 }),
  shadowraze: pillar(E('demon'), { d: 0.65, h: 320, n: 1.6, dark: false, c2: '#ffb050' }),
  requiem: nova(E('demon'), { d: 1, ring: true, n: 2.4, sh: SH.SMOKE }),
  // Night Stalker, Nyx, Outworld Destroyer, Ogre, Omniknight, Oracle.
  void: burst(E('void'), { d: 0.6 }),
  darkness: nova('#20123a', { d: 1.4, dark: true, n: 1.5, sh: SH.SMOKE }),
  mind_flare: burst(E('mana'), { d: 0.5 }),
  carapace_burst: burst(E('mana'), { d: 0.5, sh: SH.SHARD }),
  astral_end: burst(E('arcane'), { d: 0.5 }),
  sanity_eclipse: nova('#a0e0ff', { d: 0.9, ring: true, n: 2.2, c2: '#ffffff' }),
  fireblast: burst(E('fire'), { d: 0.5, r: 90, c: '#ff7a2a' }),
  multicast: rise(E('fire'), { d: 0.5, r: 60 }),
  false_promise_end: burst(E('sun'), { d: 0.6 }),
  // Pangolier, Phantom Assassin, Phoenix, Primal Beast, Puck, Pugna, QoP.
  shield_crash: nova(E('steel'), { d: 0.5, dark: true }),
  swashbuckle: line(E('steel'), { d: 0.45, w: 80 }),
  gyro_bounce: impact(E('steel'), { d: 0.3 }),
  coup_de_grace: slash('#ff2a2a', { d: 0.6, r: 160, n: 1.8 }),
  fan_of_knives: nova('#d8d8e8', { d: 0.45, sh: SH.SHARD, n: 1.6 }),
  fade: burst('#a99ab8', { d: 0.4, r: 70, dark: true, sh: SH.SMOKE }),
  sun_ray: beam(E('sun'), { d: 0.3, w: 70, c2: '#fff6c8' }),
  supernova: burst(E('sun'), { d: 1.1, ring: true, n: 2.6, r: 900, c2: '#ffffff' }),
  fire_spirit: arc(E('fire'), { h: 200, end: burst(E('fire'), { d: 0.5 }) }),
  fire_spirit_hit: burst(E('fire'), { d: 0.5 }),
  trample: burst(E('earth'), { d: 0.35, r: 120, dark: true, n: 0.6 }),
  uproar: nova(E('earth'), { d: 0.6, ring: true, c: '#ff7040' }),
  rock_throw_warn: warn(E('earth'), {}),
  rock_throw: burst(E('earth'), { d: 0.6, n: 1.6, sh: SH.SHARD, dark: true }),
  pulverize: nova(E('earth'), { d: 0.6, ring: true, n: 1.8, dark: true }),
  waning_rift: nova(E('psi'), { d: 0.6, ring: true, sh: SH.STAR }),
  dream_coil: field(E('psi'), { swirl: true }),
  dream_coil_break: burst(E('psi'), { d: 0.5 }),
  nether_blast_warn: warn('#9ae05a', {}),
  nether_blast: nova('#9ae05a', { d: 0.6, ring: true }),
  nether_ward_zap: chain('#9ae05a', { d: 0.3, w: 6 }),
  sonic_boom: nova(E('shadow'), { d: 0.4 }),
  // Clockwerk, Razor, Riki, Ringmaster, Rubick.
  battery_assault: chain(E('lightning'), { d: 0.25, w: 5 }),
  power_cogs: field(E('steel'), { c: '#ffc060', sh: SH.SPARK }),
  cog_shock: chain(E('lightning'), { d: 0.3, w: 6 }),
  rocket_flare: arc(E('fire'), { h: 400, end: burst(E('fire'), { d: 0.5 }) }),
  rocket_flare_hit: burst(E('fire'), { d: 0.6, ring: true }),
  hookshot_impact: burst(E('steel'), { d: 0.5, r: 120 }),
  lightning: chain('#5ab0ff', { d: 0.3, w: 6, c2: '#ffffff' }),
  'lightning.luna': chain(E('moon'), { d: 0.35, w: 9, sky: true, c2: '#ffffff' }),
  backstab: slash(E('shadow'), { d: 0.35, r: 80 }),
  escape_act_pop: burst(E('chaos'), { d: 0.5, sh: SH.STAR }),
  spotlight_beam: pillar('#fff2c0', { d: 0.6, h: 900, n: 0.6 }),
  wheel_explode: burst(E('chaos'), { d: 0.8, ring: true, n: 2, sh: SH.STAR }),
  telekinesis_land: nova(E('nature'), { d: 0.5, c: '#90ff60' }),
  fade_bolt: chain(E('nature'), { d: 0.35, w: 8, c: '#a0ff80' }),
  // Sand King, Shadow Shaman, Timbersaw, Silencer, Wraith King, Skywrath.
  burrowstrike: line(E('sand'), { d: 0.6, n: 1.6 }),
  scorpion_strike: burst(E('sand'), { d: 0.5 }),
  epicenter: spikes(E('sand'), { d: 0.5 }),
  ether_shock: chain(E('lightning'), { d: 0.3, w: 5 }),
  fowl_play: burst(E('nature'), { d: 0.5, r: 90, sh: SH.STAR }),
  urnaconda: arc(E('poison'), { h: 120 }),
  whirling_death: spin(E('steel'), { d: 0.45, n: 1.6 }),
  timber_chain: beam('#c0c0c8', { w: 6 }),
  glaive_bounce: beam(E('mana'), { d: 0.25, w: 6 }),
  last_word: burst(E('mana'), { d: 0.5, sh: SH.CROSS }),
  global_silence: nova(E('mana'), { d: 1.2, r: 900, ring: true, sh: SH.CROSS }),
  wraith_form: rise(E('mist'), { d: 0.6, r: 80 }),
  reincarnation: pillar(E('mist'), { d: 1.4, h: 500, n: 2, ring: true }),
  mystic_flare: field(E('mana'), { d: 2.2, n: 2 }),
  // Slardar, Slark, Snapfire, Spectre, Spirit Breaker, Storm Spirit.
  slithereen_crush: nova(E('water'), { d: 0.6, ring: true, n: 1.6 }),
  dark_pact_warn: warn(E('void'), {}),
  shadow_dance: burst('#1a1028', { d: 0.6, dark: true, sh: SH.SMOKE }),
  mortimer_glob: arc(E('fire'), { h: 500, end: burst(E('fire'), { d: 0.5, r: 230 }) }),
  mortimer_impact: burst(E('fire'), { d: 0.5 }),
  cookie_land: nova('#ffb060', { d: 0.5, ring: true }),
  haunt: rise(E('spectral'), { d: 0.8, r: 90, sh: SH.SMOKE }),
  nether_strike: blink(E('void'), { d: 0.6, trail: true }),
  planar_pocket_redirect: beam(E('void'), { d: 0.4, w: 10 }),
  overload: burst(E('lightning'), { d: 0.4, r: 280 }),
  static_remnant_blast: burst(E('lightning'), { d: 0.45 }),
  // Techies, Templar Assassin, Terrorblade, Tidehunter, Tinker.
  lob: arc({ h: 300 }),
  sticky_bomb: burst(E('fire'), { d: 0.6, ring: true }),
  reactive_tazer: nova(E('lightning'), { d: 0.5 }),
  blast_off: burst(E('fire'), { d: 0.9, ring: true, n: 2.4 }),
  mad: nova(E('fire'), { d: 0.9, ring: true, n: 2.4 }),
  mad_barrel: warn(E('fire'), {}),
  minefield: field(E('fire'), { n: 0.4, sh: SH.SPARK }),
  land_mine_blast: burst(E('fire'), { d: 0.7, ring: true, n: 1.8 }),
  meld_strike: slash(E('psi'), { d: 0.4 }),
  psi_blades: line(E('psi'), { d: 0.3, w: 30 }),
  psionic_trap: nova(E('psi'), { d: 0.6, ring: true }),
  reflection: nova(E('demon'), { d: 0.6 }),
  metamorphosis: rise(E('demon'), { d: 0.9, r: 140, ring: true, n: 1.6 }),
  terror_wave: spikes(E('demon'), { sh: SH.SKULL }),
  sunder: beam('#c040ff', { d: 0.8, w: 24, c2: '#ffd0ff', n: 1.8 }),
  anchor_smash: nova(E('water'), { d: 0.5 }),
  kraken_cleanse: bubble(E('water'), { d: 0.5 }),
  ravage: spikes(E('water'), { n: 1.6, sh: SH.SHARD }),
  laser: beam('#ff3030', { d: 0.4, w: 14, c2: '#ffe0e0' }),
  march: line(E('steel'), { d: 0.6, n: 0.6 }),
  turret_drop: warn(E('steel'), {}),
  rearm: rise(E('lightning'), { d: 0.8, r: 90, sh: SH.SPARK }),
  // Tiny, Treant, Troll, Tusk, Undying, Vengeful, Viper, Visage, Void Spirit.
  avalanche: burst(E('earth'), { d: 0.8, n: 2.2, dark: true, sh: SH.SHARD, ring: true }),
  toss_land: nova(E('earth'), { d: 0.5, dark: true }),
  tree_land: burst(E('nature'), { d: 0.5, sh: SH.LEAF }),
  leech_pulse: chain(E('nature'), { d: 0.3, w: 6 }),
  overgrowth: nova(E('nature'), { d: 0.8, ring: true, n: 1.6, sh: SH.LEAF }),
  switch_stance: impact(E('blood'), { d: 0.3 }),
  walrus_punch: burst(E('ice'), { d: 0.8, r: 160, n: 2, sh: SH.SNOW, ring: true }),
  decay: nova(E('bone'), { d: 0.6, c: '#a0ff70' }),
  soul_rip: beam('#a0ff70', { d: 0.45, w: 8 }),
  tombstone: pillar(E('bone'), { d: 0.8, h: 300, w: 110 }),
  nether_swap: blink(E('spectral'), { d: 0.6, trail: true }),
  nethertoxin: field(E('poison'), { sh: SH.DROP }),
  nethertoxin_proj: arc(E('poison'), { d: 0.5, h: 200 }),
  nose_dive: burst(E('poison'), { d: 0.7, ring: true, n: 1.6 }),
  stone_form: burst('#9a9aa8', { d: 0.6, dark: true, sh: SH.SHARD }),
  aether_remnant: line(E('arcane'), { n: 0.6 }),
  aether_remnant_proj: beam(E('arcane'), { d: 0.35, w: 10 }),
  aether_pull: impact(E('arcane'), { d: 0.4 }),
  dissimilate_portal: portal(E('arcane'), {}),
  dissimilate_exit: burst(E('arcane'), { d: 0.6, ring: true }),
  resonant_pulse: nova(E('arcane'), { d: 0.5, ring: true }),
  astral_step: blink(E('arcane'), { d: 0.5, trail: true }),
  // Warlock, Weaver, Windranger, Winter Wyvern, Io, Witch Doctor, Zeus.
  fatal_bonds: chain(E('demon'), { d: 0.5, w: 5 }),
  upheaval: field(E('demon'), { n: 1.2, sh: SH.SMOKE }),
  chaotic_offering: fall(E('demon'), { d: 0.7, h: 1100, ring: true, n: 2.6 }),
  time_lapse: blink(E('time'), { d: 0.6, trail: true }),
  thread_of_fate: beam(E('time'), { d: 0.5, w: 6 }),
  shackle: beam(E('wind'), { w: 7 }),
  powershot_charge: rise(E('wind'), { r: 60, n: 0.6 }),
  gale_force: line(E('wind'), { d: 0.8, sh: SH.SWIRL }),
  splinter_shatter: burst(E('ice'), { d: 0.5, sh: SH.SHARD }),
  winters_curse: field(E('ice'), { sh: SH.SNOW }),
  tether: beam('#cfeaff', { d: 0.4, w: 8 }),
  wisp_spirit: impact('#cfeaff', { d: 0.12, r: 26, n: 0.2 }),
  wisp_spirit_explode: burst('#cfeaff', { d: 0.4 }),
  relocate_warn: portal('#cfeaff', { r: 120 }),
  maledict: nova(E('poison'), { d: 0.5, sh: SH.SKULL, c: '#c0ff60' }),
  maledict_burst: burst(E('poison'), { d: 0.5, c: '#c0ff60' }),
  lightning_bolt: chain('#5ab0ff', { d: 0.4, w: 9, sky: true, c2: '#ffffff', ring: true }),
  'lightning_bolt@zuus_thundergods_wrath': chain('#5ab0ff', { d: 0.45, w: 12, sky: true, c2: '#ffffff', ring: true, n: 1.6 }),
  arc_lightning: chain('#5ab0ff', { d: 0.35, w: 7, c2: '#ffffff' }),
  // Varios.
  aftershock: nova(E('earth'), { d: 0.5, dark: true }),
  bear_return: blink(E('nature'), { d: 0.5 }),
  bear_summon: burst(E('nature'), { d: 0.6, r: 120 }),
  dominate: beam('#c080ff', { d: 0.5, w: 8 }),
  endurance: nova(E('blood'), { d: 0.6 }),
  fallen_sky: fall(E('fire'), { d: 0.7, h: 900, ring: true }),
  firestorm: fall(E('demon'), { d: 0.5, h: 600, n: 0.8 }),
  ice_wall: line(E('ice'), { sh: SH.SHARD }),
  imp_explode: burst(E('fire'), { d: 0.5 }),
  impetus: impact(E('arcane'), { d: 0.4 }),
  plague_spread: beam(E('poison'), { d: 0.35, w: 6 }),
  plasma_field: nova(E('lightning'), { back: true, ring: true }),
  press_the_attack: rise(E('heal'), { d: 0.6, r: 80 }),
  purification: burst(E('holy'), { d: 0.6, ring: true }),
  remnant: burst(E('lightning'), { d: 0.4, r: 70 }),
  remnant_break: burst(E('lightning'), { d: 0.4, r: 70 }),
  rocket: beam(E('fire'), { d: 0.3, w: 8 }),
  savage_roar: nova(E('blood'), { d: 0.6, ring: true }),
  scream_of_pain: nova(E('shadow'), { d: 0.5, c: '#d050ff' }),
  shadow_path: field(E('spectral'), { sh: SH.SMOKE }),
  smoke: burst('#8080a0', { d: 0.8, dark: true, sh: SH.SMOKE, n: 1.4 }),
  starfall: fall(E('moon'), { d: 0.5, h: 900, sh: SH.STAR }),
  unleash_pulse: nova(E('psi'), { d: 0.4, c: '#ff70c0' }),
  veil: nova(E('arcane'), { d: 0.6 }),
  bramble: field(E('nature'), { sh: SH.LEAF, n: 0.6 }),
  tame_the_beasts: cone(E('earth'), { d: 0.6, w: 35 }),
  trees_cut: NONE,
  // Firmas al lanzar (evento 'cast') para habilidades cuyo servidor no emite nada propio.
  'cast@batrider_flaming_lasso': beam(E('fire'), { d: 3, w: 8 }),
  'cast@pugna_life_drain': beam('#9ae05a', { d: 10, w: 16, chan: true, c2: '#f0ffd0' }),
  'cast@slardar_amplify_damage': impact(E('water'), { d: 0.6, r: 70, sh: SH.SHARD }),
  'cast@shadow_shaman_mass_serpent_ward': nova(E('lightning'), { d: 0.6, r: 220, ring: true }),
  'cast@sven_gods_strength': rise(E('mana'), { d: 1, r: 140, ring: true, n: 1.6 }),
  'cast@ursa_enrage': rise(E('blood'), { d: 0.9, r: 130, ring: true, n: 1.6 }),
  'cast@luna_eclipse': nova('#3a4a9a', { d: 1.2, r: 675, ring: true, c2: '#cfe0ff' }),
  'cast@largo_amphibian_rhapsody': nova('#ff9a5a', { d: 0.8, r: 500, sh: SH.STAR }),
  'cast@keeper_of_the_light_spirit_form': rise(E('holy'), { d: 1, r: 130, ring: true }),
  'cast@life_stealer_consume': burst(E('blood'), { d: 0.6, r: 140 }),
  'cast@visage_summon_familiars': burst(E('spectral'), { d: 0.7, r: 180, sh: SH.SMOKE }),
  'cast@bristleback_warpath': rise('#e8d8b0', { d: 0.6, r: 100 }),
  'cast@sniper_assassinate': impact('#ffe066', { d: 1.2, r: 60, sh: SH.CROSS }),
  'cast@crystal_maiden_freezing_field': nova(E('ice'), { d: 0.8, r: 810, sh: SH.SNOW }),
  'cast@witch_doctor_death_ward': pillar(E('poison'), { d: 0.7, r: 90, h: 350 }),
  'cast@juggernaut_omni_slash': slash('#ffd27a', { d: 0.4, r: 160 }),
  'cast@phantom_lancer_juxtapose': NONE,
  'cast@riki_backstab': NONE,
  aoe: nova({ d: 0.6, ring: true }),
  'aoe.arcane_curse': nova(E('mana'), { d: 0.7, ring: true, sh: SH.CROSS }),
  barrier: bubble(E('gold'), { d: 0.5 }),
  omnislash: slash('#ffd27a', { d: 0.35, r: 140, n: 1.2 }),
  shrapnel_warn: warn('#d9b36a', {}),
  invoker_orb: impact(E('arcane'), { d: 0.35, r: 40 }),
  mana_restore: rise(E('mana'), { d: 0.8, r: 90 }),
  frost_blast: burst(E('ice'), { d: 0.6, ring: true, sh: SH.SNOW }),
  caustic_explode: burst(E('poison'), { d: 0.6, sh: SH.DROP }),
  fortunes_end: burst(E('sun'), { d: 0.6, ring: true }),
  marci_impact: burst(E('psi'), { d: 0.5, ring: true, c: '#ff70c0' }),
};

// ---------------------------------------------------------------- estados (a mano)

const st = (k: StatusKind, c?: string, o: Omit<StatusDef, 'k' | 'c'> = {}): StatusDef => ({ k, c, ...o });

export const STATUS: Record<string, StatusDef> = {
  // Control.
  stun: st('stun', '#ffe066'),
  bash: st('stun', '#ffe066'),
  hex: st('hex', '#9cff6a'),
  sleep: st('sleep', '#c8b8ff'),
  nightmare: st('sleep', '#8a50ff'),
  silence: st('mark', '#c08cff', { mark: SH.CROSS }),
  disarm: st('mark', '#ff6a5a', { mark: SH.CROSS }),
  break: st('mark', '#ff9a40', { mark: SH.SHARD }),
  blind: st('mark', '#e0e0e0', { mark: SH.SMOKE }),
  fear: st('mark', '#b060ff', { mark: SH.SKULL }),
  crippling_fear: st('mark', '#5a2ab8', { mark: SH.SKULL }),
  taunt: st('mark', '#ff3030', { mark: SH.CHEVRON, also: st('aura', '#ff3030') }),
  berserkers_call: st('mark', '#ff3030', { mark: SH.CHEVRON }),
  root: st('root', '#7ab04a'),
  entangle: st('root', '#5cc83a'),
  ensnare: st('root', E('water')),
  shackles: st('root', '#a8f0d8'),
  leash: st('root', '#3a2a6a'),
  slow: st('slow', '#7fb8ff'),
  frostbite: st('frozen', '#bfe9ff'),
  frozen: st('frozen', '#9fdcff'),
  cold_snap: st('frozen', '#9fdcff'),
  stone: st('frozen', '#a0a0a8'),
  petrify: st('frozen', '#b09a78'),
  cyclone: st('lift', '#e8f2ff'),
  airborne: st('lift', '#e8f2ff'),
  tossed: st('lift', '#c8a878'),
  thrown: st('lift', '#ff9ad0'),
  telekinesis: st('lift', '#a0ff80'),
  black_hole: st('lift', '#8a50ff'),
  push: st('trail', '#ffffff'),
  hooked: st('trail', '#c9a46a'),
  skewered: st('trail', E('ice')),
  astral_prison: st('shield', E('arcane')),
  disruption: st('shield', E('demon')),
  shadow_realm: st('ghost', E('psi')),
  dominated: st('mark', '#c080ff', { mark: SH.RING }),
  persuaded: st('mark', E('holy'), { mark: SH.RING }),
  duel: st('mark', E('gold'), { mark: SH.STAR, also: st('aura', E('gold')) }),
  mesmerize: st('sleep', E('chaos')),
  dream_coil: st('mark', E('psi'), { mark: SH.STAR }),
  chronosphere: st('frozen', E('time')),
  time_lock: st('stun', E('time')),
  dismember: st('glow', E('blood'), { also: st('drip', E('blood')) }),
  // Daños en el tiempo.
  burn: st('burn', E('fire')),
  ignite: st('burn', E('fire')),
  fiery_soul: st('burn', E('fire'), { n: 0.5 }),
  scorched_earth: st('field', E('fire'), { r: 600, n: 0.6 }),
  poison: st('drip', E('poison')),
  plague: st('drip', E('poison')),
  shadow_poison: st('drip', '#c040ff'),
  bleed: st('drip', E('blood')),
  open_wounds: st('drip', E('blood')),
  rupture: st('drip', E('blood'), { also: st('glow', E('blood')) }),
  doom: st('burn', E('demon'), { also: st('mark', E('demon'), { mark: SH.SKULL }) }),
  maledict: st('mark', '#c0ff60', { mark: SH.SKULL }),
  curse: st('drip', '#80c040'),
  decay: st('drip', '#a0ff70'),
  corrosive_haze: st('mark', '#ff7040', { mark: SH.SHARD }),
  armor_down: st('mark', '#ff7040', { mark: SH.SHARD }),
  armor_reduction: st('mark', '#ff7040', { mark: SH.SHARD }),
  track: st('mark', E('gold'), { mark: SH.STAR }),
  x_mark: st('mark', E('water'), { mark: SH.CROSS }),
  spotlight: st('glow', '#fff2c0'),
  winters_curse: st('frozen', E('ice'), { also: st('aura', E('ice')) }),
  // Escudos y protecciones.
  bkb: st('shield', E('gold')),
  magic_immune: st('shield', E('gold')),
  barrier: st('shield', '#8fb6ff'),
  pipe: st('shield', '#9fb8ff'),
  lotus: st('shield', '#ff9fd8'),
  linkens: st('shield', '#5fd1ff'),
  counterspell: st('shield', '#b49cff'),
  blade_mail: st('shield', '#d0d0d8'),
  satanic: st('glow', '#ff3030', { also: st('motes', '#ff3030', { sh: SH.DROP }) }),
  meat_shield: st('shield', '#e88a8a'),
  frost_shield: st('shield', E('ice')),
  kraken_shell: st('shield', E('water')),
  guardian_angel: st('shield', E('holy'), { also: st('motes', E('holy'), { sh: SH.STAR }) }),
  repel: st('shield', E('holy')),
  shallow_grave: st('shield', '#ff70b0', { also: st('aura', '#ff70b0') }),
  false_promise: st('shield', E('sun'), { also: st('aura', E('sun')) }),
  borrowed_time: st('shield', E('mist'), { also: st('motes', E('mist')) }),
  aeon_disk: st('shield', E('gold')),
  mana_shield: st('shield', E('mana')),
  ion_shell: st('shield', E('psi'), { also: st('motes', E('psi'), { sh: SH.SPARK }) }),
  surge: st('trail', E('psi')),
  carapace: st('shield', '#5aa0ff'),
  bulwark: st('shield', E('gold')),
  refraction: st('shield', E('psi')),
  flame_guard: st('shield', E('fire'), { also: st('burn', E('fire'), { n: 0.4 }) }),
  living_armor: st('aura', E('nature'), { also: st('motes', E('nature'), { sh: SH.LEAF }) }),
  crimson_guard: st('shield', '#ff6040'),
  solar_crest: st('aura', E('sun')),
  reactive_armor: st('shield', E('steel')),
  tombstone_bunker: st('shield', E('bone')),
  bodyguard: st('aura', '#ff9ad0'),
  parry: st('shield', E('steel')),
  stone_form: st('frozen', '#9a9aa8'),
  // Áreas centradas en la unidad.
  blade_fury: st('spin', '#ffb347', { r: 260 }),
  whirling_axes_melee: st('spin', E('steel'), { r: 220 }),
  rot: st('field', '#8bc34a', { r: 250, n: 1.4, sh: SH.SMOKE }),
  freezing_field: st('field', '#9fdcff', { r: 810, n: 0.8, sh: SH.SNOW, pops: 9 }),
  healing_ward: st('field', '#7dff7d', { r: 400 }),
  radiance: st('field', '#ffae42', { r: 650, n: 0.5 }),
  immolation: st('field', '#ffae42', { r: 300, n: 0.5 }),
  sand_storm: st('field', E('sand'), { r: 550, n: 1.6, sh: SH.SMOKE }),
  static_storm: st('field', E('lightning'), { r: 450, pops: 4 }),
  epicenter: st('field', E('sand'), { r: 500, n: 0.6, pops: 5 }),
  eye_of_the_storm: st('field', E('lightning'), { r: 500, n: 0.6 }),
  electric_vortex: st('lift', E('lightning')),
  ice_spire: st('field', E('ice'), { r: 300 }),
  nether_ward: st('field', '#9ae05a', { r: 600, n: 0.3 }),
  serpent_ward: st('aura', E('lightning')),
  death_ward: st('field', E('poison'), { r: 160, n: 0.4 }),
  quill_spray: st('aura', '#e8d8b0'),
  pulse_nova: st('field', E('lightning'), { r: 450, n: 0.5, pops: 3 }),
  supernova: st('field', E('sun'), { r: 400, n: 1.6, pops: 3 }),
  sun_ray: st('glow', E('sun')),
  solar_guardian: st('field', E('sun'), { r: 500 }),
  fire_spirits: st('motes', E('fire'), { sh: SH.FLAME }),
  firefly: st('trail', E('fire')),
  flamethrower: st('burn', E('fire')),
  rocket_barrage: st('field', E('fire'), { r: 400, n: 0.3, pops: 10 }),
  flak_cannon: st('aura', E('steel')),
  whirling_death: st('spin', E('steel'), { r: 300 }),
  battle_trance: st('glow', E('blood'), { also: st('motes', E('blood')) }),
  howl: st('motes', E('blood')),
  tether: st('aura', '#cfeaff'),
  overcharge: st('glow', '#cfeaff', { also: st('motes', '#cfeaff') }),
  relocate: st('aura', '#cfeaff'),
  sinister_gaze: st('mark', E('ice'), { mark: SH.SKULL }),
  ravens_veil: st('ghost', '#3a3a6a'),
  // Mejoras.
  haste: st('trail', '#ffffff'),
  sprint: st('trail', E('water')),
  windrun: st('trail', E('wind')),
  tailwind: st('trail', E('wind')),
  charge_of_darkness: st('trail', E('void')),
  bulldoze: st('trail', E('void')),
  phantom_rush: st('trail', '#8fb6ff'),
  phantom_strike: st('trail', E('steel')),
  icarus_dive: st('trail', E('sun')),
  onslaught_charge: st('trail', E('earth')),
  rolling_boulder: st('trail', E('earth')),
  ball_lightning: st('glow', E('lightning'), { also: st('trail', E('lightning')) }),
  falcon_rush: st('trail', E('steel')),
  bloodlust: st('glow', '#ff4a2a', { also: st('motes', '#ff4a2a') }),
  berserk: st('glow', '#ff5050'),
  berserkers_rage: st('glow', E('blood')),
  rage: st('glow', '#ff3030', { also: st('shield', '#ff3030') }),
  armlet: st('glow', '#ff3030'),
  empower: st('motes', '#ff9a40'),
  frenzy: st('motes', E('demon')),
  enchant: st('aura', '#c0ff80'),
  overload: st('motes', E('lightning'), { sh: SH.SPARK }),
  static_charge: st('motes', E('lightning'), { sh: SH.SPARK }),
  take_aim: st('aura', '#ffe066'),
  deadly_focus: st('glow', '#ff2a2a'),
  focus_fire: st('glow', E('wind')),
  strafe: st('motes', E('fire')),
  demon_zeal: st('glow', E('demon')),
  metamorphosis: st('burn', E('demon'), { n: 0.6 }),
  dragon_form_: st('burn', E('fire'), { n: 0.4 }),
  true_form: st('aura', E('nature')),
  transform: st('aura', E('blood')),
  grow: st('aura', E('earth')),
  megameepo: st('aura', E('earth')),
  fountain_heal: st('motes', '#7dff7d'),
  heal: st('motes', E('heal')),
  regen: st('motes', E('heal')),
  flask: st('motes', E('heal')),
  clarity: st('motes', E('mana')),
  tango: st('motes', E('nature'), { sh: SH.LEAF }),
  bottle: st('motes', E('mana')),
  voodoo_restoration: st('field', E('heal'), { r: 500, n: 0.5 }),
  natures_attendants: st('motes', E('nature'), { sh: SH.LEAF, n: 1.4 }),
  soul_ring: st('motes', E('blood')),
  mana: st('motes', E('mana')),
  fight_song: st('motes', '#ff9a5a', { sh: SH.STAR }),
  groovin: st('motes', '#ff9a5a', { sh: SH.STAR }),
  rhapsody: st('motes', '#ff9a5a', { sh: SH.STAR }),
  song: st('field', E('water'), { r: 1000, n: 0.5, sh: SH.STAR }),
  divine_favor: st('motes', E('holy'), { sh: SH.STAR }),
  hand_of_god: st('motes', E('holy')),
  converge: st('motes', E('sun')),
  starbreaker: st('glow', E('sun')),
  jingu: st('motes', E('gold')),
  // Invisibilidad y formas etéreas.
  invis: st('ghost', '#ffffff'),
  invisible: st('ghost', '#ffffff'),
  moonlight: st('ghost', E('moon')),
  fade: st('ghost', '#a99ab8'),
  blur: st('ghost', '#c8c8e0'),
  ghost_walk: st('ghost', E('ice')),
  smoke: st('ghost', '#8080a0'),
  shadow_dance: st('ghost', '#1a1028'),
  shukuchi: st('ghost', E('time')),
  meld: st('ghost', E('psi')),
  phase_shift: st('ghost', E('psi')),
  ethereal: st('ghost', '#8fffc8', { also: st('shield', '#8fffc8') }),
  wraith_form: st('ghost', E('mist'), { also: st('motes', E('mist')) }),
  doppel: st('ghost', '#8fb6ff'),
  dig: st('ghost', E('earth')),
  burrow: st('ghost', E('earth')),
  dissimilate: st('ghost', E('arcane')),
  // Otros.
  battle_hunger: st('mark', '#ff6a3a', { mark: SH.DROP }),
  corruption: st('mark', '#5a3a5a', { mark: SH.SHARD }),
  homing_missile: st('mark', E('fire'), { mark: SH.CHEVRON }),
  void_mark: st('mark', E('arcane'), { mark: SH.RING }),
  kez_mark: st('mark', E('steel'), { mark: SH.CROSS }),
  glimpse: st('trail', E('lightning')),
  thunder_strike: st('mark', E('lightning'), { mark: SH.BOLT }),
  static_link: st('aura', E('lightning')),
  static_link_beam: st('aura', E('lightning')),
  fatal_bonds: st('mark', E('demon'), { mark: SH.RING }),
  shadow_word: st('drip', E('demon')),
  soulbind: st('mark', '#4a6cff', { mark: SH.RING }),
  ink_swell: st('field', E('ink'), { r: 220, n: 0.6 }),
  arcane_curse: st('mark', E('mana'), { mark: SH.CROSS }),
  ancient_seal: st('mark', E('mana'), { mark: SH.STAR }),
  life_break: st('glow', E('fire')),
  omnislash: st('glow', '#ffd27a', { also: st('trail', '#ffd27a') }),
  sleight_of_fist: st('ghost', E('fire')),
  fire_remnant: st('ghost', E('fire')),
  // Resto de modificadores con fx, uno a uno.
  alacrity: st('glow', '#ff9a40', { also: st('motes', '#ff9a40') }),
  anchor: st('root', E('water')),
  anchor_smash: st('mark', E('water'), { mark: SH.SHARD }),
  arcane_boots: st('motes', E('mana')),
  arctic_burn: st('trail', E('ice')),
  arena_kill_buff: st('motes', E('gold')),
  astral_buff: st('glow', E('moon')),
  astral_spirit: st('ghost', E('moon')),
  battery_assault: st('motes', E('lightning'), { sh: SH.SPARK, n: 1.6 }),
  bedlam: st('spin', E('psi'), { r: 250 }),
  blood: st('drip', E('blood')),
  bloodstone: st('glow', E('blood')),
  bloom: st('motes', E('nature'), { sh: SH.LEAF }),
  bull_rush: st('trail', E('earth')),
  cart: st('trail', E('earth')),
  caustic: st('drip', E('poison')),
  chakram: st('slow', '#e0e0f0'),
  cold_embrace: st('frozen', E('ice')),
  concoction: st('mark', E('poison'), { mark: SH.DROP }),
  croak: st('hex', E('water')),
  croak_reverb: st('mark', E('water'), { mark: SH.RING }),
  cursed_crown: st('mark', E('psi'), { mark: SH.STAR }),
  dark_ascension: st('glow', E('void')),
  dark_pact: st('glow', E('void'), { also: st('motes', E('void')) }),
  dark_portrait: st('ghost', E('ink')),
  dead_in_the_water: st('root', E('water')),
  death_pact: st('glow', E('fire')),
  decrepify: st('ghost', '#9ae05a'),
  demonic_cleanse: st('motes', E('demon')),
  demonic_purge: st('drip', E('demon'), { also: st('slow', E('demon')) }),
  devour: st('glow', E('demon')),
  diabolic_edict: st('field', E('lightning'), { r: 500, n: 0.6, sh: SH.SPARK }),
  dispersion: st('shield', E('spectral')),
  disseminate: st('mark', E('demon'), { mark: SH.SKULL }),
  double_edge: st('glow', E('earth')),
  dragon_slave: st('burn', E('fire'), { n: 0.6 }),
  drinking_buddies: st('trail', E('ice')),
  dual_breath_ice: st('slow', E('ice')),
  dust: st('mark', E('gold'), { mark: SH.STAR }),
  enchant_totem: st('glow', E('earth')),
  entangle_empower: st('root', E('nature')),
  entangle_stacks: st('mark', E('nature'), { mark: SH.LEAF }),
  escape_act: st('ghost', E('chaos')),
  essence_shift: st('motes', E('void'), { n: 0.4 }),
  exorcism: st('field', E('spectral'), { r: 700, n: 0.8, sh: SH.SMOKE }),
  fade_bolt: st('drip', '#a0ff80'),
  fates_edict: st('shield', E('sun')),
  fetch: st('drip', E('fire')),
  flesh_golem: st('aura', E('bone')),
  flesh_golem_plague: st('drip', '#a0ff70'),
  flying: st('none'),
  frost: st('slow', E('ice')),
  gobbled: st('ghost', '#ffb060'),
  gush: st('slow', E('water')),
  gyroshell: st('trail', E('steel')),
  hammer: st('glow', E('sun')),
  haunt: st('ghost', E('spectral')),
  hop: st('trail', '#ffb060'),
  hurricane_pike: st('trail', E('wind')),
  infest: st('ghost', E('blood')),
  infested: st('glow', E('blood')),
  ink_trail: st('slow', E('ink')),
  intimidate: st('mark', '#ff9a40', { mark: SH.SKULL }),
  jetpack: st('trail', E('fire')),
  land_mine: st('none'),
  last_word: st('mark', E('mana'), { mark: SH.CROSS }),
  leap: st('trail', E('moon')),
  leech_seed: st('drip', E('nature')),
  lil_shredder: st('motes', E('fire')),
  little_friends: st('mark', E('nature'), { mark: SH.LEAF }),
  lucky_shot: st('mark', E('steel'), { mark: SH.STAR }),
  lunar_orbit: st('spin', E('moon'), { r: 300 }),
  lvl_pain: st('mark', E('demon'), { mark: SH.SKULL }),
  mad_barrel: st('mark', E('fire'), { mark: SH.CHEVRON }),
  mage_slayer: st('drip', E('mana')),
  magnetize: st('drip', '#5cf0c8'),
  malefice: st('mark', E('void'), { mark: SH.RING }),
  meld_armor: st('mark', E('psi'), { mark: SH.SHARD }),
  menace: st('mark', E('demon'), { mark: SH.SKULL }),
  minefield_sign: st('field', E('fire'), { r: 300, n: 0.2 }),
  mirror_image: st('ghost', E('water')),
  mischief: st('ghost', '#d0d0ff'),
  morph_agi: st('motes', E('water')),
  morph_str: st('motes', '#ff8040'),
  mortimer_kisses: st('aura', E('fire')),
  nimbus: st('field', E('lightning'), { r: 180, n: 0.5 }),
  nothl: st('ghost', E('shadow')),
  nullifier: st('mark', E('chaos'), { mark: SH.CROSS }),
  onslaught: st('glow', E('earth')),
  overclocking: st('glow', E('steel'), { also: st('motes', E('lightning'), { sh: SH.SPARK }) }),
  overgrowth: st('root', E('nature')),
  overwhelming_odds: st('motes', E('gold')),
  phantasm: st('ghost', E('chaos')),
  phantom: st('ghost', E('ink')),
  pierce_the_veil: st('ghost', E('spectral'), { also: st('glow', E('spectral')) }),
  planar_pocket: st('shield', E('void')),
  power_cog: st('none'),
  press_the_attack: st('motes', E('heal')),
  psionic_trap_idle: st('field', E('psi'), { r: 120, n: 0.2 }),
  pull: st('lift', E('nature')),
  pulverize: st('lift', E('earth')),
  pupate: st('hex', E('psi')),
  purifying_flames: st('burn', E('sun')),
  raptor_dance: st('spin', E('steel'), { r: 280 }),
  reactive_tazer: st('motes', E('lightning'), { sh: SH.SPARK }),
  recall: st('motes', E('spectral')),
  reflection: st('ghost', E('demon')),
  reincarnating: st('frozen', E('mist')),
  remnant: st('none'),
  replicate: st('ghost', E('water')),
  retribution: st('motes', E('spectral')),
  roared: st('mark', '#ff7040', { mark: SH.SKULL }),
  rollup: st('trail', E('steel')),
  rum: st('motes', '#ffb050'),
  sadist: st('motes', E('poison')),
  saltwater_shiv: st('drip', E('water')),
  shadow_path: st('trail', E('spectral')),
  shadow_step: st('ghost', E('spectral')),
  shadow_strike: st('drip', E('shadow')),
  shadowraze: st('mark', E('demon'), { mark: SH.FLAME }),
  shapeshift: st('motes', E('blood')),
  shred: st('mark', E('steel'), { mark: SH.SHARD }),
  skeleton: st('none'),
  skewer: st('trail', E('ice')),
  snowball: st('frozen', E('ice')),
  solar_air: st('trail', E('sun')),
  soul_release: st('drip', E('spectral')),
  spear_impaled: st('root', E('gold')),
  spell_steal: st('motes', E('nature')),
  spirit_siphon: st('drip', E('spectral')),
  stampede: st('trail', E('earth')),
  static_remnant: st('field', E('lightning'), { r: 120, n: 0.6 }),
  sticky_bomb: st('mark', E('fire'), { mark: SH.CHEVRON }),
  stone_buff: st('shield', '#a0a0a8'),
  stone_gaze: st('field', '#5cf0a0', { r: 400, n: 0.4 }),
  strongman_tonic: st('glow', '#ff7040'),
  swarm: st('drip', E('time')),
  switcheroo: st('ghost', E('poison')),
  tag_team: st('motes', E('ice')),
  teleport: st('motes', '#8fd0ff', { n: 2 }),
  tombstone: st('field', E('bone'), { r: 300, n: 0.4 }),
  trample: st('trail', E('earth')),
  transfiguration: st('hex', E('gold')),
  treant_eyes: st('none'),
  tree_grab: st('motes', E('nature'), { sh: SH.LEAF, n: 0.4 }),
  tree_perch: st('motes', E('gold'), { n: 0.4 }),
  tricks: st('ghost', E('shadow')),
  turret: st('none'),
  unicycle: st('trail', E('chaos')),
  unleash: st('glow', '#ff70c0', { also: st('motes', '#ff70c0') }),
  vacuum: st('lift', E('psi')),
  veil: st('mark', E('arcane'), { mark: SH.STAR }),
  warp_flare: st('mark', '#b07aff', { mark: SH.RING }),
  weave_ally: st('motes', '#ff7ad8'),
  weave_enemy: st('mark', '#ff7ad8', { mark: SH.SHARD }),
  windup: st('glow', E('earth')),
  wolf_bite: st('glow', E('blood')),
  work_horse: st('trail', E('earth')),
  wukongs_command: st('aura', E('gold')),
  channel: st('none'),
  buff: st('none'),
};

// ---------------------------------------------------------------- proyectiles (a mano)

const pj = (c: string | undefined, s: number, o: Omit<ProjDef, 'c' | 's'> = {}): ProjDef => ({ c, s, ...o });

export const PROJ: Record<string, ProjDef> = {
  dragon_slave: pj(E('fire'), 60, { wave: 220, trail: 5, sh: SH.FLAME, z: 50 }),
  hook: pj('#d8c8a0', 26, { chain: '#9a8a6a', sh: SH.SHARD, trail: 0.5 }),
  lance: pj('#8fb6ff', 26, { trail: 2, arrow: true }),
  spirit_lance: pj('#8fb6ff', 26, { trail: 2, arrow: true }),
  assassinate: pj('#ffe066', 22, { trail: 4, arrow: true, c2: '#ffffff' }),
  ethereal: pj('#8fffc8', 30, { trail: 3 }),
  atos: pj('#c08cff', 26, { trail: 2 }),
  storm_bolt: pj('#6aa8ff', 34, { trail: 3, sh: SH.SPARK, c2: '#ffffff' }),
  chaos_bolt: pj(E('chaos'), 32, { trail: 3 }),
  shockwave: pj('#9fd8ff', 50, { wave: 160, trail: 4, dark: false }),
  powershot: pj(E('wind'), 34, { wave: 120, trail: 4, arrow: true }),
  arrow: pj(E('moon'), 30, { trail: 3, arrow: true, c2: '#ffffff' }),
  sonic_wave: pj(E('shadow'), 60, { wave: 300, trail: 4, sh: SH.RING }),
  wave_of_terror: pj(E('spectral'), 40, { wave: 180, trail: 4, sh: SH.SMOKE }),
  breathe_fire: pj(E('fire'), 50, { wave: 200, trail: 5, sh: SH.FLAME }),
  crypt_swarm: pj(E('spectral'), 40, { wave: 180, trail: 4, sh: SH.SMOKE }),
  tidal_wave: pj(E('water'), 60, { wave: 300, trail: 5, sh: SH.DROP }),
  ghostship: pj('#7fa8c0', 70, { trail: 3, dark: true, sh: SH.SMOKE }),
  cannon_ball: pj('#404048', 20, { trail: 2, dark: true, sh: SH.SMOKE }),
  gush: pj(E('water'), 32, { trail: 3, sh: SH.DROP }),
  gush_wave: pj(E('water'), 40, { wave: 160, trail: 4, sh: SH.DROP }),
  impale: pj(E('earth'), 36, { wave: 120, trail: 5, sh: SH.SHARD, dark: true, z: 20 }),
  ice_blast: pj(E('ice'), 44, { trail: 4, sh: SH.SNOW }),
  ice_blast_tracer: pj(E('ice'), 24, { trail: 1.5, sh: SH.SNOW }),
  chain_frost: pj(E('ice'), 38, { trail: 4, sh: SH.SNOW, c2: '#ffffff' }),
  ice_shards: pj(E('ice'), 30, { trail: 3, sh: SH.SHARD }),
  splinter_blast: pj(E('ice'), 34, { trail: 3, sh: SH.SHARD }),
  venomous_gale: pj(E('poison'), 40, { wave: 120, trail: 4, sh: SH.DROP }),
  noxious_plague: pj(E('poison'), 34, { trail: 3, sh: SH.DROP }),
  viper_strike: pj(E('poison'), 30, { trail: 3, sh: SH.DROP }),
  poison_touch: pj(E('poison'), 26, { trail: 2 }),
  shadow_poison: pj('#c040ff', 30, { trail: 2, sh: SH.SKULL }),
  death_coil: pj(E('mist'), 32, { trail: 3, sh: SH.SMOKE }),
  death_pulse: pj(E('poison'), 26, { trail: 2 }),
  death_pulse_heal: pj(E('heal'), 26, { trail: 2 }),
  mystic_snake: pj('#5cf0a0', 30, { trail: 3, sh: SH.DROP }),
  mystic_snake_return: pj('#5cf0a0', 24, { trail: 2 }),
  shadow_strike: pj(E('shadow'), 28, { trail: 3, sh: SH.SHARD }),
  stifling_dagger: pj('#e0e0f0', 22, { trail: 2, arrow: true, sh: SH.SHARD }),
  spectral_dagger: pj(E('spectral'), 30, { trail: 4, sh: SH.SMOKE }),
  shuriken: pj('#e0e0e0', 24, { spin: true, sh: SH.STAR, trail: 1.5 }),
  chakram: pj('#e0e0f0', 50, { spin: true, sh: SH.RING, trail: 2 }),
  whirling_axe: pj('#e0c0a0', 30, { spin: true, sh: SH.CROSS, trail: 1.5 }),
  boomerang: pj(E('nature'), 30, { spin: true, sh: SH.CROSS, trail: 2 }),
  magic_missile: pj(E('arcane'), 30, { trail: 3, sh: SH.SPARK }),
  arcane_bolt: pj(E('mana'), 30, { trail: 3, sh: SH.SPARK }),
  concussive_shot: pj(E('mana'), 34, { trail: 3, sh: SH.STAR }),
  paralyzing_cask: pj('#9cff6a', 26, { trail: 2, spin: true, sh: SH.SHARD }),
  penitence: pj(E('holy'), 28, { trail: 2 }),
  illusory_orb: pj(E('psi'), 40, { trail: 4, sh: SH.STAR }),
  requiem: pj(E('demon'), 36, { trail: 2, sh: SH.SMOKE, wave: 80 }),
  scatterblast: pj(E('fire'), 40, { wave: 180, trail: 5 }),
  firesnap_cookie: pj('#ffb060', 26, { trail: 2 }),
  ignite: pj(E('fire'), 30, { trail: 4, sh: SH.FLAME }),
  fireball: pj(E('fire'), 36, { trail: 4, sh: SH.FLAME }),
  fire_shield: pj(E('fire'), 26, { trail: 2 }),
  flamebreak: pj(E('fire'), 30, { trail: 4, sh: SH.FLAME }),
  burning_barrage: pj(E('fire'), 20, { trail: 3, arrow: true }),
  chaos_meteor: pj(E('fire'), 80, { trail: 6, sh: SH.FLAME, z: 50 }),
  tornado: pj(E('wind'), 60, { trail: 4, sh: SH.SWIRL, spin: true }),
  wraithfire_blast: pj(E('mist'), 30, { trail: 3, sh: SH.FLAME }),
  martyrdom: pj(E('holy'), 26, { trail: 2 }),
  soul_assumption: pj(E('spectral'), 30, { trail: 3 }),
  spell_steal: pj(E('nature'), 26, { trail: 2 }),
  stroke_of_fate: pj(E('ink'), 50, { wave: 140, trail: 4, sh: SH.SMOKE }),
  spark_wraith: pj(E('lightning'), 30, { trail: 3, sh: SH.SPARK }),
  turret_missile: pj(E('fire'), 20, { trail: 3, dark: true, sh: SH.SMOKE }),
  march_robot: pj(E('steel'), 24, { trail: 1 }),
  warp_flare: pj('#b07aff', 26, { trail: 3 }),
  harpoon: pj('#c0c0c8', 26, { chain: '#8a8a90', arrow: true }),
  hookshot: pj('#c0c0c8', 26, { chain: '#8a8a90', arrow: true }),
  kez_claw: pj('#c0c0c8', 22, { chain: '#8a8a90', arrow: true }),
  talon_toss: pj(E('steel'), 26, { spin: true, sh: SH.SHARD }),
  mars_spear: pj(E('gold'), 34, { trail: 3, arrow: true }),
  dead_shot: pj(E('spectral'), 26, { trail: 4, arrow: true }),
  spectral_slug: pj(E('spectral'), 30, { trail: 3 }),
  fortunes_end: pj(E('sun'), 34, { trail: 3 }),
  wheel_of_wonder: pj(E('chaos'), 60, { spin: true, sh: SH.STAR, trail: 3 }),
  impalement_dagger: pj('#e0e0f0', 22, { arrow: true, trail: 2 }),
  hurl_boulder: pj(E('earth'), 36, { dark: true, sh: SH.SHARD, trail: 2 }),
  toss_tree: pj(E('nature'), 50, { sh: SH.LEAF, trail: 2 }),
  slugger: pj(E('earth'), 30, { trail: 2 }),
  rattlecage: pj(E('bone'), 30, { trail: 2 }),
  bedlam: pj(E('psi'), 22, { trail: 3 }),
  adaptive_strike: pj(E('water'), 34, { trail: 3, sh: SH.DROP }),
  berserk_potion: pj(E('poison'), 24, { trail: 2 }),
  concoction: pj(E('poison'), 30, { trail: 3, spin: true, sh: SH.DROP }),
  cinder_brew: pj('#e0a040', 30, { trail: 2, sh: SH.DROP }),
  liquid_courage: pj('#ffb050', 26, { trail: 2 }),
  dragon_tail: pj('#ffd05a', 26, { trail: 2 }),
  ensnare: pj(E('water'), 30, { trail: 2, sh: SH.RING }),
  shackleshot: pj(E('wind'), 26, { arrow: true, trail: 3 }),
  crippling_crossbow: pj('#c0c0c8', 20, { arrow: true, trail: 2 }),
  dead_in_the_water: pj(E('water'), 30, { chain: '#3a6a8a' }),
  goo: pj('#a0d040', 22, { trail: 2, sh: SH.DROP }),
  hairball: pj('#c0a080', 26, { trail: 2 }),
  deafening_blast: pj('#c8a0ff', 60, { wave: 200, trail: 4 }),
  spawn_spiderlings: pj(E('poison'), 26, { trail: 2 }),
  nullifier: pj(E('chaos'), 24, { trail: 2 }),
  uproar_projectile: pj('#ff7040', 24, { trail: 2 }),
  weaver_swarm: pj(E('time'), 20, { trail: 1.5 }),
  death_ward: pj(E('poison'), 18, { trail: 2 }),
};

/** Ataque a distancia de cada héroe o unidad: [color, forma, tamaño]. */
const ATTACK: Record<string, [string, Shape?, number?]> = {
  lina: [E('fire'), SH.FLAME, 14], crystal_maiden: [E('ice'), SH.SNOW], sniper: ['#ffe8a0', SH.SPARK, 8], fountain: ['#9fe0ff'],
  ancient_apparition: [E('ice'), SH.SNOW], arc_warden: [E('lightning')], bane: [E('void'), SH.SMOKE], batrider: [E('fire'), SH.FLAME],
  chen: [E('holy')], clinkz: [E('fire'), SH.FLAME], dark_willow: [E('psi'), SH.STAR], dazzle: ['#ff7ad8'], death_prophet: [E('spectral'), SH.SMOKE],
  disruptor: [E('lightning')], drow_ranger: [E('ice'), SH.SHARD], enchantress: ['#c0ff80', SH.LEAF], enigma: [E('void'), SH.SMOKE],
  furion: [E('nature'), SH.LEAF], grimstroke: [E('ink'), SH.SMOKE], gyrocopter: ['#ffd27a', SH.SPARK, 8], hoodwink: [E('nature')],
  huskar: [E('fire'), SH.FLAME], invoker: [E('arcane')], jakiro: [E('fire'), SH.FLAME], keeper_of_the_light: [E('holy'), SH.STAR],
  leshrac: [E('lightning')], lich: [E('ice'), SH.SNOW], lion: [E('demon')], lone_druid: [E('nature')], luna: [E('moon'), SH.RING],
  medusa: ['#5cf0a0', SH.SHARD], mirana: [E('moon'), SH.SHARD], morphling: [E('water'), SH.DROP], muerta: [E('spectral'), SH.SPARK, 8],
  necrolyte: [E('poison')], nevermore: [E('demon'), SH.SMOKE], obsidian_destroyer: [E('arcane')], oracle: [E('sun'), SH.FLAME],
  phoenix: [E('sun'), SH.FLAME], puck: [E('psi'), SH.STAR], pugna: ['#9ae05a'], queenofpain: [E('shadow')], razor: [E('lightning')],
  ringmaster: [E('chaos'), SH.STAR], rubick: [E('nature')], shadow_demon: [E('demon')], shadow_shaman: [E('lightning')],
  silencer: [E('mana'), SH.RING], skywrath_mage: [E('mana'), SH.STAR], snapfire: ['#ffb060', SH.SPARK], storm_spirit: [E('lightning')],
  techies: [E('fire')], templar_assassin: [E('psi')], tinker: [E('lightning')], troll_warlord: ['#e0c0a0', SH.SHARD],
  vengefulspirit: [E('spectral')], venomancer: [E('poison'), SH.DROP], viper: [E('poison'), SH.DROP], visage: [E('spectral')],
  warlock: [E('demon')], weaver: [E('time')], windrunner: [E('wind'), SH.SHARD], winter_wyvern: [E('ice'), SH.SNOW], wisp: ['#cfeaff'],
  witch_doctor: [E('poison'), SH.SKULL], zuus: ['#a8dcff', SH.SPARK],
};

// ---------------------------------------------------------------- zonas (a mano)

const zn = (c: string | undefined, o: Omit<ZoneDef, 'c'> = {}): ZoneDef => ({ c, ...o });

export const ZONE: Record<string, ZoneDef> = {
  shrapnel: zn('#d9b36a', { n: 1.4, sh: SH.SPARK, rain: true }),
  chronosphere: zn(E('time'), { dome: true, edge: true }),
  kinetic_field: zn(E('lightning'), { edge: true, n: 0.6 }),
  black_hole: zn('#5a2ab8', { swirl: true }),
  static_storm: zn(E('lightning'), { n: 1.4, sh: SH.SPARK, rain: true }),
  macropyre: zn(E('fire'), { n: 1.4, sh: SH.FLAME }),
  ice_path: zn(E('ice'), { n: 0.8, sh: SH.SHARD, edge: true }),
  ice_wall: zn(E('ice'), { n: 0.8, sh: SH.SHARD, edge: true }),
  glacier: zn(E('ice'), { n: 0.6, sh: SH.SNOW, edge: true }),
  acid_spray: zn(E('poison'), { n: 1.2, sh: SH.DROP }),
  nethertoxin: zn(E('poison'), { n: 0.8, sh: SH.DROP }),
  sand_storm: zn(E('sand'), { n: 1.6, sh: SH.SMOKE, dark: true, swirl: true }),
  smoke_screen: zn('#8080a0', { n: 1.4, sh: SH.SMOKE, dark: true }),
  pit_of_malice: zn(E('demon'), { edge: true, n: 0.6 }),
  dark_portal: zn(E('demon'), { swirl: true, edge: true }),
  midnight_pulse: zn(E('void'), { n: 0.8, edge: true }),
  arena_of_blood: zn(E('gold'), { edge: true, n: 0.4 }),
  wall_of_replica: zn(E('psi'), { edge: true }),
  chakram: zn('#e0e0f0', { swirl: true, n: 0.6 }),
  mystic_flare: zn(E('mana'), { rain: true, n: 2, sh: SH.SPARK }),
  rain_of_destiny: zn(E('sun'), { rain: true, n: 1.2 }),
  avalanche: zn(E('earth'), { n: 1.6, dark: true, sh: SH.SHARD }),
  firestorm: zn(E('demon'), { rain: true, n: 1.2, sh: SH.FLAME }),
  fireball: zn(E('fire'), { n: 1.2, sh: SH.FLAME }),
  firespit: zn(E('fire'), { n: 1, sh: SH.FLAME }),
  celestial_flare: zn(E('sun'), { n: 1 }),
  minefield: zn(E('fire'), { n: 0.3, edge: true }),
  gale_force: zn(E('wind'), { swirl: true, n: 1.2, sh: SH.SWIRL }),
  twister: zn(E('wind'), { swirl: true, n: 1.4, sh: SH.SWIRL }),
  emp_drag: zn('#b088ff', { swirl: true, n: 1.2, sh: SH.SPARK }),
  magnetic_field: zn(E('lightning'), { edge: true, n: 0.6, c2: '#ffffff' }),
  spark_wraith: zn(E('lightning'), { n: 0.6, sh: SH.SPARK }),
  natures_grasp: zn(E('nature'), { n: 0.8, sh: SH.LEAF }),
  bramble: zn(E('nature'), { n: 0.6, sh: SH.LEAF }),
  spin_web: zn('#d8d8c8', { n: 0.08 }),
  psionic_trap: zn(E('psi'), { edge: true, n: 0.4 }),
  the_calling: zn(E('spectral'), { edge: true, swirl: true }),
  spotlight: zn('#fff2c0', { edge: true, n: 0.6 }),
  wheel_of_wonder: zn(E('chaos'), { edge: true, n: 0.8, sh: SH.STAR }),
  whoopee_cloud: zn('#c8a0ff', { n: 1.2, sh: SH.SMOKE, dark: true }),
  wukongs_command: zn(E('gold'), { edge: true, n: 0.4 }),
  wukong_soldier: zn(E('gold'), { n: 0.4 }),
  ice_vortex: zn(E('ice'), { swirl: true, n: 1, sh: SH.SNOW }),
  ice_shard: zn(E('ice'), { n: 0.6, sh: SH.SHARD, edge: true }),
  slardar_puddle: zn(E('water'), { n: 0.6, sh: SH.DROP }),
  surge_trail: zn(E('psi'), { n: 0.4 }),
  spear_trail: zn(E('gold'), { n: 0.6, sh: SH.FLAME }),
  frogstomp: zn(E('water'), { n: 0.6 }),
  depth_shroud: zn('#1a1028', { n: 1.2, sh: SH.SMOKE, dark: true }),
  seeds_of_serenity: zn(E('heal'), { n: 0.6, sh: SH.LEAF }),
  aether_remnant: zn(E('arcane'), { n: 0.6 }),
  essence_distiller: zn(E('mana'), { n: 0.6 }),
  gem: zn('#c0ffff', { n: 0.2 }),
  rocket_flare_sight: zn(E('fire'), { n: 0.2 }),
  emp: zn('#b088ff', { n: 1 }),
};

// ---------------------------------------------------------------- respaldo automático

type Inv = Record<string, { a?: string[]; f?: string[]; debuff?: 1 }>;
const INV = inventory as unknown as { emits: Inv; mods: Inv; projs: Inv; zones: Inv };

/** Habilidad "dueña" de un nombre según el inventario (para estados sin `a`). */
export const ownerOf = (kind: keyof typeof INV, name: string) => INV[kind][name]?.a?.[0];

const has = (re: RegExp, s: string) => re.test(s);

/** Forma automática de un evento a partir de su nombre, campos y la habilidad. */
export function autoFx(n: string, f: Partial<Fx>, a?: string | null): FxDef {
  const beh = a ? ABILITIES[a]?.behavior ?? [] : [];
  const two = f.x2 !== undefined || f.u2 !== undefined;
  if (has(/_warn$|_charge$/, n)) return { k: 'warn' };
  if (has(/portal|teleport|relocate/, n)) return { k: 'portal' };
  if (has(/blink|step|jump|leap|dash|walk|swap|_exit$/, n) && two) return { k: 'blink', trail: true };
  if (has(/lightning|chain|bolt|zap|shock|arc_|bounce/, n) && two) return { k: 'chain', w: 6 };
  if (f.d !== undefined && f.x2 !== undefined && f.u2 === undefined && !has(/beam|link|tether/, n)) return f.r ? { k: 'line', w: f.r } : { k: 'arc', h: 260 };
  if (f.u2 !== undefined || (f.x2 !== undefined && !f.r)) return { k: 'beam', w: 10, d: f.d ?? 0.4 };
  if (f.x2 !== undefined && f.r) return { k: 'line', w: f.r, d: 0.6 };
  if (f.d !== undefined && f.r) return { k: 'field' };
  if (f.r) {
    if (has(/stomp|slam|smash|nova|pulse|wave|howl|roar|call|crush|quake|repuls|ring/, n)) return { k: 'nova', ring: true, d: 0.6 };
    if (has(/strike|meteor|fall|sky|star|rain/, n)) return { k: 'fall', h: 900, d: 0.6 };
    return beh.includes('aoe') || beh.includes('point') ? { k: 'burst', ring: true, d: 0.6 } : { k: 'burst', d: 0.5 };
  }
  if (has(/heal|restore|regen|levelup|rise|morph|form|summon/, n)) return { k: 'rise', d: 0.7, r: 90 };
  if (has(/slash|strike|stab|crit|cleave/, n)) return { k: 'slash', d: 0.35 };
  if (has(/shield|block|reflect|cleanse/, n)) return { k: 'bubble', d: 0.45 };
  return { k: 'impact', d: 0.4, r: 60 };
}

/** Estado automático por palabras clave del nombre y si es un debuff. */
export function autoStatus(n: string): StatusDef {
  const inv = INV.mods[n];
  const debuff = !!inv?.debuff;
  if (has(/stun|bash|stone|petrif|frozen|freeze|trance|sleep/, n)) return { k: has(/sleep/, n) ? 'sleep' : has(/stone|petrif|frozen|freeze/, n) ? 'frozen' : 'stun' };
  if (has(/hex|voodoo|pupate|transfigur/, n)) return { k: 'hex' };
  if (has(/silence|mute/, n)) return { k: 'mark', mark: SH.CROSS };
  if (has(/disarm/, n)) return { k: 'mark', mark: SH.CROSS };
  if (has(/fear|terror|menace/, n)) return { k: 'mark', mark: SH.SKULL };
  if (has(/root|entangle|snare|leash|web|anchor|shackle/, n)) return { k: 'root' };
  if (has(/cyclone|toss|lift|thrown|airborne|launch|pull|vacuum/, n)) return { k: 'lift' };
  if (has(/shield|barrier|guard|aegis|armor|carapace|bulwark|bunker|shell|kraken|bubble|immune|grave|promise|repel/, n)) return { k: 'shield' };
  if (has(/invis|fade|ghost|phase|shadow_dance|smoke|ethereal|meld|veil|realm|hide|burrow|dig|dissim/, n)) return { k: 'ghost' };
  if (has(/haste|speed|sprint|run|charge|rush|dash|leap|hop|unicycle|jetpack|bulldoze|rollup|gyroshell|cart|onslaught/, n)) return { k: 'trail' };
  if (has(/burn|ignite|fire|flame|scorch|napalm|immol/, n)) return { k: 'burn' };
  if (has(/poison|plague|venom|toxin|bleed|rupture|wound|curse|decay|rot|caustic|acid|drain|leech|siphon/, n)) return { k: 'drip' };
  if (has(/slow|frost|cold|chill|ice|crippl|drag|enfeeble|decrepify/, n)) return { k: 'slow' };
  if (has(/mark|track|seal|edict|bond|link|chain|aim|focus|spotlight|sign|kiss/, n)) return { k: 'mark', mark: debuff ? SH.SKULL : SH.STAR };
  if (has(/ward|aura|field|storm|zone/, n)) return { k: 'aura' };
  if (has(/rage|berserk|frenzy|lust|zeal|empower|strength|power|buff|form|grow|true|mega|demon|overcharge|overclock|tonic/, n)) return { k: 'glow', also: { k: 'motes' } };
  if (has(/heal|regen|mana|restor|song|rhapsody|groov|favor|attendant/, n)) return { k: 'motes' };
  return debuff ? { k: 'drip', n: 0.6 } : { k: 'motes', n: 0.7 };
}

/** Proyectil automático: núcleo y estela del color de su habilidad. */
export function autoProj(fx: string, a?: string | null): ProjDef {
  const wave = has(/wave|breath|shock|gale|swarm|blast|stroke|spray/, fx);
  const arrow = has(/arrow|dagger|spear|shot|bolt|bullet|claw|harpoon/, fx);
  const spin = has(/shuriken|chakram|axe|glaive|boomerang|wheel|cask/, fx);
  return { s: wave ? 44 : 28, wave: wave ? 160 : undefined, trail: 3, arrow, spin };
}

// ---------------------------------------------------------------- resolución con memoria

const fxMemo = new Map<string, Resolved<FxDef>>();
const stMemo = new Map<string, Resolved<StatusDef>>();
const pjMemo = new Map<string, Resolved<ProjDef>>();
const znMemo = new Map<string, Resolved<ZoneDef>>();

function finish<T extends { c?: string; c2?: string; sh?: Shape; dark?: boolean }>(def: T, look: Look, auto: boolean): Resolved<T> {
  const c = def.c ?? look.c;
  // Si la entrada fija el color pero no el núcleo, el núcleo es una versión clara de ese color.
  const c2 = def.c2 ?? (def.c ? lighten(def.c, 0.65) : look.c2);
  return { def, c, c2, sh: def.sh ?? look.sh, dark: def.dark ?? (auto ? !!look.dark : false), auto };
}

/** Aspecto de un evento Fx (o null si lo pinta otra capa). */
export function fxStyle(f: Fx): Resolved<FxDef> | null {
  const a = f.a ?? ownerOf('emits', f.n) ?? null;
  const key = f.n + '|' + (f.c ?? '') + '|' + (a ?? '') + '|' + (f.x2 !== undefined ? 1 : 0) + (f.u2 !== undefined ? 1 : 0) + (f.r ? 1 : 0) + (f.d !== undefined ? 1 : 0);
  let r = fxMemo.get(key);
  if (r) return r.def.k === 'none' ? null : r;
  const hand = (f.c !== undefined ? FX[f.n + '.' + f.c] : undefined) ?? (a ? FX[f.n + '@' + a] : undefined) ?? FX[f.n];
  const def = hand ?? autoFx(f.n, f, a);
  r = finish(def, nameLook(f.n, a), !hand);
  fxMemo.set(key, r);
  return def.k === 'none' ? null : r;
}

/** Aspecto de un estado de unidad. */
export function statusStyle(name: string): Resolved<StatusDef> {
  let r = stMemo.get(name);
  if (r) return r;
  const hand = STATUS[name];
  const def = hand ?? autoStatus(name);
  r = finish(def, nameLook(name, ownerOf('mods', name)), !hand);
  stMemo.set(name, r);
  return r;
}

/** Aspecto de un proyectil. */
export function projStyle(fx: string, a?: string): Resolved<ProjDef> {
  const key = fx + '|' + (a ?? '');
  let r = pjMemo.get(key);
  if (r) return r;
  if (fx.startsWith('attack:')) {
    const who = fx.slice(7);
    const at = ATTACK[who];
    const hero = HEROES[who];
    const el: Elem = at ? 'magic' : hero ? (elemOf(who) ?? 'steel') : (elemOf(who) ?? 'steel');
    const look = at ? { ...elemLook(el), c: at[0], c2: lighten(at[0], 0.7), sh: at[1] ?? SH.SPARK } : (hero ? abilityLook(hero.abilities[0]) : elemLook(el));
    const def: ProjDef = { s: (at?.[2] ?? 12) * 1.5, trail: 3, sh: at?.[1] ?? SH.SPARK };
    r = { def, c: look.c, c2: look.c2, sh: def.sh!, dark: false, auto: !at };
  } else {
    const hand = PROJ[fx];
    const def = hand ?? autoProj(fx, a ?? ownerOf('projs', fx));
    r = finish(def, nameLook(fx, a ?? ownerOf('projs', fx)), !hand);
  }
  pjMemo.set(key, r);
  return r;
}

/** Aspecto de una zona. */
export function zoneStyle(fx: string, a?: string): Resolved<ZoneDef> {
  const key = fx + '|' + (a ?? '');
  let r = znMemo.get(key);
  if (r) return r;
  const hand = ZONE[fx];
  const def = hand ?? { n: 0.8, edge: true };
  r = finish(def, nameLook(fx, a ?? ownerOf('zones', fx)), !hand);
  znMemo.set(key, r);
  return r;
}

/** Color del destello de lanzamiento y del anillo de canalización de una habilidad. */
export function castLook(a: string | undefined): Look {
  return abilityLook(a);
}

// ---------------------------------------------------------------- color

export function hexRgb(c: string): [number, number, number] {
  const n = parseInt(c.slice(1, 7), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
export function lighten(c: string, k: number): string {
  const [r, g, b] = hexRgb(c);
  const h = (v: number) => Math.round((v + (1 - v) * k) * 255).toString(16).padStart(2, '0');
  return '#' + h(r) + h(g) + h(b);
}

// ---------------------------------------------------------------- cobertura

/** Cuántos nombres del inventario tienen entrada a mano y cuántos van por respaldo. */
export function coverage() {
  const out = { emits: { hand: 0, auto: 0, none: 0 }, mods: { hand: 0, auto: 0 }, projs: { hand: 0, auto: 0 }, zones: { hand: 0, auto: 0 }, attacks: { hand: 0, auto: 0 } };
  for (const n of Object.keys(INV.emits)) {
    if (n === 'cast') { out.emits.hand++; continue; }
    const hand = FX[n] ?? Object.keys(FX).find((k) => k.startsWith(n + '.') || k.startsWith(n + '@'));
    if (FX[n]?.k === 'none') out.emits.none++;
    else if (hand) out.emits.hand++; else out.emits.auto++;
  }
  for (const n of Object.keys(INV.mods)) STATUS[n] ? out.mods.hand++ : out.mods.auto++;
  for (const n of Object.keys(INV.projs)) {
    if (n.startsWith('attack:')) ATTACK[n.slice(7)] ? out.attacks.hand++ : out.attacks.auto++;
    else PROJ[n] ? out.projs.hand++ : out.projs.auto++;
  }
  for (const n of Object.keys(INV.zones)) ZONE[n] ? out.zones.hand++ : out.zones.auto++;
  return out;
}

export const INVENTORY = INV;
export type { Look };
export { E as elemColor, E2 as elemCore };
