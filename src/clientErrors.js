import express from 'express';
import mongoose from 'mongoose';

/*
  Client-side error capture — fire-and-forget, free-tier safe.

  Browsers POST (usually via navigator.sendBeacon) JS errors, unhandled
  promise rejections, and socket connect failures here so we can spot
  problems (e.g. WebSocket handshakes being blocked) BEFORE users email.

  Design guarantees (mirrors analytics.js — must NEVER affect gameplay):
   - Always responds 204 immediately; the DB write is not awaited and can't throw.
   - Writes only if Mongo is connected; otherwise silently drops.
   - Payload fields are size-capped; documents auto-expire via a TTL index, so
     the collection stays tiny on the free tier.
   - A cheap in-memory per-IP rate limit stops a single misbehaving client
     (or abuse) from flooding the collection.
*/

const COLLECTION = 'client_errors';
const TTL_DAYS = 30;

// ── cheap in-memory per-IP rate limit (single instance; resets on restart) ──
const RL_WINDOW_MS = 60 * 1000;
const RL_MAX = 30; // max error reports per IP per minute
const hits = new Map(); // ip -> { count, windowStart }

// prune stale entries so the map can't grow unbounded over time
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

export function ensureClientErrorIndexes() {
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
    const doc = {
      type: str(b.type, 40) || 'error',
      message: str(b.message, 500),
      stack: str(b.stack, 2000),
      source: str(b.source, 300),
      line: Number.isFinite(b.line) ? b.line : null,
      col: Number.isFinite(b.col) ? b.col : null,
      page: str(b.page, 300),
      extra: str(typeof b.extra === 'string' ? b.extra : JSON.stringify(b.extra ?? ''), 500),
      userAgent: str(req.headers['user-agent'], 400),
      ip,
      createdAt: new Date(),
    };
    if (!doc.message && !doc.stack) return; // nothing useful

    const conn = mongoose.connection;
    if (!conn || conn.readyState !== 1) return;
    conn.collection(COLLECTION).insertOne(doc).catch(() => {});
  } catch {
    /* never surface */
  }
});

export default router;
