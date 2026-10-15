// Cuerpo de las unidades en el modo 2D (fichas con retrato, creeps, estructuras).
// Los estados encima de la unidad, proyectiles y poderes los pinta canvas/effects.ts.
import { heroIcon } from '../../../../shared/data';
import { ST } from '../../../../shared/sim/types';
import type { VUnit } from '../../game/state';
import { ORB_COLOR } from '../fxstyle';
import { img, ready } from '../images';
import { teamColor, type View } from '../types';

const CREEP_COLOR: Record<string, string> = {
  kobold: '#8a6a4a', kobold_foreman: '#a07a4a', wolf: '#8c8c96', alpha_wolf: '#b0b0c0', satyr: '#8a5ab0', centaur: '#b08a3a',
};

/** Dónde quedó dibujada la unidad (con saltos o elevaciones aplicados) y su radio visual. */
export interface Drawn { x: number; y: number; r: number }

export class UnitPainter {
  private clock = 0;

  /** Dibuja la unidad; devuelve su posición dibujada o null si no se dibuja. */
  draw(c: CanvasRenderingContext2D, v: View, u: VUnit, px: number, clock: number): Drawn | null {
    this.clock = clock;
    if (u.s & ST.hidden) return null;
    const fx = u.fx ?? [];
    let x = u.px, y = u.py;
    if (u.a) { x += Math.cos(u.pf) * 10; y += Math.sin(u.pf) * 10; }
    const lifted = fx.includes('cyclone');
    if (lifted) y -= 40 + Math.sin(this.clock * 6) * 8;
    c.save();
    if (fx.includes('invis') || fx.includes('ethereal') || fx.includes('doppel')) c.globalAlpha = 0.45;
    const team = teamColor(v, u.t);
    switch (u.k) {
      case 'throne': {
        c.fillStyle = '#00000055';
        c.beginPath(); c.ellipse(x + 10, y + 14, 130, 110, 0, 0, Math.PI * 2); c.fill();
        const gr = c.createRadialGradient(x - 30, y - 30, 10, x, y, 120);
        gr.addColorStop(0, '#fff1c2'); gr.addColorStop(0.5, '#e0a84a'); gr.addColorStop(1, '#6a4416');
        c.fillStyle = gr;
        c.beginPath();
        for (let k = 0; k < 8; k++) { const a = (k / 8) * Math.PI * 2 + Math.PI / 8; c.lineTo(x + Math.cos(a) * 110, y + Math.sin(a) * 110); }
        c.closePath(); c.fill();
        c.strokeStyle = '#3a240a'; c.lineWidth = 6 * px; c.stroke();
        break;
      }
      case 'kobold': {
        c.fillStyle = '#6b4a2a'; c.beginPath(); c.arc(x, y, 34, 0, Math.PI * 2); c.fill();
        c.fillStyle = '#f6cf7c';
        c.beginPath(); c.moveTo(x - 22, y - 26); c.lineTo(x - 14, y - 48); c.lineTo(x, y - 32); c.lineTo(x + 14, y - 48); c.lineTo(x + 22, y - 26); c.closePath(); c.fill();
        break;
      }
      case 'orb': {
        const o = v.orbs.find((q) => q.i === u.i);
        const col = ORB_COLOR[o?.r ?? 'common'] ?? '#7fe0ff';
        c.strokeStyle = col + '88'; c.lineWidth = 3 * px; c.setLineDash([14 * px, 10 * px]);
        c.beginPath(); c.arc(x, y, 220, 0, Math.PI * 2); c.stroke(); c.setLineDash([]);
        for (const [t, p] of o?.p ?? []) {
          c.strokeStyle = teamColor(v, t); c.lineWidth = 12 * px;
          c.beginPath(); c.arc(x, y, 220, -Math.PI / 2, -Math.PI / 2 + (p / v.captureTime) * Math.PI * 2); c.stroke();
        }
        const pulse = 1 + Math.sin(this.clock * 4) * 0.08;
        const gr = c.createRadialGradient(x, y, 0, x, y, 70 * pulse);
        gr.addColorStop(0, '#ffffff'); gr.addColorStop(0.3, col); gr.addColorStop(1, col + '00');
        c.fillStyle = gr; c.beginPath(); c.arc(x, y, 70 * pulse, 0, Math.PI * 2); c.fill();
        c.fillStyle = col;
        c.beginPath(); c.moveTo(x, y - 30); c.lineTo(x + 22, y); c.lineTo(x, y + 30); c.lineTo(x - 22, y); c.closePath(); c.fill();
        break;
      }
      case 'fountain': {
        const gr = c.createRadialGradient(x, y, 10, x, y, 110);
        gr.addColorStop(0, '#ffffff'); gr.addColorStop(0.4, team); gr.addColorStop(1, team + '00');
        c.fillStyle = gr; c.beginPath(); c.arc(x, y, 110, 0, Math.PI * 2); c.fill();
        c.strokeStyle = '#1a1520'; c.lineWidth = 8 * px;
        c.beginPath(); c.arc(x, y, 62, 0, Math.PI * 2); c.stroke();
        break;
      }
      case 'ward': {
        c.fillStyle = '#2a5a2a'; c.beginPath(); c.arc(x, y, 22, 0, Math.PI * 2); c.fill();
        c.fillStyle = '#9cff9c'; c.fillRect(x - 4, y - 14, 8, 28); c.fillRect(x - 14, y - 4, 28, 8);
        break;
      }
      case 'summon':
      case 'creep': {
        if ((u.s & ST.flying) !== 0) y -= 30;
        c.fillStyle = '#0006'; c.beginPath(); c.ellipse(x + 4, y + 6, u.r * 1.2, u.r, 0, 0, Math.PI * 2); c.fill();
        c.fillStyle = CREEP_COLOR[u.n.replace('neutral_', '')] ?? (u.k === 'summon' ? '#6a7a8a' : '#888');
        c.strokeStyle = u.k === 'summon' ? team : '#1a1410'; c.lineWidth = (u.k === 'summon' ? 6 : 4) * px;
        c.beginPath(); c.arc(x, y, u.r * 1.3, 0, Math.PI * 2); c.fill(); c.stroke();
        c.fillStyle = '#1a1410';
        c.beginPath(); c.arc(x + Math.cos(u.pf) * u.r, y + Math.sin(u.pf) * u.r, 6, 0, Math.PI * 2); c.fill();
        break;
      }
      default: {
        const r = 34;
        c.fillStyle = '#0007'; c.beginPath(); c.ellipse(x + 6, y + 9, r * 1.05, r * 0.9, 0, 0, Math.PI * 2); c.fill();
        // Indicador de orientación.
        c.fillStyle = team;
        c.beginPath();
        c.moveTo(x + Math.cos(u.pf) * (r + 16), y + Math.sin(u.pf) * (r + 16));
        c.lineTo(x + Math.cos(u.pf + 0.45) * (r + 2), y + Math.sin(u.pf + 0.45) * (r + 2));
        c.lineTo(x + Math.cos(u.pf - 0.45) * (r + 2), y + Math.sin(u.pf - 0.45) * (r + 2));
        c.closePath(); c.fill();
        const icon = img(heroIcon(u.n));
        c.save();
        c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.clip();
        c.fillStyle = '#222'; c.fill();
        if (ready(icon)) c.drawImage(icon, x - r, y - r, r * 2, r * 2);
        if (u.il) { c.fillStyle = '#3c8ce055'; c.fill(); }
        c.restore();
        c.strokeStyle = team; c.lineWidth = (u.o ? 7 : 5) * px;
        c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.stroke();
        if (v.hover === u.i) { c.strokeStyle = '#ffffffaa'; c.lineWidth = 2 * px; c.beginPath(); c.arc(x, y, r + 8, 0, Math.PI * 2); c.stroke(); }
      }
    }
    c.restore();
    return { x, y, r: u.k === 'hero' || u.k === 'illusion' ? 34 : u.r * 1.3 };
  }
}
