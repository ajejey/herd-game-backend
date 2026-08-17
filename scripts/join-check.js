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
    const handlers = [];
    const done = (event, payload) => {
      clearTimeout(timer);
      for (const [e, h] of handlers) socket.off(e, h);
      resolve({ event, payload });
    };
    const timer = setTimeout(() => done('timeout', null), ms);
    for (const e of events) {
      const h = (payload) => done(e, payload);
      handlers.push([e, h]);
      socket.on(e, h);
    }
  });
}

/*
  Record every occurrence of an event, for assertions about what did NOT happen.

  race() cannot express that: it removes its listeners when it resolves, so
  "no game_completed arrived" has to be observed by something that is listening
  the whole time rather than for one turn.
*/
function collect(socket, event) {
  const seen = [];
  socket.on(event, (payload) => seen.push(payload));
  return seen;
}

const settle = (ms = 600) => new Promise((r) => setTimeout(r, ms));

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

/*
  Setup shared by the host-authority checks below: a started two-player room,
  with both player ids to hand.
*/
async function startedRoom() {
  const host = await createRoom('Host');
  const guestSocket = connect();
  await new Promise((r) => guestSocket.on('connect', r));
  guestSocket.emit('join_game', { roomCode: host.roomCode, username: 'Guest' });
  const joined = await race(guestSocket, ['game_joined', 'error']);
  if (joined.event !== 'game_joined') throw new Error('guest could not join the test room');

  host.socket.emit('start_game', { gameId: host.gameId });
  const started = await race(host.socket, ['game_started', 'error']);
  if (started.event !== 'game_started') throw new Error('could not start the test room');

  return { host, guestSocket, guestPlayerId: joined.payload.playerId };
}

console.log('\n=== the host is still the host after they reconnect ===');
{
  /*
    The bug this pins down: `game.hostId` was the socket id captured at
    create_game and was never rewritten. Socket ids change on every reconnect —
    a locked phone, a refreshed tab — so from a host's first reconnect onwards
    every host-only handler refused them, and nobody else could start a round
    either. The room was unfinishable by anyone in it.

    Of 275 recent rooms, 67 had a host whose socket had changed and 67 of those
    67 never completed, against 75% for rooms whose host never reconnected.

    This has to be asserted at the socket. The front end decides separately
    whether to RENDER the Next Round button, so a browser test can be green
    while the server still rejects the click.
  */
  const { host } = await startedRoom();

  const back = connect();
  await new Promise((r) => back.on('connect', r));
  back.emit('reconnect_game', {
    gameId: host.gameId,
    roomCode: host.roomCode,
    username: 'Host',
  });
  const rejoined = await race(back, ['game_rejoined', 'reconnect_failed']);
  if (rejoined.event !== 'game_rejoined') {
    fail(`host could not reconnect at all: ${rejoined.payload?.reason || rejoined.event}`);
  } else {
    if (!rejoined.payload.isHost) {
      fail('game_rejoined did not tell the host they are the host — the client cannot render the button');
    } else {
      ok('game_rejoined reports isHost, so the client can restore the host view');
    }

    back.emit('next_round', { gameId: host.gameId });
    const { event, payload } = await race(back, ['next_round', 'error']);
    if (event !== 'next_round') {
      fail(`a reconnected host was refused the next round: ${payload?.message || event}`);
    } else {
      ok('a host who reconnects can still start the next round');
    }
  }
}

console.log('\n=== refreshing on the results screen comes back to the results screen ===');
{
  /*
    Round.status has an enum of 'collecting-answers' | 'completed' and nothing
    ever wrote 'completed'. So join_game's restore —

        if (currentRound && currentRound.status === 'completed')

    — was unreachable, and reconnect_game did not carry results at all. Anyone
    who refreshed while looking at the results came back to an answer box for a
    round that had already been scored, captioned "2 of 2 players answered".
    For the host that is a room with no Next Round button, which is a room
    nobody can finish.
  */
  const { host, guestSocket } = await startedRoom();

  host.socket.emit('submit_answer', { gameId: host.gameId, answer: 'pizza' });
  guestSocket.emit('submit_answer', { gameId: host.gameId, answer: 'pizza' });
  const done = await race(host.socket, ['round_completed', 'error']);
  if (done.event !== 'round_completed') {
    fail(`could not finish a round to test the restore: ${done.payload?.message || done.event}`);
  } else {
    const back = connect();
    await new Promise((r) => back.on('connect', r));
    back.emit('reconnect_game', {
      gameId: host.gameId,
      roomCode: host.roomCode,
      username: 'Host',
    });
    const { event, payload } = await race(back, ['game_rejoined', 'reconnect_failed']);
    if (event !== 'game_rejoined') {
      fail(`could not reconnect: ${payload?.reason || event}`);
    } else if (!payload.gameState?.roundResults) {
      fail('reconnecting after a finished round returned no results — the player gets an answer box for a round already scored');
    } else if (!payload.gameState.roundResults.allAnswers?.length) {
      fail('the restored results carried no answers');
    } else {
      ok('a reconnect after a finished round restores the results');
    }
  }
}

console.log('\n=== the pink cow can be moved by hand, and that ends a stuck game ===');
{
  /*
    "Manaully moving the cow would be a good feature" — 16 Aug 2026.

    Winning needs 8 points AND not holding the cow, and the cow only moves on a
    round with exactly one odd answer. A leader who takes the cow at 8 is stuck
    until such a round turns up, which may be never; room RK6J7L played 34
    rounds that way.

    Built as the deadlock itself: put the cow on the host, walk them to 8, and
    assert that the game does NOT end. Then move the cow and assert it does.
    Without the second half the feature would move a badge and change nothing.
  */
  const { host, guestPlayerId } = await startedRoom();
  const completions = collect(host.socket, 'game_completed');

  host.socket.emit('move_pink_cow', { gameId: host.gameId, playerId: host.playerId });
  const moved = await race(host.socket, ['pink_cow_moved', 'error']);
  if (moved.event !== 'pink_cow_moved') {
    fail(`the host could not move the cow: ${moved.payload?.message || moved.event}`);
  } else if (String(moved.payload.pinkCowHolder) !== String(host.playerId)) {
    fail(`the cow went to ${moved.payload.pinkCowHolder}, not the player asked for`);
  } else {
    ok('the host can hand the cow to a named player');
  }

  for (let i = 0; i < 8; i += 1) {
    host.socket.emit('adjust_score', { gameId: host.gameId, playerId: host.playerId, delta: 1 });
    await race(host.socket, ['players_updated'], 3000);
  }

  await settle();
  if (completions.length) {
    fail('a player on 8 points HOLDING the cow was declared the winner — the cow rule is not being applied');
  } else {
    ok('8 points while holding the cow does not win (the state the report is about)');
  }

  host.socket.emit('move_pink_cow', { gameId: host.gameId, playerId: guestPlayerId });
  const { event, payload } = await race(host.socket, ['game_completed', 'error']);
  if (event !== 'game_completed') {
    fail(`moving the cow away left the game stuck: ${payload?.message || event}`);
  } else if (String(payload.winner?._id) !== String(host.playerId)) {
    fail(`the wrong player won: ${payload.winner?.username}`);
  } else {
    ok('moving the cow off the leader ends the game and they win');
  }
}

console.log('\n=== the cow can be taken off the table entirely ===');
{
  /*
    The "Nobody" button. Untested when the feature was first written, and it is
    the one path that could plausibly no-op: clearing a field with

        Game.findByIdAndUpdate(id, { pinkCowHolder: null })

    only works if that null survives into a $set instead of being dropped as an
    absent value. So this does not trust the broadcast — it reconnects and reads
    the state back out of the database.
  */
  const { host, guestPlayerId } = await startedRoom();

  host.socket.emit('move_pink_cow', { gameId: host.gameId, playerId: guestPlayerId });
  const on = await race(host.socket, ['pink_cow_moved', 'error']);
  if (on.event !== 'pink_cow_moved') {
    fail(`could not place the cow before taking it away: ${on.payload?.message || on.event}`);
  } else {
    host.socket.emit('move_pink_cow', { gameId: host.gameId, playerId: null });
    const { event, payload } = await race(host.socket, ['pink_cow_moved', 'error']);

    if (event !== 'pink_cow_moved') {
      fail(`"Nobody" was refused: ${payload?.message || event}`);
    } else if (payload.pinkCowHolder) {
      fail(`"Nobody" broadcast the cow as still held by ${payload.pinkCowHolder}`);
    } else {
      const back = connect();
      await new Promise((r) => back.on('connect', r));
      back.emit('reconnect_game', {
        gameId: host.gameId,
        roomCode: host.roomCode,
        username: 'Host',
      });
      const re = await race(back, ['game_rejoined', 'reconnect_failed']);
      if (re.event !== 'game_rejoined') {
        fail(`could not read the state back: ${re.payload?.reason || re.event}`);
      } else if (re.payload.gameState?.pinkCowHolder) {
        fail(`the broadcast said nobody, but the stored game still has the cow on ${re.payload.gameState.pinkCowHolder}`);
      } else {
        ok('"Nobody" clears the cow, and the clear is what got saved');
      }
    }
  }
}

console.log('\n=== only the host can move the cow ===');
{
  const { host, guestSocket } = await startedRoom();
  guestSocket.emit('move_pink_cow', { gameId: host.gameId, playerId: host.playerId });
  const { event, payload } = await race(guestSocket, ['pink_cow_moved', 'error'], 4000);
  if (event === 'pink_cow_moved') {
    fail('any player could move the pink cow');
  } else if (event === 'timeout') {
    fail('a non-host move was ignored silently — the player gets no feedback at all');
  } else if (!/host/i.test(payload?.message || '')) {
    fail(`unhelpful refusal: "${payload?.message}"`);
  } else {
    ok('a non-host is refused, and told why');
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
