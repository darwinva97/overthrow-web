// Registro de modelos: decide qué modelo lleva cada unidad (héroe, creep, invocación, ward…) y
// los guarda en caché, así cada geometría se construye una sola vez por tipo.
import { lookOf, type Look } from './appearance';
import { centaur, flyer, floating, humanoid, insect, mounted, orb, quad, vehicle, type BeastKind } from './bodies';
import { Builder, type AnimSpec, type ModelDef, type V3 } from './builder';
import { BONE, DARK, GOLD, shade, strikeOf } from './parts';

const cache = new Map<string, ModelDef>();

/** Escala de mundo de un modelo de escala 1 (el humanoide canónico mide ~100). */
export const WORLD_SCALE = 1.4;

function fromLook(key: string, look: Look, shadow: boolean): ModelDef {
  const b = new Builder(key);
  let top = 100;
  const anim: AnimSpec = { biped: 'walk', strike: strikeOf(look.weapon), hover: look.hover };
  switch (look.arch) {
    case 'humanoid': case 'giant': top = humanoid(b, look, { legs: 'walk' }).top; break;
    case 'spirit': top = floating(b, look, 'wisp'); anim.biped = 'float'; anim.tail = 'sway'; anim.hover = (look.hover ?? 0) + 10; break;
    case 'serpent': top = floating(b, look, 'snake'); anim.biped = 'float'; anim.tail = 'snake'; break;
    case 'centaur': {
      const kind: BeastKind = look.acc.includes('antlers') ? 'deer' : 'horse';
      top = centaur(b, look, kind); anim.biped = 'float'; anim.quad = 'm';
      break;
    }
    case 'mounted':
      top = mounted(b, look); anim.biped = 'seated';
      if (look.mount === 'bat') { anim.wings = 'flap'; anim.hover = look.hover ?? 45; } else anim.quad = 'm';
      break;
    case 'beast': {
      const q = quad(b, '', { kind: look.head === 'void' ? 'void' : 'wolf', col: look.pal[0], belly: look.pal[3], glow: look.glow, k: 1.1 });
      top = q.top;
      if (look.acc.includes('tentacles')) for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        b.horn('body', shade(look.pal[1], 1.4), [[Math.cos(a) * 10, q.legH + 14, Math.sin(a) * 10], [Math.cos(a) * 22 - 6, q.legH + 30, Math.sin(a) * 24], [Math.cos(a) * 30 - 16, q.legH + 40, Math.sin(a) * 30]], 3);
      }
      if (look.acc.includes('horns')) for (const s of [-1, 1]) b.horn('head', BONE, [[46, q.legH + 22, s * 6], [44, q.legH + 34, s * 12], [36, q.legH + 42, s * 14]], 3);
      anim.biped = 'none'; anim.quad = ''; anim.strike = 'bite';
      break;
    }
    case 'flyer': top = flyer(b, look); anim.biped = 'none'; anim.wings = look.scale < 0.9 ? 'buzz' : 'flap'; anim.tail = 'wag'; anim.strike = 'bite'; anim.hover = look.hover ?? 50; break;
    case 'insect': top = insect(b, look); anim.biped = 'none'; anim.insect = look.legs ?? 6; anim.strike = look.acc.includes('claws_big') ? 'claw' : 'bite'; if (look.acc.includes('wings_bug')) anim.wings = 'buzz'; if (look.acc.includes('tail_stinger')) anim.tail = 'wag'; break;
    case 'orb': top = orb(b, look); anim.biped = 'none'; anim.blob = true; anim.spin = 1.6; anim.hover = look.hover ?? 30; anim.strike = 'none'; break;
    case 'vehicle':
      top = vehicle(b, look); anim.biped = 'none';
      if (look.vehicle === 'copter') { anim.spin = 28; anim.hover = look.hover ?? 60; anim.strike = 'gun'; } else { anim.wheels = true; anim.strike = 'none'; }
      break;
  }
  if (b.has('spin') && !anim.spin) anim.spin = 1.4;
  return b.finish(anim, top, look.scale * WORLD_SCALE, shadow);
}

/** Modelo de un héroe (también ilusiones, clones de Meepo, Tempest Double…). */
export function heroModel(hero: string): ModelDef {
  const key = 'hero:' + hero;
  let m = cache.get(key);
  if (!m) { m = fromLook(key, lookOf(hero), true); cache.set(key, m); }
  return m;
}

// ---------------------------------------------------------------------------
// Creeps e invocaciones

const C = (arch: Look['arch'], scale: number, pal: Look['pal'], weapon: Look['weapon'], acc: Look['acc'], extra: Partial<Look> = {}): Look =>
  ({ arch, scale, pal, weapon, acc, ...extra });

interface CreepSpec { look?: Look; beast?: { kind: BeastKind; col: string; belly?: string; glow?: string; k: number; mane?: string; acc?: 'armor' | 'horns' } }

const SPECS: [RegExp, CreepSpec][] = [
  [/kobold_king/, { look: C('humanoid', 1.55, ['#7a5434', '#4a3424', '#f6cf7c', '#9a7454'], 'mace', ['crown', 'cape', 'tail'], { build: 'normal', head: 'rodent', glow: '#ff6040', metal: '#d8c070' }) }],
  [/kobold_taskmaster/, { look: C('humanoid', 0.85, ['#6a4a2e', '#3a2a1a', '#d0a040', '#9a7454'], 'whip', ['helm', 'tail'], { build: 'tiny', head: 'rodent' }) }],
  [/kobold/, { look: C('humanoid', 0.72, ['#7a5434', '#4a3424', '#c0a060', '#9a7454'], 'club', ['tail'], { build: 'tiny', head: 'rodent' }) }],
  [/alpha_wolf/, { beast: { kind: 'wolf', col: '#4a4650', belly: '#8a8690', glow: '#ff5030', k: 1.15 } }],
  [/lycan_wolf/, { beast: { kind: 'wolf', col: '#3a3a44', belly: '#6a6a74', glow: '#ffd040', k: 1.0 } }],
  [/wolf/, { beast: { kind: 'wolf', col: '#7a7680', belly: '#b8b4bc', k: 0.95 } }],
  [/satyr_hellcaller/, { look: C('humanoid', 1.2, ['#5a3a6a', '#3a2a2a', '#ff6a3a', '#7a5a8a'], 'claws', ['horns_ram', 'loincloth'], { build: 'heavy', head: 'beast', glow: '#ff6a3a' }) }],
  [/satyr_soulstealer/, { look: C('humanoid', 0.95, ['#4a3a6a', '#3a2a2a', '#7fd6ff', '#6a5a8a'], 'staff', ['horns_ram', 'loincloth'], { build: 'slim', head: 'beast', glow: '#7fd6ff' }) }],
  [/satyr/, { look: C('humanoid', 0.82, ['#6a4a7a', '#3a2a2a', '#b0ff70', '#8a6a9a'], 'wand', ['horns', 'loincloth'], { build: 'slim', head: 'beast', glow: '#b0ff70' }) }],
  [/centaur_khan/, { look: C('centaur', 1.25, ['#7a5a3a', '#4a3020', '#c8a060', '#9a7a5a'], 'club', ['horns_long', 'beard'], { mountCol: '#5a3e26', build: 'heavy', hair: '#2a1e14' }) }],
  [/centaur/, { look: C('centaur', 0.95, ['#8a6a4a', '#5a4030', '#c8a060', '#a08060'], 'spear', ['mohawk'], { mountCol: '#7a5a3a', build: 'slim', hair: '#2a1e14' }) }],
  [/ogre_magi/, { look: C('giant', 1.05, ['#3a5aa0', '#3a2a1a', '#e0c070', '#6a8ad0'], 'staff', ['belly'], { build: 'hulk' }) }],
  [/ogre/, { look: C('giant', 1.1, ['#7a6a4a', '#3a2a1a', '#a0a0a0', '#8aa0c0'], 'club', ['belly'], { build: 'hulk' }) }],
  [/frostbitten_golem|ice_shaman/, { look: C('giant', 1.0, ['#8ab0d0', '#4a6a8a', '#e8f8ff', '#a0c8e0'], 'fists', ['ice'], { build: 'hulk', head: 'rock', glow: '#bfe9ff' }) }],
  [/warlock_golem/, { look: C('giant', 1.5, ['#3a2a2a', '#1a1414', '#ff6a1a', '#4a3434'], 'fists', ['flames', 'rocks'], { build: 'hulk', head: 'rock', glow: '#ff7a2a' }) }],
  [/mud_golem/, { look: C('giant', 0.95, ['#6a5a3a', '#3a2e1e', '#a08a5a', '#7a6a4a'], 'fists', ['rocks'], { build: 'hulk', head: 'rock', glow: '#e0c060' }) }],
  [/golem/, { look: C('giant', 1.1, ['#6a6a72', '#3a3a44', '#a0a0a8', '#7a7a82'], 'fists', ['rocks'], { build: 'hulk', head: 'rock', glow: '#7af0ff' }) }],
  [/troll_warlord_skeleton|skeleton_warrior|wraith_king_skeleton/, { look: C('humanoid', 0.85, ['#c8c0a8', '#5a5040', '#9fffc0', '#d8d0b8'], 'sword', [], { build: 'slim', head: 'skull', glow: '#9fffc0' }) }],
  [/skeleton_archer/, { look: C('humanoid', 0.85, ['#c8b898', '#5a3a2a', '#ff8a2a', '#d8c8a8'], 'bow', ['flames'], { build: 'slim', head: 'skull', glow: '#ff8a2a' }) }],
  [/dark_troll_warlord|dark_troll/, { look: C('humanoid', 0.95, ['#3a4a3a', '#2a2a1a', '#c0a060', '#5a6a5a'], 'axe', ['mohawk', 'loincloth'], { build: 'normal', head: 'troll', hair: '#d0d0c0' }) }],
  [/forest_troll_high_priest/, { look: C('humanoid', 0.9, ['#5a7a3a', '#3a2a1a', '#ffd040', '#6a9a6a'], 'staff', ['headdress'], { build: 'slim', head: 'troll' }) }],
  [/troll/, { look: C('humanoid', 0.9, ['#6a3a2a', '#3a2a1a', '#e0d0a0', '#6a9a6a'], 'axe', ['mohawk'], { build: 'slim', head: 'troll', hair: '#e8e0d0' }) }],
  [/harpy/, { look: C('flyer', 0.7, ['#6a4a7a', '#3a2a4a', '#c49cff', '#8a6a9a'], 'none', ['tail'], { flyer: 'dragon', hover: 50, glow: '#c49cff' }) }],
  [/black_dragon|black_drake/, { look: C('flyer', 1.0, ['#2a2a30', '#14141a', '#ff6a2a', '#3a3a44'], 'none', ['horns', 'tail'], { flyer: 'dragon', hover: 50, glow: '#ff6a2a' }) }],
  [/wildkin/, { look: C('humanoid', 0.95, ['#8a7a5a', '#5a4a3a', '#e0c070', '#a08a6a'], 'none', ['wings_feather'], { build: 'heavy', head: 'bird' }) }],
  [/gnoll/, { look: C('humanoid', 0.8, ['#7a5a3a', '#4a3a2a', '#c0c0c0', '#9a7a5a'], 'dagger', ['ears_beast'], { build: 'slim', head: 'beast', hunch: 0.3 }) }],
  [/ghost/, { look: C('spirit', 0.9, ['#9ab8c8', '#5a7a8a', '#e8f8ff', '#b8d8e8'], 'none', [], { build: 'slim', head: 'skull', glow: '#e8f8ff' }) }],
  [/thunder_lizard|jungle_stalker|prowler/, { beast: { kind: 'lizard', col: '#5a7a5a', belly: '#a0b890', glow: '#e0e040', k: 1.0 } }],
  [/furbolg/, { look: C('humanoid', 1.1, ['#e0e0e8', '#8a8a96', '#7fd6ff', '#d0d0d8'], 'claws', ['ears_beast'], { build: 'heavy', head: 'beast' }) }],
  [/fel_beast/, { beast: { kind: 'void', col: '#3a4a3a', glow: '#9fff4a', k: 0.85 } }],
  [/frog|frogling|tadpole/, { beast: { kind: 'frog', col: '#5a8a3a', belly: '#d0d890', k: 0.9 } }],
  [/spiderite/, { look: C('insect', 0.5, ['#2a2a3a', '#14141c', '#d03050', '#4a3050'], 'none', [], { legs: 8, head: 'insect', glow: '#ff4060' }) }],
  [/spider/, { look: C('insect', 0.65, ['#2a2a3a', '#14141c', '#d03050', '#4a3050'], 'none', [], { legs: 8, head: 'insect', glow: '#ff4060' }) }],
  [/treant_large|tree_fey/, { look: C('giant', 1.0, ['#5a4a2a', '#3a2a1a', '#5a8a3a', '#6a5a3a'], 'fists', ['leaves'], { build: 'hulk', head: 'tree' }) }],
  [/treant/, { look: C('giant', 0.75, ['#5a4a2a', '#3a2a1a', '#5a8a3a', '#6a5a3a'], 'fists', ['leaves'], { build: 'hulk', head: 'tree' }) }],
  [/druid_bear|spirit_bear|_bear/, { beast: { kind: 'bear', col: '#5a3e26', belly: '#8a6a4a', glow: '#9fff7a', k: 1.25, acc: 'armor' } }],
  [/boar/, { beast: { kind: 'boar', col: '#6a4a3a', belly: '#9a7a5a', k: 1.0 } }],
  [/hawk/, { look: C('flyer', 0.55, ['#7a5a3a', '#4a3a2a', '#e0c070', '#c8a878'], 'none', ['tail'], { flyer: 'bird', hover: 90 }) }],
  [/zombie_torso/, { look: C('humanoid', 0.7, ['#5a6a5a', '#2a2a2a', '#9fff7a', '#7a8a72'], 'claws', [], { build: 'slim', head: 'skull', glow: '#9fff7a', hunch: 0.6 }) }],
  [/zombie/, { look: C('humanoid', 0.85, ['#5a6a5a', '#2a2a2a', '#9fff7a', '#7a8a72'], 'claws', [], { build: 'slim', head: 'skull', glow: '#9fff7a', hunch: 0.45 }) }],
  [/imp/, { look: C('humanoid', 0.6, ['#8a2a1a', '#3a1414', '#ff8a2a', '#a03020'], 'claws', ['wings_bat', 'horns', 'tail'], { build: 'tiny', head: 'demon', glow: '#ffae42' }) }],
  [/eidolon/, { look: C('spirit', 0.8, ['#2a2048', '#0a0814', '#c49cff', '#3a3060'], 'none', ['horns'], { head: 'void', glow: '#c49cff', build: 'slim' }) }],
  [/forged_spirit/, { look: C('spirit', 0.9, ['#5a2a1a', '#2a1410', '#ff8a2a', '#7a3a2a'], 'none', ['flames'], { head: 'rock', glow: '#ff8a2a', build: 'normal' }) }],
  [/brewmaster_earth/, { look: C('humanoid', 1.05, ['#7a6a4a', '#4a3a2a', '#a08a5a', '#8a7a5a'], 'fists', ['rocks'], { build: 'heavy', head: 'panda', hair: '#a09070' }) }],
  [/brewmaster_storm/, { look: C('humanoid', 0.95, ['#3a6ad0', '#1a2a5a', '#bfe9ff', '#5a8ae0'], 'staff', ['aura_ring'], { build: 'normal', head: 'panda', glow: '#bfe9ff', hair: '#bfe9ff' }) }],
  [/brewmaster_fire/, { look: C('humanoid', 0.95, ['#c83a1a', '#5a1a10', '#ffb040', '#ff7a2a'], 'fists', ['flames'], { build: 'normal', head: 'panda', glow: '#ff8a2a', hair: '#ffb060' }) }],
  [/brewmaster_void/, { look: C('humanoid', 0.95, ['#3a2a5a', '#1a1428', '#c49cff', '#5a4a7a'], 'staff', ['aura_ring'], { build: 'normal', head: 'panda', glow: '#c49cff', hair: '#8a7ab0' }) }],
  [/familiar/, { look: C('flyer', 0.7, ['#6a7a7a', '#3a4a4a', '#9fd8ff', '#8a9a9a'], 'none', ['horns', 'tail'], { flyer: 'dragon', hover: 45, glow: '#9fd8ff' }) }],
  [/wisp/, { look: C('orb', 0.45, ['#fff4c0', '#ffd870', '#ffffff', '#ffe8a0'], 'none', [], { hover: 50, glow: '#ffe080' }) }],
  [/zealot/, { look: C('humanoid', 0.95, ['#ece4cc', '#7a6a4a', '#e0b040', '#c8a080'], 'mace', ['hood', 'robe'], { build: 'normal' }) }],
  [/ink_creature/, { look: C('spirit', 0.55, ['#1a1a24', '#0a0a10', '#ff3030', '#2a2a34'], 'none', [], { head: 'void', glow: '#ff3030', build: 'slim' }) }],
  [/swarm/, { look: C('insect', 0.35, ['#5a8a6a', '#2a3a2a', '#e0e080', '#7ab08a'], 'none', ['wings_bug'], { legs: 6, head: 'insect', glow: '#e0ff80' }) }],
  [/ancestral_spirit/, { look: C('spirit', 1.2, ['#3a5a9a', '#1a2a4a', '#7ab8ff', '#5a7ab0'], 'none', ['beard'], { build: 'hulk', glow: '#7ab8ff', head: 'void' }) }],
  [/revenant/, { look: C('spirit', 0.9, ['#2a3a3a', '#141c1c', '#7affd0', '#4a6a6a'], 'none', ['hat_wide'], { head: 'skull', glow: '#7affd0', build: 'slim' }) }],
];

function ward(b: Builder, kind: string): number {
  b.bone('body', 'root', [0, 0, 0]);
  const glow = (c: V3, r: number, col: string) => b.ell('body', col, c, [r, r, r], { lit: 1 });
  switch (kind) {
    case 'serpent_ward': {
      b.cyl('body', '#5a4a2a', [0, 4, 0], 10, 12, 8, { seg: 7 });
      const pts: V3[] = [[0, 8, 0], [4, 26, 2], [-2, 42, -2], [4, 56, 0]];
      for (let i = 0; i < 3; i++) b.tube('body', i % 2 ? '#7aa84a' : '#5a8a3a', pts[i], pts[i + 1], 5 - i, 4.5 - i);
      b.ell('body', '#6a9a4a', [8, 58, 0], [7, 4.5, 5]);
      for (const s of [-1, 1]) b.ell('body', '#ffe040', [12, 60, s * 2.4], [1, 1, 1], { lit: 1, detail: 0 });
      return 64;
    }
    case 'plague_ward':
      b.cyl('body', '#4a3a2a', [0, 5, 0], 8, 11, 10, { seg: 6 });
      b.ell('body', '#5a8a2a', [0, 22, 0], [9, 14, 9], { detail: 0 });
      for (let i = 0; i < 5; i++) { const a = (i / 5) * Math.PI * 2; b.cone('body', '#7aa83a', [Math.cos(a) * 6, 30, Math.sin(a) * 6], [Math.cos(a) * 16, 44, Math.sin(a) * 16], 3.5, { seg: 3 }); }
      glow([0, 38, 0], 4, '#e0ff40');
      return 48;
    case 'death_ward':
      b.cyl('body', '#3a2a1a', [0, 30, 0], 3, 5, 60, { seg: 6 });
      b.ell('body', BONE, [2, 64, 0], [8, 8, 7]);
      for (const s of [-1, 1]) glow([8, 65, s * 3], 1.6, '#ff5030');
      for (const s of [-1, 1]) b.plate('body', '#7a2a2a', [[0, 0], [4, 16], [-2, 14]], 1, [0, 56, s * 5], { rot: [s * 0.5, 0, 0] });
      return 74;
    case 'healing_ward':
      b.cyl('body', '#4a3a2a', [0, 22, 0], 3, 4, 44, { seg: 6 });
      b.cone('body', '#7dff7d', [0, 44, 0], [0, 64, 0], 7, { lit: 1, seg: 6 });
      b.torus('body', GOLD, [0, 44, 0], 6, 1.4, { rot: [Math.PI / 2, 0, 0], tub: 10 });
      return 66;
    case 'nether_ward':
      b.cyl('body', '#3a4a2a', [0, 8, 0], 14, 18, 16, { seg: 6 });
      b.cyl('body', '#4a5a3a', [0, 40, 0], 4, 10, 50, { seg: 6 });
      glow([0, 72, 0], 9, '#9fff4a');
      for (let i = 0; i < 3; i++) { const a = (i / 3) * Math.PI * 2; b.cone('body', '#4a5a3a', [Math.cos(a) * 8, 60, Math.sin(a) * 8], [Math.cos(a) * 16, 84, Math.sin(a) * 16], 3, { seg: 4 }); }
      return 84;
    case 'tombstone':
      b.box('body', '#6a6a72', [0, 4, 0], [40, 8, 30]);
      b.box('body', '#7a7a84', [0, 34, 0], [10, 56, 30]);
      b.cyl('body', '#7a7a84', [0, 62, 0], 15, 15, 10, { rot: [Math.PI / 2, 0, 0], seg: 10 });
      b.box('body', '#3a3a40', [5.5, 44, 0], [1, 20, 4]);
      b.box('body', '#3a3a40', [5.5, 48, 0], [1, 4, 14]);
      glow([6, 30, 0], 3, '#9fff7a');
      return 76;
    case 'anchor':
      b.at([0, 10, 0], () => {
        b.tube('body', '#7a6a5a', [0, 0, 0], [0, 70, 0], 4);
        b.torus('body', '#7a6a5a', [0, 74, 0], 7, 2.4, { tub: 8 });
        b.box('body', '#7a6a5a', [0, 56, 0], [36, 5, 5]);
        b.torus('body', '#7a6a5a', [0, 10, 0], 26, 4, { arc: Math.PI, rot: [0, 0, Math.PI], tub: 10 });
      });
      return 90;
    case 'sentry': case 'observer':
      b.cyl('body', '#4a3a2a', [0, 20, 0], 2.5, 4, 40, { seg: 6 });
      glow([0, 44, 0], 6, kind === 'sentry' ? '#7fd6ff' : '#ffe060');
      b.torus('body', GOLD, [0, 44, 0], 7, 1.2, { tub: 10 });
      return 50;
    case 'mine':
      b.cyl('body', '#3a3a40', [0, 4, 0], 12, 14, 8, { seg: 8 });
      b.cyl('body', '#5a5a64', [0, 9, 0], 8, 10, 4, { seg: 8 });
      glow([0, 12, 0], 3, '#ff4030');
      return 14;
    case 'sign':
      b.tube('body', '#6a4a2a', [0, 0, 0], [0, 46, 0], 2);
      b.box('body', '#d8c070', [0, 42, 0], [3, 20, 30]);
      b.box('body', '#c03030', [1.6, 42, 0], [0.5, 10, 10], { rot: [Math.PI / 4, 0, 0] });
      return 52;
    case 'trap':
      b.torus('body', '#c49cff', [0, 6, 0], 14, 1.6, { rot: [Math.PI / 2, 0, 0], lit: 1, tub: 16, seg: 3 });
      glow([0, 10, 0], 4, '#d9a6ff');
      return 14;
    case 'turret':
      b.cyl('body', '#5a5a64', [0, 10, 0], 14, 18, 20, { seg: 8 });
      b.ell('body', '#a07a3a', [0, 26, 0], [12, 9, 12]);
      b.cyl('body', DARK, [12, 28, 0], 3, 3, 20, { rot: [0, 0, Math.PI / 2], seg: 6 });
      glow([22, 28, 0], 2.5, '#9fd8ff');
      return 36;
    case 'cog':
      b.cyl('body', '#a07a3a', [0, 40, 0], 14, 14, 80, { seg: 10 });
      for (let i = 0; i < 8; i++) { const a = (i / 8) * Math.PI * 2; b.box('body', '#8a6a2a', [Math.cos(a) * 15, 40, Math.sin(a) * 15], [6, 76, 6], { rot: [0, -a, 0] }); }
      b.cyl('body', '#c03030', [0, 82, 0], 8, 10, 6, { seg: 8 });
      glow([0, 87, 0], 3, '#ffae42');
      return 90;
    case 'ice_spire':
      b.cone('body', '#bfe9ff', [0, 0, 0], [0, 90, 0], 14, { seg: 5, lit: 0.45 });
      for (const s of [-1, 1]) b.cone('body', '#e8f8ff', [s * 8, 0, 4], [s * 18, 50, 8], 7, { seg: 4, lit: 0.45 });
      return 90;
    case 'eyes':
      glow([0, 60, 0], 6, '#d0ff7a');
      b.ell('body', '#3a5a2a', [0, 56, 0], [10, 6, 10], { detail: 0 });
      return 66;
    case 'stone':
      b.ell('body', '#4a8a6a', [0, 22, 0], [24, 22, 22], { detail: 0 });
      b.ell('body', '#7affc0', [10, 30, 0], [6, 6, 6], { lit: 0.6, detail: 0 });
      return 44;
    case 'sun':
      b.ball('body', '#ffb040', [0, 80, 0], [36, 36, 36], { lit: 1, seg: 10 });
      b.ball('body', '#fff0a0', [0, 80, 0], [20, 20, 20], { lit: 1, seg: 8 });
      return 120;
    case 'cloud':
      for (const [x, z, r] of [[0, 0, 26], [22, 8, 18], [-20, -6, 20], [4, -18, 16]] as [number, number, number][]) b.ell('body', '#c8d0e0', [x, 150, z], [r, r * 0.6, r], { detail: 0 });
      glow([0, 136, 0], 6, '#bfe9ff');
      return 170;
    case 'missile':
      b.at([0, 30, 0], () => {
        b.tube('body', '#a0a4ac', [-20, 0, 0], [16, 0, 0], 5, 5, { seg: 8 });
        b.cone('body', '#c03030', [16, 0, 0], [28, 0, 0], 5, { seg: 8 });
        for (let i = 0; i < 4; i++) b.plate('body', '#c03030', [[0, 0], [-8, 0], [-10, 8]], 1, [-14, 0, 0], { rot: [(i * Math.PI) / 2, 0, 0] });
        b.cone('body', '#ffae42', [-20, 0, 0], [-36, 0, 0], 4, { seg: 6, lit: 1 });
      });
      return 40;
    case 'sigil':
      b.cyl('body', '#bfe9ff', [0, 30, 0], 12, 12, 2, { seg: 6, lit: 0.6 });
      b.cone('body', '#e8f8ff', [0, 30, 0], [0, 56, 0], 6, { seg: 4, lit: 0.6 });
      return 56;
    case 'cart':
      b.box('body', '#8a5a2a', [0, 22, 0], [50, 22, 34]);
      for (const s of [-1, 1]) b.cyl('body', '#3a2a1a', [0, 14, s * 19], 14, 14, 4, { rot: [Math.PI / 2, 0, 0], seg: 8 });
      b.cone('body', '#c03030', [0, 33, 0], [0, 60, 0], 26, { seg: 6 });
      return 60;
    case 'wheel':
      b.torus('body', '#c03030', [0, 40, 0], 34, 4, { tub: 16, seg: 5 });
      for (let i = 0; i < 6; i++) { const a = (i / 6) * Math.PI * 2; b.tube('body', GOLD, [0, 40, 0], [0, 40 + Math.sin(a) * 32, Math.cos(a) * 32], 1.6); }
      b.tube('body', DARK, [0, 0, -6], [0, 40, 0], 3); b.tube('body', DARK, [0, 0, 6], [0, 40, 0], 3);
      return 76;
    default:
      b.cyl('body', '#4a5a3a', [0, 30, 0], 4, 8, 60, { seg: 6 });
      glow([0, 66, 0], 6, '#9cff9c');
      return 72;
  }
}

function wardKind(n: string): string {
  if (n.includes('serpent') || n.startsWith('shadow_shaman_ward')) return 'serpent_ward';
  if (n.includes('plague_ward')) return 'plague_ward';
  if (n.includes('death_ward')) return 'death_ward';
  if (n.includes('healing_ward')) return 'healing_ward';
  if (n.includes('nether_ward')) return 'nether_ward';
  if (n.includes('tombstone')) return 'tombstone';
  if (n.includes('anchor')) return 'anchor';
  if (n.includes('sentry')) return 'sentry';
  if (n.includes('observer')) return 'observer';
  if (n.includes('mine') && !n.includes('sign')) return 'mine';
  if (n.includes('sign')) return 'sign';
  if (n.includes('cog')) return 'cog';
  if (n.includes('trap')) return 'trap';
  if (n.includes('turret')) return 'turret';
  if (n.includes('ice_spire')) return 'ice_spire';
  if (n.includes('treant_eyes')) return 'eyes';
  if (n.includes('earth_spirit_stone')) return 'stone';
  if (n.includes('phoenix_sun')) return 'sun';
  if (n.includes('zeus_cloud')) return 'cloud';
  if (n.includes('missile') || n.includes('rocket')) return 'missile';
  if (n.includes('sigil')) return 'sigil';
  if (n.includes('centaur_cart')) return 'cart';
  if (n.includes('ringmaster_wheel')) return 'wheel';
  return '';
}

/** Modelo de una unidad que no es héroe. `kind` es SUnit.k. */
export function unitModel(kind: string, n: string): ModelDef {
  const wk = wardKind(n);
  const found = wk ? undefined : SPECS.find(([re]) => re.test(n));
  const key = wk ? 'ward:' + wk : found ? 'unit:' + found[0].source : kind === 'ward' ? 'ward:default' : 'unit:generic';
  let m = cache.get(key);
  if (m) return m;
  const spec = found?.[1];
  if (wk || (!spec && kind === 'ward')) {
    const b = new Builder(key);
    const top = ward(b, wk || 'default');
    m = b.finish({ biped: 'none', strike: 'none', still: true }, top, WORLD_SCALE, false);
  } else if (spec?.look) {
    m = fromLook(key, spec.look, false);
  } else if (spec?.beast) {
    const q = spec.beast;
    const b = new Builder(key);
    const r = quad(b, '', { kind: q.kind, col: q.col, belly: q.belly, glow: q.glow, k: q.k, mane: q.mane });
    if (q.acc === 'armor') {
      b.ell('body', '#8a8a96', [8, r.legH + 30, 0], [22, 10, 20], { detail: 0 });
      b.ell('body', '#9fff7a', [8, r.legH + 41, 0], [3, 3, 3], { lit: 1, detail: 0 });
    }
    m = b.finish({ biped: 'none', quad: '', strike: 'bite' }, r.top, WORLD_SCALE, false);
  } else {
    m = fromLook(key, C('humanoid', 0.8, ['#7a7a6a', '#4a4a3a', '#c0a060', '#a08a70'], 'club', [], { build: 'slim', head: 'beast' }), false);
  }
  cache.set(key, m);
  return m;
}

/** Bicho del maleficio (Hex): una rana. */
export function hexModel(): ModelDef {
  let m = cache.get('hex');
  if (!m) {
    const b = new Builder('hex');
    const r = quad(b, '', { kind: 'frog', col: '#6aa84a', belly: '#e0e8a0', k: 1.1 });
    m = b.finish({ biped: 'none', quad: '', strike: 'none' }, r.top, WORLD_SCALE, false);
    cache.set('hex', m);
  }
  return m;
}

/** Todas las claves de modelo de creep (para la galería). */
export const CREEP_SAMPLES = ['neutral_kobold', 'neutral_kobold_taskmaster', 'kobold_king', 'neutral_giant_wolf', 'neutral_alpha_wolf', 'lycan_wolf4',
  'neutral_satyr_trickster', 'neutral_satyr_soulstealer', 'neutral_satyr_hellcaller', 'neutral_centaur_outrunner', 'neutral_centaur_khan',
  'neutral_ogre_mauler', 'neutral_mud_golem', 'warlock_golem', 'warlock_minor_imp', 'furion_treant', 'lone_druid_bear1', 'beastmaster_boar',
  'beastmaster_hawk', 'broodmother_spiderling', 'wraith_king_skeleton', 'clinkz_skeleton_archer', 'unit_undying_zombie', 'eidolon',
  'invoker_forged_spirit', 'brewmaster_earth_1', 'brewmaster_storm_1', 'brewmaster_fire_1', 'visage_familiar1', 'keeper_of_the_light_wisp',
  'chen_zealot', 'grimstroke_ink_creature', 'weaver_swarm', 'elder_titan_ancestral_spirit', 'neutral_harpy_storm', 'neutral_black_dragon',
  'neutral_dark_troll_warlord', 'neutral_wildkin', 'neutral_ghost', 'neutral_big_thunder_lizard', 'neutral_polar_furbolg_champion', 'neutral_ancient_frog'];
export const WARD_SAMPLES = ['serpent_ward', 'venomancer_plague_ward', 'witch_doctor_death_ward', 'healing_ward', 'pugna_nether_ward', 'unit_tombstone4',
  'unit_tidehunter_anchor', 'sentry_wards', 'techies_land_mine', 'techies_minefield_sign', 'templar_assassin_psionic_trap', 'tinker_turret1',
  'rattletrap_cog', 'lich_ice_spire', 'treant_eyes', 'earth_spirit_stone', 'phoenix_sun', 'zeus_cloud', 'gyrocopter_homing_missile', 'ringmaster_wheel'];
