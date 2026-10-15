// Mapas de Overthrow generados de forma determinista: el servidor y los clientes
// obtienen la misma cuadrícula a partir del nombre del mapa.
import { CELL, FREE, Grid, ROCK, TREE } from '../sim/nav';

export interface MapDef {
  key: string;
  name: string;
  teams: number;
  teamSize: number;
  killGoal: number;
  /** Segundos de partida antes de decidir por kills. */
  timeLimit: number;
  captureTime: number;
}

export const MAPS: Record<string, MapDef> = {
  necropolis: { key: 'necropolis', name: 'Necropolis FFA', teams: 8, teamSize: 1, killGoal: 30, timeLimit: 20 * 60, captureTime: 5 },
  gardens: { key: 'gardens', name: 'Gardens Duo', teams: 5, teamSize: 2, killGoal: 45, timeLimit: 20 * 60, captureTime: 5 },
  jungle: { key: 'jungle', name: 'Jungle Quintet', teams: 3, teamSize: 5, killGoal: 75, timeLimit: 20 * 60, captureTime: 8 },
  desert: { key: 'desert', name: 'Desert Octet', teams: 3, teamSize: 8, killGoal: 100, timeLimit: 20 * 60, captureTime: 8 },
};

export interface MapLayout {
  def: MapDef;
  grid: Grid;
  half: number;
  fountains: { x: number; y: number }[];
  camps: { x: number; y: number; tier: number }[];
  throne: { x: number; y: number };
  /** Puntos donde el Kobold King puede lanzar orbes. */
  orbRing: [number, number];
  /** Geometría para pintar el suelo: plaza central, anillo y caminos. */
  plaza: number;
  ringR: number;
  outer: number;
}

/** Ruido de valor determinista para que los bosques salgan en grupos. */
function noise(seed: number) {
  const h = (x: number, y: number) => {
    let n = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 2147483647);
    n = Math.imul(n ^ (n >>> 13), 1274126177);
    return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
  };
  const smooth = (t: number) => t * t * (3 - 2 * t);
  return (x: number, y: number) => {
    const xi = Math.floor(x), yi = Math.floor(y);
    const fx = smooth(x - xi), fy = smooth(y - yi);
    const a = h(xi, yi), b = h(xi + 1, yi), c = h(xi, yi + 1), d = h(xi + 1, yi + 1);
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
  };
}

/**
 * Arena circular con N bases en el borde, separadas por muros de roca.
 * Cada base tiene un camino hacia el centro (el trono) y un anillo une todos los caminos.
 * El tamaño crece con el número total de jugadores.
 */
export function buildMap(key: string): MapLayout {
  const def = MAPS[key] ?? MAPS.necropolis;
  const players = def.teams * def.teamSize;
  const half = players <= 8 ? 3328 : players <= 15 ? 3840 : 4352;
  const cells = Math.round((half * 2) / CELL);
  const grid = new Grid(cells, cells, -half, -half);
  const n = noise(def.teams * 7 + def.teamSize);
  const outer = half - 180;
  const baseR = outer - 520;
  const ringR = baseR * 0.62;
  const plaza = 760;
  const N = def.teams;
  const fountains: { x: number; y: number }[] = [];
  for (let i = 0; i < N; i++) {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / N;
    fountains.push({ x: Math.cos(a) * (baseR + 120), y: Math.sin(a) * (baseR + 120) });
  }
  const camps: MapLayout['camps'] = [];
  for (let i = 0; i < N; i++) {
    const a = -Math.PI / 2 + ((i + 0.5) * 2 * Math.PI) / N;
    camps.push({ x: Math.cos(a) * (ringR + 330), y: Math.sin(a) * (ringR + 330), tier: i % 2 ? 2 : 1 });
    camps.push({ x: Math.cos(a) * (ringR - 380), y: Math.sin(a) * (ringR - 380), tier: 3 });
  }
  for (let cy = 0; cy < cells; cy++) for (let cx = 0; cx < cells; cx++) {
    const x = grid.centerX(cx), y = grid.centerY(cy);
    const r = Math.hypot(x, y);
    const ang = Math.atan2(y, x);
    let t = FREE;
    if (r > outer) t = ROCK;
    else if (r < 110) t = ROCK; // trono
    else if (r > plaza) {
      // Bosque base con huecos.
      const v = n(x / 420, y / 420) * 0.7 + n(x / 150 + 50, y / 150) * 0.3;
      t = v > 0.36 ? TREE : FREE;
      // Muros de roca que separan las bases.
      for (let i = 0; i < N; i++) {
        const wa = -Math.PI / 2 + ((i + 0.5) * 2 * Math.PI) / N;
        let d = Math.abs(ang - wa) % (2 * Math.PI);
        if (d > Math.PI) d = 2 * Math.PI - d;
        if (r > baseR - 260 && d * r < 150) t = ROCK;
      }
      if (Math.abs(r - ringR) < 210) t = FREE;
    }
    // Caminos de cada base al centro y claro de la base.
    for (const f of fountains) {
      const fl = Math.hypot(f.x, f.y);
      const ux = f.x / fl, uy = f.y / fl;
      const along = x * ux + y * uy;
      const across = Math.abs(-x * uy + y * ux);
      if (along > 0 && along < fl && across < 190 && r >= 110) t = FREE;
      if (Math.hypot(x - f.x, y - f.y) < 560) t = FREE;
    }
    for (const c of camps) if (Math.hypot(x - c.x, y - c.y) < 250) t = FREE;
    // Rocas sueltas en el bosque para variar.
    if (t === TREE && n(x / 90 + 100, y / 90 + 100) > 0.86) t = ROCK;
    grid.cells[cy * cells + cx] = t;
  }
  return { def, grid, half, fountains, camps, throne: { x: 0, y: 0 }, orbRing: [plaza * 0.75, ringR + 150], plaza, ringR, outer };
}
