// Prueba una tanda de héroes sin red: comprueba que el kit está completo y juega
// partidas solo con bots que lanzan todas sus habilidades. Uso:
//   npx tsx scripts/test-heroes.ts lina pudge axe [--minutes 8]
import '../shared/items';
import '../shared/items/neutral';
import { HEROES, ABILITIES } from '../shared/data';
import { addHero, createGame } from '../shared/game/setup';
import { HERO_KITS, abilityImpl } from '../shared/sim/abilities';
import { botThink } from '../shared/overthrow/bot';
import { buyItem } from '../shared/sim/items';

const args = process.argv.slice(2);
const mi = args.indexOf('--minutes');
const minutes = mi >= 0 ? +args[mi + 1] : 8;
const heroes = args.filter((a, i) => !a.startsWith('--') && i !== mi + 1);
let problems = 0;
for (const h of heroes) {
  await import(`../shared/heroes/${h}.ts`);
  if (!HEROES[h]) { console.log(`✗ ${h}: no existe en los datos`); problems++; continue; }
  const kit = HERO_KITS[h];
  if (!kit) { console.log(`✗ ${h}: falta defineHero`); problems++; continue; }
  const missing = HEROES[h].abilities.filter((a) => !abilityImpl(a));
  if (missing.length) { console.log(`✗ ${h}: habilidades sin implementar: ${missing.join(', ')}`); problems++; }
  for (const k of kit) if (!ABILITIES[k]) { console.log(`✗ ${h}: ${k} no existe en abilities.json`); problems++; }
}
const errors = new Map<string, number>();
const casts = new Map<string, number>();
for (let round = 0; round < Math.ceil(heroes.length / 8) * 2; round++) {
  const game = createGame('necropolis', 100 + round);
  const pool = heroes.slice((round * 8) % heroes.length).concat(heroes).slice(0, 8);
  const units = pool.map((h, t) => {
    // Por parejas: así también se prueban las habilidades sobre aliados.
    const u = addHero(game, h, Math.floor(t / 2), null);
    u.isBot = true;
    u.gold = 20000;
    // Con Shard y Aghanim's para probar también sus mejoras.
    if (round % 2) { buyItem(u, 'aghanims_shard'); buyItem(u, 'ultimate_scepter_2'); }
    for (const a of u.abilities) {
      const orig = a.impl.onSpellStart;
      if (orig && !(a.impl as any)._wrapped) {
        (a.impl as any)._wrapped = true;
        a.impl.onSpellStart = (ab, t) => { casts.set(ab.key, (casts.get(ab.key) ?? 0) + 1); return orig(ab, t); };
      }
    }
    return u;
  });
  // Los bots suben de nivel rápido para usar las definitivas.
  for (const u of units) u.addXp(9000 + round * 4000);
  const w = game.world;
  while (w.time < minutes * 60 && !w.over) {
    for (const u of units) {
      try { botThink(w, u, game.rules); } catch (e) { const k = `${u.name} (bot): ${(e as Error).message}`; errors.set(k, (errors.get(k) ?? 0) + 1); }
    }
    try { w.tick(); } catch (e) {
      const st = String((e as Error).stack ?? e).split('\n').slice(0, 3).join(' | ');
      errors.set(st, (errors.get(st) ?? 0) + 1);
      if ([...errors.values()].reduce((a, b) => a + b, 0) > 200) break;
    }
    w.fx.length = 0; w.errors.length = 0;
  }
}
for (const h of heroes) {
  const kit = HERO_KITS[h] ?? [];
  const actives = kit.filter((k) => abilityImpl(k)?.onSpellStart);
  const never = actives.filter((k) => !casts.get(k));
  console.log(`${h}: lanzadas ${actives.length - never.length}/${actives.length}${never.length ? ` (nunca: ${never.join(', ')})` : ''}`);
}
for (const [k, n] of errors) console.log(`✗ ERROR ×${n}: ${k}`);
console.log(errors.size || problems ? `\n${problems} problemas de kit, ${errors.size} errores distintos` : '\nTodo bien');
