// Blob Party — PartyKit server.
// Authoritative for blobs; relays player circles. The static game (public/index.html)
// is served from the same host, so the browser connects back to its own origin
// at  /parties/main/:roomId  (no config needed on the client).
//
// Protocol (matches public/index.html):
//   client -> { t:'hello', name, color }
//            { t:'state', x, y, r, score }
//            { t:'ate',   id }
//   server -> { t:'welcome', id, blobs }
//            { t:'players', list:[{id,name,color,x,y,r,score}] }
//            { t:'blobs',   list:[{id,x,y,r,points,life,maxLife}] }

const CAP = 40;                 // max blobs alive in a room
const R_MIN = 5, R_MAX = 15;

function spawnBlob() {
  const roll = Math.random();
  const r = roll < 0.70 ? 11 + Math.random()*4 : roll < 0.92 ? 8 + Math.random()*3 : 5 + Math.random()*3;
  const t = (r - R_MIN) / (R_MAX - R_MIN);
  const points = Math.round((50 - t*40)/5)*5;
  const life = (3.5 + Math.random()*5.5) * 1000;
  const ang = Math.random()*Math.PI*2, dist = Math.random()*1600;
  return { id: 'b'+Math.floor(Math.random()*1e9), x: Math.cos(ang)*dist, y: Math.sin(ang)*dist, r, points, life, maxLife: life };
}

export default class BlobRoom {
  constructor(room) {
    this.room = room;
    this.players = new Map();     // connection id -> player state
    this.blobs = new Map();       // id -> blob
    for (let i = 0; i < 18; i++) { const b = spawnBlob(); this.blobs.set(b.id, b); }
    this.timer = setInterval(() => this.tick(), 125);   // ~8 world updates / sec
  }

  onConnect(conn) {
    this.players.set(conn.id, { id: conn.id, name: 'Player', color: '#7fb2b8', x: 0, y: 0, r: 14, score: 0 });
    conn.send(JSON.stringify({ t: 'welcome', id: conn.id, blobs: [...this.blobs.values()] }));
    this.broadcastPlayers();
  }

  onMessage(raw, conn) {
    let m; try { m = JSON.parse(raw); } catch { return; }
    const p = this.players.get(conn.id); if (!p) return;
    if (m.t === 'hello') { p.name = String(m.name || 'Player').slice(0, 12); p.color = m.color || p.color; }
    else if (m.t === 'state') { p.x = m.x; p.y = m.y; p.r = m.r; p.score = m.score; }
    else if (m.t === 'ate') { this.blobs.delete(m.id); }   // first client to claim a blob removes it
  }

  onClose(conn) { this.players.delete(conn.id); this.broadcastPlayers(); }

  broadcastPlayers() {
    this.room.broadcast(JSON.stringify({ t: 'players', list: [...this.players.values()] }));
  }

  tick() {
    while (this.blobs.size < CAP && Math.random() < 0.6) { const b = spawnBlob(); this.blobs.set(b.id, b); }
    for (const [id, b] of this.blobs) { b.life -= 125; if (b.life <= 0) this.blobs.delete(id); }
    this.room.broadcast(JSON.stringify({ t: 'blobs', list: [...this.blobs.values()] }));
    this.broadcastPlayers();
  }
}
