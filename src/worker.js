/**
 * Blob Party — Cloudflare Worker + Durable Objects
 *
 * DOs:
 *   RoomRegistry — single global instance; tracks valid room codes in SQLite
 *   BlobRoom     — one per room code; owns game state; requires MIN_PLAYERS to start
 *
 * HTTP API:
 *   POST /api/rooms/create        → { code }
 *   GET  /api/rooms/join/:code    → { ok } or { ok:false, error }
 *
 * WebSocket:
 *   /parties/main/:code           → routed to BlobRoom (rejected if code not in Registry)
 *
 * Deploy: npx wrangler deploy
 */

import { DurableObject } from 'cloudflare:workers';

// ── Shared constants ───────────────────────────────────────────────────────────

const BLOB_CAP        = 40;
const BLOB_R_MIN      = 5;
const BLOB_R_MAX      = 15;
const WORLD_DIST      = 1600;   // max blob spawn radius (matches client WORLD_HALF = 2000)
const TICK_MS         = 125;    // 8 Hz game loop
const MIN_PLAYERS     = 2;      // game doesn't start below this
const ROOM_TTL_MS     = 4 * 60 * 60 * 1000;  // rooms expire after 4 hours
const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous 0/O, 1/I

// ── Helpers ────────────────────────────────────────────────────────────────────

function spawnBlob() {
  const roll = Math.random();
  const r    = roll < 0.70 ? 11 + Math.random() * 4
             : roll < 0.92 ?  8 + Math.random() * 3
                            :  5 + Math.random() * 3;
  const t      = (r - BLOB_R_MIN) / (BLOB_R_MAX - BLOB_R_MIN);
  const points = Math.round((50 - t * 40) / 5) * 5;
  const life   = (3.5 + Math.random() * 5.5) * 1000;
  const ang    = Math.random() * Math.PI * 2;
  const dist   = Math.random() * WORLD_DIST;
  return { id: crypto.randomUUID(), x: Math.cos(ang) * dist, y: Math.sin(ang) * dist, r, points, life, maxLife: life };
}

/** Consistent JSON response with CORS header. */
function json(data, status = 200) {
  return Response.json(data, { status, headers: { 'Access-Control-Allow-Origin': '*' } });
}

// ── RoomRegistry Durable Object ───────────────────────────────────────────────

/**
 * Single global instance (idFromName('global')).
 * All room creation goes through here — clients can't self-create rooms by
 * guessing URL parameters. Rooms expire after ROOM_TTL_MS.
 */
export class RoomRegistry extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS rooms (
          code       TEXT    PRIMARY KEY,
          created_at INTEGER NOT NULL
        )
      `);
    });
  }

  /** Create a new unique room, persist it, return the 4-char code. */
  createRoom() {
    this.#purgeExpired();
    const code = this.#uniqueCode();
    this.ctx.storage.sql.exec(
      `INSERT INTO rooms (code, created_at) VALUES (?, ?)`,
      code, Date.now()
    );
    return code;
  }

  /** Returns true if the code exists and has not expired. */
  roomExists(code) {
    const rows = this.ctx.storage.sql.exec(
      `SELECT 1 FROM rooms WHERE code = ? AND created_at > ?`,
      code, Date.now() - ROOM_TTL_MS
    ).toArray();
    return rows.length > 0;
  }

  #purgeExpired() {
    this.ctx.storage.sql.exec(
      `DELETE FROM rooms WHERE created_at <= ?`,
      Date.now() - ROOM_TTL_MS
    );
  }

  #uniqueCode() {
    for (let attempt = 0; attempt < 100; attempt++) {
      const code = Array.from(
        { length: 4 },
        () => ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)]
      ).join('');
      const taken = this.ctx.storage.sql.exec(
        `SELECT 1 FROM rooms WHERE code = ?`, code
      ).toArray().length > 0;
      if (!taken) return code;
    }
    throw new Error('Could not generate a unique room code — try again');
  }
}

// ── BlobRoom Durable Object ────────────────────────────────────────────────────

/**
 * One instance per room code (keyed by idFromName(code)).
 *
 * Game loop (alarm) only runs when >= MIN_PLAYERS are connected.
 * Broadcasts { t:'status', state:'waiting'|'playing', count } on every player
 * join/leave so clients can show the waiting screen or resume the game.
 */
export class BlobRoom extends DurableObject {
  #players = new Map();  // playerId → player state
  #blobs   = new Map();  // blobId   → blob

  constructor(ctx, env) {
    super(ctx, env);
    this.#seedBlobs(18);
    // Reconnect any players whose WebSockets survived a (rare) DO hibernation.
    // The active alarm prevents hibernation during play; this is a safety net.
    for (const ws of ctx.getWebSockets()) {
      const [pid] = ws.tags ?? [];
      if (pid && !this.#players.has(pid)) {
        this.#players.set(pid, this.#defaultPlayer(pid));
      }
    }
  }

  // ── Connection lifecycle ──────────────────────────────────────────────────

  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('WebSocket upgrade required', { status: 426 });
    }

    const [client, server] = Object.values(new WebSocketPair());
    const pid = crypto.randomUUID();

    this.ctx.acceptWebSocket(server, [pid]);
    this.#players.set(pid, this.#defaultPlayer(pid));

    server.send(JSON.stringify({ t: 'welcome', id: pid, blobs: [...this.#blobs.values()] }));

    // Broadcast updated status to all connected clients (including new player)
    await this.#broadcastStatus();

    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws, raw) {
    const [pid] = ws.tags ?? [];
    if (!pid) return;

    // Lazy-reconstruct after a rare hibernation wake
    if (!this.#players.has(pid)) this.#players.set(pid, this.#defaultPlayer(pid));

    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    const player = this.#players.get(pid);
    switch (msg.t) {
      case 'hello':
        player.name  = String(msg.name  ?? 'Player').slice(0, 12);
        player.color = String(msg.color ?? player.color);
        break;
      case 'state':
        // Coerce to numbers; never trust client values as-is
        player.x     = +msg.x     || 0;
        player.y     = +msg.y     || 0;
        player.r     = +msg.r     || 14;
        player.score = +msg.score || 0;
        break;
      case 'ate':
        if (typeof msg.id === 'string') this.#blobs.delete(msg.id);
        break;
    }
  }

  async webSocketClose(ws) {
    const [pid] = ws.tags ?? [];
    if (pid) this.#players.delete(pid);
    this.#broadcastPlayers();
    await this.#broadcastStatus(); // may pause game if count drops below MIN_PLAYERS
  }

  webSocketError(ws) { this.webSocketClose(ws); }

  // ── Game tick ─────────────────────────────────────────────────────────────

  async alarm() {
    const sockets = this.ctx.getWebSockets();
    if (sockets.length === 0) return;              // room empty, expire alarm
    if (this.#players.size < MIN_PLAYERS) return;  // not enough players; don't reschedule

    // Advance blob simulation
    while (this.#blobs.size < BLOB_CAP && Math.random() < 0.6) {
      const b = spawnBlob();
      this.#blobs.set(b.id, b);
    }
    for (const [id, blob] of this.#blobs) {
      blob.life -= TICK_MS;
      if (blob.life <= 0) this.#blobs.delete(id);
    }

    // Serialize once, broadcast to all — avoids repeated JSON.stringify
    const blobMsg   = JSON.stringify({ t: 'blobs',   list: [...this.#blobs.values()] });
    const playerMsg = JSON.stringify({ t: 'players', list: [...this.#players.values()] });
    for (const ws of sockets) {
      try { ws.send(blobMsg); ws.send(playerMsg); } catch { /* client gone */ }
    }

    await this.ctx.storage.setAlarm(Date.now() + TICK_MS);
  }

  // ── Private ───────────────────────────────────────────────────────────────

  #defaultPlayer(id) {
    return { id, name: 'Player', color: '#7fb2b8', x: 0, y: 0, r: 14, score: 0 };
  }

  #seedBlobs(n) {
    for (let i = 0; i < n; i++) { const b = spawnBlob(); this.#blobs.set(b.id, b); }
  }

  #broadcastPlayers() {
    const msg = JSON.stringify({ t: 'players', list: [...this.#players.values()] });
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(msg); } catch {}
    }
  }

  async #broadcastStatus() {
    const count = this.#players.size;
    const state = count >= MIN_PLAYERS ? 'playing' : 'waiting';
    const msg   = JSON.stringify({ t: 'status', state, count });
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(msg); } catch {}
    }
    // (Re-)start the alarm when we just crossed the player threshold
    if (state === 'playing') await this.#ensureAlarm();
  }

  async #ensureAlarm() {
    if (await this.ctx.storage.getAlarm() === null) {
      await this.ctx.storage.setAlarm(Date.now() + TICK_MS);
    }
  }
}

// ── Worker entry point ─────────────────────────────────────────────────────────

export default {
  /**
   * @param {Request} request
   * @param {{ BLOB_ROOM: DurableObjectNamespace, ROOM_REGISTRY: DurableObjectNamespace, ASSETS: Fetcher }} env
   */
  async fetch(request, env) {
    const url    = new URL(request.url);
    const path   = url.pathname;
    const method = request.method;

    // Helper: always use the single global registry instance
    const registry = () => env.ROOM_REGISTRY.get(env.ROOM_REGISTRY.idFromName('global'));

    // ── POST /api/rooms/create ──────────────────────────────────────────────
    if (path === '/api/rooms/create' && method === 'POST') {
      try {
        const code = await registry().createRoom();
        return json({ code });
      } catch (err) {
        return json({ error: String(err.message) }, 500);
      }
    }

    // ── GET /api/rooms/join/:code ───────────────────────────────────────────
    const joinMatch = /^\/api\/rooms\/join\/([A-Z2-9]{1,16})$/i.exec(path);
    if (joinMatch && method === 'GET') {
      const code   = joinMatch[1].toUpperCase();
      const exists = await registry().roomExists(code);
      if (!exists) return json({ ok: false, error: 'Room not found or expired' }, 404);
      return json({ ok: true });
    }

    // ── WebSocket upgrade: /parties/main/:code ──────────────────────────────
    const wsMatch = /^\/parties\/main\/([^/?#]{1,16})/i.exec(path);
    if (wsMatch && request.headers.get('Upgrade') === 'websocket') {
      const code   = decodeURIComponent(wsMatch[1]).toUpperCase();
      const exists = await registry().roomExists(code);

      if (!exists) {
        // Accept the WS to send a clean error message, then close
        const [client, server] = Object.values(new WebSocketPair());
        server.accept();
        server.send(JSON.stringify({ t: 'error', message: 'Room not found or expired' }));
        server.close(4404, 'Room not found');
        return new Response(null, { status: 101, webSocket: client });
      }

      return env.BLOB_ROOM.get(env.BLOB_ROOM.idFromName(code)).fetch(request);
    }

    // ── Static assets (public/index.html etc.) ──────────────────────────────
    return env.ASSETS.fetch(request);
  },
};
