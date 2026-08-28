import { randomBytes } from 'crypto';

// games: roomCode -> gameState
const games = new Map();

// tokens: rejoinToken -> { roomCode, playerId }
const tokens = new Map();

// cleanup handles: roomCode -> TimeoutHandle
const cleanupHandles = new Map();

const GAME_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

export function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I or O (look like 1/0)
  let code;
  do {
    code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (games.has(code));
  return code;
}

export function generateToken() {
  return randomBytes(20).toString('hex');
}

/*
  The settings a room was created with, kept OUT of the game state on purpose.

  play_again needs them: every game derives real configuration from settings —
  rounds, turn seconds, category count, win score, and the resolved custom
  question pack — so a second game built from `createInitialState({})` would
  silently be a different game from the one the room just played.

  They are not stored on the state object because EVERY game's
  deriveClientState spreads `...state`, so anything living there is broadcast
  to every player. settings can carry `customQuestions` — the actual Taboo
  cards, the Chameleon words — and putting that in state would deal every
  player the answers. Engine-private map, same reasoning as the room store
  itself.
*/
const settings = new Map();

export function setSettings(roomCode, value) {
  settings.set(roomCode, value && typeof value === 'object' ? value : {});
}

export function settingsFor(roomCode) {
  return settings.get(roomCode) ?? {};
}

export function setGame(roomCode, state) {
  games.set(roomCode, state);
}

export function getGame(roomCode) {
  return games.get(roomCode) ?? null;
}

export function deleteGame(roomCode) {
  games.delete(roomCode);
  settings.delete(roomCode);
  // revoke all tokens for this room
  for (const [token, data] of tokens.entries()) {
    if (data.roomCode === roomCode) tokens.delete(token);
  }
  const handle = cleanupHandles.get(roomCode);
  if (handle) { clearTimeout(handle); cleanupHandles.delete(roomCode); }
}

export function setToken(token, data) {
  tokens.set(token, data);
}

export function getToken(token) {
  return tokens.get(token) ?? null;
}

export function scheduleCleanup(roomCode) {
  const existing = cleanupHandles.get(roomCode);
  if (existing) clearTimeout(existing);
  const handle = setTimeout(() => deleteGame(roomCode), GAME_TTL_MS);
  cleanupHandles.set(roomCode, handle);
}

export function refreshCleanup(roomCode) {
  scheduleCleanup(roomCode);
}

export function allGames() {
  return games.entries();
}

// ── Snapshot/restore helpers (for surviving server restarts) ────────────────
// All rejoin tokens that belong to a room (so a restored room can still be
// rejoined after a restart).
export function tokensForRoom(roomCode) {
  const out = [];
  for (const [token, data] of tokens.entries()) {
    if (data.roomCode === roomCode) out.push({ token, playerId: data.playerId });
  }
  return out;
}

// Restore a room + its tokens into memory (used when loading a snapshot after a
// restart). Does not overwrite a room that's already live in memory.
export function restoreGame(roomCode, state, tokenEntries = [], roomSettings = null) {
  if (games.has(roomCode)) return false;
  games.set(roomCode, state);
  /*
    Settings come back with the room. Without this a room that survived a
    restart could still be replayed, but the second game would quietly use
    default rounds and lose the custom pack — the failure would look like the
    pack "expiring" rather than like a restart.
  */
  if (roomSettings) settings.set(roomCode, roomSettings);
  for (const { token, playerId } of tokenEntries) {
    if (token && playerId) tokens.set(token, { roomCode, playerId });
  }
  scheduleCleanup(roomCode);
  return true;
}
