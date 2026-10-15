// Paletas por "elemento" y deducción del aspecto de una habilidad a partir de sus metadatos.
// Lo usa el catálogo para todo lo que no tiene una entrada escrita a mano.
import { ABILITIES, HEROES, ITEMS } from '../../../../shared/data';
import { SH, type Shape } from './atlas';

export interface Look {
  /** Color principal y color de núcleo (más claro). */
  c: string; c2: string;
  /** Forma de las partículas. */
  sh: Shape;
  /** Polvo o humo con mezcla normal en vez de brillo aditivo. */
  dark?: boolean;
  el: Elem;
}

export type Elem =
  | 'fire' | 'ice' | 'poison' | 'shadow' | 'lightning' | 'holy' | 'blood' | 'earth' | 'water' | 'wind'
  | 'nature' | 'time' | 'arcane' | 'gold' | 'void' | 'steel' | 'pure' | 'magic' | 'heal' | 'mist'
  | 'ink' | 'psi' | 'moon' | 'sand' | 'demon' | 'spectral' | 'chaos' | 'sun' | 'mana' | 'bone';

export const ELEM: Record<Elem, Omit<Look, 'el'>> = {
  fire: { c: '#ff5a14', c2: '#ffd36a', sh: SH.FLAME },
  sun: { c: '#ffa21a', c2: '#fff1b0', sh: SH.FLAME },
  ice: { c: '#5cc8ff', c2: '#eafcff', sh: SH.SNOW },
  poison: { c: '#5fd12a', c2: '#e2ff86', sh: SH.DROP },
  shadow: { c: '#8a3cff', c2: '#e2c0ff', sh: SH.SMOKE },
  void: { c: '#4a1d8a', c2: '#b688ff', sh: SH.SMOKE, dark: true },
  lightning: { c: '#4fa8ff', c2: '#ffffff', sh: SH.SPARK },
  holy: { c: '#ffd25a', c2: '#fffbe2', sh: SH.STAR },
  blood: { c: '#d0101c', c2: '#ff8070', sh: SH.DROP },
  earth: { c: '#b07a3e', c2: '#f2d7a2', sh: SH.SHARD, dark: true },
  sand: { c: '#d8b25a', c2: '#fff0c0', sh: SH.SMOKE, dark: true },
  water: { c: '#1e9ee8', c2: '#c8f4ff', sh: SH.DROP },
  wind: { c: '#a8f0d8', c2: '#ffffff', sh: SH.SWIRL },
  nature: { c: '#4cc83a', c2: '#d8ffb0', sh: SH.LEAF },
  time: { c: '#a07cff', c2: '#ffe8a8', sh: SH.RING },
  arcane: { c: '#7062ff', c2: '#dcd6ff', sh: SH.GLOW },
  mana: { c: '#3d7bff', c2: '#cfe0ff', sh: SH.SPARK },
  gold: { c: '#ffbf2a', c2: '#fff2b8', sh: SH.STAR },
  steel: { c: '#ff6030', c2: '#ffe2c8', sh: SH.SPARK },
  pure: { c: '#ffe07a', c2: '#ffffff', sh: SH.STAR },
  magic: { c: '#4f86ff', c2: '#dce8ff', sh: SH.GLOW },
  heal: { c: '#58f07a', c2: '#eaffea', sh: SH.GLOW },
  mist: { c: '#3fd2c4', c2: '#d8fff8', sh: SH.SMOKE },
  ink: { c: '#2a3c8a', c2: '#9ab4ff', sh: SH.SMOKE, dark: true },
  psi: { c: '#e05cff', c2: '#ffd8ff', sh: SH.SPARK },
  moon: { c: '#8fb8ff', c2: '#f4f8ff', sh: SH.STAR },
  demon: { c: '#e0281a', c2: '#ffb070', sh: SH.FLAME },
  spectral: { c: '#7a4cd8', c2: '#d4c0ff', sh: SH.SMOKE },
  chaos: { c: '#d02a6a', c2: '#ffb0d0', sh: SH.SPARK },
  bone: { c: '#d8d0b8', c2: '#ffffff', sh: SH.SHARD },
};

/** Palabras clave → elemento, por orden de prioridad. */
const KEYWORDS: [RegExp, Elem][] = [
  [/sun_?ray|sun_?strike|solar|supernova|dawn|luminos|celestial|starbreaker|sunder_none/, 'sun'],
  [/fire|flame|burn|lava|magma|ember|inferno|fiery|napalm|blaze|meteor|ignite|scorch|macropyre|cinder|firefly|hellfire|heat|dragon_slave|dragon_form|breathe|lsa|laguna|fireball|firespit|firestorm|immolat|radiance|remnant_explode|blast_off|cookie|mortimer|flamebreak|incinerat/, 'fire'],
  [/ice|frost|cold|freez|snow|winter|chill|glacier|crystal|arctic|splinter|chain_frost|wyvern|blizzard|frozen|tusk|shiva/, 'ice'],
  [/poison|venom|toxi|plague|acid|nether_?toxin|viper|ooze|goo|caustic|blight|noxious|gale_?venom|nethertoxin|decrepify|maledict|corrosive|disease|spit/, 'poison'],
  [/blood|bleed|rupture|rage|berserk|sadist|gore|life_break|culling|sanguine|wound|dismember|vampir|satanic/, 'blood'],
  [/lightning|thunder|static|storm_|spark|ball_lightning|arc_|electric|plasma|emp\b|emp_|zap|ion_|overload|jolt|shock|tazer|volt|charge_of|kinetic/, 'lightning'],
  [/holy|divine|heal|purif|guardian|angel|grace|repel|penitence|persua|hand_of_god|mekansm|guardian|aegis|martyr|god|light_|illuminat|blinding/, 'holy'],
  [/time|chrono|backtrack|faceless|dilation|time_|rewind|lapse/, 'time'],
  [/earth|stone|rock|boulder|fissure|quake|avalanche|split_earth|stomp|tremor|petrify|magnetiz|epicenter|burrow|impale|toss|smash|slam|crush|grip|upheaval|rubble|pulveriz|rolling/, 'earth'],
  [/sand|dust|scorpion|desert/, 'sand'],
  [/water|tide|wave|torrent|kraken|splash|rip_tide|gush|anchor|bubble|aqua|siren|tidal|ghostship|puddle|drown/, 'water'],
  [/wind|gale|tornado|cyclone|whirl|tailwind|windrun|hurricane|air|twister|vortex|spin/, 'wind'],
  [/nature|tree|sprout|vine|entangle|leech|bramble|grow|overgrowth|treant|seed|bloom|forest|wrath_of|grasp|living_armor|root/, 'nature'],
  [/gold|midas|greed|bounty|coin|treasure|track/, 'gold'],
  [/mana|arcane_boots|essence|astral|mystic|spell|counterspell|manaburn|mana_void|ancient_seal|concussive|arcane/, 'mana'],
  [/void|black_hole|darkness|nightmare|abyss|dark_portal|midnight|nihil|malefice|demonic_conv|sanity|eclipse/, 'void'],
  [/shadow|dark|death|soul|necro|fear|terror|doom|curse|grave|reaper|requiem|exorcism|haunt|scythe|wraith|ghost|spirit_siphon|crypt|silence|hex|voodoo|fatal|chaotic|edict|ink/, 'shadow'],
  [/chaos|reality|phantasm/, 'chaos'],
  [/psi|psionic|refraction|meld|trap|dream|illusory|waning|phase/, 'psi'],
  [/moon|lunar|eclipse|glaive|starfall|starstorm|moonlight|sacred_arrow|arrow/, 'moon'],
  [/bone|skeleton|tomb|skull|decay|soul_rip/, 'bone'],
];

/** Elemento característico de cada héroe (el color de su kit). */
export const HERO_ELEM: Record<string, Elem> = {
  abaddon: 'mist', abyssal_underlord: 'demon', alchemist: 'poison', ancient_apparition: 'ice', antimage: 'mana',
  arc_warden: 'lightning', axe: 'blood', bane: 'void', batrider: 'fire', beastmaster: 'earth', bloodseeker: 'blood',
  bounty_hunter: 'gold', brewmaster: 'fire', bristleback: 'poison', broodmother: 'poison', centaur: 'earth',
  chaos_knight: 'chaos', chen: 'holy', clinkz: 'fire', crystal_maiden: 'ice', dark_seer: 'psi', dark_willow: 'psi',
  dawnbreaker: 'sun', dazzle: 'shadow', death_prophet: 'spectral', disruptor: 'lightning', doom_bringer: 'demon',
  dragon_knight: 'fire', drow_ranger: 'ice', earth_spirit: 'nature', earthshaker: 'earth', elder_titan: 'moon',
  ember_spirit: 'fire', enchantress: 'nature', enigma: 'void', faceless_void: 'time', furion: 'nature',
  grimstroke: 'ink', gyrocopter: 'fire', hoodwink: 'nature', huskar: 'fire', invoker: 'arcane', jakiro: 'fire',
  juggernaut: 'steel', keeper_of_the_light: 'holy', kez: 'steel', kunkka: 'water', largo: 'water',
  legion_commander: 'gold', leshrac: 'lightning', lich: 'ice', life_stealer: 'blood', lina: 'fire', lion: 'demon',
  lone_druid: 'nature', luna: 'moon', lycan: 'blood', magnataur: 'ice', marci: 'psi', mars: 'gold', medusa: 'water',
  meepo: 'earth', mirana: 'moon', monkey_king: 'gold', morphling: 'water', muerta: 'spectral', naga_siren: 'water',
  necrolyte: 'poison', nevermore: 'demon', night_stalker: 'void', nyx_assassin: 'mana', obsidian_destroyer: 'arcane',
  ogre_magi: 'fire', omniknight: 'holy', oracle: 'sun', pangolier: 'steel', phantom_assassin: 'steel',
  phantom_lancer: 'moon', phoenix: 'sun', primal_beast: 'earth', puck: 'psi', pudge: 'blood', pugna: 'poison',
  queenofpain: 'shadow', rattletrap: 'steel', razor: 'lightning', riki: 'shadow', ringmaster: 'chaos',
  rubick: 'nature', sand_king: 'sand', shadow_demon: 'demon', shadow_shaman: 'lightning', shredder: 'steel',
  silencer: 'mana', skeleton_king: 'mist', skywrath_mage: 'mana', slardar: 'water', slark: 'void', snapfire: 'fire',
  sniper: 'steel', spectre: 'spectral', spirit_breaker: 'void', storm_spirit: 'lightning', sven: 'mana',
  techies: 'fire', templar_assassin: 'psi', terrorblade: 'demon', tidehunter: 'water', tinker: 'lightning',
  tiny: 'earth', treant: 'nature', troll_warlord: 'blood', tusk: 'ice', undying: 'bone', ursa: 'blood',
  vengefulspirit: 'spectral', venomancer: 'poison', viper: 'poison', visage: 'spectral', void_spirit: 'arcane',
  warlock: 'demon', weaver: 'time', windrunner: 'wind', winter_wyvern: 'ice', wisp: 'moon', witch_doctor: 'poison',
  zuus: 'lightning',
};

/** Items activos con aspecto propio. */
const ITEM_ELEM: Record<string, Elem> = {
  blink: 'mana', overwhelming_blink: 'blood', swift_blink: 'wind', arcane_blink: 'arcane', dagon: 'blood', dagon_2: 'blood',
  dagon_3: 'blood', dagon_4: 'blood', dagon_5: 'blood', black_king_bar: 'gold', mekansm: 'heal', guardian_greaves: 'heal',
  pipe: 'mana', crimson_guard: 'steel', shivas_guard: 'ice', radiance: 'fire', cyclone: 'wind', wind_waker: 'wind',
  sheepstick: 'nature', orchid: 'shadow', bloodthorn: 'blood', ethereal_blade: 'heal', rod_of_atos: 'arcane',
  gungir: 'lightning', mjollnir: 'lightning', maelstrom: 'lightning', satanic: 'blood', armlet: 'blood',
  lotus_orb: 'psi', sphere: 'mana', refresher: 'heal', hand_of_midas: 'gold', urn_of_shadows: 'shadow',
  spirit_vessel: 'shadow', bottle: 'mana', meteor_hammer: 'fire', heavens_halberd: 'steel', abyssal_blade: 'void',
  nullifier: 'chaos', silver_edge: 'shadow', invis_sword: 'shadow', glimmer_cape: 'arcane', solar_crest: 'sun',
  phylactery: 'mana', angels_demise: 'mana', blade_mail: 'steel', manta: 'mana', diffusal_blade: 'mana',
  disperser: 'mana', force_staff: 'wind', hurricane_pike: 'wind', arcane_boots: 'mana', tpscroll: 'mana',
  travel_boots: 'mana', ghost: 'heal', harpoon: 'steel', eternal_shroud: 'mana', bloodstone: 'blood',
  aeon_disk: 'gold', soul_ring: 'blood', magic_wand: 'nature', magic_stick: 'nature', faerie_fire: 'holy',
  flask: 'heal', clarity: 'mana', tango: 'nature', smoke_of_deceit: 'shadow', dust: 'gold', ward_dispenser: 'gold',
};

const memo = new Map<string, Look>();
const mk = (el: Elem): Look => ({ ...ELEM[el], el });

/** Elemento por palabras clave en un texto (nombre de efecto, de habilidad…). */
export function elemOf(text: string): Elem | null {
  const t = text.toLowerCase();
  for (const [re, el] of KEYWORDS) if (re.test(t)) return el;
  return null;
}

const DMG_ELEM: Record<string, Elem> = { physical: 'steel', magical: 'magic', pure: 'pure' };

/** Héroe al que pertenece una habilidad (por el prefijo de la clave). */
export function heroOfAbility(a: string): string | null {
  if (HEROES[a]) return a;
  let best: string | null = null;
  for (const h in HEROES) if (a.startsWith(h + '_') && (!best || h.length > best.length)) best = h;
  return best;
}

/** Aspecto de una habilidad o item: nombre → héroe → descripción → tipo de daño. */
export function abilityLook(a: string | undefined | null): Look {
  if (!a) return mk('magic');
  const hit = memo.get(a);
  if (hit) return hit;
  let el: Elem | null = null;
  const item = ITEMS[a];
  if (item) el = ITEM_ELEM[a] ?? elemOf(a) ?? 'arcane';
  else {
    const d = ABILITIES[a];
    const hero = heroOfAbility(a);
    const short = hero ? a.slice(hero.length + 1) : a;
    el = elemOf(short) ?? elemOf(d?.name ?? '') ?? (hero ? HERO_ELEM[hero] ?? null : null) ?? elemOf(d?.desc ?? '');
    if (!el && d) el = d.targetTeam === 'friendly' || d.targetTeam === 'ally' ? 'heal' : DMG_ELEM[d.dmgType ?? ''] ?? 'magic';
    el ??= 'magic';
  }
  const look = mk(el);
  memo.set(a, look);
  return look;
}

/** Aspecto de un nombre de efecto: sus palabras clave mandan; si no, la habilidad que lo emite. */
export function nameLook(name: string, a?: string | null): Look {
  const key = name + '|' + (a ?? '');
  const hit = memo.get(key);
  if (hit) return hit;
  const el = elemOf(name);
  const look = el ? mk(el) : abilityLook(a);
  memo.set(key, look);
  return look;
}

export const elemLook = mk;
