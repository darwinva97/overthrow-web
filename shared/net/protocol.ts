// Mensajes entre cliente y servidor. El cliente solo manda intenciones (órdenes),
// nunca posiciones; el servidor manda lo que ve el equipo de cada jugador.
import type { Order, TargetKind } from '../sim/types';
import type { OrbPick } from '../sim/unit';

export type ClientMsg =
  | { t: 'create'; name: string; map: string; quick?: boolean; hero?: string }
  | { t: 'join'; code: string; name: string }
  | { t: 'resume'; code: string; token: string }
  | { t: 'leave' }
  | { t: 'pick'; hero: string }
  | { t: 'team'; team: number }
  | { t: 'map'; map: string }
  | { t: 'bots'; fill: boolean }
  | { t: 'start' }
  | { t: 'order'; o: Order; q?: boolean; units?: number[] }
  | { t: 'learn'; slot: number }
  | { t: 'buy'; item: string }
  | { t: 'sell'; slot: number }
  | { t: 'swap'; a: number; b: number }
  | { t: 'orb'; i: number }
  | { t: 'talent'; key: string }
  | { t: 'neutral'; trinket: number; enhancement: number }
  | { t: 'chat'; text: string }
  | { t: 'ping'; c: number };

export interface LobbyPlayer { id: string; name: string; hero: string | null; team: number; bot: boolean; online: boolean }
export interface LobbyState {
  code: string; host: string; map: string; fillBots: boolean;
  state: 'lobby' | 'game' | 'over';
  players: LobbyPlayer[];
  teams: number; teamSize: number;
}

export type ServerMsg =
  | { t: 'welcome'; id: string; token: string; code: string }
  | { t: 'lobby'; lobby: LobbyState }
  | { t: 'start'; map: string; you: string; team: number; hero: number; teams: TeamInfo[]; killGoal: number; timeLimit: number; captureTime: number }
  | { t: 's'; s: Snapshot }
  /** Snapshot compacto (shared/net/wire.ts). */
  | { t: 'w'; s: import('./wire').WireSnapshot }
  | { t: 'err'; msg: string }
  | { t: 'chat'; from: string; text: string; team: number }
  | { t: 'end'; winner: number; reason: string; board: BoardRow[] }
  | { t: 'pong'; c: number };

export interface TeamInfo { id: number; name: string; color: string }

/** Unidad visible. Claves cortas porque va 15 veces por segundo. */
export interface SUnit {
  i: number;
  /** Tipo: hero, illusion, creep, ward, fountain, kobold, throne, orb */
  k: string;
  /** Héroe o nombre de unidad. */
  n: string;
  t: number;
  x: number; y: number; f: number;
  h: number; H: number; m: number; M: number;
  l: number;
  /** Estados (bits ST). */
  s: number;
  /** Efectos visuales de sus modificadores. */
  fx?: string[];
  /** 1 si es del jugador que recibe el snapshot. */
  o?: 1;
  /** Fase de ataque (1 = preparando golpe) y lanzamiento (1 = cast point, 2 = canalizando). */
  a?: 1;
  c?: 1 | 2;
  /** Radio de visión: solo para unidades del propio equipo, para la niebla. */
  v?: number;
  r: number;
  /** Ilusión vista por su dueño (los enemigos no la distinguen). */
  il?: 1;
  /** Habilidad o item que está lanzando o canalizando. */
  ck?: string;
}

export interface SProj { i: number; fx: string; x: number; y: number; s: number; tu?: number; a?: string }
export interface SZone { i: number; fx: string; x: number; y: number; r: number; t: number; e: number; a?: string }
export interface SOrb { i: number; r: string; p: [number, number][]; landed: boolean }

export interface SAbility {
  k: string; l: number; max: number; cd: number; mcd: number; mc: number;
  ch: number; tg: boolean; can: boolean; tk: TargetKind; rng: number; aoe: number;
  ult: boolean; innate: boolean;
  /** Disponible (las de Scepter/Shard sin el objeto, no). */
  av: boolean;
  req: 'scepter' | 'shard' | null;
  hidden: boolean;
}
export interface SItem { k: string; cd: number; mcd: number; ch: number; tg: boolean; md: number; tk: TargetKind | null; rng: number }
export interface SBuff { n: string; fx?: string; r: number; d: number; s: number; db: boolean; src: string }

export interface SMe {
  id: number; gold: number; lvl: number; xp: number; xpPrev: number; xpNext: number; ap: number;
  ab: SAbility[]; it: (SItem | null)[]; st: string[]; shop: boolean;
  orb: OrbPick | null; orbN: number;
  buffs: SBuff[];
  dead: number;
  stats: { dmg: string; as: number; armor: number; mr: number; ms: number; str: number; agi: number; int: number; range: number; spell: number; hpr: number; mpr: number; evasion: number };
  units: number[];
  kda: [number, number, number, number];
  talents: { tier: number; level: number; can: boolean; options: { key: string; name: string; picked: boolean }[] }[];
  scepter: boolean; shard: boolean;
  neutral: import('../sim/unit').NeutralPick | null;
  enhancement: { key: string; tier: number } | null;
}

export interface BoardRow { id: number; name: string; hero: string; team: number; k: number; d: number; a: number; lvl: number; alive: boolean; respawn: number; bot: boolean; gold?: number }

export interface Snapshot {
  tm: number;
  /** Visión sin unidad del propio equipo (para la niebla). */
  vz: { x: number; y: number; r: number }[];
  /** Celdas distintas del mapa inicial [índice, tipo]; solo cuando cambian. */
  cells?: [number, number][];
  night: boolean;
  u: SUnit[];
  p: SProj[];
  z: SZone[];
  fx: import('../sim/types').Fx[];
  orbs: SOrb[];
  kills: number[];
  board: BoardRow[];
  me: SMe | null;
}
