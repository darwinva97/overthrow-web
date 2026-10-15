// Capa de efectos del modo 3D: poderes (fx del servidor), proyectiles, zonas, estados sobre unidades,
// destellos de lanzamiento y canalizaciones. La lógica es la de vfx/engine.ts (compartida con el 2D);
// aquí solo se calcula qué parte del mapa se ve y se sube el frame a la GPU (vfx/three-backend.ts).
import * as THREE from 'three';
import type { Fx } from '../../../../shared/sim/types';
import type { View } from '../types';
import { VfxEngine, type Bounds } from '../vfx/engine';
import { ThreeVfx } from '../vfx/three-backend';
import type { ThreeCtx } from './shared';
import type { UnitLayer } from './units';

export class EffectLayer {
  private ctx: ThreeCtx;
  private eng: VfxEngine;
  private gpu: ThreeVfx;
  private bounds: Bounds = { x0: 0, y0: 0, x1: 0, y1: 0 };
  private v3 = new THREE.Vector3();
  private ms = 0;

  constructor(ctx: ThreeCtx, units: UnitLayer) {
    this.ctx = ctx;
    // La altura de la cabeza la da la capa de unidades (la misma que usan sus barras y estados).
    this.eng = new VfxEngine({ sprites: 7000, particles: 5000, flyLift: 120, density: 1, headOf: (u) => units.headHeight(u) });
    this.gpu = new ThreeVfx(this.eng.frame);
    ctx.scene.add(this.gpu.group);
    this.hook();
  }

  private lastView: View | null = null;

  fx(f: Fx, v: View) { this.eng.fx(f, v); }

  /** Gancho de depuración en la consola del navegador: __vfx.dump(), __vfx.stats(). */
  private hook() {
    (globalThis as { __vfx?: unknown }).__vfx = { dump: () => this.lastView && this.eng.dump(this.lastView), stats: () => this.stats(), mode: '3d' };
  }

  /** Rectángulo del suelo que ve la cámara (para no generar efectos fuera de pantalla). */
  private visibleGround(): Bounds {
    const cam = this.ctx.camera, b = this.bounds, p = this.v3;
    b.x0 = b.y0 = Infinity; b.x1 = b.y1 = -Infinity;
    for (let i = 0; i < 4; i++) {
      p.set(i & 1 ? 1 : -1, i & 2 ? 1 : -1, 0.5).unproject(cam).sub(cam.position);
      // Rayos que no bajan al suelo (cielo): se cortan a 6000 de distancia.
      const t = p.y < -1e-3 ? -cam.position.y / p.y : 6000 / Math.max(1e-3, p.length());
      const x = cam.position.x + p.x * t, y = cam.position.z + p.z * t;
      if (x < b.x0) b.x0 = x; if (x > b.x1) b.x1 = x;
      if (y < b.y0) b.y0 = y; if (y > b.y1) b.y1 = y;
    }
    return b;
  }

  update(v: View, dt: number) {
    this.lastView = v;
    const t0 = performance.now();
    this.eng.update(v, Math.min(dt, 0.25), this.visibleGround());
    this.gpu.sync(this.ctx.clock);
    this.ms += (performance.now() - t0 - this.ms) * 0.1;
  }

  /** Estadísticas para el panel F9 (si el núcleo las añade). */
  stats(): Record<string, number> {
    const i = this.eng.info;
    return { 'llamadas de efectos': this.gpu.calls, partículas: i.particles, 'sprites de efectos': i.sprites, 'efectos vivos': i.live, 'ms de efectos': Math.round(this.ms * 10) / 10 };
  }

  dispose() { this.gpu.dispose(); this.eng.dispose(); }
}
