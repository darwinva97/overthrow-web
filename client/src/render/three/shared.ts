// Piezas compartidas por las capas del modo 3D (núcleo, unidades y efectos).
import * as THREE from 'three';
import type { MapLayout } from '../../../../shared/maps';

/** Lo que el núcleo comparte con las capas de unidades y efectos. */
export interface ThreeCtx {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  /** Textura radial blanca para brillos. */
  glow: THREE.Texture;
  /** Segundos de render acumulados (para animaciones). */
  clock: number;
  L: MapLayout;
  /** Inyecta la niebla de guerra en un material del escenario. */
  fogged<M extends THREE.Material>(mat: M): M;
}

export const hashStr = (s: string) => { let h = 0; for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) | 0; return Math.abs(h); };

// Geometrías compartidas.
export const G = {
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
export function glowTexture() {
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
