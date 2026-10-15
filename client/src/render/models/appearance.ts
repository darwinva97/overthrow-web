// Tabla de apariencia de los 127 héroes para el modo 3D. Cada entrada describe un modelo
// procedural: arquetipo de silueta, escala, paleta, arma y accesorios. Los modelos de Valve no
// se usan; esto es una interpretación low-poly reconocible de cada héroe.
//
// Ojo: la clave es la interna de Dota (nevermore = Shadow Fiend, furion = Nature's Prophet,
// wisp = Io, zuus = Zeus, rattletrap = Clockwerk, shredder = Timbersaw, obsidian_destroyer =
// Outworld Destroyer, skeleton_king = Wraith King, magnataur = Magnus, necrolyte = Necrophos…).

export type Arch =
  | 'humanoid'  // bípedo corriente
  | 'giant'     // bípedo enorme: tronco ancho, brazos largos, piernas cortas
  | 'beast'     // cuadrúpedo
  | 'centaur'   // cuerpo de cuadrúpedo con torso humanoide
  | 'mounted'   // jinete sobre montura
  | 'flyer'     // criatura alada que vuela
  | 'spirit'    // torso flotante que acaba en estela, sin piernas
  | 'serpent'   // torso sobre cola de serpiente
  | 'insect'    // muchas patas
  | 'orb'       // cuerpo amorfo: esfera de energía
  | 'vehicle';  // máquina (girocóptero, carro)

export type Build = 'tiny' | 'slim' | 'normal' | 'heavy' | 'hulk';

export type Head =
  | 'human' | 'beast' | 'bull' | 'bird' | 'skull' | 'helm' | 'fish' | 'frog' | 'demon' | 'insect'
  | 'rock' | 'void' | 'troll' | 'goblin' | 'ape' | 'rodent' | 'panda' | 'reptile' | 'tree' | 'mask';

export type Weapon =
  | 'none' | 'sword' | 'greatsword' | 'katana' | 'rapier' | 'dagger' | 'daggers' | 'axe' | 'greataxe'
  | 'spear' | 'trident' | 'glaive' | 'scythe' | 'bow' | 'crossbow' | 'staff' | 'staff_orb' | 'staff_skull'
  | 'staff_crook' | 'staff_gold' | 'wand' | 'hammer' | 'warhammer' | 'mace' | 'club' | 'flail' | 'whip'
  | 'hook' | 'cleaver' | 'anchor' | 'totem' | 'shovel' | 'brush' | 'lute' | 'torch' | 'rifle' | 'pistol'
  | 'shotgun' | 'fists' | 'claws' | 'blades' | 'mech_arm' | 'saw' | 'shield' | 'book' | 'orb';

export type Acc =
  // cabeza
  | 'horns' | 'horns_ram' | 'horns_long' | 'horn_nose' | 'antlers' | 'tusks' | 'ears_long' | 'ears_beast'
  | 'hair' | 'ponytail' | 'topknot' | 'mohawk' | 'beard' | 'hood' | 'crown' | 'circlet' | 'halo' | 'helm'
  | 'helm_horned' | 'crest' | 'hat_wide' | 'hat_pointy' | 'hat_tricorn' | 'hat_top' | 'goggles' | 'mask'
  | 'mask_tall' | 'veil' | 'headdress' | 'snake_hair' | 'second_head' | 'fins' | 'frill' | 'nose_ring'
  // cuerpo
  | 'cape' | 'robe' | 'skirt' | 'loincloth' | 'coat' | 'scarf' | 'pauldrons' | 'pauldrons_spiked'
  | 'fur_collar' | 'belly' | 'spikes_back' | 'shell' | 'backpack' | 'barrel_back' | 'quiver' | 'banner'
  | 'chains' | 'rocks' | 'leaves' | 'ice' | 'flames' | 'orbs' | 'souls' | 'aura_ring' | 'wisp_pet'
  | 'goblin_rider' | 'tentacles' | 'mane' | 'saw_chest'
  // cola y alas
  | 'tail' | 'tail_fluffy' | 'tail_stinger' | 'wings_bat' | 'wings_feather' | 'wings_bug' | 'wings_fairy'
  | 'wings_demon' | 'claws_big';

export type Mount = 'horse' | 'cat' | 'lizard' | 'bat';
export type FlyerKind = 'bird' | 'dragon';
export type VehicleKind = 'copter' | 'cart';

export interface Look {
  arch: Arch;
  /** Escala relativa a un héroe medio (1). */
  scale: number;
  /** Paleta: [principal (ropa/armadura), secundario (piernas, cuero), detalle (ribetes, oro), piel]. */
  pal: [string, string, string, string];
  weapon: Weapon;
  /** Mano izquierda: escudo, segunda arma, libro… */
  off?: Weapon;
  acc: Acc[];
  build?: Build;
  head?: Head;
  hair?: string;
  /** Color de brillo: ojos, gemas, fuego, energía. */
  glow?: string;
  /** Inclinación hacia delante (0-1): encorvados como Lifestealer o Slark. */
  hunch?: number;
  /** Altura de vuelo extra. */
  hover?: number;
  mount?: Mount;
  mountCol?: string;
  flyer?: FlyerKind;
  vehicle?: VehicleKind;
  /** Patas de insecto. */
  legs?: number;
  /** Color del metal de armas y armaduras. */
  metal?: string;
  /** Brazos desnudos (color de piel) aunque la cabeza sea humana. */
  bare?: boolean;
}

const L = (arch: Arch, scale: number, pal: Look['pal'], weapon: Weapon, acc: Acc[], extra: Partial<Look> = {}): Look =>
  ({ arch, scale, pal, weapon, acc, ...extra });

export const LOOKS: Record<string, Look> = {
  abaddon: L('mounted', 1.05, ['#34465e', '#161c26', '#5fd6e8', '#a6b4c0'], 'sword', ['helm', 'cape', 'pauldrons'],
    { mount: 'horse', mountCol: '#232a36', head: 'helm', glow: '#6fe8ff', metal: '#9fc8d8' }),
  abyssal_underlord: L('giant', 1.3, ['#4a3a30', '#221a16', '#9cff4a', '#56603e'], 'greatsword', ['horns_long', 'pauldrons_spiked', 'tail'],
    { build: 'hulk', head: 'demon', glow: '#a8ff5a', metal: '#6a6a5a' }),
  alchemist: L('giant', 1.25, ['#7a5530', '#3a2a1c', '#8fe14f', '#b49a78'], 'fists', ['barrel_back', 'goblin_rider', 'belly'],
    { build: 'hulk', head: 'goblin', glow: '#9cff4a', metal: '#a08a5a' }),
  ancient_apparition: L('spirit', 1.25, ['#8ccaf0', '#3a6a9a', '#e8fbff', '#c4ecff'], 'none', ['horns_long', 'ice'],
    { head: 'skull', glow: '#aef4ff', build: 'slim' }),
  antimage: L('humanoid', 1.0, ['#5a4a82', '#2a2238', '#e0c070', '#8a7ab8'], 'blades', ['ears_long', 'topknot', 'pauldrons'],
    { build: 'slim', hair: '#ece4f4', glow: '#7fd6ff', metal: '#cfd8e8' }),
  arc_warden: L('humanoid', 1.0, ['#4a56d0', '#23234f', '#7af0ff', '#7e8ed6'], 'orb', ['crest', 'aura_ring', 'robe'],
    { build: 'slim', head: 'void', glow: '#7af0ff', hover: 8 }),
  axe: L('humanoid', 1.25, ['#3a2e2a', '#241a16', '#c8963c', '#c4462e'], 'greataxe', ['mohawk', 'pauldrons', 'beard'],
    { bare: true, build: 'heavy', hair: '#1c1414', metal: '#b8b0a8' }),
  bane: L('beast', 1.25, ['#3a2a5a', '#160f24', '#c49cff', '#4f3f70'], 'none', ['tentacles', 'horns'],
    { head: 'void', glow: '#d9a6ff' }),
  batrider: L('mounted', 1.0, ['#7a3a2a', '#3a2a2a', '#ffae42', '#6f9a72'], 'torch', ['mohawk', 'goggles'],
    { mount: 'bat', mountCol: '#4a3a40', head: 'troll', glow: '#ff8a3a', hair: '#d0402a', hover: 45 }),
  beastmaster: L('humanoid', 1.15, ['#6a4a2a', '#3a2a1a', '#c8bca4', '#c8946a'], 'axe', ['helm_horned', 'fur_collar', 'beard'],
    { bare: true, off: 'axe', build: 'heavy', hair: '#3a2a1a' }),
  bloodseeker: L('humanoid', 1.0, ['#8a2222', '#2a1a1a', '#d4b06a', '#9a5a4a'], 'daggers', ['mask', 'horns', 'loincloth'],
    { build: 'slim', glow: '#ff3030', hunch: 0.3 }),
  bounty_hunter: L('humanoid', 0.9, ['#5a4a3a', '#2a2a2a', '#d0d0d0', '#8a7a5a'], 'daggers', ['ears_beast', 'scarf', 'goggles'],
    { build: 'slim', head: 'rodent', hunch: 0.2 }),
  brewmaster: L('humanoid', 1.2, ['#b84a2a', '#2a2a2a', '#e8c070', '#f0ece0'], 'staff', ['barrel_back', 'belly'],
    { build: 'heavy', head: 'panda' }),
  bristleback: L('humanoid', 1.15, ['#7a5a3a', '#3a2a1a', '#e2d8b8', '#8a6a4a'], 'fists', ['spikes_back', 'goggles'],
    { build: 'heavy', head: 'beast', hunch: 0.35 }),
  broodmother: L('insect', 1.2, ['#2a2a3a', '#14141c', '#d03050', '#4a3050'], 'none', [],
    { legs: 8, head: 'insect', glow: '#ff4060' }),
  centaur: L('centaur', 1.35, ['#7a5a3a', '#3a2a1a', '#c4ae88', '#9a7a5a'], 'greataxe', ['horns_long', 'beard', 'tail'],
    { mountCol: '#6a4a2e', build: 'heavy', hair: '#2a1e14' }),
  chaos_knight: L('mounted', 1.1, ['#4a3a5a', '#1a1420', '#ff6a2a', '#5a4a6a'], 'flail', ['helm', 'horns', 'cape'],
    { mount: 'horse', mountCol: '#2a1a2a', head: 'helm', glow: '#ff7a2a', metal: '#5a5060' }),
  chen: L('mounted', 1.0, ['#ece4cc', '#7a6a4a', '#e0b040', '#c8a080'], 'staff_crook', ['hat_pointy', 'cape'],
    { mount: 'horse', mountCol: '#d0bc98', glow: '#ffe080' }),
  clinkz: L('humanoid', 0.95, ['#d8c8a8', '#5a3a2a', '#ff8a2a', '#d8c8a8'], 'bow', ['flames', 'quiver'],
    { build: 'slim', head: 'skull', glow: '#ff8a2a' }),
  crystal_maiden: L('humanoid', 0.95, ['#4f92d8', '#e8f0ff', '#bfe9ff', '#f0c8a8'], 'staff_orb', ['hood', 'cape', 'skirt'],
    { build: 'slim', hair: '#ecd8a0', glow: '#bfe9ff' }),
  dark_seer: L('humanoid', 1.1, ['#3a4a8a', '#1a2244', '#e0c070', '#6a8ad8'], 'staff', ['crest', 'robe', 'pauldrons'],
    { build: 'normal', head: 'void', glow: '#9fd8ff' }),
  dark_willow: L('humanoid', 0.85, ['#2e3e2e', '#141c14', '#ff9fd8', '#c8e0b0'], 'wand', ['wings_fairy', 'hair', 'wisp_pet', 'skirt'],
    { build: 'slim', hair: '#3a4a3a', glow: '#b6ff9f', hover: 22 }),
  dawnbreaker: L('humanoid', 1.2, ['#e8c070', '#4a3a6a', '#ffe8a0', '#d8a8a0'], 'warhammer', ['halo', 'pauldrons', 'hair'],
    { build: 'heavy', hair: '#f8f0d0', glow: '#ffe080', metal: '#f0d890' }),
  dazzle: L('humanoid', 1.0, ['#6a3a8a', '#2a1a3a', '#ffd040', '#5a8aa0'], 'staff_skull', ['headdress', 'mohawk', 'tusks'],
    { build: 'slim', head: 'troll', glow: '#ff9fd8', hair: '#e8e0d0' }),
  death_prophet: L('spirit', 1.1, ['#3a6a6a', '#1a2a2a', '#7affd0', '#9ad8c8'], 'none', ['hair', 'souls'],
    { build: 'slim', hair: '#2a4a4a', glow: '#7affd0' }),
  disruptor: L('mounted', 1.05, ['#4a6aa0', '#2a2a4a', '#9fd8ff', '#7a9a6a'], 'staff', ['hood', 'mohawk'],
    { mount: 'lizard', mountCol: '#5a7a5a', glow: '#9fd8ff', hair: '#d0d0d0' }),
  doom_bringer: L('humanoid', 1.35, ['#8a2a1a', '#2a1414', '#ff8a2a', '#a03020'], 'greatsword', ['horns_long', 'wings_demon', 'tail', 'flames'],
    { build: 'hulk', head: 'demon', glow: '#ff7a2a', metal: '#3a2a2a' }),
  dragon_knight: L('humanoid', 1.15, ['#8a8a96', '#3a2a2a', '#c03030', '#c89878'], 'sword', ['pauldrons', 'cape', 'crest'],
    { off: 'shield', head: 'helm', metal: '#c0c4cc' }),
  drow_ranger: L('humanoid', 1.0, ['#4a6a8a', '#2a3240', '#bfe9ff', '#8ab0d0'], 'bow', ['hood', 'cape', 'quiver'],
    { build: 'slim', hair: '#e8f0ff', glow: '#bfe9ff' }),
  earth_spirit: L('humanoid', 1.15, ['#4a8a6a', '#3a3a3a', '#e0c070', '#8aa890'], 'fists', ['pauldrons', 'topknot', 'rocks'],
    { build: 'heavy', glow: '#7affc0', hair: '#2a4a3a' }),
  earthshaker: L('humanoid', 1.25, ['#6a4a2a', '#3a2a1a', '#d8c080', '#8a5a3a'], 'totem', ['headdress', 'fur_collar'],
    { build: 'heavy', head: 'beast' }),
  elder_titan: L('giant', 1.35, ['#3a4a6a', '#1a2236', '#7ab8ff', '#6a7a9a'], 'hammer', ['beard', 'horns'],
    { build: 'hulk', glow: '#7ab8ff', hair: '#2a2a3a' }),
  ember_spirit: L('humanoid', 1.0, ['#c8402a', '#3a1a14', '#ffb040', '#e0a070'], 'katana', ['topknot', 'flames', 'scarf'],
    { bare: true, build: 'slim', hair: '#ff5a2a', glow: '#ff8a2a' }),
  enchantress: L('centaur', 1.05, ['#b8885a', '#6a4a2a', '#ff9fd8', '#f0c8a8'], 'spear', ['antlers', 'hair', 'leaves'],
    { mountCol: '#b8885a', build: 'slim', hair: '#a0602a', glow: '#ff9fd8' }),
  enigma: L('spirit', 1.2, ['#1e1838', '#0a0814', '#c49cff', '#2a2048'], 'none', ['horns_long', 'aura_ring', 'tentacles'],
    { head: 'void', glow: '#b49cff' }),
  faceless_void: L('humanoid', 1.1, ['#5a4a8a', '#2a2244', '#c0a060', '#7a6ab0'], 'mace', ['tusks', 'pauldrons'],
    { build: 'normal', head: 'insect', glow: '#c49cff' }),
  furion: L('humanoid', 1.15, ['#4a6a2a', '#2a3a1a', '#d8c080', '#7a9a6a'], 'staff', ['antlers', 'robe', 'beard', 'leaves'],
    { build: 'slim', hair: '#4a3a2a', glow: '#9fff7a' }),
  grimstroke: L('humanoid', 1.05, ['#2a2a3a', '#14141c', '#d03030', '#b8a890'], 'brush', ['hood', 'scarf', 'cape'],
    { build: 'slim', glow: '#ff5050', hunch: 0.15 }),
  gyrocopter: L('vehicle', 1.1, ['#c8963c', '#4a3a2a', '#c03030', '#c89878'], 'none', ['goggles', 'beard'],
    { vehicle: 'copter', hair: '#e07a3a', hover: 45, metal: '#a0a4ac' }),
  hoodwink: L('humanoid', 0.85, ['#6a8a4a', '#3a2a1a', '#d8a040', '#b87a4a'], 'crossbow', ['hood', 'tail_fluffy', 'ears_beast'],
    { build: 'tiny', head: 'rodent' }),
  huskar: L('humanoid', 1.05, ['#c8402a', '#3a2a1a', '#e8d8b0', '#6a9a8a'], 'spear', ['mohawk', 'headdress', 'loincloth'],
    { bare: true, build: 'slim', head: 'troll', hair: '#e8e0d0', glow: '#ffae42' }),
  invoker: L('humanoid', 1.05, ['#e0c070', '#3a2a4a', '#ff9a40', '#e0c0a0'], 'none', ['orbs', 'robe', 'cape', 'ponytail', 'pauldrons'],
    { build: 'slim', hair: '#f0f0f0', glow: '#7fd6ff' }),
  jakiro: L('flyer', 1.3, ['#5a7aa0', '#a04a2a', '#bfe9ff', '#ff8a3a'], 'none', ['second_head', 'tail'],
    { flyer: 'dragon', glow: '#ffb060', hover: 38 }),
  juggernaut: L('humanoid', 1.05, ['#c8602a', '#3a2a2a', '#e0d0a0', '#b08060'], 'katana', ['mask_tall', 'skirt', 'pauldrons'],
    { bare: true, build: 'normal', hair: '#3a2020' }),
  keeper_of_the_light: L('mounted', 1.0, ['#ece4cc', '#8a7a5a', '#ffe080', '#d8b090'], 'staff_orb', ['hat_pointy', 'beard', 'robe'],
    { mount: 'horse', mountCol: '#e8e8f0', hair: '#f0f0f0', glow: '#ffe080' }),
  kez: L('humanoid', 1.0, ['#2a3a5a', '#1a1a24', '#e04040', '#3a4a6a'], 'katana', ['scarf', 'crest', 'cape'],
    { off: 'dagger', build: 'slim', head: 'bird', glow: '#ffd040' }),
  kunkka: L('humanoid', 1.1, ['#2a4a7a', '#1a2236', '#e0c070', '#c89878'], 'sword', ['hat_tricorn', 'coat', 'beard'],
    { build: 'normal', hair: '#5a3a2a' }),
  largo: L('humanoid', 1.2, ['#5a8a3a', '#3a2a1a', '#e0a040', '#7aa84a'], 'lute', ['belly', 'scarf'],
    { build: 'heavy', head: 'frog' }),
  legion_commander: L('humanoid', 1.1, ['#a03030', '#3a2a2a', '#e0c070', '#e0b090'], 'sword', ['banner', 'pauldrons', 'crest', 'hair'],
    { build: 'normal', hair: '#c84030', head: 'helm', metal: '#d0c8b0' }),
  leshrac: L('centaur', 1.15, ['#c8b48a', '#4a3a5a', '#c49cff', '#d8c8a0'], 'none', ['horns_long', 'mane'],
    { mountCol: '#8a7a6a', build: 'slim', glow: '#d9a6ff', hair: '#5a3a6a' }),
  lich: L('humanoid', 1.05, ['#4f86b0', '#1a2a3a', '#bfe9ff', '#d8d0c0'], 'staff_orb', ['robe', 'hood', 'ice'],
    { build: 'slim', head: 'skull', glow: '#bfe9ff' }),
  life_stealer: L('humanoid', 1.05, ['#9a8a7a', '#4a2a2a', '#c03030', '#b8a090'], 'claws', ['spikes_back'],
    { build: 'slim', head: 'demon', glow: '#ff4040', hunch: 0.6 }),
  lina: L('humanoid', 0.95, ['#c83a2a', '#3a1a14', '#ffb040', '#f0c8a8'], 'none', ['hair', 'flames', 'skirt', 'circlet'],
    { build: 'slim', hair: '#ff4a1a', glow: '#ff8a2a' }),
  lion: L('humanoid', 1.0, ['#6a2a2a', '#2a1414', '#ff5050', '#b8a080'], 'staff', ['horns', 'robe', 'cape'],
    { build: 'slim', glow: '#ff5050', hunch: 0.35, head: 'demon' }),
  lone_druid: L('humanoid', 1.0, ['#5a6a3a', '#3a2a1a', '#9fff7a', '#c89878'], 'staff', ['hood', 'fur_collar', 'beard'],
    { build: 'normal', glow: '#9fff7a', hair: '#6a4a2a' }),
  luna: L('mounted', 1.0, ['#3a4a8a', '#1a1a3a', '#bfd8ff', '#c8b8d8'], 'glaive', ['helm', 'hair', 'cape'],
    { mount: 'cat', mountCol: '#2a2a4a', hair: '#e8e8ff', glow: '#bfd8ff' }),
  lycan: L('humanoid', 1.15, ['#5a5a6a', '#2a2a30', '#c0c0c8', '#8a7a6a'], 'claws', ['ears_beast', 'fur_collar', 'tail'],
    { build: 'heavy', head: 'beast', hunch: 0.25, glow: '#ffd040' }),
  magnataur: L('humanoid', 1.3, ['#5a4a3a', '#2a2a2a', '#e8e0c8', '#7a8aa0'], 'spear', ['horn_nose', 'tusks', 'fur_collar'],
    { build: 'hulk', head: 'bull' }),
  marci: L('humanoid', 0.95, ['#3a3a4a', '#1a1a24', '#e04040', '#f0c8a8'], 'fists', ['ponytail', 'scarf'],
    { bare: true, build: 'slim', hair: '#e0a070' }),
  mars: L('humanoid', 1.2, ['#c8963c', '#3a2a2a', '#c03030', '#c89878'], 'spear', ['crest', 'cape', 'pauldrons'],
    { off: 'shield', build: 'heavy', head: 'helm', metal: '#d8a850' }),
  medusa: L('serpent', 1.15, ['#3a7a6a', '#2a3a2a', '#e0c070', '#5aa08a'], 'bow', ['snake_hair'],
    { build: 'slim', glow: '#9fffc0' }),
  meepo: L('humanoid', 0.8, ['#6a5a3a', '#3a2a1a', '#a0a0a0', '#a08060'], 'shovel', ['hood', 'ears_beast', 'tail'],
    { build: 'tiny', head: 'rodent' }),
  mirana: L('mounted', 1.0, ['#c8c8e0', '#4a4a7a', '#e0c070', '#f0c8a8'], 'bow', ['hair', 'circlet', 'cape'],
    { mount: 'cat', mountCol: '#ecebf2', hair: '#4a2e5a', glow: '#bfd8ff' }),
  monkey_king: L('humanoid', 1.0, ['#c8963c', '#5a3a2a', '#e04040', '#a07a5a'], 'staff_gold', ['circlet', 'tail', 'scarf'],
    { build: 'slim', head: 'ape', hunch: 0.15 }),
  morphling: L('spirit', 1.15, ['#3a8ad8', '#1a4a8a', '#9fe0ff', '#4aa0e0'], 'fists', ['crest'],
    { build: 'normal', head: 'void', glow: '#9fe0ff' }),
  muerta: L('humanoid', 1.0, ['#2a2a3a', '#14141c', '#7affd0', '#d8c8c0'], 'pistol', ['hat_wide', 'cape', 'hair'],
    { off: 'pistol', build: 'slim', hair: '#1a1a1a', glow: '#7affd0' }),
  naga_siren: L('serpent', 1.1, ['#2a8a7a', '#1a3a3a', '#e0c070', '#5ab0a0'], 'sword', ['fins', 'hair'],
    { off: 'sword', build: 'slim', hair: '#e04a3a' }),
  necrolyte: L('humanoid', 1.05, ['#3a4a3a', '#1a1a1a', '#9fff4a', '#a0a090'], 'scythe', ['hood', 'robe'],
    { build: 'slim', glow: '#9fff4a', hunch: 0.15 }),
  nevermore: L('humanoid', 1.2, ['#2a1a1a', '#140c0c', '#ff5a2a', '#3a2424'], 'claws', ['spikes_back', 'horns', 'tail', 'souls'],
    { build: 'heavy', head: 'demon', glow: '#ff5a2a', hunch: 0.3 }),
  night_stalker: L('humanoid', 1.3, ['#4a4a6a', '#1a1a2a', '#9fd8ff', '#5a5a7c'], 'claws', ['wings_bat', 'horns', 'tail'],
    { build: 'hulk', head: 'beast', glow: '#ffd040', hunch: 0.3 }),
  nyx_assassin: L('insect', 1.05, ['#3a4a6a', '#1a2236', '#7affd0', '#5a6a8a'], 'claws', ['claws_big', 'shell'],
    { legs: 4, head: 'insect', glow: '#7affd0' }),
  obsidian_destroyer: L('humanoid', 1.2, ['#2a2a3a', '#1a1420', '#c49cff', '#5a4a6a'], 'staff', ['wings_bat', 'crest', 'tail'],
    { build: 'slim', head: 'void', glow: '#c49cff', hover: 20 }),
  ogre_magi: L('giant', 1.3, ['#8a5a2a', '#3a2a1a', '#e0c070', '#5a8ad0'], 'club', ['second_head', 'belly'],
    { build: 'hulk' }),
  omniknight: L('humanoid', 1.15, ['#d8d8e0', '#4a4a5a', '#e0c070', '#c89878'], 'hammer', ['pauldrons', 'cape', 'beard'],
    { build: 'heavy', head: 'helm', glow: '#ffe8a0', metal: '#e0e0e8', hair: '#d8d0c0' }),
  oracle: L('humanoid', 1.0, ['#c8a040', '#3a2a4a', '#ff9fd8', '#b8a080'], 'staff', ['hood', 'robe', 'hat_wide'],
    { build: 'slim', glow: '#ffd040' }),
  pangolier: L('humanoid', 0.95, ['#7a2a2a', '#3a2a1a', '#e0c070', '#a08060'], 'rapier', ['hat_wide', 'shell', 'cape'],
    { build: 'normal', head: 'beast' }),
  phantom_assassin: L('humanoid', 1.0, ['#3a3a5a', '#1a1a2a', '#8fb6ff', '#d8c0b0'], 'sword', ['veil', 'hood', 'cape'],
    { build: 'slim', glow: '#8fb6ff' }),
  phantom_lancer: L('humanoid', 1.05, ['#3a5a8a', '#1a2236', '#9fd8ff', '#c8a890'], 'spear', ['ponytail', 'pauldrons'],
    { build: 'slim', hair: '#d0d0e0' }),
  phoenix: L('flyer', 1.2, ['#ff8a2a', '#c83a1a', '#ffe080', '#ffb040'], 'none', ['crest', 'tail'],
    { flyer: 'bird', glow: '#ffb040', hover: 45 }),
  primal_beast: L('giant', 1.45, ['#6a4a3a', '#2a1a1a', '#e0d0b0', '#8a5a4a'], 'fists', ['horns_long', 'tusks', 'spikes_back', 'tail'],
    { build: 'hulk', head: 'beast', glow: '#ff6a3a' }),
  puck: L('flyer', 0.8, ['#7ad0d0', '#c49cff', '#ffe080', '#a0e0d8'], 'none', ['horns', 'tail'],
    { flyer: 'dragon', glow: '#e0b0ff', hover: 40 }),
  pudge: L('giant', 1.4, ['#6a4a3a', '#3a2a2a', '#c03030', '#9aa888'], 'hook', ['belly', 'chains'],
    { off: 'cleaver', build: 'hulk', metal: '#9a9a9a' }),
  pugna: L('humanoid', 0.85, ['#5a6a3a', '#2a2a1a', '#9fff4a', '#d8d0b0'], 'none', ['robe', 'flames'],
    { build: 'tiny', head: 'skull', glow: '#9fff4a' }),
  queenofpain: L('humanoid', 1.0, ['#5a2a5a', '#2a1a2a', '#ff5a8a', '#d8a0b0'], 'dagger', ['wings_bat', 'tail', 'horns', 'hair'],
    { build: 'slim', hair: '#3a1a3a', glow: '#ff5a8a' }),
  rattletrap: L('humanoid', 1.0, ['#a07a3a', '#4a3a2a', '#c03030', '#6a6a72'], 'mech_arm', ['backpack', 'goggles', 'pauldrons'],
    { build: 'heavy', head: 'helm', glow: '#ffae42', metal: '#b08a4a' }),
  razor: L('spirit', 1.15, ['#3a5a9a', '#1a2a4a', '#9fd8ff', '#5a7ab0'], 'whip', ['crest', 'aura_ring'],
    { build: 'normal', glow: '#9fd8ff', head: 'void' }),
  riki: L('humanoid', 0.85, ['#4a3a5a', '#2a1a2a', '#c0c0c8', '#8a6ab0'], 'daggers', ['horns', 'ears_beast', 'scarf', 'tail'],
    { build: 'tiny', hunch: 0.2 }),
  ringmaster: L('humanoid', 1.1, ['#a02a2a', '#2a1a1a', '#e0c070', '#e8e0d0'], 'whip', ['hat_top', 'coat', 'mask'],
    { build: 'slim' }),
  rubick: L('humanoid', 1.0, ['#4a8a3a', '#1a2a1a', '#e0c070', '#c8b890'], 'staff', ['mask', 'horns', 'cape', 'hood'],
    { build: 'slim', glow: '#9fff7a' }),
  sand_king: L('insect', 1.25, ['#c8963c', '#6a4a2a', '#e8c070', '#a07a3a'], 'claws', ['claws_big', 'tail_stinger'],
    { legs: 6, head: 'insect' }),
  shadow_demon: L('spirit', 1.15, ['#3a1a2a', '#1a0a14', '#ff3060', '#5a2a3a'], 'none', ['horns_long', 'spikes_back'],
    { build: 'slim', head: 'demon', glow: '#ff3060' }),
  shadow_shaman: L('humanoid', 0.95, ['#c8963c', '#3a2a1a', '#ff9a40', '#6a8ab0'], 'staff', ['headdress', 'loincloth'],
    { build: 'slim', head: 'goblin', glow: '#ffd040' }),
  shredder: L('humanoid', 1.2, ['#8a6a3a', '#4a3a2a', '#c0c0c8', '#c89878'], 'saw', ['saw_chest', 'backpack'],
    { build: 'heavy', head: 'helm', metal: '#9a9aa4', glow: '#ffae42' }),
  silencer: L('humanoid', 1.05, ['#4a3a6a', '#1a1a2a', '#e0c070', '#8a7ab0'], 'glaive', ['pauldrons', 'cape', 'hood'],
    { build: 'normal', glow: '#c49cff' }),
  skeleton_king: L('humanoid', 1.25, ['#3a6a5a', '#1a2a24', '#9fffc0', '#d8d0b0'], 'greatsword', ['crown', 'cape', 'pauldrons'],
    { build: 'heavy', head: 'skull', glow: '#9fffc0', metal: '#a8c8b8' }),
  skywrath_mage: L('humanoid', 1.05, ['#e0c070', '#4a3a6a', '#7fd6ff', '#e8e0d0'], 'staff', ['wings_feather', 'crest', 'robe'],
    { build: 'slim', head: 'bird', glow: '#7fd6ff', hover: 28 }),
  slardar: L('serpent', 1.2, ['#3a5a7a', '#1a2a3a', '#e0c070', '#4a7a9a'], 'trident', ['fins', 'spikes_back'],
    { build: 'heavy', head: 'fish' }),
  slark: L('humanoid', 0.95, ['#2a3a5a', '#141c2a', '#9fd8ff', '#3a5a7a'], 'dagger', ['fins', 'cape'],
    { build: 'slim', head: 'fish', hunch: 0.45, glow: '#9fd8ff' }),
  snapfire: L('mounted', 1.0, ['#c8963c', '#5a3a2a', '#ff8a3a', '#c89878'], 'shotgun', ['goggles', 'hair'],
    { mount: 'lizard', mountCol: '#d0743a', hair: '#e8e8e8', metal: '#8a8a90' }),
  sniper: L('humanoid', 0.85, ['#6a5a3a', '#3a2a1a', '#c8963c', '#c89878'], 'rifle', ['goggles', 'helm', 'beard', 'backpack'],
    { build: 'tiny', hair: '#a0703a', metal: '#7a7a82' }),
  spectre: L('spirit', 1.2, ['#4a3a7a', '#1a142a', '#c49cff', '#6a5aa0'], 'blades', ['hood', 'spikes_back'],
    { build: 'slim', glow: '#c49cff' }),
  spirit_breaker: L('humanoid', 1.25, ['#3a4a7a', '#1a2236', '#9fd8ff', '#5a6a9a'], 'mace', ['horns', 'nose_ring', 'fur_collar'],
    { build: 'hulk', head: 'bull', glow: '#9fd8ff', hunch: 0.25 }),
  storm_spirit: L('humanoid', 1.05, ['#3a6ad0', '#1a2a5a', '#bfe9ff', '#5a8ae0'], 'fists', ['beard', 'belly', 'aura_ring'],
    { build: 'heavy', head: 'panda', glow: '#bfe9ff', hair: '#bfe9ff', hover: 10 }),
  sven: L('humanoid', 1.2, ['#3a4a6a', '#1a1a24', '#c0c0c8', '#c89878'], 'greatsword', ['pauldrons', 'cape', 'horns'],
    { build: 'heavy', head: 'helm', metal: '#c8ccd4' }),
  techies: L('vehicle', 1.0, ['#8a6a3a', '#4a3a2a', '#c03030', '#7aa84a'], 'none', ['goggles'],
    { vehicle: 'cart', metal: '#8a8a90' }),
  templar_assassin: L('humanoid', 1.0, ['#5a3a7a', '#2a1a3a', '#c49cff', '#d8b8a0'], 'claws', ['veil', 'hood', 'pauldrons'],
    { build: 'slim', glow: '#d9a6ff' }),
  terrorblade: L('humanoid', 1.2, ['#3a5a6a', '#1a2a2a', '#7affd0', '#4a6a7a'], 'sword', ['horns_long', 'wings_demon', 'tail'],
    { off: 'sword', build: 'normal', head: 'demon', glow: '#7affd0' }),
  tidehunter: L('giant', 1.4, ['#3a6a5a', '#1a3a2a', '#c8963c', '#5a9a7a'], 'anchor', ['belly', 'fins'],
    { build: 'hulk', head: 'fish', metal: '#7a6a5a' }),
  tinker: L('humanoid', 1.0, ['#a07a3a', '#3a3a44', '#9fd8ff', '#c89878'], 'mech_arm', ['backpack', 'goggles'],
    { build: 'heavy', glow: '#9fd8ff', hair: '#e0e0e0', metal: '#8a8e98' }),
  tiny: L('giant', 1.35, ['#7a7a72', '#4a4a44', '#a0a090', '#8a8a80'], 'fists', ['rocks'],
    { build: 'hulk', head: 'rock', glow: '#7af0ff' }),
  treant: L('giant', 1.55, ['#5a4a2a', '#3a2a1a', '#5a8a3a', '#6a5a3a'], 'fists', ['leaves', 'antlers'],
    { build: 'hulk', head: 'tree', glow: '#d0ff7a' }),
  troll_warlord: L('humanoid', 1.1, ['#8a3a2a', '#3a2a1a', '#e0d0a0', '#5a8a8a'], 'axe', ['mohawk', 'tusks', 'loincloth'],
    { bare: true, off: 'axe', build: 'normal', head: 'troll', hair: '#e8e0d0' }),
  tusk: L('humanoid', 1.15, ['#3a5a8a', '#1a2a3a', '#e8e8f0', '#a08a7a'], 'fists', ['tusks', 'fur_collar', 'helm_horned'],
    { build: 'heavy', head: 'beast' }),
  undying: L('humanoid', 1.25, ['#5a6a5a', '#2a2a2a', '#9fff7a', '#7a8a72'], 'fists', ['chains', 'spikes_back'],
    { build: 'heavy', head: 'skull', glow: '#9fff7a', hunch: 0.4 }),
  ursa: L('humanoid', 1.2, ['#6a4a2a', '#3a2a1a', '#c0c0c8', '#7a5a3a'], 'claws', ['ears_beast', 'fur_collar'],
    { build: 'heavy', head: 'beast', hunch: 0.25 }),
  vengefulspirit: L('humanoid', 1.0, ['#4a5ab0', '#1a2250', '#c49cff', '#7a8ad0'], 'none', ['wings_feather', 'crest', 'tail'],
    { build: 'slim', head: 'bird', glow: '#bfd8ff' }),
  venomancer: L('humanoid', 1.05, ['#5a8a2a', '#2a3a1a', '#e0e040', '#7aa83a'], 'claws', ['tail', 'frill', 'spikes_back'],
    { build: 'slim', head: 'reptile', hunch: 0.35, glow: '#e0ff40' }),
  viper: L('flyer', 1.2, ['#4a8a3a', '#2a3a1a', '#c8e040', '#6aa04a'], 'none', ['tail', 'horns'],
    { flyer: 'dragon', glow: '#c8ff40', hover: 38 }),
  visage: L('flyer', 1.2, ['#6a7a7a', '#3a4a4a', '#9fd8ff', '#8a9a9a'], 'none', ['horns', 'tail'],
    { flyer: 'dragon', glow: '#9fd8ff', hover: 38 }),
  void_spirit: L('humanoid', 1.05, ['#5a3a9a', '#1a1a3a', '#c49cff', '#7a6ad0'], 'staff', ['hood', 'scarf', 'aura_ring'],
    { build: 'normal', glow: '#c49cff' }),
  warlock: L('humanoid', 1.05, ['#7a2a2a', '#2a1a1a', '#e0c070', '#c89878'], 'staff', ['robe', 'beard', 'hood'],
    { off: 'book', build: 'normal', hair: '#d8d8d8', glow: '#ff9a40' }),
  weaver: L('insect', 1.05, ['#5a8a6a', '#2a3a2a', '#e0e080', '#7ab08a'], 'none', ['wings_bug'],
    { legs: 6, head: 'insect', glow: '#e0ff80' }),
  windrunner: L('humanoid', 1.0, ['#4a7a3a', '#3a2a1a', '#e0c070', '#f0c8a8'], 'bow', ['ponytail', 'cape', 'quiver'],
    { build: 'slim', hair: '#d0602a' }),
  winter_wyvern: L('flyer', 1.3, ['#7ab8e0', '#3a5a8a', '#e8f8ff', '#a0d0f0'], 'none', ['horns', 'tail', 'ice'],
    { flyer: 'dragon', glow: '#bfe9ff', hover: 38 }),
  wisp: L('orb', 1.0, ['#8fd8f0', '#5fb0e0', '#e8fbff', '#bfe9ff'], 'none', [],
    { glow: '#bfefff', hover: 40 }),
  witch_doctor: L('humanoid', 1.0, ['#6a8a3a', '#3a2a1a', '#e0d0a0', '#5a7a6a'], 'staff_skull', ['mask', 'headdress', 'loincloth'],
    { build: 'slim', head: 'troll', hunch: 0.3, glow: '#9fff7a' }),
  zuus: L('humanoid', 1.05, ['#e8e8f0', '#4a5a8a', '#9fd8ff', '#e0c0a0'], 'none', ['beard', 'robe', 'hair', 'circlet'],
    { build: 'normal', hair: '#f4f4f4', glow: '#bfe9ff' }),
};

/** Apariencia de un héroe; los que falten salen como humanoide genérico. */
export function lookOf(hero: string): Look {
  return LOOKS[hero] ?? L('humanoid', 1, ['#7a7a8a', '#3a3a44', '#d0b060', '#c89878'], 'sword', []);
}

/** Héroes con algún accesorio propio (para el informe y la galería). */
export const withAccessories = () => Object.values(LOOKS).filter((l) => l.acc.length > 0 || !!l.off).length;
