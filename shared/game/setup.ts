// Monta una partida completa: mapa, mundo, reglas y registro de héroes e items.
import '../heroes';
import '../items';
import '../items/neutral';
import { buildMap } from '../maps';
import { OverthrowRules } from '../overthrow/rules';
import { syncItemPassives } from '../sim/items';
import { World } from '../sim/world';

export const START_GOLD = 850;

export function createGame(mapKey: string, seed = Date.now() & 0xffff) {
  const map = buildMap(mapKey);
  const world = new World(map.grid, seed);
  const rules = new OverthrowRules(world, map);
  return { map, world, rules };
}

export function addHero(game: ReturnType<typeof createGame>, hero: string, team: number, playerId: string | null) {
  const f = game.map.fountains[team];
  const u = game.world.spawnHero(hero, team, playerId, f.x + (Math.random() - 0.5) * 200, f.y + (Math.random() - 0.5) * 200);
  u.gold = START_GOLD;
  syncItemPassives(u);
  return u;
}
