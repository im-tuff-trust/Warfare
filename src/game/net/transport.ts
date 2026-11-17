// Transport abstraction. In production a persistent WebSocket relay (server/realtime.mjs) carries
// room traffic; when no realtime URL is configured, BroadcastChannel lets multiple tabs on one
// device share a room so the full lobby/multiplayer flow still works locally.

export interface PeerInfo { id: string; name: string; }
export type MessageHandler = (from: string, data: any) => void; // eslint-disable-line @typescript-eslint/no-explicit-any
export type PeersHandler = (peers: PeerInfo[], hostId: string) => void;

export interface Transport {
  readonly id: string;
  readonly mode: 'online' | 'local';
  connect(room: string, create: boolean, name: string): Promise<{ hostId: string; peers: PeerInfo[] }>;
  send(data: unknown, to?: string): void;
  onMessage(cb: MessageHandler): void;
  onPeers(cb: PeersHandler): void;
  onClose(cb: (reason: string) => void): void;
  close(): void;
}

export function randomId(n = 10): string {
  const a = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  const arr = new Uint8Array(n);
  crypto.getRandomValues(arr);
  for (let i = 0; i < n; i++) s += a[arr[i] % a.length];
  return s;
}

// ------------------------------------------------------------------ WebSocket

export class WebSocketTransport implements Transport {
  readonly id = randomId();
  readonly mode = 'online' as const;
  private ws: WebSocket | null = null;
  private msgCb: MessageHandler = () => {};
  private peersCb: PeersHandler = () => {};
  private closeCb: (r: string) => void = () => {};
  private queue: string[] = [];
  private closed = false;
  constructor(private url: string) {}

  connect(room: string, create: boolean, name: string) {
    return new Promise<{ hostId: string; peers: PeerInfo[] }>((resolve, reject) => {
      let settled = false;
      const ws = new WebSocket(this.url);
      this.ws = ws;
      const timer = setTimeout(() => { if (!settled) { settled = true; reject(new Error('Realtime server did not respond')); ws.close(); } }, 8000);
      ws.onopen = () => ws.send(JSON.stringify({ type: 'join', room, create, name, clientId: this.id }));
      ws.onerror = () => { if (!settled) { settled = true; clearTimeout(timer); reject(new Error('Could not reach the realtime server')); } };
      ws.onclose = () => {
        if (!settled) { settled = true; clearTimeout(timer); reject(new Error('Connection closed')); }
        else if (!this.closed) this.closeCb('Disconnected from the realtime server');
      };
      ws.onmessage = (ev) => {
        let m: any; // eslint-disable-line @typescript-eslint/no-explicit-any
        try { m = JSON.parse(ev.data as string); } catch { return; }
        if (m.type === 'joined') {
          settled = true; clearTimeout(timer);
          for (const q of this.queue) ws.send(q);
          this.queue = [];
          resolve({ hostId: m.host, peers: m.peers });
        } else if (m.type === 'error') {
          if (!settled) { settled = true; clearTimeout(timer); reject(new Error(m.error)); }
        } else if (m.type === 'peers') this.peersCb(m.peers, m.host);
        else if (m.type === 'msg') this.msgCb(m.from, m.data);
      };
    });
  }
  send(data: unknown, to?: string) {
    const s = JSON.stringify({ type: 'msg', to, data });
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(s);
    else this.queue.push(s);
  }
  onMessage(cb: MessageHandler) { this.msgCb = cb; }
  onPeers(cb: PeersHandler) { this.peersCb = cb; }
  onClose(cb: (r: string) => void) { this.closeCb = cb; }
  close() { this.closed = true; this.ws?.close(); }
}

// ------------------------------------------------------------------ BroadcastChannel (same device)

interface BCMsg { k: 'hello' | 'here' | 'bye' | 'hb' | 'msg'; from: string; name?: string; joinedAt?: number; to?: string; data?: unknown; room?: string; }

export class LocalTransport implements Transport {
  readonly id = randomId();
  readonly mode = 'local' as const;
  private ch: BroadcastChannel | null = null;
  private peers = new Map<string, { name: string; joinedAt: number; seen: number }>();
  private msgCb: MessageHandler = () => {};
  private peersCb: PeersHandler = () => {};
  private closeCb: (r: string) => void = () => {};
  private joinedAt = Date.now();
  private name = '';
  private hb: ReturnType<typeof setInterval> | null = null;
  private lastHost = '';

  connect(room: string, create: boolean, name: string) {
    this.name = name;
    return new Promise<{ hostId: string; peers: PeerInfo[] }>((resolve, reject) => {
      const ch = new BroadcastChannel('warfare-room-' + room);
      this.ch = ch;
      let answered = false;
      ch.onmessage = (ev) => {
        const m = ev.data as BCMsg;
        if (m.from === this.id) return;
        if (m.to && m.to !== this.id) return;
        const now = Date.now();
        switch (m.k) {
          case 'hello':
            this.peers.set(m.from, { name: m.name ?? '?', joinedAt: m.joinedAt ?? now, seen: now });
            this.post({ k: 'here', from: this.id, name: this.name, joinedAt: this.joinedAt, to: m.from });
            this.emitPeers();
            break;
          case 'here': case 'hb':
            if (!this.peers.has(m.from) || m.k === 'here') answered = true;
            this.peers.set(m.from, { name: m.name ?? '?', joinedAt: m.joinedAt ?? now, seen: now });
            if (m.k === 'here') this.emitPeers();
            break;
          case 'bye':
            this.peers.delete(m.from);
            this.emitPeers();
            break;
          case 'msg':
            this.msgCb(m.from, m.data);
            break;
        }
      };
      if (create) this.joinedAt = Date.now() - 1e9; // the creator is always the initial host
      this.post({ k: 'hello', from: this.id, name, joinedAt: this.joinedAt });
      setTimeout(() => {
        if (!create && !answered) { ch.close(); this.ch = null; reject(new Error('Room not found. (Local mode: rooms are shared between tabs on this device only.)')); return; }
        this.hb = setInterval(() => {
          this.post({ k: 'hb', from: this.id, name: this.name, joinedAt: this.joinedAt });
          const now = Date.now();
          let changed = false;
          for (const [id, p] of this.peers) if (now - p.seen > 5000) { this.peers.delete(id); changed = true; }
          if (changed) this.emitPeers();
        }, 1000);
        window.addEventListener('beforeunload', this.onUnload);
        resolve({ hostId: this.host(), peers: this.peerList() });
      }, create ? 150 : 1200);
    });
  }
  private onUnload = () => this.post({ k: 'bye', from: this.id });
  private post(m: BCMsg) { try { this.ch?.postMessage(m); } catch { /* closed */ } }
  private peerList(): PeerInfo[] {
    return [{ id: this.id, name: this.name }, ...[...this.peers.entries()].map(([id, p]) => ({ id, name: p.name }))];
  }
  private host(): string {
    let best = this.id, bt = this.joinedAt;
    for (const [id, p] of this.peers) if (p.joinedAt < bt || (p.joinedAt === bt && id < best)) { best = id; bt = p.joinedAt; }
    return best;
  }
  private emitPeers() {
    const h = this.host();
    this.lastHost = h;
    this.peersCb(this.peerList(), h);
  }
  send(data: unknown, to?: string) { this.post({ k: 'msg', from: this.id, to, data }); }
  onMessage(cb: MessageHandler) { this.msgCb = cb; }
  onPeers(cb: PeersHandler) { this.peersCb = cb; }
  onClose(cb: (r: string) => void) { this.closeCb = cb; void this.closeCb; }
  close() {
    this.post({ k: 'bye', from: this.id });
    if (this.hb) clearInterval(this.hb);
    window.removeEventListener('beforeunload', this.onUnload);
    this.ch?.close();
    this.ch = null;
    void this.lastHost;
  }
}

// ------------------------------------------------------------------ room codes & config

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I

export function localRoomCode(): string {
  const arr = new Uint8Array(6);
  crypto.getRandomValues(arr);
  return [...arr].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

export function normalizeCode(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
}

export interface NetConfig { realtimeUrl: string | null; }

export async function fetchConfig(): Promise<NetConfig> {
  const env = process.env.NEXT_PUBLIC_REALTIME_URL;
  if (env) return { realtimeUrl: env };
  try {
    const r = await fetch('/api/config', { cache: 'no-store' });
    if (r.ok) { const j = await r.json(); return { realtimeUrl: j.realtimeUrl || null }; }
  } catch { /* static hosting */ }
  return { realtimeUrl: null };
}

/** Ask the backend for a unique room code (falls back to a client-side code). */
export async function createRoomCode(): Promise<string> {
  try {
    const r = await fetch('/api/rooms', { method: 'POST', cache: 'no-store' });
    if (r.ok) { const j = await r.json(); if (j.code) return j.code as string; }
  } catch { /* offline */ }
  return localRoomCode();
}

export async function roomExists(code: string): Promise<boolean | null> {
  try {
    const r = await fetch('/api/rooms/' + encodeURIComponent(code), { cache: 'no-store' });
    if (r.ok) { const j = await r.json(); return typeof j.exists === 'boolean' ? j.exists : null; }
  } catch { /* offline */ }
  return null;
}

export function makeTransport(cfg: NetConfig): Transport {
  return cfg.realtimeUrl ? new WebSocketTransport(cfg.realtimeUrl) : new LocalTransport();
}
