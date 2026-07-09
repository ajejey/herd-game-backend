/*
  Fishbowl (aka Salad Bowl) on the engine.

  Setup:
    submitting : every player secretly adds a few words/phrases to the bowl.
  Then 3 rounds over the SAME words, harder each time:
    round 1 : Describe it (say anything but the word)
    round 2 : Act it out (charades, no words)
    round 3 : One word only
  Two teams take turns. On a turn, the active player draws words from the bowl
  and their team guesses; each word guessed = a point. When the bowl empties, the
  round advances and the bowl refills with all the words. Higher team score after
  round 3 wins.

  Turn timer is client-driven (the giver's client counts down to `deadline` and
  calls end_turn) — no server timer, matching the rest of the suite.
*/
const DEFAULT_WORDS = 3;
const DEFAULT_TURN_SEC = 45;
const ROUND_NAMES = { 1: 'Describe it (no saying the word)', 2: 'Act it out (no words)', 3: 'One word only' };

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

export const FishbowlGame = {
  minPlayers: 4,

  createInitialState(settings = {}) {
    const w = Number(settings.words);
    return {
      phase: null, // 'submitting' | 'playing'
      wordsPerPlayer: Number.isInteger(w) && w >= 2 && w <= 6 ? w : DEFAULT_WORDS,
      turnSec: DEFAULT_TURN_SEC,
      submissions: {}, // playerId -> [words]
      teams: { A: [], B: [] },
      teamScores: { A: 0, B: 0 },
      roundType: 1,
      allWords: [],
      bowl: [],
      currentTeam: 'A',
      giverIndex: { A: 0, B: 0 },
      turn: null, // { giverId, deadline, gotCount }
      lastTurn: null, // { team, giverId, got }
      winner: null,
    };
  },

  onStart(state) {
    return { ...state, status: 'playing', phase: 'submitting', submissions: {} };
  },

  handleAction(state, action, payload, player) {
    switch (action) {
      case 'submit_words': {
        if (state.phase !== 'submitting') return null;
        if (state.submissions[player.id]) return null;
        if (!Array.isArray(payload.words)) return null;
        const words = payload.words
          .map((w) => String(w || '').trim().slice(0, 40))
          .filter(Boolean)
          .slice(0, state.wordsPerPlayer);
        if (words.length === 0) return null;
        const submissions = { ...state.submissions, [player.id]: words };
        const next = { ...state, submissions };
        const connected = state.players.filter((p) => p.connected);
        const allIn = connected.length > 0 && connected.every((p) => submissions[p.id]);
        return allIn ? beginRounds(next) : next;
      }

      case 'force_begin': {
        if (state.phase !== 'submitting' || player.id !== state.hostId) return null;
        return beginRounds(state);
      }

      case 'start_turn': {
        if (state.phase !== 'playing' || state.turn) return null;
        if (player.id !== currentGiverId(state)) return null;
        return { ...state, turn: { giverId: player.id, deadline: Date.now() + state.turnSec * 1000, gotCount: 0 } };
      }

      case 'got_word': {
        if (state.phase !== 'playing' || !state.turn || player.id !== state.turn.giverId) return null;
        if (state.bowl.length === 0) return null;
        const team = state.currentTeam;
        const teamScores = { ...state.teamScores, [team]: state.teamScores[team] + 1 };
        const bowl = state.bowl.slice(1);
        const turn = { ...state.turn, gotCount: state.turn.gotCount + 1 };

        if (bowl.length === 0) {
          // round cleared — advance (or finish), end this turn
          return advanceRound({ ...state, teamScores, bowl, turn });
        }
        return { ...state, teamScores, bowl, turn };
      }

      case 'skip_word': {
        if (state.phase !== 'playing' || !state.turn || player.id !== state.turn.giverId) return null;
        if (state.bowl.length <= 1) return null; // nothing to skip to
        const bowl = [...state.bowl.slice(1), state.bowl[0]];
        return { ...state, bowl };
      }

      case 'end_turn': {
        if (state.phase !== 'playing' || !state.turn) return null;
        if (player.id !== state.turn.giverId && player.id !== state.hostId) return null;
        return endTurn(state);
      }

      default:
        return null;
    }
  },

  deriveClientState(state, playerId) {
    const base = { ...state, players: state.players.map(({ socketId, ...rest }) => rest) };

    if (state.phase === 'submitting') {
      base.submittedIds = Object.keys(state.submissions);
      base.yourWords = state.submissions[playerId] || null;
      base.submissions = undefined;
      return base;
    }

    if (state.phase === 'playing') {
      base.submissions = undefined;
      base.allWords = undefined; // don't leak the full list
      base.roundName = ROUND_NAMES[state.roundType];
      base.wordsLeft = state.bowl.length;
      base.currentGiverId = currentGiverId(state);
      // Only the active giver sees the current word.
      base.currentWord = state.turn && playerId === state.turn.giverId ? state.bowl[0] || null : undefined;
      base.bowl = undefined;
      return base;
    }
    return base;
  },

  onPlayerDisconnect(state, player) {
    if (state.phase === 'playing' && state.turn && player?.id === state.turn.giverId) {
      return endTurn(state);
    }
    return null;
  },
};

// ── helpers ──────────────────────────────────────────────────────────────────
function teamMembers(state, team) {
  // connected members of a team, preserving assignment order
  return state.teams[team].filter((id) => state.players.find((p) => p.id === id && p.connected));
}

function currentGiverId(state) {
  const members = teamMembers(state, state.currentTeam);
  if (members.length === 0) return null;
  return members[state.giverIndex[state.currentTeam] % members.length];
}

function beginRounds(state) {
  const connected = state.players.filter((p) => p.connected);
  const teams = { A: [], B: [] };
  connected.forEach((p, i) => teams[i % 2 === 0 ? 'A' : 'B'].push(p.id));
  const allWords = shuffle(Object.values(state.submissions).flat());
  if (allWords.length === 0) return state; // nothing submitted — can't begin
  return {
    ...state,
    phase: 'playing',
    teams,
    teamScores: { A: 0, B: 0 },
    roundType: 1,
    allWords,
    bowl: [...allWords],
    currentTeam: 'A',
    giverIndex: { A: 0, B: 0 },
    turn: null,
    lastTurn: null,
    winner: null,
  };
}

function endTurn(state) {
  const team = state.currentTeam;
  const lastTurn = state.turn ? { team, giverId: state.turn.giverId, got: state.turn.gotCount } : state.lastTurn;
  const giverIndex = { ...state.giverIndex, [team]: state.giverIndex[team] + 1 };
  return { ...state, turn: null, lastTurn, giverIndex, currentTeam: team === 'A' ? 'B' : 'A' };
}

function advanceRound(state) {
  // called when the bowl just emptied during a turn
  const finishedTurn = endTurn(state); // pass play to the other team, clear turn
  const nextRound = state.roundType + 1;
  if (nextRound > 3) {
    const winner =
      state.teamScores.A === state.teamScores.B ? null
        : state.teamScores.A > state.teamScores.B ? 'A' : 'B';
    return { ...finishedTurn, status: 'finished', roundType: 3, bowl: [], winner };
  }
  return { ...finishedTurn, roundType: nextRound, bowl: shuffle(state.allWords) };
}
