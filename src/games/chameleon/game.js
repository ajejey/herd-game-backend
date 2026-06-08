import { getGrid } from './words.js';

/*
  The Chameleon — social deduction. Everyone sees a 16-word grid and a category.
  One secret word is the answer; everyone EXCEPT the Chameleon knows which.
  Each player gives a one-word clue about the secret word; the Chameleon must
  bluff. Then everyone votes for who they think the Chameleon is.

  Round phases:
    clue     : everyone submits a one-word clue (Chameleon bluffs)
    voting   : all clues shown; everyone votes for the suspected Chameleon
    guessing : if the Chameleon is voted out, they get one guess at the word
    result   : reveal Chameleon + secret word + scores

  Scoring:
    - Chameleon escapes the vote      → Chameleon +2
    - Chameleon caught but guesses word→ Chameleon +1
    - Chameleon caught and guesses wrong → every other player +1
  Highest score after N rounds wins.
*/
const DEFAULT_ROUNDS = 5;

export const ChameleonGame = {
  minPlayers: 3,

  createInitialState(settings = {}) {
    const r = Number(settings.rounds);
    return {
      phase: null,
      currentRound: 0,
      totalRounds: Number.isInteger(r) && r >= 3 && r <= 12 ? r : DEFAULT_ROUNDS,
      round: null,
      usedCategories: [],
    };
  },

  onStart(state) {
    return startRound({ ...state, currentRound: 0, usedCategories: [] });
  },

  handleAction(state, action, payload, player) {
    switch (action) {
      case 'submit_clue': {
        if (state.phase !== 'clue') return null;
        const word = String(payload.word || '').trim().slice(0, 24);
        if (!word) return null;
        if (state.round.clues.find((c) => c.playerId === player.id)) return null;
        const clues = [...state.round.clues, { playerId: player.id, username: player.username, word }];
        const eligible = state.players.filter((p) => p.connected);
        const all = eligible.length > 0 && eligible.every((p) => clues.find((c) => c.playerId === p.id));
        const next = { ...state, round: { ...state.round, clues } };
        return all ? { ...next, phase: 'voting', round: { ...next.round, phase: 'voting' } } : next;
      }

      case 'force_voting': {
        if (state.phase !== 'clue' || player.id !== state.hostId) return null;
        if (state.round.clues.length === 0) return null;
        return { ...state, phase: 'voting', round: { ...state.round, phase: 'voting' } };
      }

      case 'submit_vote': {
        if (state.phase !== 'voting') return null;
        const { suspectId } = payload;
        if (!state.players.find((p) => p.id === suspectId)) return null;
        if (state.round.votes.find((v) => v.voterId === player.id)) return null;
        const votes = [...state.round.votes, { voterId: player.id, suspectId }];
        const eligible = state.players.filter((p) => p.connected);
        const all = eligible.length > 0 && eligible.every((p) => votes.find((v) => v.voterId === p.id));
        if (all) return resolveVotes({ ...state, round: { ...state.round, votes } });
        return { ...state, round: { ...state.round, votes } };
      }

      case 'force_votes': {
        if (state.phase !== 'voting' || player.id !== state.hostId) return null;
        return resolveVotes(state);
      }

      case 'chameleon_guess': {
        if (state.phase !== 'guessing') return null;
        if (player.id !== state.round.chameleonId) return null;
        const { wordIndex } = payload;
        if (!Number.isInteger(wordIndex) || wordIndex < 0 || wordIndex > 15) return null;
        return resolveGuess(state, wordIndex);
      }

      case 'next_round': {
        if (state.phase !== 'result' || player.id !== state.hostId) return null;
        if (state.currentRound >= state.totalRounds) return null;
        return startRound(state);
      }

      default:
        return null;
    }
  },

  deriveClientState(state, playerId) {
    let round = state.round;
    if (round) {
      const amChameleon = playerId === round.chameleonId;
      const hideChameleon = state.phase === 'clue' || state.phase === 'voting';
      const out = { ...round };

      // The Chameleon never sees the secret word until the result.
      if (amChameleon && state.phase !== 'result') out.secretIndex = null;
      // Hide who the Chameleon is until they're revealed (caught or result).
      if (hideChameleon) out.chameleonId = null;
      // Tell each player privately whether THEY are the Chameleon.
      out.youAreChameleon = amChameleon;
      // Hide other players' clues while everyone is still writing them (show count).
      if (state.phase === 'clue') { out.clueCount = round.clues.length; out.clues = round.clues.filter((c) => c.playerId === playerId); }
      // Hide votes until the result (show how many have voted).
      if (state.phase !== 'result') { out.voteCount = round.votes.length; out.votes = round.votes.filter((v) => v.voterId === playerId); }

      round = out;
    }
    return { ...state, round, players: state.players.map(({ socketId, ...rest }) => rest) };
  },

  onPlayerDisconnect(state, player) {
    // If the Chameleon bails mid-guess, resolve it (players win) so the round
    // can't hang waiting on someone who left.
    if (state.phase === 'guessing' && player?.id === state.round.chameleonId) {
      return resolveGuess(state, -1); // -1 ≠ secretIndex → wrong guess, players win
    }
    if (state.phase === 'clue') {
      const eligible = state.players.filter((p) => p.connected);
      const all = eligible.length > 0 && eligible.every((p) => state.round.clues.find((c) => c.playerId === p.id));
      if (all && state.round.clues.length > 0) return { ...state, phase: 'voting', round: { ...state.round, phase: 'voting' } };
    }
    if (state.phase === 'voting') {
      const eligible = state.players.filter((p) => p.connected);
      const all = eligible.length > 0 && eligible.every((p) => state.round.votes.find((v) => v.voterId === p.id));
      if (all) return resolveVotes(state);
    }
    return null;
  },
};

// ── helpers ──────────────────────────────────────────────────────────────────
function startRound(state) {
  const nextRound = state.currentRound + 1;
  const grid = getGrid(state.usedCategories);
  const secretIndex = Math.floor(Math.random() * grid.words.length);
  const connected = state.players.filter((p) => p.connected);
  const chameleon = connected[Math.floor(Math.random() * connected.length)] || state.players[0];

  return {
    ...state,
    status: 'playing',
    phase: 'clue',
    currentRound: nextRound,
    usedCategories: [...state.usedCategories, grid.category],
    round: {
      number: nextRound,
      phase: 'clue',
      category: grid.category,
      words: grid.words,
      secretIndex,                 // hidden from the Chameleon by deriveClientState
      chameleonId: chameleon.id,   // hidden from everyone until reveal
      clues: [],
      votes: [],
      caughtId: null,
      result: null,
    },
  };
}

function resolveVotes(state) {
  const { votes, chameleonId } = state.round;
  const counts = {};
  for (const v of votes) counts[v.suspectId] = (counts[v.suspectId] || 0) + 1;
  let caughtId = null, max = -1;
  for (const [id, n] of Object.entries(counts)) { if (n > max) { max = n; caughtId = id; } }

  if (caughtId === chameleonId) {
    // Caught — the Chameleon gets one guess at the secret word.
    return { ...state, phase: 'guessing', round: { ...state.round, phase: 'guessing', caughtId } };
  }
  // Escaped — the Chameleon wins this round.
  return finishRound(state, { caughtId, chameleonWon: true, reason: 'escaped', guessIndex: null });
}

function resolveGuess(state, wordIndex) {
  const correct = wordIndex === state.round.secretIndex;
  return finishRound(state, {
    caughtId: state.round.caughtId,
    chameleonWon: correct,
    reason: correct ? 'caught-but-guessed' : 'caught',
    guessIndex: wordIndex,
  });
}

function finishRound(state, result) {
  const chameleonId = state.round.chameleonId;
  const players = state.players.map((p) => {
    let add = 0;
    if (result.chameleonWon) {
      if (p.id === chameleonId) add = result.reason === 'escaped' ? 2 : 1;
    } else if (p.id !== chameleonId) {
      add = 1; // players win — everyone but the Chameleon scores
    }
    return { ...p, score: (p.score ?? 0) + add };
  });

  const isFinal = state.currentRound >= state.totalRounds;
  let winner = null;
  if (isFinal) winner = [...players].sort((a, b) => b.score - a.score)[0] ?? null;

  return {
    ...state,
    status: isFinal ? 'finished' : 'playing',
    phase: 'result',
    players,
    winner,
    round: { ...state.round, phase: 'result', result },
  };
}
