// Partida sin red ni render solo con bots, para probar el motor de punta a punta.
import '../shared/heroes';
import { addHero, createGame } from '../shared/game/setup';
import { botThink, playableHeroes } from '../shared/overthrow/bot';
import { TICK } from '../shared/sim/world';

const mapKey = process.argv[2] ?? 'necropolis';
const game = createGame(mapKey, 42);
const { world, rules, map } = game;
// Héroes al azar (con semilla), para cubrir combinaciones distintas en cada ejecución.
const seed = Number(process.argv[3] ?? 42);
let r = seed;
const rnd = () => ((r = (r * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const heroes = playableHeroes().map((h) => [rnd(), h] as const).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
const units = [];
for (let t = 0; t < map.def.teams; t++) {
  for (let k = 0; k < map.def.teamSize; k++) {
    const u = addHero(game, heroes[(t * map.def.teamSize + k) % heroes.length], t, null);
    u.isBot = true;
    units.push(u);
  }
}
let errors = 0;
const t0 = Date.now();
let lastReport = 0;
while (!world.over && world.time < map.def.timeLimit + 120) {
  for (const u of units) botThink(world, u, rules);
  try { world.tick(); } catch (e) { errors++; if (errors < 5) console.log('ERROR', (e as Error).stack?.split('\n').slice(0, 4).join(' | ')); }
  world.fx.length = 0;
  world.errors.length = 0;
  if (world.time - lastReport >= 120) {
    lastReport = world.time;
    console.log(`${(world.time / 60).toFixed(0)} min | kills ${world.teams.map((t) => t.kills).join(' ')} | unidades ${world.list.length}`);
  }
}
const ms = Date.now() - t0;
console.log(`\nFin a los ${(world.time / 60).toFixed(1)} min de juego en ${(ms / 1000).toFixed(1)} s reales (${(world.tickN / (ms / 1000)).toFixed(0)} ticks/s)`);
console.log('Errores:', errors);
console.log('Ganador:', world.over ? `${world.teams[world.over.winner].name} (${world.over.reason})` : 'ninguno');
for (const u of units) {
  console.log(`${u.name.padEnd(16)} eq${u.team} nv${String(u.level).padStart(2)} ${u.kills}/${u.deaths}/${u.assists} oro ${Math.round(u.gold).toString().padStart(5)} | ${u.items.filter(Boolean).map((i) => i!.key).join(', ')}`);
}
