import express from 'express';
import mongoose from 'mongoose';

/*
  Push device tokens.

  Collection: push_tokens { token, anonId, platform, tz, createdAt, updatedAt }

  Keyed on the token itself (unique) rather than anonId: one person can have the
  app on two devices, and FCM rotates tokens, so anonId is a label for grouping,
  not an identity. Stale tokens are pruned by the sender when FCM rejects them.
*/
const TOKENS = 'push_tokens';

function db() {
  const conn = mongoose.connection;
  if (!conn || conn.readyState !== 1) return null;
  return conn;
}

export async function ensurePushIndexes() {
  const conn = db();
  if (!conn) return;
  try {
    await conn.collection(TOKENS).createIndex({ token: 1 }, { unique: true });
    await conn.collection(TOKENS).createIndex({ anonId: 1 });
  } catch { /* best-effort */ }
}

const router = express.Router();

router.post('/register', async (req, res) => {
  const { token, anonId, platform, tz } = req.body || {};
  if (typeof token !== 'string' || token.length < 20 || token.length > 4096) {
    return res.status(400).json({ ok: false, error: 'bad token' });
  }
  const conn = db();
  if (!conn) return res.status(503).json({ ok: false, error: 'db unavailable' });

  try {
    const now = new Date();
    await conn.collection(TOKENS).updateOne(
      { token },
      {
        $set: {
          anonId: typeof anonId === 'string' ? anonId.slice(0, 64) : null,
          platform: typeof platform === 'string' ? platform.slice(0, 16) : null,
          tz: typeof tz === 'string' ? tz.slice(0, 64) : null,
          updatedAt: now,
        },
        $setOnInsert: { createdAt: now },
      },
      { upsert: true }
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'store failed' });
  }
});

router.post('/unregister', async (req, res) => {
  const { token } = req.body || {};
  if (typeof token !== 'string') return res.status(400).json({ ok: false });
  const conn = db();
  if (!conn) return res.status(503).json({ ok: false });
  try {
    await conn.collection(TOKENS).deleteOne({ token });
    res.json({ ok: true });
  } catch {
    res.status(500).json({ ok: false });
  }
});

// Small enough to be useful for a sanity check, no PII in the response.
router.get('/count', async (_req, res) => {
  const conn = db();
  if (!conn) return res.json({ count: 0 });
  try {
    res.json({ count: await conn.collection(TOKENS).countDocuments() });
  } catch {
    res.json({ count: 0 });
  }
});

export default router;
export { TOKENS };
