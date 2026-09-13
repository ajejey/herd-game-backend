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
/*
  This branch only printed. check:logic chains on &&, so Clover becoming
  uncompletable — the exact 0%-completion disaster this script was written for —
  left `npm run check:all` green. Now that the file has an exit contract from
  the disconnect guard below, the older and more important half gets one too.
*/
if (state.status !== 'finished') process.exitCode = 1;

/*
  ── A clover you finished is played, awake or not ──────────────────────────

  Three players in room HRAL reported the same thing within ninety seconds on
  1 Sep 2026:

    "If any person refreshes or is randomly kicked out, when they come back
     into the game, it automatically skips their turn and we get zero points
     for that turn, as if we got all their words wrong!"

  enterResolving built resolveOrder from who was CONNECTED, so the list was a
  record of who happened to be online during one millisecond. A refresh is a
  disconnect. Their finished clover was dropped from the round, they came back
  to find it already gone, and the team lost the points.

  Fixed in 0a9c4dd (1 Sep 2026), but nothing here guarded it, so it could come
  back on any future edit to enterResolving and nobody would know until the
  next three reports.

  The general statement, which is what this asserts, and which is worth
  applying to any game with a submit-then-resolve shape: SUBMITTED WORK IS
  RESOLVED REGARDLESS OF CONNECTION. Being offline may cost you your own turn
  to act; it must never delete something you already did.
*/
{
  let s = { roomCode: 'DC', hostId: 'p0', status: 'lobby', players: players.map((p) => ({ ...p })), ...CloverGame.createInitialState({}), createdAt: Date.now() };
  s = CloverGame.onStart(s);

  const submit = (p) => {
    const cl = s.clovers[p.id];
    const next = CloverGame.handleAction(s, 'submit_clues', { clues: cl.keywords.map((k, i) => 'clue' + i) }, p);
    if (next) s = next;
  };

  /*
    ORDER MATTERS, and getting it wrong makes this check pass against the very
    code it is meant to catch. enterResolving runs once, at the moment the last
    player submits. The victim has to be OFFLINE at that instant — submit,
    drop, and let the others finish — which is exactly the shape a refresh
    takes in a real room. Dropping after everyone has submitted is too late:
    the order is already built and both versions keep them.
  */
  const victim = s.players[s.players.length - 1];
  submit(victim);
  const submitted = !!s.clovers[victim.id]?.submitted;

  s = { ...s, players: s.players.map((p) => (p.id === victim.id ? { ...p, connected: false } : p)) };
  if (CloverGame.onPlayerDisconnect) {
    s = CloverGame.onPlayerDisconnect(s, victim) || s;
  }

  for (const p of s.players) {
    if (p.id !== victim.id) submit(p);
  }

  const inOrder = (s.resolveOrder || []).includes(victim.id);
  const pass = submitted && inOrder;
  console.log(
    `\ndisconnect guard -> ${victim.username} submitted:${submitted} still in resolveOrder:${inOrder}  ` +
    (pass ? '✓ their clover survives the drop' : '✗ A FINISHED CLOVER WAS DELETED BY A DISCONNECT')
  );
  if (!pass) {
    console.log('   this is the HRAL bug returning — see 0a9c4dd');
    process.exitCode = 1;
  }
}
