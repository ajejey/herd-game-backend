/*
  A turn whose clock has run out can always be ended, by anybody in the room.

    node scripts/stranded-turn-check.js

  ── The reports ──────────────────────────────────────────────────────────────

    17 Sep 2026, taboo BJZD 04:41: "timer gets stuck at zero"
    17 Sep 2026, taboo BJZD 04:42: "The round reached 0 but didn't continue to
                                    the next round"

  One minute apart, same room, two different people. Everyone in that room was
  watching a clock at zero that nothing could move.

  ── Why it happens, and why it is a whole class ──────────────────────────────

  This engine has NO server-side timers. A timed turn carries a `deadline` and
  ends when a client sends `end_turn`. That is a deliberate design — it keeps
  the server free of per-room wall-clock state, which is what makes a single
  Railway replica survive a restart with rooms intact.

  The cost is that some browser has to still be running. Taboo and Fishbowl let
  only ONE browser do it: the giver's. And the giver is the one person in the
  room who is not looking at their phone — they are talking, against a clock,
  describing a word. Mobile browsers throttle `setInterval` in a background tab
  and stop it altogether when the screen locks. Their clock never reaches zero,
  nobody else is permitted to advance, and the room sits there.

  Fishbowl was worse: its client latched an `endedRef` after one attempt, so a
  single `end_turn` lost to a reconnect was never retried. Fishbowl also has the
  lowest completion rate of any game on the site.

  ── The rule ─────────────────────────────────────────────────────────────────

  Anyone may end a turn once its deadline has PASSED. Before the deadline only
  the giver and the host may, because ending early is a deliberate act.

  The comparison happens on the SERVER's clock, which is the whole point: a
  player whose device clock runs fast believes the turn expired early, their
  request arrives early, and it is refused. No amount of client-side skew can
  cut somebody's turn short.

  ── What is checked ──────────────────────────────────────────────────────────
    1. for every game with a timed turn: a bystander CANNOT end it early
    2. ...and CAN end it once the deadline has passed
    3. the giver and the host keep their early end
    4. no other game module grows a `turn.deadline` without the same escape

  4 is the part that matters in six months: it fails for a game that does not
  exist yet.

  No database, no browser, no server.
*/
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { TabooGame } from '../src/games/taboo/game.js';
import { FishbowlGame } from '../src/games/fishbowl/game.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const GAMES_DIR = path.join(here, '..', 'src', 'games');

let failures = 0;
const fail = (m, d = '') => { console.log(`  FAIL  ${m}${d ? '\n          ' + d : ''}`); failures += 1; };
const ok = (m) => console.log(`  ok    ${m}`);

console.log('');
console.log('=== a turn at zero can always be ended ===');

function players(n) {
  return Array.from({ length: n }, (_, i) => ({
    id: 'p' + i, username: 'P' + i, connected: true, isHost: i === 0, score: 0, joinedAt: Date.now() + i,
  }));
}

/**
 * Drive one game to a started turn, then assert the rule from every seat.
 *
 * @param {string} name
 * @param {object} Game      the game module
 * @param {(state:object)=>object} toTurn  take a fresh started state to one
 *                                         with a live `turn`
 */
function check(name, Game, toTurn) {
  const ps = players(6);
  const base = {
    roomCode: 'TEST', hostId: 'p0', status: 'lobby', players: ps,
    ...Game.createInitialState({}), createdAt: Date.now(),
  };

  let state;
  try {
    state = toTurn(Game.onStart(base));
  } catch (err) {
    fail(`${name}: could not reach a turn`, err.message);
    return;
  }

  if (!state?.turn?.deadline) {
    fail(`${name}: reached no turn with a deadline`, 'the setup below has drifted from the game');
    return;
  }

  /*
    THE HOST MUST NOT BE THE GIVER, or half of this file tests nothing.

    p0 is the host, and in both games p0 is also the FIRST giver — team A is
    [p0, p2, p4] with giverIndex 0. So `host.id !== giver.id` was false, the
    host branch below quietly assigned `byHost = byGiver`, and the host was
    never passed to handleAction at all. Deleting the host exemption from
    either engine still printed "ok the giver and the host can still end early
    on purpose".

    A sweep that reports green on the thing it was written to protect is worse
    than no sweep. The host is moved off the giver's seat here rather than in
    the per-game setup so it cannot drift back when a game changes how it picks
    its first giver.
  */
  const offGiver = ps.find((p) => p.id !== state.turn.giverId);
  state = { ...state, hostId: offGiver.id };

  const giver = ps.find((p) => p.id === state.turn.giverId);
  const host = ps.find((p) => p.id === state.hostId);
  /* Somebody who is neither — the seat that was locked out entirely. */
  const bystander = ps.find((p) => p.id !== state.turn.giverId && p.id !== state.hostId);

  if (!giver || !host || !bystander || host.id === giver.id) {
    fail(`${name}: could not find three distinct seats to test from`);
    return;
  }

  /* 1. Early, a bystander may not. Ending a turn nobody asked to end is a
        real harm — it burns a card and costs their team the rest of the
        clock. */
  const early = Game.handleAction(state, 'end_turn', {}, bystander);
  if (early !== null) fail(`${name}: a bystander ended a turn that had not run out`);
  else ok(`${name}: a bystander cannot end a turn early`);

  /* 2. Once the deadline has passed, anyone may — this is the fix. */
  const expired = { ...state, turn: { ...state.turn, deadline: Date.now() - 1000 } };
  const late = Game.handleAction(expired, 'end_turn', {}, bystander);
  if (late === null) {
    fail(
      `${name}: NOBODY BUT THE GIVER CAN END AN EXPIRED TURN`,
      'if the giver\'s browser is asleep the room is stranded at 0s for ever — '
      + 'this is the Taboo BJZD report',
    );
  } else if (late.turn) {
    fail(`${name}: ending an expired turn left the turn in place`);
  } else {
    ok(`${name}: anyone can end a turn whose clock has run out`);
  }

  /* 3. The giver and the host keep their deliberate early end — a real thing
        they do, and now genuinely exercised from two distinct seats. */
  const byGiver = Game.handleAction(state, 'end_turn', {}, giver);
  const byHost = Game.handleAction(state, 'end_turn', {}, host);
  if (!byGiver) fail(`${name}: the giver can no longer end their own turn early`);
  else if (!byHost) fail(`${name}: the host can no longer end a turn early`);
  else ok(`${name}: the giver and the host can still end early on purpose`);

  /*
    4. AN AUTOMATIC END IS GATED ON THE CLOCK FOR EVERY SEAT, HOST INCLUDED.

    Every client now fires end_turn at ITS OWN zero, computed from the device's
    own clock. The host was exempt from the expiry check — harmless while only
    a deliberate press could reach it, and not harmless now: one host phone
    with a fast clock would silently cut every turn in the room short, which is
    the exact opposite of the bug this file exists for.
  */
  const autoEarlyHost = Game.handleAction(state, 'end_turn', { auto: true, deadline: state.turn.deadline }, host);
  const autoEarlyGiver = Game.handleAction(state, 'end_turn', { auto: true, deadline: state.turn.deadline }, giver);
  if (autoEarlyHost !== null || autoEarlyGiver !== null) {
    fail(
      `${name}: an AUTOMATIC end was accepted before the clock ran out`,
      'a device with a fast clock would cut every turn in the room short',
    );
  } else {
    ok(`${name}: an automatic end waits for the server's clock, from every seat`);
  }

  /*
    5. A REQUEST ABOUT A TURN THAT IS NO LONGER THE TURN IS IGNORED.

    socket.io buffers emits made while disconnected and flushes them on
    reconnect. A client retrying at 0s through a 30s network drop queues up
    eight of these; they arrive after the room has moved on, and without this
    they would kill the fresh turn — repeatedly, burning a card each time.
  */
  const stale = Game.handleAction(
    expired, 'end_turn', { auto: true, deadline: Number(expired.turn.deadline) - 99999 }, bystander,
  );
  if (stale !== null) {
    fail(
      `${name}: an end_turn naming a DIFFERENT turn was accepted`,
      'a retry flushed from the offline buffer would end the turn after the one it meant',
    );
  } else {
    ok(`${name}: an end_turn for a turn that has passed is ignored`);
  }
}

check('taboo', TabooGame, (s) => {
  const giverId = s.teams[s.currentTeam][s.giverIndex[s.currentTeam] % s.teams[s.currentTeam].length];
  const giver = s.players.find((p) => p.id === giverId);
  return TabooGame.handleAction(s, 'start_turn', {}, giver);
});

check('fishbowl', FishbowlGame, (s) => {
  let st = s;
  for (const p of st.players) {
    const words = Array.from({ length: st.wordsPerPlayer }, (_, i) => `${p.id}w${i}`);
    st = FishbowlGame.handleAction(st, 'submit_words', { words }, p) || st;
  }
  const giver = st.players.find((p) => p.id === (st.turn?.giverId ?? null))
    || st.players.find((p) => FishbowlGame.handleAction(st, 'start_turn', {}, p));
  return FishbowlGame.handleAction(st, 'start_turn', {}, giver) || st;
});

/* ── 4. No game grows a timed turn without the escape ─────────────────────── */

/*
  Source-level, and deliberately so: a game added next month cannot be driven
  by a setup written today, but it can still be READ. A module that gives a
  turn a deadline and then gates `end_turn` on identity alone is the exact
  shape of the bug, whatever the game is called.
*/
const modules = fs.readdirSync(GAMES_DIR, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => path.join(GAMES_DIR, e.name, 'game.js'))
  .filter((p) => fs.existsSync(p));

const stranded = [];
for (const file of modules) {
  const src = fs.readFileSync(file, 'utf8');
  /* A turn with a client-driven clock. */
  if (!/turn\s*:\s*\{[^}]*deadline\s*:/.test(src)) continue;
  if (!/case 'end_turn'/.test(src)) continue;

  const start = src.indexOf("case 'end_turn'");
  const after = src.slice(start);
  const next = after.slice(1).search(/\n\s{6}case '|\n\s{6}default\s*:/);
  const raw = next === -1 ? after : after.slice(0, next + 1);

  /*
    COMMENTS STRIPPED FIRST, and this is not fussiness.

    The first version of this sweep tested the raw text, and the mutation test
    that is supposed to prove it works quietly passed: removing the guard left
    the long comment ABOVE it, which explains the rule and therefore contains
    both "deadline" and "Date.now()". The check was reading its own
    documentation and calling it an implementation.

    Any source-level assertion has this failure mode, and it is worse than no
    assertion, because it reports green.
  */
  const body = raw.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');

  /* The escape: something in this case compares the deadline to now. */
  const hasEscape = /deadline/.test(body) && /Date\.now\(\)/.test(body);
  if (!hasEscape) stranded.push(path.relative(GAMES_DIR, file).replace(/\\/g, '/'));
}

if (stranded.length) {
  fail(
    `${stranded.length} game(s) gate end_turn on identity alone`,
    `${stranded.join(', ')} — a timed turn that only one player may end strands `
    + 'the whole room when that player\'s browser is asleep',
  );
} else {
  ok(`no game strands a room on one browser (${modules.length} modules read)`);
}

console.log('');
if (failures) { console.log(`stranded turns — ${failures} problem(s)\n`); process.exit(1); }
console.log('stranded turns — a clock at zero always has somebody who can move it\n');
