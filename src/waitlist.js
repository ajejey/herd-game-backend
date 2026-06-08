import express from 'express';
import mongoose from 'mongoose';

/*
  Corporate "Teams Plus" waitlist — captures interest in a weekly game
  auto-posted to Slack/Teams. This is the willingness-to-pay probe (Gate 2 in
  CORPORATE_STRATEGY.md): work-email signups become the first concierge leads.

  Stored leads are NOT TTL'd (unlike analytics) — we want to keep them. Kept
  tiny and off the realtime path: validate + dedupe by email, respond fast.
*/
const COLLECTION = 'waitlist';

// cheap per-IP rate limit (single instance)
const RL_WINDOW_MS = 60 * 1000;
const RL_MAX = 10;
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const rec = hits.get(ip);
  if (!rec || now - rec.windowStart > RL_WINDOW_MS) { hits.set(ip, { count: 1, windowStart: now }); return false; }
  rec.count += 1;
  return rec.count > RL_MAX;
}

const str = (v, max) => (v == null ? '' : String(v).slice(0, max)).trim();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function ensureWaitlistIndexes() {
  try {
    const conn = mongoose.connection;
    if (!conn || conn.readyState !== 1) return;
    await conn.collection(COLLECTION).createIndex({ email: 1 }, { unique: true });
  } catch { /* best-effort */ }
}

const router = express.Router();

router.post('/', async (req, res) => {
  try {
    const ip = (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim();
    if (rateLimited(ip)) return res.status(429).json({ error: 'rate_limited' });

    const b = req.body || {};
    const email = str(b.email, 120).toLowerCase();
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'invalid_email' });

    const doc = {
      email,
      company: str(b.company, 120),
      tool: str(b.tool, 20),        // slack | teams | other
      source: str(b.source, 120),   // which page they signed up from
      createdAt: new Date(),
    };

    const conn = mongoose.connection;
    if (!conn || conn.readyState !== 1) return res.status(503).json({ error: 'unavailable' });
    try {
      await conn.collection(COLLECTION).insertOne(doc);
    } catch (err) {
      if (err && err.code === 11000) return res.json({ ok: true, already: true }); // already on the list
      throw err;
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'failed' });
  }
});

export default router;
