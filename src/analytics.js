import mongoose from 'mongoose';

/*
  Lightweight, fire-and-forget product analytics.

  Design guarantees (so it can NEVER affect gameplay):
   - Never awaited by callers, never throws.
   - Writes only if Mongo is already connected; otherwise silently skips.
   - The insert promise's rejection is swallowed.
   - Game state lives in-memory (engine/store.js); these writes are off the
     critical path — a slow or down DB cannot add latency or crash a game.

  Events auto-expire via a TTL index (see ensureAnalyticsIndexes), so the
  collection stays tiny on the free tier.
*/

const COLLECTION = 'analytics_events';
const TTL_DAYS = 180;

export function logEvent(name, fields = {}) {
  try {
    const conn = mongoose.connection;
    if (!conn || conn.readyState !== 1) return; // 1 = connected
    conn
      .collection(COLLECTION)
      .insertOne({ name, ...fields, createdAt: new Date() })
      .catch(() => {}); // swallow — analytics must never surface errors
  } catch {
    /* never affect the caller */
  }
}

// Create the TTL index once on startup (fire-and-forget).
export function ensureAnalyticsIndexes() {
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
