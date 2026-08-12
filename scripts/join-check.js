#!/usr/bin/env node
/*
  Getting into the main Herd game — asserted at the SOCKET, not the browser.

  Two players reported this on 11 Aug 2026:

    "my buddy can't get in"
    "Gaga can't play with me because you're on a different page on the same game"

  The browser now normalises the room code before it sends it, and that alone
  makes an end-to-end Playwright test pass whether or not the SERVER also
  normalises — the client fix hides the server one. That is exactly the blind
  spot TESTING.md §5.3 warns about: if the assertion cannot see past the client,
  it is not testing server authority.

  It matters here more than usual, because the Android app ships its own frozen
  copy of the front end. Every install out there keeps sending whatever it sent
  before, for as long as people take to update. The server has to be the thing
  that is right.

  So these talk to the socket directly and send deliberately ugly values.

  Needs the backend on :3001 and a Mongo it can write to:
    MONGODB_URI=mongodb://localhost:27017/herd_e2e node src/index.js
    node scripts/join-check.js
*/
import { io } from 'socket.io-client';

const URL = process.env.BACKEND_URL || 'http://localhost:3001';

let failures = 0;
const fail = (m) => { console.log(`  FAIL  ${m}`); failures += 1; };
const ok = (m) => console.log(`  ok    ${m}`);

const sockets = [];
function connect() {
  const s = io(URL, { transports: ['polling', 'websocket'], forceNew: true });
  sockets.push(s);
  return s;
}

/** Wait for one of several events; resolves { event, payload }. */
function race(socket, events, ms = 8000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ event: 'timeout', payload: null }), ms);
    for (const e of events) {
      socket.once(e, (payload) => { clearTimeout(timer); resolve({ event: e, payload }); });
    }
  });
}

async function createRoom(name) {
  const s = connect();
  await new Promise((r) => s.on('connect', r));
  s.emit('create_game', { username: name });
  const { payload } = await race(s, ['game_created', 'error']);
  if (!payload?.roomCode) throw new Error('could not create a room to test against');
  return { socket: s, ...payload };
}

console.log(`\nJoining the main Herd game — against ${URL}`);

console.log('\n=== the room code is normalised server-side ===');
for (const [label, mangle] of [
  ['lower case (what a phone keyboard sends)', (c) => c.toLowerCase()],
  /*
    Lowercase the first LETTER, not the first character.

    Room codes are drawn from A-Z0-9, so `c[0].toLowerCase()` is a no-op on the
    roughly one code in four that starts with a digit — and this check quietly
    passed against the bug whenever it drew one of those. A mangle that does
    not always mangle is not an assertion, it is a coin toss.
  */
  ['mixed case', (c) => c.replace(/[A-Z]/, (ch) => ch.toLowerCase())],
  ['a trailing space from a paste', (c) => `${c} `],
  ['leading and trailing whitespace', (c) => `  ${c}  `],
]) {
  const room = await createRoom('Host');
  const s = connect();
  await new Promise((r) => s.on('connect', r));
  s.emit('join_game', { roomCode: mangle(room.roomCode), username: 'Friend' });
  const { event, payload } = await race(s, ['game_joined', 'error']);
  if (event !== 'game_joined') {
    fail(`${label}: server said "${payload?.message || event}" for room ${room.roomCode}`);
  } else {
    ok(label);
  }
}

console.log('\n=== a returning player is matched whatever the capitalisation ===');
{
  const room = await createRoom('Host');
  const s = connect();
  await new Promise((r) => s.on('connect', r));
  s.emit('join_game', { roomCode: room.roomCode, username: 'Micah' });
  const first = await race(s, ['game_joined', 'error']);

  // Same person, comes back, types their name slightly differently.
  const again = connect();
  await new Promise((r) => again.on('connect', r));
  again.emit('join_game', { roomCode: room.roomCode, username: 'micah' });
  const { event, payload } = await race(again, ['game_joined', 'error']);

  /*
    Asserting only that the join SUCCEEDS is not enough, and this check was
    written that way first and passed against the bug.

    While a room is still in the lobby an unmatched name is not refused — it
    quietly creates a SECOND player. So the failure is not an error, it is a
    duplicate: one human occupying two seats, inflating the count that every
    round waits on. Room M8RVAL is carrying "Micah" and "micah" for exactly
    this reason. The identity of the player is the thing to assert.
  */
  if (event !== 'game_joined') {
    fail(`rejoining as "micah" after "Micah" was refused: ${payload?.message || event}`);
  } else if (String(payload.playerId) !== String(first.payload?.playerId)) {
    fail('"micah" became a SECOND player instead of matching the "Micah" already in the room');
  } else {
    ok('"micah" is recognised as the "Micah" already in the room');
  }
}

console.log('\n=== reconnecting works even when the server still thinks you are here ===');
{
  const room = await createRoom('Host');
  const s = connect();
  await new Promise((r) => s.on('connect', r));
  s.emit('join_game', { roomCode: room.roomCode, username: 'Gaga' });
  const joined = await race(s, ['game_joined', 'error']);

  /*
    No disconnect first — that is the whole point.

    A refresh, a locked phone or a restored tab all reconnect before the old
    socket's disconnect has been processed, so the record still says connected.
    This used to require isConnected:false, find nobody, and emit
    reconnect_failed — which the client handles with navigate('/'). The player
    was ejected from a game they were sitting in and dumped on the home page.
  */
  const back = connect();
  await new Promise((r) => back.on('connect', r));
  back.emit('reconnect_game', {
    gameId: joined.payload.gameId,
    roomCode: room.roomCode,
    username: 'Gaga',
  });
  const { event, payload } = await race(back, ['game_rejoined', 'reconnect_failed']);
  if (event !== 'game_rejoined') {
    fail(`reconnect while still marked connected was refused: ${payload?.reason || event}`);
  } else {
    ok('a player who never formally left can still take their seat back');
  }
}

console.log('\n=== a genuinely wrong code is still refused ===');
{
  const s = connect();
  await new Promise((r) => s.on('connect', r));
  s.emit('join_game', { roomCode: 'ZZZZZZ', username: 'Nobody' });
  const { event, payload } = await race(s, ['game_joined', 'error']);
  if (event === 'game_joined') fail('a nonexistent room accepted a player');
  else if (!/not found/i.test(payload?.message || '')) fail(`unhelpful message: "${payload?.message}"`);
  else ok('an unknown room code is rejected, and says so');
}

for (const s of sockets) s.close();
console.log(failures ? `\n${failures} FAILURE(S)\n` : '\nAll checks passed.\n');
process.exit(failures ? 1 : 0);
