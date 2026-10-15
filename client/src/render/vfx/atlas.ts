// Atlas de formas de partícula, compartido por los dos modos.
// 4×4 celdas de 128 px. Canal R = máscara (alfa de la forma), canal G = núcleo caliente
// (la parte que se pinta casi blanca en los brillos aditivos). Se dibuja una sola vez.

export const SH = {
  GLOW: 0, SPARK: 1, STAR: 2, SMOKE: 3, RING: 4, SHARD: 5, CROSS: 6, FLAME: 7,
  DROP: 8, SWIRL: 9, LEAF: 10, SKULL: 11, SNOW: 12, BUBBLE: 13, CHEVRON: 14, BOLT: 15,
} as const;
export type Shape = (typeof SH)[keyof typeof SH];

export const ATLAS_CELLS = 4;
export const ATLAS_CELL = 128;

let atlas: HTMLCanvasElement | null = null;

/** Lienzo del atlas (se crea la primera vez). */
export function shapeAtlas(): HTMLCanvasElement {
  if (atlas) return atlas;
  const N = ATLAS_CELLS, C = ATLAS_CELL;
  const cv = document.createElement('canvas');
  cv.width = cv.height = N * C;
  const g = cv.getContext('2d')!;
  g.fillStyle = '#000';
  g.fillRect(0, 0, cv.width, cv.height);
  g.globalCompositeOperation = 'lighter';
  const R = (a: number) => `rgba(255,0,0,${a})`;
  const Gc = (a: number) => `rgba(0,255,0,${a})`;
  const cell = (i: number, draw: (h: number) => void) => {
    const cx = (i % N) * C + C / 2, cy = Math.floor(i / N) * C + C / 2;
    g.save();
    g.beginPath(); g.rect(cx - C / 2, cy - C / 2, C, C); g.clip();
    g.translate(cx, cy);
    draw(C / 2 - 4);
    g.restore();
  };
  const radial = (r: number, stops: [number, string][]) => {
    const gr = g.createRadialGradient(0, 0, 0, 0, 0, r);
    for (const [o, c] of stops) gr.addColorStop(o, c);
    g.fillStyle = gr;
    g.fillRect(-r, -r, r * 2, r * 2);
  };
  const poly = (pts: [number, number][], fill: string, blur = 0) => {
    g.shadowColor = fill; g.shadowBlur = blur;
    g.fillStyle = fill;
    g.beginPath(); pts.forEach(([x, y], k) => (k ? g.lineTo(x, y) : g.moveTo(x, y))); g.closePath(); g.fill();
    g.shadowBlur = 0;
  };

  // 0 GLOW: halo suave.
  cell(SH.GLOW, (h) => {
    radial(h, [[0, R(1)], [0.25, R(0.7)], [0.55, R(0.22)], [1, R(0)]]);
    radial(h * 0.35, [[0, Gc(1)], [1, Gc(0)]]);
  });
  // 1 SPARK: punto caliente con halo corto.
  cell(SH.SPARK, (h) => {
    radial(h, [[0, R(1)], [0.15, R(0.95)], [0.4, R(0.3)], [1, R(0)]]);
    radial(h * 0.3, [[0, Gc(1)], [0.6, Gc(0.6)], [1, Gc(0)]]);
  });
  // 2 STAR: estrella de cuatro puntas.
  cell(SH.STAR, (h) => {
    const s: [number, number][] = [];
    for (let k = 0; k < 8; k++) { const a = (k * Math.PI) / 4 - Math.PI / 2, r = k % 2 ? h * 0.22 : h * 0.95; s.push([Math.cos(a) * r, Math.sin(a) * r]); }
    radial(h * 0.6, [[0, R(0.6)], [1, R(0)]]);
    poly(s, R(1), 8);
    radial(h * 0.28, [[0, Gc(1)], [1, Gc(0)]]);
  });
  // 3 SMOKE: nube irregular de varias manchas.
  cell(SH.SMOKE, (h) => {
    const blobs = [[0, 0, 0.62], [-0.3, -0.18, 0.42], [0.32, -0.1, 0.4], [0.1, 0.3, 0.42], [-0.22, 0.26, 0.36], [0.05, -0.36, 0.34]];
    for (const [x, y, r] of blobs) {
      const gr = g.createRadialGradient(x * h, y * h, 0, x * h, y * h, r * h);
      gr.addColorStop(0, R(0.55)); gr.addColorStop(0.6, R(0.28)); gr.addColorStop(1, R(0));
      g.fillStyle = gr; g.fillRect(-h, -h, h * 2, h * 2);
    }
  });
  // 4 RING: anillo.
  cell(SH.RING, (h) => {
    g.shadowColor = R(1); g.shadowBlur = 10;
    g.strokeStyle = R(1); g.lineWidth = h * 0.16;
    g.beginPath(); g.arc(0, 0, h * 0.78, 0, Math.PI * 2); g.stroke();
    g.shadowBlur = 0;
    g.strokeStyle = Gc(0.9); g.lineWidth = h * 0.05;
    g.beginPath(); g.arc(0, 0, h * 0.78, 0, Math.PI * 2); g.stroke();
  });
  // 5 SHARD: rombo alargado (cristal, esquirla).
  cell(SH.SHARD, (h) => {
    poly([[0, -h * 0.95], [h * 0.32, 0], [0, h * 0.95], [-h * 0.32, 0]], R(1), 6);
    poly([[0, -h * 0.6], [h * 0.12, 0], [0, h * 0.6], [-h * 0.12, 0]], Gc(0.9));
  });
  // 6 CROSS: aspa (silencio, desarme).
  cell(SH.CROSS, (h) => {
    g.lineCap = 'round';
    g.shadowColor = R(1); g.shadowBlur = 8;
    g.strokeStyle = R(1); g.lineWidth = h * 0.26;
    g.beginPath(); g.moveTo(-h * 0.6, -h * 0.6); g.lineTo(h * 0.6, h * 0.6); g.moveTo(h * 0.6, -h * 0.6); g.lineTo(-h * 0.6, h * 0.6); g.stroke();
    g.shadowBlur = 0;
    g.strokeStyle = Gc(0.8); g.lineWidth = h * 0.08;
    g.beginPath(); g.moveTo(-h * 0.55, -h * 0.55); g.lineTo(h * 0.55, h * 0.55); g.moveTo(h * 0.55, -h * 0.55); g.lineTo(-h * 0.55, h * 0.55); g.stroke();
  });
  // 7 FLAME: lengua de fuego hacia arriba.
  const tear = (h: number, up: boolean, fill: string, blur: number) => {
    const s = up ? 1 : -1;
    g.shadowColor = fill; g.shadowBlur = blur; g.fillStyle = fill;
    g.beginPath();
    g.moveTo(0, -h * 0.95 * s);
    g.bezierCurveTo(h * 0.25 * s, -h * 0.45 * s, h * 0.62 * s, h * 0.05 * s, h * 0.55 * s, h * 0.38 * s);
    g.arc(0, h * 0.38 * s, h * 0.55, up ? 0 : Math.PI, up ? Math.PI : Math.PI * 2);
    g.bezierCurveTo(-h * 0.62 * s, h * 0.05 * s, -h * 0.25 * s, -h * 0.45 * s, 0, -h * 0.95 * s);
    g.fill(); g.shadowBlur = 0;
  };
  cell(SH.FLAME, (h) => {
    g.globalAlpha = 0.85; tear(h * 0.92, true, R(1), 10); g.globalAlpha = 1;
    g.translate(0, h * 0.2); tear(h * 0.45, true, Gc(0.9), 6);
  });
  // 8 DROP: gota hacia abajo.
  cell(SH.DROP, (h) => {
    g.translate(0, -h * 0.05); tear(h * 0.8, false, R(1), 6);
    g.translate(-h * 0.15, -h * 0.25); radial(h * 0.18, [[0, Gc(0.9)], [1, Gc(0)]]);
  });
  // 9 SWIRL: espiral (viento, ciclón).
  cell(SH.SWIRL, (h) => {
    g.lineCap = 'round';
    for (const [col, w] of [[R(1), h * 0.14], [Gc(0.6), h * 0.05]] as [string, number][]) {
      g.strokeStyle = col; g.lineWidth = w; g.beginPath();
      for (let k = 0; k <= 60; k++) { const t = k / 60, a = t * Math.PI * 3.2, r = h * (0.08 + 0.82 * t); const x = Math.cos(a) * r, y = Math.sin(a) * r * 0.85; k ? g.lineTo(x, y) : g.moveTo(x, y); }
      g.stroke();
    }
  });
  // 10 LEAF: hoja.
  cell(SH.LEAF, (h) => {
    g.rotate(-0.6);
    g.fillStyle = R(1); g.shadowColor = R(1); g.shadowBlur = 5;
    g.beginPath(); g.moveTo(0, -h * 0.9); g.quadraticCurveTo(h * 0.62, 0, 0, h * 0.9); g.quadraticCurveTo(-h * 0.62, 0, 0, -h * 0.9); g.fill();
    g.shadowBlur = 0;
    g.strokeStyle = Gc(0.8); g.lineWidth = h * 0.06; g.beginPath(); g.moveTo(0, -h * 0.75); g.lineTo(0, h * 0.8); g.stroke();
  });
  // 11 SKULL: calavera (miedo, muerte).
  cell(SH.SKULL, (h) => {
    g.fillStyle = R(1); g.shadowColor = R(1); g.shadowBlur = 6;
    g.beginPath(); g.arc(0, -h * 0.12, h * 0.62, 0, Math.PI * 2); g.fill();
    g.fillRect(-h * 0.34, h * 0.3, h * 0.68, h * 0.42);
    g.shadowBlur = 0;
    g.globalCompositeOperation = 'source-over';
    g.fillStyle = '#000';
    g.beginPath(); g.arc(-h * 0.24, -h * 0.08, h * 0.16, 0, Math.PI * 2); g.arc(h * 0.24, -h * 0.08, h * 0.16, 0, Math.PI * 2); g.fill();
    g.beginPath(); g.moveTo(0, h * 0.12); g.lineTo(h * 0.08, h * 0.28); g.lineTo(-h * 0.08, h * 0.28); g.fill();
    g.fillRect(-h * 0.04, h * 0.48, h * 0.08, h * 0.26); g.fillRect(-h * 0.2, h * 0.48, h * 0.06, h * 0.26); g.fillRect(h * 0.14, h * 0.48, h * 0.06, h * 0.26);
    g.globalCompositeOperation = 'lighter';
  });
  // 12 SNOW: cristal de seis puntas.
  cell(SH.SNOW, (h) => {
    g.lineCap = 'round';
    for (const [col, w, blur] of [[R(1), h * 0.12, 6], [Gc(0.8), h * 0.04, 0]] as [string, number, number][]) {
      g.strokeStyle = col; g.lineWidth = w; g.shadowColor = col; g.shadowBlur = blur; g.beginPath();
      for (let k = 0; k < 6; k++) {
        const a = (k * Math.PI) / 3, c = Math.cos(a), s = Math.sin(a);
        g.moveTo(0, 0); g.lineTo(c * h * 0.9, s * h * 0.9);
        const bx = c * h * 0.55, by = s * h * 0.55;
        g.moveTo(bx, by); g.lineTo(bx + Math.cos(a + 0.7) * h * 0.25, by + Math.sin(a + 0.7) * h * 0.25);
        g.moveTo(bx, by); g.lineTo(bx + Math.cos(a - 0.7) * h * 0.25, by + Math.sin(a - 0.7) * h * 0.25);
      }
      g.stroke(); g.shadowBlur = 0;
    }
  });
  // 13 BUBBLE: esfera con el borde brillante (escudos en 2D).
  cell(SH.BUBBLE, (h) => {
    radial(h, [[0, R(0.12)], [0.7, R(0.3)], [0.88, R(1)], [0.95, R(0.5)], [1, R(0)]]);
    g.translate(-h * 0.35, -h * 0.4);
    radial(h * 0.25, [[0, Gc(0.7)], [1, Gc(0)]]);
  });
  // 14 CHEVRON: flecha hacia abajo (ralentizado).
  cell(SH.CHEVRON, (h) => {
    g.lineCap = 'round'; g.lineJoin = 'round';
    for (const [col, w] of [[R(1), h * 0.22], [Gc(0.7), h * 0.07]] as [string, number][]) {
      g.strokeStyle = col; g.lineWidth = w; g.beginPath();
      g.moveTo(-h * 0.6, -h * 0.35); g.lineTo(0, h * 0.3); g.lineTo(h * 0.6, -h * 0.35); g.stroke();
    }
  });
  // 15 BOLT: rayo en zigzag.
  cell(SH.BOLT, (h) => {
    const pts: [number, number][] = [[h * 0.15, -h * 0.95], [-h * 0.4, h * 0.08], [-h * 0.02, h * 0.08], [-h * 0.2, h * 0.95], [h * 0.45, -h * 0.15], [h * 0.05, -h * 0.15]];
    poly(pts, R(1), 10);
    g.scale(0.5, 0.6); poly(pts, Gc(0.8));
  });
  return (atlas = cv);
}

/** Datos RGBA del atlas (para los sprites tintados del modo 2D). */
let atlasData: ImageData | null = null;
export function atlasPixels(): ImageData {
  if (atlasData) return atlasData;
  const cv = shapeAtlas();
  return (atlasData = cv.getContext('2d')!.getImageData(0, 0, cv.width, cv.height));
}
