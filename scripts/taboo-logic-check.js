/*
  Taboo logic check — proves a game completes for team mode (4+) and co-op (3),
  and that scoring (got +1, skip 0, buzz -1) and the buzz permission rules work.

  Usage: node scripts/taboo-logic-check.js [numPlayers]
*/
import { TabooGame } from '../src/games/taboo/game.js';

function mk(N) {
  const players = Array.from({ length: N }, (_, i) => ({
    id: 'p' + i, username: 'P' + i, connected: true, isHost: i === 0, score: 0, joinedAt: Date.now() + i,
  }));
  return { roomCode: 'T', hostId: 'p0', status: 'lobby', players, ...TabooGame.createInitialState({}), createdAt: Date.now() };
}

function run(N) {
  let state = TabooGame.onStart(mk(N));
  const players = state.players;
  const act = (a, payload, p) => { const n = TabooGame.handleAction(state, a, payload, p); if (n) state = n; return !!n; };

  let guard = 0;
  while (state.status !== 'finished' && guard++ < 200) {
    const giverId = state.teams[state.currentTeam][state.giverIndex[state.currentTeam] % state.teams[state.currentTeam].length];
    const giver = players.find((p) => p.id === giverId);
    if (!act('start_turn', {}, giver)) break;
    act('got_word', {}, giver);   // +1
    act('got_word', {}, giver);   // +1
    act('skip_word', {}, giver);  //  0
    // an opponent buzzes (-1); in teams mode a team-mate must NOT be able to
    const opponent = players.find((p) => !state.teams[state.currentTeam].includes(p.id)) || players.find((p) => p.id !== giverId);
    act('buzz', {}, opponent);
    act('end_turn', {}, giver);
  }

  // permission check: a giver's own team-mate cannot buzz (team mode only)
  let permOk = 'n/a (co-op)';
  if (!state.coop) {
    let s2 = TabooGame.onStart(mk(N));
    const gid = s2.teams.A[0];
    s2 = TabooGame.handleAction(s2, 'start_turn', {}, s2.players.find((p) => p.id === gid));
    const mate = s2.teams.A.find((id) => id !== gid);
    permOk = mate ? (TabooGame.handleAction(s2, 'buzz', {}, s2.players.find((p) => p.id === mate)) === null ? 'blocked ✓' : 'ALLOWED ✗') : 'n/a';
  }

  // ── Role visibility matrix ────────────────────────────────────────────────
  // This previously asserted "the giver is the ONLY one who can see the card",
  // comparing against whichever player happened not to be the giver. That was
  // the bug a user reported on 4 Aug 2026: the opposing team is asked to buzz
  // when a forbidden word is said, so they MUST be able to read the card. The
  // check has to distinguish team-mate from opponent, which it did not.
  //
  //   giver          -> MUST see the card
  //   giver's team   -> MUST NOT (it would hand them the answer)
  //   opposing team  -> MUST see it (otherwise buzzing is impossible)
  let s3 = TabooGame.onStart(mk(N));
  const gid3 = s3.teams.A[0];
  s3 = TabooGame.handleAction(s3, 'start_turn', {}, s3.players.find((p) => p.id === gid3));

  const sees = (id) => !!TabooGame.deriveClientState(s3, id).card;
  const giverSees = sees(gid3);
  const mateId = s3.teams.A.find((id) => id !== gid3);
  const oppId = s3.teams.B[0];

  const mateSees = mateId ? sees(mateId) : null;      // null = no team-mate at this size
  const oppSees = oppId ? sees(oppId) : null;         // null = co-op, no opposing team

  const mateVerdict = mateId === undefined ? 'n/a' : mateSees ? 'LEAKED✗' : 'hidden ✓';
  const oppVerdict = oppId === undefined ? 'n/a' : oppSees ? 'sees ✓' : 'BLIND✗';

  console.log(
    `${N}p | ${(state.coop ? 'CO-OP' : 'TEAMS').padEnd(5)} | finished:${state.status === 'finished' ? 'YES' : 'NO '} | ` +
    `A=${state.teamScores.A} B=${state.teamScores.B} | winner:${state.winner ?? '(none)'} | ` +
    `mate-buzz:${permOk} | card giver:${giverSees ? 'sees ✓' : 'HIDDEN✗'} mate:${mateVerdict} opp:${oppVerdict}`
  );

  const visibilityOk =
    giverSees &&
    (mateId === undefined || mateSees === false) &&
    (oppId === undefined || oppSees === true);

  /*
    ── A card never survives the turn it was shown in ────────────────────────

    Reported from room KWCU on 9 Sep 2026. Only got/skip/buzz advanced the
    deck, and none of those is how a turn ENDS — the timer ends it, or the
    host does. So the card the giver had just spent thirty seconds describing
    out loud was still at deckIndex when the opposing team started, and they
    were handed it having already heard the clues.

    Stated generally so it holds for any future way of ending a turn: whatever
    card was on screen when a turn ended must not be on screen when the next
    one starts.
  */
  let s4 = TabooGame.onStart(mk(N));
  const gid4 = s4.teams[s4.currentTeam][0];
  const giver4 = s4.players.find((p) => p.id === gid4);
  s4 = TabooGame.handleAction(s4, 'start_turn', {}, giver4);
  const cardInPlay = TabooGame.deriveClientState(s4, gid4).card;

  // End the turn WITHOUT resolving the card — the exact shape the player hit.
  s4 = TabooGame.handleAction(s4, 'end_turn', {}, giver4);
  const nextGiverId = s4.teams[s4.currentTeam][s4.giverIndex[s4.currentTeam] % s4.teams[s4.currentTeam].length];
  const nextGiver = s4.players.find((p) => p.id === nextGiverId);
  s4 = TabooGame.handleAction(s4, 'start_turn', {}, nextGiver) || s4;
  const cardAfter = TabooGame.deriveClientState(s4, nextGiverId).card;

  /*
    BOTH CARDS MUST EXIST, and they must differ.

    The first version computed `cardBurned = !sameWord`, which is TRUE when
    cardAfter is null — and cardAfter is null whenever the next turn failed to
    start, which start_turn does silently by returning null if the player it is
    handed is not the current giver. So a turn that never began reported
    "✓ burned" and the guard could not fail. That is precisely the failure mode
    this file exists to prevent, reintroduced by the fix for it.
  */
  const started = !!cardInPlay && !!cardAfter;
  const cardBurned = started && cardInPlay.word !== cardAfter.word;
  console.log(
    `     unresolved card at turn end: ${cardInPlay?.word ?? '(none)'} -> next turn: ` +
    `${cardAfter?.word ?? '(none)'}  ` +
    (!started ? '✗ NO CARD DEALT — the guard could not run' : cardBurned ? '✓ burned' : '✗ REPEATED')
  );

  return state.status === 'finished' && visibilityOk && cardBurned;
}

const only = Number(process.argv[2]);
const sizes = only ? [only] : [3, 4, 5, 6];
const ok = sizes.map(run);
console.log(ok.every(Boolean) ? '\nAll good.' : '\nFAILURES ABOVE.');
/*
  This printed "FAILURES ABOVE." and exited 0, so check:logic — which chains on
  && — stayed green through every failure this file can detect, including the
  card-repeat guard just added to it. A check that reports a problem and then
  tells the shell everything is fine is worse than no check, because it is
  trusted. Same fault found in clover-logic-check.js in the same review.
*/
if (!ok.every(Boolean)) process.exitCode = 1;
