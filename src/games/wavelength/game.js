import { getSpectrum, scoreGuess } from './spectrums.js';

/*
  Spectrum — Wavelength-style guessing game on the engine.

  Round phases:
    clue     : the clue-giver sees the hidden target and writes a clue
    guessing : everyone else slides to where they think the target is
    result   : reveal the target; score each guesser by proximity, and the
               clue-giver gets the best guess's points (reward a good clue)

  Scoring (per round): bullseye 4 / 3 / 2 / 1 / 0 by distance. Highest total
  after N rounds wins.
*/
const DEFAULT_ROUNDS = 6;

export const SpectrumGame = {
  minPlayers: 3,

  createInitialState(settings = {}) {
    const r = Number(settings.rounds);
    return {
      phase: null,
      currentRound: 0,
      totalRounds: Number.isInteger(r) && r >= 3 && r <= 12 ? r : DEFAULT_ROUNDS,
      round: null,
      usedPairs: [],
      giverRotation: 0,
    };
  },

  onStart(state) {
    return startRound({ ...state, currentRound: 0, usedPairs: [], giverRotation: 0 });
  },

  handleAction(state, action, payload, player) {
    switch (action) {
      case 'submit_clue': {
        if (state.phase !== 'clue') return null;
        if (player.id !== state.round.clueGiverId) return null;
        const clue = String(payload.clue || '').trim().slice(0, 80);
        if (!clue) return null;
        return { ...state, phase: 'guessing', round: { ...state.round, clue, phase: 'guessing' } };
      }

      case 'submit_guess': {
        if (state.phase !== 'guessing') return null;
        if (player.id === state.round.clueGiverId) return null; // giver doesn't guess
        const v = Number(payload.value);
        if (!Number.isFinite(v) || v < 0 || v > 100) return null;
        if (state.round.guesses.find((g) => g.playerId === player.id)) return null;
        const guesses = [...state.round.guesses, { playerId: player.id, value: Math.round(v) }];
        const guessers = state.players.filter((p) => p.connected && p.id !== state.round.clueGiverId);
        const all = guessers.length > 0 && guessers.every((p) => guesses.find((g) => g.playerId === p.id));
        if (all) return resolve({ ...state, round: { ...state.round, guesses } });
        return { ...state, round: { ...state.round, guesses } };
      }

      case 'force_reveal': {
        if (state.phase !== 'guessing' || player.id !== state.hostId) return null;
        return resolve(state);
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
      const amGiver = playerId === round.clueGiverId;
      const out = { ...round, youAreClueGiver: amGiver };
      // Only the clue-giver sees the target before the reveal.
      if (!amGiver && state.phase !== 'result') out.target = null;
      // Hide the clue until the giver has submitted it (phase moves to guessing).
      if (state.phase === 'clue') out.clue = null;
      // During guessing, show each player only their own guess (count for progress).
      if (state.phase === 'guessing') {
        out.guessCount = round.guesses.length;
        out.guesses = round.guesses.filter((g) => g.playerId === playerId);
      }
      round = out;
    }
    return { ...state, round, players: state.players.map(({ socketId, ...rest }) => rest) };
  },

  onPlayerDisconnect(state, player) {
    // If the clue-giver bails during 'clue', the round can't proceed — restart it
    // with a fresh giver so the game doesn't hang.
    if (state.phase === 'clue' && player?.id === state.round.clueGiverId) {
      return startRound({ ...state, currentRound: state.currentRound - 1 });
    }
    if (state.phase === 'guessing') {
      const guessers = state.players.filter((p) => p.connected && p.id !== state.round.clueGiverId);
      const all = guessers.length > 0 && guessers.every((p) => state.round.guesses.find((g) => g.playerId === p.id));
      if (all) return resolve(state);
    }
    return null;
  },
};

// ── helpers ──────────────────────────────────────────────────────────────────
function startRound(state) {
  const nextRound = state.currentRound + 1;
  const spec = getSpectrum(state.usedPairs);
  const connected = state.players.filter((p) => p.connected);
  const giver = connected[state.giverRotation % Math.max(connected.length, 1)] || state.players[0];

  return {
    ...state,
    status: 'playing',
    phase: 'clue',
    currentRound: nextRound,
    usedPairs: [...state.usedPairs, spec.leftLabel + '|' + spec.rightLabel],
    giverRotation: state.giverRotation + 1,
    round: {
      number: nextRound,
      phase: 'clue',
      leftLabel: spec.leftLabel,
      rightLabel: spec.rightLabel,
      target: spec.target,          // hidden from non-givers until result
      clueGiverId: giver.id,
      clue: null,
      guesses: [],
      result: null,
    },
  };
}

function resolve(state) {
  const { target, guesses, clueGiverId } = state.round;
  const scored = guesses.map((g) => ({ ...g, points: scoreGuess(g.value, target) }));
  const best = scored.reduce((m, g) => Math.max(m, g.points), 0);

  const byPlayer = {};
  for (const g of scored) byPlayer[g.playerId] = g.points;
  byPlayer[clueGiverId] = (byPlayer[clueGiverId] ?? 0) + best; // giver earns the team's best

  const players = state.players.map((p) => ({ ...p, score: (p.score ?? 0) + (byPlayer[p.id] ?? 0) }));

  const isFinal = state.currentRound >= state.totalRounds;
  let winner = null;
  if (isFinal) winner = [...players].sort((a, b) => b.score - a.score)[0] ?? null;

  return {
    ...state,
    status: isFinal ? 'finished' : 'playing',
    phase: 'result',
    players,
    winner,
    round: { ...state.round, phase: 'result', result: { target, scored, best } },
  };
}
