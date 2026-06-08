import { getRandomQuestions } from './questions.js';

/*
  Team Trivia — live multiplayer multiple-choice trivia (Kahoot-style, but free,
  no-signup, browser-based). Built for office/team play on a video call.

  Round phases:
    answering : show the question + 4 options. Each player taps one answer.
    reveal    : show the correct answer + who got it + the leaderboard.

  Scoring: +1 per correct answer (flat — fair and simple). Highest after N rounds wins.
  Auto-advances to reveal when every connected player has answered; the host can
  also force reveal / next round.
*/
const DEFAULT_ROUNDS = 8;

export const TeamTriviaGame = {
  minPlayers: 2,

  createInitialState(settings = {}) {
    const rounds = Number(settings.rounds);
    return {
      phase: null,
      currentRound: 0,
      totalRounds: Number.isInteger(rounds) && rounds >= 3 && rounds <= 20 ? rounds : DEFAULT_ROUNDS,
      round: null,
      usedQuestions: [],
    };
  },

  onStart(state) {
    return startRound({ ...state, currentRound: 0, usedQuestions: [] });
  },

  handleAction(state, action, payload, player) {
    switch (action) {
      case 'submit_answer': {
        if (state.phase !== 'answering') return null;
        const { optionIndex } = payload;
        if (!Number.isInteger(optionIndex) || optionIndex < 0 || optionIndex > 3) return null;
        // first answer per player wins (idempotent)
        if (state.round.answers.find((a) => a.playerId === player.id)) return null;

        const answers = [...state.round.answers, { playerId: player.id, optionIndex }];
        const eligible = state.players.filter((p) => p.connected);
        const allAnswered = eligible.length > 0 && eligible.every((p) => answers.find((a) => a.playerId === p.id));

        if (allAnswered) return revealRound({ ...state, round: { ...state.round, answers } });
        return { ...state, round: { ...state.round, answers } };
      }

      case 'force_reveal': {
        if (state.phase !== 'answering') return null;
        if (player.id !== state.hostId) return null;
        return revealRound(state);
      }

      case 'next_round': {
        if (state.phase !== 'reveal') return null;
        if (player.id !== state.hostId) return null;
        if (state.currentRound >= state.totalRounds) return null;
        return startRound(state);
      }

      default:
        return null;
    }
  },

  deriveClientState(state, playerId) {
    let round = state.round;
    if (round && state.phase === 'answering') {
      // hide the correct answer, and hide which option others picked (show only your own)
      round = {
        ...round,
        answerIndex: null,
        answers: round.answers
          .filter((a) => a.playerId === playerId)
          .map((a) => ({ playerId: a.playerId, optionIndex: a.optionIndex })),
        // expose only the COUNT so the UI can show "3/5 answered"
        answeredCount: round.answers.length,
      };
    }
    return {
      ...state,
      round,
      players: state.players.map(({ socketId, ...rest }) => rest),
    };
  },

  onPlayerDisconnect(state) {
    if (state.phase !== 'answering') return null;
    const eligible = state.players.filter((p) => p.connected);
    const allAnswered = eligible.length > 0 && eligible.every((p) => state.round.answers.find((a) => a.playerId === p.id));
    if (allAnswered) return revealRound(state);
    return null;
  },
};

// ── helpers ──────────────────────────────────────────────────────────────────
function startRound(state) {
  const nextRound = state.currentRound + 1;
  const [picked] = getRandomQuestions(1, state.usedQuestions);
  // shuffle option order so the correct answer (authored at index 0) moves around
  const order = shuffle([0, 1, 2, 3]);
  const options = order.map((i) => picked.options[i]);
  const answerIndex = order.indexOf(0);

  return {
    ...state,
    status: 'playing',
    phase: 'answering',
    currentRound: nextRound,
    usedQuestions: [...state.usedQuestions, picked.q],
    round: {
      number: nextRound,
      question: picked.q,
      category: picked.category,
      options,
      answerIndex,          // hidden until reveal by deriveClientState
      answers: [],
      results: null,
    },
  };
}

function revealRound(state) {
  const { answerIndex, answers } = state.round;
  const correctIds = new Set(answers.filter((a) => a.optionIndex === answerIndex).map((a) => a.playerId));

  const players = state.players.map((p) => ({
    ...p,
    score: (p.score ?? 0) + (correctIds.has(p.id) ? 1 : 0),
  }));

  const isFinal = state.currentRound >= state.totalRounds;
  let winner = null;
  if (isFinal) {
    const sorted = [...players].sort((a, b) => b.score - a.score);
    winner = sorted[0] ?? null;
  }

  return {
    ...state,
    status: isFinal ? 'finished' : 'playing',
    phase: 'reveal',
    players,
    winner,
    round: {
      ...state.round,
      results: {
        answerIndex,
        correctPlayerIds: [...correctIds],
        // tally how many picked each option, for a result bar
        tally: [0, 1, 2, 3].map((i) => answers.filter((a) => a.optionIndex === i).length),
      },
    },
  };
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
