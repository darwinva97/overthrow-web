// Servidor: sirve el cliente compilado y lleva las salas por WebSocket en /ws.
import { createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import { STEAM_CDN } from '../shared/data';
import type { ClientMsg, ServerMsg } from '../shared/net/protocol';
import { Room, type Player } from './room';

const PORT = Number(process.env.PORT ?? 4060);
const HOST = process.env.HOST ?? '127.0.0.1';
const DIST = process.env.DIST_DIR ?? fileURLToPath(new URL('../client/dist/', import.meta.url));

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.woff2': 'font/woff2',
  '.ico': 'image/x-icon', '.webp': 'image/webp',
};

const rooms = new Map<string, Room>();
const CACHE = fileURLToPath(new URL('../.cache/cdn/', import.meta.url));
mkdirSync(CACHE, { recursive: true });

/** Proxy con caché en disco de retratos e iconos de Valve. */
async function serveCdn(path: string, res: import('node:http').ServerResponse) {
  if (!/^(heroes|heroes\/icons|abilities|items)\/[a-z0-9_]+\.png$/.test(path)) { res.writeHead(404); res.end(); return; }
  const file = join(CACHE, path.replaceAll('/', '__'));
  const headers = { 'content-type': 'image/png', 'cache-control': 'public, max-age=604800' };
  if (existsSync(file)) { res.writeHead(200, headers); createReadStream(file).pipe(res); return; }
  try {
    const r = await fetch(`${STEAM_CDN}/${path}`);
    if (!r.ok) { res.writeHead(r.status); res.end(); return; }
    const buf = Buffer.from(await r.arrayBuffer());
    writeFileSync(file, buf);
    res.writeHead(200, headers);
    res.end(buf);
  } catch {
    res.writeHead(502); res.end();
  }
}

const http = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size }));
    return;
  }
  if (url.pathname.startsWith('/cdn/')) { void serveCdn(url.pathname.slice(5), res); return; }
  let file = normalize(join(DIST, decodeURIComponent(url.pathname)));
  if (!file.startsWith(DIST)) { res.writeHead(403); res.end(); return; }
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(DIST, 'index.html');
  if (!existsSync(file)) { res.writeHead(404); res.end('Cliente sin compilar: npm run build'); return; }
  const ext = extname(file);
  res.writeHead(200, {
    'content-type': TYPES[ext] ?? 'application/octet-stream',
    'cache-control': file.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  createReadStream(file).pipe(res);
});

const wss = new WebSocketServer({ server: http, path: '/ws', perMessageDeflate: { threshold: 512 }, maxPayload: 64 * 1024 });

function newCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (;;) {
    let c = '';
    for (let i = 0; i < 5; i++) c += A[Math.floor(Math.random() * A.length)];
    if (!rooms.has(c)) return c;
  }
}

wss.on('connection', (ws: WebSocket) => {
  let room: Room | null = null;
  let me: Player | null = null;
  const send = (m: ServerMsg) => { if (ws.readyState === 1) ws.send(JSON.stringify(m)); };
  let budget = 60;
  const refill = setInterval(() => { budget = Math.min(60, budget + 30); }, 1000);

  ws.on('message', (raw) => {
    if (--budget < 0) return; // límite de mensajes por segundo
    let m: ClientMsg;
    try { m = JSON.parse(String(raw)); } catch { return; }
    if (!m || typeof m.t !== 'string') return;

    if (!room || !me) {
      if (m.t === 'create') {
        room = new Room(newCode());
        if (m.map && ['necropolis', 'gardens', 'jungle', 'desert'].includes(m.map)) room.map = m.map;
        rooms.set(room.code, room);
        const p = room.addPlayer(String(m.name ?? ''), ws);
        if (typeof p === 'string') return send({ t: 'err', msg: p });
        me = p;
        if (m.hero) room.handle(me, { t: 'pick', hero: m.hero });
        send({ t: 'welcome', id: me.id, token: me.token, code: room.code });
        if (m.quick) room.start(); else room.pushLobby();
      } else if (m.t === 'join') {
        const r = rooms.get(String(m.code ?? '').toUpperCase().trim());
        if (!r) return send({ t: 'err', msg: 'No existe esa sala' });
        const p = r.addPlayer(String(m.name ?? ''), ws);
        if (typeof p === 'string') return send({ t: 'err', msg: p });
        room = r; me = p;
        send({ t: 'welcome', id: me.id, token: me.token, code: room.code });
        room.pushLobby();
      } else if (m.t === 'resume') {
        const r = rooms.get(String(m.code ?? '').toUpperCase());
        const p = r && [...r.players.values()].find((q) => q.token && q.token === m.token);
        if (!r || !p) return send({ t: 'err', msg: 'No se pudo volver a la partida' });
        room = r; me = p;
        p.ws = ws;
        if (p.unit) p.unit.isBot = false;
        send({ t: 'welcome', id: p.id, token: p.token, code: r.code });
        send({ t: 'lobby', lobby: r.lobbyState() });
        if (r.state === 'game') r.sendStart(p);
      }
      return;
    }
    if (m.t === 'leave') {
      room.removePlayer(me);
      room = null; me = null;
      return;
    }
    room.handle(me, m);
  });

  ws.on('close', () => {
    clearInterval(refill);
    if (room && me && me.ws === ws) room.removePlayer(me);
  });
});

// Limpieza de salas vacías o terminadas.
setInterval(() => {
  const now = Date.now();
  for (const [code, r] of rooms) {
    const online = r.humans().some((p) => p.ws);
    if (online) { r.emptySince = 0; continue; }
    if (!r.emptySince) r.emptySince = now;
    const grace = r.state === 'game' ? 3 * 60_000 : 30_000;
    if (now - r.emptySince > grace) { r.dispose(); rooms.delete(code); }
  }
}, 10_000);

http.listen(PORT, HOST, () => console.log(`Overthrow en http://${HOST}:${PORT}`));
