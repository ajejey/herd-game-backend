import express from 'express';
import mongoose from 'mongoose';

/*
  Daily-game completion events — fire-and-forget, free-tier safe.

  The daily solo games (Daily Herd, Daily Trivia, Huddle) run entirely in the
  browser, so the server otherwise only sees page views, not real completions.
  Clients POST (via navigator.sendBeacon) a tiny "complete" event here so we can
  report true plays-per-day per game and track the daily-habit flywheel.

  Design guarantees (mirrors clientErrors.js — must NEVER affect gameplay):
   - Always responds 204 immediately; the DB write is not awaited and can't throw.
   - Writes only if Mongo is connected; otherwise silently drops.
   - Fields are size/shape-capped; documents auto-expire via a TTL index.
   - A cheap in-memory per-IP rate limit caps abuse.
*/

const COLLECTION = 'daily_events';
const TTL_DAYS = 120; // keep ~4 months of daily history for trend reporting

// ── cheap in-memory per-IP rate limit (single instance; resets on restart) ──
const RL_WINDOW_MS = 60 * 1000;
const RL_MAX = 60; // generous: a user may finish several daily games in a minute
const hits = new Map(); // ip -> { count, windowStart }

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

const str = (v, max) => (v == null ? '' : String(v).slice(0, max));
const num = (v) => (Number.isFinite(v) ? v : null);

export function ensureDailyEventIndexes() {
  try {
    const conn = mongoose.connection;
    if (!conn || conn.readyState !== 1) return;
    conn
      .collection(COLLECTION)
      .createIndex({ createdAt: 1 }, { expireAfterSeconds: TTL_DAYS * 24 * 60 * 60 })
      .catch(() => {});
  } catch {
    /* no-op */
  }
}

const router = express.Router();

router.post('/', (req, res) => {
  // Respond first — the client never waits on us, and nothing here can break a game.
  res.status(204).end();
  try {
    const ip = (req.ip || '').toString();
    if (rateLimited(ip)) return;

    const b = req.body || {};
    const game = str(b.game, 40);
    if (!game) return; // nothing useful

    const doc = {
      game,
      event: str(b.event, 40) || 'complete',
      day: num(b.day),
      score: num(b.score),
      total: num(b.total),
      won: typeof b.won === 'boolean' ? b.won : null,
      anonId: str(b.anonId, 60),
      ip,
      createdAt: new Date(),
    };

    const conn = mongoose.connection;
    if (!conn || conn.readyState !== 1) return;
    conn.collection(COLLECTION).insertOne(doc).catch(() => {});
  } catch {
    /* never surface */
  }
});

export default router;
