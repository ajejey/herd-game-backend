import { drawKeywords } from './keywords.js';

/*
  Clover Clues — cooperative word-clue party game (So Clover-inspired, original).

  Each player gets a clover of 4 keyword cards (4 leaves in a ring). They write a
  one-word clue for each of the 4 "zones" linking adjacent leaves
  (clue[i] links leaf[i] and leaf[(i+1)%4]). A decoy 5th card is added and all 5
  shuffled. In resolution, one clover at a time, the team (everyone except its
  author, who stays silent) places 4 of the 5 cards into the correct leaves using
  only the clues. Cooperative score: +1 per correct card, +2 for a perfect clover.
*/

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function enterResolving(state) {
  const order = state.players
    .filter((p) => p.connected && state.clovers[p.id]?.submitted)
    .map((p) => p.id);
  if (order.length === 0) return state;
  return { ...state, phase: 'resolving', resolveOrder: order, resolveIndex: 0, placement: [null, null, null, null], revealing: false };
}

export const CloverGame = {
  minPlayers: 3,

  createInitialState() {
    return {
      phase: null,
      clovers: {},      // playerId -> { keywords:[4], clues:[4]|null, decoy, shuffled:[5], submitted }
      resolveOrder: [],
      resolveIndex: 0,
      placement: [null, null, null, null],
      revealing: false,
      results: {},      // playerId -> { score, correctMask:[4], decoy }
      totalScore: 0,
    };
  },

  onStart(state) {
    const players = state.players;
    const drawn = drawKeywords(players.length * 4);
    const clovers = {};
    players.forEach((p, i) => {
      clovers[p.id] = {
        keywords: drawn.slice(i * 4, i * 4 + 4),
        clues: null,
        decoy: null,
        shuffled: null,
        submitted: false,
      };
    });
    return {
      ...state,
      status: 'playing',
      phase: 'writing',
      clovers,
      resolveOrder: [],
      resolveIndex: 0,
      placement: [null, null, null, null],
      revealing: false,
      results: {},
      totalScore: 0,
    };
  },

  handleAction(state, action, payload, player) {
    switch (action) {
      case 'submit_clues': {
        if (state.phase !== 'writing') return null;
        const clover = state.clovers[player.id];
        if (!clover || clover.submitted) return null;
        const clues = Array.isArray(payload.clues) ? payload.clues : null;
        if (!clues || clues.length !== 4) return null;
        const clean = clues.map((c) => String(c || '').trim().slice(0, 30));
        if (clean.some((c) => !c)) return null; // all four required

        // Decoy: a keyword not used by any clover (keywords or existing decoys).
        const used = new Set();
        for (const c of Object.values(state.clovers)) {
          c.keywords.forEach((k) => used.add(k));
          if (c.decoy) used.add(c.decoy);
        }
        const [decoy] = drawKeywords(1, used);
        const five = decoy ? [...clover.keywords, decoy] : [...clover.keywords];

        const clovers = {
          ...state.clovers,
          [player.id]: { ...clover, clues: clean, decoy: decoy || null, shuffled: shuffle(five), submitted: true },
        };

        const eligible = state.players.filter((p) => p.connected);
        const allDone = eligible.every((p) => clovers[p.id]?.submitted);
        const next = { ...state, clovers };
        return allDone ? enterResolving(next) : next;
      }

      case 'force_resolve': {
        // Host advances from writing even if some haven't submitted (only
        // submitted clovers get resolved).
        if (state.phase !== 'writing') return null;
        if (player.id !== state.hostId) return null;
        return enterResolving(state);
      }

      case 'place_card': {
        if (state.phase !== 'resolving' || state.revealing) return null;
        const authorId = state.resolveOrder[state.resolveIndex];
        if (player.id === authorId) return null; // author is the silent spectator
        const { slot, card } = payload;
        if (!Number.isInteger(slot) || slot < 0 || slot > 3) return null;
        const clover = state.clovers[authorId];
        const placement = [...state.placement];
        if (card === null) {
          placement[slot] = null;
        } else {
          if (!clover.shuffled.includes(card)) return null;
          for (let i = 0; i < 4; i++) if (placement[i] === card) placement[i] = null; // one card per slot
          placement[slot] = card;
        }
        return { ...state, placement };
      }

      case 'confirm_placement': {
        if (state.phase !== 'resolving' || state.revealing) return null;
        const authorId = state.resolveOrder[state.resolveIndex];
        if (player.id === authorId) return null;
        if (state.placement.some((s) => s === null)) return null;
        const clover = state.clovers[authorId];
        const correctMask = state.placement.map((c, i) => c === clover.keywords[i]);
        const correct = correctMask.filter(Boolean).length;
        const score = correct + (correct === 4 ? 2 : 0);
        const results = { ...state.results, [authorId]: { score, correctMask, decoy: clover.decoy } };
        return { ...state, revealing: true, results, totalScore: state.totalScore + score };
      }

      case 'next_clover': {
        if (state.phase !== 'resolving' || !state.revealing) return null;
        const nextIndex = state.resolveIndex + 1;
        if (nextIndex >= state.resolveOrder.length) {
          return { ...state, phase: 'finished', status: 'finished', revealing: false };
        }
        return { ...state, resolveIndex: nextIndex, placement: [null, null, null, null], revealing: false };
      }

      default:
        return null;
    }
  },

  deriveClientState(state, playerId) {
    const base = { ...state, players: state.players.map(({ socketId, ...rest }) => rest) };

    if (state.phase === 'writing') {
      const mine = state.clovers[playerId];
      base.myClover = mine ? { keywords: mine.keywords, submitted: mine.submitted } : null;
      base.cloverStatus = Object.fromEntries(state.players.map((p) => [p.id, !!state.clovers[p.id]?.submitted]));
      delete base.clovers; // never leak others' keywords/clues
      return base;
    }

    if (state.phase === 'resolving') {
      const authorId = state.resolveOrder[state.resolveIndex];
      const clover = state.clovers[authorId];
      const isAuthor = playerId === authorId;
      const active = {
        authorId,
        authorName: state.players.find((p) => p.id === authorId)?.username || 'Player',
        clues: clover.clues,
        cards: clover.shuffled, // the 5 shuffled keyword cards
        isAuthor,
      };
      if (state.revealing) {
        active.solution = clover.keywords;
        active.decoy = clover.decoy;
        active.result = state.results[authorId];
      } else if (isAuthor) {
        // The author already knows the answer — show it, but they must stay silent.
        active.solution = clover.keywords;
        active.decoy = clover.decoy;
      }
      base.active = active;
      base.placement = state.placement;
      base.progress = { index: state.resolveIndex, total: state.resolveOrder.length };
      base.results = state.results;
      base.totalScore = state.totalScore;
      delete base.clovers;
      return base;
    }

    // finished — reveal everything
    return base;
  },
};
