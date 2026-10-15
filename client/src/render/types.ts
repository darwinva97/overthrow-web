// Contrato común de los dos modos de dibujo. El juego no sabe si pinta en 2D o en 3D:
// le pasa la misma vista a cualquiera de los dos y les pide convertir coordenadas.
import type { MapLayout } from '../../../shared/maps';
import type { BoardRow, SMe, SOrb, SProj, SZone, TeamInfo } from '../../../shared/net/protocol';
import type { Fx } from '../../../shared/sim/types';
import type { VUnit } from '../game/state';

export interface Camera { x: number; y: number; zoom: number }

export interface Targeting {
  range: number;
  aoe: number;
  kind: 'unit' | 'point' | 'unitOrPoint';
}

export interface View {
  tm: number;
  night: boolean;
  units: VUnit[];
  byId: Map<number, VUnit>;
  projs: SProj[];
  zones: SZone[];
  orbs: SOrb[];
  me: SMe | null;
  hero: VUnit | undefined;
  team: number;
  teams: TeamInfo[];
  layout: MapLayout;
  hover: number;
  mouse: { x: number; y: number };
  targeting: Targeting | null;
  captureTime: number;
  /** Marca de la última orden de movimiento. */
  marker: { x: number; y: number; t: number; attack: boolean } | null;
  board: BoardRow[];
  killsByTeam: number[];
  /** Visión del equipo sin unidad (para la niebla). */
  vz: { x: number; y: number; r: number }[];
}

export interface Renderer {
  readonly kind: '2d' | '3d';
  /** Elementos a montar en pantalla, de abajo arriba (el primero recibe el ratón). */
  readonly elements: HTMLElement[];
  resize(w: number, h: number, dpr: number): void;
  render(v: View, cam: Camera, dt: number): void;
  /** Punto del suelo bajo el píxel de pantalla. */
  screenToWorld(sx: number, sy: number, cam: Camera): { x: number; y: number };
  /** Píxel de pantalla de un punto del mundo a cierta altura. */
  worldToScreen(x: number, y: number, h: number, cam: Camera): { x: number; y: number };
  fx(f: Fx, v: View): void;
  /** Los árboles talados cambiaron (la cuadrícula ya está actualizada). */
  treesChanged?(changed: [number, number][]): void;
  dispose(): void;
}

export const TEAM_NEUTRAL = '#9a8f7a';
export function teamColor(v: View, team: number) {
  return v.teams[team]?.color ?? TEAM_NEUTRAL;
}
