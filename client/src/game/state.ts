// Buffer de snapshots e interpolación: los clientes pintan 100 ms en el pasado para
// moverse con suavidad entre dos estados del servidor.
import type { SProj, SUnit, Snapshot } from '../../../shared/net/protocol';
import type { Fx } from '../../../shared/sim/types';

export interface VUnit extends SUnit {
  /** Posición y orientación interpoladas. */
  px: number; py: number; pf: number;
  /** Velocidad aparente (unidades/s), para animar el paso. */
  speed: number;
}

const DELAY = 0.11;

const lerpAngle = (a: number, b: number, t: number) => {
  let d = b - a;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return a + d * t;
};

export class SnapBuffer {
  snaps: Snapshot[] = [];
  private offset: number | null = null;
  private fxQueue: { tm: number; fx: Fx }[] = [];
  latest: Snapshot | null = null;

  push(s: Snapshot) {
    const now = performance.now() / 1000;
    const off = now - s.tm;
    // El desfase se ajusta rápido hacia abajo (paquete adelantado) y lento hacia arriba.
    if (this.offset === null || off < this.offset) this.offset = off;
    else this.offset += (off - this.offset) * 0.02;
    this.snaps.push(s);
    if (this.snaps.length > 12) this.snaps.shift();
    for (const f of s.fx) this.fxQueue.push({ tm: s.tm, fx: f });
    this.latest = s;
  }

  renderTime() {
    if (this.offset === null) return 0;
    return performance.now() / 1000 - this.offset - DELAY;
  }

  /** Efectos cuyo instante ya ha llegado en el tiempo de render. */
  takeFx(): Fx[] {
    const t = this.renderTime();
    const out: Fx[] = [];
    while (this.fxQueue.length && this.fxQueue[0].tm <= t + 0.02) out.push(this.fxQueue.shift()!.fx);
    if (this.fxQueue.length > 400) this.fxQueue.splice(0, this.fxQueue.length - 400);
    return out;
  }

  sample(): { units: VUnit[]; projs: SProj[]; tm: number } | null {
    if (!this.snaps.length) return null;
    const t = this.renderTime();
    let a = this.snaps[0], b = this.snaps[this.snaps.length - 1];
    for (let i = 0; i < this.snaps.length - 1; i++) {
      if (this.snaps[i].tm <= t && this.snaps[i + 1].tm >= t) { a = this.snaps[i]; b = this.snaps[i + 1]; break; }
    }
    if (t >= b.tm) a = b;
    const span = b.tm - a.tm;
    const k = span > 0 ? Math.max(0, Math.min(1, (t - a.tm) / span)) : 1;
    const prev = new Map(a.u.map((u) => [u.i, u]));
    const units: VUnit[] = b.u.map((u) => {
      const p = prev.get(u.i);
      if (!p || Math.hypot(p.x - u.x, p.y - u.y) > 600) return { ...u, px: u.x, py: u.y, pf: u.f, speed: 0 };
      return {
        ...u,
        px: p.x + (u.x - p.x) * k, py: p.y + (u.y - p.y) * k, pf: lerpAngle(p.f, u.f, k),
        speed: span > 0 ? Math.hypot(u.x - p.x, u.y - p.y) / span : 0,
      };
    });
    const pp = new Map(a.p.map((p) => [p.i, p]));
    const projs = b.p.map((p) => {
      const q = pp.get(p.i);
      return q ? { ...p, x: q.x + (p.x - q.x) * k, y: q.y + (p.y - q.y) * k } : p;
    });
    return { units, projs, tm: a.tm + span * k };
  }
}
