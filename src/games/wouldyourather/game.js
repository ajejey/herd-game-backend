import { PROMPTS, pickPrompt } from './wyrData.js';

/*
  Would You Rather on the engine — a live poll icebreaker.

  Round phases:
    voting : both options shown; everyone taps A or B (own votes hidden)
    reveal : show the split and who picked what; you score a point for siding
             with the majority (the "herd") — on brand for the hub. Ties: nobody
             scores. Highest total after N rounds wins.

  No server-side timer: resolves when everyone has voted, or the host reveals.
*/
const DEFAULT_ROUNDS = 8;

export const WouldYouRatherGame = {
  minPlayers: 2,

  createInitialState(settings = {}) {
    const r = Number(settings.rounds);
    return {
      phase: null,
      currentRound: 0,
      totalRounds: Number.isInteger(r) && r >= 3 && r <= 20 ? r : DEFAULT_ROUNDS,
      usedPrompts: [],
      round: null,
      winner: null,
      /*
        A host's own "would you rather" pairs, resolved by the engine from
        settings.packCode. Stored on the room rather than read live, so a pack
        that expires mid-game cannot change the questions under the players.
      */
      customPrompts: Array.isArray(settings.customQuestions) && settings.customQuestions.length
        ? settings.customQuestions
        : null,
    };
  },

  onStart(state) {
    return startRound({ ...state, currentRound: 0, usedPrompts: [], winner: null });
  },

  handleAction(state, action, payload, player) {
    switch (action) {
      case 'vote': {
        if (state.phase !== 'voting') return null;
        const choice = payload.choice === 'A' || payload.choice === 'B' ? payload.choice : null;
        if (!choice) return null;
        if (state.round.votes[player.id]) return null; // one vote per round
        const votes = { ...state.round.votes, [player.id]: choice };
        const next = { ...state, round: { ...state.round, votes } };
        const connected = state.players.filter((p) => p.connected);
        const allIn = connected.length > 0 && connected.every((p) => votes[p.id]);
        return allIn ? resolve(next) : next;
      }

      case 'force_reveal': {
        if (state.phase !== 'voting' || player.id !== state.hostId) return null;
        return resolve(state);
      }

      case 'next_round': {
        if (state.phase !== 'reveal' || player.id !== state.hostId) return null;
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
      if (state.phase === 'voting') {
        const voterIds = Object.keys(round.votes);
        round = {
          number: round.number,
          phase: round.phase,
          optionA: round.optionA,
          optionB: round.optionB,
          votedCount: voterIds.length,
          votedIds: voterIds,
          yourVote: round.votes[playerId] || null,
        };
      }
      // 'reveal' exposes the full round (votes + result) as-is
    }
    return { ...state, round, players: state.players.map(({ socketId, ...rest }) => rest) };
  },

  onPlayerDisconnect(state, player) {
    if (state.phase === 'voting') {
      const connected = state.players.filter((p) => p.connected);
      const allIn = connected.length > 0 && connected.every((p) => state.round.votes[p.id]);
      if (allIn) return resolve(state);
    }
    return null;
  },
};

// ── helpers ──────────────────────────────────────────────────────────────────
function startRound(state) {
  const nextRound = state.currentRound + 1;
  const bank = (Array.isArray(state.customPrompts) && state.customPrompts.length) ? state.customPrompts : PROMPTS;
  const idx = pickPrompt(state.usedPrompts, bank.length);
  const p = bank[idx];
  return {
    ...state,
    status: 'playing',
    phase: 'voting',
    currentRound: nextRound,
    usedPrompts: [...state.usedPrompts, idx],
    round: {
      number: nextRound,
      phase: 'voting',
      optionA: p.a,
      optionB: p.b,
      votes: {}, // playerId -> 'A' | 'B'
      result: null,
    },
  };
}

function resolve(state) {
  const votes = state.round.votes;
  let a = 0, b = 0;
  for (const v of Object.values(votes)) { if (v === 'A') a++; else if (v === 'B') b++; }
  const majority = a > b ? 'A' : b > a ? 'B' : null; // null = tie, nobody scores

  const players = state.players.map((p) => {
    const withHerd = majority && votes[p.id] === majority;
    return { ...p, score: (p.score ?? 0) + (withHerd ? 1 : 0) };
  });

  const isFinal = state.currentRound >= state.totalRounds;
  const winner = isFinal ? [...players].sort((x, y) => y.score - x.score)[0] ?? null : null;

  return {
    ...state,
    status: isFinal ? 'finished' : 'playing',
    phase: 'reveal',
    players,
    winner,
    round: { ...state.round, phase: 'reveal', result: { a, b, majority } },
  };
}
