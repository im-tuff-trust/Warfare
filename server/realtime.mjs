// WARFARE realtime relay: persistent WebSocket rooms for lobbies and in-match sync.
// Vercel serverless functions cannot hold long-lived sockets, so deploy this small Node
// service separately (Render, Fly.io, Railway, any VPS) and point REALTIME_URL at it.
//
//   PORT=8787 node server/realtime.mjs
//
// HTTP:  POST /rooms -> { code }   GET /rooms/:code -> { exists, players }   GET /health
// WS:    { type:'join', room, create, name, clientId }  then  { type:'msg', to?, data }

import http from 'node:http';
import { randomInt } from 'node:crypto';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT || 8787);
const MAX_PLAYERS = Number(process.env.MAX_PLAYERS || 16);
const RESERVE_MS = 10 * 60 * 1000; // an unused reserved code expires after 10 minutes
const EMPTY_MS = 60 * 1000; // an empty room lingers for a minute (reconnects / host refresh)
const MAX_MSG = 96 * 1024;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** @type {Map<string, { code: string, created: number, emptySince: number, members: Map<string, { ws: import('ws').WebSocket, name: string, joinedAt: number }> }>} */
const rooms = new Map();

function newCode() {
  for (let attempt = 0; attempt < 100; attempt++) {
    let c = '';
    for (let i = 0; i < 6; i++) c += ALPHABET[randomInt(ALPHABET.length)];
    if (!rooms.has(c)) return c;
  }
  throw new Error('code space exhausted');
}

function reserve(code = newCode()) {
  const r = { code, created: Date.now(), emptySince: Date.now(), members: new Map() };
  rooms.set(code, r);
  return r;
}

function hostOf(room) {
  let best = null;
  for (const [id, m] of room.members) if (!best || m.joinedAt < best.joinedAt || (m.joinedAt === best.joinedAt && id < best.id)) best = { id, joinedAt: m.joinedAt };
  return best ? best.id : '';
}

function peers(room) {
  return [...room.members.entries()].map(([id, m]) => ({ id, name: m.name }));
}

function broadcastPeers(room) {
  const msg = JSON.stringify({ type: 'peers', host: hostOf(room), peers: peers(room) });
  for (const m of room.members.values()) if (m.ws.readyState === 1) m.ws.send(msg);
}

function cors(req, res) {
  const origin = req.headers.origin;
  if (!ALLOWED_ORIGINS.length || (origin && ALLOWED_ORIGINS.includes(origin))) res.setHeader('Access-Control-Allow-Origin', origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
}

const server = http.createServer((req, res) => {
  cors(req, res);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  const url = new URL(req.url || '/', 'http://x');
  const json = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (url.pathname === '/health') return json(200, { ok: true, rooms: rooms.size });
  if (url.pathname === '/rooms' && req.method === 'POST') return json(200, { code: reserve().code });
  const m = url.pathname.match(/^\/rooms\/([A-Z0-9]{6})$/i);
  if (m && req.method === 'GET') {
    const r = rooms.get(m[1].toUpperCase());
    return json(200, { exists: !!r, players: r ? r.members.size : 0 });
  }
  json(404, { error: 'not found' });
});

const wss = new WebSocketServer({ server, maxPayload: MAX_MSG });

wss.on('connection', (ws, req) => {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.length && origin && !ALLOWED_ORIGINS.includes(origin)) { ws.close(1008, 'origin not allowed'); return; }
  /** @type {null | { room: any, id: string }} */
  let me = null;
  let budget = 400; // simple per-socket rate limit (messages per second)
  const refill = setInterval(() => { budget = 400; }, 1000);
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    if (--budget < 0) return;
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (!me) {
      if (msg.type !== 'join') return;
      const code = String(msg.room || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
      const id = String(msg.clientId || '').replace(/[^a-z0-9]/gi, '').slice(0, 24);
      if (code.length !== 6 || !id) { ws.send(JSON.stringify({ type: 'error', error: 'Invalid room code' })); return; }
      let room = rooms.get(code);
      if (!room) {
        if (!msg.create) { ws.send(JSON.stringify({ type: 'error', error: 'Room not found. Check the code and try again.' })); return; }
        room = reserve(code);
      }
      if (room.members.size >= MAX_PLAYERS) { ws.send(JSON.stringify({ type: 'error', error: 'Room is full' })); return; }
      room.members.set(id, { ws, name: String(msg.name || 'Player').slice(0, 20), joinedAt: Date.now() });
      me = { room, id };
      ws.send(JSON.stringify({ type: 'joined', you: id, host: hostOf(room), peers: peers(room) }));
      broadcastPeers(room);
      return;
    }
    if (msg.type !== 'msg') return;
    const out = JSON.stringify({ type: 'msg', from: me.id, data: msg.data });
    if (msg.to) {
      const t = me.room.members.get(String(msg.to));
      if (t && t.ws.readyState === 1) t.ws.send(out);
    } else {
      for (const [id, m] of me.room.members) if (id !== me.id && m.ws.readyState === 1) m.ws.send(out);
    }
  });

  ws.on('close', () => {
    clearInterval(refill);
    if (!me) return;
    me.room.members.delete(me.id);
    if (me.room.members.size === 0) me.room.emptySince = Date.now();
    else broadcastPeers(me.room);
  });
});

// heartbeat + room cleanup
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
  const now = Date.now();
  for (const [code, r] of rooms) {
    if (r.members.size) continue;
    const neverUsed = r.created === r.emptySince;
    if (now - r.emptySince > (neverUsed ? RESERVE_MS : EMPTY_MS)) rooms.delete(code);
  }
}, 15000);

server.listen(PORT, () => console.log(`[realtime] listening on :${PORT}`));
