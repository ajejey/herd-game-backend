import { shuffledDeck } from './tabooCards.js';

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
    const connected = state.players.filter((p) => p.connected);
    const coop = connected.length < 4;
    const teams = { A: [], B: [] };
    if (coop) connected.forEach((p) => teams.A.push(p.id));
    else connected.forEach((p, i) => teams[i % 2 === 0 ? 'A' : 'B'].push(p.id));
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
        // Only the OPPOSING team may buzz (in co-op, anyone but the giver).
        if (!state.turn || player.id === state.turn.giverId) return null;
        const onGiversTeam = state.teams[state.currentTeam].includes(player.id);
        if (!state.coop && onGiversTeam) return null;
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

    // Only the giver may ever see the card. Everyone else must not.
    if (state.turn && playerId === state.turn.giverId) {
      base.card = state.deck[state.deckIndex] || null;
    } else {
      base.card = null;
    }
    delete base.deck;
    return base;
  },

  onPlayerDisconnect(state, player) {
    if (state.turn && player?.id === state.turn.giverId) return endTurn(state);
    return null;
  },
};

// ── helpers ──────────────────────────────────────────────────────────────────
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

  // Everyone has taken their rounds → finish.
  const done = state.coop
    ? turnsTaken.A >= state.totalRounds
    : turnsTaken.A >= state.totalRounds && turnsTaken.B >= state.totalRounds;

  if (done) {
    const winner = state.coop ? null
      : state.teamScores.A === state.teamScores.B ? null
        : state.teamScores.A > state.teamScores.B ? 'A' : 'B';
    return { ...state, status: 'finished', phase: 'finished', turn: null, lastTurn, turnsTaken, giverIndex, winner };
  }
  return { ...state, turn: null, lastTurn, turnsTaken, giverIndex, currentTeam: nextTeam };
}
