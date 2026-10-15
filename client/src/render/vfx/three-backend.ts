// Dibujo del Frame de efectos en Three.js con seis llamadas de dibujo fijas:
// sprites aditivos, sprites normales, decals aditivos, decals normales, haces y escudos.
// Los arrays del Frame se suben tal cual como búferes intercalados (sin copias ni objetos por frame).
import * as THREE from 'three';
import { ATLAS_CELLS, shapeAtlas } from './atlas';
import { BM, DC, type Frame, SL, SP } from './frame';

const SPRITE_VS = /* glsl */ `
attribute vec4 iPos; attribute vec4 iCol; attribute vec3 iPar;
varying vec2 vUv; varying vec4 vCol; varying float vHot; varying float vShape;
void main() {
  vec4 mv = viewMatrix * vec4(iPos.x, iPos.z, iPos.y, 1.0);
  float c = cos(iPar.y), s = sin(iPar.y);
  vec2 q = vec2(position.x * c - position.y * s, position.x * s + position.y * c);
  mv.xy += q * iPos.w;
  // Un poco hacia la cámara para no cortarse con el suelo ni con las mallas.
  mv.z += min(iPos.w * 0.35, 60.0);
  vUv = position.xy + 0.5; vCol = iCol; vHot = iPar.z; vShape = iPar.x;
  gl_Position = projectionMatrix * mv;
}`;

const SPRITE_FS = /* glsl */ `
uniform sampler2D map; uniform float normalBlend;
varying vec2 vUv; varying vec4 vCol; varying float vHot; varying float vShape;
void main() {
  float N = ${ATLAS_CELLS.toFixed(1)};
  float sh = floor(vShape + 0.5);
  vec2 cell = vec2(mod(sh, N), floor(sh / N));
  vec2 uv = (cell + vec2(vUv.x, 1.0 - vUv.y) * 0.96 + 0.02) / N;
  vec4 t = texture2D(map, uv);
  float a = t.r * vCol.a;
  if (a < 0.003) discard;
  vec3 col = normalBlend > 0.5 ? vCol.rgb : mix(vCol.rgb, vec3(1.0), clamp(t.g * vHot, 0.0, 1.0));
  gl_FragColor = vec4(col, a);
}`;

const DECAL_VS = /* glsl */ `
attribute vec4 iA; attribute vec2 iB; attribute vec4 iCol; attribute vec3 iC;
varying vec2 vC; varying vec4 vCol; varying vec3 vP;
void main() {
  float sy = abs(iC.x - 4.0) < 0.5 ? iB.x : iA.w;
  vec2 dir = vec2(cos(iB.y), sin(iB.y)); vec2 perp = vec2(-dir.y, dir.x);
  vec2 w = iA.xy + perp * position.x * iA.w + dir * position.y * sy;
  vC = position.xy; vCol = iCol; vP = iC;
  gl_Position = projectionMatrix * viewMatrix * vec4(w.x, iA.z, w.y, 1.0);
}`;

const DECAL_FS = /* glsl */ `
uniform float gain;
varying vec2 vC; varying vec4 vCol; varying vec3 vP;
float band(float d, float c, float w) { return clamp(1.0 - abs(d - c) / w, 0.0, 1.0); }
void main() {
  float type = vP.x, p1 = vP.y;
  float d = length(vC);
  float a = 0.0; float hot = 0.0;
  if (type < 0.5) {            // DISC
    a = pow(max(0.0, 1.0 - d), 1.4);
    hot = pow(max(0.0, 1.0 - d * 1.6), 2.0) * 0.15;
  } else if (type < 1.5) {     // RING
    float th = max(p1, 0.02);
    float b = band(d, 1.0 - th, th);
    a = b * b * (3.0 - 2.0 * b);
    hot = band(d, 1.0 - th, th * 0.3) * 0.6;
  } else if (type < 2.5) {     // WARN: relleno, borde, disco de progreso
    float edge = band(d, 0.965, 0.035);
    float prog = band(d, p1, 0.025);
    a = step(d, 1.0) * (0.16 + 0.22 * step(d, p1)) + edge + prog * 0.7;
    hot = edge * 0.5;
  } else if (type < 3.5) {     // CONE (vértice en el centro, eje +y)
    float ang = abs(atan(vC.x, vC.y));
    float inside = smoothstep(p1, p1 * 0.82, ang) * smoothstep(1.0, 0.93, d);
    a = inside * (0.25 + 0.75 * d) + band(d, 0.95, 0.05) * step(ang, p1) * 0.8;
    hot = band(d, 0.95, 0.04) * step(ang, p1) * 0.6;
  } else if (type < 4.5) {     // LINE (x = a lo ancho, y = a lo largo)
    float ac = abs(vC.x), al = abs(vC.y);
    float ends = smoothstep(1.0, 0.82, al);
    a = ends * ((1.0 - ac * ac) * 0.7 + band(ac, 0.88, 0.12) * 0.8);
    hot = ends * band(ac, 0.0, 0.3) * 0.35;
  } else {                     // RUNES: círculo mágico
    float ang = atan(vC.y, vC.x);
    float outer = band(d, 0.94, 0.04) + band(d, 0.84, 0.02);
    float inner = band(d, 0.56, 0.025);
    float ticks = step(0.62, fract(ang * 3.8197)) * step(0.62, d) * step(d, 0.8) * 0.7;
    float spokes = band(fract(ang * 0.9549 + 0.5), 0.5, 0.025) * step(d, 0.56) * step(0.2, d) * 0.5;
    a = outer + inner + ticks + spokes;
    hot = outer * 0.4;
  }
  a = clamp(a, 0.0, 1.0) * vCol.a * gain;
  if (a < 0.003) discard;
  gl_FragColor = vec4(mix(vCol.rgb, vec3(1.0), hot), a);
}`;

const BEAM_VS = /* glsl */ `
attribute vec3 iP1; attribute vec3 iP2; attribute float iW; attribute vec4 iCol;
varying vec2 vC; varying vec4 vCol;
void main() {
  vec3 a = vec3(iP1.x, iP1.z, iP1.y), b = vec3(iP2.x, iP2.z, iP2.y);
  vec3 p = mix(a, b, position.y);
  vec3 axis = b - a; float len = length(axis); axis = len > 0.001 ? axis / len : vec3(0.0, 1.0, 0.0);
  vec3 side = cross(axis, normalize(cameraPosition - p));
  float sl = length(side); side = sl > 0.001 ? side / sl : vec3(1.0, 0.0, 0.0);
  // Los extremos se alargan medio ancho para que el haz no acabe en seco.
  p += axis * (position.y * 2.0 - 1.0) * iW * 0.5;
  p += side * position.x * iW * 0.5;
  vC = vec2(position.x, position.y); vCol = iCol;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}`;

const BEAM_FS = /* glsl */ `
varying vec2 vC; varying vec4 vCol;
void main() {
  float ac = abs(vC.x);
  float a = pow(max(0.0, 1.0 - ac), 1.6) * vCol.a;
  if (a < 0.003) discard;
  float hot = pow(max(0.0, 1.0 - ac * 2.2), 2.0) * 0.8;
  gl_FragColor = vec4(mix(vCol.rgb, vec3(1.0), hot), a);
}`;

const SHELL_VS = /* glsl */ `
attribute vec4 iA; attribute vec4 iCol; attribute float iSq;
varying vec3 vN; varying vec3 vV; varying vec4 vCol; varying float vY;
void main() {
  vec3 w = vec3(iA.x, iA.z, iA.y) + position * vec3(iA.w, iA.w * iSq, iA.w);
  vN = normalize(normal * vec3(1.0, 1.0 / max(iSq, 0.01), 1.0));
  vV = normalize(cameraPosition - w); vCol = iCol; vY = position.y;
  gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
}`;

const SHELL_FS = /* glsl */ `
uniform float time;
varying vec3 vN; varying vec3 vV; varying vec4 vCol; varying float vY;
void main() {
  float f = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 2.0);
  float bands = 0.85 + 0.15 * sin(vY * 18.0 - time * 4.0);
  float a = (0.12 + 0.88 * f) * bands * vCol.a;
  if (a < 0.003) discard;
  gl_FragColor = vec4(mix(vCol.rgb, vec3(1.0), f * f * 0.6), a);
}`;

interface Batch {
  mesh: THREE.Mesh;
  geo: THREE.InstancedBufferGeometry;
  buf: THREE.InstancedInterleavedBuffer;
  count: () => number;
  stride: number;
}

function quadGeo(kind: 'center' | 'ground' | 'beam') {
  const g = new THREE.InstancedBufferGeometry();
  const p = kind === 'center' ? [-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]
    : kind === 'ground' ? [-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]
    : [-1, 0, 0, 1, 0, 0, 1, 1, 0, -1, 1, 0];
  g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  return g;
}

export class ThreeVfx {
  private batches: Batch[] = [];
  private shellMat: THREE.ShaderMaterial;
  private tex: THREE.CanvasTexture;
  readonly group = new THREE.Group();

  constructor(frame: Frame) {
    this.tex = new THREE.CanvasTexture(shapeAtlas());
    this.tex.flipY = false;
    this.tex.generateMipmaps = true;
    this.tex.minFilter = THREE.LinearMipmapLinearFilter;
    this.tex.colorSpace = THREE.NoColorSpace;
    const common = { transparent: true, depthWrite: false, depthTest: true };
    const add = THREE.AdditiveBlending, nrm = THREE.NormalBlending;
    const sprite = (normal: boolean) => new THREE.ShaderMaterial({
      ...common, vertexShader: SPRITE_VS, fragmentShader: SPRITE_FS, blending: normal ? nrm : add,
      uniforms: { map: { value: this.tex }, normalBlend: { value: normal ? 1 : 0 } },
    });
    const decal = (normal: boolean) => new THREE.ShaderMaterial({
      ...common, vertexShader: DECAL_VS, fragmentShader: DECAL_FS, blending: normal ? nrm : add,
      // El suelo iluminado ya es claro: los decals aditivos van algo más bajos para no quemarlo.
      uniforms: { gain: { value: normal ? 1 : 0.75 } },
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, side: THREE.DoubleSide,
    });
    const f = frame;
    const decalAttrs: Record<string, [number, number]> = { iA: [4, 0], iB: [2, 4], iCol: [4, 6], iC: [3, 10] };
    const spriteAttrs: Record<string, [number, number]> = { iPos: [4, 0], iCol: [4, 4], iPar: [3, 8] };
    // Orden: decals normales (humo en el suelo) → decals aditivos → escudos → haces → sprites normales → aditivos.
    this.add(quadGeo('ground'), decal(true), DC, f.dcN, () => f.nDN, decalAttrs, 1);
    this.add(quadGeo('ground'), decal(false), DC, f.dcA, () => f.nDA, decalAttrs, 2);
    const sphere = new THREE.SphereGeometry(1, 28, 18);
    const sg = new THREE.InstancedBufferGeometry();
    sg.index = sphere.index; sg.setAttribute('position', sphere.getAttribute('position')); sg.setAttribute('normal', sphere.getAttribute('normal'));
    this.shellMat = new THREE.ShaderMaterial({ ...common, vertexShader: SHELL_VS, fragmentShader: SHELL_FS, blending: add, uniforms: { time: { value: 0 } } });
    this.add(sg, this.shellMat, SL, f.sl, () => f.nS, { iA: [4, 0], iCol: [4, 4], iSq: [1, 8] }, 3);
    this.add(quadGeo('beam'), new THREE.ShaderMaterial({ ...common, vertexShader: BEAM_VS, fragmentShader: BEAM_FS, blending: add, side: THREE.DoubleSide }),
      BM, f.bm, () => f.nB, { iP1: [3, 0], iP2: [3, 3], iW: [1, 6], iCol: [4, 7] }, 4);
    this.add(quadGeo('center'), sprite(true), SP, f.spN, () => f.nN, spriteAttrs, 5);
    this.add(quadGeo('center'), sprite(false), SP, f.spA, () => f.nA, spriteAttrs, 6);
  }

  private add(geo: THREE.InstancedBufferGeometry, mat: THREE.ShaderMaterial, stride: number, arr: Float32Array, count: () => number,
    attrs: Record<string, [number, number]>, order: number) {
    const buf = new THREE.InstancedInterleavedBuffer(arr, stride, 1);
    buf.setUsage(THREE.DynamicDrawUsage);
    for (const [name, [size, off]] of Object.entries(attrs)) geo.setAttribute(name, new THREE.InterleavedBufferAttribute(buf, size, off));
    geo.instanceCount = 0;
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = 50 + order;
    mesh.matrixAutoUpdate = false;
    this.group.add(mesh);
    this.batches.push({ mesh, geo, buf, count, stride });
  }

  /** Sube lo usado de cada búfer y ajusta el número de instancias. */
  sync(time: number) {
    this.shellMat.uniforms.time.value = time;
    for (const b of this.batches) {
      const n = b.count();
      b.geo.instanceCount = n;
      b.mesh.visible = n > 0;
      if (n > 0) {
        b.buf.clearUpdateRanges();
        b.buf.addUpdateRange(0, n * b.stride);
        b.buf.needsUpdate = true;
      }
    }
  }

  /** Llamadas de dibujo de efectos en este frame. */
  get calls() { let c = 0; for (const b of this.batches) if (b.mesh.visible) c++; return c; }

  dispose() {
    for (const b of this.batches) { b.geo.dispose(); (b.mesh.material as THREE.Material).dispose(); }
    this.tex.dispose();
    this.group.removeFromParent();
  }
}
