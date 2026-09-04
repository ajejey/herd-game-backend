import express from 'express';
import mongoose from 'mongoose';
import * as store from './engine/store.js';
import { describeGame } from './engine/gameDirectory.js';

/*
  "I have a code, where do I put it?"

  Search logging for Sep 2026 turned up something nobody had thought to look
  for: 27% of everything typed into the game search box was a ROOM CODE. Not a
  game name, not a category — a code. QCGJ, THBZ, LNQP, HRAL and 3QB19F were
  checked against the database and every one was a live room at the time it was
  typed. Those people had been sent a code by a friend, could not find the box
  it goes in, typed it into the only box on the page that looked like a search,
  and were told there were no results.

  That is the worst possible dead end. They were not browsing. They were not
  undecided. They were one field away from playing a game with people who were
  already waiting for them, and the site said "nothing found".

  The engine has known which game a code belongs to since the wrong-game fix —
  every room records its namespace, and gameDirectory turns that into a name
  and a public path. All that was missing was a way to ask from outside a
  socket connection. That is this file.

  ── Where a code can be ─────────────────────────────────────────────────────
  Three places, checked in this order, because they age differently:

    1. The live in-memory store. Authoritative and instant. A room made ten
       seconds ago is here and nowhere else — persistence is debounced, so
       looking only at Mongo would fail exactly for the freshest rooms, which
       are the ones people are being invited to right now.
    2. game_rooms, the snapshot. Covers a room that outlived a restart.
    3. games, the legacy Herd collection, which predates the engine and lives
       at /game/CODE rather than a namespace.

  ── What it deliberately does not do ────────────────────────────────────────
  It does not say whether the game has started, who is in it, or anything about
  its contents. The answer is a game name and a path, which is exactly what the
  person needs and nothing they could not have got by trying each game in turn.
  Enumerating codes gets a 404 the same as a typo does, and codes are short, so
  the endpoint is rate-limited per IP.
*/

const router = express.Router();

/* Codes are 4-6 of [A-Z0-9]; anything else is not worth a database round trip. */
const CODE = /^[A-Z0-9]{4,6}$/;

/*
  A code lookup is cheap but enumerable, so cap it. Generous enough that a
  household or an office behind one NAT address never notices — a person makes
  one of these per invite, not per keystroke, because the client debounces.
*/
const HITS = new Map();
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 40;

function rateLimited(key) {
  const now = Date.now();
  const rec = HITS.get(key);
  if (!rec || now - rec.start > WINDOW_MS) { HITS.set(key, { start: now, n: 1 }); return false; }
  rec.n += 1;
  return rec.n > MAX_PER_WINDOW;
}

/* Unbounded Maps are how a small feature becomes a memory leak on a long-lived
   single replica. Sweep expired buckets rather than letting them accumulate. */
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of HITS) if (now - v.start > WINDOW_MS) HITS.delete(k);
}, WINDOW_MS).unref?.();

const db = () => (mongoose.connection?.readyState === 1 ? mongoose.connection : null);

router.get('/:code', async (req, res) => {
  try {
    if (rateLimited((req.ip || '').toString())) return res.status(429).json({ error: 'slow_down' });

    const code = String(req.params.code || '').trim().toUpperCase();
    if (!CODE.test(code)) return res.status(400).json({ error: 'bad_code' });

    /* 1. Live rooms. state.game is the namespace, set at creation. */
    for (const [roomCode, state] of store.allGames()) {
      if (roomCode !== code) continue;
      const dest = describeGame(state?.game);
      if (dest) return res.json({ code, game: dest.name, path: dest.path, live: true });
    }

    const conn = db();
    if (!conn) return res.status(404).json({ error: 'not_found' });

    /* 2. A room that survived a restart. */
    const snap = await conn.collection('game_rooms').findOne({ roomCode: code });
    if (snap?.namespace) {
      const dest = describeGame(snap.namespace);
      if (dest) return res.json({ code, game: dest.name, path: dest.path, live: false });
    }

    /*
      3. The original Herd game. It has no namespace because it predates the
         engine, and its room lives at /game/CODE rather than /<game>/room/CODE
         — so the path is built differently on purpose, not by oversight.
    */
    const legacy = await conn.collection('games').findOne({ roomCode: code });
    if (legacy) {
      return res.json({ code, game: 'Herd Mentality', path: `/game/${code}`, live: false, direct: true });
    }

    return res.status(404).json({ error: 'not_found' });
  } catch (err) {
    console.error('find room error:', err);
    return res.status(500).json({ error: 'server_error' });
  }
});

export default router;
