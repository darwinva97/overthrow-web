// Dibujo del Frame de efectos en Canvas 2D.
// Los sprites se tiñen una sola vez por (forma, color, calor, mezcla) y se cachean: en cada frame
// solo hay drawImage con globalAlpha. Nada de gradientes por frame ni save/clip por partícula.
// Coordenadas de mundo (el lienzo ya trae la transformación de cámara); la altura z se proyecta
// hacia arriba en pantalla con el factor K.
import { ATLAS_CELL, ATLAS_CELLS, atlasPixels, SH } from './atlas';
import { BM, DC, DECAL, type Frame, SL, SP } from './frame';

const TAU = Math.PI * 2;
const SPRITE_PX = 64;
/** Hoja de sprites tintados: una sola imagen fuente para todos los drawImage (una textura en la GPU). */
const SHEET_CELLS = 32;
const CACHE_MAX = SHEET_CELLS * SHEET_CELLS;
/** Sprites nuevos que se pueden tintar por frame (el resto espera al siguiente). */
const BAKES_PER_FRAME = 16;
/** Formas que se notan giradas; el resto se dibuja sin rotar (más barato). */
const ROTATES = new Set<number>([SH.STAR, SH.SHARD, SH.CROSS, SH.LEAF, SH.SWIRL, SH.CHEVRON, SH.BOLT, SH.FLAME, SH.SNOW]);

export class CanvasVfx {
  /** Clave del sprite → índice de celda en la hoja. */
  private cache = new Map<number, number>();
  private sheet: HTMLCanvasElement;
  private sheetCtx: CanvasRenderingContext2D;
  private cellImg: ImageData;
  private colors = new Map<number, string>();
  private bakes = 0;
  /** Matriz base del lienzo (mundo → píxeles) al empezar a dibujar. */
  private m = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

  readonly K: number;
  constructor(K = 0.35) {
    this.K = K;
    this.sheet = document.createElement('canvas');
    this.sheet.width = this.sheet.height = SHEET_CELLS * SPRITE_PX;
    this.sheetCtx = this.sheet.getContext('2d')!;
    this.cellImg = this.sheetCtx.createImageData(SPRITE_PX, SPRITE_PX);
  }

  // ------------------------------------------------------------ cachés

  private q(v: number) { return Math.max(0, Math.min(31, Math.round(v * 31))); }

  /** Celda del sprite tintado (64 px): rgb = mezcla(color, blanco, núcleo·calor), alfa = máscara. -1 si aún no se puede tintar. */
  private sprite(shape: number, r: number, g: number, b: number, hot: number, normal: boolean): number {
    const qr = this.q(r), qg = this.q(g), qb = this.q(b), qh = normal ? 0 : Math.min(3, Math.round(hot * 3));
    const key = (((shape * 4 + qh) * 2 + (normal ? 1 : 0)) * 32 + qr) * 1024 + qg * 32 + qb;
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit;
    if (this.bakes++ >= BAKES_PER_FRAME) return -1;
    if (this.cache.size >= CACHE_MAX) this.cache.clear();
    const cell = this.cache.size;
    const [mask, core] = this.shapeMask(shape);
    const cr = qr / 31, cg = qg / 31, cb = qb / 31, h = (qh / 3) * 0.6;
    const d = this.cellImg.data;
    for (let p = 0, o = 0; p < mask.length; p++, o += 4) {
      // El lienzo 2D satura antes con 'lighter': núcleo algo más tenue que en 3D.
      const w = Math.min(1, core[p] * h);
      d[o] = (cr + (1 - cr) * w) * 255;
      d[o + 1] = (cg + (1 - cg) * w) * 255;
      d[o + 2] = (cb + (1 - cb) * w) * 255;
      d[o + 3] = mask[p] * 255;
    }
    this.sheetCtx.putImageData(this.cellImg, (cell % SHEET_CELLS) * SPRITE_PX, Math.floor(cell / SHEET_CELLS) * SPRITE_PX);
    this.cache.set(key, cell);
    return cell;
  }

  /** drawImage de una celda de la hoja. */
  private blit(c: CanvasRenderingContext2D, cell: number, x: number, y: number, w: number, h: number) {
    c.drawImage(this.sheet, (cell % SHEET_CELLS) * SPRITE_PX + 0.5, Math.floor(cell / SHEET_CELLS) * SPRITE_PX + 0.5, SPRITE_PX - 1, SPRITE_PX - 1, x, y, w, h);
  }

  private masks = new Map<number, [Float32Array, Float32Array]>();
  /** Máscara y núcleo de una forma, reducidos a 64 px (una vez por forma). */
  private shapeMask(shape: number): [Float32Array, Float32Array] {
    let m = this.masks.get(shape);
    if (m) return m;
    const src = atlasPixels();
    const W = src.width, step = ATLAS_CELL / SPRITE_PX;
    const ox = (shape % ATLAS_CELLS) * ATLAS_CELL, oy = Math.floor(shape / ATLAS_CELLS) * ATLAS_CELL;
    const mask = new Float32Array(SPRITE_PX * SPRITE_PX), core = new Float32Array(SPRITE_PX * SPRITE_PX);
    for (let py = 0; py < SPRITE_PX; py++) for (let px = 0; px < SPRITE_PX; px++) {
      let a = 0, c = 0;
      for (let sy = 0; sy < step; sy++) for (let sx = 0; sx < step; sx++) {
        const i = ((oy + py * step + sy) * W + ox + px * step + sx) * 4;
        a += src.data[i]; c += src.data[i + 1];
      }
      mask[py * SPRITE_PX + px] = a / (step * step * 255);
      core[py * SPRITE_PX + px] = c / (step * step * 255);
    }
    m = [mask, core];
    this.masks.set(shape, m);
    return m;
  }

  private rgb(r: number, g: number, b: number) {
    const key = this.q(r) * 1024 + this.q(g) * 32 + this.q(b);
    let s = this.colors.get(key);
    if (!s) { s = `rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)})`; this.colors.set(key, s); }
    return s;
  }

  private base(c: CanvasRenderingContext2D) {
    const t = c.getTransform();
    this.m.a = t.a; this.m.b = t.b; this.m.c = t.c; this.m.d = t.d; this.m.e = t.e; this.m.f = t.f;
  }
  private reset(c: CanvasRenderingContext2D) { const m = this.m; c.setTransform(m.a, m.b, m.c, m.d, m.e, m.f); }

  // ------------------------------------------------------------ suelo

  /** Formas en el suelo, bajo las unidades. */
  drawGround(c: CanvasRenderingContext2D, fr: Frame, px: number) {
    this.bakes = 0;
    this.base(c);
    c.lineCap = 'round';
    // En 2D el suelo es claro: los trazos se pintan con mezcla normal (con 'lighter' todo acaba blanco)
    // y solo los discos de brillo suman luz.
    c.globalCompositeOperation = 'source-over';
    this.decals(c, fr.dcN, fr.nDN, px, true);
    this.decals(c, fr.dcA, fr.nDA, px, false);
    c.globalCompositeOperation = 'source-over';
    c.globalAlpha = 1;
  }

  private decals(c: CanvasRenderingContext2D, d: Float32Array, n: number, px: number, normal: boolean) {
    for (let k = 0; k < n; k++) {
      const i = k * DC;
      const x = d[i], y = d[i + 1], sx = d[i + 3], sy = d[i + 4], rot = d[i + 5];
      const r = d[i + 6], g = d[i + 7], b = d[i + 8], a = Math.min(1, d[i + 9]), type = d[i + 10], p1 = d[i + 11];
      switch (type) {
        case DECAL.DISC: {
          const img = this.sprite(SH.GLOW, r, g, b, 0.3, normal);
          if (img < 0) break;
          const s = sx * 2.3;
          c.globalAlpha = a * 0.7;
          if (!normal) c.globalCompositeOperation = 'lighter';
          this.blit(c, img, x - s / 2, y - s / 2, s, s);
          c.globalCompositeOperation = 'source-over';
          break;
        }
        case DECAL.RING: {
          const th = Math.max(0.02, p1);
          c.globalAlpha = a * 0.9;
          c.strokeStyle = this.rgb(r, g, b);
          c.lineWidth = Math.max(2 * px, sx * th);
          c.beginPath(); c.arc(x, y, sx * (1 - th), 0, TAU); c.stroke();
          break;
        }
        case DECAL.WARN: {
          const col = this.rgb(r, g, b);
          c.fillStyle = col;
          c.globalAlpha = a * 0.14;
          c.beginPath(); c.arc(x, y, sx, 0, TAU); c.fill();
          c.globalAlpha = a * 0.22;
          c.beginPath(); c.arc(x, y, Math.max(1, sx * p1), 0, TAU); c.fill();
          c.globalAlpha = a;
          c.strokeStyle = col; c.lineWidth = Math.max(3 * px, sx * 0.05);
          c.beginPath(); c.arc(x, y, sx * 0.97, 0, TAU); c.stroke();
          c.globalAlpha = a * 0.6; c.lineWidth = Math.max(2 * px, sx * 0.025);
          c.beginPath(); c.arc(x, y, Math.max(1, sx * p1), 0, TAU); c.stroke();
          break;
        }
        case DECAL.CONE: {
          const col = this.rgb(r, g, b);
          c.fillStyle = col;
          c.globalAlpha = a * 0.4;
          c.beginPath(); c.moveTo(x, y); c.arc(x, y, sx, rot - p1, rot + p1); c.closePath(); c.fill();
          c.globalAlpha = a * 0.9; c.strokeStyle = col; c.lineWidth = Math.max(3 * px, sx * 0.05);
          c.beginPath(); c.arc(x, y, sx * 0.97, rot - p1, rot + p1); c.stroke();
          break;
        }
        case DECAL.LINE: {
          const dx = Math.cos(rot), dy = Math.sin(rot), qx = -dy * sx, qy = dx * sx, lx = dx * sy, ly = dy * sy;
          const col = this.rgb(r, g, b);
          c.fillStyle = col;
          c.globalAlpha = a * 0.45;
          c.beginPath();
          c.moveTo(x - lx - qx, y - ly - qy); c.lineTo(x + lx - qx, y + ly - qy); c.lineTo(x + lx + qx, y + ly + qy); c.lineTo(x - lx + qx, y - ly + qy);
          c.closePath(); c.fill();
          c.globalAlpha = a * 0.8; c.strokeStyle = col; c.lineWidth = Math.max(2 * px, sx * 0.12);
          c.beginPath();
          c.moveTo(x - lx - qx * 0.9, y - ly - qy * 0.9); c.lineTo(x + lx - qx * 0.9, y + ly - qy * 0.9);
          c.moveTo(x - lx + qx * 0.9, y - ly + qy * 0.9); c.lineTo(x + lx + qx * 0.9, y + ly + qy * 0.9);
          c.stroke();
          break;
        }
        case DECAL.RUNES: {
          const col = this.rgb(r, g, b);
          c.strokeStyle = col; c.globalAlpha = a * 0.85;
          c.lineWidth = Math.max(2 * px, sx * 0.04);
          c.beginPath(); c.arc(x, y, sx * 0.94, 0, TAU); c.stroke();
          c.lineWidth = Math.max(1.5 * px, sx * 0.025);
          c.beginPath(); c.arc(x, y, sx * 0.56, 0, TAU); c.stroke();
          c.beginPath();
          for (let t = 0; t < 12; t++) {
            const an = rot + (t * TAU) / 12;
            const cs = Math.cos(an), sn = Math.sin(an);
            c.moveTo(x + cs * sx * 0.64, y + sn * sx * 0.64); c.lineTo(x + cs * sx * 0.82, y + sn * sx * 0.82);
          }
          for (let t = 0; t < 3; t++) {
            // Triángulo inscrito girando: dos dan la estrella de seis puntas.
            const an = rot * -1.5 + (t * TAU) / 3, an2 = an + TAU / 3;
            c.moveTo(x + Math.cos(an) * sx * 0.56, y + Math.sin(an) * sx * 0.56);
            c.lineTo(x + Math.cos(an2) * sx * 0.56, y + Math.sin(an2) * sx * 0.56);
          }
          c.stroke();
          break;
        }
      }
    }
  }

  // ------------------------------------------------------------ aire

  /** Escudos, haces y sprites, encima de las unidades. */
  drawAir(c: CanvasRenderingContext2D, fr: Frame, px: number) {
    this.base(c);
    const K = this.K;
    c.globalCompositeOperation = 'lighter';
    // Escudos: burbuja tintada.
    const s = fr.sl;
    for (let k = 0; k < fr.nS; k++) {
      const i = k * SL;
      const img = this.sprite(SH.BUBBLE, s[i + 4], s[i + 5], s[i + 6], 0.8, false);
      if (img < 0) continue;
      const rad = s[i + 3], sq = s[i + 8];
      c.globalAlpha = Math.min(1, s[i + 7]);
      this.blit(c, img, s[i] - rad, s[i + 1] - s[i + 2] * K - rad * sq, rad * 2, rad * 2 * sq);
    }
    // Haces: trazo de color y núcleo claro.
    const b = fr.bm;
    c.lineCap = 'round';
    for (let k = 0; k < fr.nB; k++) {
      const i = k * BM;
      const x1 = b[i], y1 = b[i + 1] - b[i + 2] * K, x2 = b[i + 3], y2 = b[i + 4] - b[i + 5] * K;
      const w = Math.max(1.5 * px, b[i + 6] * 0.5), a = Math.min(1, b[i + 10]);
      c.strokeStyle = this.rgb(b[i + 7], b[i + 8], b[i + 9]);
      c.globalAlpha = a * 0.45; c.lineWidth = w * 1.6;
      c.beginPath(); c.moveTo(x1, y1); c.lineTo(x2, y2); c.stroke();
      c.globalAlpha = a; c.lineWidth = w * 0.7;
      c.stroke();
    }
    // Sprites con mezcla normal (humo, polvo) y luego los aditivos.
    c.globalCompositeOperation = 'source-over';
    this.sprites(c, fr.spN, fr.nN, true);
    c.globalCompositeOperation = 'lighter';
    this.sprites(c, fr.spA, fr.nA, false);
    c.globalCompositeOperation = 'source-over';
    c.globalAlpha = 1;
    this.reset(c);
  }

  private sprites(c: CanvasRenderingContext2D, d: Float32Array, n: number, normal: boolean) {
    const K = this.K, m = this.m;
    // Por debajo de ~2,5 px en pantalla no se ve: no se dibuja.
    const minSize = 2.5 / Math.max(1e-6, Math.abs(m.a));
    for (let k = 0; k < n; k++) {
      const i = k * SP;
      const size = d[i + 3];
      if (size < minSize) continue;
      const shape = d[i + 8], rot = d[i + 9];
      const img = this.sprite(shape, d[i + 4], d[i + 5], d[i + 6], d[i + 10], normal);
      if (img < 0) continue;
      const x = d[i], y = d[i + 1] - d[i + 2] * K;
      c.globalAlpha = Math.min(1, d[i + 7]);
      if (rot !== 0 && ROTATES.has(shape)) {
        const cs = Math.cos(rot), sn = Math.sin(rot);
        c.setTransform(m.a * cs + m.c * sn, m.b * cs + m.d * sn, -m.a * sn + m.c * cs, -m.b * sn + m.d * cs, m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f);
        this.blit(c, img, -size / 2, -size / 2, size, size);
        c.setTransform(m.a, m.b, m.c, m.d, m.e, m.f);
      } else this.blit(c, img, x - size / 2, y - size / 2, size, size);
    }
  }
}
