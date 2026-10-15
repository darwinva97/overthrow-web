# Cómo implementar héroes e items (guía para colaboradores)

Proyecto: port web de Overthrow 3.0 (Dota 2). El servidor simula a 30 ticks/s con el motor de
`shared/sim/`; los clientes solo pintan. El objetivo es la **máxima fidelidad a Dota 7.39 actual**:
mismas mecánicas, mismos números, talentos, Aghanim's Scepter y Shard.

## Antes de escribir código, lee

- `shared/sim/types.ts` — Modifier (props, states, eventos), AbilityImpl, ItemImpl, ST (estados), Props.
- `shared/sim/abilities.ts` — `defineAbility`, `defineHero`, `val()`, `dmg()`, `dur()`, `hasScepter/hasShard/hasTalent`.
- `shared/sim/world.ts` — API del mundo (ver abajo).
- `shared/sim/combat.ts` — `damage()`, `heal()`, `launchAttack()`, `makeAttack()/landAttack()`, `burnMana()`, `giveMana()`.
- `shared/heroes/util.ts` — `debuff`, `stun`, `slow`, `root`, `silence`, `hex`, `push`, `dash`, `dot`, `castDir`,
  `nearestEnemy`, `illusionsOf`, `reflectSpell`, `canDebuff`.
- Ejemplos completos: `shared/heroes/lina.ts`, `pudge.ts`, `juggernaut.ts`, `phantom_lancer.ts`, `antimage.ts`.
- Items: `shared/items/index.ts` (patrones de pasivas, auras, activas, procs).

## Los datos (no se escriben números a mano)

`shared/data/abilities.json` sale de los scripts de Valve del parche actual. Cada habilidad tiene:

- `values`: clave → valores por nivel. Claves especiales: `_cd` (enfriamiento), `_mc` (maná),
  `abilitycastrange`, `abilitycastpoint`, `abilitychanneltime`, `abilityduration`, `abilitycharges`,
  `abilitychargerestoretime`.
- `links`: enlaces de valores con talentos (`t`), Scepter (`sc`), Shard (`sh`), `rs` (solo existe con Scepter).
  **`val(a, 'clave')` ya aplica todo eso** (y las mejoras de orbe). Usa siempre `val()`; nunca leas
  `def.values` directamente ni pongas números literales que existan en los datos.
- `behavior` (flags de Valve en minúsculas: `passive`, `no_target`, `unit_target`, `point`, `aoe`, `channelled`,
  `toggle`, `autocast`, `hidden`, `immediate`…), `dmgType`, `bkbPierce`, `targetTeam`, `ult`, `innate`,
  `grantedBy` (`scepter` | `shard`), `maxLevel`, `desc` (descripción en inglés, guía de la mecánica).

Consulta rápida:

```bash
node -e 'const a=require("./shared/data/abilities.json"); const x=a["lina_laguna_blade"]; console.log(x.desc, JSON.stringify(x.values), JSON.stringify(x.links))'
node -e 'const h=require("./shared/data/heroes.json"); console.log(JSON.stringify(h["lina"], null, 1))'   # kit, talentos, aghs
node -e 'const u=require("./shared/data/units.json"); console.log(Object.keys(u).join(" "))'              # invocaciones
```

`heroes.json[h].abilities` es el kit oficial en orden de hueco (incluye innatas y las de Scepter/Shard).
`heroes.json[h].talents` son los 8 talentos (tier 1-4). `heroes.json[h].aghs` describe Scepter y Shard en texto.
Si la mecánica no está clara por la descripción, usa tu conocimiento de Dota 7.39 y los nombres de los valores.

## Estructura de un héroe

Un fichero por héroe: `shared/heroes/<clave>.ts` (la clave del dataset: `nevermore`, `furion`, `wisp`,
`zuus`, `windrunner`, `rattletrap`, `shredder`, `obsidian_destroyer`, `skeleton_king`, `magnataur`…).

```ts
import { defineAbility, defineHero, dmg, dur, val, hasScepter, hasShard, hasTalent } from '../sim/abilities';
import { damage, heal } from '../sim/combat';
import { ST } from '../sim/types';
import type { Unit } from '../sim/unit';
import { stun, slow, debuff, castDir } from './util';

defineAbility({
  key: 'lina_light_strike_array', target: 'point', ai: { role: 'disable' },
  aoe: (a) => val(a, 'light_strike_array_aoe'),
  onSpellStart(a, t) { /* … */ },
});
// … una defineAbility por cada habilidad del kit (también innatas, Scepter y Shard) …

defineHero('lina', ['lina_dragon_slave', /* … el kit de heroes.json en ese orden … */], {
  build: ['null_talisman', 'phase_boots', 'kaya', 'cyclone', 'black_king_bar', 'ultimate_scepter'],
  upgrades: [ /* opcional: mejoras de orbe propias, ver abajo */ ],
  talents: { /* opcional: talentos que no son enlace de valor */ },
});
```

### AbilityImpl

- `target`: `'none' | 'unit' | 'point' | 'unitOrPoint' | 'passive' | 'toggle'`.
  Vector targeting → `'point'` (dirección desde el héroe). Autocast tipo "orbe" (Frost Arrows…) → `'toggle'`
  y en la pasiva comprueba `a.toggled` y el maná en `onAttackStart`.
- `team`: `'enemy' | 'ally' | 'any'` (por defecto enemy). `allowSelf` para autolanzarse.
- `ult: true` en definitivas (el dataset ya lo marca en `def.ult`; pon igualmente `ult: true`).
- `innate: true` en innatas. Las de Scepter/Shard se detectan solas con `def.grantedBy`
  (o pon `requires: 'scepter' | 'shard'`): se ocultan y se suben solas.
- `passive(a)`: modificador intrínseco (se recrea al subir de nivel, al morir/revivir, con Scepter/Shard).
- `onSpellStart(a, {unit, x, y})`, `channel(a)` + `onChannelTick(a, dt)` + `onChannelEnd(a, interrupted)`,
  `onToggle(a, on)`, `charges(a) => [max, segundosPorCarga]`, `castPoint(a)`, `castRange(a)`, `aoe(a)`.
- `castBeyond: true` si al pulsar fuera de alcance no debe caminar (blinks que se recortan).
- `reflectable: true` en hechizos con objetivo unidad enemiga (Counterspell/Lotus los reflejan).
- `hidden: (a) => boolean` para sub-habilidades que aparecen según el estado (Return de Kunkka…);
  con `levelWith: <hueco>` siguen el nivel de otra habilidad.
- `noIllusion: true` si las ilusiones no deben tener esa pasiva (auras, la mayoría de pasivas no de ataque).
- `ai: { role, hpBelow?, selfRadius? }` **obligatorio en toda activa** o los bots no la usarán.
  Roles: `nuke`, `disable`, `aoe`, `escape`, `buff`, `summon`, `channel`, `heal`.
  `selfRadius`: para habilidades sin objetivo, distancia al enemigo a la que lanzarla.

### Modificadores (todo es un modificador)

`unit.addMod(spec, caster, ability)` con `name`, `duration`, `debuff`, `purgable`, `props` (objeto o
función `(m) => ({…})`), `states` (bits de `ST`), `interval` + `onInterval`, `aura`, y eventos:
`onAttackStart` (críticos, true strike), `onAttackLanded`, `onAttacked`, `onIncomingDamage` (bloqueos,
barreras: modifica `ev.amount`), `onTakeDamage`, `onDealDamage`, `onKill`, `onAnyDeath`, `onDeath`,
`onRespawn`, `onAbilityExecuted`, `onTargeted` (bloquear/reflejar), `onOrder`, `onTick`, `onCreated`, `onDestroy`.

- Mismo `name` + mismo caster → se refresca. Para varias instancias usa `data: { multi: true }`.
- Debuffs de enemigos: usa `debuff()` de util (respeta inmunidad a hechizos y bkbPierce) o los atajos.
- Props en fracción: `msSlow: 0.3` = 30%; `magicResist: 0.25`; `attackSlow` en puntos de AS; `damage` plano;
  `damagePct` sobre el daño base; `incomingPct`/`outgoingPct` (ilusiones); `cdr`, `manaReduce`,
  `healAmp`, `cleave`, `trueSight` (radio), `vision`, `damageBlock`…
- Estados: `stunned silenced rooted disarmed hexed invisible magicImmune invulnerable untargetable muted
  taunted noCollision revealed ethereal hidden busy broken flying`.

### Mundo (`u.w`)

- Unidades: `w.list`, `w.units.get(id)`, `w.enemiesIn(team, x, y, r, {heroes})`, `w.alliesIn(...)`,
  `w.unitsIn(x, y, r, pred)`, `w.targetable(u)`, `w.canSee(team, u)`.
- Movimiento: `w.teleport(u, x, y)` (blinks; llama antes a `w.disjoint(u)` si esquiva proyectiles),
  `w.forceMove(u, x, y)` (empujes por tick), `dash()` y `push()` de util.
- Proyectiles: `w.addProjectile({ kind: 'linear' | 'track', fx, source, target?, x, y, dx, dy, speed,
  left (distancia), width, widthEnd, dodgeable, onHit(p, unit) => true para terminar, onEnd, onThink })`.
  Los lineales impactan a cualquier unidad: filtra por equipo en `onHit`.
- Zonas: `w.addZone({ fx, x, y, r, team, interval, duration, onInterval(z) })`.
- Retardos: `w.after(segundos, fn)`. Efectos visuales: `w.emit({ n, x, y, x2?, y2?, r?, d?, u?, u2? })`
  (nombres en `client/src/render/fxstyle.ts`; si inventas uno nuevo no pasa nada, simplemente no se dibuja).
- Ilusiones: `w.spawnIllusion(hero, x, y, duración, outPct, inPct)` (fracciones: −0.85, 3).
- Invocaciones controlables: `w.spawnSummon(owner, '<clave de units.json>', x, y, duración, { level, abilities, hp })`.
  Sus habilidades se crean si tienen `defineAbility`.
- Visión: `w.addVision(team, x, y, r, duración, flying?)`. Árboles: `w.cutTrees(x, y, r)`, `w.nearestTree(x, y, r)`.
- Órdenes: `w.issueOrder(u, { type: 'attack', target: id })`…, `w.interruptCast(u, true)`.
- Tiempo: `w.time`, `w.isNight()`, `w.rng()` (usa siempre este aleatorio).

### Talentos

Los talentos que modifican un valor (`links.t`) funcionan solos con `val()`. Para los que cambian una
mecánica (p. ej. "Dragon Slave aplica un ralentizado", "+1 carga") comprueba `hasTalent(u, 'special_bonus_unique_…')`
en el código, o usa `opts.talents[clave] = (u) => …` para efectos de una vez. Los genéricos (`special_bonus_hp_250`…)
ya están hechos.

### Aghanim's Scepter y Shard

Los valores enlazados con `sc`/`sh` funcionan solos. Las habilidades nuevas (`def.grantedBy`) se ocultan
hasta tener el objeto. Los cambios de mecánica se implementan comprobando `hasScepter(u)` / `hasShard(u)`.
`heroes.json[h].aghs` dice qué hace cada uno.

### Mejoras de orbe (Overthrow 3.0)

Overthrow da a cada héroe mejoras sobre valores concretos de sus habilidades con un máximo de veces
(p. ej. "Entangle +30 de radio, máx 5", "Pounce −0,25 s de duración de correa", "Ghostship +150 daño").
Si no defines `upgrades`, se generan automáticamente (daño +15%, enfriamiento −8%, radio y duración +12%).
Puedes definir las tuyas, más fieles al estilo de Overthrow:
`{ slot: 0, key: 'dragon_slave_damage', amount: 40, max: 5, label: 'Dragon Slave: +40 daño' }`
(`pct: true` para porcentaje; `key: '_cd'` para enfriamiento con `amount` negativo).

## Normas

1. **Solo crea o modifica tus propios ficheros**: `shared/heroes/<héroe>.ts` de tu tanda (y, si lo necesitas,
   `shared/heroes/lib/<tanda>.ts` con ayudas compartidas entre tus héroes). No toques `shared/sim/*`,
   `shared/heroes/util.ts`, `shared/heroes/index.ts`, ficheros de otros héroes ni el cliente. Si te falta algo
   del motor, resuélvelo dentro de tu fichero (lógica en modificadores) y anótalo en tu informe final.
2. TypeScript con `erasableSyntaxOnly`: nada de `enum`, `namespace` ni propiedades en parámetros del constructor;
   `import type` para tipos. Comentarios en español, breves, como el resto del código.
3. Implementa **todas** las habilidades de `heroes.json[h].abilities` (incluidas innatas y Scepter/Shard) y los
   cambios de Scepter/Shard sobre habilidades existentes. Talentos de mecánica: los que puedas.
4. Fidelidad: tiempos, radios, tipos de daño, qué atraviesa inmunidad, disipaciones (`u.purge(debuffs, buffs)`),
   si es canalizada, si se esquiva. Lee la `desc` de cada habilidad.
5. Bots: `ai` en cada activa y una `build` coherente con el héroe, con claves de `shared/data/items.json`
   que tengan coste > 0 (los items sin mecánica todavía se filtran solos de la compra).

## Verificación (obligatoria antes de terminar)

```bash
cd ~/sandbox/overthrow-web
npx tsc --noEmit -p . 2>&1 | grep -E "shared/heroes/(heroe1|heroe2)" ; echo fin   # sin errores tuyos
nice -n 15 npx tsx scripts/test-heroes.ts heroe1 heroe2 heroe3 --minutes 4
```

`test-heroes` comprueba que el kit está completo, juega partidas solo con bots (con y sin Scepter/Shard) y
dice qué activas no llegó a lanzar nunca y qué excepciones hubo. Debe acabar sin `✗`. Una activa que nunca se
lanza suele indicar un `ai` mal puesto o un `castCheck` que siempre falla.
