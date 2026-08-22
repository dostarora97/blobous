# Blob Party

A small browser game: you're a circle that flies by "stretching" a locked mouse pointer, eats
yellow blobs to grow (bigger = slower), and overlaps other circles to drain their size. Multiplayer
runs on [PartyKit](https://www.partykit.io/).

- **The bigger you get, the slower you move.** Eating grows you.
- **Blobs** inside your circle get drained; leave before one is finished and it resets — no partial credit.
- **PvP:** overlap a *smaller* circle to steal its size; avoid *bigger* ones.
- **Points** buy a single upgrade: **Drain** (eat blobs and drain circles faster).

---

## Controls

| Action | Key |
|---|---|
| Enter / leave pointer-lock flight mode | **Esc** (or **L**) |
| Steer | Move the mouse — stretch further from center = faster (up to a cap) |
| Buy the **Drain** upgrade | **Spacebar** |
| Restart your run | **R** |

In flight mode your real cursor is hidden and locked; you fly by pushing the "velocity line" out of
your circle. Press **Esc** to get your normal mouse back at any time.

> Note: while the pointer is truly locked, the browser reserves **Esc** to release it — that's a
> built-in safety rule you can't override. So Esc enters lock from normal mode, and Esc leaves it
> from flight mode. That's the toggle.

---

## 1) Just play right now (offline, no setup)

Open **`public/index.html`** in your browser (double-click it). You'll play against **bots** that
stand in for other players. Everything works except real networking. Great for trying it solo.

> Chrome/Edge/Firefox all work. Pointer lock and emoji effects behave best in a normal browser tab
> (not inside an embedded preview).

---

## 2) Play online with friends — the fast path (recommended)

This deploys the game to a free PartyKit URL that works **anywhere** (not just your WiFi). ~5 minutes.

### Step 1 — Install Node.js (once)
Download the LTS installer from <https://nodejs.org> and install it. Verify in a terminal:
```bash
node --version    # should print v18 or newer
```

### Step 2 — Open a terminal in this folder
```bash
cd path/to/blob-party
npm install
```

### Step 3 — Deploy
```bash
npx partykit deploy
```
The first time, it asks you to log in (GitHub). When it finishes it prints a URL like:
```
https://blob-party.YOUR-USERNAME.partykit.dev
```

### Step 4 — Everyone opens that URL
1. You (the host) open the URL in your browser.
2. In the **Party** panel (top-left), click **Create room**. A code appears and the page URL becomes
   something like `…partykit.dev/#room=ABCD`.
3. **Copy that full URL and send it to your friends.** When they open it, they auto-join the same
   room. (Or they can type the same code into **room code** and click **Join**.)
4. Play. You'll see each other's circles, names, and scores; the leaderboard is up top.

That's it — no code editing. The game auto-detects that it's being served by PartyKit and connects
back to it automatically.

To update the game later (after edits), just run `npx partykit deploy` again.

---

## 3) Play on your local WiFi (no deploy)

Good if you're all in the same room and don't want to deploy. Runs a dev server on your machine.

### Step 1 — Start the dev server (host machine)
```bash
cd path/to/blob-party
npm install
npx partykit dev
```
It prints something like `Ready on http://127.0.0.1:1999`.

### Step 2 — Find your computer's LAN IP (host machine)
- **macOS:** `ipconfig getifaddr en0`   (or check System Settings → Network)
- **Windows:** `ipconfig`  → look for "IPv4 Address" (e.g. `192.168.1.42`)
- **Linux:** `hostname -I`  → first address

### Step 3 — Everyone opens the host's address
On each device **on the same WiFi**, open:
```
http://YOUR-LAN-IP:1999          e.g.  http://192.168.1.42:1999
```
Then **Create room** on the host, share the resulting `…:1999/#room=CODE` URL (or the code), and
friends **Join**.

### If friends can't connect
- Make sure everyone is on the **same WiFi network** (not a guest network that isolates devices).
- Allow the connection through the host's **firewall** (macOS/Windows may prompt the first time; say
  allow). Windows: allow Node.js through Windows Defender Firewall for private networks.
- Some routers block device-to-device traffic ("AP isolation"/"client isolation"); if so, use the
  deploy path in section 2 instead — it always works.
- If a device is on a "secure" origin and refuses the plain `ws://` connection, use section 2
  (deployed URLs are `https`/`wss` and never have this problem).

---

## Project layout

```
blob-party/
├─ README.md
├─ package.json         # scripts: npm run dev / npm run deploy
├─ partykit.json        # PartyKit config (serves public/ + runs src/server.js)
├─ public/
│  └─ index.html        # the whole game (client) — open this directly for offline play
└─ src/
   └─ server.js         # PartyKit room server (authoritative blobs + player relay)
```

## Tuning (optional)

Open `public/index.html` and search near the top of the `<script>`:

- `SPEED_BASE`, `SPEED_EXP` — how fast you are, and how hard growing slows you down.
- `EAT_GROWTH` — how quickly eating fattens you.
- `PASSIVE_DECAY` — slow slimming so nobody stays huge forever.
- `STEAL_RATE`, `GROW_EFF` — PvP size-stealing strength.
- `CAP`, blob spawn interval and rarity — how thickly blobs appear (also mirrored in `src/server.js`
  for online play).

## How multiplayer works (in one paragraph)

The server owns the blobs and relays each player's circle (position, size, score) to everyone ~8×/sec.
Each client is authoritative over its **own** circle: it grows itself when it eats, and in PvP it only
ever changes its **own** size (shrinking when overlapped by someone bigger, growing when it's the
bigger one), so both machines reach the same result without a referee. This is intentionally simple —
great for friends, not tournament-grade. If you want it stricter, move eating and PvP resolution into
`src/server.js` and have clients render server-authoritative state.

Have fun. 🟡
