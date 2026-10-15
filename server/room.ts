// Una sala: lobby (elegir mapa, héroe y equipo) y después la partida autoritativa.
import { randomBytes } from 'node:crypto';
import type { WebSocket } from 'ws';
import { addHero, createGame } from '../shared/game/setup';
import { MAPS } from '../shared/maps';
import type { ClientMsg, LobbyState, ServerMsg } from '../shared/net/protocol';
import { botThink, playableHeroes } from '../shared/overthrow/bot';
import { applyPick } from '../shared/overthrow/rules';
import { applyNeutralPick } from '../shared/overthrow/neutrals';
import { pickTalent } from '../shared/sim/talents';
import { levelAbility } from '../shared/sim/abilities';
import { buyItem, sellItem, swapItems } from '../shared/sim/items';
import type { Order } from '../shared/sim/types';
import type { Unit } from '../shared/sim/unit';
import { TICK } from '../shared/sim/world';
import { XP_TABLE } from '../shared/data';
import { board, buildSnapshot } from './snapshot';
import { WireEncoder } from '../shared/net/wire';

export interface Player {
  id: string;
  token: string;
  name: string;
  ws: WebSocket | null;
  hero: string | null;
  team: number;
  bot: boolean;
  unit: Unit | null;
  lastSeen: number;
  gridVersion?: number;
  enc?: WireEncoder;
}

const SNAPSHOT_EVERY = 2; // ticks → 15 Hz
const BOT_NAMES = ['Bot Ancestral', 'Bot Kobold', 'Bot Roshan', 'Bot Tinker', 'Bot Ogro', 'Bot Sátiro', 'Bot Centauro', 'Bot Dragón'];

export class Room {
  code: string;
  host = '';
  map = 'necropolis';
  fillBots = true;
  state: 'lobby' | 'game' | 'over' = 'lobby';
  players = new Map<string, Player>();
  game: ReturnType<typeof createGame> | null = null;
  private timer: NodeJS.Timeout | null = null;
  emptySince = 0;
  createdAt = Date.now();
  private botSeq = 0;

  constructor(code: string) { this.code = code; }

  get def() { return MAPS[this.map]; }
  get capacity() { return this.def.teams * this.def.teamSize; }
  humans() { return [...this.players.values()].filter((p) => !p.bot); }

  send(p: Player, m: ServerMsg) {
    if (p.ws && p.ws.readyState === 1) p.ws.send(JSON.stringify(m));
  }
  broadcast(m: ServerMsg) { for (const p of this.players.values()) this.send(p, m); }

  lobbyState(): LobbyState {
    return {
      code: this.code, host: this.host, map: this.map, fillBots: this.fillBots, state: this.state,
      teams: this.def.teams, teamSize: this.def.teamSize,
      players: [...this.players.values()].map((p) => ({ id: p.id, name: p.name, hero: p.hero, team: p.team, bot: p.bot, online: !!p.ws || p.bot })),
    };
  }
  pushLobby() { this.broadcast({ t: 'lobby', lobby: this.lobbyState() }); }

  /** Equipo con menos jugadores. */
  private freeTeam(): number {
    const counts = new Array(this.def.teams).fill(0);
    for (const p of this.players.values()) if (p.team >= 0 && p.team < counts.length) counts[p.team]++;
    let best = -1;
    for (let i = 0; i < counts.length; i++) if (counts[i] < this.def.teamSize && (best < 0 || counts[i] < counts[best])) best = i;
    return best;
  }

  addPlayer(name: string, ws: WebSocket): Player | string {
    if (this.state !== 'lobby') return 'La partida ya ha empezado';
    // Si la sala está llena de bots, un humano echa a uno.
    if (this.players.size >= this.capacity) {
      const bot = [...this.players.values()].find((p) => p.bot);
      if (!bot) return 'Sala llena';
      this.players.delete(bot.id);
    }
    const id = randomBytes(6).toString('hex');
    const p: Player = { id, token: randomBytes(12).toString('hex'), name: name.slice(0, 20) || 'Jugador', ws, hero: null, team: this.freeTeam(), bot: false, unit: null, lastSeen: Date.now() };
    this.players.set(id, p);
    if (!this.host) this.host = id;
    return p;
  }

  addBot() {
    if (this.players.size >= this.capacity) return;
    const id = 'bot' + (++this.botSeq) + randomBytes(2).toString('hex');
    const taken = new Set([...this.players.values()].map((p) => p.hero));
    const heroes = playableHeroes();
    const free = heroes.filter((h) => !taken.has(h));
    const hero = (free.length ? free : heroes)[Math.floor(Math.random() * (free.length || heroes.length))];
    this.players.set(id, { id, token: '', name: BOT_NAMES[this.botSeq % BOT_NAMES.length], ws: null, hero, team: this.freeTeam(), bot: true, unit: null, lastSeen: Date.now() });
  }

  removePlayer(p: Player) {
    if (this.state === 'lobby') {
      this.players.delete(p.id);
      if (this.host === p.id) this.host = this.humans()[0]?.id ?? '';
      this.pushLobby();
    } else {
      // En partida su héroe pasa a manos de un bot hasta que vuelva.
      p.ws = null;
      if (p.unit) p.unit.isBot = true;
    }
  }

  handle(p: Player, m: ClientMsg) {
    p.lastSeen = Date.now();
    if (m.t === 'ping') return this.send(p, { t: 'pong', c: m.c });
    if (m.t === 'chat') {
      const text = String(m.text).slice(0, 200);
      if (process.env.CHEATS === '1' && text.startsWith('-') && p.unit && this.game) { this.cheat(p.unit, text); return; }
      for (const q of this.players.values()) this.send(q, { t: 'chat', from: p.name, text, team: p.team });
      return;
    }
    if (this.state === 'lobby') return this.handleLobby(p, m);
    if (this.state === 'game') return this.handleGame(p, m);
  }

  private handleLobby(p: Player, m: ClientMsg) {
    const isHost = p.id === this.host;
    switch (m.t) {
      case 'pick':
        if (playableHeroes().includes(m.hero)) p.hero = m.hero;
        break;
      case 'team': {
        const n = [...this.players.values()].filter((q) => q.team === m.team).length;
        if (m.team >= 0 && m.team < this.def.teams && n < this.def.teamSize) p.team = m.team;
        break;
      }
      case 'map':
        if (isHost && MAPS[m.map]) {
          this.map = m.map;
          for (const q of [...this.players.values()]) if (q.bot) this.players.delete(q.id);
          for (const q of this.players.values()) q.team = -1;
          for (const q of this.players.values()) q.team = this.freeTeam();
        }
        break;
      case 'bots':
        if (isHost) this.fillBots = !!m.fill;
        break;
      case 'start':
        if (isHost) this.start();
        return;
    }
    this.pushLobby();
  }

  start() {
    if (this.state !== 'lobby') return;
    if (this.fillBots) while (this.players.size < this.capacity) this.addBot();
    const game = createGame(this.map);
    this.game = game;
    this.initialCells = game.world.grid.cells.slice();
    const heroes = playableHeroes();
    for (const p of this.players.values()) {
      if (p.team < 0) p.team = this.freeTeam();
      if (p.team < 0) continue;
      if (!p.hero) p.hero = heroes[Math.floor(Math.random() * heroes.length)];
      const u = addHero(game, p.hero, p.team, p.id);
      u.isBot = p.bot || !p.ws;
      (u as any).displayName = p.name;
      p.unit = u;
    }
    this.state = 'game';
    this.pushLobby();
    for (const p of this.players.values()) this.sendStart(p);
    let n = 0;
    this.timer = setInterval(() => this.step(++n), TICK * 1000);
  }

  sendStart(p: Player) {
    if (!this.game || !p.unit) return;
    p.gridVersion = -1;
    p.enc = new WireEncoder();
    const d = this.def;
    this.send(p, {
      t: 'start', map: this.map, you: p.id, team: p.team, hero: p.unit.id,
      teams: this.game.world.teams.map((t) => ({ id: t.id, name: t.name, color: t.color })),
      killGoal: d.killGoal, timeLimit: d.timeLimit, captureTime: d.captureTime,
    });
  }

  private step(n: number) {
    const g = this.game!;
    const w = g.world;
    for (const p of this.players.values()) if (p.unit?.isBot) botThink(w, p.unit, g.rules);
    try {
      w.tick();
    } catch (e) {
      console.error(`[${this.code}] error en tick`, e);
    }
    for (const e of w.errors) {
      const p = this.players.get(e.playerId);
      if (p) this.send(p, { t: 'err', msg: e.msg });
    }
    w.errors.length = 0;
    if (n % SNAPSHOT_EVERY === 0) {
      const fx = w.fx;
      w.fx = [];
      const rows = board(w);
      for (const r of rows) {
        const p = [...this.players.values()].find((q) => q.unit?.id === r.id);
        if (p) r.name = p.name;
      }
      // Un snapshot por equipo, reutilizado salvo la parte "me".
      for (const p of this.players.values()) {
        if (!p.ws || p.ws.readyState !== 1) continue;
        const s = buildSnapshot(w, g.rules, p.team, p.unit, fx, rows);
        if (p.gridVersion !== w.grid.version) { s.cells = this.changedCells(); p.gridVersion = w.grid.version; }
        p.enc ??= new WireEncoder();
        p.ws.send(JSON.stringify({ t: 'w', s: p.enc.encode(s) }));
      }
    }
    if (w.over) this.finish();
  }

  private finish() {
    const w = this.game!.world;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.state = 'over';
    const rows = board(w);
    for (const r of rows) {
      const p = [...this.players.values()].find((q) => q.unit?.id === r.id);
      if (p) r.name = p.name;
    }
    this.broadcast({ t: 'end', winner: w.over!.winner, reason: w.over!.reason, board: rows });
  }

  private handleGame(p: Player, m: ClientMsg) {
    const g = this.game!;
    const w = g.world;
    const h = p.unit;
    if (!h) return;
    switch (m.t) {
      case 'order': {
        const o = sanitizeOrder(m.o);
        if (!o) return;
        // Sin lista de unidades: solo el héroe. Con lista: las suyas (ilusiones, wards).
        const ids = m.units?.length ? m.units : [h.id];
        for (const id of ids.slice(0, 40)) {
          const u = w.units.get(id);
          if (!u || u.playerId !== p.id || !u.alive) continue;
          if ((o.type === 'cast' || o.type === 'item') && u !== h) continue;
          w.issueOrder(u, o, !!m.q);
        }
        break;
      }
      case 'learn': { const a = h.abilities[m.slot]; if (a) levelAbility(h, a); break; }
      case 'buy': { const e = buyItem(h, String(m.item)); if (e) this.send(p, { t: 'err', msg: e }); break; }
      case 'sell': { const e = sellItem(h, m.slot | 0); if (e) this.send(p, { t: 'err', msg: e }); break; }
      case 'swap': swapItems(h, m.a | 0, m.b | 0); break;
      case 'orb': applyPick(h, m.i | 0); break;
      case 'talent': pickTalent(h, String(m.key)); break;
      case 'neutral': applyNeutralPick(h, m.trinket | 0, m.enhancement | 0); break;
    }
  }

  private initialCells: Uint8Array | null = null;
  /** Celdas que difieren del mapa inicial: árboles talados o plantados, muros temporales. */
  private changedCells(): [number, number][] {
    const g = this.game!.world.grid;
    const init = this.initialCells ??= g.cells.slice();
    const out: [number, number][] = [];
    for (let i = 0; i < g.cells.length; i++) if (g.cells[i] !== init[i]) out.push([i, g.cells[i]]);
    return out;
  }

  /** Cheats de lobby de Dota, solo con CHEATS=1 (pruebas). */
  private cheat(u: Unit, text: string) {
    const [cmd, arg] = text.trim().split(/\s+/);
    if (cmd === '-lvlup') { for (let i = 0; i < (+arg || 1); i++) u.addXp(XP_TABLE[Math.min(XP_TABLE.length - 1, u.level)] - u.xp + 1); }
    else if (cmd === '-gold') u.gold += +arg || 10000;
    else if (cmd === '-item' && arg) buyItem(u, arg);
    else if (cmd === '-refresh') { u.hp = u.s.maxHp; u.mana = u.s.maxMana; for (const a of u.abilities) a.cd = 0; for (const i of u.items) if (i) i.cd = 0; }
  }

  dispose() { if (this.timer) clearInterval(this.timer); }
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

function sanitizeOrder(o: any): Order | null {
  if (!o || typeof o.type !== 'string') return null;
  switch (o.type) {
    case 'move': case 'attackMove':
      if (num(o.x) === undefined || num(o.y) === undefined) return null;
      return { type: o.type, x: o.x, y: o.y };
    case 'attack': case 'follow':
      return num(o.target) === undefined ? null : { type: o.type, target: o.target };
    case 'stop': case 'hold': return { type: o.type };
    case 'cast': case 'item':
      if (num(o.slot) === undefined) return null;
      return { type: o.type, slot: o.slot | 0, target: num(o.target), x: num(o.x), y: num(o.y) };
  }
  return null;
}
