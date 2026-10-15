// Formato compacto de snapshots en la red. El servidor guarda por jugador qué le ha mandado
// ya (datos estáticos de unidades, tabla de textos, marcador, "me") y solo envía lo nuevo;
// el cliente reconstruye el Snapshot completo, así que el resto del código no cambia.
import type { BoardRow, SMe, SOrb, SProj, SUnit, SZone, Snapshot } from './protocol';
import type { Fx } from '../sim/types';

/** Unidad dinámica: [id, x, y, rumbo×100, vida, maná, nivel, estados, flags, visión, fx, ck]. */
type WUnit = [number, number, number, number, number, number, number, number, number, number, number, number];
/** Unidad estática: [id, tipo, nombre, equipo, vidaMáx, manáMáx, radio]. */
type WStatic = [number, string, string, number, number, number, number];
/** Proyectil: [id, fx, x, y, origen, objetivo, habilidad, ancho]. */
type WProj = [number, number, number, number, number, number, number, number];
/** Zona: [id, fx, x, y, radio, equipo, segundos×10, habilidad]. */
type WZone = [number, number, number, number, number, number, number, number];

export interface WireSnapshot {
  tm: number;
  n: 0 | 1;
  u: WUnit[];
  us?: WStatic[];
  str?: [number, string][];
  p: WProj[];
  z: WZone[];
  fx: Fx[];
  orbs: SOrb[];
  kills: number[];
  vz: Snapshot['vz'];
  cells?: [number, number][];
  board?: BoardRow[];
  me?: SMe | null;
}

/** El marcador es el mismo para todos los jugadores: se serializa una vez por snapshot. */
const boardStr = new WeakMap<object, string>();
const F_ATTACK = 1, F_CAST = 2, F_CHANNEL = 4, F_OWN = 8, F_ILL = 16;

/** Una instancia por jugador conectado. */
export class WireEncoder {
  private statics = new Map<number, string>();
  private strings = new Map<string, number>();
  private lastBoard = '';
  private boardAt = -99;
  private lastMe = '';
  private lastMeSlow = '';
  private n = 0;

  private str(s: string | undefined, out: [number, string][]): number {
    if (!s) return -1;
    let i = this.strings.get(s);
    if (i === undefined) { i = this.strings.size; this.strings.set(s, i); out.push([i, s]); }
    return i;
  }

  /** Olvida todo (reconexión): el siguiente snapshot va completo. */
  reset() { this.statics.clear(); this.strings.clear(); this.lastBoard = ''; this.lastMe = ''; this.lastMeSlow = ''; }

  encode(s: Snapshot): WireSnapshot {
    this.n++;
    const str: [number, string][] = [];
    const us: WStatic[] = [];
    const u: WUnit[] = s.u.map((x) => {
      const sig = `${x.k}|${x.n}|${x.t}|${x.H}|${x.M}|${x.r}`;
      if (this.statics.get(x.i) !== sig) { this.statics.set(x.i, sig); us.push([x.i, x.k, x.n, x.t, x.H, x.M, x.r]); }
      const flags = (x.a ? F_ATTACK : 0) | (x.c === 1 ? F_CAST : 0) | (x.c === 2 ? F_CHANNEL : 0) | (x.o ? F_OWN : 0) | (x.il ? F_ILL : 0);
      return [x.i, x.x, x.y, Math.round(x.f * 100), x.h, x.m, x.l, x.s, flags, x.v ?? 0,
        x.fx?.length ? this.str(x.fx.join(','), str) : -1, this.str(x.ck, str)];
    });
    // Las unidades que ya no se ven se olvidan para no crecer sin límite.
    if (this.statics.size > s.u.length * 4 + 200) {
      const live = new Set(s.u.map((x) => x.i));
      for (const id of this.statics.keys()) if (!live.has(id)) this.statics.delete(id);
    }
    const out: WireSnapshot = {
      tm: s.tm, n: s.night ? 1 : 0, u,
      p: s.p.map((p) => [p.i, this.str(p.fx, str), p.x, p.y, p.s, p.tu ?? -1, this.str(p.a, str), p.w ?? 0]),
      z: s.z.map((z) => [z.i, this.str(z.fx, str), z.x, z.y, z.r, z.t, Math.round(z.e * 10), this.str(z.a, str)]),
      fx: s.fx, orbs: s.orbs, kills: s.kills, vz: s.vz,
    };
    if (s.cells) out.cells = s.cells;
    if (us.length) out.us = us;
    // Marcador: como mucho una vez por segundo y solo si cambió.
    let b = boardStr.get(s.board);
    if (b === undefined) { b = JSON.stringify(s.board); boardStr.set(s.board, b); }
    if (b !== this.lastBoard && s.tm - this.boardAt >= 1) { out.board = s.board; this.lastBoard = b; this.boardAt = s.tm; }
    // "me": lo que cambia de estructura va al momento; los contadores, a 5 Hz.
    const meStr = JSON.stringify(s.me);
    if (meStr !== this.lastMe) {
      const slow = s.me ? JSON.stringify({
        ab: s.me.ab.map((a) => [a.k, a.l, a.can, a.av, a.hidden, a.tg, a.ch]), it: s.me.it.map((i) => i && [i.k, i.tg, i.md, i.ch]),
        st: s.me.st, ap: s.me.ap, orb: s.me.orb, neutral: s.me.neutral, talents: s.me.talents, dead: s.me.dead > 0, lvl: s.me.lvl,
        shop: s.me.shop, scepter: s.me.scepter, shard: s.me.shard, units: s.me.units,
      }) : '';
      if (slow !== this.lastMeSlow || this.n % 3 === 0) { out.me = s.me; this.lastMe = meStr; this.lastMeSlow = slow; }
    }
    if (str.length) out.str = str;
    return out;
  }
}

/** Una instancia por conexión en el cliente. */
export class WireDecoder {
  private statics = new Map<number, WStatic>();
  private strings: string[] = [];
  private board: BoardRow[] = [];
  private me: SMe | null = null;

  reset() { this.statics.clear(); this.strings = []; this.board = []; this.me = null; }

  decode(w: WireSnapshot): Snapshot {
    for (const [i, s] of w.str ?? []) this.strings[i] = s;
    for (const st of w.us ?? []) this.statics.set(st[0], st);
    if (w.board) this.board = w.board;
    if (w.me !== undefined) this.me = w.me;
    const S = (i: number) => (i >= 0 ? this.strings[i] : undefined);
    const u: SUnit[] = [];
    for (const d of w.u) {
      const st = this.statics.get(d[0]);
      if (!st) continue;
      const x: SUnit = {
        i: d[0], k: st[1], n: st[2], t: st[3], H: st[4], M: st[5], r: st[6],
        x: d[1], y: d[2], f: d[3] / 100, h: d[4], m: d[5], l: d[6], s: d[7],
      };
      const fl = d[8];
      if (fl & F_ATTACK) x.a = 1;
      if (fl & F_CAST) x.c = 1;
      if (fl & F_CHANNEL) x.c = 2;
      if (fl & F_OWN) x.o = 1;
      if (fl & F_ILL) x.il = 1;
      if (d[9]) x.v = d[9];
      const fx = S(d[10]);
      if (fx) x.fx = fx.split(',');
      const ck = S(d[11]);
      if (ck) x.ck = ck;
      u.push(x);
    }
    const p: SProj[] = w.p.map((q) => ({ i: q[0], fx: S(q[1]) ?? '', x: q[2], y: q[3], s: q[4], tu: q[5] >= 0 ? q[5] : undefined, a: S(q[6]), w: q[7] || undefined }));
    const z: SZone[] = w.z.map((q) => ({ i: q[0], fx: S(q[1]) ?? '', x: q[2], y: q[3], r: q[4], t: q[5], e: q[6] / 10, a: S(q[7]) }));
    return {
      tm: w.tm, night: w.n === 1, vz: w.vz, cells: w.cells, u, p, z, fx: w.fx,
      orbs: w.orbs, kills: w.kills, board: this.board, me: this.me,
    };
  }
}
