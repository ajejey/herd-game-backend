#!/usr/bin/env node
/*
  A room code must only work in the game it was made for.

    node scripts/cross-game-check.js

  Every engine game is mounted on its own socket namespace but they all share
  ONE room store, and until now `join_game` looked a code up in that store
  without checking which game the room belonged to. A valid code typed on the
  wrong game's page therefore resolved perfectly and put that player inside
  another game's room, where the wrong game's deriveClientState ran against
  foreign state.

  Nothing threw. No error was reported. The player's screen was simply wrong,
  which is why this only ever reached us as "not working":

    DDMY   reported on team-trivia       room was /scattergories
    MRMA   reported on would-you-rather  room was /twotruths
    WBEP   reported on chameleon         room was /guesstimate

  Measured across 30 days of analytics_events, after excluding codes legitimately
  reused once a room expired: 50 room sessions, 1.6% of all rooms, every pairing
  of games represented. It was structural, not one bad game.

  This spins up a real Socket.IO server with two real games mounted and talks to
  it over real sockets, because the bug lived in the join handler and nowhere a
  unit test would look. No database and no running backend required.
*/
import { createServer } from 'http';
import { Server } from 'socket.io';
import { io as connect } from 'socket.io-client';
import { mountGame } from '../src/engine/index.js';
import * as store from '../src/engine/store.js';
import { ScattergoriesGame } from '../src/games/scattergories/game.js';
import { TeamTriviaGame } from '../src/games/teamtrivia/game.js';

let failures = 0;
const fail = (m, detail = '') => { console.log(`  FAIL  ${m}${detail ? ' — ' + detail : ''}`); failures += 1; };
const ok = (m) => console.log(`  ok    ${m}`);

const httpServer = createServer();
const ioServer = new Server(httpServer, { cors: { origin: '*' } });
mountGame(ioServer, '/scattergories', ScattergoriesGame);
mountGame(ioServer, '/teamtrivia', TeamTriviaGame);

await new Promise((resolve) => httpServer.listen(0, resolve));
const PORT = httpServer.address().port;
const URL = `http://127.0.0.1:${PORT}`;

const clients = [];
function client(nsp) {
  const s = connect(URL + nsp, { transports: ['websocket'], forceNew: true });
  clients.push(s);
  return s;
}

/** Emit, then resolve with whichever of `joined` / `error` comes back first. */
function attempt(socket, event, payload, ms = 4000) {
  return new Promise((resolve) => {
    const done = (outcome) => { clearTimeout(t); resolve(outcome); };
    const t = setTimeout(() => resolve({ kind: 'timeout' }), ms);
    socket.once('joined', (d) => done({ kind: 'joined', ...d }));
    socket.once('error', (d) => done({ kind: 'error', ...d }));
    socket.emit(event, payload);
  });
}

const ready = (s) => new Promise((res, rej) => {
  s.once('connect', res);
  s.once('connect_error', rej);
});

try {
  /* ── A room is made in Scattergories ─────────────────────────────────────── */
  const host = client('/scattergories');
  await ready(host);
  const created = await attempt(host, 'create_game', { username: 'Host' });
  if (created.kind !== 'joined' || !created.roomCode) {
    fail('a Scattergories room can be created', created.kind);
    throw new Error('cannot continue without a room');
  }
  const CODE = created.roomCode;
  ok(`a Scattergories room can be created (${CODE})`);

  /* ── The same code, on the wrong game's page ─────────────────────────────── */
  const wrong = client('/teamtrivia');
  await ready(wrong);
  const crossed = await attempt(wrong, 'join_game', { roomCode: CODE, username: 'Lost' });

  if (crossed.kind === 'joined') {
    fail('a Team Trivia player must NOT get into a Scattergories room',
      'they were admitted — this is the bug');
  } else if (crossed.kind === 'timeout') {
    fail('the wrong-game join is answered at all', 'no reply, so the player just hangs');
  } else {
    ok('a Team Trivia player is kept out of a Scattergories room');
    if (crossed.code === 'WRONG_GAME') ok('the refusal is marked WRONG_GAME, not ROOM_NOT_FOUND');
    else fail('the refusal says the code is for another game', `code was ${crossed.code}`);

    /* The whole point: the code is RIGHT, the page is wrong. Saying "not found"
       sends someone hunting for a typo that does not exist. */
    if (/scattergories/i.test(crossed.message || '')) ok('the message names the game the code belongs to');
    else fail('the message names the game the code belongs to', crossed.message);
  }

  /* ── And the right page still works ──────────────────────────────────────── */
  const right = client('/scattergories');
  await ready(right);
  const joined = await attempt(right, 'join_game', { roomCode: CODE, username: 'Friend' });
  if (joined.kind === 'joined') ok('a Scattergories player still joins normally');
  else fail('a Scattergories player still joins normally', `${joined.kind} ${joined.message || ''}`);

  /* ── A room made before this field existed must still be joinable ────────── */
  const legacy = store.getGame(CODE);
  const LEGACY_CODE = 'ZZZZ';
  const { game: _dropped, ...withoutGame } = legacy;
  store.setGame(LEGACY_CODE, { ...withoutGame, roomCode: LEGACY_CODE });

  const older = client('/teamtrivia');
  await ready(older);
  const legacyJoin = await attempt(older, 'join_game', { roomCode: LEGACY_CODE, username: 'MidGame' });
  if (legacyJoin.kind === 'joined') {
    ok('a room created before this deploy is still joinable (nobody is dropped mid-game)');
  } else {
    fail('a room created before this deploy is still joinable',
      `${legacyJoin.kind} ${legacyJoin.message || ''} — this would kick live games on deploy`);
  }

  /* ── An unknown code still says what it always said ──────────────────────── */
  const missing = client('/teamtrivia');
  await ready(missing);
  const nope = await attempt(missing, 'join_game', { roomCode: 'QQQQ', username: 'Nobody' });
  if (nope.kind === 'error' && nope.code === 'ROOM_NOT_FOUND') ok('a genuinely unknown code is still ROOM_NOT_FOUND');
  else fail('a genuinely unknown code is still ROOM_NOT_FOUND', `${nope.kind} ${nope.code || ''}`);
} catch (err) {
  fail('the check ran to completion', err.message);
} finally {
  for (const c of clients) { try { c.close(); } catch { /* ignore */ } }
  ioServer.close();
  httpServer.close();
}

console.log('');
if (failures) {
  console.log(`cross-game room codes — ${failures} problem(s)`);
  process.exit(1);
}
console.log('cross-game room codes — a code only works in the game it was made for');
process.exit(0);
