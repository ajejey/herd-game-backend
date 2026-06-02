import { randomUUID } from 'crypto';
import { questions, getRandomQuestions } from './questions.js';

/*
  Guesstimate — a trivia-betting party game (Wits & Wagers-inspired, distinct branding).

  Round phases:
    question   : show the trivia question to everyone
    answering  : every player writes their numerical guess
    betting    : answers are sorted low→high on a chalkboard. Players place 2 chips
                 on any answer (own or others'). Doubling on one or splitting.
    reveal     : actual answer is shown. "Price is Right" rule — closest WITHOUT
                 going over wins. If all are over, the lowest answer wins.
                 Payouts based on board position.

  Scoring:
    - Writing the winning answer: +2 points
    - Each chip on the winning answer: payout × 1 point

  Payouts (Wits & Wagers-inspired but distinct labeling):
    Board has N positions (N = number of UNIQUE answers).
    Position payouts (lowest to highest answer):
      with N answers, payouts are spaced from 5x (lowest) down to 1x (highest).
      Mapping: 1st (lowest) = 5x, 2nd = 4x, 3rd = 3x, 4th = 2x, rest = 1x

  Game ends after 7 rounds. Highest score wins.
*/

const TOTAL_ROUNDS = 7;

function payoutForPosition(positionIndex /* 0-based, 0 = lowest answer */) {
  // 5x, 4x, 3x, 2x, then 1x for everything else
  const table = [5, 4, 3, 2];
  return table[positionIndex] ?? 1;
}

export const GuesstimateGame = {

  minPlayers: 2,

  createInitialState() {
    return {
      phase: null,
      currentRound: 0,
      totalRounds: TOTAL_ROUNDS,
      round: null,
      usedQuestions: [],
    };
  },

  onStart(state) {
    return startRound({ ...state, currentRound: 0 });
  },

  handleAction(state, action, payload, player) {
    switch (action) {

      case 'submit_answer': {
        if (state.phase !== 'answering') return null;
        const raw = payload.number;
        // Accept anything that parses as a finite non-negative number
        const num = typeof raw === 'number' ? raw : parseFloat(String(raw).replace(/[^0-9.-]/g, ''));
        if (!Number.isFinite(num)) return null;

        // Idempotent — first submission wins
        if (state.round.answers.find(a => a.playerId === player.id)) return null;

        const newAnswer = {
          id: randomUUID(),
          playerId: player.id,
          username: player.username,
          number: num,
        };
        const answers = [...state.round.answers, newAnswer];

        // Auto-advance when every connected player has answered
        const eligible = state.players.filter(p => p.connected);
        const allAnswered = eligible.every(p => answers.find(a => a.playerId === p.id));

        if (allAnswered) {
          return enterBettingPhase({ ...state, round: { ...state.round, answers } });
        }

        return { ...state, round: { ...state.round, answers } };
      }

      case 'force_betting': {
        // Host can force-advance if some players are slow
        if (state.phase !== 'answering') return null;
        if (player.id !== state.hostId) return null;
        if (state.round.answers.length === 0) return null;
        return enterBettingPhase(state);
      }

      case 'submit_bet': {
        if (state.phase !== 'betting') return null;
        const { boardIndex } = payload;
        if (!Number.isInteger(boardIndex)) return null;
        if (boardIndex < 0 || boardIndex >= state.round.board.length) return null;

        const myBets = state.round.bets.filter(b => b.playerId === player.id);
        if (myBets.length >= 2) return null;

        const bets = [...state.round.bets, { playerId: player.id, boardIndex }];

        // Auto-advance to reveal when every connected player placed both chips
        const eligible = state.players.filter(p => p.connected);
        const allBet = eligible.every(p =>
          bets.filter(b => b.playerId === p.id).length === 2
        );

        if (allBet) {
          return resolveRound({ ...state, round: { ...state.round, bets } });
        }

        return { ...state, round: { ...state.round, bets } };
      }

      case 'force_reveal': {
        if (state.phase !== 'betting') return null;
        if (player.id !== state.hostId) return null;
        return resolveRound(state);
      }

      case 'next_round': {
        if (state.phase !== 'reveal') return null;
        if (player.id !== state.hostId) return null;
        if (state.currentRound >= state.totalRounds) return null;
        return startRound(state);
      }

      case 'cancel_round': {
        // Host can cancel the current round (no scoring), start a fresh one
        if (!['answering', 'betting'].includes(state.phase)) return null;
        if (player.id !== state.hostId) return null;
        return startRound({ ...state, currentRound: state.currentRound - 1 });
      }

      default:
        return null;
    }
  },

  // Hide secrets per player
  deriveClientState(state, playerId) {
    let round = state.round;
    if (round) {
      // Hide other players' answers during answering phase
      if (state.phase === 'answering') {
        round = {
          ...round,
          answers: round.answers.map(a =>
            a.playerId === playerId ? a : { id: a.id, playerId: a.playerId, username: a.username, number: null }
          ),
        };
      }
      // Hide other players' bets during betting phase (only show own bets)
      if (state.phase === 'betting') {
        round = {
          ...round,
          bets: round.bets.filter(b => b.playerId === playerId),
        };
      }
      // Hide the actualAnswer until reveal
      if (state.phase !== 'reveal') {
        round = { ...round, actualAnswer: null, winningBoardIndex: null, scores: null };
      }
    }

    return {
      ...state,
      round,
      players: state.players.map(({ socketId, ...rest }) => rest),
    };
  },

  onPlayerDisconnect(state, _disconnectedPlayer) {
    // Re-check auto-advance conditions in case the disconnected player was holding things up
    if (state.phase === 'answering') {
      const eligible = state.players.filter(p => p.connected);
      const allAnswered = eligible.length > 0 && eligible.every(p =>
        state.round.answers.find(a => a.playerId === p.id)
      );
      if (allAnswered && state.round.answers.length > 0) {
        return enterBettingPhase(state);
      }
    }
    if (state.phase === 'betting') {
      const eligible = state.players.filter(p => p.connected);
      const allBet = eligible.length > 0 && eligible.every(p =>
        state.round.bets.filter(b => b.playerId === p.id).length === 2
      );
      if (allBet) {
        return resolveRound(state);
      }
    }
    return null;
  },
};

// ── Private helpers ──────────────────────────────────────────────────────────

function startRound(state) {
  const nextRound = state.currentRound + 1;
  const [picked] = getRandomQuestions(1, state.usedQuestions);
  if (!picked) {
    // Ran out of questions — recycle (shouldn't really happen with 100+ Qs and 7-round games)
    return startRound({ ...state, usedQuestions: [] });
  }

  return {
    ...state,
    status: 'playing',
    phase: 'answering',
    currentRound: nextRound,
    usedQuestions: [...state.usedQuestions, picked.q],
    round: {
      number: nextRound,
      question: picked.q,
      actualAnswer: picked.a, // hidden by deriveClientState until reveal
      answers: [],
      board: [],          // populated when betting phase begins
      bets: [],
      winningBoardIndex: null,
      scores: null,
    },
  };
}

function enterBettingPhase(state) {
  // Build the betting board: sort UNIQUE answer numbers low→high
  const answersByNumber = new Map();
  for (const ans of state.round.answers) {
    if (!answersByNumber.has(ans.number)) answersByNumber.set(ans.number, []);
    answersByNumber.get(ans.number).push(ans);
  }
  const sortedNumbers = [...answersByNumber.keys()].sort((a, b) => a - b);
  const board = sortedNumbers.map((num, i) => ({
    number: num,
    authors: answersByNumber.get(num).map(a => ({ playerId: a.playerId, username: a.username })),
    payout: payoutForPosition(i),
  }));

  // Quick advance to a brief "question revealed / answers shown" pause is handled client-side;
  // server transitions straight to betting once all answers are in.
  return {
    ...state,
    phase: 'betting',
    round: { ...state.round, board },
  };
}

function resolveRound(state) {
  const { actualAnswer, board, bets, answers } = state.round;

  // Determine winning board index: closest without going over.
  // If all over, the lowest number wins.
  const allOver = board.every(slot => slot.number > actualAnswer);
  let winningIdx;
  if (allOver) {
    winningIdx = 0; // lowest answer
  } else {
    // Find the highest slot that's still <= actualAnswer
    winningIdx = -1;
    for (let i = 0; i < board.length; i++) {
      if (board[i].number <= actualAnswer) winningIdx = i;
    }
    if (winningIdx === -1) winningIdx = 0; // safety
  }

  const winningSlot = board[winningIdx];

  // Compute round scores
  const roundScores = {};
  // +2 for each author whose answer was the winning slot
  for (const author of winningSlot.authors) {
    roundScores[author.playerId] = (roundScores[author.playerId] ?? 0) + 2;
  }
  // payout × 1 for each correct bet
  for (const bet of bets) {
    if (bet.boardIndex === winningIdx) {
      const payout = board[bet.boardIndex].payout;
      roundScores[bet.playerId] = (roundScores[bet.playerId] ?? 0) + payout;
    }
  }

  const updatedPlayers = state.players.map(p => ({
    ...p,
    score: (p.score ?? 0) + (roundScores[p.id] ?? 0),
  }));

  const isFinalRound = state.currentRound >= state.totalRounds;
  let winner = null;
  if (isFinalRound) {
    const sorted = [...updatedPlayers].sort((a, b) => b.score - a.score);
    if (sorted[0]) winner = sorted[0];
  }

  return {
    ...state,
    status: isFinalRound ? 'finished' : 'playing',
    phase: 'reveal',
    players: updatedPlayers,
    winner,
    round: {
      ...state.round,
      winningBoardIndex: winningIdx,
      scores: roundScores,
    },
  };
}
