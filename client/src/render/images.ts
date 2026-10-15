// Caché de imágenes (retratos, iconos). Pasan por /cdn del propio servidor.
const cache = new Map<string, HTMLImageElement>();

export function img(url: string): HTMLImageElement {
  let i = cache.get(url);
  if (!i) {
    i = new Image();
    i.crossOrigin = 'anonymous';
    i.decoding = 'async';
    i.src = url;
    cache.set(url, i);
  }
  return i;
}
export const ready = (i: HTMLImageElement) => i.complete && i.naturalWidth > 0;
