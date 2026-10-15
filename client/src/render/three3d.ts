// Modo 3D con Three.js: misma vista que el 2D, con modelos low-poly propios (no los de Valve).
import * as THREE from 'three';
import type { MapLayout } from '../../../shared/maps';
import { FREE, ROCK, TREE } from '../../../shared/sim/nav';
import type { Fx } from '../../../shared/sim/types';
import { ST } from '../../../shared/sim/types';
import { Overlay } from './overlay';
import { EffectLayer } from './three/effects';
import { G, glowTexture, type ThreeCtx } from './three/shared';
import { UnitLayer } from './three/units';
import { Fog, terrainCanvas } from './terrain';
import { teamColor, type Camera, type Renderer, type View } from './types';

const PITCH = (56 * Math.PI) / 180;
const BASE_DIST = 2300;

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
  private ctx: ThreeCtx;
  private unitLayer: UnitLayer;
  private effects: EffectLayer;
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
    this.ctx = { scene: this.scene, camera: this.camera, glow: this.glow, clock: 0, L, fogged: (m) => this.fogged(m) };
    this.unitLayer = new UnitLayer(this.ctx);
    this.effects = new EffectLayer(this.ctx, this.unitLayer);

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

  render(v: View, cam: Camera, dt: number) {
    this.clock += dt;
    this.ctx.clock = this.clock;
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

    this.unitLayer.update(v, dt);
    this.effects.update(v, dt);

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

    this.gl.render(this.scene, this.camera);
    this.octx.clearRect(0, 0, this.W, this.H);
    this.overlay.draw(this.octx, v, (x, y, h) => this.worldToScreen(x, y, h, cam), dt,
      (u) => (u.k === 'hero' || u.k === 'illusion' ? 230 : u.k === 'creep' ? 140 : 110));
  }

  stats() {
    const r = this.gl.info.render;
    return { 'llamadas de dibujo': r.calls, triángulos: r.triangles, geometrías: this.gl.info.memory.geometries, texturas: this.gl.info.memory.textures };
  }

  fx(f: Fx, v: View) {
    this.overlay.fx(f, v);
    this.unitLayer.onFx(f, v);
    this.effects.fx(f, v);
  }

  dispose() {
    this.unitLayer.dispose();
    this.effects.dispose();
    this.gl.dispose();
    this.canvas.remove();
    this.overlayCanvas.remove();
  }
}
