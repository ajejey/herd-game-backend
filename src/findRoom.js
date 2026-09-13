import express from 'express';
import { lookupRoom, CODE } from './roomLookup.js';

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

/*
  A code lookup is cheap but enumerable, so cap it. Generous enough that a
  household or an office behind one NAT address never notices — a person makes
  one of these per invite, not per keystroke, because the client debounces.

  This stayed here rather than moving into roomLookup.js with the rest: the
  socket join paths are already rate-limited by having to hold a connection,
  and per-IP throttling is a property of the public HTTP surface, not of the
  question being asked.
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

router.get('/:code', async (req, res) => {
  try {
    if (rateLimited((req.ip || '').toString())) return res.status(429).json({ error: 'slow_down' });

    const code = String(req.params.code || '').trim().toUpperCase();
    if (!CODE.test(code)) return res.status(400).json({ error: 'bad_code' });

    /*
      The three-store lookup moved to roomLookup.js so the socket join paths
      could use it too — see the note there. This route is now one of three
      callers rather than the only one, and there is a single implementation
      to keep correct.
    */
    const found = await lookupRoom(code);
    if (found) {
      return res.json({
        code: found.code, game: found.game, path: found.path,
        live: found.live, ...(found.direct ? { direct: true } : {}),
      });
    }

    return res.status(404).json({ error: 'not_found' });
  } catch (err) {
    console.error('find room error:', err);
    return res.status(500).json({ error: 'server_error' });
  }
});

export default router;
