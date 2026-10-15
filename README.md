# Overthrow web

Port multijugador en tiempo real de **Overthrow 3.0**, el modo Arcade de Dota 2, para el navegador.
Cada jugador elige si ve la partida en **2D (Canvas)** o en **3D (Three.js)**, y puede cambiar con
F2 en mitad de la partida aunque los demás usen el otro modo.

Hay una instancia en marcha en https://overthrow.bezenti.com

## Qué incluye

- Los 127 héroes de Dota 7.39, con innatas, Aghanim's Scepter, Shard y talentos.
- Items de tienda y objetos neutrales (trinkets y encantamientos por tier, que llegan directamente al equipo).
- Las reglas de Overthrow 3.0:
  - kill goal y límite de tiempo, con prórroga;
  - Midas Throne;
  - orbes del Kobold King, comunes, raros y épicos, con remontada para quien va perdiendo.
- Cuatro modos: Necropolis FFA (8×1), Gardens Duo (5×2), Jungle Quintet (3×5) y Desert Octet (3×8).
- Salas por código y bots que rellenan los huecos o toman el héroe de quien se desconecta.
- Niebla de guerra con línea de visión (los árboles la tapan), árboles talables y campamentos con los creeps neutrales reales.

Los números de héroes, habilidades, items y unidades salen de los scripts de Valve del parche actual,
extraídos por [dotabuff/d2vpkr](https://github.com/dotabuff/d2vpkr). Los nombres y descripciones salen de
[dotaconstants](https://github.com/odota/dotaconstants).

## Estructura

```
shared/   motor de simulación (TypeScript puro), datos, héroes, items y reglas del modo
server/   Node + ws: salas, bucle autoritativo a 30 ticks/s, snapshots por equipo
client/   Vite: HUD en DOM y los dos renderers (render/canvas2d.ts y render/three3d.ts)
scripts/  generación de datos y pruebas con bots
docs/     guía para implementar héroes e items (docs/HEROES.md)
```

El servidor simula todo y manda a cada jugador lo que ve su equipo. Los clientes solo envían órdenes
y pintan. Por eso cada uno puede usar un renderer distinto.

## Puesta en marcha

```bash
npm install
npm run fetch-kv     # descarga los scripts de Valve a data-src/ (no se versionan)
npm run gen-data     # genera shared/data/*.json (ya vienen generados en el repo)
npm run build        # compila el cliente en client/dist
npm run server       # http://127.0.0.1:4060
```

En desarrollo, `npm run dev:client` levanta Vite con proxy al servidor del puerto 4060.

Variables de entorno: `PORT`, `HOST`, `DIST_DIR`, y `CHEATS=1` para los comandos de chat de prueba
(`-lvlup N`, `-gold N`, `-item clave`, `-refresh`).

## Pruebas

```bash
npm test                                              # fórmulas y mecánicas clave
npx tsx scripts/test-heroes.ts lina pudge --minutes 4  # kit completo y partidas con bots
npx tsx scripts/sim-bots.ts necropolis 42             # partida entera solo con bots
```

## Aviso

Proyecto de aficionados sin relación con Valve ni con Spirit Bear Productions. Dota 2 y sus héroes son
marcas de Valve Corporation. Los retratos e iconos se cargan de su CDN a través del propio servidor y no se incluyen en el repositorio.
