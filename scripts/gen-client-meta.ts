// Genera los datos que necesita el cliente sin cargar la simulación entera:
// - shared/data/meta.json: héroes jugables e items que se venden de verdad.
// - shared/data/*.client.json: versiones ligeras de habilidades y unidades (sin enlaces ni stats de servidor).
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import '../shared/heroes';
import '../shared/items';
import '../shared/items/neutral';
import { ABILITIES, UNITS } from '../shared/data';
import { HERO_KITS } from '../shared/sim/abilities';
import { shopItems } from '../shared/sim/items';

const out = join(dirname(fileURLToPath(import.meta.url)), '../shared/data');
const shop = shopItems().map((d) => d.key);
writeFileSync(join(out, 'meta.json'), JSON.stringify({ playable: Object.keys(HERO_KITS).sort(), shop }));
const abil: Record<string, unknown> = {};
for (const [k, a] of Object.entries(ABILITIES)) {
  abil[k] = { key: k, name: a.name, desc: a.desc, behavior: a.behavior, dmgType: a.dmgType, ult: a.ult, innate: a.innate,
    targetTeam: a.targetTeam, cd: a.cd, mc: a.mc, values: a.values, links: {}, grantedBy: a.grantedBy, maxLevel: a.maxLevel };
}
writeFileSync(join(out, 'abilities.client.json'), JSON.stringify(abil));
const units: Record<string, unknown> = {};
for (const [k, u] of Object.entries(UNITS)) units[k] = { key: k, flying: u.flying, scale: u.scale, melee: u.melee, level: u.level };
writeFileSync(join(out, 'units.client.json'), JSON.stringify(units));
console.log(`meta: ${Object.keys(HERO_KITS).length} héroes, ${shop.length} items de tienda`);
