// Animación procedural de los modelos: respiración, carrera, golpe, lanzamiento, canalización,
// aturdimiento, impacto y muerte. Todo son giros sobre la pose de reposo de los huesos, con un
// desfase por unidad para que no se muevan todas a la vez. No crea objetos por frame.
import type * as THREE from 'three';
import { IDLE_ARM, type ModelInst, type Strike } from './builder';

export interface AnimState {
  /** Desfase aleatorio por unidad (0-1). */
  seed: number;
  /** Tiempo propio (se para si la unidad está congelada). */
  t: number;
  /** Fase del paso y mezcla de movimiento (0 quieto, 1 corriendo). */
  walk: number;
  move: number;
  amp: number;
  /** Ataque: tiempo de preparación (a = 1) y tiempo desde el golpe. */
  wind: number;
  strike: number;
  hits: number;
  lastA: boolean;
  /** Lanzamiento: mezcla de la pose (c = 1), tiempo desde que se suelta y mezcla de canalización. */
  cast: number;
  release: number;
  chan: number;
  lastC: number;
  stun: number;
  /** Tiempo desde el último golpe recibido. */
  hit: number;
  /** Tiempo desde la muerte (< 0 si vive). */
  dead: number;
  roll: number;
  /** Pose de brazos calculada (reutilizada). */
  pose: number[];
  /** El lanzamiento actual apunta a un objetivo (brazos al frente) o no (brazos arriba). */
  aim: boolean;
}

export function newAnim(seed: number): AnimState {
  return {
    seed, t: seed * 10, walk: seed * 6.28, move: 0, amp: 0.6, wind: 0, strike: 9, hits: 0, lastA: false,
    cast: 0, release: 9, chan: 0, lastC: 0, stun: 0, hit: 9, dead: -1, roll: 0, pose: [0, 0, 0, 0, 0, 0, 0, 0], aim: false,
  };
}

export interface AnimIn {
  speed: number;
  attacking: boolean;
  cast: number;
  stunned: boolean;
  /** La habilidad que se lanza tiene objetivo (unidad o punto). */
  aim: boolean;
}

// Poses de ataque: [brazoD z, brazoD x, codoD z, brazoI z, brazoI x, codoI z, pecho y, pecho z]
type Pose = [number, number, number, number, number, number, number, number];
const ATTACK: Record<Strike, { wind: Pose; hit: Pose; alt?: boolean }> = {
  slash: { wind: [2.3, -0.9, 0.5, 0.2, 0.2, 0.2, 0.55, 0.1], hit: [1.0, 0.7, 0.1, -0.1, 0.25, 0.3, -0.55, -0.2] },
  chop: { wind: [2.8, -0.25, 0.7, 2.8, 0.25, 0.7, 0.1, 0.2], hit: [0.8, 0.15, 0.0, 0.8, -0.15, 0.0, -0.05, -0.45] },
  thrust: { wind: [0.2, -0.25, 1.4, 0.7, 0.2, 1.0, 0.45, 0.05], hit: [1.5, 0.05, -0.1, 1.1, 0.25, 0.3, -0.35, -0.25] },
  bow: { wind: [1.4, 0.2, 2.7, 1.2, -0.1, -0.5, -0.5, 0.0], hit: [1.2, 0.5, 1.4, 1.2, -0.1, -0.5, -0.45, 0.05] },
  gun: { wind: [1.2, 0.2, 0.2, 1.1, -0.35, 0.6, -0.2, 0.0], hit: [1.6, 0.2, 0.3, 1.4, -0.35, 0.6, -0.2, 0.2] },
  cast: { wind: [2.6, -0.5, 0.4, 0.3, 0.3, 0.3, 0.35, 0.1], hit: [1.4, 0.25, 0.0, 0.2, 0.3, 0.3, -0.35, -0.2] },
  punch: { wind: [0.5, -0.2, 1.3, 0.6, 0.2, 0.8, 0.45, 0.0], hit: [1.6, 0.15, -0.6, 0.4, 0.2, 0.8, -0.45, -0.15], alt: true },
  dual: { wind: [2.2, -0.8, 0.5, 2.2, 0.8, 0.5, 0.0, 0.15], hit: [0.8, 0.6, 0.2, 0.8, -0.6, 0.2, 0.0, -0.3] },
  claw: { wind: [2.4, -0.6, 0.7, 0.4, 0.3, 0.4, 0.4, 0.2], hit: [0.6, 0.35, 0.2, 0.4, 0.3, 0.4, -0.4, -0.35], alt: true },
  whip: { wind: [3.0, -0.4, 1.0, 0.3, 0.2, 0.3, 0.35, 0.2], hit: [1.1, 0.25, -0.2, 0.3, 0.2, 0.3, -0.35, -0.2] },
  bite: { wind: [0.6, -0.3, 0.6, 0.6, 0.3, 0.6, 0, 0.2], hit: [1.4, 0, 0, 1.4, 0, 0, 0, -0.3] },
  none: { wind: [0, 0, 0, 0, 0, 0, 0, 0.05], hit: [0, 0, 0, 0, 0, 0, 0, -0.1] },
};
const CAST_UP: Pose = [2.5, -0.65, 0.35, 2.5, 0.65, 0.35, 0, 0.15];
const CAST_AIM: Pose = [2.2, -0.35, 0.6, 0.6, 0.35, 0.5, 0.35, 0.12];
const CAST_THROW: Pose = [1.5, -0.1, 0, 1.5, 0.1, 0, 0, -0.22];

const WIND_T = 0.22, HIT_T = 0.11, REC_T = 0.3;
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth = (x: number) => { x = clamp01(x); return x * x * (3 - 2 * x); };
const easeOut = (x: number) => { x = clamp01(x); return 1 - (1 - x) * (1 - x); };
const approach = (v: number, target: number, rate: number, dt: number) => v + (target - v) * Math.min(1, rate * dt);

/** Avanza el estado de animación con lo que llega del servidor. */
export function step(st: AnimState, inp: AnimIn, dt: number, worldScale: number) {
  st.t += dt;
  const moving = inp.speed > 25;
  st.move = approach(st.move, moving ? 1 : 0, moving ? 8 : 6, dt);
  st.amp = approach(st.amp, Math.min(1.25, Math.max(0.55, inp.speed / 300)), 4, dt);
  if (moving) st.walk += (dt * inp.speed) / (22 * worldScale);
  else st.walk += dt * 0.5 * st.move;
  st.roll += (dt * inp.speed) / (12 * worldScale);
  // Ataque
  if (inp.attacking) {
    if (!st.lastA) { st.wind = 0; }
    st.wind += dt;
  } else if (st.lastA) { st.strike = 0; st.hits++; st.wind = 0; }
  st.lastA = inp.attacking;
  st.strike += dt;
  // Lanzamiento
  if (inp.cast !== 1 && st.lastC === 1) st.release = 0;
  if (inp.cast) st.aim = inp.aim;
  st.lastC = inp.cast;
  st.release += dt;
  st.cast = approach(st.cast, inp.cast === 1 ? 1 : 0, inp.cast === 1 ? 12 : 8, dt);
  st.chan = approach(st.chan, inp.cast === 2 ? 1 : 0, 7, dt);
  st.stun = approach(st.stun, inp.stunned ? 1 : 0, 8, dt);
  st.hit += dt;
  if (st.dead >= 0) st.dead += dt;
}

/** Suma una pose (opcionalmente en espejo) a la pose acumulada. */
function put(P: number[], src: Pose, k: number, mirror: boolean) {
  if (k <= 0) return;
  if (!mirror) { for (let i = 0; i < 8; i++) P[i] += src[i] * k; return; }
  P[0] += src[3] * k; P[1] -= src[4] * k; P[2] += src[5] * k;
  P[3] += src[0] * k; P[4] -= src[1] * k; P[5] += src[2] * k;
  P[6] -= src[6] * k; P[7] += src[7] * k;
}

/** Calcula la pose de brazos y su peso (0-1) a partir de ataque y lanzamiento. */
function armPose(st: AnimState, strike: Strike): number {
  const P = st.pose;
  const A = ATTACK[strike];
  const mirror = !!A.alt && st.hits % 2 === 1;
  let w = 0;
  for (let i = 0; i < 8; i++) P[i] = 0;
  if (st.lastA) {
    const k = smooth(st.wind / WIND_T);
    put(P, A.wind, k, mirror); w = k;
  } else if (st.strike < HIT_T + REC_T) {
    if (st.strike < HIT_T) {
      const k = easeOut(st.strike / HIT_T);
      put(P, A.wind, 1 - k, mirror); put(P, A.hit, k, mirror);
    } else put(P, A.hit, 1 - smooth((st.strike - HIT_T) / REC_T), mirror);
    w = 1;
  }
  // El lanzamiento manda sobre el ataque.
  const c = Math.max(st.cast, st.chan);
  if (c > 0.01 || st.release < 0.4) {
    const keep = 1 - Math.min(1, c);
    for (let i = 0; i < 8; i++) P[i] *= keep;
    put(P, st.aim ? CAST_AIM : CAST_UP, st.cast * (1 - st.chan), false);
    if (st.chan > 0) {
      const o = Math.sin(st.t * 7) * 0.14;
      const c2 = st.chan;
      if (st.aim) {
        // Canalización con objetivo (Life Drain, Dismember…): brazos al frente, temblando.
        P[0] += (1.5 + o * 0.5) * c2; P[1] += -0.15 * c2; P[2] += 0.1 * c2;
        P[3] += (1.5 - o * 0.5) * c2; P[4] += 0.15 * c2; P[5] += 0.1 * c2;
        P[7] += -0.08 * c2;
      } else {
        // Canalización en área (Freezing Field, Black Hole…): brazos abiertos hacia arriba.
        P[0] += (2.1 + o) * c2; P[1] += -0.7 * c2; P[2] += 0.35 * c2;
        P[3] += (2.1 - o) * c2; P[4] += 0.7 * c2; P[5] += 0.35 * c2;
        P[7] += 0.1 * c2;
      }
    }
    if (st.release < 0.4) {
      const k = st.release < 0.12 ? easeOut(st.release / 0.12) : 1 - smooth((st.release - 0.12) / 0.28);
      put(P, CAST_THROW, k * (1 - st.cast), false);
    }
    w = Math.max(w, c, st.release < 0.4 ? 1 - st.release / 0.4 : 0);
  }
  return Math.min(1, w);
}

type B = THREE.Bone | undefined;
export interface Rig {
  root: THREE.Bone; hips: B; chest: B; head: B; head2: B; armL: B; armR: B; handL: B; handR: B;
  legL: B; legR: B; footL: B; footR: B; cape: B; tail: B; tail2: B; tail3: B; tail4: B;
  wingL: B; wingR: B; spin: B; saw: B; body: B; abdomen: B; wheelL: B; wheelR: B;
  q: { body: B; head: B; tail: B; legFL: B; legFR: B; legBL: B; legBR: B } | null;
  legs: THREE.Bone[];
  /** Cadena de la cola de serpiente. */
  snake: B[];
  mlegL: B; mlegR: B;
}

export function rigOf(inst: ModelInst): Rig {
  const by = (n: string): B => { const i = inst.def.roles[n]; return i === undefined ? undefined : inst.bones[i]; };
  const qp = inst.def.anim.quad;
  const legs: THREE.Bone[] = [];
  for (let i = 0; i < (inst.def.anim.insect ?? 0); i++) { const b = by('leg' + i); if (b) legs.push(b); }
  return {
    root: inst.bones[0], hips: by('hips'), chest: by('chest'), head: by('head'), head2: by('head2'),
    armL: by('armL'), armR: by('armR'), handL: by('handL'), handR: by('handR'),
    legL: by('legL'), legR: by('legR'), footL: by('footL'), footR: by('footR'), cape: by('cape'),
    tail: by('tail'), tail2: by('tail2'), tail3: by('tail3'), tail4: by('tail4'),
    wingL: by('wingL'), wingR: by('wingR'), spin: by('spin'), saw: by('saw'), body: by('body'), abdomen: by('abdomen'),
    wheelL: by('wheelL'), wheelR: by('wheelR'), mlegL: by('mlegL'), mlegR: by('mlegR'),
    q: qp === undefined ? null : {
      body: by(qp + 'body'), head: by(qp + 'head'), tail: by(qp + 'tail'),
      legFL: by(qp + 'legFL'), legFR: by(qp + 'legFR'), legBL: by(qp + 'legBL'), legBR: by(qp + 'legBR'),
    },
    legs,
    snake: [by('tail'), by('tail2'), by('tail3'), by('tail4')],
  };
}

/** Coloca los huesos según el estado. */
export function pose(inst: ModelInst, rig: Rig, st: AnimState) {
  const { bones, rest, def } = inst;
  const A = def.anim;
  for (let i = 0; i < bones.length; i++) {
    const b = bones[i];
    b.position.copy(rest[i]);
    b.rotation.set(0, 0, 0);
    b.scale.set(1, 1, 1);
  }
  const t = st.t;
  const sd = st.seed * 6.28;
  const m = st.move;
  const ph = st.walk;
  const sn = Math.sin(ph), cs = Math.cos(ph);
  const amp = st.amp;
  const breath = Math.sin(t * 2.1 + sd);
  const stun = st.stun;
  const hitK = st.hit < 0.25 ? 1 - st.hit / 0.25 : 0;
  const R = rig;

  // Altura de vuelo y balanceo
  if (A.hover) R.root.position.y += A.hover + Math.sin(t * 2 + sd) * 4;
  if (A.still) {
    if (R.spin && A.spin) R.spin.rotation.y = t * A.spin;
    deathPose(R, st, A.biped === 'walk');
    return;
  }

  // ------------------------------------------------------------ bípedo (o torso)
  const w = armPose(st, A.strike);
  const P = st.pose;
  if (A.biped !== 'none' && R.chest) {
    const idle = IDLE_ARM[A.strike];
    const free = 1 - w;
    const legsMove = A.biped === 'walk';
    const swing = legsMove ? sn * 0.55 * amp * m : 0;
    const elbow = legsMove ? (0.15 + 0.25 * Math.max(0, sn)) * m : 0;
    if (R.armL) R.armL.rotation.set(0.13 + breath * 0.025 + P[4] + stun * 0.1, 0, idle[2] + (-swing) * free + P[3] - stun * idle[2]);
    if (R.armR) R.armR.rotation.set(-0.13 - breath * 0.025 + P[1] - stun * 0.1, 0, idle[0] + swing * free + P[0] - stun * idle[0]);
    if (R.handL) R.handL.rotation.z = idle[3] + elbow * free + P[5] - stun * idle[3] * 0.6;
    if (R.handR) R.handR.rotation.z = idle[1] + elbow * free + P[2] - stun * idle[1] * 0.6;
    const twist = legsMove ? sn * 0.16 * m : 0;
    R.chest.rotation.set(
      Math.sin(t * 5 + sd) * 0.12 * stun,
      -twist * free + P[6],
      -0.13 * m * (legsMove ? 1 : 0.6) + P[7] + hitK * 0.3 + Math.sin(t * 2.4 + sd) * 0.015,
    );
    R.chest.position.y += breath * 0.45 + st.chan * Math.sin(t * 3) * 0.6;
    if (R.head) R.head.rotation.set(Math.sin(t * 4 + sd) * 0.1 * stun, Math.sin(t * 0.45 + sd * 3) * 0.18 * (1 - m) * (1 - w), -0.35 * stun + hitK * 0.15 - P[7] * 0.4);
    if (R.head2) R.head2.rotation.set(0, Math.sin(t * 0.6 + sd) * 0.3, Math.sin(t * 1.3) * 0.08);
    if (R.hips) {
      if (legsMove) {
        R.hips.position.y += (Math.abs(cs) * 2.2 - 1.1) * m * amp - 3 * stun;
        R.hips.rotation.y = twist * 0.6;
      } else if (A.biped === 'float') {
        R.hips.rotation.z = -0.15 * m;
        R.hips.position.y += Math.sin(t * 1.8 + sd) * 1.5;
      }
      R.hips.rotation.x = Math.sin(t * 5 + sd + 1) * 0.1 * stun;
    }
    if (legsMove) {
      const legA = 0.62 * amp * m;
      if (R.legL) R.legL.rotation.z = sn * legA + stun * 0.15;
      if (R.legR) R.legR.rotation.z = -sn * legA + stun * 0.15;
      if (R.footL) R.footL.rotation.z = -Math.max(0, cs) * 1.0 * amp * m - 0.05 - stun * 0.3;
      if (R.footR) R.footR.rotation.z = -Math.max(0, -cs) * 1.0 * amp * m - 0.05 - stun * 0.3;
    }
    if (R.cape) R.cape.rotation.z = -(0.06 + 0.45 * m) + Math.sin(t * 7 + sd) * 0.05 * m + Math.sin(t * 1.3 + sd) * 0.03;
  }

  // ------------------------------------------------------------ cuadrúpedo (bestia o montura)
  const Q = R.q;
  if (Q && Q.body) {
    const legA = 0.65 * amp * m;
    if (Q.legFL) Q.legFL.rotation.z = sn * legA;
    if (Q.legBR) Q.legBR.rotation.z = sn * legA;
    if (Q.legFR) Q.legFR.rotation.z = -sn * legA;
    if (Q.legBL) Q.legBL.rotation.z = -sn * legA;
    Q.body.position.y += Math.abs(cs) * 2.5 * m - 1.2 * m + breath * 0.4;
    // Ataque de bestia: se encoge y muerde. Las monturas encabritan al lanzar.
    let rear = 0, lunge = 0, bite = 0;
    if (A.biped === 'none') {
      if (st.lastA) { const k = smooth(st.wind / WIND_T); rear = 0.12 * k; bite = 0.35 * k; }
      else if (st.strike < HIT_T + REC_T) { const k = st.strike < HIT_T ? easeOut(st.strike / HIT_T) : 1 - smooth((st.strike - HIT_T) / REC_T); lunge = 8 * k; bite = -0.4 * k; rear = -0.08 * k; }
    }
    rear += 0.3 * Math.max(st.cast, st.chan * 0.6);
    Q.body.rotation.z = rear + Math.sin(ph * 2) * 0.03 * m + hitK * 0.15;
    Q.body.rotation.x = Math.sin(t * 5 + sd) * 0.08 * stun;
    Q.body.position.x += lunge;
    if (Q.legFL && rear > 0.05) { Q.legFL.rotation.z += rear * 1.6; if (Q.legFR) Q.legFR.rotation.z += rear * 1.2; }
    if (Q.head) Q.head.rotation.set(0, Math.sin(t * 0.5 + sd * 2) * 0.2 * (1 - m), Math.sin(ph * 2) * 0.07 * m + Math.sin(t * 1.6 + sd) * 0.04 + bite - 0.3 * stun);
    if (Q.tail) Q.tail.rotation.set(0, Math.sin(t * 3 + sd) * 0.35, 0.15 * m);
  }

  // ------------------------------------------------------------ alas
  if (R.wingL && R.wingR && A.wings) {
    const rate = A.wings === 'buzz' ? 38 : A.wings === 'glide' ? 3 : 4.5 + 3 * m;
    const ampW = A.wings === 'buzz' ? 0.3 : A.biped === 'walk' ? 0.12 + 0.25 * m : 0.55;
    const castOpen = Math.max(st.cast, st.chan) * 0.6;
    const f = Math.sin(t * rate + sd) * ampW + castOpen + (A.biped === 'walk' ? 0 : 0.1);
    R.wingL.rotation.x = f;
    R.wingR.rotation.x = -f;
    R.wingL.rotation.y = -0.15 * m;
    R.wingR.rotation.y = 0.15 * m;
  }

  // ------------------------------------------------------------ cuerpo de volador, insecto o máquina
  if (A.biped === 'none' && R.body && !Q) {
    R.body.position.y += breath * 0.6 + (A.wings === 'flap' ? -Math.sin(t * (4.5 + 3 * m) + sd) * 2 : 0);
    let lunge = 0, nod = 0;
    if (st.lastA) { const k = smooth(st.wind / WIND_T); nod = 0.25 * k; }
    else if (st.strike < HIT_T + REC_T) { const k = st.strike < HIT_T ? easeOut(st.strike / HIT_T) : 1 - smooth((st.strike - HIT_T) / REC_T); lunge = 7 * k; nod = -0.35 * k; }
    R.body.position.x += lunge;
    R.body.rotation.z = -0.12 * m * (A.insect ? 0.2 : 1) + 0.25 * Math.max(st.cast, st.chan) + hitK * 0.2 + nod * 0.3;
    R.body.rotation.x = Math.sin(t * 5 + sd) * 0.12 * stun + (A.spin && A.spin > 10 ? Math.sin(t * 1.3) * 0.04 : 0);
    if (R.head) R.head.rotation.set(0, Math.sin(t * 0.7 + sd * 2) * 0.2, nod + Math.sin(t * 1.9 + sd) * 0.05 - 0.3 * stun);
    if (R.head2) R.head2.rotation.set(0, -Math.sin(t * 0.8 + sd) * 0.25, Math.sin(t * 1.7) * 0.06 + nod * 0.6);
    if (R.abdomen) R.abdomen.rotation.set(Math.sin(t * 1.5 + sd) * 0.05, Math.sin(t * 2.2 + sd) * 0.06, -0.04 + breath * 0.03);
    // Pinzas (armL/armR) de insectos
    if (A.insect && R.armL && R.armR) {
      const snap = Math.sin(t * 1.4 + sd) * 0.08;
      R.armL.rotation.set(0, 0.2 * w + snap, P[3] * 0.25);
      R.armR.rotation.set(0, -0.2 * w - snap, P[0] * 0.25);
    }
    if (A.blob) { const k = 1 + Math.sin(t * 3 + sd) * 0.07; R.body.scale.set(k, k, k); }
  }
  // Patas de insecto: trípode alterno
  if (R.legs.length) {
    const n = R.legs.length;
    for (let i = 0; i < n; i++) {
      const s = i % 2 ? 1 : -1;
      const grp = (i + Math.floor(i / 2)) % 2;
      const p2 = ph * 1.4 + grp * Math.PI;
      R.legs[i].rotation.set(-s * Math.max(0, Math.cos(p2)) * 0.32 * m + Math.sin(t * 2 + i) * 0.03, Math.sin(p2) * 0.38 * m, 0);
    }
  }
  // Colas
  if (R.tail) {
    if (A.tail === 'snake') {
      for (let i = 0; i < 4; i++) { const b = R.snake[i]; if (b) b.rotation.y = Math.sin(t * 2.2 + sd - i * 0.9) * 0.18 + Math.sin(ph - i * 1.1) * 0.3 * m; }
    } else if (A.tail === 'sway') {
      R.tail.rotation.set(Math.sin(t * 1.7 + sd) * 0.12, 0, -0.5 * m + Math.sin(t * 1.3 + sd) * 0.06);
      if (R.tail2) R.tail2.rotation.set(Math.sin(t * 1.7 + sd - 0.8) * 0.2, 0, -0.3 * m);
    } else if (!Q || R.tail !== Q.tail) {
      R.tail.rotation.set(0, Math.sin(t * 2.4 + sd) * 0.3, -0.1 + 0.2 * m);
      if (R.tail2) R.tail2.rotation.set(0, Math.sin(t * 2.4 + sd - 0.9) * 0.35, 0.1 * m);
      if (A.insect && R.tail2 && st.strike < HIT_T + REC_T) R.tail2.rotation.z -= 0.6 * (1 - clamp01(st.strike / (HIT_T + REC_T)));
    }
  }
  if (R.mlegL) R.mlegL.rotation.z = Math.sin(t * 2 + sd) * 0.15;
  if (R.mlegR) R.mlegR.rotation.z = Math.sin(t * 2 + sd + 1) * 0.15;
  if (R.spin && A.spin) R.spin.rotation.y = t * A.spin + sd;
  if (R.saw) R.saw.rotation.x = t * 14;
  if (A.wheels) { if (R.wheelL) R.wheelL.rotation.z = -st.roll; if (R.wheelR) R.wheelR.rotation.z = -st.roll; }
  // Impacto: sacudida de todo el cuerpo
  if (hitK > 0) R.root.position.x -= hitK * 2.5 * Math.cos(st.hit * 60);
  deathPose(R, st, A.biped === 'walk');
}

/** Caída: los bípedos caen de espaldas; el resto rueda de lado. */
function deathPose(R: Rig, st: AnimState, biped: boolean) {
  if (st.dead < 0) return;
  const f = st.dead < 0.5 ? easeOut(st.dead / 0.5) : 1 - Math.sin(Math.min(1, (st.dead - 0.5) / 0.2) * Math.PI) * 0.04;
  if (biped) {
    R.root.rotation.z = 1.45 * f;
    if (R.armL) R.armL.rotation.x += 0.7 * f;
    if (R.armR) R.armR.rotation.x -= 0.7 * f;
  } else {
    R.root.rotation.x = 1.35 * f;
    R.root.position.y *= 1 - f;
  }
  if (st.dead > 1.0) R.root.position.y -= (st.dead - 1.0) * 30;
}

/** Duración total de la animación de muerte (s). */
export const DEATH_TIME = 1.9;
