// server-lan.js — plain Node.js multiplayer server, no PartyKit needed.
//
// Run:    node server-lan.js
// Then share with friends on the same Wi-Fi:  http://<your-lan-ip>:4200
//
// Same protocol as src/server.js so the client (public/index.html) works unchanged.

import http from 'node:http';
import fs   from 'node:fs';
import path from 'node:path';
import os   from 'node:os';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';

const PORT = 4200;
const __dir = path.dirname(fileURLToPath(import.meta.url));
const HTML  = fs.readFileSync(path.join(__dir, 'public', 'index.html'));

// ── blob spawning (mirrors src/server.js, updated world radius) ──────────────
const CAP = 40, R_MIN = 5, R_MAX = 15;
function spawnBlob() {
  const roll = Math.random();
  const r = roll < 0.70 ? 11 + Math.random()*4
           : roll < 0.92 ?  8 + Math.random()*3
                          :  5 + Math.random()*3;
  const t      = (r - R_MIN) / (R_MAX - R_MIN);
  const points = Math.round((50 - t*40) / 5) * 5;
  const life   = (3.5 + Math.random()*5.5) * 1000;
  const ang    = Math.random()*Math.PI*2;
  const dist   = Math.random()*1600;
  return {
    id: 'b' + Math.floor(Math.random()*1e9),
    x: Math.cos(ang)*dist, y: Math.sin(ang)*dist,
    r, points, life, maxLife: life,
  };
}

// ── rooms ─────────────────────────────────────────────────────────────────────
const rooms = new Map();

class Room {
  constructor(id) {
    this.id    = id;
    this.conns = new Map();  // connId -> { ws, player }
    this.blobs = new Map();
    for (let i = 0; i < 18; i++) { const b = spawnBlob(); this.blobs.set(b.id, b); }
    this.timer = setInterval(() => this.tick(), 125);
  }

  add(id, ws) {
    const player = { id, name: 'Player', color: '#7fb2b8', x: 0, y: 0, r: 14, score: 0 };
    this.conns.set(id, { ws, player });
    this._send(ws, { t: 'welcome', id, blobs: [...this.blobs.values()] });
    this._broadcastPlayers();
    console.log(`[${this.id}] +${id}  (${this.conns.size} players)`);
  }

  message(id, raw) {
    let m; try { m = JSON.parse(raw); } catch { return; }
    const c = this.conns.get(id); if (!c) return;
    const p = c.player;
    if      (m.t === 'hello') { p.name = String(m.name || 'Player').slice(0, 12); p.color = m.color || p.color; }
    else if (m.t === 'state') { p.x = m.x; p.y = m.y; p.r = m.r; p.score = m.score; }
    else if (m.t === 'ate')   { this.blobs.delete(m.id); }
  }

  remove(id) {
    this.conns.delete(id);
    this._broadcastPlayers();
    console.log(`[${this.id}] -${id}  (${this.conns.size} players)`);
    if (this.conns.size === 0) { clearInterval(this.timer); rooms.delete(this.id); }
  }

  _send(ws, msg) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  _broadcastPlayers() {
    const list = [...this.conns.values()].map(c => c.player);
    this._broadcast({ t: 'players', list });
  }

  tick() {
    while (this.blobs.size < CAP && Math.random() < 0.6) {
      const b = spawnBlob(); this.blobs.set(b.id, b);
    }
    for (const [id, b] of this.blobs) { b.life -= 125; if (b.life <= 0) this.blobs.delete(id); }
    const blobMsg   = JSON.stringify({ t: 'blobs',   list: [...this.blobs.values()] });
    const playerMsg = JSON.stringify({ t: 'players', list: [...this.conns.values()].map(c => c.player) });
    for (const { ws } of this.conns.values()) {
      if (ws.readyState === WebSocket.OPEN) { ws.send(blobMsg); ws.send(playerMsg); }
    }
  }

  _broadcast(msg) {
    const data = JSON.stringify(msg);
    for (const { ws } of this.conns.values())
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
  }
}

// ── HTTP: serve index.html for every request ──────────────────────────────────
const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(HTML);
});

// ── WebSocket: /parties/main/:roomId ─────────────────────────────────────────
const wss = new WebSocketServer({ server });
let counter = 0;

wss.on('connection', (ws, req) => {
  const match = /\/parties\/main\/([^/?#]+)/.exec(req.url ?? '');
  if (!match) { ws.close(); return; }

  const roomId = decodeURIComponent(match[1]).toUpperCase();
  const id     = 'p' + (++counter);

  if (!rooms.has(roomId)) rooms.set(roomId, new Room(roomId));
  const room = rooms.get(roomId);
  room.add(id, ws);

  ws.on('message', raw  => room.message(id, raw.toString()));
  ws.on('close',   ()   => room.remove(id));
  ws.on('error',   ()   => ws.close());
});

// ── start ─────────────────────────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
  const lanIPs = Object.values(os.networkInterfaces())
    .flat()
    .filter(i => i.family === 'IPv4' && !i.internal)
    .map(i => i.address);

  console.log(`\n🟡  Blob Party — LAN server on port ${PORT}`);
  console.log(`    Local:  http://127.0.0.1:${PORT}`);
  for (const ip of lanIPs)
    console.log(`    LAN:    http://${ip}:${PORT}   ← share this with friends`);
  console.log('\n    Create a room in the Party panel, share the URL.\n');
});
