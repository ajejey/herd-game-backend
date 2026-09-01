import { shuffledDeck } from './tabooCards.js';
import { playingRoster } from '../roster.js';

/*
  Taboo on the engine.

  One player describes the target word to their team WITHOUT saying any of the
  five forbidden words. The other team watches for slips and can BUZZ — that
  buzz is what makes it Taboo rather than charades-with-words, and it keeps the
  non-active team engaged instead of spectating.

  Turn: giver starts, then per card -> got it (+1), skip (0), or buzzed by the
  other team (-1). Turn ends when the timer runs out (client-driven, like our
  other games — no server timers) or the giver ends it. Teams alternate; most
  points after N rounds each wins.

  With 3 players there aren't two teams, so we fall back to CO-OP: one shared
  score, giver rotates, everyone else guesses (same approach as Fishbowl).
*/
const DEFAULT_TURN_SEC = 60;
const DEFAULT_ROUNDS = 3; // turns per team

export const TabooGame = {
  minPlayers: 3,

  createInitialState(settings = {}) {
    const r = Number(settings.rounds);
    const t = Number(settings.turnSec);
    return {
      phase: null, // 'playing'
      coop: false,
      turnSec: Number.isInteger(t) && t >= 30 && t <= 180 ? t : DEFAULT_TURN_SEC,
      totalRounds: Number.isInteger(r) && r >= 1 && r <= 8 ? r : DEFAULT_ROUNDS,
      teams: { A: [], B: [] },
      teamScores: { A: 0, B: 0 },
      deck: [],
      deckIndex: 0,
      currentTeam: 'A',
      giverIndex: { A: 0, B: 0 },
      turnsTaken: { A: 0, B: 0 },
      turn: null,      // { giverId, deadline, got, skipped, buzzed }
      lastTurn: null,  // { team, giverId, got, buzzed }
      winner: null,
    };
  },

  onStart(state) {
    /*
      Teams come from playingRoster() — here, or away for only a moment — and
      ensureTeamed() puts back anyone who returns after that.

      Both obvious answers are wrong, and each has shipped:

      `p.connected` alone strands a player whose socket blipped during the
      countdown: no team, no turn, permanently, because the list is written
      once. That is the shape three Clover players reported on 1 Sep 2026.

      `state.players` alone — the first attempt at this fix — hands teams to
      LOBBY GHOSTS, because that array never shrinks. Five open a lobby, two
      wander off, three start (still >= minPlayers): the roster says five,
      `coop` comes out false, and the two who left can be the whole of team B.
      Team B never takes a turn, turnsTaken.B stays 0, and the done test below
      cannot be satisfied. Verified on the module: forty turns in, still
      playing, {A:120, B:0}. An unfinishable room — worse than the bug it was
      introduced to fix, and caught by /code-review rather than by the check
      that was supposed to cover this.

      What separates the two is TIME, which the engine already records as
      `disconnectedAt`. See games/roster.js.
    */
    const roster = playingRoster(state);
    const coop = roster.length < 4;
    const teams = { A: [], B: [] };
    if (coop) roster.forEach((p) => teams.A.push(p.id));
    else roster.forEach((p, i) => teams[i % 2 === 0 ? 'A' : 'B'].push(p.id));
    return {
      ...state,
      status: 'playing',
      phase: 'playing',
      coop,
      teams,
      teamScores: { A: 0, B: 0 },
      deck: shuffledDeck(),
      deckIndex: 0,
      currentTeam: 'A',
      giverIndex: { A: 0, B: 0 },
      turnsTaken: { A: 0, B: 0 },
      turn: null,
      lastTurn: null,
      winner: null,
    };
  },

  handleAction(state, action, payload, player) {
    /* Put returning players back on a team before anything reads the teams. */
    state = ensureTeamed(state);
    switch (action) {
      case 'start_turn': {
        if (state.phase !== 'playing' || state.turn) return null;
        if (player.id !== currentGiverId(state)) return null;
        return { ...state, turn: { giverId: player.id, deadline: Date.now() + state.turnSec * 1000, got: 0, skipped: 0, buzzed: 0 } };
      }

      case 'got_word': {
        if (!state.turn || player.id !== state.turn.giverId) return null;
        return scoreCard(state, +1, { got: 1 });
      }

      case 'skip_word': {
        if (!state.turn || player.id !== state.turn.giverId) return null;
        return scoreCard(state, 0, { skipped: 1 });
      }

      case 'buzz': {
        // Mirrors card visibility above: you may only buzz what you can see.
        // That means the opposing team and nobody else — not the giver, not the
        // giver's guessing team, and not co-op (where everyone else is guessing,
        // so there is no one holding the card to police it).
        if (!state.turn || state.coop) return null;
        if (player.id === state.turn.giverId) return null;
        const opposing = state.currentTeam === 'A' ? 'B' : 'A';
        if (!state.teams[opposing]?.includes(player.id)) return null;
        return scoreCard(state, -1, { buzzed: 1 });
      }

      case 'end_turn': {
        if (!state.turn) return null;
        if (player.id !== state.turn.giverId && player.id !== state.hostId) return null;
        return endTurn(state);
      }

      default:
        return null;
    }
  },

  deriveClientState(state, playerId) {
    const base = { ...state, players: state.players.map(({ socketId, ...rest }) => rest) };
    base.currentGiverId = currentGiverId(state);
    base.cardsLeft = Math.max(0, state.deck.length - state.deckIndex);

    // Who may see the card during a turn?
    //   - the giver, obviously: they are describing it
    //   - the OPPOSING team, because policing the forbidden words IS their job.
    //     Without the card in front of them the buzz button is unusable — they
    //     cannot know what counts as a slip.
    // Never the giver's own team: they are the ones guessing, and the card
    // would hand them the answer.
    base.card = null;
    if (state.turn) {
      const isGiver = playerId === state.turn.giverId;
      const opposing = state.currentTeam === 'A' ? 'B' : 'A';
      const onOpposingTeam = !state.coop && !!state.teams[opposing]?.includes(playerId);
      if (isGiver || onOpposingTeam) base.card = state.deck[state.deckIndex] || null;
    }
    delete base.deck;
    return base;
  },

  onPlayerDisconnect(state, player) {
    if (state.turn && player?.id === state.turn.giverId) return endTurn(state);
    /*
      THE TEAM WHOSE TURN IT IS HAS JUST EMPTIED, AND NOBODY CAN MOVE.

      start_turn requires being the current giver, and currentGiverId returns
      null when no member of the current team is connected — so no player, host
      included, has a legal action. Only endTurn hands play to the other team,
      and endTurn needs a turn to have started. The room sits there for good.

      Found by blip-check.js while testing something else: four players, team B
      walks out, and the two still playing are locked out of their own final
      score at turnsTaken {A:1, B:0}. It predates the roster work — a team could
      always empty mid-game — but it is the same failure the rest of this file
      exists to prevent, so it is closed here.

      Forfeiting the empty team's turn is the honest resolution: they are not
      coming back, and the alternative is a room nobody can finish.
    */
    if (state.phase === 'playing' && !state.turn
        && teamMembers(state, state.currentTeam).length === 0) {
      return endTurn(state);
    }
    return null;
  },
};

// ── helpers ──────────────────────────────────────────────────────────────────

/*
  The other half of the team rule: anyone connected who is on no team gets one.

  onStart builds the teams from whoever is present, which keeps lobby ghosts
  out and gets the co-op threshold right. That alone would strand a player who
  blipped during the countdown, so this puts them back the moment they act —
  into the smaller team, so a late return cannot lopside the game.

  Lazily applied rather than driven by a reconnect hook because the engine does
  not have one: a rejoin restores the socket and flips `connected`, and nothing
  tells the game about it. Every action passing through here is enough.
*/
function ensureTeamed(state) {
  if (!state.teams) return state;
  const onTeam = new Set([...state.teams.A, ...state.teams.B]);
  const missing = state.players.filter((p) => p.connected && !onTeam.has(p.id));
  if (missing.length === 0) return state;
  const teams = { A: [...state.teams.A], B: [...state.teams.B] };
  for (const p of missing) {
    if (state.coop) teams.A.push(p.id);
    else (teams.A.length <= teams.B.length ? teams.A : teams.B).push(p.id);
  }
  return { ...state, teams };
}

function teamMembers(state, team) {
  return state.teams[team].filter((id) => state.players.find((p) => p.id === id && p.connected));
}

function currentGiverId(state) {
  const members = teamMembers(state, state.currentTeam);
  if (members.length === 0) return null;
  return members[state.giverIndex[state.currentTeam] % members.length];
}

// Advance the deck and apply a score delta to the giver's team.
function scoreCard(state, delta, counters) {
  const team = state.currentTeam;
  const teamScores = { ...state.teamScores, [team]: state.teamScores[team] + delta };
  const turn = {
    ...state.turn,
    got: state.turn.got + (counters.got || 0),
    skipped: state.turn.skipped + (counters.skipped || 0),
    buzzed: state.turn.buzzed + (counters.buzzed || 0),
  };
  let deckIndex = state.deckIndex + 1;
  let deck = state.deck;
  if (deckIndex >= deck.length) { deck = shuffledDeck(); deckIndex = 0; } // recycle, never run dry
  return { ...state, teamScores, turn, deck, deckIndex };
}

function endTurn(state) {
  const team = state.currentTeam;
  const lastTurn = state.turn
    ? { team, giverId: state.turn.giverId, got: state.turn.got, buzzed: state.turn.buzzed }
    : state.lastTurn;
  const turnsTaken = { ...state.turnsTaken, [team]: state.turnsTaken[team] + 1 };
  const giverIndex = { ...state.giverIndex, [team]: state.giverIndex[team] + 1 };

  const other = team === 'A' ? 'B' : 'A';
  const hasOther = teamMembers(state, other).length > 0;
  const nextTeam = hasOther ? other : team;

  /*
    Everyone has taken their rounds → finish.

    A team with nobody left in it cannot take a turn, so requiring it to reach
    totalRounds is requiring something that will never happen — the room plays
    on for ever with the survivors, and the final score they are working
    towards is unreachable. endTurn already refuses to hand play to an empty
    team (`hasOther` above); this is the same fact applied to the finish line.

    An empty team therefore stops being counted rather than blocking. Both
    teams alive and only one finished still keeps playing, which is the normal
    case and the one that must not change.
  */
  const alive = (t) => teamMembers(state, t).length > 0;
  const finishedOrGone = (t) => turnsTaken[t] >= state.totalRounds || !alive(t);
  const done = state.coop
    ? turnsTaken.A >= state.totalRounds
    : finishedOrGone('A') && finishedOrGone('B');

  if (done) {
    const winner = state.coop ? null
      : state.teamScores.A === state.teamScores.B ? null
        : state.teamScores.A > state.teamScores.B ? 'A' : 'B';
    return { ...state, status: 'finished', phase: 'finished', turn: null, lastTurn, turnsTaken, giverIndex, winner };
  }
  return { ...state, turn: null, lastTurn, turnsTaken, giverIndex, currentTeam: nextTeam };
}
