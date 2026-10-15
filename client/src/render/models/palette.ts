// Textura de paleta compartida por todos los modelos 3D: cada modelo reserva una fila y
// cada color de esa fila es una casilla. Los vértices apuntan a su casilla con la UV, así que
// todas las unidades comparten un único material y cada una sale en una sola llamada de dibujo.
// Una segunda textura igual, la de brillo, hace de mapa de emisión (ojos, gemas, fuego…).
import * as THREE from 'three';

export const PAL_W = 32;
export const PAL_H = 512;

const color = new Uint8Array(PAL_W * PAL_H * 4);
const glow = new Uint8Array(PAL_W * PAL_H * 4);

function makeTex(data: Uint8Array) {
  const t = new THREE.DataTexture(data, PAL_W, PAL_H, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.colorSpace = THREE.SRGBColorSpace;
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}

export const paletteTex = makeTex(color);
export const glowTex = makeTex(glow);

const rows = new Map<string, PaletteRow>();
let nextRow = 0;

const tmp = new THREE.Color();
function rgb(hex: string): [number, number, number] {
  tmp.set(hex);
  // THREE.Color guarda lineal; la textura es sRGB.
  tmp.convertLinearToSRGB();
  return [Math.round(tmp.r * 255), Math.round(tmp.g * 255), Math.round(tmp.b * 255)];
}

/** Fila de la paleta de un modelo: colores → casillas. */
export class PaletteRow {
  readonly row: number;
  private slots = new Map<string, number>();
  constructor(row: number) { this.row = row; }

  /** UV de un color (y de su brillo si `lit` > 0, de 0 a 1). */
  uv(hex: string, lit = 0): [number, number] {
    const key = hex + '|' + lit;
    let s = this.slots.get(key);
    if (s === undefined) {
      s = this.slots.size;
      if (s >= PAL_W) s = PAL_W - 1; // sin sitio: comparte la última casilla
      else {
        this.slots.set(key, s);
        const i = (this.row * PAL_W + s) * 4;
        const [r, g, b] = rgb(hex);
        color[i] = r; color[i + 1] = g; color[i + 2] = b; color[i + 3] = 255;
        glow[i] = Math.round(r * lit); glow[i + 1] = Math.round(g * lit); glow[i + 2] = Math.round(b * lit); glow[i + 3] = 255;
        paletteTex.needsUpdate = true;
        glowTex.needsUpdate = true;
      }
    }
    return [(s + 0.5) / PAL_W, (this.row + 0.5) / PAL_H];
  }
}

export function paletteRow(key: string): PaletteRow {
  let r = rows.get(key);
  if (!r) { r = new PaletteRow(nextRow); nextRow = (nextRow + 1) % PAL_H; rows.set(key, r); }
  return r;
}
