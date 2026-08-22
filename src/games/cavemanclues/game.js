import { shuffledDeck } from './words.js';
import { illegalWords } from './syllables.js';
import { normalizeAnswer } from '../../utils/answerNormalizer.js';

/*
  Caveman Clues on the engine.

  One player sees a secret word and describes it to everyone else USING ONLY
  ONE-SYLLABLE WORDS. Everyone else races to type the answer. The giver rotates
  each round.

  Design notes worth keeping:

  The computer is the referee, and that is the whole reason to build this. In
  the boxed version a human has to catch multi-syllable slips live and is bad at
  it. Here the rule is enforced exactly, which makes the screen version better
  than the box — rarely true, and the reason this one is worth the effort.

  TWO kinds of illegal clue, handled deliberately differently:

    a SLIP (a word of 2+ syllables) is SENT, everyone sees it, the giver loses a
    point. Faithful — in the physical game they said it out loud, so hiding it
    would be wrong, and the groan is the fun.

    a clue containing the ANSWER is REJECTED. Never sent, no penalty. Not the
    same thing at all: a slip is comedy, giving the answer away ends the round
    for everyone.

  No server timers, like every other game here — the client drives the deadline
  and the server only validates. See ROBUSTNESS.md.
*/
const DEFAULT_TURN_SEC = 90;
const DEFAULT_ROUNDS = 3;
/*
  A soft ceiling on total turns, separate from rounds-each.

  "Rounds" means turns EACH, so six players at five rounds is thirty turns —
  forty-five minutes for a game people sit down to for ten.

  Raised to the player count when the room is bigger, because the ceiling and
  the marketing were written to different numbers: the game is advertised as
  3-20 players and a flat 15 meant five people in a full room only ever guessed.
  Everyone gives clues at least once; the rotation decides who gets a second.
*/
const MAX_TURNS = 15;
const turnBudget = (playerCount) => Math.max(MAX_TURNS, playerCount);
const MAX_CLUE_LEN = 120;
const MAX_GUESS_LEN = 40;
const MAX_CLUES = 40;   // a giver spamming clues must not grow state unbounded
const MAX_GUESSES = 80;

export const CavemanCluesGame = {
  minPlayers: 3,

  createInitialState(settings = {}) {
    const r = Number(settings.rounds);
    const t = Number(settings.turnSec);
    return {
      phase: null,                 // 'clue' | 'reveal' | 'finished'
      turnSec: Number.isInteger(t) && t >= 45 && t <= 180 ? t : DEFAULT_TURN_SEC,
      totalRounds: Number.isInteger(r) && r >= 3 && r <= 8 ? r : DEFAULT_ROUNDS,
      customWords: Array.isArray(settings.customQuestions) && settings.customQuestions.length
        ? settings.customQuestions.slice(0, 200).map(String)
        : null,
      /*
        Words the HOST's browser has already been dealt, in past games. They go
        to the back of the deck rather than out of it — see shuffledDeck. This
        is what stops the tenth game in a row from feeling like the first one
        again, and it is the host's list because the host is the person who
        plays this repeatedly.
      */
      exclude: Array.isArray(settings.exclude)
        ? settings.exclude.slice(0, 400).map(String)
        : null,
      deck: [],
      deckIndex: 0,
      giverOrder: [],
      round: 0,
      totalTurns: 0,               // fixed at kickoff; see onStart
      lastGiverId: null,           // the rotation anchors on WHO, not on an index
      turn: null,                  // { giverId, clues, guesses, slips, solvedBy, deadline }
      lastTurn: null,              // { word, giverId, solvedBy, giverGain, guesserGain }
      scores: {},                  // playerId -> number
      winner: null,
    };
  },

  onStart(state) {
    /*
      EVERYONE in the room, not just whoever happened to be connected at the
      instant the host pressed Start.

      It used to be the connected list, which meant a player whose socket
      blipped at kickoff was written out of the rotation permanently — no turn
      as clue giver for the whole game, and no score entry, so they could not
      even be a tied winner. Mobile browsers drop sockets constantly, which is
      the same reason onPlayerDisconnect below is deliberately a no-op.
    */
    const everyone = state.players;
    const deck = state.customWords ? shuffleOf(state.customWords) : shuffledDeck(state.exclude);
    const scores = {};
    everyone.forEach((p) => { scores[p.id] = 0; });

    /*
      Fixed here, once. Recomputing it from the currently-connected count meant
      three people leaving could drop the target below the round already
      reached and end the game on the spot — everyone else watching "Round 9 of
      15" jump straight to final scores with no explanation.

      Also bounded by the deck: a custom pack shorter than the turn count would
      otherwise re-deal its last word every turn, handing every guesser an
      answer they had just been shown.
    */
    const totalTurns = Math.min(
      state.totalRounds * Math.max(1, everyone.length),
      turnBudget(everyone.length),
      deck.length,
    );

    return beginTurn({
      ...state,
      status: 'playing',
      deck,
      deckIndex: 0,
      giverOrder: everyone.map((p) => p.id),
      lastGiverId: null,
      totalTurns,
      round: 0,
      scores,
      lastTurn: null,
      winner: null,
    });
  },

  handleAction(state, action, payload, player) {
    if (!player) return null;

    /*
      `payload = {}` as a default parameter is NOT enough: a default only fills
      in for `undefined`, and this arrives straight off a socket where `null` is
      just as easy to send. A raw-socket test with `payload: null` threw here —
      caught by the engine's safe() wrapper, so nothing crashed, but the action
      silently did nothing and the only trace was a stack trace in the logs.
    */
    const data = payload && typeof payload === 'object' ? payload : {};

    if (action === 'clue') return giveClue(state, data, player);
    if (action === 'guess') return makeGuess(state, data, player);
    if (action === 'skip') return skipWord(state, player);
    if (action === 'end_turn') return endTurn(state, player);
    if (action === 'next_round') return nextRound(state, player);
    return null;
  },

  deriveClientState(state, playerId) {
    const base = { ...state, players: state.players.map(({ socketId, ...rest }) => rest) };

    /*
      THE line that matters, per the role visibility matrix in
      CAVEMAN_CLUES_PLAN.md. During a turn the secret word goes to the Clue
      Giver and to nobody else. Not hidden with CSS — absent from the payload,
      because the Android app ships a frozen front end that cannot be trusted to
      hide anything, and because a guesser can open dev tools.
    */
    base.word = null;
    if (state.turn && state.phase === 'clue' && playerId === state.turn.giverId) {
      base.word = currentWord(state);
    }
    // Once the round is over everyone sees it — that IS the reveal.
    if (state.phase === 'reveal' || state.phase === 'finished') {
      base.word = state.lastTurn ? state.lastTurn.word : null;
    }

    // The rest of the deck is the next eight answers. It never leaves the server.
    delete base.deck;
    delete base.customWords;
    /* Knowing which words are NOT coming is a hint, and 200 strings in every
       payload to every player is a lot of bandwidth for a hint. */
    delete base.exclude;

    /*
      "You tried to say the answer" is the giver's business alone. Telling a
      guesser that a rejected clue happened is a hint in itself, and carrying
      any part of it is how the word leaked in the first place.
    */
    if (base.turn && playerId !== base.turn.giverId) {
      const { rejected: _hidden, rejectedAt: _when, ...rest } = base.turn;
      base.turn = rest;
    }

    base.wordsLeft = Math.max(0, state.deck.length - state.deckIndex);
    base.isGiver = !!state.turn && playerId === state.turn.giverId;

    /* Which turn of how many. A party game with no visible end is one people
       drift away from — nobody can decide to stay for "one more" if they cannot
       see how many are left. Computed here so the client never has to work out
       the rotation maths for itself and get it subtly different. */
    base.turnNumber = Math.min(state.round + 1, state.totalTurns);
    base.totalTurns = state.totalTurns;
    return base;
  },

  onPlayerDisconnect(state, player) {
    /*
      Deliberately does NOT end the round.

      It used to, and an e2e reload proved why that was wrong: a giver who
      reloads, locks their phone, or loses signal for two seconds would kill the
      round for everyone. Mobile browsers background tabs constantly, so that
      fires far more often than a giver actually leaving, and it is indis-
      tinguishable from the game randomly ending.

      Instead the room is never frozen: endTurn below lets ANYONE end a turn
      whose giver is disconnected. A blip costs nothing; a genuine walk-out is
      one tap for whoever notices.
    */
    void player;
    return null;
  },
};

/* ── helpers ─────────────────────────────────────────────────────────────── */

function shuffleOf(list) {
  const deck = [...new Set(list.map((w) => String(w).trim()).filter(Boolean))];
  for (let i = deck.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function currentWord(state) {
  return state.deck[state.deckIndex] || null;
}

/*
  Whose turn is it next.

  Anchored on WHO gave last, not on a counter into a list whose length changes.
  The old `order[giverPos % order.length]` re-indexed the whole rotation every
  time someone dropped: with four players and p0 leaving after turn two, the
  observed sequence was p0, p1, p3, p1 — p2 skipped entirely while p1 gave clues
  twice. The engine's own kick handler re-anchors by playerId for the same
  reason.

  Skips whoever is currently disconnected without shifting anyone else, so a
  blip costs that person one turn rather than their place in the queue.
*/
function nextGiverId(state) {
  const order = state.giverOrder || [];
  if (!order.length) return null;
  const at = state.lastGiverId ? order.indexOf(state.lastGiverId) : -1;
  for (let i = 1; i <= order.length; i += 1) {
    const id = order[(at + i + order.length) % order.length];
    if (state.players.find((p) => p.id === id && p.connected)) return id;
  }
  return null;   // nobody is connected
}

function beginTurn(state) {
  const giverId = nextGiverId(state);
  if (!giverId || state.round >= state.totalTurns) return finish(state);

  return {
    ...state,
    phase: 'clue',
    lastGiverId: giverId,
    turn: { giverId, clues: [], guesses: [], slips: 0, solvedBy: null, startedAt: Date.now() },
  };
}

function giveClue(state, payload, player) {
  if (state.phase !== 'clue' || !state.turn) return null;
  if (player.id !== state.turn.giverId) return null;
  if (state.turn.clues.length >= MAX_CLUES) return null;

  const text = String(payload.text || '').trim().slice(0, MAX_CLUE_LEN);
  if (!text) return null;

  /*
    Saying the answer is refused outright, and the check is on the NORMALISED
    form so "elephants" is caught for "Elephant" — the same normaliser the
    guessing uses, so the two can never disagree about what counts as the word.
  */
  const word = currentWord(state);
  const target = normalizeAnswer(word || '');
  const saidTheWord = text
    .split(/[^A-Za-z']+/)
    .filter(Boolean)
    .some((w) => normalizeAnswer(w) === target);
  if (saidTheWord) {
    /*
      The text is NOT stored.

      It was, and that broadcast the answer to the whole room: state.turn is
      spread into every player's payload by deriveClientState, so a clue
      rejected FOR containing the secret handed the secret to everyone — the
      exact opposite of what rejecting it is for. The giver's screen shows a
      fixed line and never echoes what they typed, so the text was only ever a
      liability.

      deriveClientState also scrubs `rejected` for non-givers, because one
      guard on a secret is not enough.
    */
    return { ...state, turn: { ...state.turn, rejected: { reason: 'answer' }, rejectedAt: Date.now() } };
  }

  const bad = illegalWords(text);
  const clue = { text, by: player.id, bad, at: Date.now() };
  return {
    ...state,
    turn: {
      ...state.turn,
      clues: [...state.turn.clues, clue],
      slips: state.turn.slips + (bad.length ? 1 : 0),
      rejected: null,
    },
  };
}

function makeGuess(state, payload, player) {
  if (state.phase !== 'clue' || !state.turn) return null;
  if (player.id === state.turn.giverId) return null;      // the giver knows it
  if (state.turn.solvedBy) return null;                   // already won, ignore
  if (state.turn.guesses.length >= MAX_GUESSES) return null;

  const text = String(payload.text || '').trim().slice(0, MAX_GUESS_LEN);
  if (!text) return null;

  const word = currentWord(state);
  const right = !!word && normalizeAnswer(text) === normalizeAnswer(word);
  const guess = { text, by: player.id, right, at: Date.now() };
  const turn = { ...state.turn, guesses: [...state.turn.guesses, guess] };

  if (!right) return { ...state, turn };
  return revealTurn({ ...state, turn }, player.id);
}

function skipWord(state, player) {
  if (state.phase !== 'clue' || !state.turn) return null;
  if (player.id !== state.turn.giverId) return null;
  if (state.deckIndex + 1 >= state.deck.length) return null;   // never run dry
  return {
    ...state,
    deckIndex: state.deckIndex + 1,
    turn: { ...state.turn, clues: [], guesses: [], slips: state.turn.slips, rejected: null },
  };
}

function endTurn(state, player) {
  if (state.phase !== 'clue' || !state.turn) return null;

  /*
    The giver may always end their own turn. Anyone else may end it when the
    room would otherwise be stuck: the clock is spent, or the giver is no longer
    connected. Without the second case a giver who closes their laptop leaves
    everyone staring at a clue box nobody can fill until the timer runs out.
  */
  if (player.id === state.turn.giverId) return revealTurn(state, null);

  const spent = Date.now() - state.turn.startedAt > state.turnSec * 1000;
  const giverGone = !state.players.find((p) => p.id === state.turn.giverId && p.connected);
  if (!spent && !giverGone) return null;
  return revealTurn(state, null);
}

function revealTurn(state, solverId) {
  const word = currentWord(state);
  const { giverId, slips } = state.turn;

  /*
    Floored at zero WITHIN the round. A giver who slips four times scores 0 for
    that round, not -4. Losing points you already earned reads as punishment and
    people stop playing; scoring nothing reads as a bad round.
  */
  const giverGain = Math.max(0, (solverId ? 1 : 0) - slips);
  const guesserGain = solverId ? 2 : 0;

  const scores = { ...state.scores };
  scores[giverId] = (scores[giverId] || 0) + giverGain;
  if (solverId) scores[solverId] = (scores[solverId] || 0) + guesserGain;

  return {
    ...state,
    phase: 'reveal',
    scores,
    turn: { ...state.turn, solvedBy: solverId },
    lastTurn: { word, giverId, solvedBy: solverId, giverGain, guesserGain, slips, clues: state.turn.clues },
  };
}

function nextRound(state, player) {
  if (state.phase !== 'reveal') return null;
  // Anyone may advance. Waiting on one person who has put their phone down is
  // the most common way a party game dies.
  void player;

  /*
    The deck is walked, never clamped. It used to pin deckIndex at the last card
    when it ran out, which re-dealt the same word every remaining turn — every
    guesser already knowing the answer from the reveal they had just watched.
    totalTurns is now bounded by deck length at kickoff, so running out means
    the game is over.
  */
  const advanced = {
    ...state,
    deckIndex: state.deckIndex + 1,
    round: state.round + 1,
    turn: null,
  };
  if (advanced.deckIndex >= state.deck.length || advanced.round >= state.totalTurns) {
    return finish(advanced);
  }
  return beginTurn(advanced);
}

function finish(state) {
  const entries = Object.entries(state.scores);
  const top = entries.reduce((best, [id, n]) => (n > best.n ? { id, n } : best), { id: null, n: -1 });
  // Ties are reported as ties rather than resolved arbitrarily.
  const tied = entries.filter(([, n]) => n === top.n).map(([id]) => id);
  return {
    ...state,
    status: 'finished',
    phase: 'finished',
    turn: null,
    winner: tied.length > 1 ? null : top.id,
    tiedWinners: tied.length > 1 ? tied : null,
  };
}
