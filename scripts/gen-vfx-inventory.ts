// Inventario de nombres de efecto visual que puede mandar el servidor.
// Recorre shared/ y saca:
//   - emits: los `n` de w.emit({ n, … }) con los campos que llevan (x2, r, d, u2…)
//   - mods:  los `fx` de modificadores (u.fx en el cliente), marcando si salen de un debuff
//   - projs: los `fx` de proyectiles (incluidos los attack:<héroe> de los ataques a distancia)
//   - zones: los `fx` de zonas
// Para cada nombre guarda las habilidades o items en cuyo código aparece (`a`), que el catálogo usa
// para deducir color y forma cuando no hay una entrada escrita a mano.
//
// Uso: npx tsx scripts/gen-vfx-inventory.ts   → client/src/render/vfx/inventory.json
import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SHARED = join(root, 'shared');
const OUT = join(root, 'client/src/render/vfx/inventory.json');

type Kind = 'emits' | 'mods' | 'projs' | 'zones';
interface Entry { a: Set<string>; f: Set<string>; files: Set<string>; debuff: boolean }
const inv: Record<Kind, Map<string, Entry>> = { emits: new Map(), mods: new Map(), projs: new Map(), zones: new Map() };

function add(kind: Kind, name: string, owner: string | null, file: string, fields: string[] = [], debuff = false) {
  if (!name || /[^a-z0-9_:]/i.test(name)) return;
  let e = inv[kind].get(name);
  if (!e) { e = { a: new Set(), f: new Set(), files: new Set(), debuff: false }; inv[kind].set(name, e); }
  if (owner) e.a.add(owner);
  for (const f of fields) e.f.add(f);
  e.files.add(file);
  if (debuff) e.debuff = true;
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return f === 'data' ? [] : walk(p);
    return p.endsWith('.ts') ? [p] : [];
  });
}

/** Índice del carácter que cierra el bloque abierto en `i` ({ ( [). Ignora cadenas simples. */
function closeOf(s: string, i: number): number {
  let depth = 0;
  for (let k = i; k < s.length; k++) {
    const ch = s[k];
    if (ch === "'" || ch === '"' || ch === '`') { const q = ch; k++; while (k < s.length && s[k] !== q) { if (s[k] === '\\') k++; k++; } continue; }
    if (ch === '{' || ch === '(' || ch === '[') depth++;
    else if (ch === '}' || ch === ')' || ch === ']') { depth--; if (depth === 0) return k; }
  }
  return s.length;
}

/** Llave `{` que abre el objeto literal que contiene la posición `i`. */
function openOf(s: string, i: number): number {
  let depth = 0;
  for (let k = i; k >= 0; k--) {
    const ch = s[k];
    if (ch === '}' || ch === ')' || ch === ']') depth++;
    else if (ch === '{' || ch === '(' || ch === '[') { if (depth === 0) return ch === '{' ? k : -1; depth--; }
  }
  return -1;
}

/** Expresión tras `fx:` hasta la coma o cierre al mismo nivel. */
function exprAfter(s: string, i: number): string {
  let depth = 0, k = i;
  for (; k < s.length; k++) {
    const ch = s[k];
    if (ch === "'" || ch === '"' || ch === '`') { const q = ch; k++; while (k < s.length && s[k] !== q) k++; continue; }
    if (ch === '{' || ch === '(' || ch === '[') depth++;
    else if (ch === '}' || ch === ')' || ch === ']') { if (depth === 0) break; depth--; }
    else if ((ch === ',' || ch === ';' || ch === '\n') && depth === 0) break;
  }
  return s.slice(i, k);
}

const strings = (expr: string) => [...expr.matchAll(/'([^'\\]*)'/g)].map((m) => m[1]);

/** Dueños (habilidad o item) por posición en el fichero. */
function owners(src: string, file: string) {
  const marks: { at: number; key: string }[] = [];
  for (const m of src.matchAll(/(?:defineAbility|defineItem)\(\{\s*key:\s*'([^']+)'/g)) marks.push({ at: m.index!, key: m[1] });
  for (const m of src.matchAll(/\b[a-z][A-Za-z]*(?:Item|Consumable|Spell|Aura)\('([a-z0-9_]+)'/g)) marks.push({ at: m.index!, key: m[1] });
  marks.sort((a, b) => a.at - b.at);
  const hero = file.includes('/heroes/') && !file.includes('/lib/') ? file.split('/').pop()!.replace(/\.ts$/, '') : null;
  return (i: number) => {
    let best: string | null = null;
    for (const m of marks) { if (m.at > i) break; best = m.key; }
    return best ?? hero;
  };
}

/** Funciones con un parámetro que acaba en `fx:` o `n:`: se resuelven con los literales de sus llamadas. */
interface DynFn { name: string; arg: number; kind: 'fx' | 'n'; file: string }
const dynFns: DynFn[] = [];

const files = walk(SHARED);
const sources = new Map(files.map((f) => [f, readFileSync(f, 'utf8')]));

for (const [file, src] of sources) {
  for (const m of src.matchAll(/(?:function\s+([A-Za-z0-9_]+)\s*\(|(?:const|let)\s+([A-Za-z0-9_]+)\s*=\s*\()([^)]*)\)/g)) {
    const name = m[1] ?? m[2];
    const params = m[3].split(',').map((p) => p.trim().split(/[:=?\s]/)[0]).filter(Boolean);
    const bodyStart = src.indexOf('{', m.index! + m[0].length);
    if (bodyStart < 0) continue;
    const body = src.slice(bodyStart, closeOf(src, bodyStart) + 1);
    params.forEach((p, idx) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(p)) return;
      // `fx: p`, o un parámetro llamado `fx` usado como propiedad abreviada ({ fx, … }).
      const asFx = new RegExp(`\\bfx:\\s*${p}\\s*[,}\\n]`).test(body) || (p === 'fx' && /[{,]\s*fx\s*[,}]/.test(body));
      const asN = new RegExp(`emit\\(\\{\\s*n:\\s*${p}\\b`).test(body);
      if (asFx) dynFns.push({ name, arg: idx, kind: 'fx', file });
      if (asN) dynFns.push({ name, arg: idx, kind: 'n', file });
    });
  }
}

/** Divide los argumentos de una llamada al nivel superior. */
function splitArgs(s: string): string[] {
  const out: string[] = [];
  let depth = 0, cur = '';
  for (let k = 0; k < s.length; k++) {
    const ch = s[k];
    if (ch === "'" || ch === '"' || ch === '`') { const q = ch; let j = k + 1; while (j < s.length && s[j] !== q) j++; cur += s.slice(k, j + 1); k = j; continue; }
    if (ch === '{' || ch === '(' || ch === '[') depth++;
    if (ch === '}' || ch === ')' || ch === ']') depth--;
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Clasifica el objeto literal que contiene un `fx:`. */
function classify(src: string, at: number): { kind: Kind; debuff: boolean } {
  const open = openOf(src, at);
  const obj = open >= 0 ? src.slice(open, closeOf(src, open) + 1) : '';
  const before = src.slice(Math.max(0, open - 60), open);
  const head = obj.slice(0, 400);
  if (/addZone\(\s*$/.test(before) || /\binterval:/.test(head) && /\bteam:/.test(head) && /\br[,:]/.test(head) && !/\bname:/.test(head)) return { kind: 'zones', debuff: false };
  if (/\bkind:\s*'(?:track|linear)'/.test(head) || /addProjectile\(\s*$/.test(before)) return { kind: 'projs', debuff: false };
  return { kind: 'mods', debuff: /\b(?:debuff|stun|slow|root|silence|hex|fear|dot|knockFrom|taunt)\(\s*[^)]*$/.test(before) || /debuff/.test(before) };
}

for (const [file, src] of sources) {
  const rel = relative(root, file);
  const ownerAt = owners(src, file);
  const consts = new Map([...src.matchAll(/const\s+([A-Z0-9_]+)\s*=\s*'([^']+)'/g)].map((m) => [m[1], m[2]]));

  // emit({ n: '…', … })
  for (const m of src.matchAll(/emit\(\{/g)) {
    const open = m.index! + m[0].length - 1;
    const obj = src.slice(open, closeOf(src, open) + 1);
    const nm = /\bn:\s*'([^']+)'/.exec(obj);
    if (!nm) continue;
    const fields = [...obj.matchAll(/[{,]\s*(x2|y2|r|d|u|u2|v|c|t)\s*[:,}]/g)].map((x) => x[1]);
    add('emits', nm[1], ownerAt(m.index!), rel, fields);
  }

  // fx: '…'  ·  fx: cond ? 'a' : 'b'  ·  fx: X ?? 'y'  ·  fx: CONST
  for (const m of src.matchAll(/\bfx:\s*/g)) {
    const at = m.index!;
    const expr = exprAfter(src, at + m[0].length);
    let names = strings(expr);
    const id = /^([A-Z0-9_]+)\s*$/.exec(expr.trim());
    if (id && consts.has(id[1])) names = [consts.get(id[1])!];
    if (/^'attack:'\s*\+/.test(expr.trim())) continue; // se resuelve aparte
    if (!names.length) continue;
    const { kind, debuff } = classify(src, at);
    for (const n of names) add(kind, n, ownerAt(at), rel, [], debuff);
  }

  // Objetos con `fx` abreviado ({ fx, … }) dentro de addZone/addProjectile: se resuelven por las funciones dinámicas.
}

// Llamadas a funciones con parámetro de efecto: lineZones(w, 'ice_path', …), barrier('x', …, 'barrier')…
for (const fn of dynFns) {
  for (const [file, src] of sources) {
    if (!src.includes(fn.name + '(')) continue;
    const rel = relative(root, file);
    const ownerAt = owners(src, file);
    for (const m of src.matchAll(new RegExp(`(?<![A-Za-z0-9_.])${fn.name}\\(`, 'g'))) {
      const open = m.index! + m[0].length - 1;
      const args = splitArgs(src.slice(open + 1, closeOf(src, open)));
      const lit = /^'([^']+)'$/.exec(args[fn.arg] ?? '');
      if (!lit) continue;
      if (fn.kind === 'n') { add('emits', lit[1], ownerAt(m.index!), rel); continue; }
      // ¿Qué crea la función con ese fx?
      const fsrc = sources.get(fn.file)!;
      const def = new RegExp(`(?:function\\s+${fn.name}\\s*\\(|const\\s+${fn.name}\\s*=)`).exec(fsrc);
      const bodyAt = def ? fsrc.indexOf('{', def.index + def[0].length) : -1;
      const body = bodyAt >= 0 ? fsrc.slice(bodyAt, closeOf(fsrc, bodyAt)) : '';
      const kind: Kind = /addZone\(/.test(body) ? 'zones' : /addProjectile\(/.test(body) ? 'projs' : 'mods';
      add(kind, lit[1], ownerAt(m.index!), rel, [], /debuff\(/.test(body));
    }
  }
}

// Proyectiles de ataque: 'attack:' + clave del héroe o de la unidad.
const heroes = JSON.parse(readFileSync(join(SHARED, 'data/heroes.json'), 'utf8')) as Record<string, { melee: boolean }>;
const units = JSON.parse(readFileSync(join(SHARED, 'data/units.json'), 'utf8')) as Record<string, { melee?: boolean; canAttack?: boolean }>;
for (const [k, h] of Object.entries(heroes)) if (!h.melee) add('projs', 'attack:' + k, null, 'shared/sim/combat.ts');
for (const [k, u] of Object.entries(units)) if (u.melee === false && u.canAttack !== false) add('projs', 'attack:' + k, null, 'shared/sim/combat.ts');
add('projs', 'attack:fountain', null, 'shared/sim/combat.ts');

// Evento de lanzamiento que emite el mundo en cada cast.
add('emits', 'cast', null, 'shared/sim/world.ts', ['u', 'u2', 'c', 't']);

const out: Record<string, Record<string, { a?: string[]; f?: string[]; debuff?: 1 }>> = {};
let total = 0;
for (const kind of Object.keys(inv) as Kind[]) {
  out[kind] = {};
  for (const name of [...inv[kind].keys()].sort()) {
    const e = inv[kind].get(name)!;
    const o: { a?: string[]; f?: string[]; debuff?: 1 } = {};
    if (e.a.size) o.a = [...e.a].sort().slice(0, 6);
    if (e.f.size) o.f = [...e.f].sort();
    if (e.debuff) o.debuff = 1;
    out[kind][name] = o;
    total++;
  }
}
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(out, null, 0).replace(/\},"/g, '},\n"') + '\n');
console.log(`inventario: ${Object.keys(out.emits).length} emits, ${Object.keys(out.mods).length} mods, ${Object.keys(out.projs).length} proyectiles, ${Object.keys(out.zones).length} zonas (${total} entradas) → ${relative(root, OUT)}`);
console.log('funciones dinámicas:', dynFns.map((f) => `${f.name}#${f.arg}(${f.kind})`).join(' '));
