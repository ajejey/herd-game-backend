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
