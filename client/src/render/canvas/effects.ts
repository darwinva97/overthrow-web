// Poderes en el modo 2D: fx del servidor, proyectiles, zonas, áreas, estados sobre unidades,
// destellos de lanzamiento y canalizaciones. La lógica es la de vfx/engine.ts (compartida con el 3D);
// aquí solo se dibuja el frame con sprites precalculados (vfx/canvas-backend.ts).
import type { Fx } from '../../../../shared/sim/types';
import type { VUnit } from '../../game/state';
import type { View } from '../types';
import { CanvasVfx } from '../vfx/canvas-backend';
import { VfxEngine, type Bounds } from '../vfx/engine';
import type { Drawn } from './units';

export class EffectPainter {
  private eng = new VfxEngine({ sprites: 1400, particles: 1000, flyLift: 0, density: 0.45 });
  private gfx = new CanvasVfx(0.32);
  private lastClock = -1;
  private bounds: Bounds = { x0: 0, y0: 0, x1: 0, y1: 0 };
  private ms = 0;
  private cur = 0;

  private lastView: View | null = null;

  fx(f: Fx, v: View) { this.eng.fx(f, v); }

  /** Gancho de depuración en la consola del navegador: __vfx.dump(), __vfx.stats(). */
  private hook() {
    (globalThis as { __vfx?: unknown }).__vfx = { dump: () => this.lastView && this.eng.dump(this.lastView), stats: () => this.stats(), mode: '2d' };
  }

  /** Parte del mundo visible con la transformación actual del lienzo. */
  private visible(c: CanvasRenderingContext2D): Bounds {
    const t = c.getTransform(), b = this.bounds;
    b.x0 = -t.e / t.a; b.y0 = -t.f / t.d;
    b.x1 = (c.canvas.width - t.e) / t.a; b.y1 = (c.canvas.height - t.f) / t.d;
    return b;
  }

  /** Bajo las unidades: avanza la simulación y pinta lo que va en el suelo. */
  drawUnder(c: CanvasRenderingContext2D, v: View, px: number, clock: number) {
    if (!this.lastView) this.hook();
    this.lastView = v;
    const t0 = performance.now();
    const dt = this.lastClock < 0 ? 0 : Math.min(0.25, Math.max(0, clock - this.lastClock));
    this.lastClock = clock;
    this.eng.update(v, dt, this.visible(c));
    this.gfx.drawGround(c, this.eng.frame, px);
    this.cur = performance.now() - t0;
  }

  /** Los estados de cada unidad salen en el frame compartido (drawOver); aquí no hace falta nada. */
  drawOnUnit(_c: CanvasRenderingContext2D, _v: View, _u: VUnit, _d: Drawn, _px: number) {}

  /** Encima de todo: escudos, haces, partículas y proyectiles. */
  drawOver(c: CanvasRenderingContext2D, _v: View, _dt: number, px: number) {
    const t0 = performance.now();
    this.gfx.drawAir(c, this.eng.frame, px);
    this.ms += (this.cur + performance.now() - t0 - this.ms) * 0.1;
  }

  stats(): Record<string, number> {
    const i = this.eng.info;
    return { partículas: i.particles, 'sprites de efectos': i.sprites, 'efectos vivos': i.live, 'ms de efectos': Math.round(this.ms * 10) / 10 };
  }
}
