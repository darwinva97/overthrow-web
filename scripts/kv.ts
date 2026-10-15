// Parser del formato KeyValues de Valve (los .txt de scripts/npc).
// Devuelve objetos anidados; si una clave se repite, gana la última.
export type KV = { [k: string]: string | KV };

export function parseKV(src: string): KV {
  let i = 0;
  const n = src.length;
  const skip = () => {
    for (;;) {
      while (i < n && /\s/.test(src[i])) i++;
      if (src[i] === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }
      break;
    }
  };
  const token = (): string | null => {
    skip();
    if (i >= n) return null;
    const c = src[i];
    if (c === '{' || c === '}') { i++; return c; }
    if (c === '"') {
      i++;
      let s = '';
      while (i < n && src[i] !== '"') { if (src[i] === '\\' && i + 1 < n) { s += src[i + 1]; i += 2; } else s += src[i++]; }
      i++;
      return s;
    }
    let s = '';
    while (i < n && !/[\s{}"]/.test(src[i])) s += src[i++];
    return s;
  };
  const block = (): KV => {
    const o: KV = {};
    for (;;) {
      const k = token();
      if (k === null || k === '}') return o;
      if (k === '{') continue;
      skip();
      // Condiciones de plataforma tipo [$WIN32] tras la clave.
      if (src[i] === '[') { while (i < n && src[i] !== ']') i++; i++; skip(); }
      if (src[i] === '{') { i++; o[k] = block(); }
      else {
        const v = token();
        if (v === null) return o;
        if (v === '{') { o[k] = block(); continue; }
        o[k] = v;
        skip();
        if (src[i] === '[') { while (i < n && src[i] !== ']') i++; i++; }
      }
    }
  };
  return block();
}

export const nums = (s: string | undefined): number[] =>
  !s ? [] : s.trim().split(/\s+/).map((t) => parseFloat(t.replace('%', ''))).filter((x) => Number.isFinite(x));
