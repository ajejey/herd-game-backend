/*
  Fishbowl logic check — proves a game completes for both team mode (4+) and
  the new co-op mode (3 players), and reports how long a game actually is.

  Prod showed 43% of rooms ever starting and only 22% of started games
  finishing, so length and the 4-player minimum both mattered.

  Usage: node scripts/fishbowl-logic-check.js [numPlayers]
*/
import { FishbowlGame } from '../src/games/fishbowl/game.js';

function run(N) {
  const players = Array.from({ length: N }, (_, i) => ({
    id: 'p' + i, username: 'P' + i, connected: true, isHost: i === 0, score: 0, joinedAt: Date.now() + i,
  }));
  let state = { roomCode: 'TEST', hostId: 'p0', status: 'lobby', players, ...FishbowlGame.createInitialState({}), createdAt: Date.now() };
  let actions = 0;
  const act = (a, payload, player) => {
    const next = FishbowlGame.handleAction(state, a, payload, player);
    actions++;
    if (next) state = next;
    return !!next;
  };

  state = FishbowlGame.onStart(state);
  const words = state.wordsPerPlayer;
  for (const p of players) act('submit_words', { words: Array.from({ length: words }, (_, i) => `${p.id}w${i}`) }, p);

  const bowlSize = state.allWords.length;
  let guard = 0;
  while (state.status !== 'finished' && guard++ < 500) {
    const giverId = state.teams[state.currentTeam][state.giverIndex[state.currentTeam] % state.teams[state.currentTeam].length];
    const giver = players.find((p) => p.id === giverId);
    if (!act('start_turn', {}, giver)) break;
    // guess everything the giver can in one turn
    let safety = 0;
    while (state.turn && state.status !== 'finished' && safety++ < 100) {
      if (!act('got_word', {}, giver)) break;
    }
    if (state.turn) act('end_turn', {}, giver);
  }

  const mode = state.coop ? 'CO-OP' : 'TEAMS';
  console.log(
    `${N} players | ${mode.padEnd(6)} | bowl ${String(bowlSize).padStart(2)} words | ` +
    `finished: ${state.status === 'finished' ? 'YES' : 'NO '} | ` +
    `score A=${state.teamScores.A} B=${state.teamScores.B} | winner: ${state.winner ?? '(none)'} | ` +
    `${actions} actions`
  );
  return state.status === 'finished';
}

const only = Number(process.argv[2]);
const sizes = only ? [only] : [3, 4, 5, 6, 8];
const results = sizes.map(run);
console.log(results.every(Boolean) ? '\nAll sizes complete correctly.' : '\nSOME SIZES FAILED TO COMPLETE.');
/*
  Third script in this directory found printing a failure and exiting 0, so
  check:logic stayed green through it. Worth stating as the general rule rather
  than fixing three files and moving on: A CHECK THAT CANNOT FAIL THE SUITE IS
  DOCUMENTATION, NOT A CHECK — and it is the most dangerous kind, because the
  green tick is read as evidence.

  Fishbowl is the game this matters most for right now: 25% of started games
  finished in the 14 days to 13 Sep 2026, against a ~90% norm. If that is a
  logic fault rather than players quitting, this is the script that would say
  so, and until now it could only have said it to a log nobody reads.
*/
if (!results.every(Boolean)) process.exitCode = 1;

/* ── One word, one resolution ─────────────────────────────────────────────── */

/*
  18 Sep 2026, room ZZSN, reported against Taboo: "multiple people buzzing at
  the same time all take effect and skip multiple words."

  It is the same defect here. got_word and skip_word each take the front of the
  bowl and neither said WHICH word it meant, so a double-tapped "Got it!" scored
  twice for one word and burned a word nobody read — and a burst flushed from
  socket.io's offline buffer on reconnect did it several times over.

  TESTING.md is binding: a bug that reaches a user becomes an invariant for
  every game, not a fix in the one that was reported. Fishbowl has the lowest
  completion rate on the site, so it is the last game that should keep it.
*/
function mkFb(N) {
  const players = Array.from({ length: N }, (_, i) => ({
    id: 'p' + i, username: 'P' + i, connected: true, isHost: i === 0, score: 0, joinedAt: Date.now() + i,
  }));
  return {
    roomCode: 'F', hostId: 'p0', status: 'lobby', players,
    ...FishbowlGame.createInitialState({}), createdAt: Date.now(),
  };
}

function startedFishbowl(N) {
  let s = FishbowlGame.onStart(mkFb(N));
  for (const p of s.players) {
    const words = Array.from({ length: s.wordsPerPlayer }, (_, i) => `${p.id}w${i}`);
    s = FishbowlGame.handleAction(s, 'submit_words', { words }, p) || s;
  }
  const giver = s.players.find((p) => p.id === (s.turn?.giverId ?? null))
    || s.players.find((p) => FishbowlGame.handleAction(s, 'start_turn', {}, p));
  s = FishbowlGame.handleAction(s, 'start_turn', {}, giver) || s;
  return { state: s, giver };
}

{
  const { state, giver } = startedFishbowl(4);
  const bowlBefore = state.wordsLeft ?? state.bowl.length;
  const scoreBefore = state.teamScores[state.currentTeam];

  /* Two taps naming the SAME bowl — a double-tap, or a flushed buffer. */
  let after = state;
  let applied = 0;
  for (let i = 0; i < 3; i += 1) {
    const next = FishbowlGame.handleAction(after, 'got_word', { bowlSize: bowlBefore }, giver);
    if (next) { after = next; applied += 1; }
  }

  const consumed = bowlBefore - after.bowl.length;
  const gained = after.teamScores[after.currentTeam] - scoreBefore;
  console.log(`\n  triple "Got it" on one word: consumed=${consumed} (want 1), scored=${gained} (want 1), applied=${applied}`);
  if (consumed !== 1 || gained !== 1) {
    console.log('  FAIL  one word was resolved more than once');
    process.exitCode = 1;
  } else {
    console.log('  ok    one word, one point');
  }

  /* An older client that sends no bowlSize still works — deploy safety. */
  const legacy = FishbowlGame.handleAction(after, 'got_word', {}, giver);
  if (legacy === null) {
    console.log('  FAIL  a client that sends no bowlSize was refused');
    process.exitCode = 1;
  } else {
    console.log('  ok    a client that sends no bowlSize is unaffected');
  }

  /* Malformed input must be ignored, not coerced to bowl size 0. */
  let coerced = 0;
  for (const value of [null, '', false]) {
    if (FishbowlGame.handleAction(after, 'got_word', { bowlSize: value }, giver) === null) coerced += 1;
  }
  if (coerced) {
    console.log('  FAIL  a malformed bowlSize was read as a real bowl and refused');
    process.exitCode = 1;
  } else {
    console.log('  ok    a malformed bowlSize is ignored, not read as bowl 0');
  }
}

/* ── A rematch is a different game ────────────────────────────────────────── */

/*
  Same 18 Sep report: "if you start a new game then the order of the people
  taking a turn is not randomised and is the same." The roster arrived in join
  order and teams were dealt i % 2, so the same group got the same teams and the
  same opening giver every game.
*/
{
  const seen = new Set();
  for (let i = 0; i < 40; i += 1) {
    const { state } = startedFishbowl(6);
    seen.add(JSON.stringify(state.teams.A) + '|' + (state.turn?.giverId ?? ''));
  }
  console.log(`\n  rematch seating: ${seen.size} distinct arrangements in 40 starts`);
  if (seen.size < 5) {
    console.log('  FAIL  the same people get the same teams and the same first giver every game');
    process.exitCode = 1;
  } else {
    console.log('  ok    teams and the opening giver vary between games');
  }
}
