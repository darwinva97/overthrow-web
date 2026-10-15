// Conexión WebSocket con el servidor. Reconecta y retoma la partida con el token guardado.
import type { ClientMsg, ServerMsg } from '../../shared/net/protocol';

type Handler = (m: ServerMsg) => void;

export class Net {
  ws: WebSocket | null = null;
  private handlers = new Set<Handler>();
  private queue: ClientMsg[] = [];
  ping = 0;
  /** Bytes recibidos (para el panel de rendimiento). */
  bytesIn = 0;
  private closedByUser = false;
  onStatus: (s: 'open' | 'closed') => void = () => {};

  connect() {
    this.closedByUser = false;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws = ws;
    ws.onopen = () => {
      this.onStatus('open');
      const saved = loadSession();
      if (saved) ws.send(JSON.stringify({ t: 'resume', code: saved.code, token: saved.token }));
      for (const m of this.queue) ws.send(JSON.stringify(m));
      this.queue = [];
    };
    ws.onmessage = (e) => {
      this.bytesIn += (e.data as string).length;
      const m = JSON.parse(e.data) as ServerMsg;
      if (m.t === 'pong') { this.ping = performance.now() - m.c; return; }
      if (m.t === 'welcome') saveSession(m.code, m.token);
      for (const h of this.handlers) h(m);
    };
    ws.onclose = () => {
      this.onStatus('closed');
      if (!this.closedByUser) setTimeout(() => this.connect(), 1500);
    };
    setInterval(() => this.send({ t: 'ping', c: performance.now() }), 2000);
  }

  on(h: Handler) { this.handlers.add(h); return () => this.handlers.delete(h); }

  send(m: ClientMsg) {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(m));
    else if (m.t !== 'ping' && m.t !== 'order') this.queue.push(m);
  }
}

const KEY = 'overthrow.session';
export function saveSession(code: string, token: string) { sessionStorage.setItem(KEY, JSON.stringify({ code, token })); }
export function loadSession(): { code: string; token: string } | null {
  try { return JSON.parse(sessionStorage.getItem(KEY) ?? 'null'); } catch { return null; }
}
export function clearSession() { sessionStorage.removeItem(KEY); }
