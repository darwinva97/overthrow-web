// Descarga los scripts de Valve del parche actual (extraídos por dotabuff/d2vpkr)
// a data-src/kv. Son datos, no código: solo los lee scripts/gen-data.ts.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'data-src/kv');
mkdirSync(join(out, 'heroes'), { recursive: true });
const RAW = 'https://raw.githubusercontent.com/dotabuff/d2vpkr/master/dota/scripts/npc';

async function get(path: string) {
  const r = await fetch(`${RAW}/${path}`);
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.text();
}

for (const f of ['npc_heroes.txt', 'npc_abilities.txt', 'items.txt', 'neutral_items.txt', 'npc_units.txt']) {
  writeFileSync(join(out, f), await get(f));
  console.log('ok', f);
}
const list = await (await fetch('https://api.github.com/repos/dotabuff/d2vpkr/contents/dota/scripts/npc/heroes')).json() as { name: string }[];
let n = 0;
await Promise.all(list.filter((x) => x.name.endsWith('.txt')).map(async (x) => {
  writeFileSync(join(out, 'heroes', x.name), await get(`heroes/${x.name}`));
  n++;
}));
console.log('héroes', n);

// Textos oficiales en español (latinoamericano y de España).
mkdirSync(join(root, 'data-src/loc'), { recursive: true });
const LOC = 'https://raw.githubusercontent.com/dotabuff/d2vpkr/master/dota/resource/localization';
for (const f of ['abilities_latam', 'dota_latam', 'abilities_spanish', 'dota_spanish']) {
  const r = await fetch(`${LOC}/${f}.txt`);
  if (r.ok) writeFileSync(join(root, 'data-src/loc', `${f}.txt`), await r.text());
}
console.log('textos ok');
