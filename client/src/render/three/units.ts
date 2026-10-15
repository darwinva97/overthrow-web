// Capa de unidades del modo 3D: modelos procedurales por héroe y por tipo de unidad, animación
// según el estado del servidor y su ciclo de vida (aparición, golpes, muerte).
// Los estados visuales (aturdido, escudos, auras…) los dibuja la capa de efectos.
//
// Rendimiento: cada unidad es una sola SkinnedMesh (geometría cacheada por tipo, material y
// textura de paleta compartidos), los anillos del suelo van todos en dos InstancedMesh y solo
// los héroes proyectan sombra.
import * as THREE from 'three';
import { ABILITIES, HEROES, heroIcon } from '../../../../shared/data';
import { ST, type Fx } from '../../../../shared/sim/types';
import type { VUnit } from '../../game/state';
import { ORB_COLOR } from '../fxstyle';
import { img } from '../images';
import { DEATH_TIME, newAnim, pose, rigOf, step, type AnimIn, type AnimState, type Rig } from '../models/animate';
import { instantiate, ownMaterial, unitMaterial, type ModelInst, type Tint } from '../models/builder';
import { heroModel, hexModel, unitModel } from '../models/index';
import { teamColor, type View } from '../types';
import { G, hashStr, type ThreeCtx } from './shared';

interface Puppet { inst: ModelInst; rig: Rig }

export interface UnitObj {
  /** Raíz en el suelo, en la posición de la unidad (la capa de efectos le cuelga cosas). */
  root: THREE.Group;
  /** Cuerpo: gira hacia donde mira la unidad y lleva la escala del modelo. */
  body: THREE.Group;
  sprite: THREE.Sprite | null;
  /** Materiales propios (solo fuente, trono y orbes). */
  mats: THREE.Material[];
  key: string;
  alpha: number;
  extra?: THREE.Object3D;
  /** Modelo animado y su estado. */
  puppet: Puppet | null;
  hex: Puppet | null;
  anim: AnimState;
  /** Anillo de equipo: color, radio y grupo (0 brillante, 1 tenue, -1 sin anillo). */
  ringColor: THREE.Color;
  ringScale: number;
  ringGroup: number;
  face: number;
  lastH: number;
  flash: number;
  /** Material propio mientras muere (para el fundido). */
  fade: THREE.MeshStandardMaterial | null;
  hero: boolean;
  /** Ilusión propia (tinte azul). */
  ill: boolean;
  stamp: number;
  gone: number;
}

const RING_CAP = 1024;
const tmpM = new THREE.Matrix4();
const tmpP = new THREE.Vector3();
const tmpQ = new THREE.Quaternion();
const tmpS = new THREE.Vector3();
const CREEP_RING = new THREE.Color('#c9a24a');
const NO_FX: string[] = [];
const NO_INPUT: AnimIn = { speed: 0, attacking: false, cast: 0, stunned: false, aim: false };
const input: AnimIn = { speed: 0, attacking: false, cast: 0, stunned: false, aim: false };
/** Habilidad → ¿tiene objetivo? (para la pose de lanzamiento). */
const aimed = new Map<string, boolean>();
function isAimed(ck: string | undefined): boolean {
  if (!ck) return false;
  let r = aimed.get(ck);
  if (r === undefined) {
    const b = ABILITIES[ck]?.behavior ?? [];
    r = b.includes('unit_target') || b.includes('point');
    aimed.set(ck, r);
  }
  return r;
}

const lerpAngle = (a: number, b: number, t: number) => {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
};

export class UnitLayer {
  private ctx: ThreeCtx;
  readonly units = new Map<number, UnitObj>();
  private iconTextures = new Map<string, THREE.CanvasTexture>();
  /** Unidades que acaban de desaparecer del snapshot: se esperan un momento por si llega su muerte. */
  private vanished = new Map<number, UnitObj>();
  private dying: UnitObj[] = [];
  /** Muertes recientes: no se recrean aunque sigan un instante en el snapshot. */
  private deaths = new Map<number, number>();
  private rings: THREE.InstancedMesh[];
  private frame = 0;

  constructor(ctx: ThreeCtx) {
    this.ctx = ctx;
    this.rings = [0.85, 0.38].map((opacity) => {
      const m = new THREE.InstancedMesh(G.ring, new THREE.MeshBasicMaterial({ transparent: true, opacity, depthWrite: false }), RING_CAP);
      m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(RING_CAP * 3), 3);
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.frustumCulled = false;
      m.count = 0;
      m.renderOrder = -1;
      ctx.scene.add(m);
      return m;
    });
  }

  /** Objeto 3D de una unidad (raíz en el suelo); la capa de efectos le cuelga cosas. */
  get(id: number): UnitObj | undefined { return this.units.get(id); }

  /** Eventos del servidor que afectan a la animación: la muerte deja una copia que cae y se desvanece. */
  onFx(f: Fx, _v: View) {
    if (f.n !== 'death' || !f.u) return;
    const o = this.units.get(f.u) ?? this.vanished.get(f.u);
    this.deaths.set(f.u, this.ctx.clock);
    if (!o) return;
    this.units.delete(f.u);
    this.vanished.delete(f.u);
    if (!o.puppet) { this.drop(o); return; }
    o.root.visible = true;
    o.anim.dead = 0;
    o.puppet.inst.mesh.visible = true;
    if (o.hex) o.hex.inst.mesh.visible = false;
    if (o.sprite) o.sprite.visible = false;
    const m = ownMaterial(o.ill ? 'illusion' : 'none');
    o.fade = m;
    o.puppet.inst.mesh.material = m;
    this.dying.push(o);
  }

  /** Altura de la cabeza en unidades de mundo, para barras y estados. */
  headHeight(u: VUnit): number {
    const o = this.units.get(u.i);
    if (o?.puppet) {
      const d = o.puppet.inst.def;
      return (d.height + (d.anim.hover ?? 0)) * d.scale + 10;
    }
    return u.k === 'hero' || u.k === 'illusion' ? 180 : u.k === 'creep' || u.k === 'summon' ? 120 : 100;
  }

  private iconTexture(hero: string, team: string): THREE.CanvasTexture {
    const key = hero + team;
    let t = this.iconTextures.get(key);
    if (t) return t;
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const x = c.getContext('2d')!;
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const draw = (im?: HTMLImageElement) => {
      x.clearRect(0, 0, 128, 128);
      // Sombra suave, retrato recortado en círculo y aro del color del equipo.
      x.fillStyle = 'rgba(0,0,0,0.45)';
      x.beginPath(); x.arc(64, 68, 54, 0, Math.PI * 2); x.fill();
      x.save();
      x.beginPath(); x.arc(64, 64, 46, 0, Math.PI * 2); x.clip();
      x.fillStyle = '#1a1820'; x.fill();
      if (im) { const s = Math.max(92 / im.naturalWidth, 92 / im.naturalHeight); const w = im.naturalWidth * s, h = im.naturalHeight * s; x.drawImage(im, 64 - w / 2, 64 - h / 2, w, h); }
      x.restore();
      x.lineWidth = 7; x.strokeStyle = team;
      x.beginPath(); x.arc(64, 64, 48, 0, Math.PI * 2); x.stroke();
      x.lineWidth = 2; x.strokeStyle = 'rgba(0,0,0,0.7)';
      x.beginPath(); x.arc(64, 64, 52, 0, Math.PI * 2); x.stroke();
      tex.needsUpdate = true;
    };
    draw();
    const im = img(heroIcon(hero));
    if (im.complete && im.naturalWidth) draw(im); else im.addEventListener('load', () => draw(im), { once: true });
    this.iconTextures.set(key, tex);
    return tex;
  }

  private puppetFor(u: VUnit): Puppet | null {
    let def;
    if (u.k === 'hero' || u.k === 'illusion') def = heroModel(u.n);
    else if (u.k === 'kobold') def = unitModel('creep', 'kobold_king');
    else if (u.k === 'creep' || u.k === 'summon' || u.k === 'ward') {
      const hero = HEROES[u.n] ? u.n : u.n.endsWith('_remnant') ? (u.n.startsWith('stormspirit') ? 'storm_spirit' : u.n.startsWith('ember') ? 'ember_spirit' : '') : '';
      def = hero ? heroModel(hero) : unitModel(u.k, u.n);
    } else return null;
    const inst = instantiate(def, unitMaterial());
    inst.mesh.castShadow = u.k === 'hero' || u.k === 'illusion';
    return { inst, rig: rigOf(inst) };
  }

  private makeUnit(u: VUnit, v: View): UnitObj {
    const root = new THREE.Group();
    const body = new THREE.Group();
    root.add(body);
    const team = teamColor(v, u.t);
    const o: UnitObj = {
      root, body, sprite: null, mats: [], key: u.k + u.n + u.t, alpha: 1, puppet: null, hex: null,
      anim: newAnim((hashStr('u' + u.i) % 997) / 997), ringColor: new THREE.Color(team), ringScale: 40, ringGroup: 0,
      face: -u.f, lastH: u.h, flash: 0, fade: null, hero: u.k === 'hero' || u.k === 'illusion', ill: false, stamp: 0, gone: 0,
    };
    const std = (color: string | THREE.Color, extra: THREE.MeshStandardMaterialParameters = {}) => {
      const m = new THREE.MeshStandardMaterial({ color, roughness: 0.65, flatShading: true, ...extra });
      o.mats.push(m);
      return m;
    };
    const mesh = (geo: THREE.BufferGeometry, mat: THREE.Material, x = 0, y = 0, z = 0) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      m.castShadow = true;
      body.add(m);
      return m;
    };

    o.puppet = this.puppetFor(u);
    if (o.puppet) {
      body.add(o.puppet.inst.mesh);
      body.scale.setScalar(o.puppet.inst.def.scale);
    }
    if (o.hero) {
      o.ringScale = 40;
      const d = o.puppet!.inst.def;
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.iconTexture(u.n, team), depthTest: false, transparent: true }));
      sp.position.y = (d.height + (d.anim.hover ?? 0)) * d.scale + 34;
      sp.scale.setScalar(44);
      sp.renderOrder = 10;
      root.add(sp);
      o.sprite = sp;
    } else if (u.k === 'creep' || u.k === 'summon') {
      o.ringScale = u.r * 1.4;
      if (u.k === 'creep') { o.ringColor.copy(CREEP_RING); o.ringGroup = 1; }
    } else if (u.k === 'ward') {
      o.ringScale = 26;
    } else if (u.k === 'kobold') {
      o.ringGroup = -1;
    } else if (u.k === 'fountain') {
      mesh(new THREE.CylinderGeometry(90, 110, 40, 10), std('#3a3442'), 0, 20, 0);
      mesh(new THREE.CylinderGeometry(55, 70, 50, 10), std('#4a4252'), 0, 65, 0);
      const crystal = mesh(new THREE.OctahedronGeometry(38), std(team, { emissive: team, emissiveIntensity: 1.8 }), 0, 150, 0);
      crystal.scale.y = 1.7;
      o.extra = crystal;
      o.ringScale = 130;
    } else if (u.k === 'throne') {
      const gold = std('#e0a84a', { metalness: 0.9, roughness: 0.3, flatShading: true });
      mesh(new THREE.CylinderGeometry(130, 150, 30, 8), std('#3a2a1a'), 0, 15, 0);
      mesh(new THREE.CylinderGeometry(100, 120, 40, 8), gold, 0, 50, 0);
      mesh(new THREE.BoxGeometry(80, 40, 90), gold, 0, 90, 0);
      mesh(new THREE.BoxGeometry(20, 140, 100), gold, -45, 150, 0);
      for (const z of [-55, 55]) mesh(new THREE.BoxGeometry(70, 20, 14), gold, 0, 118, z);
      mesh(G.gem, std('#ff4040', { emissive: '#ff2020', emissiveIntensity: 2 }), -38, 205, 0).scale.setScalar(2);
      o.ringGroup = -1;
    } else if (u.k === 'orb') {
      const orb = v.orbs.find((q) => q.i === u.i);
      const col = ORB_COLOR[orb?.r ?? 'common'];
      const gem = mesh(G.orb, std(col, { emissive: col, emissiveIntensity: 2.5 }), 0, 90, 0);
      o.extra = gem;
      const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.ctx.glow, color: col, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
      halo.position.y = 90; halo.scale.setScalar(240);
      root.add(halo);
      o.ringScale = 220;
      o.ringColor.set(col);
      o.ringGroup = 1;
    }
    this.ctx.scene.add(root);
    return o;
  }

  /** Libera una unidad: su esqueleto, materiales propios y el sprite. */
  private drop(o: UnitObj) {
    this.ctx.scene.remove(o.root);
    for (const p of [o.puppet, o.hex]) if (p) p.inst.mesh.skeleton.dispose();
    for (const m of o.mats) m.dispose();
    o.fade?.dispose();
    (o.sprite?.material as THREE.SpriteMaterial | undefined)?.dispose();
    if (o.root.userData.arcs) for (const c of (o.root.userData.arcs as THREE.Group).children) { (c as THREE.Mesh).geometry.dispose(); ((c as THREE.Mesh).material as THREE.Material).dispose(); }
  }

  update(v: View, dt: number) {
    const clock = this.ctx.clock;
    const frame = ++this.frame;
    for (const [id, t] of this.deaths) if (clock - t > 1.2) this.deaths.delete(id);
    for (const u of v.units) {
      if (this.deaths.has(u.i)) continue;
      let o = this.units.get(u.i);
      const key = u.k + u.n + u.t;
      if (!o) {
        const back = this.vanished.get(u.i);
        if (back && back.key === key) { o = back; this.vanished.delete(u.i); this.units.set(u.i, o); }
      }
      if (o && o.key !== key) { this.drop(o); this.units.delete(u.i); o = undefined; }
      if (!o) { o = this.makeUnit(u, v); this.units.set(u.i, o); }
      o.stamp = frame;
      this.animateUnit(o, u, v, dt);
    }
    // Las que ya no están: se ocultan y se esperan por si llega su muerte.
    for (const [id, o] of this.units) {
      if (o.stamp === frame) continue;
      this.units.delete(id);
      o.root.visible = false;
      o.gone = clock;
      this.vanished.set(id, o);
    }
    for (const [id, o] of this.vanished) if (clock - o.gone > 0.45) { this.drop(o); this.vanished.delete(id); }
    // Muertes en curso
    for (let i = this.dying.length - 1; i >= 0; i--) {
      const o = this.dying[i];
      const p = o.puppet!;
      step(o.anim, NO_INPUT, dt, p.inst.def.scale);
      pose(p.inst, p.rig, o.anim);
      const k = (o.anim.dead - 0.9) / (DEATH_TIME - 0.9);
      if (o.fade) {
        const a = Math.max(0, Math.min(1, 1 - k));
        o.fade.opacity = a;
        o.fade.transparent = a < 0.99;
        o.fade.depthWrite = a > 0.5;
      }
      if (o.anim.dead >= DEATH_TIME) { this.drop(o); this.dying.splice(i, 1); }
    }
    this.updateRings();
  }

  private animateUnit(o: UnitObj, u: VUnit, v: View, dt: number) {
    const fx = u.fx ?? NO_FX;
    const flying = (u.s & ST.flying) !== 0;
    o.root.visible = !(u.s & ST.hidden);
    o.root.position.set(u.px, flying && !o.puppet?.inst.def.anim.hover ? 120 : 0, u.py);
    if (o.extra) { o.extra.rotation.y += dt * 1.5; o.extra.position.y = (u.k === 'orb' ? 90 : 150) + Math.sin(this.ctx.clock * 2) * 8; }
    if (u.k === 'orb') this.updateOrbProgress(o, u, v);
    const p = o.puppet;
    if (!p) return;

    // Orientación con un poco de suavizado
    o.face = lerpAngle(o.face, -u.pf, Math.min(1, dt * 16));
    o.body.rotation.y = o.face;
    o.body.position.set(0, 0, 0);
    if (fx.includes('blade_fury')) o.body.rotation.y = this.ctx.clock * 25;
    if (fx.includes('cyclone')) { o.body.position.y = 90 + Math.sin(this.ctx.clock * 5) * 10; o.body.rotation.y = this.ctx.clock * 12; }

    // Golpe recibido: sacudida y destello
    if (u.h < o.lastH - 0.5 && u.h > 0) { o.anim.hit = 0; o.flash = 0.11; }
    o.lastH = u.h;
    o.flash = Math.max(0, o.flash - dt);

    // Maleficio: se convierte en rana
    const hexed = fx.includes('hex') || (u.s & ST.hexed) !== 0;
    if (hexed && !o.hex) {
      const inst = instantiate(hexModel(), unitMaterial());
      o.hex = { inst, rig: rigOf(inst) };
      o.body.add(inst.mesh);
      inst.mesh.scale.setScalar(hexModel().scale / p.inst.def.scale);
    }
    p.inst.mesh.visible = !hexed;
    if (o.hex) o.hex.inst.mesh.visible = hexed;
    const cur = hexed && o.hex ? o.hex : p;

    // Animación
    const frozen = fx.includes('frostbite');
    input.speed = u.speed;
    input.attacking = u.a === 1;
    input.cast = u.c ?? 0;
    input.stunned = (u.s & ST.stunned) !== 0 || fx.includes('stun');
    input.aim = isAimed(u.ck);
    if (!frozen) step(o.anim, input, dt, p.inst.def.scale);
    pose(cur.inst, cur.rig, o.anim);

    // Material: tinte de ilusión propia, destello al recibir golpe y transparencia
    const ill = !!(u.il && u.o);
    o.ill = ill;
    const tint: Tint = o.flash > 0 ? (ill ? 'flash-illusion' : 'flash') : ill ? 'illusion' : 'none';
    const alpha = fx.includes('invis') || fx.includes('ethereal') || fx.includes('doppel') ? 0.4 : u.n.endsWith('_remnant') ? 0.6 : 1;
    o.alpha = alpha;
    const mat = unitMaterial(tint, alpha);
    if (cur.inst.mesh.material !== mat) cur.inst.mesh.material = mat;
    if (o.sprite) o.sprite.material.opacity = alpha < 1 ? 0.6 : 1;
  }

  /** Anillos de equipo: todos en dos InstancedMesh (brillantes y tenues). */
  private updateRings() {
    const [hi, lo] = this.rings;
    let nh = 0, nl = 0;
    tmpQ.identity();
    for (const o of this.units.values()) {
      if (o.ringGroup < 0 || !o.root.visible) continue;
      const m = o.ringGroup === 0 ? hi : lo;
      const i = o.ringGroup === 0 ? nh++ : nl++;
      if (i >= RING_CAP) continue;
      tmpP.set(o.root.position.x, 2, o.root.position.z);
      tmpS.setScalar(o.ringScale);
      m.setMatrixAt(i, tmpM.compose(tmpP, tmpQ, tmpS));
      m.setColorAt(i, o.ringColor);
    }
    hi.count = Math.min(nh, RING_CAP); lo.count = Math.min(nl, RING_CAP);
    for (const m of this.rings) { m.instanceMatrix.needsUpdate = true; if (m.instanceColor) m.instanceColor.needsUpdate = true; }
  }

  private updateOrbProgress(o: UnitObj, u: VUnit, v: View) {
    const orb = v.orbs.find((q) => q.i === u.i);
    let arcs = o.root.userData.arcs as THREE.Group | undefined;
    if (!arcs) { arcs = new THREE.Group(); o.root.userData.arcs = arcs; o.root.add(arcs); }
    const sig = JSON.stringify(orb?.p ?? []);
    if (arcs.userData.sig === sig) return;
    arcs.userData.sig = sig;
    for (const c of arcs.children) { (c as THREE.Mesh).geometry.dispose(); ((c as THREE.Mesh).material as THREE.Material).dispose(); }
    arcs.clear();
    for (const [t, pr] of orb?.p ?? []) {
      const geo = new THREE.RingGeometry(205, 235, 64, 1, Math.PI / 2, -(pr / v.captureTime) * Math.PI * 2);
      geo.rotateX(-Math.PI / 2);
      const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: teamColor(v, t), transparent: true, opacity: 0.9, depthWrite: false }));
      m.position.y = 6;
      arcs.add(m);
    }
  }

  dispose() {
    for (const o of this.units.values()) this.drop(o);
    for (const o of this.vanished.values()) this.drop(o);
    for (const o of this.dying) this.drop(o);
    this.units.clear(); this.vanished.clear(); this.dying.length = 0;
    for (const m of this.rings) { this.ctx.scene.remove(m); (m.material as THREE.Material).dispose(); m.dispose(); }
    for (const t of this.iconTextures.values()) t.dispose();
  }
}
