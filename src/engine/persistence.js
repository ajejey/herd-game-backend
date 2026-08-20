import mongoose from 'mongoose';

/*
  Room snapshot persistence — lets live multiplayer rooms SURVIVE a server
  restart / redeploy / crash. Without this, every deploy (and Railway redeploys
  on every push) wipes all in-memory rooms and players get "room not found".

  Design (so it can NEVER add latency or crash a game):
   - Snapshots are written FIRE-AND-FORGET (never awaited) and DEBOUNCED per room
     (~2s trailing) so a fast game doesn't hammer Mongo.
   - Restore happens only on a cache MISS during rejoin (rare — basically once
     per room after a restart), and is the only awaited DB call.
   - All wrapped in try/catch; if Mongo is down, rooms simply aren't persisted —
     gameplay is unaffected.
   - Snapshots auto-expire via a TTL index, so the collection stays tiny.
*/
const COLLECTION = 'game_rooms';
const TTL_SECONDS = 3 * 60 * 60; // 3 hours
const DEBOUNCE_MS = 2000;

const timers = new Map(); // roomCode -> debounce handle

function db() {
  const conn = mongoose.connection;
  return conn && conn.readyState === 1 ? conn : null;
}

export function ensureRoomIndexes() {
  try {
    const conn = db();
    if (!conn) return;
    conn.collection(COLLECTION).createIndex({ updatedAt: 1 }, { expireAfterSeconds: TTL_SECONDS }).catch(() => {});
    conn.collection(COLLECTION).createIndex({ roomCode: 1 }, { unique: true }).catch(() => {});
  } catch { /* no-op */ }
}

// Debounced, fire-and-forget snapshot. namespace lets the same room code coexist
// across games (unlikely, but safe).
export function snapshotRoom(namespace, roomCode, state, tokenEntries) {
  try {
    const key = namespace + ':' + roomCode;
    if (timers.has(key)) clearTimeout(timers.get(key));
    const handle = setTimeout(() => {
      timers.delete(key);
      try {
        const conn = db();
        if (!conn) return;
        // strip volatile socketIds — they're meaningless after a restart
        const safeState = sanitize(state);
        conn.collection(COLLECTION).updateOne(
          { roomCode },
          { $set: { roomCode, namespace, state: safeState, tokens: tokenEntries || [], updatedAt: new Date() } },
          { upsert: true }
        ).catch(() => {});
      } catch { /* swallow */ }
    }, DEBOUNCE_MS);
    timers.set(key, handle);
  } catch { /* never affect the caller */ }
}

export async function loadRoom(roomCode) {
  try {
    const conn = db();
    if (!conn) return null;
    const doc = await conn.collection(COLLECTION).findOne({ roomCode });
    if (!doc || !doc.state) return null;
    /*
      `namespace` is returned, not just stored. Every engine game shares one
      room store, so a caller that restores a snapshot without checking which
      game it belongs to writes another game's room into memory under the wrong
      game — the restart-path twin of the cross-game join bug.
    */
    return { state: doc.state, tokens: doc.tokens || [], namespace: doc.namespace || null };
  } catch {
    return null;
  }
}

export function deleteSnapshot(roomCode) {
  try {
    const conn = db();
    if (!conn) return;
    conn.collection(COLLECTION).deleteOne({ roomCode }).catch(() => {});
  } catch { /* no-op */ }
}

// Clone state with player.socketId cleared (stale after a restart) — players
// reattach their socketId when they rejoin.
function sanitize(state) {
  try {
    const clone = JSON.parse(JSON.stringify(state));
    if (Array.isArray(clone.players)) {
      clone.players = clone.players.map((p) => ({ ...p, socketId: null, connected: false }));
    }
    return clone;
  } catch {
    return state;
  }
}
