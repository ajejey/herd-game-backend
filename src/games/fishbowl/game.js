import { playingRoster } from '../roster.js';
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
// 2 words per player, not 3: the bowl is played through THREE times, so every
// extra word costs three rounds of play. Prod showed only 22% of started games
// ever finished — the game was simply too long. 4 players now means an 8-word
// bowl instead of 12, cutting a third of the length without losing any round.
const DEFAULT_WORDS = 2;
const DEFAULT_TURN_SEC = 45;
const ROUND_NAMES = { 1: 'Describe it (no saying the word)', 2: 'Act it out (no words)', 3: 'One word only' };

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

export const FishbowlGame = {
  // 3, not 4. A third of all Fishbowl rooms filled to 2-3 players and could
  // never start, because two teams need 4. With 3 we drop into CO-OP mode:
  // one shared bowl, one shared score, the clue-giver rotates and everyone
  // else guesses. Still a real game, and it unblocks those rooms.
  minPlayers: 3,

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
    /* Put returning players back on a team before anything reads the teams. */
    state = ensureTeamed(state);
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
    /*
      The team whose turn it is has just emptied, so nobody can move: start_turn
      requires being the current giver, currentGiverId returns null when that
      team has no connected member, and only endTurn hands play across. The
      bowl never empties, the round never advances, the room is finished with
      nobody able to finish it. Same hole as Taboo's, found the same way.
    */
    if (state.phase === 'playing' && !state.turn
        && teamMembers(state, state.currentTeam).length === 0) {
      return endTurn(state);
    }
    return null;
  },
};

// ── helpers ──────────────────────────────────────────────────────────────────
/*
  The other half of the team rule: anyone connected who is on no team gets one.

  beginRounds builds the teams from whoever is present, which keeps lobby
  ghosts out and gets the co-op threshold right. That alone would strand a
  player who blipped during the countdown, so this puts them back the moment
  they act — into the smaller team, so a late return cannot lopside the game.

  Lazily applied because the engine has no reconnect hook: a rejoin restores
  the socket and flips `connected` back on, and nothing tells the game. Every
  action passing through handleAction is enough.
*/
function ensureTeamed(state) {
  if (!state.teams) return state;
  const onTeam = new Set([...state.teams.A, ...state.teams.B]);
  const missing = state.players.filter((p) => p.connected && !onTeam.has(p.id));
  if (missing.length === 0) return state;
  const teams = { A: [...state.teams.A], B: [...state.teams.B] };
  for (const p of missing) {
    if (state.coop) teams.A.push(p.id);
    else (teams.A.length <= teams.B.length ? teams.A : teams.B).push(p.id);
  }
  return { ...state, teams };
}

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
  /*
    Teams come from playingRoster() — here, or away for only a moment — and
    ensureTeamed() puts back anyone who returns after that. Both obvious
    answers are wrong, and each has shipped:

    `p.connected` alone strands a player whose socket blipped during the
    countdown: never a giver, never a guesser, their words still in the bowl,
    and reconnecting changed nothing because the lists were already written.
    That is the Clover complaint in a different game.

    `state.players` alone — the first attempt at this fix — hands teams to
    LOBBY GHOSTS, because that array never shrinks. Six open a lobby, three
    wander off, three start, and the three who left can be the whole of team A:
    no connected member, currentGiverId returns null, start_turn needs the
    giver and end_turn needs a turn, so nobody — host included — has a legal
    move. The milder and far commoner version is one ghost pushing a real
    3-player game over the `< 4` threshold, so three people play 2-v-1 against
    a phantom.

    What separates the two is TIME, which the engine already records as
    `disconnectedAt`. See games/roster.js.
  */
  const roster = playingRoster(state);
  // Fewer than 4 can't make two teams — play co-op: everyone on one team,
  // giver rotates, shared score.
  const coop = roster.length < 4;
  const teams = { A: [], B: [] };
  if (coop) roster.forEach((p) => teams.A.push(p.id));
  else roster.forEach((p, i) => teams[i % 2 === 0 ? 'A' : 'B'].push(p.id));
  const allWords = shuffle(Object.values(state.submissions).flat());
  if (allWords.length === 0) return state; // nothing submitted — can't begin
  return {
    ...state,
    phase: 'playing',
    coop,
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
  // In co-op there is no other team to pass to — the giver just rotates.
  const other = team === 'A' ? 'B' : 'A';
  const nextTeam = teamMembers(state, other).length > 0 ? other : team;
  return { ...state, turn: null, lastTurn, giverIndex, currentTeam: nextTeam };
}

function advanceRound(state) {
  // called when the bowl just emptied during a turn
  const finishedTurn = endTurn(state); // pass play to the other team, clear turn
  const nextRound = state.roundType + 1;
  if (nextRound > 3) {
    // Co-op has no winning team — the shared score IS the result.
    const winner = state.coop ? null
      : state.teamScores.A === state.teamScores.B ? null
        : state.teamScores.A > state.teamScores.B ? 'A' : 'B';
    return { ...finishedTurn, status: 'finished', roundType: 3, bowl: [], winner };
  }
  return { ...finishedTurn, roundType: nextRound, bowl: shuffle(state.allWords) };
}
