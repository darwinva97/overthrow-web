// Capa 2D en coordenadas de pantalla común a los dos modos: barras de vida y maná,
// nivel, números flotantes y textos de oro.
import type { Fx } from '../../../shared/sim/types';
import { ST } from '../../../shared/sim/types';
import type { VUnit } from '../game/state';
import { teamColor, type View } from './types';

interface FloatText { x: number; y: number; text: string; color: string; t: number; dur: number; size: number }

const NUM_COLOR: Record<string, string> = {
  magical: '#7fd0ff', pure: '#ffe6a0', physical: '#ffffff', crit: '#ff4040', heal: '#7dff7d',
};

export type Project = (x: number, y: number, h: number) => { x: number; y: number };

export class Overlay {
  private texts: FloatText[] = [];

  fx(f: Fx, v: View) {
    const me = v.hero?.i;
    if (f.n === 'num') {
      // Solo los números que interesan: daño que haces, que recibes, críticos y curas propias.
      const related = f.u === me || f.t === v.team || f.c === 'crit';
      if (!related && f.c !== 'heal') return;
      if (f.c === 'heal' && f.u !== me) return;
      this.texts.push({ x: f.x, y: f.y, text: (f.c === 'heal' ? '+' : '') + f.v, color: NUM_COLOR[f.c ?? 'physical'] ?? '#fff',
        t: 0, dur: 1.1, size: f.c === 'crit' ? 22 : 15 });
    } else if (f.n === 'gold' || f.n === 'midas') {
      if (f.n === 'gold' && f.u !== me) return;
      this.texts.push({ x: f.x, y: f.y, text: `+${f.v} oro`, color: '#f6cf7c', t: 0, dur: 1.4, size: 15 });
    } else if (f.n === 'miss') {
      this.texts.push({ x: f.x, y: f.y, text: 'fallo', color: '#d0c8e0', t: 0, dur: 0.8, size: 13 });
    }
  }

  draw(ctx: CanvasRenderingContext2D, v: View, project: Project, dt: number, heightOf: (u: VUnit) => number) {
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const u of v.units) {
      if (u.k === 'throne' || u.k === 'kobold' || u.k === 'orb' || u.k === 'fountain') continue;
      if (u.s & ST.hidden) continue;
      const p = project(u.px, u.py, heightOf(u));
      const hero = u.k === 'hero' || u.k === 'illusion';
      const w = hero ? 84 : 46, h = hero ? 8 : 5;
      const x0 = p.x - w / 2, y0 = p.y - (hero ? 26 : 12);
      const mine = u.o === 1;
      const ally = u.t === v.team;
      ctx.fillStyle = '#000b';
      ctx.fillRect(x0 - 1, y0 - 1, w + 2, h + 2 + (hero ? 5 : 0));
      ctx.fillStyle = mine ? (u.il ? '#3c8ce0' : '#56d24a') : ally ? '#3fae9a' : u.t < 0 ? '#c9a24a' : '#d43c30';
      ctx.fillRect(x0, y0, w * Math.max(0, u.h / u.H), h);
      if (hero && u.M > 0) {
        ctx.fillStyle = '#3d8fd8';
        ctx.fillRect(x0, y0 + h + 1, w * Math.max(0, u.m / u.M), 3);
      }
      if (hero) {
        // Separadores cada 250 de vida, como en Dota.
        ctx.fillStyle = '#0007';
        const step = 250 / u.H * w;
        if (step > 3) for (let k = step; k < w; k += step) ctx.fillRect(x0 + k, y0, 1, h);
        ctx.fillStyle = teamColor(v, u.t);
        ctx.fillRect(x0 - 16, y0 - 1, 14, 14);
        ctx.fillStyle = '#fff';
        ctx.font = '700 11px "Saira Semi Condensed", sans-serif';
        ctx.fillText(String(u.l), x0 - 9, y0 + 6);
      }
    }
    for (const t of this.texts) {
      t.t += dt;
      const k = t.t / t.dur;
      const p = project(t.x, t.y, 140);
      ctx.globalAlpha = Math.max(0, 1 - k * k);
      ctx.font = `700 ${t.size}px "Saira Semi Condensed", sans-serif`;
      ctx.lineWidth = 3;
      ctx.strokeStyle = '#000';
      ctx.strokeText(t.text, p.x, p.y - k * 40);
      ctx.fillStyle = t.color;
      ctx.fillText(t.text, p.x, p.y - k * 40);
    }
    ctx.globalAlpha = 1;
    this.texts = this.texts.filter((t) => t.t < t.dur);
    ctx.restore();
  }
}
