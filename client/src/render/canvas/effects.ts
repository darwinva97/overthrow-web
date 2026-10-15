// Poderes en el modo 2D: fx del servidor, proyectiles, zonas, áreas y estados sobre unidades.
import type { Fx } from '../../../../shared/sim/types';
import type { VUnit } from '../../game/state';
import { FX, ORB_COLOR, STATUS, projColor, projSize, type FxStyle } from '../fxstyle';
import type { View } from '../types';
import type { Drawn } from './units';

interface LiveFx { f: Fx; s: FxStyle; t: number; d: number }

export class EffectPainter {
  private live: LiveFx[] = [];
  private clock = 0;

  fx(f: Fx, v: View) {
    if (f.n === 'orb_throw') { this.live.push({ f, s: { k: 'flash', c: ORB_COLOR[f.c ?? 'common'], d: f.d ?? 1.5 }, t: 0, d: f.d ?? 1.5 }); return; }
    const s = FX[f.n];
    if (s) this.live.push({ f, s, t: 0, d: f.d ?? s.d });
  }

  /** Bajo las unidades: zonas y áreas de auras. */
  drawUnder(c: CanvasRenderingContext2D, v: View, px: number, clock: number) {
    this.clock = clock;
    for (const z of v.zones) {
      const col = z.fx === 'shrapnel' ? '#d9b36a' : '#ffffff';
      c.fillStyle = col + '22'; c.strokeStyle = col + '88'; c.lineWidth = 2 * px;
      c.beginPath(); c.arc(z.x, z.y, z.r, 0, Math.PI * 2); c.fill(); c.stroke();
    }
    for (const u of v.units) for (const fx of u.fx ?? []) {
      const st = STATUS[fx];
      if (!st || (st.k !== 'area' && st.k !== 'spin')) continue;
      c.fillStyle = st.c + (st.k === 'spin' ? '30' : '1c'); c.strokeStyle = st.c + '77'; c.lineWidth = 2 * px;
      c.beginPath(); c.arc(u.px, u.py, st.r ?? 300, 0, Math.PI * 2); c.fill(); c.stroke();
      if (st.k === 'spin') {
        c.lineWidth = 10 * px; c.strokeStyle = st.c + 'cc';
        for (let k = 0; k < 3; k++) {
          const a0 = this.clock * 14 + (k * Math.PI * 2) / 3;
          c.beginPath(); c.arc(u.px, u.py, (st.r ?? 300) * 0.8, a0, a0 + 0.7); c.stroke();
        }
      }
    }
  }

  /** Encima de cada unidad: estados (aturdido, escudos, ralentizados…) y canalización. */
  drawOnUnit(c: CanvasRenderingContext2D, v: View, u: VUnit, d: Drawn, px: number) {
    const fx = u.fx ?? [];
    const x = d.x, y = d.y;
    // Estados encima de la unidad.
    for (const f of fx) {
      const st = STATUS[f];
      if (!st) continue;
      const rr = (u.k === 'hero' || u.k === 'illusion' ? 34 : u.r * 1.3);
      if (st.k === 'feet') {
        c.strokeStyle = st.c + 'bb'; c.lineWidth = 5 * px;
        c.beginPath(); c.arc(x, y, rr + 10, 0, Math.PI * 2); c.stroke();
      } else if (st.k === 'shell') {
        c.fillStyle = st.c + '22'; c.strokeStyle = st.c + 'cc'; c.lineWidth = 3 * px;
        c.beginPath(); c.arc(x, y, rr + 16, 0, Math.PI * 2); c.fill(); c.stroke();
      } else if (st.k === 'stars') {
        c.fillStyle = st.c;
        for (let k = 0; k < 3; k++) {
          const a = this.clock * 5 + (k * Math.PI * 2) / 3;
          c.beginPath(); c.arc(x + Math.cos(a) * 26, y - rr - 14 + Math.sin(a) * 8, 6, 0, Math.PI * 2); c.fill();
        }
      } else if (st.k === 'lift') {
        c.strokeStyle = st.c + 'aa'; c.lineWidth = 4 * px;
        for (let k = 0; k < 3; k++) { c.beginPath(); c.arc(x, y + 40, 30 + k * 14, this.clock * 8 + k, this.clock * 8 + k + 2); c.stroke(); }
      }
    }
    if (u.c === 2) {
      c.strokeStyle = '#f6cf7c'; c.lineWidth = 3 * px;
      c.beginPath(); c.arc(x, y, 50, this.clock * 3, this.clock * 3 + 4); c.stroke();
    }
  }

  /** Encima de todo: proyectiles y efectos de poderes. */
  drawOver(c: CanvasRenderingContext2D, v: View, dt: number, px: number) {
    for (const p of v.projs) {
      const col = projColor(p.fx);
      const size = projSize(p.fx);
      if (p.fx === 'hook') {
        const src = v.byId.get(p.s);
        if (src) {
          c.strokeStyle = '#a89a7a'; c.lineWidth = 6 * px; c.setLineDash([10 * px, 6 * px]);
          c.beginPath(); c.moveTo(src.px, src.py); c.lineTo(p.x, p.y); c.stroke(); c.setLineDash([]);
        }
      }
      const gr = c.createRadialGradient(p.x, p.y, 0, p.x, p.y, size);
      gr.addColorStop(0, '#ffffff');
      gr.addColorStop(0.35, col);
      gr.addColorStop(1, col + '00');
      c.fillStyle = gr;
      c.beginPath(); c.arc(p.x, p.y, size, 0, Math.PI * 2); c.fill();
    }
    this.drawFx(c, v, dt, px);
  }

  private drawFx(c: CanvasRenderingContext2D, v: View, dt: number, px: number) {
    for (const l of this.live) {
      l.t += dt;
      const k = Math.min(1, l.t / l.d);
      const { f, s } = l;
      const r = f.r ?? 260;
      c.globalAlpha = 1 - k;
      switch (s.k) {
        case 'ring':
          c.strokeStyle = s.c; c.lineWidth = 10 * px;
          c.beginPath(); c.arc(f.x, f.y, Math.max(1, r * (0.2 + k * 0.8)), 0, Math.PI * 2); c.stroke();
          break;
        case 'burst': {
          const gr = c.createRadialGradient(f.x, f.y, 0, f.x, f.y, r);
          gr.addColorStop(0, '#ffffff'); gr.addColorStop(0.3, s.c); gr.addColorStop(1, s.c + '00');
          c.fillStyle = gr; c.beginPath(); c.arc(f.x, f.y, r * (0.6 + 0.4 * k), 0, Math.PI * 2); c.fill();
          break;
        }
        case 'warn':
          c.globalAlpha = 0.5 + 0.4 * Math.sin(l.t * 18);
          c.strokeStyle = s.c; c.lineWidth = 5 * px; c.fillStyle = s.c + '22';
          c.beginPath(); c.arc(f.x, f.y, r, 0, Math.PI * 2); c.fill(); c.stroke();
          break;
        case 'beam': case 'bolt': {
          const a = f.u ? v.byId.get(f.u) : undefined, b = f.u2 ? v.byId.get(f.u2) : undefined;
          const x1 = a?.px ?? f.x, y1 = a?.py ?? f.y, x2 = b?.px ?? f.x2 ?? f.x, y2 = b?.py ?? f.y2 ?? f.y;
          c.strokeStyle = s.c; c.lineWidth = (s.w ?? 8) * px * 3; c.lineCap = 'round';
          c.beginPath(); c.moveTo(x1, y1);
          if (s.k === 'bolt') {
            for (let i = 1; i < 6; i++) {
              const t = i / 6;
              c.lineTo(x1 + (x2 - x1) * t + (Math.random() - 0.5) * 50, y1 + (y2 - y1) * t + (Math.random() - 0.5) * 50);
            }
          }
          c.lineTo(x2, y2); c.stroke();
          break;
        }
        case 'flash': {
          if (f.n === 'orb_throw') {
            const t = k;
            const x = f.x + ((f.x2 ?? f.x) - f.x) * t, y = f.y + ((f.y2 ?? f.y) - f.y) * t - Math.sin(t * Math.PI) * 500;
            c.globalAlpha = 1; c.fillStyle = s.c;
            c.beginPath(); c.arc(x, y, 30, 0, Math.PI * 2); c.fill();
            break;
          }
          for (const [x, y] of [[f.x, f.y], [f.x2, f.y2]] as [number | undefined, number | undefined][]) {
            if (x === undefined || y === undefined) continue;
            const gr = c.createRadialGradient(x, y, 0, x, y, 90);
            gr.addColorStop(0, '#ffffff'); gr.addColorStop(0.4, s.c); gr.addColorStop(1, s.c + '00');
            c.fillStyle = gr; c.beginPath(); c.arc(x, y, 90, 0, Math.PI * 2); c.fill();
          }
          break;
        }
      }
    }
    c.globalAlpha = 1;
    this.live = this.live.filter((l) => l.t < l.d);
  }
}
