// Capa de efectos del modo 3D: poderes (fx del servidor), proyectiles, zonas y estados sobre unidades.
import * as THREE from 'three';
import type { Fx } from '../../../../shared/sim/types';
import { FX, ORB_COLOR, STATUS, projColor, projSize, type FxStyle } from '../fxstyle';
import { teamColor, type View } from '../types';
import { G, type ThreeCtx } from './shared';
import type { UnitLayer } from './units';

interface LiveFx { obj: THREE.Object3D; t: number; d: number; update(k: number, t: number): void }

export class EffectLayer {
  private ctx: ThreeCtx;
  private units: UnitLayer['units'];
  private live: LiveFx[] = [];
  private projs = new Map<number, THREE.Object3D>();
  private zones = new Map<number, THREE.Object3D>();
  private statuses = new Map<number, Map<string, THREE.Object3D>>();

  constructor(ctx: ThreeCtx, units: UnitLayer) { this.ctx = ctx; this.units = units.units; }

  fx(f: Fx, v: View) {
    let s: FxStyle | undefined = FX[f.n];
    if (f.n === 'orb_throw') s = { k: 'flash', c: ORB_COLOR[f.c ?? 'common'], d: f.d ?? 1.5 };
    if (!s) return;
    const d = f.d ?? s.d;
    const color = new THREE.Color(s.c);
    const add = (obj: THREE.Object3D, update: LiveFx['update']) => { this.ctx.scene.add(obj); this.live.push({ obj, t: 0, d, update }); };
    const basic = (opacity = 1) => new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, blending: THREE.AdditiveBlending });
    const r = f.r ?? 260;
    if (f.n === 'orb_throw') {
      const m = new THREE.Mesh(G.orb, new THREE.MeshBasicMaterial({ color }));
      m.scale.setScalar(0.8);
      add(m, (k) => {
        m.position.set(f.x + ((f.x2 ?? f.x) - f.x) * k, 80 + Math.sin(k * Math.PI) * 700, f.y + ((f.y2 ?? f.y) - f.y) * k);
        m.rotation.y += 0.2;
      });
      return;
    }
    switch (s.k) {
      case 'ring': {
        const m = new THREE.Mesh(G.ring, basic());
        m.position.set(f.x, 6, f.y);
        add(m, (k) => { m.scale.setScalar(Math.max(1, r * (0.2 + 0.8 * k))); (m.material as THREE.MeshBasicMaterial).opacity = 1 - k; });
        break;
      }
      case 'burst': {
        const g = new THREE.Group();
        const disc = new THREE.Mesh(G.disc, new THREE.MeshBasicMaterial({ color, map: this.ctx.glow, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
        disc.position.y = 5;
        const ball = new THREE.Mesh(G.sphere, basic(0.7));
        g.add(disc, ball);
        g.position.set(f.x, 0, f.y);
        add(g, (k) => {
          disc.scale.setScalar(r * (0.6 + 0.6 * k)); (disc.material as THREE.MeshBasicMaterial).opacity = 1 - k;
          ball.scale.setScalar(r * 0.35 * (0.5 + k)); ball.position.y = 40 + k * 60; (ball.material as THREE.MeshBasicMaterial).opacity = 0.7 * (1 - k);
        });
        break;
      }
      case 'warn': {
        const g = new THREE.Group();
        const ring = new THREE.Mesh(G.ring, basic());
        const disc = new THREE.Mesh(G.disc, basic(0.18));
        ring.scale.setScalar(r); disc.scale.setScalar(r);
        g.add(ring, disc);
        g.position.set(f.x, 5, f.y);
        add(g, (_k, t) => { (ring.material as THREE.MeshBasicMaterial).opacity = 0.5 + 0.4 * Math.sin(t * 18); });
        break;
      }
      case 'beam': case 'bolt': {
        const pts = () => {
          const a = f.u ? v.byId.get(f.u) : undefined, b = f.u2 ? v.byId.get(f.u2) : undefined;
          return [new THREE.Vector3(a?.px ?? f.x, 90, a?.py ?? f.y), new THREE.Vector3(b?.px ?? f.x2 ?? f.x, 70, b?.py ?? f.y2 ?? f.y)];
        };
        if (s.k === 'beam') {
          const m = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1, 8, 1, true), basic());
          const w = s.w ?? 10;
          add(m, (k) => {
            const [a, b] = pts();
            const len = a.distanceTo(b);
            m.position.copy(a).add(b).multiplyScalar(0.5);
            m.scale.set(w * (1 - k * 0.5), len, w * (1 - k * 0.5));
            m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
            (m.material as THREE.MeshBasicMaterial).opacity = 1 - k;
          });
        } else {
          const geo = new THREE.BufferGeometry();
          const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color, transparent: true }));
          add(line, (k) => {
            const [a, b] = pts();
            const arr: THREE.Vector3[] = [];
            for (let i = 0; i <= 6; i++) {
              const p = a.clone().lerp(b, i / 6);
              if (i > 0 && i < 6) p.add(new THREE.Vector3((Math.random() - 0.5) * 50, (Math.random() - 0.5) * 30, (Math.random() - 0.5) * 50));
              arr.push(p);
            }
            geo.setFromPoints(arr);
            (line.material as THREE.LineBasicMaterial).opacity = 1 - k;
          });
        }
        break;
      }
      case 'flash': {
        const g = new THREE.Group();
        for (const [x, y] of [[f.x, f.y], [f.x2, f.y2]] as [number | undefined, number | undefined][]) {
          if (x === undefined || y === undefined) continue;
          const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.ctx.glow, color, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
          sp.position.set(x, 70, y);
          sp.scale.setScalar(220);
          g.add(sp);
        }
        add(g, (k) => { for (const c of g.children) ((c as THREE.Sprite).material as THREE.SpriteMaterial).opacity = 1 - k; });
        break;
      }
    }
  }


  private statusObj(st: (typeof STATUS)[string]): THREE.Object3D {
    const color = new THREE.Color(st.c);
    const basic = (o: number) => new THREE.MeshBasicMaterial({ color, transparent: true, opacity: o, depthWrite: false });
    switch (st.k) {
      case 'feet': { const m = new THREE.Mesh(G.ring, basic(0.8)); m.scale.setScalar(52); m.position.y = 4; return m; }
      case 'area': case 'spin': {
        const g = new THREE.Group();
        const disc = new THREE.Mesh(G.disc, basic(st.k === 'spin' ? 0.2 : 0.12));
        const edge = new THREE.Mesh(G.ring, basic(0.5));
        disc.scale.setScalar(st.r ?? 300); edge.scale.setScalar(st.r ?? 300);
        disc.position.y = 3; edge.position.y = 4;
        g.add(disc, edge);
        return g;
      }
      case 'shell': { const m = new THREE.Mesh(G.sphere, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.22, depthWrite: false, blending: THREE.AdditiveBlending })); m.scale.setScalar(80); m.position.y = 70; return m; }
      case 'stars': {
        const g = new THREE.Group();
        for (let k = 0; k < 3; k++) { const s = new THREE.Mesh(G.gem, new THREE.MeshBasicMaterial({ color })); s.scale.setScalar(0.7); g.add(s); }
        g.position.y = 160;
        return g;
      }
      default: return new THREE.Group();
    }
  }


  /** Estados visuales de cada unidad según sus modificadores (u.fx). */
  private syncStatuses(v: View) {
    for (const u of v.units) {
      const o = this.units.get(u.i);
      if (!o) continue;
      let st = this.statuses.get(u.i);
      if (!st) { st = new Map(); this.statuses.set(u.i, st); }
      const fx = u.fx ?? [];
      for (const f of fx) {
        const s = STATUS[f];
        if (!s || st.has(f) || s.k === 'alpha' || s.k === 'lift') continue;
        const obj = this.statusObj(s);
        o.root.add(obj);
        st.set(f, obj);
      }
      for (const [f, obj] of st) {
        if (!fx.includes(f) || obj.parent !== o.root) { obj.parent?.remove(obj); st.delete(f); continue; }
        if (STATUS[f].k === 'stars') obj.children.forEach((c, k) => {
          const a = this.ctx.clock * 5 + (k * Math.PI * 2) / 3;
          c.position.set(Math.cos(a) * 30, Math.sin(a * 2) * 5, Math.sin(a) * 30);
        });
        if (STATUS[f].k === 'spin') obj.rotation.y = this.ctx.clock * 10;
      }
    }
    for (const id of this.statuses.keys()) if (!v.byId.has(id)) this.statuses.delete(id);
  }

  private syncProjectiles(v: View) {
    const seen = new Set<number>();
    for (const p of v.projs) {
      seen.add(p.i);
      let o = this.projs.get(p.i);
      if (!o) {
        const col = new THREE.Color(projColor(p.fx));
        const g = new THREE.Group();
        const core = new THREE.Mesh(G.sphere, new THREE.MeshBasicMaterial({ color: col }));
        const size = projSize(p.fx);
        core.scale.setScalar(p.fx === 'dragon_slave' ? 40 : Math.max(6, size * 0.6));
        const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.ctx.glow, color: col, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
        halo.scale.setScalar(size * 3);
        g.add(core, halo);
        if (p.fx === 'hook') {
          const line = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: '#b8a888' }));
          line.name = 'chain';
          line.frustumCulled = false;
          this.ctx.scene.add(line);
          g.userData.chain = line;
        }
        this.ctx.scene.add(g);
        this.projs.set(p.i, g);
        o = g;
      }
      o.position.set(p.x, p.fx === 'dragon_slave' ? 50 : 80, p.y);
      const chain = o.userData.chain as THREE.Line | undefined;
      const src = v.byId.get(p.s);
      if (chain && src) chain.geometry.setFromPoints([new THREE.Vector3(src.px, 80, src.py), o.position.clone()]);
    }
    for (const [id, o] of this.projs) if (!seen.has(id)) {
      this.ctx.scene.remove(o);
      if (o.userData.chain) this.ctx.scene.remove(o.userData.chain);
      this.projs.delete(id);
    }
  }

  private syncZones(v: View) {
    const seen = new Set<number>();
    for (const z of v.zones) {
      seen.add(z.i);
      if (this.zones.has(z.i)) continue;
      const col = new THREE.Color(z.fx === 'shrapnel' ? '#d9b36a' : '#ffffff');
      const g = new THREE.Group();
      const disc = new THREE.Mesh(G.disc, new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.16, depthWrite: false }));
      const edge = new THREE.Mesh(G.ring, new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.6, depthWrite: false }));
      disc.scale.setScalar(z.r); edge.scale.setScalar(z.r);
      g.add(disc, edge);
      g.position.set(z.x, 4, z.y);
      this.ctx.scene.add(g);
      this.zones.set(z.i, g);
    }
    for (const [id, o] of this.zones) if (!seen.has(id)) { this.ctx.scene.remove(o); this.zones.delete(id); }
  }

  update(v: View, dt: number) {
    this.syncStatuses(v);
    this.syncProjectiles(v);
    this.syncZones(v);
    for (const l of this.live) { l.t += dt; l.update(Math.min(1, l.t / l.d), l.t); }
    for (const l of this.live) if (l.t >= l.d) this.ctx.scene.remove(l.obj);
    this.live = this.live.filter((l) => l.t < l.d);
  }

  dispose() {}
}
