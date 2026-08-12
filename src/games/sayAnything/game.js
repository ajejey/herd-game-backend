import { getRandomQuestions } from './questions.js';
import { randomUUID } from 'crypto';

/*
  Say Anything — round phases:
    picking    : judge picks a question from their hand (3 choices)
    answering  : non-judges submit free text answers
    judging    : judge secretly picks their favourite answer
    betting    : non-judges place up to 2 bets on which answer the judge picked
    reveal     : scores shown, host advances

  Scoring:
    - Answer author gets 1 point if judge picked their answer
    - Each bettor gets 1 point per correct bet (bet on the judge's pick)
    - Judge gets 1 point per player who bet correctly
*/

const WIN_SCORE = 7;

// ── Helpers ──────────────────────────────────────────────────────────────────

function nextJudgeIndex(state) {
  const count = state.players.length;
  return (state.judgeIndex + 1) % count;
}

function connectedNonJudge(state) {
  const judge = state.players[state.judgeIndex];
  return state.players.filter(p => p.connected && p.id !== judge?.id);
}

// ── Game definition ───────────────────────────────────────────────────────────

export const SayAnythingGame = {

  createInitialState(settings = {}) {
    return {
      phase: null,           // null in lobby
      judgeIndex: 0,
      currentRound: 0,
      winScore: settings.winScore ?? WIN_SCORE,
      // per-round state (reset each round)
      round: null,
      usedQuestions: [],
      // A host's own questions, resolved by the engine from settings.packCode.
      customQuestions: Array.isArray(settings.customQuestions) && settings.customQuestions.length
        ? settings.customQuestions
        : null,
    };
  },

  onStart(state) {
    return startRound({ ...state, currentRound: 0, judgeIndex: 0 });
  },

  handleAction(state, action, payload, player) {
    switch (action) {

      case 'pick_question': {
        if (state.phase !== 'picking') return null;
        const judge = state.players[state.judgeIndex];
        if (player.id !== judge.id) return null;
        const { question } = payload;
        if (!state.round.questionChoices.includes(question)) return null;

        return {
          ...state,
          phase: 'answering',
          round: { ...state.round, question, questionChoices: [] },
        };
      }

      case 'submit_answer': {
        if (state.phase !== 'answering') return null;
        const judge = state.players[state.judgeIndex];
        if (player.id === judge.id) return null; // judge can't answer
        const text = payload.text?.trim();
        if (!text) return null;
        // idempotent: ignore if already answered
        if (state.round.answers.find(a => a.playerId === player.id)) return null;

        const answers = [
          ...state.round.answers,
          { id: randomUUID(), playerId: player.id, username: player.username, text },
        ];

        // Auto-advance to judging when all connected non-judges have answered
        const eligible = connectedNonJudge(state);
        const allAnswered = eligible.every(p => answers.find(a => a.playerId === p.id));

        return {
          ...state,
          phase: allAnswered ? 'judging' : 'answering',
          round: { ...state.round, answers },
        };
      }

      case 'force_judging': {
        // Host can force-advance from answering → judging (skip slow players)
        if (state.phase !== 'answering') return null;
        if (player.id !== state.hostId) return null;
        if (state.round.answers.length === 0) return null; // need at least 1 answer
        return { ...state, phase: 'judging' };
      }

      case 'judge_pick': {
        if (state.phase !== 'judging') return null;
        const judge = state.players[state.judgeIndex];
        if (player.id !== judge.id) return null;
        const { answerId } = payload;
        if (!state.round.answers.find(a => a.id === answerId)) return null;

        return {
          ...state,
          phase: 'betting',
          round: { ...state.round, judgePickId: answerId },
        };
      }

      case 'submit_bet': {
        if (state.phase !== 'betting') return null;
        const judge = state.players[state.judgeIndex];
        if (player.id === judge.id) return null;
        const { answerId } = payload;
        if (!state.round.answers.find(a => a.id === answerId)) return null;

        const existingBets = state.round.bets.filter(b => b.playerId !== player.id);
        const myBets = state.round.bets.filter(b => b.playerId === player.id);

        // max 2 bets per player (duplicates allowed — that's "doubling down")
        if (myBets.length >= 2) return null;

        const bets = [...existingBets, ...myBets, { playerId: player.id, answerId }];

        // Auto-advance only when all eligible players have placed BOTH bets
        const eligible = connectedNonJudge(state);
        const allBet = eligible.every(p =>
          bets.filter(b => b.playerId === p.id).length === 2
        );

        if (allBet) {
          return resolveRound({ ...state, round: { ...state.round, bets } });
        }

        return { ...state, round: { ...state.round, bets } };
      }

      case 'force_reveal': {
        // Host can force-reveal (skip slow bettors)
        if (state.phase !== 'betting') return null;
        if (player.id !== state.hostId) return null;
        return resolveRound(state);
      }

      case 'next_round': {
        if (state.phase !== 'reveal') return null;
        if (player.id !== state.hostId) return null;
        return startRound(state);
      }

      case 'cancel_round': {
        // Host can abort the current round (judge offline, stuck, etc.) — rotates judge, no scoring
        if (!['picking', 'answering', 'judging', 'betting'].includes(state.phase)) return null;
        if (player.id !== state.hostId) return null;
        const newJudgeIndex = (state.judgeIndex + 1) % state.players.length;
        const choices = getRandomQuestions(3, state.usedQuestions, state.customQuestions);
        return {
          ...state,
          phase: 'picking',
          judgeIndex: newJudgeIndex,
          usedQuestions: [...state.usedQuestions, ...choices],
          round: {
            number: state.currentRound,
            questionChoices: choices,
            question: null,
            answers: [],
            judgePickId: null,
            bets: [],
            scores: null,
          },
        };
      }

      default:
        return null;
    }
  },

  // Filter secrets per player before sending to client
  deriveClientState(state, playerId) {
    const judge = state.players[state.judgeIndex];
    const isJudge = judge?.id === playerId;

    let round = state.round;
    if (round && state.phase !== 'reveal') {
      round = {
        ...round,
        // Hide judge's pick until reveal
        judgePickId: state.phase === 'reveal' ? round.judgePickId : null,
        // Hide other players' answers during answering phase
        // (judge sees them once judging starts)
        answers: (state.phase === 'answering')
          ? round.answers.map(a =>
              a.playerId === playerId
                ? a
                : { id: a.id, playerId: a.playerId, username: a.username, text: '...' }
            )
          : round.answers,
        // Hide bets during betting phase (only show own bets)
        bets: state.phase === 'betting'
          ? round.bets.filter(b => b.playerId === playerId)
          : round.bets,
      };
    }

    return {
      ...state,
      round,
      // Strip socketIds from players for client
      players: state.players.map(({ socketId, ...rest }) => rest),
    };
  },

  onPlayerDisconnect(state, disconnectedPlayer) {
    const judge = state.players[state.judgeIndex];

    // If judge disconnects during answering/judging/betting, auto-advance if host is around
    if (
      disconnectedPlayer.id === judge?.id &&
      ['answering', 'judging', 'betting'].includes(state.phase)
    ) {
      // Mark that judge is gone — host will see a "Skip round" button via force_judging/force_reveal
      return { ...state, judgeDisconnected: true };
    }

    // Non-judge disconnects during answering — check if everyone remaining has answered
    if (state.phase === 'answering') {
      const eligible = connectedNonJudge({ ...state });
      const allAnswered = eligible.every(p =>
        state.round.answers.find(a => a.playerId === p.id)
      );
      if (allAnswered && state.round.answers.length > 0) {
        return { ...state, phase: 'judging' };
      }
    }

    // Non-judge disconnects during betting — check if all remaining have placed both bets
    if (state.phase === 'betting') {
      const eligible = connectedNonJudge({ ...state });
      const allBet = eligible.every(p =>
        state.round.bets.filter(b => b.playerId === p.id).length === 2
      );
      if (allBet) {
        return resolveRound(state);
      }
    }

    return null;
  },
};

// ── Private helpers ───────────────────────────────────────────────────────────

function startRound(state) {
  const judgeIndex = state.currentRound === 0 ? 0 : nextJudgeIndex(state);
  const choices = getRandomQuestions(3, state.usedQuestions, state.customQuestions);

  return {
    ...state,
    status: 'playing',
    phase: 'picking',
    judgeIndex,
    judgeDisconnected: false,
    currentRound: state.currentRound + 1,
    usedQuestions: [...state.usedQuestions, ...choices],
    round: {
      number: state.currentRound + 1,
      questionChoices: choices,
      question: null,
      answers: [],
      judgePickId: null,
      bets: [],
      scores: null, // populated at reveal
    },
  };
}

function resolveRound(state) {
  const { judgePickId, answers, bets } = state.round;
  const judge = state.players[state.judgeIndex];

  // Winning answer
  const winningAnswer = answers.find(a => a.id === judgePickId);
  const correctBets = bets.filter(b => b.answerId === judgePickId);
  const correctBettors = correctBets.map(b => b.playerId);

  // Compute delta scores for this round
  const roundScores = {};

  // Answer author gets 1 point
  if (winningAnswer) {
    roundScores[winningAnswer.playerId] = (roundScores[winningAnswer.playerId] ?? 0) + 1;
  }

  // Each correct bettor gets 1 point
  for (const pid of correctBettors) {
    roundScores[pid] = (roundScores[pid] ?? 0) + 1;
  }

  // Judge gets 1 point per correct bettor
  if (judge) {
    roundScores[judge.id] = (roundScores[judge.id] ?? 0) + correctBettors.length;
  }

  // Apply to players
  const players = state.players.map(p => ({
    ...p,
    score: (p.score ?? 0) + (roundScores[p.id] ?? 0),
  }));

  // Check win condition — highest score >= winScore (judge excluded from winning mid-round)
  const winner = players.find(p => p.score >= state.winScore && p.id !== judge?.id);

  return {
    ...state,
    status: winner ? 'finished' : 'playing',
    phase: 'reveal',
    winner: winner ?? null,
    players,
    round: {
      ...state.round,
      scores: roundScores,
      correctBettors,
    },
  };
}
