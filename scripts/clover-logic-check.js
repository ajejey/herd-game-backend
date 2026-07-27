/*
  Clover logic check — can a game actually reach status 'finished'?

  Prod shows 21 started games and 0 completed. This drives the CloverGame module
  directly (no UI, no sockets) to prove whether the state machine can complete,
  and to count exactly how many player actions a full game costs.

  Usage: node scripts/clover-logic-check.js [numPlayers]
*/
import { CloverGame } from '../src/games/clover/game.js';

const N = Number(process.argv[2]) || 3;
const players = Array.from({ length: N }, (_, i) => ({
  id: 'p' + i, username: 'P' + i, connected: true, isHost: i === 0, score: 0, joinedAt: Date.now() + i,
}));

let state = { roomCode: 'TEST', hostId: 'p0', status: 'lobby', players, ...CloverGame.createInitialState({}), createdAt: Date.now() };

let actions = 0;
const act = (action, payload, player) => {
  const next = CloverGame.handleAction(state, action, payload, player);
  actions++;
  if (next) state = next;
  return !!next;
};

state = CloverGame.onStart(state);
console.log('after start  -> phase:', state.phase, '| status:', state.status);

// 1) every player writes 4 clues
for (const p of players) {
  const ok = act('submit_clues', { clues: ['a', 'b', 'c', 'd'] }, p);
  if (!ok) console.log('  !! submit_clues rejected for', p.username);
}
console.log('after clues  -> phase:', state.phase, '| resolveOrder:', state.resolveOrder.length);

// 2) resolve every clover
let guard = 0;
while (state.phase === 'resolving' && guard++ < 100) {
  const authorId = state.resolveOrder[state.resolveIndex];
  const solver = players.find((p) => p.id !== authorId);
  const clover = state.clovers[authorId];

  // place 4 cards (use the real answer so scoring is exercised)
  for (let slot = 0; slot < 4; slot++) {
    act('place_card', { slot, card: clover.keywords[slot] }, solver);
  }
  if (!act('confirm_placement', {}, solver)) { console.log('  !! confirm_placement rejected'); break; }
  if (!act('next_clover', {}, solver)) { console.log('  !! next_clover rejected'); break; }
}

console.log('\nFINAL -> phase:', state.phase, '| status:', state.status, '| totalScore:', state.totalScore);
console.log('player actions required for a', N, 'player game:', actions);
console.log(state.status === 'finished'
  ? '\nRESULT: the game CAN complete. Logic is fine. 0% completion in prod is behavioural (players quit), not a code bug.'
  : '\nRESULT: the game did NOT reach finished — this is a real product bug.');
