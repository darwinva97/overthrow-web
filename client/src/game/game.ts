// Partida en el cliente: cámara, entrada al estilo Dota, interpolación y el renderer
// elegido (2D o 3D), que se puede cambiar en caliente sin cortar la conexión.
import { buildMap, type MapLayout } from '../../../shared/maps';
import type { ServerMsg, SMe } from '../../../shared/net/protocol';
import type { Order } from '../../../shared/sim/types';
import { ST } from '../../../shared/sim/types';
import type { Net } from '../net';
import { Canvas2DRenderer } from '../render/canvas2d';
import { terrainCanvas } from '../render/terrain';
import type { Camera, Renderer, Targeting, View } from '../render/types';
import { Hud, IT_KEYS, abilityKeyMap } from './hud';
import { SnapBuffer, type VUnit } from './state';
import { WireDecoder } from '../../../shared/net/wire';

type StartMsg = Extract<ServerMsg, { t: 'start' }>;
type Mode = '2d' | '3d';
const MODE_KEY = 'overthrow.render';

interface Aim extends Targeting { slot: number; item: boolean; attackMove?: boolean }

export class Game {
  readonly root = document.createElement('div');
  private buf = new SnapBuffer();
  private wire = new WireDecoder();
  private layout: MapLayout;
  private renderer!: Renderer;
  private mode: Mode;
  private cam: Camera;
  private hud: Hud;
  private terrain2d: HTMLCanvasElement;
  private terrainMini: HTMLCanvasElement;
  /** Celdas taladas aplicadas a la cuadrícula local. */
  private felled: number[] = [];
  private initialCells: Uint8Array;
  private changed: [number, number][] = [];
  private mouse = { x: innerWidth / 2, y: innerHeight / 2 };
  private mouseWorld = { x: 0, y: 0 };
  private aim: Aim | null = null;
  private keys = new Set<string>();
  private camLock = false;
  private controlAll = true;
  private marker: View['marker'] = null;
  private last = performance.now();
  private raf = 0;
  private view: View | null = null;
  private offs: (() => void)[] = [];
  private drag: { x: number; y: number; cx: number; cy: number } | null = null;
  private centeredOnce = false;
  private ended = false;

  private net: Net;
  private start: StartMsg;
  private exit: () => void;

  constructor(net: Net, start: StartMsg, exit: () => void) {
    this.net = net; this.start = start; this.exit = exit;
    this.root.id = 'game';
    this.layout = buildMap(start.map);
    this.initialCells = this.layout.grid.cells.slice();
    const colors = start.teams.map((t) => t.color);
    this.terrain2d = terrainCanvas(this.layout, { trees: false, teamColors: colors });
    this.terrainMini = terrainCanvas(this.layout, { trees: true, teamColors: colors });
    const f = this.layout.fountains[start.team];
    this.cam = { x: f.x, y: f.y, zoom: 1 };
    this.mode = (localStorage.getItem(MODE_KEY) as Mode) || '3d';
    this.hud = new Hud({
      castAbility: (s, self) => this.castAbility(s, false, self),
      useItem: (s, self) => this.castAbility(s, true, self),
      learn: (s) => this.net.send({ t: 'learn', slot: s }),
      buy: (k) => this.net.send({ t: 'buy', item: k }),
      sell: (s) => this.net.send({ t: 'sell', slot: s }),
      swap: (a, b) => this.net.send({ t: 'swap', a, b }),
      pickOrb: (i) => this.net.send({ t: 'orb', i }),
      pickTalent: (key) => this.net.send({ t: 'talent', key }),
      pickNeutral: (trinket, enhancement) => this.net.send({ t: 'neutral', trinket, enhancement }),
      toggleMode: () => this.setMode(this.mode === '2d' ? '3d' : '2d'),
      toggleControlAll: () => { this.controlAll = !this.controlAll; },
      minimapClick: (x, y, button) => {
        if (button === 2) this.order({ type: 'move', x, y }, false, { x, y });
        else { this.cam.x = x; this.cam.y = y; this.camLock = false; }
      },
      chat: (text) => this.net.send({ t: 'chat', text }),
      leave: () => { this.net.send({ t: 'leave' }); this.exit(); },
    }, { killGoal: start.killGoal, timeLimit: start.timeLimit, teams: start.teams, team: start.team, layout: this.layout, terrain: this.terrainMini });
    this.root.append(this.hud.el);
    this.setMode(this.mode);
    this.bind();
    this.offs.push(net.on((m) => this.onMsg(m)));
    this.raf = requestAnimationFrame(this.frame);
  }

  // ---------------- Render ----------------

  private switching = false;

  async setMode(m: Mode) {
    if (this.switching) return;
    this.switching = true;
    const old = this.renderer;
    let r: Renderer;
    if (m === '3d') {
      try {
        const { Three3DRenderer } = await import('../render/three3d');
        r = new Three3DRenderer(this.layout, this.start.teams.map((t) => t.color));
      } catch (e) {
        console.error(e);
        this.hud.toast('Este navegador no puede mostrar 3D; sigues en 2D');
        m = '2d';
        r = new Canvas2DRenderer(this.layout, this.start.teams.map((t) => t.color), this.terrain2d);
      }
    } else {
      r = new Canvas2DRenderer(this.layout, this.start.teams.map((t) => t.color), this.terrain2d);
    }
    old?.dispose();
    this.renderer = r;
    this.mode = m;
    localStorage.setItem(MODE_KEY, m);
    for (const el of [...r.elements].reverse()) this.root.prepend(el);
    this.resize();
    r.treesChanged?.(this.changed);
    r.setQuality?.(this.quality.level);
    this.switching = false;
  }

  private resize = () => {
    this.renderer?.resize(innerWidth, innerHeight, Math.min(2, devicePixelRatio || 1) * this.quality.scale);
  };

  // ---------------- Calidad adaptativa ----------------
  // Mide el tiempo real entre frames: si va lento baja la resolución interna (y en 3D las
  // sombras); si sobra margen la vuelve a subir. Así un portátil modesto sigue fluido.
  /** localStorage 'overthrow.quality' = 'alta' | 'media' | 'baja' fija la calidad (sin adaptar). */
  private fixedQuality = ['alta', 'media', 'baja'].includes(localStorage.getItem('overthrow.quality') ?? '');
  private quality = { scale: 1, level: (({ baja: 0, media: 1 } as Record<string, 0 | 1 | 2>)[localStorage.getItem('overthrow.quality') ?? ''] ?? 2) as 0 | 1 | 2, slow: 0, fast: 0, ema: 16 };

  private adapt(frameMs: number) {
    const q = this.quality;
    q.ema += (Math.min(200, frameMs) - q.ema) * 0.05;
    if (document.hidden || this.fixedQuality) return;
    if (q.ema > 24) { q.slow++; q.fast = 0; } else if (q.ema < 14) { q.fast++; q.slow = 0; } else { q.slow = 0; q.fast = 0; }
    if (q.slow > 90) {
      q.slow = 0;
      if (q.level > 0 && q.scale <= 0.8) { q.level = (q.level - 1) as 0 | 1; this.renderer.setQuality?.(q.level); }
      else if (q.scale > 0.6) { q.scale = Math.max(0.6, q.scale * 0.85); this.resize(); }
    } else if (q.fast > 300) {
      q.fast = 0;
      if (q.scale < 1) { q.scale = Math.min(1, q.scale / 0.85); this.resize(); }
      else if (q.level < 2) { q.level = (q.level + 1) as 1 | 2; this.renderer.setQuality?.(q.level); }
    }
  }

  private frame = (now: number) => {
    this.raf = requestAnimationFrame(this.frame);
    this.adapt(now - this.last);
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    const sample = this.buf.sample();
    const latest = this.buf.latest;
    if (!sample || !latest || !this.renderer) return;
    const byId = new Map<number, VUnit>(sample.units.map((u) => [u.i, u]));
    const me = latest.me;
    const hero = me ? byId.get(me.id) : undefined;
    if (hero && !this.centeredOnce) { this.cam.x = hero.px; this.cam.y = hero.py; this.centeredOnce = true; }
    this.moveCamera(dt, hero);
    this.mouseWorld = this.renderer.screenToWorld(this.mouse.x, this.mouse.y, this.cam);
    const v: View = {
      tm: sample.tm, night: latest.night, units: sample.units, byId, projs: sample.projs, zones: latest.z, orbs: latest.orbs,
      me, hero, team: this.start.team, teams: this.start.teams, layout: this.layout,
      hover: 0, mouse: this.mouseWorld, targeting: this.aim && !this.aim.attackMove ? this.aim : null,
      captureTime: this.start.captureTime, marker: this.marker, board: latest.board, killsByTeam: latest.kills, vz: latest.vz ?? [],
    };
    v.hover = this.unitAt(this.mouse.x, this.mouse.y, v)?.i ?? 0;
    this.view = v;
    for (const f of this.buf.takeFx()) { this.renderer.fx(f, v); this.hud.onFx(f, v); }
    const t0 = performance.now();
    this.renderer.render(v, this.cam, dt);
    const corners = [[0, 0], [innerWidth, 0], [innerWidth, innerHeight], [0, innerHeight]].map(([x, y]) => this.renderer.screenToWorld(x, y, this.cam));
    this.hud.update(v, this.cam, corners, {
      mode: this.mode, controlAll: this.controlAll, ping: this.net.ping,
      targetingSlot: this.aim ? (this.aim.item ? 'i' : 'a') + this.aim.slot : '',
    });
    this.root.classList.toggle('targeting', !!this.aim);
    this.perfSample(now, performance.now() - t0, v);
  };

  // ---------------- Panel de rendimiento (F9) ----------------

  private perfEl: HTMLElement | null = null;
  private perf = { frames: 0, js: 0, since: performance.now(), bytes: 0, fps: 0, ms: 0, kbps: 0 };

  private togglePerf() {
    if (this.perfEl) { this.perfEl.remove(); this.perfEl = null; return; }
    this.perfEl = document.createElement('div');
    this.perfEl.className = 'perf';
    this.root.append(this.perfEl);
  }

  private perfSample(now: number, jsMs: number, v: View) {
    const p = this.perf;
    p.frames++; p.js += jsMs;
    if (now - p.since < 500) return;
    const secs = (now - p.since) / 1000;
    p.fps = p.frames / secs; p.ms = p.js / p.frames;
    p.kbps = (this.net.bytesIn - p.bytes) / 1024 / secs;
    p.bytes = this.net.bytesIn; p.frames = 0; p.js = 0; p.since = now;
    if (!this.perfEl) return;
    const extra = this.renderer.stats?.() ?? {};
    this.perfEl.innerHTML = [
      `${p.fps.toFixed(0)} FPS`, `${p.ms.toFixed(1)} ms de render`, `${p.kbps.toFixed(1)} KB/s de red`,
      `${v.units.length} unidades · ${v.projs.length} proyectiles`,
      `calidad ${['baja', 'media', 'alta'][this.quality.level]} · resolución ×${this.quality.scale.toFixed(2)}`,
      ...Object.entries(extra).map(([k, n]) => `${n} ${k}`),
    ].join('<br>');
  }

  private moveCamera(dt: number, hero: VUnit | undefined) {
    if ((this.camLock || this.keys.has(' ') || this.keys.has('F1')) && hero) {
      this.cam.x += (hero.px - this.cam.x) * Math.min(1, dt * 12);
      this.cam.y += (hero.py - this.cam.y) * Math.min(1, dt * 12);
      return;
    }
    const speed = 2600 / this.cam.zoom * dt;
    let dx = 0, dy = 0;
    if (this.keys.has('ArrowLeft')) dx--;
    if (this.keys.has('ArrowRight')) dx++;
    if (this.keys.has('ArrowUp')) dy--;
    if (this.keys.has('ArrowDown')) dy++;
    // Bordes de pantalla, solo con el ratón dentro y sin arrastrar.
    if (document.hasFocus() && !this.drag) {
      const m = 6;
      if (this.mouse.x <= m) dx--;
      if (this.mouse.x >= innerWidth - m) dx++;
      if (this.mouse.y <= m) dy--;
      if (this.mouse.y >= innerHeight - m) dy++;
    }
    this.cam.x += dx * speed;
    this.cam.y += dy * speed;
    const half = this.layout.half;
    this.cam.x = Math.max(-half, Math.min(half, this.cam.x));
    this.cam.y = Math.max(-half, Math.min(half + 600, this.cam.y));
  }

  private unitAt(sx: number, sy: number, v: View): VUnit | undefined {
    let best: VUnit | undefined, bd = Infinity;
    const h3 = this.mode === '3d';
    for (const u of v.units) {
      if (u.k === 'throne' || u.k === 'kobold' || u.k === 'orb' || (u.s & ST.hidden)) continue;
      const big = u.k === 'hero' || u.k === 'illusion';
      const p = this.renderer.worldToScreen(u.px, u.py, h3 ? (big ? 80 : 40) : 0, this.cam);
      const edge = this.renderer.worldToScreen(u.px + (big ? 40 : u.r * 1.4), u.py, h3 ? (big ? 80 : 40) : 0, this.cam);
      const r = Math.max(14, Math.abs(edge.x - p.x) * (h3 ? 1.6 : 1.1));
      const d = Math.hypot(p.x - sx, p.y - sy);
      if (d < r && d < bd) { bd = d; best = u; }
    }
    return best;
  }

  // ---------------- Órdenes ----------------

  private ownUnits(): number[] {
    const me = this.view?.me;
    if (!me) return [];
    return this.controlAll ? [me.id, ...me.units] : [me.id];
  }

  private order(o: Order, queue: boolean, mark?: { x: number; y: number }, attack = false) {
    const units = o.type === 'cast' || o.type === 'item' ? undefined : this.ownUnits();
    this.net.send({ t: 'order', o, q: queue, units });
    if (mark) this.marker = { ...mark, t: performance.now() / 1000, attack };
  }

  private castAbility(slot: number, item: boolean, self: boolean) {
    const me = this.view?.me;
    if (!me) return;
    if (item) {
      const it = me.it[slot];
      if (!it || (slot >= 6 && slot !== 9)) return;
      if (!it.tk || it.tk === 'passive') return this.hud.toast('Este item no tiene activa');
      if (it.cd > 0) return this.hud.toast('En enfriamiento');
      if (it.tk === 'none' || it.tk === 'toggle') return this.order({ type: 'item', slot }, false);
      if (self && (it.tk === 'unit' || it.tk === 'unitOrPoint')) return this.order({ type: 'item', slot, target: me.id }, false);
      this.aim = { slot, item: true, kind: it.tk, range: it.rng, aoe: 0 };
      return;
    }
    const a = me.ab[slot];
    if (!a || a.tk === 'passive') return;
    if (a.l === 0) return this.hud.toast('Aprende la habilidad primero (Ctrl + tecla)');
    if (a.tk === 'none' || a.tk === 'toggle') return this.order({ type: 'cast', slot }, false);
    if (self) return this.order({ type: 'cast', slot, target: me.id }, false);
    this.aim = { slot, item: false, kind: a.tk, range: a.rng, aoe: a.aoe };
  }

  private confirmAim(shift: boolean) {
    const a = this.aim!;
    const v = this.view!;
    const u = v.byId.get(v.hover);
    const p = this.mouseWorld;
    if (a.attackMove) {
      if (u && u.t !== v.team) this.order({ type: 'attack', target: u.i }, shift, { x: u.px, y: u.py }, true);
      else this.order({ type: 'attackMove', x: p.x, y: p.y }, shift, p, true);
      this.aim = null;
      return;
    }
    const type = a.item ? 'item' : 'cast';
    if (a.kind === 'unit') {
      if (!u) { this.hud.toast('Elige una unidad como objetivo'); return; }
      this.order({ type, slot: a.slot, target: u.i }, shift);
    } else if (a.kind === 'unitOrPoint' && u) {
      this.order({ type, slot: a.slot, target: u.i }, shift);
    } else {
      this.order({ type, slot: a.slot, x: p.x, y: p.y }, shift, p, true);
    }
    if (!shift) this.aim = null;
  }

  private rightClick(shift: boolean) {
    const v = this.view;
    if (!v) return;
    if (this.aim) { this.aim = null; return; }
    const u = v.byId.get(v.hover);
    if (u && u.t !== v.team && u.k !== 'fountain') this.order({ type: 'attack', target: u.i }, shift, { x: u.px, y: u.py }, true);
    else if (u && u.t === v.team && u.i !== v.me?.id && u.k !== 'fountain') this.order({ type: 'follow', target: u.i }, shift, { x: u.px, y: u.py });
    else this.order({ type: 'move', x: this.mouseWorld.x, y: this.mouseWorld.y }, shift, this.mouseWorld);
  }

  private abilitySlotForKey(me: SMe, key: string): number {
    for (const [slot, k] of abilityKeyMap(me.ab)) if (k === key) return slot;
    return -1;
  }

  private bind() {
    const el = this.root;
    const on = <K extends keyof WindowEventMap>(t: K, f: (e: WindowEventMap[K]) => void, target: Window | HTMLElement = window) => {
      target.addEventListener(t, f as EventListener);
      this.offs.push(() => target.removeEventListener(t, f as EventListener));
    };
    on('resize', this.resize);
    on('mousemove', (e) => {
      this.mouse = { x: e.clientX, y: e.clientY };
      if (this.drag && this.renderer) {
        const a = this.renderer.screenToWorld(this.drag.x, this.drag.y, this.cam);
        const b = this.renderer.screenToWorld(e.clientX, e.clientY, this.cam);
        this.cam.x -= b.x - a.x; this.cam.y -= b.y - a.y;
        this.drag.x = e.clientX; this.drag.y = e.clientY;
      }
    });
    on('mouseup', (e) => { if (e.button === 1) this.drag = null; });
    const isWorld = (e: Event) => !!this.renderer && this.renderer.elements.includes(e.target as HTMLElement);
    on('mousedown', (e) => {
      if (!isWorld(e)) return;
      if (e.button === 1) { e.preventDefault(); this.drag = { x: e.clientX, y: e.clientY, cx: this.cam.x, cy: this.cam.y }; return; }
      if (e.button === 2) { this.rightClick(e.shiftKey); return; }
      if (e.button === 0 && this.aim) this.confirmAim(e.shiftKey);
    }, el);
    on('contextmenu', (e) => e.preventDefault(), el);
    on('wheel', (e) => {
      if (!isWorld(e)) return;
      this.cam.zoom = Math.max(0.55, Math.min(1.7, this.cam.zoom * (e.deltaY > 0 ? 0.92 : 1.08)));
    }, el);
    on('keyup', (e) => {
      this.keys.delete(e.key.length === 1 ? e.key.toUpperCase() : e.key);
      if (e.key === 'Tab') this.hud.showBoard(false);
    });
    on('blur', () => this.keys.clear());
    on('keydown', (e) => {
      if (this.hud.typing) return;
      const key = e.key.length === 1 ? e.key.toUpperCase() : e.key;
      if (key === 'Tab') { e.preventDefault(); this.hud.showBoard(true); return; }
      if (key === 'F2') { e.preventDefault(); this.setMode(this.mode === '2d' ? '3d' : '2d'); return; }
      if (key === 'F3') { e.preventDefault(); this.controlAll = !this.controlAll; return; }
      if (key === 'F9') { e.preventDefault(); this.togglePerf(); return; }
      if (key === 'F1') e.preventDefault();
      if (e.repeat && key !== ' ') return;
      this.keys.add(key);
      const me = this.view?.me;
      if (key === 'Enter') { e.preventDefault(); this.hud.openChat(); return; }
      if (key === 'Escape') { this.aim = null; this.hud.toggleShop(false); return; }
      if (key === 'B') { this.hud.toggleShop(); return; }
      if (key === 'Y') { this.camLock = !this.camLock; return; }
      if (!me) return;
      if (e.altKey && ['1', '2', '3'].includes(key) && me.orb) { e.preventDefault(); this.net.send({ t: 'orb', i: +key - 1 }); return; }
      const ab = this.abilitySlotForKey(me, key);
      if (ab >= 0) {
        e.preventDefault();
        if (e.ctrlKey || e.metaKey) this.net.send({ t: 'learn', slot: ab });
        else this.castAbility(ab, false, e.altKey);
        return;
      }
      const it = key === '0' ? 9 : IT_KEYS.indexOf(key);
      if (it >= 0) { this.castAbility(it, true, e.altKey); return; }
      if (key === 'A') { this.aim = { slot: -1, item: false, kind: 'point', range: 0, aoe: 0, attackMove: true }; return; }
      if (key === 'S') { this.order({ type: 'stop' }, false); this.aim = null; return; }
      if (key === 'H') { this.order({ type: 'hold' }, false); return; }
    });
  }

  private applyCells(list: [number, number][]) {
    const g = this.layout.grid;
    for (const i of this.felled) g.cells[i] = this.initialCells[i];
    for (const [i, v] of list) g.cells[i] = v;
    this.felled = list.map(([i]) => i);
    this.changed = list;
    this.renderer?.treesChanged?.(list);
  }

  private onMsg(m: ServerMsg) {
    if (m.t === 's' || m.t === 'w') {
      const s = m.t === 'w' ? this.wire.decode(m.s) : m.s;
      this.buf.push(s);
      if (s.cells) this.applyCells(s.cells);
    }
    else if (m.t === 'start') this.wire.reset();
    else if (m.t === 'err') this.hud.toast(m.msg);
    else if (m.t === 'chat') this.hud.chatLine(m.from, m.text, this.start.teams[m.team]?.color ?? '#ccc');
    else if (m.t === 'end' && !this.ended) {
      this.ended = true;
      this.hud.showEnd(m.winner, m.reason, m.board, this.start.team, () => { this.net.send({ t: 'leave' }); this.exit(); });
    }
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    for (const f of this.offs) f();
    this.renderer.dispose();
    this.hud.dispose();
    this.root.remove();
  }
}
