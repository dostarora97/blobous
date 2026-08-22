/**
 * Blob Party — Cloudflare Worker + Durable Objects
 *
 * Architecture:
 *   Worker (fetch)  → routes WebSocket upgrades to BlobRoom DO
 *                   → falls through to static assets (public/index.html)
 *   BlobRoom DO     → one instance per room code
 *                   → owns blob state authoritatively
 *                   → relays player circle state to all room members
 *                   → drives the game loop via alarm (~8 Hz)
 *
 * Free-tier safe:
 *   - SQLite-backed DO (new_sqlite_classes) required on Workers Free plan
 *   - Alarm stops when the room is empty → no idle compute charges
 *   - DO stays alive during play (active alarm prevents hibernation),
 *     so in-memory state is stable — no need to persist ephemeral game state
 *
 * Deploy: npx wrangler deploy
 */

import { DurableObject } from 'cloudflare:workers';

// ── Blob constants ─────────────────────────────────────────────────────────────

const BLOB_CAP    = 40;
const BLOB_R_MIN  = 5;
const BLOB_R_MAX  = 15;
const WORLD_DIST  = 1600;   // spawn radius from origin (matches client WORLD_HALF=2000)
const TICK_MS     = 125;    // 8 Hz game loop

// ── Blob factory ──────────────────────────────────────────────────────────────

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
  return {
    id:      crypto.randomUUID(),
    x:       Math.cos(ang) * dist,
    y:       Math.sin(ang) * dist,
    r, points, life, maxLife: life,
  };
}

// ── BlobRoom Durable Object ────────────────────────────────────────────────────

/**
 * One BlobRoom instance per room code (keyed by idFromName).
 *
 * In-memory state: players Map + blobs Map. Both are ephemeral — players
 * re-introduce themselves on reconnect, and blobs are re-seeded on cold start.
 * No SQLite writes needed for this game.
 *
 * WebSockets use the Hibernatable API (ctx.acceptWebSocket) so the runtime can
 * hibernate the DO between alarm ticks if needed. An active alarm every TICK_MS
 * effectively keeps the DO warm during play; we simply stop rescheduling when
 * the room empties so idle rooms don't consume compute.
 */
export class BlobRoom extends DurableObject {
  /** @type {Map<string, {id:string,name:string,color:string,x:number,y:number,r:number,score:number}>} */
  #players = new Map();
  /** @type {Map<string, object>} */
  #blobs   = new Map();

  constructor(ctx, env) {
    super(ctx, env);
    this.#seedBlobs(18);

    // Reconnect any players whose WebSockets survived a DO hibernation.
    // The alarm prevents hibernation during active play, but guard anyway.
    for (const ws of ctx.getWebSockets()) {
      const [pid] = ws.tags ?? [];
      if (pid && !this.#players.has(pid)) {
        this.#players.set(pid, this.#defaultPlayer(pid));
      }
    }
  }

  // ── Connection lifecycle ────────────────────────────────────────────────────

  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('WebSocket upgrade required', { status: 426 });
    }

    const [client, server] = Object.values(new WebSocketPair());
    const pid = crypto.randomUUID();

    // Tag the server-side socket with the player ID so we can identify it
    // after hibernation without an external Map lookup.
    this.ctx.acceptWebSocket(server, [pid]);

    const player = this.#defaultPlayer(pid);
    this.#players.set(pid, player);

    // Welcome message carries the current blob set so the client can start
    // rendering immediately without waiting for the first tick broadcast.
    server.send(JSON.stringify({ t: 'welcome', id: pid, blobs: [...this.#blobs.values()] }));
    this.#broadcastPlayers();

    await this.#ensureAlarm();

    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws, raw) {
    const [pid] = ws.tags ?? [];
    if (!pid) return;

    // Reconstruct a minimal player entry if we woke from hibernation and
    // the client sends state before we see it in getWebSockets (edge case).
    if (!this.#players.has(pid)) {
      this.#players.set(pid, this.#defaultPlayer(pid));
    }

    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    const player = this.#players.get(pid);

    switch (msg.t) {
      case 'hello':
        player.name  = String(msg.name  ?? 'Player').slice(0, 12);
        player.color = String(msg.color ?? player.color);
        break;
      case 'state':
        // Coerce to numbers — never trust client-sent values as-is
        player.x     = +msg.x     || 0;
        player.y     = +msg.y     || 0;
        player.r     = +msg.r     || 14;
        player.score = +msg.score || 0;
        break;
      case 'ate':
        // First client to claim a blob wins; harmless if already removed
        if (typeof msg.id === 'string') this.#blobs.delete(msg.id);
        break;
    }
  }

  webSocketClose(ws) {
    const [pid] = ws.tags ?? [];
    if (pid) this.#players.delete(pid);
    this.#broadcastPlayers();
  }

  webSocketError(ws) {
    this.webSocketClose(ws);
  }

  // ── Game tick ───────────────────────────────────────────────────────────────

  async alarm() {
    const sockets = this.ctx.getWebSockets();

    // Empty room: stop ticking. The next connect will restart the alarm.
    if (sockets.length === 0) return;

    // Advance blob simulation
    while (this.#blobs.size < BLOB_CAP && Math.random() < 0.6) {
      const b = spawnBlob();
      this.#blobs.set(b.id, b);
    }
    for (const [id, blob] of this.#blobs) {
      blob.life -= TICK_MS;
      if (blob.life <= 0) this.#blobs.delete(id);
    }

    // Serialize once, broadcast to all — avoids re-serializing per connection
    const blobMsg   = JSON.stringify({ t: 'blobs',   list: [...this.#blobs.values()] });
    const playerMsg = JSON.stringify({ t: 'players', list: [...this.#players.values()] });

    for (const ws of sockets) {
      try {
        ws.send(blobMsg);
        ws.send(playerMsg);
      } catch {
        // WebSocket already closed; webSocketClose will clean up the player entry
      }
    }

    await this.ctx.storage.setAlarm(Date.now() + TICK_MS);
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  /** @param {string} id */
  #defaultPlayer(id) {
    return { id, name: 'Player', color: '#7fb2b8', x: 0, y: 0, r: 14, score: 0 };
  }

  #seedBlobs(n) {
    for (let i = 0; i < n; i++) {
      const b = spawnBlob();
      this.#blobs.set(b.id, b);
    }
  }

  #broadcastPlayers() {
    const msg = JSON.stringify({ t: 'players', list: [...this.#players.values()] });
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(msg); } catch { /* client gone */ }
    }
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
   * @param {{ BLOB_ROOM: DurableObjectNamespace, ASSETS: Fetcher }} env
   */
  async fetch(request, env) {
    const url   = new URL(request.url);
    const match = /^\/parties\/main\/([^/?#]{1,16})/i.exec(url.pathname);

    if (match && request.headers.get('Upgrade') === 'websocket') {
      const roomId = decodeURIComponent(match[1]).toUpperCase();
      const stub   = env.BLOB_ROOM.get(env.BLOB_ROOM.idFromName(roomId));
      return stub.fetch(request);
    }

    return env.ASSETS.fetch(request);
  },
};
