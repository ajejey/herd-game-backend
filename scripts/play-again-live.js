/*
  play_again, driven through a real socket against a real room.

    node scripts/play-again-live.js

  play-again-check.js reads the source and proves the shape is right. This
  proves the behaviour: it stands up the engine in-process, makes a room, wins
  a game, presses play again, and then asks the questions a player would ask.

    Is it the SAME room? (the whole point — a new code strands everybody)
    Are we back in the lobby, and can we actually start again?
    Are the scores zero?
    Is everyone still here?
    Did the room keep its settings — the rounds it was set up with?
    Can a non-host trigger it while the host is present? (must not)
    Can it be fired mid-game to wipe everyone's scores?  (must not)

  Chameleon is the game under test because it is the cheapest to walk to a
  finish and it exercises the awkward parts: a hidden role, a phase only one
  player may act in, and a round that ends two different ways. It is played
  here the way players play it — everyone submits a clue, everyone votes —
  rather than through the host's force buttons, so the test would notice if
  the ordinary path broke.

  No database, no browser.
*/
import { createServer } from 'http';
import { Server } from 'socket.io';
import { io as connect } from 'socket.io-client';
import { mountGame } from '../src/engine/index.js';
import { ChameleonGame } from '../src/games/chameleon/game.js';

let failures = 0;
const fail = (m, d = '') => { console.log(`  FAIL  ${m}${d ? ' — ' + d : ''}`); failures += 1; };
const ok = (m) => console.log(`  ok    ${m}`);
const is = (m, c, d = '') => (c ? ok(m) : fail(m, d));

const httpServer = createServer();
const ioServer = new Server(httpServer, { cors: { origin: '*' } });
mountGame(ioServer, '/chameleon', ChameleonGame);
await new Promise((r) => httpServer.listen(0, r));
const URL = `http://127.0.0.1:${httpServer.address().port}`;

const clients = [];
const client = () => {
  const s = connect(URL + '/chameleon', { transports: ['websocket'], forceNew: true });
  clients.push(s);
  return s;
};
const ready = (s) => new Promise((res, rej) => { s.once('connect', res); s.once('connect_error', rej); });
const once = (s, ev, ms = 4000) => new Promise((res) => {
  const t = setTimeout(() => res(null), ms);
  s.once(ev, (d) => { clearTimeout(t); res(d); });
});
/*
  Every socket keeps its latest state, permanently.

  The first version of this attached a one-off listener AFTER emitting, which
  is a race it lost most of the time: the broadcast for the last vote arrives
  while the driver is still awaiting its inter-emit sleep, so the transition
  had already happened by the time anything was listening, and the wait timed
  out on a room that was working perfectly. The test then reported "the game
  finishes — never reached finished" about a game that had finished.

  So state is tracked continuously and `stateWhen` answers from what is
  already known before it agrees to wait for anything.
*/
const latest = new Map();
const track = (s) => { s.on('state_update', ({ state }) => latest.set(s, state)); return s; };

const stateWhen = (s, pred, ms = 4000) => {
  const now = latest.get(s);
  if (now && pred(now)) return Promise.resolve(now);
  return new Promise((res) => {
    const t = setTimeout(() => { s.off('state_update', on); res(null); }, ms);
    const on = ({ state }) => {
      if (pred(state)) { clearTimeout(t); s.off('state_update', on); res(state); }
    };
    s.on('state_update', on);
  });
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('');
console.log('=== play again, on a real room ===');

try {
  const host = track(client()), p2 = track(client()), p3 = track(client());
  await Promise.all([ready(host), ready(p2), ready(p3)]);

  /*
    A room created with a NON-DEFAULT round count, so "the rematch keeps the
    settings" is a real question rather than a coincidence. Chameleon accepts
    3..12 and defaults to 5, so 3 is both valid and distinguishable — asking
    for 1 silently gets you the default, which is how the first run of this
    test managed to "pass" that assertion while proving nothing.
  */
  const ROUNDS = 3;
  host.emit('create_game', { username: 'Ann', settings: { rounds: ROUNDS } });
  const created = await once(host, 'joined');
  const code = created?.roomCode;
  is('a room is made', !!code, JSON.stringify(created)?.slice(0, 80));
  const totalRounds = created?.state?.totalRounds;
  is('...with the settings it asked for', totalRounds === ROUNDS, `totalRounds=${totalRounds}`);

  p2.emit('join_game', { roomCode: code, username: 'Bob' });
  const j2 = await once(p2, 'joined');
  p3.emit('join_game', { roomCode: code, username: 'Cat' });
  const j3 = await once(p3, 'joined');

  host.emit('start_game', { roomCode: code });
  const playing = await stateWhen(host, (s) => s.status === 'playing');
  is('the game starts', !!playing, 'never reached playing');

  /* id -> the socket that owns it, so the Chameleon can be made to guess. */
  const seats = [[created.playerId, host], [j2?.playerId, p2], [j3?.playerId, p3]];
  const byId = Object.fromEntries(seats);

  /*
    Played the way people play it, not through the host's escape hatches.

    The first version of this driver used force_voting and never advanced,
    because that action refuses while `round.clues.length === 0` — a guard
    worth having and worth respecting. Everyone submitting a clue moves the
    round on by itself, and so does everyone voting, so the natural path needs
    no force buttons at all and exercises what players actually do.

    Votes all land on one person, which may or may not be the Chameleon. If it
    is, the round stops in 'guessing' and only that player may guess — their id
    is readable from that phase onwards, which is the whole point of the phase.
  */
  async function playRound() {
    for (const [, sock] of seats) {
      sock.emit('game_action', { roomCode: code, action: 'submit_clue', payload: { word: 'thing' } });
      await sleep(60);
    }
    const voting = await stateWhen(host, (s) => s.phase === 'voting', 3000);
    if (!voting) return null;

    const suspect = seats[0][0];
    for (const [, sock] of seats) {
      sock.emit('game_action', { roomCode: code, action: 'submit_vote', payload: { suspectId: suspect } });
      await sleep(60);
    }
    let after = await stateWhen(host, (s) => s.phase === 'guessing' || s.phase === 'result', 4000);
    if (after?.phase === 'guessing') {
      const cham = byId[after.round?.chameleonId];
      if (cham) {
        cham.emit('game_action', { roomCode: code, action: 'chameleon_guess', payload: { wordIndex: 0 } });
        after = await stateWhen(host, (s) => s.phase === 'result' || s.status === 'finished', 3000);
      }
    }
    return after;
  }

  let done = null;
  for (let i = 0; i < ROUNDS + 1 && !done; i += 1) {
    const after = await playRound();
    if (!after) break;
    if (after.status === 'finished') { done = after; break; }
    host.emit('game_action', { roomCode: code, action: 'next_round', payload: {} });
    const nxt = await stateWhen(host, (s) => s.phase === 'clue' || s.status === 'finished', 3000);
    if (nxt?.status === 'finished') { done = nxt; break; }
  }
  is('the game finishes', !!done, 'never reached finished');

  /* ── A non-host must not be able to reset it ───────────────────────────── */
  p2.emit('play_again', { roomCode: code });
  const refused = await once(p2, 'error', 1500);
  is('a non-host is refused while the host is here', refused?.code === 'UNAUTHORIZED',
    JSON.stringify(refused));
  await sleep(150);

  /* ── The host presses it ───────────────────────────────────────────────── */
  const backInLobby = stateWhen(p3, (s) => s.status === 'lobby', 4000);
  host.emit('play_again', { roomCode: code });
  const fresh = await backInLobby;

  is('everyone is put back in the lobby', !!fresh, 'no lobby state broadcast');
  if (fresh) {
    is('...in the SAME room', fresh.roomCode === code, `${fresh.roomCode} vs ${code}`);
    is('...with everyone still in it', (fresh.players || []).length === 3,
      `${(fresh.players || []).length} players`);
    is('...and every score back to zero',
      (fresh.players || []).every((p) => (p.score ?? 0) === 0),
      JSON.stringify((fresh.players || []).map((p) => p.score)));
    is('...the host is still the host',
      (fresh.players || []).filter((p) => p.isHost).length === 1);
    is('...last game is gone from the board', !fresh.winner && !fresh.round,
      `winner=${JSON.stringify(fresh.winner)} round=${!!fresh.round}`);
    /* The one that would fail silently: a rematch built from
       createInitialState({}) is a DIFFERENT game from the one they set up. */
    is('...and it is still the game they configured', fresh.totalRounds === ROUNDS,
      `totalRounds=${fresh.totalRounds}, expected ${ROUNDS}`);
  }

  /* ── And it can really be played again ─────────────────────────────────── */
  host.emit('start_game', { roomCode: code });
  const second = await stateWhen(host, (s) => s.status === 'playing', 4000);
  is('the second game actually starts', !!second, 'start_game did nothing after the reset');

  /*
    ── Mid-game it must be inert ─────────────────────────────────────────────

    Otherwise it is a score-wiping button that anyone can reach the moment the
    host drops. Pressing it now must change nothing, and "nothing" is checked
    by watching for a lobby broadcast that must never arrive — not by reading
    a state back, which would pass even if the room had been reset and
    restarted in between.
  */
  const illegalReset = stateWhen(host, (s) => s.status === 'lobby', 1200);
  host.emit('play_again', { roomCode: code });
  const leaked = await illegalReset;
  is('mid-game it does nothing', leaked === null,
    leaked ? 'the room was reset while a game was live' : '');
} catch (err) {
  fail('the run completed', String(err.message).slice(0, 120));
} finally {
  for (const c of clients) { try { c.close(); } catch { /* closing */ } }
  ioServer.close();
  httpServer.close();
}

console.log('');
if (failures) { console.log(`play again (live) — ${failures} problem(s)\n`); process.exit(1); }
console.log('play again (live) — the room resets, keeps its people, and keeps its settings\n');
process.exit(0);
