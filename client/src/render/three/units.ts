// Capa de unidades del modo 3D: modelos, animación y su ciclo de vida.
// Los estados visuales (aturdido, escudos, auras…) los dibuja la capa de efectos.
import * as THREE from 'three';
import { HEROES, heroIcon } from '../../../../shared/data';
import { ST, type Fx } from '../../../../shared/sim/types';
import type { VUnit } from '../../game/state';
import { ATTR_COLOR, ORB_COLOR } from '../fxstyle';
import { img } from '../images';
import { teamColor, type View } from '../types';
import { G, hashStr, type ThreeCtx } from './shared';

export interface UnitObj {
  root: THREE.Group;
  body: THREE.Group;
  ring: THREE.Mesh;
  sprite: THREE.Sprite | null;
  mats: THREE.Material[];
  key: string;
  legs: THREE.Object3D[];
  alpha: number;
  extra?: THREE.Object3D;
}

export class UnitLayer {
  private ctx: ThreeCtx;
  readonly units = new Map<number, UnitObj>();
  private iconTextures = new Map<string, THREE.CanvasTexture>();

  constructor(ctx: ThreeCtx) { this.ctx = ctx; }

  /** Objeto 3D de una unidad (raíz en el suelo); la capa de efectos le cuelga cosas. */
  get(id: number): UnitObj | undefined { return this.units.get(id); }

  /** Eventos del servidor que afectan a la animación (muerte, golpe, lanzamiento…). */
  onFx(_f: Fx, _v: View) {}

  /** Altura de la cabeza en unidades de mundo, para barras y estados. */
  headHeight(u: VUnit): number { return u.k === 'hero' || u.k === 'illusion' ? 180 : u.k === 'creep' || u.k === 'summon' ? 120 : 100; }

  private iconTexture(hero: string, team: string): THREE.CanvasTexture {
    const key = hero + team;
    let t = this.iconTextures.get(key);
    if (t) return t;
    const c = document.createElement('canvas');
    c.width = c.height = 96;
    const x = c.getContext('2d')!;
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const draw = (im?: HTMLImageElement) => {
      x.clearRect(0, 0, 96, 96);
      x.save();
      x.beginPath(); x.arc(48, 48, 40, 0, Math.PI * 2); x.clip();
      x.fillStyle = '#222'; x.fill();
      if (im) x.drawImage(im, 8, 8, 80, 80);
      x.restore();
      x.lineWidth = 7; x.strokeStyle = team;
      x.beginPath(); x.arc(48, 48, 41, 0, Math.PI * 2); x.stroke();
      tex.needsUpdate = true;
    };
    draw();
    const im = img(heroIcon(hero));
    if (im.complete && im.naturalWidth) draw(im); else im.addEventListener('load', () => draw(im), { once: true });
    this.iconTextures.set(key, tex);
    return tex;
  }


  private makeUnit(u: VUnit, v: View): UnitObj {
    const root = new THREE.Group();
    const body = new THREE.Group();
    root.add(body);
    const team = teamColor(v, u.t);
    const mats: THREE.Material[] = [];
    const std = (color: string | THREE.Color, extra: THREE.MeshStandardMaterialParameters = {}) => {
      const m = new THREE.MeshStandardMaterial({ color, roughness: 0.65, flatShading: true, ...extra });
      mats.push(m);
      return m;
    };
    const mesh = (geo: THREE.BufferGeometry, mat: THREE.Material, x = 0, y = 0, z = 0) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      m.castShadow = true;
      body.add(m);
      return m;
    };
    const legs: THREE.Object3D[] = [];
    let sprite: THREE.Sprite | null = null;
    let extra: THREE.Object3D | undefined;
    const ringMat = new THREE.MeshBasicMaterial({ color: team, transparent: true, opacity: 0.85, depthWrite: false });
    const ring = new THREE.Mesh(G.ring, ringMat);
    ring.position.y = 2;
    root.add(ring);

    if (u.k === 'hero' || u.k === 'illusion') {
      const h = HEROES[u.n];
      const attr = new THREE.Color(ATTR_COLOR[h?.attr ?? 'all']);
      const accent = new THREE.Color().setHSL((hashStr(u.n) % 360) / 360, 0.5, 0.42);
      const skin = new THREE.Color().setHSL(((hashStr(u.n) >> 3) % 60) / 360 + 0.03, 0.35, 0.62);
      for (const sx of [-9, 9]) { const l = mesh(G.leg, std('#3a3040'), 0, 20, sx); legs.push(l); }
      mesh(G.torso, std(attr), 0, 62, 0);
      const cl = mesh(G.cloak, std(accent, { side: THREE.DoubleSide }), -4, 52, 0);
      cl.rotation.z = 0.12;
      mesh(G.head, std(skin), 2, 102, 0);
      mesh(G.pad, std(team), 0, 84, -18);
      mesh(G.pad, std(team), 0, 84, 18);
      if (h?.melee) {
        const b = mesh(G.blade, std('#d8d8e0', { metalness: 0.8, roughness: 0.3 }), 30, 64, 22);
        b.rotation.z = -0.5;
      } else {
        const st = mesh(G.staff, std('#6a4a2a'), 20, 66, 22);
        st.rotation.z = 0.15;
        mesh(G.gem, std(attr, { emissive: attr, emissiveIntensity: 1.5 }), 26, 112, 22);
      }
      body.scale.setScalar(1.25);
      ring.scale.setScalar(40);
      sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.iconTexture(u.n, team), depthTest: false, transparent: true }));
      sprite.position.y = 190;
      sprite.scale.setScalar(54);
      sprite.renderOrder = 10;
      root.add(sprite);
    } else if (u.k === 'creep' || u.k === 'summon') {
      const colors: Record<string, string> = { kobold: '#8a6a4a', wolf: '#8c8c96', satyr: '#7a4aa0', centaur: '#a07a3a', ogre: '#7a8a5a', golem: '#6a6a72', bear: '#6a4a2a', treant: '#4a6a2a', ward: '#3a5a2a' };
      const c = Object.entries(colors).find(([k]) => u.n.includes(k))?.[1] ?? (u.k === 'summon' ? '#6a7a8a' : '#888');
      if (u.n.includes('wolf') || u.n.includes('boar') || u.n.includes('hawk')) {
        const torso = mesh(G.sphere, std(c), 0, 30, 0); torso.scale.set(34, 18, 15);
        mesh(G.sphere, std(c), 32, 40, 0).scale.set(12, 11, 10);
        for (const [x, z] of [[-18, -8], [-18, 8], [18, -8], [18, 8]]) legs.push(mesh(G.leg, std('#555'), x, 12, z));
      } else {
        const big = u.n === 'centaur' ? 1.5 : u.n === 'satyr' ? 1.15 : 0.85;
        for (const sx of [-8, 8]) legs.push(mesh(G.leg, std('#3a3030'), 0, 20, sx));
        mesh(G.torso, std(c), 0, 58, 0);
        mesh(G.head, std(c), 0, 96, 0);
        if (u.n === 'satyr') { const hn = mesh(new THREE.ConeGeometry(4, 18, 5), std('#ddd'), 0, 112, 8); hn.rotation.x = 0.4; }
        body.scale.setScalar(big);
      }
      ring.scale.setScalar(u.r * 1.4);
      if (u.k === 'creep') { ringMat.color.set('#c9a24a'); ringMat.opacity = 0.35; }
    } else if (u.k === 'ward') {
      mesh(new THREE.CylinderGeometry(6, 10, 70, 6), std('#3a5a2a'), 0, 35, 0);
      mesh(G.gem, std('#9cff9c', { emissive: '#4cff4c', emissiveIntensity: 2 }), 0, 82, 0).scale.setScalar(1.6);
      ring.scale.setScalar(26);
    } else if (u.k === 'fountain') {
      mesh(new THREE.CylinderGeometry(90, 110, 40, 10), std('#3a3442'), 0, 20, 0);
      mesh(new THREE.CylinderGeometry(55, 70, 50, 10), std('#4a4252'), 0, 65, 0);
      const crystal = mesh(new THREE.OctahedronGeometry(38), std(team, { emissive: team, emissiveIntensity: 1.8 }), 0, 150, 0);
      crystal.scale.y = 1.7;
      extra = crystal;
      ring.scale.setScalar(130);
    } else if (u.k === 'throne') {
      const gold = std('#e0a84a', { metalness: 0.9, roughness: 0.3, flatShading: true });
      mesh(new THREE.CylinderGeometry(130, 150, 30, 8), std('#3a2a1a'), 0, 15, 0);
      mesh(new THREE.CylinderGeometry(100, 120, 40, 8), gold, 0, 50, 0);
      mesh(new THREE.BoxGeometry(80, 40, 90), gold, 0, 90, 0);
      mesh(new THREE.BoxGeometry(20, 140, 100), gold, -45, 150, 0);
      for (const z of [-55, 55]) mesh(new THREE.BoxGeometry(70, 20, 14), gold, 0, 118, z);
      mesh(G.gem, std('#ff4040', { emissive: '#ff2020', emissiveIntensity: 2 }), -38, 205, 0).scale.setScalar(2);
      ring.visible = false;
    } else if (u.k === 'kobold') {
      for (const sx of [-6, 6]) legs.push(mesh(G.leg, std('#4a3424'), 0, 16, sx));
      mesh(G.torso, std('#7a5434'), 0, 46, 0).scale.setScalar(0.8);
      mesh(G.head, std('#8a6444'), 0, 76, 0);
      mesh(new THREE.ConeGeometry(12, 22, 5), std('#f6cf7c', { metalness: 0.8, roughness: 0.3 }), 0, 98, 0);
      body.scale.setScalar(1.6);
      ring.visible = false;
    } else if (u.k === 'orb') {
      const o = v.orbs.find((q) => q.i === u.i);
      const col = ORB_COLOR[o?.r ?? 'common'];
      const gem = mesh(G.orb, std(col, { emissive: col, emissiveIntensity: 2.5 }), 0, 90, 0);
      extra = gem;
      const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.ctx.glow, color: col, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
      halo.position.y = 90; halo.scale.setScalar(240);
      root.add(halo);
      ring.scale.setScalar(220);
      ringMat.color.set(col);
      ringMat.opacity = 0.4;
    }
    root.traverse((o) => { if ((o as THREE.Mesh).isMesh && o !== ring) (o as THREE.Mesh).castShadow = true; });
    this.ctx.scene.add(root);
    return { root, body, ring, sprite, mats, key: u.k + u.n + u.t, legs, alpha: 1, extra };
  }


  update(v: View, dt: number) {
    const seen = new Set<number>();
    for (const u of v.units) {
      seen.add(u.i);
      let o = this.units.get(u.i);
      const key = u.k + u.n + u.t;
      if (o && o.key !== key) { this.ctx.scene.remove(o.root); o = undefined; }
      if (!o) { o = this.makeUnit(u, v); this.units.set(u.i, o); }
      const fx = u.fx ?? [];
      o.root.visible = !(u.s & ST.hidden);
      o.root.position.set(u.px, (u.s & ST.flying) !== 0 ? 120 : 0, u.py);
      o.body.rotation.y = -u.pf;
      // Paso, golpe y estados que mueven el cuerpo.
      const moving = u.speed > 30;
      const phase = this.ctx.clock * (u.speed / 40 + 4);
      o.body.position.y = moving ? Math.abs(Math.sin(phase)) * 6 : 0;
      o.legs.forEach((l, i) => { l.rotation.z = moving ? Math.sin(phase + i * Math.PI) * 0.5 : 0; });
      o.body.position.x = u.a ? Math.cos(u.pf) * 14 : 0;
      o.body.position.z = u.a ? Math.sin(u.pf) * 14 : 0;
      if (fx.includes('blade_fury')) o.body.rotation.y = this.ctx.clock * 25;
      if (fx.includes('cyclone')) { o.body.position.y = 90 + Math.sin(this.ctx.clock * 5) * 10; o.body.rotation.y = this.ctx.clock * 12; }
      if (o.extra) { o.extra.rotation.y += dt * 1.5; o.extra.position.y = (u.k === 'orb' ? 90 : 150) + Math.sin(this.ctx.clock * 2) * 8; }
      const alpha = fx.includes('invis') || fx.includes('ethereal') || fx.includes('doppel') ? 0.4 : 1;
      if (alpha !== o.alpha) {
        o.alpha = alpha;
        for (const m of o.mats) { m.transparent = alpha < 1; m.opacity = alpha; m.needsUpdate = true; }
      }
      if (u.il && u.o) for (const m of o.mats) (m as THREE.MeshStandardMaterial).emissive?.set('#1a3a7a');
      if (u.k === 'orb') this.updateOrbProgress(o, u, v);
    }
    for (const [id, o] of this.units) if (!seen.has(id)) { this.ctx.scene.remove(o.root); this.units.delete(id); }
  }

  private updateOrbProgress(o: UnitObj, u: VUnit, v: View) {
    const orb = v.orbs.find((q) => q.i === u.i);
    let arcs = o.root.getObjectByName('arcs') as THREE.Group | undefined;
    if (!arcs) { arcs = new THREE.Group(); arcs.name = 'arcs'; o.root.add(arcs); }
    const sig = JSON.stringify(orb?.p ?? []);
    if (arcs.userData.sig === sig) return;
    arcs.userData.sig = sig;
    arcs.clear();
    for (const [t, p] of orb?.p ?? []) {
      const geo = new THREE.RingGeometry(205, 235, 64, 1, Math.PI / 2, -(p / v.captureTime) * Math.PI * 2);
      geo.rotateX(-Math.PI / 2);
      const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: teamColor(v, t), transparent: true, opacity: 0.9, depthWrite: false }));
      m.position.y = 6;
      arcs.add(m);
    }
  }

  dispose() { for (const o of this.units.values()) this.ctx.scene.remove(o.root); this.units.clear(); }
}
