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

export function setGame(roomCode, state) {
  games.set(roomCode, state);
}

export function getGame(roomCode) {
  return games.get(roomCode) ?? null;
}

export function deleteGame(roomCode) {
  games.delete(roomCode);
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
