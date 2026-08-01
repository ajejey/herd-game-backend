import express from 'express';
import mongoose from 'mongoose';

/*
  GET /api/game-stats — per-game player counts for the last 7 days.

  Powers the social-proof badges on game cards ("1,240 played this week"). Two
  sources, because the two kinds of game are instrumented differently:

   - daily_events    → solo + daily games send a completion ping with an anonId,
                       so we count DISTINCT anonIds (real people, not replays).
                       Higher or Lower is endless, so counting raw completions
                       would wildly overstate it — one player can finish 30 runs.
   - analytics_events → multiplayer games emit player_joined / game_created,
                        which is the closest thing we have to "people who played".

  Safety: this is a public, uncached-by-default read on a free tier, so it is
  memoised in-process for CACHE_MS and always degrades to {} rather than
  throwing. A failure here must never take down the homepage.
*/

const CACHE_MS = 10 * 60 * 1000; // 10 minutes is plenty — this is a vanity metric
const WINDOW_DAYS = 7;

// ── cheap in-memory per-IP rate limit (single instance; resets on restart) ──
const RL_WINDOW_MS = 60 * 1000;
const RL_MAX = 30; // a page load makes one call; 30/min is far above real use
const hits = new Map();

setInterval(() => {
  const cutoff = Date.now() - RL_WINDOW_MS;
  for (const [ip, rec] of hits) if (rec.windowStart < cutoff) hits.delete(ip);
}, 5 * 60 * 1000).unref();

function rateLimited(ip) {
  const now = Date.now();
  const rec = hits.get(ip);
  if (!rec || now - rec.windowStart > RL_WINDOW_MS) {
    hits.set(ip, { count: 1, windowStart: now });
    return false;
  }
  rec.count += 1;
  return rec.count > RL_MAX;
}

let cache = { at: 0, data: null };

/* In-flight request coalescing.

   Without this, the moment the cache expires EVERY concurrent request starts
   its own computeStats() — two aggregations each — and on a single-replica
   free-tier box a burst of homepage loads right after the cache tick fans out
   into N duplicate collection scans. Holding one shared promise means the
   stampede collapses to a single query no matter how many callers arrive. */
let inflight = null;

async function getStats() {
  if (cache.data && Date.now() - cache.at < CACHE_MS) return cache.data;
  if (inflight) return inflight;

  inflight = computeStats()
    .then((stats) => {
      cache = { at: Date.now(), data: stats };
      return stats;
    })
    // Serve the previous (stale) numbers rather than nothing if a refresh fails.
    .catch(() => cache.data || {})
    .finally(() => { inflight = null; });

  return inflight;
}

/* The instrumentation predates the frontend game registry, so a few ids differ.
   Anything not listed passes through unchanged. */
const ALIASES = {
  daily: 'daily-herd',
  herd: 'daily-herd',
  'daily-herd': 'daily-herd',
  trivia: 'daily-trivia',
  'daily-trivia': 'daily-trivia',
  connections: 'huddle',
  huddle: 'huddle',
  aura: 'daily-aura',
  'daily-aura': 'daily-aura',
  'hot-takes': 'daily-hot-takes',
  'daily-hot-takes': 'daily-hot-takes',
  'two-truths-and-a-lie': 'two-truths',
  twotruths: 'two-truths',
  wyr: 'would-you-rather',
  sa: 'say-anything',
  gt: 'guesstimate',
  teamtrivia: 'team-trivia',
};

/* Multiplayer games are logged under their Socket.IO namespace, which carries a
   leading slash ("/scattergories", "/sa"), while solo games log a bare id
   ("daily-herd"). Without stripping the slash first, every multiplayer game
   missed the alias table and its badge silently never rendered — Scattergories
   was sitting at 427 players/week and showing nothing. */
const normalise = (g) => {
  const key = String(g || '').replace(/^\/+/, '');
  return ALIASES[key] || key;
};

async function computeStats() {
  const conn = mongoose.connection;
  if (!conn || conn.readyState !== 1) return {};

  const since = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const out = {};

  // ── solo / daily: distinct players per game ──────────────────────────────
  try {
    const rows = await conn
      .collection('daily_events')
      .aggregate(
        [
          { $match: { createdAt: { $gte: since }, game: { $type: 'string' } } },
          { $group: { _id: { game: '$game', anon: '$anonId' } } },
          { $group: { _id: '$_id.game', players: { $sum: 1 } } },
        ],
        { allowDiskUse: false, maxTimeMS: 4000 },
      )
      .toArray();
    for (const r of rows) {
      const k = normalise(r._id);
      out[k] = (out[k] || 0) + r.players;
    }
  } catch {
    /* degrade silently */
  }

  // ── multiplayer: people who created or joined a room ─────────────────────
  try {
    const rows = await conn
      .collection('analytics_events')
      .aggregate(
        [
          {
            $match: {
              createdAt: { $gte: since },
              name: { $in: ['game_created', 'player_joined'] },
              game: { $type: 'string' },
            },
          },
          { $group: { _id: '$game', players: { $sum: 1 } } },
        ],
        { allowDiskUse: false, maxTimeMS: 4000 },
      )
      .toArray();
    for (const r of rows) {
      const k = normalise(r._id);
      out[k] = (out[k] || 0) + r.players;
    }
  } catch {
    /* degrade silently */
  }

  return out;
}

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    // Cheap per-IP limit, mirroring dailyEvents.js. A cached hit is nearly
    // free, but this stops one client hammering the endpoint from being able
    // to line up requests against every cache expiry.
    if (rateLimited((req.ip || '').toString())) {
      return res.status(429).json({ windowDays: WINDOW_DAYS, stats: cache.data || {} });
    }
    // Let the CDN/browser hold it too; the number does not need to be fresh.
    res.set('Cache-Control', 'public, max-age=600');
    const stats = await getStats();
    return res.json({ windowDays: WINDOW_DAYS, stats });
  } catch {
    return res.json({ windowDays: WINDOW_DAYS, stats: {} });
  }
});

export default router;
