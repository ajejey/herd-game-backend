import { pickLetter, pickCategories, normalizeAnswer, startsWithLetter } from './scattergoriesData.js';

/*
  Scattergories on the engine.

  Round phases:
    writing : everyone writes an answer starting with the round's letter for each
              category, before the timer runs out
    results : reveal all answers; score 1 point per answer that is valid (starts
              with the letter) AND unique (no other player gave the same answer)

  No server-side timer: clients count down to `deadline` and auto-submit; the
  round resolves as soon as every connected player has submitted, or the host
  hits "Reveal now". Highest total after N rounds wins.
*/
const DEFAULT_ROUNDS = 3;
const DEFAULT_CATS = 8;
const DEFAULT_TIMER = 120;

export const ScattergoriesGame = {
  minPlayers: 2,

  createInitialState(settings = {}) {
    const rounds = Number(settings.rounds);
    const cats = Number(settings.categories);
    const timer = Number(settings.timer);
    return {
      phase: null,
      currentRound: 0,
      totalRounds: Number.isInteger(rounds) && rounds >= 1 && rounds <= 8 ? rounds : DEFAULT_ROUNDS,
      categoriesPerRound: Number.isInteger(cats) && cats >= 5 && cats <= 12 ? cats : DEFAULT_CATS,
      timerSec: Number.isInteger(timer) && timer >= 45 && timer <= 240 ? timer : DEFAULT_TIMER,
      usedLetters: [],
      usedCats: [],
      round: null,
      winner: null,
    };
  },

  onStart(state) {
    return startRound({ ...state, currentRound: 0, usedLetters: [], usedCats: [], winner: null });
  },

  handleAction(state, action, payload, player) {
    switch (action) {
      case 'submit_answers': {
        if (state.phase !== 'writing') return null;
        if (!Array.isArray(payload.answers)) return null;
        // one submission per player per round
        if (state.round.submissions[player.id]) return null;
        const answers = payload.answers
          .slice(0, state.categoriesPerRound)
          .map((a) => String(a || '').trim().slice(0, 60));
        const submissions = { ...state.round.submissions, [player.id]: { answers } };
        const next = { ...state, round: { ...state.round, submissions } };

        const connected = state.players.filter((p) => p.connected);
        const allIn = connected.length > 0 && connected.every((p) => submissions[p.id]);
        return allIn ? resolve(next) : next;
      }

      case 'force_reveal': {
        if (state.phase !== 'writing' || player.id !== state.hostId) return null;
        return resolve(state);
      }

      case 'next_round': {
        if (state.phase !== 'results' || player.id !== state.hostId) return null;
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
      if (state.phase === 'writing') {
        // Hide everyone's answers during writing; show only who has submitted.
        const submittedIds = Object.keys(round.submissions);
        round = {
          number: round.number,
          phase: round.phase,
          letter: round.letter,
          categories: round.categories,
          deadline: round.deadline,
          submittedIds,
          submittedCount: submittedIds.length,
          yourAnswers: round.submissions[playerId]?.answers || null,
        };
      }
      // In 'results' the full round (with results) is revealed as-is.
    }
    return { ...state, round, players: state.players.map(({ socketId, ...rest }) => rest) };
  },

  onPlayerDisconnect(state, player) {
    // Don't let a disconnect hang the round: if everyone still here has submitted, resolve.
    if (state.phase === 'writing') {
      const connected = state.players.filter((p) => p.connected);
      const allIn = connected.length > 0 && connected.every((p) => state.round.submissions[p.id]);
      if (allIn) return resolve(state);
    }
    return null;
  },
};

// ── helpers ──────────────────────────────────────────────────────────────────
function startRound(state) {
  const nextRound = state.currentRound + 1;
  const letter = pickLetter(state.usedLetters);
  const categories = pickCategories(state.categoriesPerRound, state.usedCats);
  return {
    ...state,
    status: 'playing',
    phase: 'writing',
    currentRound: nextRound,
    usedLetters: [...state.usedLetters, letter],
    usedCats: [...state.usedCats, ...categories].slice(-40), // remember recent to avoid repeats
    round: {
      number: nextRound,
      phase: 'writing',
      letter,
      categories,
      deadline: Date.now() + state.timerSec * 1000,
      submissions: {}, // playerId -> { answers: [] }
      results: null,
    },
  };
}

function resolve(state) {
  const { letter, categories, submissions } = state.round;
  const playerIds = state.players.map((p) => p.id);

  // Score each category: valid (starts with letter) AND unique (no duplicate) = 1 pt.
  const results = categories.map((category, c) => {
    const entries = playerIds.map((pid) => {
      const raw = submissions[pid]?.answers?.[c] || '';
      return { playerId: pid, answer: raw, valid: startsWithLetter(raw, letter) };
    });
    // count normalized valid answers to detect duplicates
    const counts = {};
    for (const e of entries) {
      if (!e.valid) continue;
      const key = normalizeAnswer(e.answer);
      counts[key] = (counts[key] || 0) + 1;
    }
    for (const e of entries) {
      const key = normalizeAnswer(e.answer);
      e.unique = e.valid && counts[key] === 1;
      e.point = e.unique ? 1 : 0;
    }
    return { category, entries };
  });

  const gained = {};
  for (const r of results) for (const e of r.entries) gained[e.playerId] = (gained[e.playerId] || 0) + e.point;

  const players = state.players.map((p) => ({ ...p, score: (p.score ?? 0) + (gained[p.id] ?? 0) }));

  const isFinal = state.currentRound >= state.totalRounds;
  const winner = isFinal ? [...players].sort((a, b) => b.score - a.score)[0] ?? null : null;

  return {
    ...state,
    status: isFinal ? 'finished' : 'playing',
    phase: 'results',
    players,
    winner,
    round: { ...state.round, phase: 'results', results, roundGained: gained },
  };
}
