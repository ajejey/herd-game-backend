/*
  A dropped connection must never delete work a player has already done.

    node scripts/blip-check.js

  ── The report ───────────────────────────────────────────────────────────────
  Three players in Clover room HRAL, 1 Sep 2026, within ninety seconds, on
  three different devices:

    "If any person refreshes or is randomly kicked out, when they come back it
     automatically skips their turn and we get zero points for that turn, as if
     we got all their words wrong! We love this game, but the glitch is really
     sad sometimes"

  ── The shape of it ──────────────────────────────────────────────────────────
  Several games write a ROSTER INTO STATE — a running order, a team split, a
  list of subjects — and then read it for the rest of the game. Built by
  filtering on `p.connected`, that roster stops being "who is playing" and
  becomes "who happened to be online during one millisecond". A socket blip at
  that moment writes somebody out of the entire game, and reconnecting cannot
  undo it, because nothing ever rebuilds the list.

  It is a nasty one to notice: nothing throws, no error is logged, the game
  plays on perfectly for everyone else, and the person it happened to has no
  way to describe it except "it skipped me".

  Found in four games by the sweep this file replaced:

    clover     resolveOrder  — a submitted clover never played, scored zero
    fishbowl   teams         — on neither team: never gives, never guesses
    taboo      teams         — same, plus `coop` flipping a 5-player game to
                               co-op for everybody if two people blinked
    twotruths  subjects      — statements written, never shown

  Caveman Clues and Hue Match already carry fixes for exactly this, in their
  own words. That is the tell that it is a class and not four coincidences.

  ── Why this is a behaviour test and not a grep ──────────────────────────────
  The bad pattern is "a filter on connected whose result is persisted", and the
  difference between that and the many CORRECT uses of `p.connected` is what
  happens to the value afterwards — which a regex cannot see. So instead of
  reading the code, this drives each game: it disconnects one player at the
  moment the roster is built, reconnects them, and asks whether they are still
  in the game.

  The mirror-image rule is deliberately NOT tested here, because it pulls the
  other way and both matter: a question about who may act RIGHT NOW should be
  answered live, so that an absent player never freezes a room. Clover's
  submit_clues and Taboo's teamMembers keep their connected filters on purpose.

  No database, no browser, no server.
*/
import { CloverGame } from '../src/games/clover/game.js';
import { FishbowlGame } from '../src/games/fishbowl/game.js';
import { TabooGame } from '../src/games/taboo/game.js';
import { TwoTruthsGame } from '../src/games/twotruths/game.js';
import { CavemanCluesGame } from '../src/games/cavemanclues/game.js';
import { HueMatchGame } from '../src/games/huematch/game.js';

let failures = 0;
const fail = (m, d = '') => { console.log(`  FAIL  ${m}${d ? ' — ' + d : ''}`); failures += 1; };
const ok = (m) => console.log(`  ok    ${m}`);

/*
  A BLIP and a GHOST look identical on `connected` alone, and telling them
  apart is the whole difficulty — so the fixtures make the difference explicit
  the same way the engine does, with `disconnectedAt`.

    blipped  gone seconds ago   — a tunnel, a lock screen, a wifi handover
    ghost    gone long ago      — opened the lobby, closed the tab, never came
                                  back, and their row stays in state.players
                                  for the life of the room
*/
const GHOST_AGE_MS = 10 * 60 * 1000;
const blipped = (id) => ({ id, username: id, connected: false, disconnectedAt: Date.now(), score: 0 });
const ghost = (id) => ({ id, username: id, connected: false, disconnectedAt: Date.now() - GHOST_AGE_MS, score: 0 });
const here = (id) => ({ id, username: id, connected: true, score: 0 });

const players = (n, offline = null) =>
  Array.from({ length: n }, (_, i) => {
    const id = `p${i + 1}`;
    return id === offline ? blipped(id) : here(id);
  });


/*
  A room built the way the engine builds one.

  The first version called onStart() on a bare object, so game settings that
  live in createInitialState — totalRounds among them — were simply absent.
  `180 >= undefined` is false, so a Taboo game that finishes perfectly well
  looked unfinishable and the check reported a bug that was not there. The
  engine always spreads createInitialState into the room at create_game, so
  the fixture does too.
*/
const room = (Game, playerRows, settings = {}) => ({
  roomCode: 'TEST',
  hostId: playerRows[0].id,
  status: 'lobby',
  players: playerRows,
  ...Game.createInitialState(settings),
});

const base = (n, offline) => ({
  roomCode: 'TEST',
  hostId: 'p1',
  status: 'lobby',
  players: players(n, offline),
});

/* Apply one action as `who`, tolerating a game that declines it. */
const act = (game, state, action, payload, who) => {
  const player = state.players.find((p) => p.id === who);
  const next = game.handleAction(state, action, payload, player);
  return next || state;
};

/* Mark one player offline, leaving everything else alone. */
const drop = (s, id) => ({ ...s, players: s.players.map((p) => (
  p.id === id ? { ...p, connected: false, disconnectedAt: Date.now() } : p)) });

/*
  ORDER OF EVENTS IS THE WHOLE TEST, and the first version of this file got it
  wrong in a way that made three of its four game assertions vacuous.

  It had everybody submit while connected, THEN dropped p2, then called the
  host's force button. But these games auto-advance on the last submission —
  the roster was already built, with everyone present, and the drop came too
  late to matter. Restoring the original Clover bug did not fail the check.

  The real sequence, and the one the players in HRAL lived through, is:

      p2 does their work  ->  p2's socket blips  ->  the last submission from
      someone else trips the auto-advance  ->  the roster is written while p2
      is offline  ->  p2 comes back to a game that has forgotten them.

  So p2 submits FIRST, drops, and the others finish. `allDone` is satisfied by
  the still-connected players, which is correct and deliberate — see the note
  in Clover's submit_clues — and that is exactly what makes the roster get
  built at the worst possible moment.
*/
const GAMES = [
  {
    name: 'Clover — a submitted clover still gets played',
    field: 'resolveOrder',
    build: (offline) => {
      let s = CloverGame.onStart({ ...room(CloverGame, players(4, null)), status: 'playing' });
      /* the blipper does their work first… */
      s = act(CloverGame, s, 'submit_clues', { clues: ['a', 'b', 'c', 'd'] }, offline);
      s = drop(s, offline);                       // …then their socket goes
      for (const p of s.players.filter((x) => x.id !== offline)) {
        s = act(CloverGame, s, 'submit_clues', { clues: ['a', 'b', 'c', 'd'] }, p.id);
      }
      return s;                                   // the last submit trips enterResolving
    },
    holds: (s) => s.resolveOrder || [],
  },
  {
    name: 'Fishbowl — a blip at kickoff does not cost you a team',
    field: 'teams',
    build: (offline) => {
      let s = FishbowlGame.onStart({ ...room(FishbowlGame, players(4, null)), status: 'playing' });
      s = act(FishbowlGame, s, 'submit_words', { words: ['one', 'two', 'three'] }, offline);
      s = drop(s, offline);
      for (const p of s.players.filter((x) => x.id !== offline)) {
        s = act(FishbowlGame, s, 'submit_words', { words: ['one', 'two', 'three'] }, p.id);
      }
      return s;
    },
    holds: (s) => [...(s.teams?.A || []), ...(s.teams?.B || [])],
  },
  {
    name: 'Taboo — a blip at kickoff does not cost you a team',
    field: 'teams',
    build: (offline) => TabooGame.onStart({ ...room(TabooGame, players(4, offline)), status: 'playing' }),
    holds: (s) => [...(s.teams?.A || []), ...(s.teams?.B || [])],
  },
  {
    name: 'Two Truths — statements written are statements shown',
    field: 'subjects',
    build: (offline) => {
      let s = TwoTruthsGame.onStart({ ...room(TwoTruthsGame, players(4, null)), status: 'playing' });
      s = act(TwoTruthsGame, s, 'submit_statements', { statements: ['a', 'b', 'c'], lieIndex: 1 }, offline);
      s = drop(s, offline);
      for (const p of s.players.filter((x) => x.id !== offline)) {
        s = act(TwoTruthsGame, s, 'submit_statements', { statements: ['a', 'b', 'c'], lieIndex: 1 }, p.id);
      }
      return s;
    },
    holds: (s) => s.subjects || [],
  },
  {
    name: 'Caveman Clues — keeps its place in the rotation',
    field: 'giverOrder',
    build: (offline) => CavemanCluesGame.onStart({ ...room(CavemanCluesGame, players(4, offline)), status: 'playing' }),
    holds: (s) => s.giverOrder || [],
  },
  {
    name: 'Hue Match — keeps its place in the rotation',
    field: 'giverOrder',
    build: (offline) => HueMatchGame.onStart({ ...room(HueMatchGame, players(4, offline)), status: 'playing' }),
    holds: (s) => s.giverOrder || [],
  },
];

console.log('');
console.log('=== a dropped connection does not delete a player ===');

for (const g of GAMES) {
  let state;
  try {
    state = g.build('p2');
  } catch (e) {
    fail(`${g.name}: threw while building`, e.message.slice(0, 90));
    continue;
  }

  const roster = g.holds(state);
  if (!Array.isArray(roster) || roster.length === 0) {
    fail(`${g.name}: ${g.field} never got built`, JSON.stringify(roster));
    continue;
  }

  /*
    p2 comes back. The roster is already written; nothing rebuilds it. So the
    only question that matters is whether it remembered them.
  */
  if (!roster.includes('p2')) {
    fail(`${g.name}`,
      `p2 blipped and is missing from ${g.field} for the rest of the game `
      + `(${g.field} = ${JSON.stringify(roster)})`);
    continue;
  }
  /* And nobody else was lost while we were at it. */
  const missing = state.players.map((p) => p.id).filter((id) => !roster.includes(id));
  if (missing.length) {
    fail(`${g.name}: others are missing from ${g.field}`, missing.join(', '));
    continue;
  }
  ok(`${g.name} (${g.field}: ${roster.length}/${state.players.length})`);
}

/*
  Taboo and Fishbowl carry a second casualty: `coop` is decided by a head count
  at the same instant, so two people blinking together turned a five-player
  game into co-op mode — permanently, for everybody, including the four who
  never dropped.
*/
for (const [label, game] of [['Taboo', TabooGame], ['Fishbowl', FishbowlGame]]) {
  const twoOffline = {
    ...base(5, null),
    status: 'playing',
    players: ['p1','p2','p3','p4','p5'].map((id) => (['p2','p3'].includes(id) ? blipped(id) : here(id))),
  };
  let s = game.onStart(twoOffline);
  if (label === 'Fishbowl') {
    for (const p of s.players) s = act(game, s, 'submit_words', { words: ['a', 'b', 'c'] }, p.id);
    s = act(game, s, 'force_begin', {}, 'p1');
  }
  if (s.coop === true) {
    fail(`${label}: two blips turned a 5-player game into co-op`,
      'and it stays that way for the rest of the game');
  } else {
    ok(`${label}: two blips do not silently change the game mode`);
  }
}

/*
  ── The other direction, which the first version of this file did not test ───

  Fixing "a blip must not lose your place" by building rosters from
  `state.players` looks right and is not, because THAT LIST NEVER SHRINKS.
  Disconnect only clears `connected`; leaving just drops the socket. Anyone who
  opened the lobby and closed their tab is on it for the rest of the room's
  life.

  So the first fix handed teams to lobby ghosts, and /code-review caught what
  this file had missed: five open a Taboo lobby, two wander off, three start
  (still >= minPlayers) — the roster says five, `coop` comes out false, and the
  two who left can be the whole of team B. Team B never takes a turn,
  turnsTaken.B stays 0, and the done test can never be satisfied. Forty turns
  in: still playing, {A:120, B:0}. An unfinishable room, which is a worse bug
  than the one being fixed.

  A check that only pulls one way will happily wave the opposite mistake
  through. So both directions are asserted here, together.
*/
const ghosts = (present, gone) => [...present.map(here), ...gone.map(ghost)];

for (const [label, game, begin] of [
  ['Taboo', TabooGame, (s) => TabooGame.onStart(s)],
  ['Fishbowl', FishbowlGame, (s) => {
    let t = FishbowlGame.onStart(s);
    for (const p of t.players.filter((x) => x.connected)) {
      t = act(FishbowlGame, t, 'submit_words', { words: ['a', 'b'] }, p.id);
    }
    return act(FishbowlGame, t, 'force_begin', {}, t.players.find((p) => p.connected).id);
  }],
]) {
  /* Three real players; two ghosts who opened the lobby and left. */
  const s = begin({ ...room(game, ghosts(['p0', 'p2', 'p4'], ['p1', 'p3'])), status: 'playing' });

  const onTeam = new Set([...(s.teams?.A || []), ...(s.teams?.B || [])]);
  const ghostOnTeam = ['p1', 'p3'].filter((id) => onTeam.has(id));
  if (ghostOnTeam.length) {
    fail(`${label}: lobby ghosts were given teams`,
      `${ghostOnTeam.join(', ')} never connected but are on a team — `
      + `teams = ${JSON.stringify(s.teams)}`);
    continue;
  }

  /* Three present players is under the two-team threshold, so this must be a
     co-op game. Counting the ghosts made it 2-v-1 against nobody. */
  if (s.coop !== true) {
    fail(`${label}: three real players were not put in co-op`,
      `two lobby ghosts pushed it over the 4-player threshold (coop=${s.coop}, `
      + `teams = ${JSON.stringify(s.teams)})`);
    continue;
  }

  /* And every present player must have somewhere to play. */
  const live = (t) => (s.teams[t] || []).filter((id) => s.players.find((p) => p.id === id && p.connected));
  if (live('A').length === 0) {
    fail(`${label}: the starting team has nobody in it`, 'no giver exists, so no action is possible');
    continue;
  }
  ok(`${label}: lobby ghosts get no team, and three real players play co-op`);
}

/*
  Taboo can be driven to its finish, so the strongest form of the above is
  simply: does the game END? An unfinishable room is the failure mode that
  matters, and it is cheap to check directly rather than by proxy.
*/
{
  let s = TabooGame.onStart({ ...room(TabooGame, ghosts(['p0', 'p2', 'p4'], ['p1', 'p3'])), status: 'playing' });
  for (let i = 0; i < 60 && s.status !== 'finished'; i += 1) {
    for (const p of s.players) {
      s = act(TabooGame, s, 'start_turn', {}, p.id);
      s = act(TabooGame, s, 'end_turn', {}, p.id);
    }
  }
  if (s.status !== 'finished') {
    fail('Taboo: a room with lobby ghosts never finishes',
      `status=${s.status} turnsTaken=${JSON.stringify(s.turnsTaken)} — `
      + 'the score they are playing towards is unreachable');
  } else {
    ok('Taboo: a room with lobby ghosts still reaches its final score');
  }
}

/*
  And the repair: a player who blips at kickoff and comes back must be given a
  team, since the roster is now built from who was present.
*/
for (const [label, game] of [['Taboo', TabooGame], ['Fishbowl', FishbowlGame]]) {
  /* p3 blipped at kickoff — recently, so they still count as playing. */
  let s = { ...room(game, [...['p0', 'p1', 'p2'].map(here), blipped('p3')]), status: 'playing' };
  s = game.onStart(s);
  if (label === 'Fishbowl') {
    for (const p of s.players.filter((x) => x.connected)) {
      s = act(game, s, 'submit_words', { words: ['a', 'b'] }, p.id);
    }
    s = act(game, s, 'force_begin', {}, 'p0');
  }
  /* p3 comes back and does something. */
  s = { ...s, players: s.players.map((p) => ({ ...p, connected: true })) };
  s = act(game, s, 'start_turn', {}, 'p0');
  const onTeam = new Set([...(s.teams?.A || []), ...(s.teams?.B || [])]);
  if (!onTeam.has('p3')) {
    fail(`${label}: a player who blipped at kickoff never gets a team back`,
      `teams = ${JSON.stringify(s.teams)}`);
  } else {
    ok(`${label}: a player who blipped at kickoff is put back on a team when they return`);
  }
}

/*
  A team can also empty out AFTER the teams are settled — two of four people
  simply leave — and then the finish line moves out of reach for the pair still
  playing. That hole predates the roster work: endTurn already refuses to hand
  play to an empty team, but the done test still demanded turnsTaken.B reach
  totalRounds, which cannot happen if nobody is left on B.

  Kept as its own case because the ghost assertions above stop at the first
  failure, so a regression here was masked by them the first time it was tried.
*/
{
  let s = TabooGame.onStart({
    ...room(TabooGame, ['p0', 'p1', 'p2', 'p3'].map(here)), status: 'playing',
  });
  /*
    ONE turn at a time. The first attempt looped every player through
    start_turn/end_turn twice, which quietly played eight turns and took both
    teams to totalRounds BEFORE anyone left — so the walk-out never happened
    and the case passed while testing nothing at all. Advancing by exactly one
    turn keeps the scenario the one being claimed.
  */
  const oneTurn = (st) => {
    for (const p of st.players) {
      const after = act(TabooGame, st, 'start_turn', {}, p.id);
      if (after !== st) return act(TabooGame, after, 'end_turn', {}, p.id);
    }
    return st;
  };

  if (s.coop) {
    fail('Taboo: four connected players should not be co-op', 'fixture no longer sets up two teams');
  } else {
    s = oneTurn(s);                       // team A takes one turn, everyone present
    /*
      …then one whole team leaves, for good, well short of their rounds —
      through onPlayerDisconnect, which is how the engine reports it. Mutating
      the rows alone would skip the hook the fix lives in and test a path the
      server never takes.
    */
    const teamB = [...s.teams.B];
    for (const id of teamB) {
      s = { ...s, players: s.players.map((p) => (p.id === id ? ghost(p.id) : p)) };
      const gone = s.players.find((p) => p.id === id);
      s = TabooGame.onPlayerDisconnect(s, gone) || s;
    }
    if (s.turnsTaken.B >= s.totalRounds) {
      fail('Taboo: fixture let team B finish before walking out',
        `turnsTaken=${JSON.stringify(s.turnsTaken)} — the walk-out is not being tested`);
    }

    for (let i = 0; i < 40 && s.status !== 'finished'; i += 1) {
      const before = s;
      s = oneTurn(s);
      if (s === before) break;   // nobody can move — that is the stuck room
    }
    if (s.status !== 'finished') {
      fail('Taboo: when a whole team walks out, the survivors can never finish',
        `status=${s.status} turnsTaken=${JSON.stringify(s.turnsTaken)} — `
        + 'the remaining players are locked out of their own final score');
    } else {
      ok('Taboo: the game still finishes when a whole team walks out mid-game');
    }
  }
}

console.log('');
if (failures) { console.log(`blip — ${failures} problem(s)\n`); process.exit(1); }
console.log('blip — a flicker costs you nothing, and a ghost is given nothing\n');
