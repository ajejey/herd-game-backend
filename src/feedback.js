import express from 'express';
import mongoose from 'mongoose';

/*
  User-submitted problem reports.

  Separate from client_errors on purpose. Those are machine-generated, noisy and
  TTL'd away after 30 days. These are a human taking the trouble to tell us
  something — in this niche almost nobody does, so each one is worth keeping and
  worth reading. No TTL.

  Why it exists at all: players who hit a problem do not write in, they leave.
  On Play they do something worse — they leave a one-star review, which is
  permanent, public, and drives installs down. A report button converts silent
  churn into a signal, and it keeps the complaint out of the review section.
  Google permits and encourages exactly this; the only thing prohibited is
  routing users to a store review based on their sentiment.

  Same safety guarantees as clientErrors.js: never blocks, never throws, capped
  fields, per-IP rate limit.
*/

const COLLECTION = 'user_feedback';

const RL_WINDOW_MS = 60 * 1000;
const RL_MAX = 5; // a human cannot legitimately file more than this per minute
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

const str = (v, max) => (v == null ? '' : String(v).slice(0, max));

export function ensureFeedbackIndexes() {
  try {
    const conn = mongoose.connection;
    if (!conn || conn.readyState !== 1) return;
    conn.collection(COLLECTION).createIndex({ createdAt: -1 }).catch(() => {});
    conn.collection(COLLECTION).createIndex({ handled: 1, createdAt: -1 }).catch(() => {});
  } catch {
    /* no-op */
  }
}

const router = express.Router();

router.post('/', async (req, res) => {
  // Answer before doing any work: the user is watching a spinner.
  const ip = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').toString().split(',')[0].trim();
  if (rateLimited(ip)) return res.status(429).json({ ok: false });

  const b = req.body || {};
  const message = str(b.message, 2000).trim();
  if (message.length < 3) return res.status(400).json({ ok: false, error: 'empty' });

  res.json({ ok: true });

  try {
    const conn = mongoose.connection;
    if (!conn || conn.readyState !== 1) return;
    conn
      .collection(COLLECTION)
      .insertOne({
        message,
        email: str(b.email, 200).trim(),      // optional; only if they want a reply
        page: str(b.page, 300),
        game: str(b.game, 60),
        roomCode: str(b.roomCode, 12),
        platform: str(b.platform, 20),        // 'android' | 'web'
        appVersion: str(b.appVersion, 20),
        userAgent: str(req.headers['user-agent'], 300),
        // Recent console errors the client already captured — this is what turns
        // "it didn't work" into something actionable without a back-and-forth.
        recentErrors: Array.isArray(b.recentErrors)
          ? b.recentErrors.slice(0, 5).map((e) => str(e, 300))
          : [],
        handled: false,
        createdAt: new Date(),
      })
      .catch(() => {});
  } catch {
    /* never let feedback break anything */
  }
});

export default router;
export { COLLECTION as FEEDBACK_COLLECTION };
