// Textos en español (latinoamericano) del propio cliente de Dota: nombres, descripciones, notas,
// lore, etiquetas de valores, Scepter/Shard, talentos y héroes. Salen de los ficheros de
// localización de Valve (data-src/loc, `npm run fetch-kv`) y van a shared/data/loc.es.json.
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseKV, type KV } from './kv';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const LANG = process.env.DOTA_LANG ?? 'latam';
const read = (f: string) => {
  const kv = parseKV(readFileSync(join(root, 'data-src/loc', f), 'utf8').replace(/^﻿/, ''));
  return (kv.lang as KV).Tokens as Record<string, string>;
};
// Valve mezcla mayúsculas en las claves (Ability/ability): se buscan sin distinguirlas.
const tok: Record<string, string> = {};
for (const [k, v] of Object.entries({ ...read(`dota_${LANG}.txt`), ...read(`abilities_${LANG}.txt`) })) tok[k.toLowerCase()] = v;
const T = (k: string) => tok[k.toLowerCase()];
const abilities = JSON.parse(readFileSync(join(root, 'shared/data/abilities.json'), 'utf8'));
const items = JSON.parse(readFileSync(join(root, 'shared/data/items.json'), 'utf8'));
const heroes = JSON.parse(readFileSync(join(root, 'shared/data/heroes.json'), 'utf8'));

/** Quita el aviso "En inglés: …" y deja solo etiquetas seguras. */
function clean(s: string | undefined): string | undefined {
  if (!s) return undefined;
  return s
    .replace(/^En inglés:[^\n]*\n\n/, '')
    .replace(/#\|[a-z]+\|#/g, '')
    .replace(/<font color='(#[0-9a-fA-F]{6})'>/g, '<span style="color:$1">').replace(/<\/font>/g, '</span>')
    .replace(/<h1>/g, '<b class="h">').replace(/<\/h1>/g, '</b><br>')
    .replace(/<(?!\/?(b|i|br|span)\b)[^>]*>/g, '')
    .trim();
}
/** Nombre en inglés que el cliente en español muestra entre paréntesis. */
function english(s: string | undefined) {
  const m = s && /^En inglés: <b><font color='#[0-9A-Fa-f]+'>([^<]+)<\/font><\/b>/.exec(s);
  return m ? m[1] : undefined;
}

interface Text { n?: string; en?: string; d?: string; lore?: string; notes?: string[]; sc?: string; sh?: string; v?: Record<string, string> }

function abilityText(prefix: string, values: string[]): Text | null {
  const n = clean(T(prefix));
  if (!n) return null;
  const desc = T(`${prefix}_Description`);
  const t: Text = { n, en: english(desc) ?? english(T(`${prefix}_Lore`)), d: clean(desc), lore: clean(T(`${prefix}_Lore`)) };
  const notes: string[] = [];
  for (let i = 0; i < 12; i++) { const x = clean(T(`${prefix}_Note${i}`)); if (x) notes.push(x); }
  if (notes.length) t.notes = notes;
  t.sc = clean(T(`${prefix}_scepter_description`));
  t.sh = clean(T(`${prefix}_shard_description`));
  const v: Record<string, string> = {};
  for (const k of values) {
    const label = T(`${prefix}_${k}`);
    if (label) v[k] = clean(label)!;
  }
  if (Object.keys(v).length) t.v = v;
  for (const k of Object.keys(t) as (keyof Text)[]) if (t[k] === undefined) delete t[k];
  return t;
}

const out = { abilities: {} as Record<string, Text>, items: {} as Record<string, Text>, heroes: {} as Record<string, { n?: string; hype?: string }> };
for (const [k, a] of Object.entries<any>(abilities)) {
  const t = abilityText(`DOTA_Tooltip_ability_${k}`, Object.keys(a.values));
  if (t) out.abilities[k] = t;
}
for (const [k, it] of Object.entries<any>(items)) {
  const t = abilityText(`DOTA_Tooltip_ability_item_${k}`, Object.keys(it.values));
  if (t) out.items[k] = t;
}
for (const k of Object.keys(heroes)) {
  const full = `npc_dota_hero_${k}`;
  out.heroes[k] = { n: clean(T(`${full}:n`) ?? T(full)), hype: clean(T(`${full}_hype`)) };
}
// Talentos: "{s:valor}" se rellena con el enlace del dataset (el cliente no tiene los enlaces).
const ops = new Map<string, string>();
for (const a of Object.values<any>(abilities)) for (const l of Object.values<any>(a.links ?? {})) for (const [t, op] of Object.entries<string>(l.t ?? {})) ops.set(t, op);
for (const [k, t] of Object.entries(out.abilities)) {
  if (!k.startsWith('special_bonus') || !t.n) continue;
  const own = abilities[k]?.values?.value?.[0];
  const val = ops.get(k) ?? (own !== undefined ? String(own) : '');
  t.n = t.n.replace(/([+-]?)\{s:[^}]+\}/g, (_m: string, sign: string) => sign + (sign ? val.replace(/^[+=x-]/, '') : val.replace(/^[=x]/, ''))).replace('%%', '%');
}
writeFileSync(join(root, 'shared/data/loc.es.json'), JSON.stringify(out));
console.log(`textos: ${Object.keys(out.abilities).length} habilidades/talentos, ${Object.keys(out.items).length} items, ${Object.keys(out.heroes).length} héroes`);
