// Modo 3D con Three.js: misma vista que el 2D, con modelos low-poly propios (no los de Valve).
import * as THREE from 'three';
import { HEROES, heroIcon } from '../../../shared/data';
import type { MapLayout } from '../../../shared/maps';
import { FREE, ROCK, TREE } from '../../../shared/sim/nav';
import type { Fx } from '../../../shared/sim/types';
import { ST } from '../../../shared/sim/types';
import type { VUnit } from '../game/state';
import { ATTR_COLOR, FX, ORB_COLOR, STATUS, projColor, projSize, type FxStyle } from './fxstyle';
import { img } from './images';
import { Overlay } from './overlay';
import { Fog, terrainCanvas } from './terrain';
import { teamColor, type Camera, type Renderer, type View } from './types';

const PITCH = (56 * Math.PI) / 180;
const BASE_DIST = 2300;

interface UnitObj {
  root: THREE.Group;
  body: THREE.Group;
  ring: THREE.Mesh;
  sprite: THREE.Sprite | null;
  status: Map<string, THREE.Object3D>;
  mats: THREE.Material[];
  key: string;
  legs: THREE.Object3D[];
  alpha: number;
  extra?: THREE.Object3D;
}

interface LiveFx { obj: THREE.Object3D; t: number; d: number; update(k: number, t: number): void }

const hashStr = (s: string) => { let h = 0; for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) | 0; return Math.abs(h); };

// Geometrías compartidas.
const G = {
  leg: new THREE.CylinderGeometry(5, 6, 40, 6),
  torso: new THREE.CapsuleGeometry(16, 24, 3, 8),
  cloak: new THREE.ConeGeometry(25, 58, 8, 1, true),
  head: new THREE.IcosahedronGeometry(13, 1),
  pad: new THREE.SphereGeometry(8, 8, 6),
  blade: new THREE.BoxGeometry(62, 4, 7),
  staff: new THREE.CylinderGeometry(2.5, 2.5, 90, 6),
  gem: new THREE.OctahedronGeometry(9),
  ring: new THREE.RingGeometry(0.82, 1, 48),
  disc: new THREE.CircleGeometry(1, 48),
  sphere: new THREE.SphereGeometry(1, 14, 10),
  orb: new THREE.IcosahedronGeometry(30, 0),
};
G.ring.rotateX(-Math.PI / 2);
G.disc.rotateX(-Math.PI / 2);

/** Textura radial blanca para brillos y destellos. */
function glowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const x = c.getContext('2d')!;
  const g = x.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.35, 'rgba(255,255,255,0.55)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = g;
  x.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class Three3DRenderer implements Renderer {
  readonly kind = '3d' as const;
  readonly canvas: HTMLCanvasElement;
  readonly elements: HTMLElement[];
  private overlayCanvas = document.createElement('canvas');
  private octx = this.overlayCanvas.getContext('2d')!;
  private gl: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(40, 1, 50, 20000);
  private sun = new THREE.DirectionalLight(0xfff1d6, 2.2);
  private hemi = new THREE.HemisphereLight(0xc8c0ff, 0x2a2018, 1.1);
  private units = new Map<number, UnitObj>();
  private projs = new Map<number, THREE.Object3D>();
  private zones = new Map<number, THREE.Object3D>();
  private live: LiveFx[] = [];
  private overlay = new Overlay();
  private fog: Fog;
  private fogTex: THREE.CanvasTexture;
  private fogUniforms: Record<string, THREE.IUniform>;
  private glow = glowTexture();
  private W = 1; private H = 1;
  private clock = 0;
  private L: MapLayout;
  private ray = new THREE.Raycaster();
  private ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private rangeRing: THREE.Mesh;
  private aoeDisc: THREE.Mesh;
  private hoverRing: THREE.Mesh;
  private marker: THREE.Mesh;
  private iconTextures = new Map<string, THREE.CanvasTexture>();
  /** Árboles instanciados: celda → índice, para ocultar los talados. */
  private treeCells: number[] = [];
  private treeMeshes: THREE.InstancedMesh[] = [];
  private treeMatrices: THREE.Matrix4[] = [];

  constructor(L: MapLayout, teamColors: string[]) {
    this.L = L;
    this.gl = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.gl.shadowMap.enabled = true;
    this.gl.shadowMap.type = THREE.PCFSoftShadowMap;
    this.gl.outputColorSpace = THREE.SRGBColorSpace;
    this.gl.toneMapping = THREE.ACESFilmicToneMapping;
    this.canvas = this.gl.domElement;
    this.canvas.className = 'world';
    this.overlayCanvas.className = 'overlay';
    this.elements = [this.canvas, this.overlayCanvas];
    this.scene.background = new THREE.Color('#0c0a10');

    this.fog = new Fog(L);
    this.fogTex = new THREE.CanvasTexture(this.fog.canvas);
    const size = L.grid.w * 64;
    this.fogUniforms = {
      fogMap: { value: this.fogTex },
      fogOrigin: { value: new THREE.Vector2(L.grid.ox, L.grid.oy) },
      fogSize: { value: size },
    };

    this.scene.add(this.hemi);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const sc = this.sun.shadow.camera;
    sc.left = -1700; sc.right = 1700; sc.top = 1700; sc.bottom = -1700; sc.near = 100; sc.far = 6000;
    this.sun.shadow.bias = -0.0008;
    this.scene.add(this.sun, this.sun.target);

    // Suelo con la misma pintura que el modo 2D, sin los árboles (aquí son mallas).
    const tex = new THREE.CanvasTexture(terrainCanvas(L, { trees: false, teamColors }));
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    const groundMat = this.fogged(new THREE.MeshStandardMaterial({ map: tex, roughness: 0.95 }));
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(size, size), groundMat);
    plane.rotation.x = -Math.PI / 2;
    plane.position.set(L.grid.ox + size / 2, 0, L.grid.oy + size / 2);
    plane.receiveShadow = true;
    this.scene.add(plane);
    this.buildForest();

    this.rangeRing = new THREE.Mesh(G.ring, new THREE.MeshBasicMaterial({ color: '#f6cf7c', transparent: true, opacity: 0.55, depthWrite: false }));
    this.aoeDisc = new THREE.Mesh(G.disc, new THREE.MeshBasicMaterial({ color: '#f6cf7c', transparent: true, opacity: 0.22, depthWrite: false }));
    this.hoverRing = new THREE.Mesh(G.ring, new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.7, depthWrite: false }));
    this.marker = new THREE.Mesh(G.ring, new THREE.MeshBasicMaterial({ color: '#78ff78', transparent: true, opacity: 0.9, depthWrite: false }));
    for (const m of [this.rangeRing, this.aoeDisc, this.hoverRing, this.marker]) { m.position.y = 3; m.visible = false; this.scene.add(m); }
  }

  /** Inyecta la niebla de guerra en el shader de un material del escenario. */
  private fogged<M extends THREE.Material>(mat: M): M {
    const U = this.fogUniforms;
    mat.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, U);
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vFogWorld;')
        .replace('#include <project_vertex>', `#include <project_vertex>
          vec4 fw = vec4(transformed, 1.0);
          #ifdef USE_INSTANCING
            fw = instanceMatrix * fw;
          #endif
          vFogWorld = (modelMatrix * fw).xyz;`);
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vFogWorld;\nuniform sampler2D fogMap;\nuniform vec2 fogOrigin;\nuniform float fogSize;')
        .replace('#include <dithering_fragment>', `#include <dithering_fragment>
          vec2 fuv = (vFogWorld.xz - fogOrigin) / fogSize;
          float fogA = texture2D(fogMap, vec2(fuv.x, 1.0 - fuv.y)).a;
          gl_FragColor.rgb *= 1.0 - fogA;`);
    };
    return mat;
  }

  private buildForest() {
    const g = this.L.grid;
    const trees: [number, number, number][] = [];
    const treeCells: number[] = [];
    const rocks: [number, number, number][] = [];
    const rnd = (a: number, b: number) => { let n = Math.imul(a, 73856093) ^ Math.imul(b, 19349663); n = Math.imul(n ^ (n >>> 13), 1274126177); return ((n >>> 0) % 10000) / 10000; };
    for (let cy = 0; cy < g.h; cy++) for (let cx = 0; cx < g.w; cx++) {
      const t = g.cells[cy * g.w + cx];
      const x = g.centerX(cx), y = g.centerY(cy);
      if (t === TREE) { trees.push([x + (rnd(cx, cy) - 0.5) * 30, y + (rnd(cy, cx) - 0.5) * 30, 0.8 + rnd(cx + 3, cy) * 0.5]); treeCells.push(cy * g.w + cx); }
      else if (t === ROCK) {
        // Solo las rocas que bordean zona jugable: el resto es fondo.
        let edge = false;
        for (let dy = -1; dy <= 1 && !edge; dy++) for (let dx = -1; dx <= 1; dx++) if (g.cellAt(cx + dx, cy + dy) !== ROCK) { edge = true; break; }
        if (edge && Math.hypot(x, y) > 200) rocks.push([x, y, 0.8 + rnd(cx, cy + 9) * 0.7]);
      }
    }
    void FREE;
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
    const canopyGeo = new THREE.ConeGeometry(46, 120, 7);
    canopyGeo.translate(0, 120, 0);
    const canopy2 = new THREE.ConeGeometry(36, 90, 7);
    canopy2.translate(0, 175, 0);
    const trunkGeo = new THREE.CylinderGeometry(7, 10, 70, 5);
    trunkGeo.translate(0, 35, 0);
    const mk = (geo: THREE.BufferGeometry, color: string, list: [number, number, number][], flat = true) => {
      const mat = this.fogged(new THREE.MeshStandardMaterial({ color, roughness: 0.9, flatShading: flat }));
      const im = new THREE.InstancedMesh(geo, mat, list.length);
      list.forEach(([x, y, k], i) => {
        q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), (x * 13 + y * 7) % 6.28);
        m.compose(p.set(x, 0, y), q, s.set(k, k, k));
        im.setMatrixAt(i, m);
      });
      im.castShadow = true;
      im.receiveShadow = true;
      this.scene.add(im);
      return im;
    };
    const tr = mk(trunkGeo, '#4a3424', trees);
    const c1 = mk(canopyGeo, '#2f5a32', trees);
    const c2 = mk(canopy2, '#3a6b3a', trees);
    this.treeCells = treeCells;
    this.treeMeshes = [tr, c1, c2];
    this.treeMatrices = trees.map((_, i) => { const mm = new THREE.Matrix4(); c1.getMatrixAt(i, mm); return mm; });
    // Variación de tono por árbol.
    const col = new THREE.Color();
    trees.forEach((t, i) => {
      col.setHSL(0.27 + (t[2] - 1) * 0.08, 0.38, 0.22 + (t[2] - 0.8) * 0.12);
      c1.setColorAt(i, col); c2.setColorAt(i, col.offsetHSL(0, 0, 0.05));
    });
    const rockGeo = new THREE.DodecahedronGeometry(52, 0);
    rockGeo.scale(1, 0.75, 1);
    rockGeo.translate(0, 22, 0);
    mk(rockGeo, '#4a4452', rocks);
  }

  private dynTrees: THREE.InstancedMesh[] = [];
  private dynRocks: THREE.InstancedMesh | null = null;

  treesChanged(changed: [number, number][]) {
    const g = this.L.grid;
    const zero = new THREE.Matrix4().makeScale(0, 0, 0);
    this.treeCells.forEach((cell, i) => {
      const m = g.cells[cell] === TREE ? this.treeMatrices[i] : zero;
      for (const im of this.treeMeshes) im.setMatrixAt(i, m);
    });
    for (const im of this.treeMeshes) im.instanceMatrix.needsUpdate = true;
    // Árboles y rocas nuevos: reserva fija de instancias.
    const initial = new Set(this.treeCells);
    const trees = changed.filter(([i, v]) => v === TREE && !initial.has(i)).map(([i]) => i).slice(0, 400);
    const rocks = changed.filter(([, v]) => v === ROCK).map(([i]) => i).slice(0, 400);
    if (!this.dynTrees.length) {
      this.dynTrees = this.treeMeshes.map((im) => {
        const d = new THREE.InstancedMesh(im.geometry, im.material, 400);
        d.castShadow = true; d.count = 0; this.scene.add(d); return d;
      });
      const rg = new THREE.DodecahedronGeometry(46, 0); rg.translate(0, 26, 0);
      this.dynRocks = new THREE.InstancedMesh(rg, this.fogged(new THREE.MeshStandardMaterial({ color: '#5a5262', flatShading: true })), 400);
      this.dynRocks.castShadow = true; this.dynRocks.count = 0; this.scene.add(this.dynRocks);
    }
    const m = new THREE.Matrix4();
    for (const d of this.dynTrees) {
      trees.forEach((cell, k) => { m.makeTranslation(g.centerX(cell % g.w), 0, g.centerY(Math.floor(cell / g.w))); d.setMatrixAt(k, m); });
      d.count = trees.length; d.instanceMatrix.needsUpdate = true;
    }
    rocks.forEach((cell, k) => { m.makeTranslation(g.centerX(cell % g.w), 0, g.centerY(Math.floor(cell / g.w))); this.dynRocks!.setMatrixAt(k, m); });
    this.dynRocks!.count = rocks.length; this.dynRocks!.instanceMatrix.needsUpdate = true;
  }

  resize(w: number, h: number, dpr: number) {
    this.W = w; this.H = h;
    this.gl.setPixelRatio(Math.min(dpr, 2));
    this.gl.setSize(w, h, false);
    this.overlayCanvas.width = Math.round(w * dpr);
    this.overlayCanvas.height = Math.round(h * dpr);
    this.octx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private placeCamera(cam: Camera) {
    const d = BASE_DIST / cam.zoom;
    this.camera.position.set(cam.x, Math.sin(PITCH) * d, cam.y + Math.cos(PITCH) * d);
    this.camera.lookAt(cam.x, 0, cam.y);
    this.camera.updateMatrixWorld();
  }

  screenToWorld(sx: number, sy: number, cam: Camera) {
    this.placeCamera(cam);
    const ndc = new THREE.Vector2((sx / this.W) * 2 - 1, -(sy / this.H) * 2 + 1);
    this.ray.setFromCamera(ndc, this.camera);
    const hit = new THREE.Vector3();
    if (!this.ray.ray.intersectPlane(this.ground, hit)) return { x: cam.x, y: cam.y };
    return { x: hit.x, y: hit.z };
  }

  worldToScreen(x: number, y: number, h: number, _cam: Camera) {
    const v = new THREE.Vector3(x, h, y).project(this.camera);
    return { x: (v.x + 1) / 2 * this.W, y: (1 - v.y) / 2 * this.H };
  }

  fx(f: Fx, v: View) {
    this.overlay.fx(f, v);
    let s: FxStyle | undefined = FX[f.n];
    if (f.n === 'orb_throw') s = { k: 'flash', c: ORB_COLOR[f.c ?? 'common'], d: f.d ?? 1.5 };
    if (!s) return;
    const d = f.d ?? s.d;
    const color = new THREE.Color(s.c);
    const add = (obj: THREE.Object3D, update: LiveFx['update']) => { this.scene.add(obj); this.live.push({ obj, t: 0, d, update }); };
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
        const disc = new THREE.Mesh(G.disc, new THREE.MeshBasicMaterial({ color, map: this.glow, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
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
          const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.glow, color, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
          sp.position.set(x, 70, y);
          sp.scale.setScalar(220);
          g.add(sp);
        }
        add(g, (k) => { for (const c of g.children) ((c as THREE.Sprite).material as THREE.SpriteMaterial).opacity = 1 - k; });
        break;
      }
    }
  }

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
      const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.glow, color: col, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
      halo.position.y = 90; halo.scale.setScalar(240);
      root.add(halo);
      ring.scale.setScalar(220);
      ringMat.color.set(col);
      ringMat.opacity = 0.4;
    }
    root.traverse((o) => { if ((o as THREE.Mesh).isMesh && o !== ring) (o as THREE.Mesh).castShadow = true; });
    this.scene.add(root);
    return { root, body, ring, sprite, status: new Map(), mats, key: u.k + u.n + u.t, legs, alpha: 1, extra };
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

  private syncUnits(v: View, dt: number) {
    const seen = new Set<number>();
    for (const u of v.units) {
      seen.add(u.i);
      let o = this.units.get(u.i);
      const key = u.k + u.n + u.t;
      if (o && o.key !== key) { this.scene.remove(o.root); o = undefined; }
      if (!o) { o = this.makeUnit(u, v); this.units.set(u.i, o); }
      const fx = u.fx ?? [];
      o.root.visible = !(u.s & ST.hidden);
      o.root.position.set(u.px, (u.s & ST.flying) !== 0 ? 120 : 0, u.py);
      o.body.rotation.y = -u.pf;
      // Paso, golpe y estados que mueven el cuerpo.
      const moving = u.speed > 30;
      const phase = this.clock * (u.speed / 40 + 4);
      o.body.position.y = moving ? Math.abs(Math.sin(phase)) * 6 : 0;
      o.legs.forEach((l, i) => { l.rotation.z = moving ? Math.sin(phase + i * Math.PI) * 0.5 : 0; });
      o.body.position.x = u.a ? Math.cos(u.pf) * 14 : 0;
      o.body.position.z = u.a ? Math.sin(u.pf) * 14 : 0;
      if (fx.includes('blade_fury')) o.body.rotation.y = this.clock * 25;
      if (fx.includes('cyclone')) { o.body.position.y = 90 + Math.sin(this.clock * 5) * 10; o.body.rotation.y = this.clock * 12; }
      if (o.extra) { o.extra.rotation.y += dt * 1.5; o.extra.position.y = (u.k === 'orb' ? 90 : 150) + Math.sin(this.clock * 2) * 8; }
      const alpha = fx.includes('invis') || fx.includes('ethereal') || fx.includes('doppel') ? 0.4 : 1;
      if (alpha !== o.alpha) {
        o.alpha = alpha;
        for (const m of o.mats) { m.transparent = alpha < 1; m.opacity = alpha; m.needsUpdate = true; }
      }
      if (u.il && u.o) for (const m of o.mats) (m as THREE.MeshStandardMaterial).emissive?.set('#1a3a7a');
      // Estados.
      for (const f of fx) {
        const st = STATUS[f];
        if (!st || o.status.has(f) || st.k === 'alpha' || st.k === 'lift') continue;
        const obj = this.statusObj(st);
        o.root.add(obj);
        o.status.set(f, obj);
      }
      for (const [f, obj] of o.status) {
        if (!fx.includes(f)) { o.root.remove(obj); o.status.delete(f); continue; }
        if (STATUS[f].k === 'stars') obj.children.forEach((c, k) => {
          const a = this.clock * 5 + (k * Math.PI * 2) / 3;
          c.position.set(Math.cos(a) * 30, Math.sin(a * 2) * 5, Math.sin(a) * 30);
        });
        if (STATUS[f].k === 'spin') obj.rotation.y = this.clock * 10;
      }
      if (u.k === 'orb') this.updateOrbProgress(o, u, v);
    }
    for (const [id, o] of this.units) if (!seen.has(id)) { this.scene.remove(o.root); this.units.delete(id); }
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
        const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.glow, color: col, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
        halo.scale.setScalar(size * 3);
        g.add(core, halo);
        if (p.fx === 'hook') {
          const line = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: '#b8a888' }));
          line.name = 'chain';
          line.frustumCulled = false;
          this.scene.add(line);
          g.userData.chain = line;
        }
        this.scene.add(g);
        this.projs.set(p.i, g);
        o = g;
      }
      o.position.set(p.x, p.fx === 'dragon_slave' ? 50 : 80, p.y);
      const chain = o.userData.chain as THREE.Line | undefined;
      const src = v.byId.get(p.s);
      if (chain && src) chain.geometry.setFromPoints([new THREE.Vector3(src.px, 80, src.py), o.position.clone()]);
    }
    for (const [id, o] of this.projs) if (!seen.has(id)) {
      this.scene.remove(o);
      if (o.userData.chain) this.scene.remove(o.userData.chain);
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
      this.scene.add(g);
      this.zones.set(z.i, g);
    }
    for (const [id, o] of this.zones) if (!seen.has(id)) { this.scene.remove(o); this.zones.delete(id); }
  }

  render(v: View, cam: Camera, dt: number) {
    this.clock += dt;
    this.placeCamera(cam);
    // Luz de día o de noche.
    const night = v.night ? 1 : 0;
    this.sun.intensity += ((night ? 0.55 : 2.3) - this.sun.intensity) * Math.min(1, dt * 2);
    this.sun.color.lerp(new THREE.Color(night ? '#8aa0ff' : '#fff1d6'), Math.min(1, dt * 2));
    this.hemi.intensity += ((night ? 0.5 : 1.1) - this.hemi.intensity) * Math.min(1, dt * 2);
    this.sun.position.set(cam.x - 900, 2600, cam.y + 700);
    this.sun.target.position.set(cam.x, 0, cam.y);

    const eyes = v.units.filter((u) => u.t === v.team && u.v).map((u) => ({ x: u.px, y: u.py, v: u.v!, flying: (u.s & ST.flying) !== 0 }));
    this.fog.update(eyes, v.night, v.vz);
    this.fogTex.needsUpdate = true;

    this.syncUnits(v, dt);
    this.syncProjectiles(v);
    this.syncZones(v);

    const t = v.targeting, hero = v.hero;
    this.rangeRing.visible = !!(t && hero && t.range > 0);
    if (t && hero) { this.rangeRing.position.set(hero.px, 3, hero.py); this.rangeRing.scale.setScalar(t.range); }
    this.aoeDisc.visible = !!(t && t.aoe);
    if (t?.aoe) { this.aoeDisc.position.set(v.mouse.x, 3, v.mouse.y); this.aoeDisc.scale.setScalar(t.aoe); }
    const hov = v.byId.get(v.hover);
    this.hoverRing.visible = !!hov;
    if (hov) { this.hoverRing.position.set(hov.px, 3, hov.py); this.hoverRing.scale.setScalar(hov.k === 'hero' || hov.k === 'illusion' ? 54 : hov.r * 2); }
    const mk = v.marker;
    const mk01 = mk ? (performance.now() / 1000 - mk.t) / 0.5 : 1;
    this.marker.visible = mk01 < 1;
    if (mk && mk01 < 1) {
      this.marker.position.set(mk.x, 4, mk.y);
      this.marker.scale.setScalar(45 * (1 - mk01 * 0.6));
      (this.marker.material as THREE.MeshBasicMaterial).color.set(mk.attack ? '#ff5040' : '#78ff78');
      (this.marker.material as THREE.MeshBasicMaterial).opacity = 1 - mk01;
    }

    for (const l of this.live) { l.t += dt; l.update(Math.min(1, l.t / l.d), l.t); }
    for (const l of this.live) if (l.t >= l.d) this.scene.remove(l.obj);
    this.live = this.live.filter((l) => l.t < l.d);

    this.gl.render(this.scene, this.camera);
    this.octx.clearRect(0, 0, this.W, this.H);
    this.overlay.draw(this.octx, v, (x, y, h) => this.worldToScreen(x, y, h, cam), dt,
      (u) => (u.k === 'hero' || u.k === 'illusion' ? 230 : u.k === 'creep' ? 140 : 110));
  }

  dispose() {
    this.gl.dispose();
    this.canvas.remove();
    this.overlayCanvas.remove();
  }
}
