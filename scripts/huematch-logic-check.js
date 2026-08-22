#!/usr/bin/env node
/**
 * Hue Match — grid, scoring, cue rules and the role visibility matrix.
 *
 *   node scripts/huematch-logic-check.js
 *
 * The matrix in HUE_MATCH_PLAN.md is the design document AND the test spec.
 * This game has TWO secrets, and the second one is the interesting one: a
 * guesser must not see anyone else's marker before the reveal, or the first
 * person to lock in decides the round and everyone copies. It is easy to miss
 * because it is not the "real" secret — the payload looks fine without it.
 *
 * No database, no browser, no server.
 */
import { HueMatchGame as G } from '../src/games/huematch/game.js';
import { COLS, ROWS, colourAt, allSquares, scoreFor, ringDistance, inBounds, labelOf } from '../src/games/huematch/grid.js';
import { rejectCue } from '../src/games/huematch/hueWords.js';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/*
  The browser paints the board from its own copy of grid.js. If the two drift,
  square G4 is one colour on screen and a different one in the scoring — and the
  only symptom is players insisting the colours are wrong, which is unfindable
  from a bug report. Compared byte for byte below the browser copy's header.
*/
{
  const fe = path.join(here, '..', '..', 'frontend', 'src', 'lib', 'hueGrid.js');
  const be = path.join(here, '..', 'src', 'games', 'huematch', 'grid.js');
  if (fs.existsSync(fe)) {
    const beSrc = fs.readFileSync(be, 'utf8');
    const feSrc = fs.readFileSync(fe, 'utf8');
    const stripped = feSrc.slice(feSrc.indexOf('/*', feSrc.indexOf('*/') + 2));
    if (stripped.trim() !== beSrc.trim()) {
      console.error('The browser copy of the hue grid has drifted from the server copy.\n');
      console.error('  fix with:  cd backend && npm run sync:huegrid');
      process.exit(1);
    }
    console.log('  the browser copy of the grid matches the server copy exactly');
  }
}

let failures = 0;
const fail = (m, d = '') => { console.log(`  FAIL  ${m}${d ? ' — ' + d : ''}`); failures += 1; };
const ok = (m) => console.log(`  ok    ${m}`);
const is = (m, cond, d = '') => (cond ? ok(m) : fail(m, d));

const players = (n) => Array.from({ length: n }, (_, i) => ({
  id: `p${i}`, username: `P${i}`, connected: true, socketId: `s${i}`,
}));
const fresh = (n = 4, settings = {}) => G.onStart({ players: players(n), ...G.createInitialState(settings) });
const find = (s, id) => s.players.find((p) => p.id === id);
const act = (s, action, payload, id) => G.handleAction(s, action, payload, find(s, id)) || s;

/* ── The grid ────────────────────────────────────────────────────────────── */
{
  const squares = allSquares();
  is('the grid is 14 x 9', squares.length === COLS * ROWS && COLS === 14 && ROWS === 9, `${COLS}x${ROWS}`);

  const hexes = squares.map((s) => s.hex);
  const dupes = hexes.length - new Set(hexes).size;
  is('every square is a distinct colour', dupes === 0, `${dupes} duplicate(s)`);
  is('every colour is a valid hex', hexes.every((h) => /^#[0-9a-f]{6}$/.test(h)));

  /* Generated, so it must be stable — the client computes the same function and
     a drift means the server's G4 is not the browser's G4. */
  is('colourAt is deterministic', colourAt(3, 4) === colourAt(3, 4) && colourAt(3, 4) === squares[4 * COLS + 3].hex);

  /* No row of near-identical squares: adjacent columns must differ visibly. */
  const flat = squares.filter((s, i) => i % COLS < COLS - 1 && s.hex === colourAt(s.col + 1, s.row));
  is('no two side-by-side squares share a colour', flat.length === 0, `${flat.length} pair(s)`);

  /* Last column is P, not N — I and O are skipped, so fourteen columns reach
     one letter past N. See COL_LETTERS in grid.js. */
  is('labels read like a board', labelOf(0, 0) === 'A1' && labelOf(13, 8) === 'P9', labelOf(13, 8));
  is('bounds reject anything off the board',
    inBounds(0, 0) && inBounds(13, 8) && !inBounds(14, 0) && !inBounds(0, 9) && !inBounds(-1, 0)
    && !inBounds(1.5, 2) && !inBounds(NaN, 0));
}

/* ── Scoring rings ───────────────────────────────────────────────────────── */
{
  const t = { col: 7, row: 4 };
  is('the exact square scores three', scoreFor({ col: 7, row: 4 }, t) === 3);
  is('a square that touches scores two', scoreFor({ col: 8, row: 4 }, t) === 2);
  is('a DIAGONAL neighbour also scores two',
    scoreFor({ col: 8, row: 5 }, t) === 2,
    'the rings must match the squares that visually touch, not a diamond');
  is('the next ring scores one', scoreFor({ col: 9, row: 4 }, t) === 1 && scoreFor({ col: 9, row: 6 }, t) === 1);
  is('beyond that scores nothing', scoreFor({ col: 10, row: 4 }, t) === 0);
  is('distance counts a diagonal as one step', ringDistance({ col: 8, row: 5 }, t) === 1);

  /* Exactly 8 squares should score 2, and exactly 16 should score 1. */
  const around = allSquares().filter((s) => scoreFor(s, t) === 2).length;
  const outer = allSquares().filter((s) => scoreFor(s, t) === 1).length;
  is('eight squares score two', around === 8, String(around));
  is('sixteen squares score one', outer === 16, String(outer));
}

/* ── Cue rules ───────────────────────────────────────────────────────────── */
{
  is('a one-word cue is allowed for the first clue', rejectCue('ocean', 1) === null);
  is('two words are refused for the first clue', rejectCue('ocean floor', 1)?.reason === 'wordcount');
  is('one word is refused for the second clue', rejectCue('ocean', 2)?.reason === 'wordcount');
  is('exactly two are allowed for the second', rejectCue('ocean floor', 2) === null);
  is('an empty cue is refused', rejectCue('   ', 1)?.reason === 'empty');

  is('a colour word is refused', rejectCue('blue', 1)?.reason === 'colour');
  is('...in any case', rejectCue('BLUE', 1)?.reason === 'colour');
  is('...as a plural', rejectCue('blues', 1)?.reason === 'colour');
  is('...with punctuation', rejectCue('blue!', 1)?.reason === 'colour');
  is('...and inside a two-word cue', rejectCue('very red', 2)?.reason === 'colour');
  is('a shade word is refused', rejectCue('pale', 1)?.reason === 'colour');

  is('a board position is refused', rejectCue('row', 1)?.reason === 'position');
  is('...including a number', rejectCue('top four', 2)?.reason === 'position');
  is('the message tells them what to do instead',
    /reminds you of/.test(rejectCue('blue', 1).message), rejectCue('blue', 1).message);

  /* Over-blocking is worse than under-blocking: a legal cue refused is the
     game calling you a cheat. */
  /* Things first, colours second. Blocking these guts the game — "it reminds
     me of rust" is precisely the cue it is asking for. */
  for (const cue of ['ocean', 'sunset', 'moss', 'brick', 'fire', 'sky', 'grass', 'rust',
                     'coffee', 'honey', 'jade', 'olive', 'mint', 'salmon', 'sand', 'ash',
                     'copper', 'gold', 'wine', 'cherry', 'plum', 'slate', 'ivory']) {
    if (rejectCue(cue, 1)) fail(`"${cue}" should be a legal cue`, rejectCue(cue, 1).reason);
  }
  ok('ordinary evocative cues are not refused');
}

/* ── Setup and the role visibility matrix ────────────────────────────────── */
let s = fresh(4);
is('a game starts asking for the first cue', s.phase === 'clue1', s.phase);
const giver = s.turn.giverId;
const guesser = s.players.find((p) => p.id !== giver).id;
const other = s.players.find((p) => p.id !== giver && p.id !== guesser).id;
is('everyone starts on zero', Object.values(s.scores).every((n) => n === 0));

{
  const gv = G.deriveClientState(s, giver);
  const uv = G.deriveClientState(s, guesser);
  is('the Cue Giver is told the target', !!gv.turn.target && typeof gv.turn.targetHex === 'string');
  is('a guesser is NOT told the target', uv.turn.target === undefined);
  is('...nor its colour or label',
    uv.turn.targetHex === undefined && uv.turn.targetLabel === undefined,
    JSON.stringify({ hex: uv.turn.targetHex, label: uv.turn.targetLabel }));
  is('the giver knows they are the giver', gv.isGiver === true && uv.isGiver === false);
}

/* ── Cues in play ────────────────────────────────────────────────────────── */
s = act(s, 'cue', { text: 'blue' }, giver);
is('a colour cue never reaches the guessers', s.phase === 'clue1' && !s.turn.cue1);
is('...and the giver is told why', s.turn.rejected?.reason === 'colour');
is('...without the refused text being stored',
  !JSON.stringify(s.turn).includes('"blue"'),
  'storing it would put a rejected cue in everyone payload');

s = act(s, 'cue', { text: 'ocean' }, giver);
is('a legal cue moves the room to guessing', s.phase === 'guess1' && s.turn.cue1 === 'ocean');
is('a guesser cannot give the cue', act(s, 'cue', { text: 'reef' }, guesser).turn.cue1 === 'ocean');

/* ── SECRET TWO: nobody sees anyone else's marker ────────────────────────── */
s = act(s, 'place', { col: 2, row: 3 }, guesser);
s = act(s, 'place', { col: 9, row: 7 }, other);
{
  const mine = G.deriveClientState(s, guesser);
  is('a guesser gets their OWN marker back', !!mine.turn.markers[guesser]);
  is('a guesser does NOT see another player marker',
    mine.turn.markers[other] === undefined,
    'whoever locks in first would otherwise decide the round');
  is('the whole payload contains no other marker',
    Object.keys(mine.turn.markers).length === 1, JSON.stringify(mine.turn.markers));
  is('who has locked in IS public',
    Array.isArray(mine.turn.lockedIds), 'the "waiting for 2 more" line needs it');
}

is('the giver cannot place a marker', act(s, 'place', { col: 1, row: 1 }, giver).turn.markers[giver] === undefined);

/* ── Locking, and the phase advancing ───────────────────────────────────── */
const guessers = s.players.filter((p) => p.id !== giver).map((p) => p.id);
for (const id of guessers) if (id !== guesser && id !== other) s = act(s, 'place', { col: 5, row: 5 }, id);
s = act(s, 'lock', {}, guesser);
is('one lock does not advance the phase', s.phase === 'guess1');
for (const id of guessers) if (id !== guesser) s = act(s, 'lock', {}, id);
is('the last lock moves on to the second cue', s.phase === 'clue2', s.phase);
is('a locked marker cannot be moved',
  act(s, 'place', { col: 0, row: 0 }, guesser).turn.markers[guesser].a.col === 2);

s = act(s, 'cue', { text: 'ocean floor' }, giver);
is('the second cue must be two words', s.phase === 'guess2' && s.turn.cue2 === 'ocean floor');

const target = s.turn.target;
s = act(s, 'place', { col: target.col, row: target.row }, guesser);       // exact
for (const id of guessers) if (id !== guesser) s = act(s, 'place', { col: (target.col + 5) % COLS, row: target.row }, id);
for (const id of guessers) s = act(s, 'lock', {}, id);
is('the round reveals once everyone has locked', s.phase === 'reveal', s.phase);
is('the target is revealed to a guesser at the reveal',
  !!G.deriveClientState(s, guesser).turn?.target && !!s.lastTurn.targetHex);
is('an exact second marker scored three', s.lastTurn.breakdown[guesser].b.points === 3);
is('the guesser total is their two markers', s.scores[guesser] === s.lastTurn.breakdown[guesser].total);

/* ── Degenerate rounds ───────────────────────────────────────────────────── */
{
  let d = fresh(4);
  const g = d.turn.giverId;
  d = act(d, 'cue', { text: 'moss' }, g);
  const us = d.players.filter((p) => p.id !== g).map((p) => p.id);
  /* Everybody picks the same square. */
  for (const id of us) d = act(d, 'place', { col: 0, row: 0 }, id);
  for (const id of us) d = act(d, 'lock', {}, id);
  d = act(d, 'cue', { text: 'damp stone' }, g);
  for (const id of us) d = act(d, 'place', { col: 0, row: 0 }, id);
  for (const id of us) d = act(d, 'lock', {}, id);
  is('everyone picking the same square still resolves', d.phase === 'reveal', d.phase);
  is('the giver score is capped', d.lastTurn.giverPoints <= 6, String(d.lastTurn.giverPoints));
}

/* ── Hostile and careless input ──────────────────────────────────────────── */
{
  let h = fresh(4);
  const g = h.turn.giverId;
  h = act(h, 'cue', { text: 'moss' }, g);
  const u = h.players.find((p) => p.id !== g).id;
  const bad = [null, undefined, 'string', 42, [], { col: null, row: 0 }, { col: 99, row: 0 },
    { col: -1, row: 0 }, { col: 1.5, row: 2 }, { col: 'a', row: 'b' }, { col: 0 }];
  let threw = null;
  for (const payload of bad) {
    try { G.handleAction(h, 'place', payload, find(h, u)); } catch (e) { threw = `${JSON.stringify(payload)}: ${e.message}`; }
  }
  is('no marker payload throws', threw === null, threw || '');
  is('no out-of-range marker is accepted',
    bad.every((p) => {
      const r = G.handleAction(h, 'place', p, find(h, u));
      return !r || !r.turn.markers[u];
    }));
  let cueThrew = null;
  for (const payload of [null, undefined, { text: null }, { text: {} }, { text: 'x'.repeat(500) }]) {
    try { G.handleAction(h, 'cue', payload, find(h, g)); } catch (e) { cueThrew = e.message; }
  }
  is('no cue payload throws', cueThrew === null, cueThrew || '');
  is('an unknown action is ignored', G.handleAction(h, 'nonsense', {}, find(h, u)) === null);
}

/* ── People coming and going ─────────────────────────────────────────────── */
{
  let x = fresh(4);
  const g = x.turn.giverId;
  is('a blip does not end the turn', G.onPlayerDisconnect(x, find(x, g)) === null);

  x = act(x, 'cue', { text: 'moss' }, g);
  const us = x.players.filter((p) => p.id !== g).map((p) => p.id);
  /* One guesser drops. The rest must still be able to finish the phase. */
  x = { ...x, players: x.players.map((p) => (p.id === us[2] ? { ...p, connected: false } : p)) };
  for (const id of [us[0], us[1]]) x = act(x, 'place', { col: 3, row: 3 }, id);
  for (const id of [us[0], us[1]]) x = act(x, 'lock', {}, id);
  is('a dropped player does not hold the room', x.phase === 'clue2', x.phase);
}

/* ── Length ──────────────────────────────────────────────────────────────── */
{
  const small = G.deriveClientState(fresh(3, { rounds: 1 }), 'p0');
  is('a three-player game is three turns', small.totalTurns === 3, String(small.totalTurns));
  /*
    A turn here is four phases plus a reveal, so the cap is on TIME, and past
    eight players it deliberately costs "everyone gets to give the cues". A
    guesser taps and scores every round regardless, so nobody sits out — the
    alternative was a 20-player room committed to an hour.
  */
  for (const [n_, rounds] of [[8, 4], [16, 4], [20, 1], [12, 2]]) {
    const v = G.deriveClientState(fresh(n_, { rounds }), 'p0');
    is(`a ${n_}-player room is capped at 8 turns`, v.totalTurns <= 8, String(v.totalTurns));
  }
  const twenty = G.deriveClientState(fresh(20, { rounds: 1 }), 'p0');
  is('...and a big room still gets a full-length game', twenty.totalTurns === 8, String(twenty.totalTurns));
  const five = G.deriveClientState(fresh(5, { rounds: 1 }), 'p0');
  is('a room under the cap still gives everyone a turn', five.totalTurns === 5, String(five.totalTurns));
  is('three players is the floor', G.minPlayers === 3);
}

/* ── Labels people read out loud ─────────────────────────────────────────── */
{
  const labels = [];
  for (let r = 0; r < ROWS; r += 1) for (let c = 0; c < COLS; c += 1) labels.push(labelOf(c, r));
  is('every square has a label', labels.length === COLS * ROWS && labels.every(Boolean));
  is('...and no two squares share one', new Set(labels).size === labels.length);
  is('no column is unlabelled', !labels.some((l) => l.includes('?')),
    'COL_LETTERS must have one entry per column');

  /*
    I and O are out. "I9" reads as nineteen on a phone, in a game whose labels
    end in a row number and get said out loud constantly. Pack IDs on this site
    already leave both out.
  */
  is('no label uses the letter I', !labels.some((l) => l.startsWith('I')));
  is('no label uses the letter O', !labels.some((l) => l.startsWith('O')));
}

/* ── Nobody can strand the room ──────────────────────────────────────────────

   Every phase of this game waits on ONE specific person, which makes "that
   person put their phone down" the default way a party game dies. Three ways
   out, all checked here, because none of them is reachable from a screenshot.
*/
{
  const guessers = (s) => s.players.filter((p) => p.id !== s.turn.giverId);
  const toGuess1 = (n = 4) => {
    let s = fresh(n);
    return act(s, 'cue', { text: 'seasick' }, s.turn.giverId);
  };

  /*
    A. Someone never taps at all.

    The client auto-locks when the clock runs out, but only for a player who has
    PLACED something — a person who never touched the board is invisible to it.
    Before move_on existed, that player held the room open for as long as their
    tab stayed open, and there was no control anywhere that could pass them.
  */
  {
    let s = toGuess1();
    const gs = guessers(s);
    for (const g of gs.slice(0, 2)) {
      s = act(s, 'place', { col: 3, row: 3 }, g.id);
      s = act(s, 'lock', {}, g.id);
    }
    is('one silent player holds the phase', s.phase === 'guess1', s.phase);
    is('...and cannot be passed while the clock is running',
      G.handleAction(s, 'move_on', {}, find(s, gs[0].id)) === null);

    /* Wind the clock back past the deadline, as a real 60 seconds would. */
    s = { ...s, turn: { ...s.turn, startedAt: Date.now() - (s.guessSec + 30) * 1000 } };
    const moved = act(s, 'move_on', {}, gs[0].id);
    is('...but anyone can move on once it is spent', moved.phase === 'clue2', moved.phase);
  }

  /*
    B. The same person closes the tab instead.

    This was the unrecoverable one. Everyone else had already locked, and lockIn
    returns null once you are locked, so after the disconnect there was no action
    left in the game that could re-run the "is everyone done?" test. The room
    stayed on "3 of 4 locked in" forever.
  */
  {
    let s = toGuess1();
    const gs = guessers(s);
    for (const g of gs.slice(0, 2)) {
      s = act(s, 'place', { col: 3, row: 3 }, g.id);
      s = act(s, 'lock', {}, g.id);
    }
    const quitter = gs[2];
    s = { ...s, players: s.players.map((p) => (p.id === quitter.id ? { ...p, connected: false } : p)) };
    const after = G.onPlayerDisconnect(s, quitter) || s;
    is('a drop by the last player the room was waiting for advances it',
      after.phase === 'clue2', after.phase);
  }

  /* A drop that leaves work outstanding must NOT advance anything. */
  {
    let s = toGuess1();
    const gs = guessers(s);
    s = act(s, 'place', { col: 3, row: 3 }, gs[0].id);
    s = act(s, 'lock', {}, gs[0].id);
    const quitter = gs[2];
    s = { ...s, players: s.players.map((p) => (p.id === quitter.id ? { ...p, connected: false } : p)) };
    const after = G.onPlayerDisconnect(s, quitter) || s;
    is('a drop with someone still guessing changes nothing', after.phase === 'guess1', after.phase);
  }

  /* An empty room must not "advance" into a reveal with nobody in it. */
  {
    let s = toGuess1();
    s = { ...s, players: s.players.map((p) => ({ ...p, connected: false })) };
    is('a room everyone left is not advanced', G.onPlayerDisconnect(s, s.players[1]) === null);
  }

  /*
    C. The cue giver disappears before typing anything.

    No cue, no deadline anyone was watching, and cue is a giver-only action —
    so the room sat on "waiting for Ann to give a one-word cue" with no
    countdown and no control, indefinitely.
  */
  {
    let s = fresh(4);
    const giver = s.turn.giverId;
    const other = s.players.find((p) => p.id !== giver).id;
    is('the room starts in a cue phase', s.phase === 'clue1');
    is('a bystander cannot end a live cue phase',
      G.handleAction(s, 'move_on', {}, find(s, other)) === null);

    const gone = { ...s, players: s.players.map((p) => (p.id === giver ? { ...p, connected: false } : p)) };
    is('...but can once the giver has dropped',
      act(gone, 'move_on', {}, other).phase === 'reveal');

    const stale = { ...s, turn: { ...s.turn, startedAt: Date.now() - (s.guessSec + 30) * 1000 } };
    is('...or once the clock is spent', act(stale, 'move_on', {}, other).phase === 'reveal');

    is('the giver can always end their own turn', act(s, 'move_on', {}, giver).phase === 'reveal');
    is('an abandoned round still reveals the colour',
      typeof act(s, 'move_on', {}, giver).lastTurn.targetHex === 'string');
  }

  /* move_on is not a way to skip the reveal or restart a finished game. */
  {
    let s = toGuess1();
    const gs = guessers(s);
    for (const g of gs) { s = act(s, 'place', { col: 1, row: 1 }, g.id); s = act(s, 'lock', {}, g.id); }
    s = act(s, 'cue', { text: 'old hospital' }, s.turn.giverId);
    for (const g of gs) { s = act(s, 'place', { col: 1, row: 1 }, g.id); s = act(s, 'lock', {}, g.id); }
    is('the round reached the reveal', s.phase === 'reveal', s.phase);
    is('move_on does nothing at the reveal',
      G.handleAction(s, 'move_on', {}, find(s, gs[0].id)) === null);
  }

  /*
    The counter people read. lockedIds used to be every locked marker while the
    denominator was connected guessers only, so one drop made it read
    "3 of 2 locked in".
  */
  {
    let s = toGuess1();
    const gs = guessers(s);
    for (const g of gs) { s = act(s, 'place', { col: 2, row: 2 }, g.id); s = act(s, 'lock', {}, g.id); }
    let mid = toGuess1();
    const mg = guessers(mid);
    for (const g of mg) { mid = act(mid, 'place', { col: 2, row: 2 }, g.id); }
    for (const g of mg.slice(0, 2)) mid = act(mid, 'lock', {}, g.id);
    mid = { ...mid, players: mid.players.map((p) => (p.id === mg[0].id ? { ...p, connected: false } : p)) };
    const view = G.deriveClientState(mid, mg[1].id);
    const denom = mid.players.filter((p) => p.connected && p.id !== mid.turn.giverId).length;
    is('the locked count never exceeds the people being waited for',
      view.turn.lockedIds.length <= denom, `${view.turn.lockedIds.length} of ${denom}`);
  }
}

console.log('');
if (failures) { console.log(`hue match logic — ${failures} problem(s)`); process.exit(1); }
console.log('hue match logic — the target stays secret, and so does everyone else\'s guess');
