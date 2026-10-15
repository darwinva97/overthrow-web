// Textos oficiales de Dota en español (shared/data/loc.es.json, generado por scripts/gen-loc.ts).
// Se cargan aparte para no engordar el bundle; mientras tanto se usan los nombres en inglés.
import { ABILITIES, ITEMS, lv } from '../../../shared/data';

interface Text { n?: string; en?: string; d?: string; lore?: string; notes?: string[]; sc?: string; sh?: string; v?: Record<string, string> }
interface Loc { abilities: Record<string, Text>; items: Record<string, Text>; heroes: Record<string, { n?: string; hype?: string }> }

let loc: Loc | null = null;
export const locReady = import('../../../shared/data/loc.es.json').then((m) => { loc = m.default as unknown as Loc; });

export const abilityName = (k: string) => loc?.abilities[k]?.n ?? ABILITIES[k]?.name ?? k;
export const itemName = (k: string) => loc?.items[k]?.n ?? ITEMS[k]?.name ?? k;
export const heroName = (k: string, fallback: string) => loc?.heroes[k]?.n ?? fallback;
export const heroHype = (k: string) => loc?.heroes[k]?.hype ?? '';
/** Etiqueta oficial de un valor ("DAÑO:"), sin los dos puntos ni el % inicial. */
export function valueLabel(k: string, key: string, item = false): string | null {
  const t = item ? loc?.items[k] : loc?.abilities[k];
  const l = t?.v?.[key];
  return l ? l.replace(/^[%$+-]+/, '').replace(/:\s*$/, '') : null;
}

const fmt = (x: number) => (Math.round(x * 100) / 100).toString();

/** Valores por nivel "a / b / c" con el del nivel actual resaltado. */
function levels(arr: number[] | undefined, level: number, pct = false) {
  if (!arr?.length) return '';
  const u = pct ? '%' : '';
  if (arr.every((x) => x === arr[0])) return `<b>${fmt(arr[0])}${u}</b>`;
  return arr.map((x, i) => (i === level - 1 ? `<b>${fmt(x)}${u}</b>` : `${fmt(x)}${u}`)).join(' / ');
}

/** Sustituye %clave% por sus valores y %% por %. */
function fill(text: string, values: Record<string, number[]>, level: number) {
  return text
    .replace(/%([a-zA-Z0-9_]+)%%%/g, (_m, k) => (values[k] ? levels(values[k], level, true) : ''))
    .replace(/%([a-zA-Z0-9_]+)%/g, (_m, k) => (values[k] ? levels(values[k], level) : ''))
    .replace(/%%/g, '%')
    .replace(/\n/g, '<br>');
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

/** Ficha completa de una habilidad, como en el cliente de Dota. */
export function abilityTooltip(key: string, level: number, extra: { ult?: boolean; innate?: boolean; range?: number }): string {
  const d = ABILITIES[key];
  if (!d) return '';
  const t = loc?.abilities[key];
  const lvl = Math.max(1, level);
  const values = d.values;
  const head = `<h4>${esc(t?.n ?? d.name)}${t?.en && t.en !== t.n ? ` <span class="en">${esc(t.en)}</span>` : ''}</h4>` +
    `<div class="k">${extra.ult ? 'Definitiva' : extra.innate ? 'Innata' : 'Habilidad'}${d.dmgType ? ` · daño ${({ magical: 'mágico', physical: 'físico', pure: 'puro' } as Record<string, string>)[d.dmgType] ?? d.dmgType}` : ''}${d.bkbPierce ? ' · atraviesa inmunidad' : ''}</div>`;
  const desc = t?.d ? fill(t.d, values, lvl) : esc(d.desc);
  const rows: string[] = [];
  const skip = /^_|castpoint|abilitycastrange|tooltip|^max_level|scepter|shard|^zero|visualz|zchange|^does_|^require|^no_|^dispel|^attack_factor$/;
  for (const [k, arr] of Object.entries(values)) {
    if (skip.test(k) || !arr.some((x) => x !== 0)) continue;
    const label = t?.v?.[k];
    if (!label && t?.v) continue;
    const pct = !!label && label.startsWith('%');
    rows.push(`<div class="vrow"><span>${esc(label ? label.replace(/^[%$+-]+/, '').replace(/:\s*$/, '') : k.replaceAll('_', ' '))}</span><span>${levels(arr, lvl, pct)}</span></div>`);
    if (rows.length >= 10) break;
  }
  const cd = values._cd ?? d.cd, mc = values._mc ?? d.mc;
  const foot = [
    cd?.some((x) => x > 0) ? `<span class="cd">⟳ ${levels(cd, lvl)}</span>` : '',
    mc?.some((x) => x > 0) ? `<span class="mc">◆ ${levels(mc, lvl)}</span>` : '',
    extra.range ? `<span>Alcance ${extra.range}</span>` : '',
  ].filter(Boolean).join(' ');
  const aghs = [
    t?.sc ? `<div class="aghs-row sc"><b>Aghanim's Scepter</b><br>${fill(t.sc, values, lvl)}</div>` : '',
    t?.sh ? `<div class="aghs-row sh"><b>Aghanim's Shard</b><br>${fill(t.sh, values, lvl)}</div>` : '',
  ].join('');
  const notes = t?.notes?.length ? `<div class="notes">${t.notes.slice(0, 4).map((n) => `· ${fill(n, values, lvl)}`).join('<br>')}</div>` : '';
  const lore = t?.lore ? `<div class="lore">${esc(t.lore)}</div>` : '';
  return `${head}<div class="desc">${desc}</div>${rows.length ? `<div class="vals">${rows.join('')}</div>` : ''}${foot ? `<div class="foot">${foot}</div>` : ''}${aghs}${notes}${lore}`;
}

/** Ficha de item: descripción oficial con valores, receta y precio. */
export function itemTooltip(key: string, cost: number, recipe: string, pending: boolean, inInventory: boolean): string {
  const d = ITEMS[key];
  if (!d) return '';
  const t = loc?.items[key];
  const values = d.values;
  const desc = t?.d ? fill(t.d, values, 1) : esc(d.desc);
  const stats = Object.entries(values).filter(([k]) => t?.v?.[k] && !desc.includes(String(lv(values[k], 1))))
    .slice(0, 8).map(([k, arr]) => {
      const label = t!.v![k];
      return `<div class="vrow"><span>${esc(label.replace(/^[%$+-]+/, '').replace(/:\s*$/, ''))}</span><span>${label.startsWith('+') || label.startsWith('%') ? '+' : ''}${levels(arr, 1, label.includes('%'))}</span></div>`;
    }).join('');
  return `<h4>${esc(t?.n ?? d.name)}${t?.en && t.en !== t.n ? ` <span class="en">${esc(t.en)}</span>` : ''}</h4>` +
    (cost > 0 ? `<span class="cost">${cost} oro</span>` : d.tier ? `<span class="k">Neutral · tier ${d.tier}</span>` : '') +
    (recipe ? `<div class="k">${recipe}</div>` : '') +
    (stats ? `<div class="vals">${stats}</div>` : '') +
    `<div class="desc">${desc}</div>` +
    (t?.lore ? `<div class="lore">${esc(t.lore)}</div>` : '') +
    (pending ? '<div class="k">Su efecto aún no está disponible en esta versión.</div>' : '') +
    (inInventory ? '<div class="k">Arrastra para mover. Clic derecho en la base: vender.</div>' : '');
}
