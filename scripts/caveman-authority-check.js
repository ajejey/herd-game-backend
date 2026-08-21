#!/usr/bin/env node
/**
 * Caveman Clues — what the SERVER allows, ignoring the browser entirely.
 *
 *   node scripts/caveman-authority-check.js
 *
 * The browser gives a guesser no clue box, so a Playwright test can never prove
 * the server would refuse one — it only proves the button is missing. That is
 * exactly the blind spot TESTING.md §5.3 warns about: if the assertion cannot
 * see past the client, it is not testing server authority.
 *
 * It matters more than usual here because the Android app ships its own frozen
 * copy of the front end. Every install out there keeps sending whatever it sent
 * before, for as long as people take to update, so the server has to be the
 * thing that is right.
 *
 * Spins up its own Socket.IO server with the real game mounted. No database and
 * no running backend.
 */
import { createServer } from 'http';
import { Server } from 'socket.io';
import { io as connect } from 'socket.io-client';
import { mountGame } from '../src/engine/index.js';
import { CavemanCluesGame } from '../src/games/cavemanclues/game.js';

let failures = 0;
const fail = (m, d = '') => { console.log(`  FAIL  ${m}${d ? ' — ' + d : ''}`); failures += 1; };
const ok = (m) => console.log(`  ok    ${m}`);
const is = (m, cond, d = '') => (cond ? ok(m) : fail(m, d));

const httpServer = createServer();
const ioServer = new Server(httpServer, { cors: { origin: '*' } });
mountGame(ioServer, '/cavemanclues', CavemanCluesGame);
await new Promise((r) => httpServer.listen(0, r));
const URL = `http://127.0.0.1:${httpServer.address().port}`;

const sockets = [];
const client = () => {
  const s = connect(`${URL}/cavemanclues`, { transports: ['websocket'], forceNew: true });
  sockets.push(s);
  return s;
};
const ready = (s) => new Promise((res, rej) => {
  s.once('connect', res); s.once('connect_error', rej);
  setTimeout(() => rej(new Error('connect timeout')), 8000);
});
const once = (s, ev, ms = 5000) => new Promise((res) => {
  const t = setTimeout(() => res(null), ms);
  s.once(ev, (d) => { clearTimeout(t); res(d); });
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* Each client keeps the newest state it was sent, which is the only honest
   record of what the server thinks this player may see. */
function track(socket) {
  const box = { state: null };
  socket.on('joined', (d) => { box.state = d.state; });
  socket.on('state_update', (d) => { box.state = d.state; });
  return box;
}

try {
  const host = client(); await ready(host);
  const hostBox = track(host);
  host.emit('create_game', { username: 'Ann' });
  const created = await once(host, 'joined');
  const code = created?.roomCode;
  is('a room can be created', !!code, String(code));

  const guessers = [];
  for (const name of ['Bob', 'Cat']) {
    const s = client(); await ready(s);
    const box = track(s);
    s.emit('join_game', { roomCode: code, username: name });
    await once(s, 'joined');
    guessers.push({ s, box, name });
  }
  host.emit('start_game', { roomCode: code });
  await sleep(600);

  const all = [{ s: host, box: hostBox, name: 'Ann' }, ...guessers];
  const giver = all.find((p) => p.box.state?.isGiver);
  const others = all.filter((p) => !p.box.state?.isGiver);
  is('the server picked exactly one Clue Giver', all.filter((p) => p.box.state?.isGiver).length === 1);

  const secret = giver.box.state.word;
  is('the giver was sent the word', typeof secret === 'string' && secret.length > 0);
  for (const o of others) {
    is(`${o.name} was not sent the word over the socket`, o.box.state.word === null);
    is(`the word is nowhere in ${o.name}'s socket payload`,
      !new RegExp(`\\b${secret}\\b`, 'i').test(JSON.stringify(o.box.state)));
  }

  /* ── A guesser emitting a clue directly ──────────────────────────────── */
  const before = giver.box.state.turn.clues.length;
  others[0].s.emit('game_action', { roomCode: code, action: 'clue', payload: { text: 'i am cheating' } });
  await sleep(600);
  is('the server refuses a clue from a guesser', giver.box.state.turn.clues.length === before,
    'the UI hiding the box is not the same as the server refusing it');

  /* ── The giver guessing their own word ───────────────────────────────── */
  const gBefore = giver.box.state.turn.guesses.length;
  giver.s.emit('game_action', { roomCode: code, action: 'guess', payload: { text: secret } });
  await sleep(600);
  is('the server refuses a guess from the giver',
    giver.box.state.turn.guesses.length === gBefore && giver.box.state.phase === 'clue');

  /* ── A bystander ending a live turn ──────────────────────────────────── */
  others[0].s.emit('game_action', { roomCode: code, action: 'end_turn', payload: {} });
  await sleep(600);
  is('the server refuses end_turn from a bystander while the giver is present',
    giver.box.state.phase === 'clue', giver.box.state.phase);

  /* ── Nonsense payloads must not crash the namespace ──────────────────── */
  for (const payload of [null, undefined, { text: null }, { text: {} }, { text: 'x'.repeat(5000) }]) {
    giver.s.emit('game_action', { roomCode: code, action: 'clue', payload });
  }
  giver.s.emit('game_action', { roomCode: code, action: 'nonsense', payload: {} });
  giver.s.emit('game_action', { roomCode: 'ZZZZ', action: 'clue', payload: { text: 'hi' } });
  await sleep(900);
  is('hostile payloads do not kill the namespace', giver.s.connected && others[0].s.connected);
  is('the game is still playable afterwards', giver.box.state?.phase === 'clue');

  /* A 5000-character clue must have been cut down, not stored whole. */
  const longest = Math.max(0, ...giver.box.state.turn.clues.map((c) => c.text.length));
  is('an enormous clue is truncated on the server', longest <= 120, `${longest} chars stored`);

  /* ── A correct guess still works after all that ──────────────────────── */
  others[1].s.emit('game_action', { roomCode: code, action: 'guess', payload: { text: secret.toLowerCase() } });
  await sleep(800);
  is('a real guess still wins after the abuse', giver.box.state.phase === 'reveal',
    giver.box.state.phase);
  is('everyone is shown the word at the reveal',
    others.every((o) => o.box.state.word === secret));
} catch (err) {
  fail('the authority check ran to completion', err.message);
} finally {
  for (const s of sockets) { try { s.close(); } catch { /* ignore */ } }
  ioServer.close();
  httpServer.close();
}

console.log('');
if (failures) { console.log(`caveman clues authority — ${failures} problem(s)`); process.exit(1); }
console.log('caveman clues authority — the server decides, not the browser');
process.exit(0);
