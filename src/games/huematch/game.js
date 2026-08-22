import { COLS, ROWS, colourAt, labelOf, inBounds, scoreFor, ringDistance } from './grid.js';
import { rejectCue } from './hueWords.js';

/*
  Hue Match on the engine.

  A grid of colours. One player secretly sees one square, gives a ONE-word cue,
  everyone places a marker; then a TWO-word cue and a second marker. Reveal and
  score by how close each marker landed.

  TWO SECRETS, not one — see HUE_MATCH_PLAN.md. The target is obvious. The
  second is that a guesser must not see anyone ELSE'S marker before the reveal:
  otherwise whoever locks in first decides the round and everyone copies. That
  one is easy to miss precisely because it is not the "real" secret, so
  deriveClientState strips it explicitly rather than relying on nobody asking.

  Rules the computer enforces, because the boxed game argues about both: the cue
  is exactly one word then exactly two, and it may not name a colour or a
  position on the board.

  No server timers, like every other game here — the client drives the deadline
  and the server only validates. See ROBUSTNESS.md.
*/
const DEFAULT_ROUNDS = 1;      // turns each
/*
  A HARD ceiling on turns, and the number is derived rather than inherited.

  A Hue Match turn is four phases — cue, guess, cue, guess — plus a reveal, so
  roughly two to three minutes. Eight turns is a 15-to-20 minute session, which
  is a party game; twenty turns is an hour, which is a chore.

  The cap used to be written `Math.max(MAX_TURNS, everyone.length)`, which caps
  nothing at all above twelve players: a 20-player room asked for 20 turns and
  got them. It was copied from Caveman Clues, where a turn is ONE 90-second
  phase and the same arithmetic is fine.

  THE TRADE-OFF, stated because it is a real one: past eight players, not
  everyone gets to be the Cue Giver. That costs much less here than it would in
  Caveman Clues — a guesser in this game taps and scores on every single round,
  so nobody is ever sitting out. Giving the cues is the bonus, not the game.
*/
const MAX_TURNS = 8;
const DEFAULT_GUESS_SEC = 60;
const MAX_CUE_LEN = 40;

/* A giver in a big room could otherwise out-score everyone by existing. */
const GIVER_CAP = 6;

/*
  How long past the deadline before anyone may push the room forward.

  The clock is the client's, not the server's (see ROBUSTNESS.md), so phones
  disagree about when it ran out by a second or two. The grace period means a
  fast phone cannot cut off a slow one that is still mid-tap.
*/
const GRACE_SEC = 3;

export const HueMatchGame = {
  minPlayers: 3,

  createInitialState(settings = {}) {
    const r = Number(settings.rounds);
    const t = Number(settings.guessSec);
    return {
      phase: null,               // 'clue1' | 'guess1' | 'clue2' | 'guess2' | 'reveal' | 'finished'
      cols: COLS,
      rows: ROWS,
      guessSec: Number.isInteger(t) && t >= 30 && t <= 180 ? t : DEFAULT_GUESS_SEC,
      totalRounds: Number.isInteger(r) && r >= 1 && r <= 4 ? r : DEFAULT_ROUNDS,
      totalTurns: 0,             // fixed at kickoff
      giverOrder: [],
      lastGiverId: null,
      round: 0,
      turn: null,                // { giverId, target, cue1, cue2, markers, startedAt }
      lastTurn: null,
      scores: {},
      winner: null,
      tiedWinners: null,
    };
  },

  onStart(state) {
    /* Everyone in the room, not whoever happened to be connected at the instant
       Start was pressed — a socket blip at kickoff must not write someone out
       of the rotation for the whole game. */
    const everyone = state.players;
    const scores = {};
    everyone.forEach((p) => { scores[p.id] = 0; });

    return beginTurn({
      ...state,
      status: 'playing',
      giverOrder: everyone.map((p) => p.id),
      lastGiverId: null,
      totalTurns: Math.max(1, Math.min(state.totalRounds * Math.max(1, everyone.length), MAX_TURNS)),
      round: 0,
      scores,
      lastTurn: null,
      winner: null,
      tiedWinners: null,
    });
  },

  handleAction(state, action, payload, player) {
    if (!player) return null;
    /* A default parameter only fills in for `undefined`, and this arrives off a
       socket where `null` is just as easy to send. */
    const data = payload && typeof payload === 'object' ? payload : {};

    if (action === 'cue') return giveCue(state, data, player);
    if (action === 'place') return placeMarker(state, data, player);
    if (action === 'lock') return lockIn(state, player);
    if (action === 'move_on') return moveOn(state, player);
    if (action === 'next_round') return nextRound(state);
    return null;
  },

  deriveClientState(state, playerId) {
    const base = { ...state, players: state.players.map(({ socketId, ...rest }) => rest) };
    const revealing = state.phase === 'reveal' || state.phase === 'finished';

    if (base.turn) {
      const isGiver = playerId === base.turn.giverId;
      const turn = { ...base.turn };

      /*
        SECRET ONE — the target, to the Cue Giver alone until the reveal.

        ALL THREE fields, not just the coordinates. The first version deleted
        `target` and left `targetHex` behind, which is the answer in a more
        useful form: a guesser could read the hex and find the matching square
        instantly, without even needing the cue. `targetLabel` is worse — it is
        literally "G4" in plain text.

        Listed explicitly rather than filtered by name, so a field added later
        has to be considered rather than quietly inheriting a leak.
      */
      if (!isGiver && !revealing) {
        delete turn.target;
        delete turn.targetHex;
        delete turn.targetLabel;
      }

      /*
        SECRET ONE AND A HALF — the refusal.

        Not storing the rejected TEXT was not enough. The reason sent back
        quotes the offending word: try "blue" and every guesser reads
        '"blue" names a colour', which is a bigger hint than any legal cue
        would have been. Even a reason with no word in it is a hint — knowing
        the giver reached for a colour name at all narrows the board.

        This is the Caveman Clues leak wearing different clothes, found by the
        e2e sweep that exists because of it. The general rule, now in
        BUILDING_A_GAME.md: anything the server says about ONE player's
        rejected input belongs to that player alone.
      */
      if (!isGiver) delete turn.rejected;

      /*
        SECRET TWO — other people's markers.

        Without this the first person to lock in decides the round and everyone
        else copies them. It is not the "real" secret, which is exactly why it
        would have been missed: the payload would have looked fine.

        A player always gets their OWN markers back, so a reload restores them.
      */
      if (!revealing) {
        turn.markers = Object.fromEntries(
          Object.entries(turn.markers || {}).filter(([id]) => id === playerId),
        );
        /* Who has finished is public — that is the "waiting for 2 more" line,
           and it reveals nothing about WHERE anyone guessed. */
        /*
          Counted over the players the room is actually WAITING for, which is
          the connected non-givers. Counting every locked marker instead let the
          line read "3 of 2 locked in" the moment one of the three dropped:
          lockedIds kept them and the denominator did not.
        */
        turn.lockedIds = state.players
          .filter((p) => p.connected && p.id !== state.turn.giverId
            && (state.turn.markers[p.id] || {}).locked)
          .map((p) => p.id);
      }
      base.turn = turn;
      base.isGiver = isGiver;
    } else {
      base.isGiver = false;
    }

    base.turnNumber = Math.min(state.round + 1, state.totalTurns);
    return base;
  },

  onPlayerDisconnect(state, player) {
    /*
      Deliberately does NOT end the turn. Mobile browsers background tabs
      constantly, so a blip fires far more often than someone actually leaving.

      It DOES re-check whether the phase can now move, and that is not a nicety.
      A phase advances when everyone still connected has locked in, and that test
      only ran inside lockIn — so if the last person the room was waiting for
      simply closed their tab, nothing recomputed it. Everybody else had already
      locked, and `lockIn` returns null once you are locked, so there was no
      action left in the game that could reach the check. The room sat on
      "3 of 4 locked in" with a 0s clock, permanently, and closing the tab was
      the one thing that made it unrecoverable.
    */
    void player;
    return advanceIfEveryoneLocked(state);
  },
};

/* ── helpers ─────────────────────────────────────────────────────────────── */

function nextGiverId(state) {
  const order = state.giverOrder || [];
  if (!order.length) return null;
  const at = state.lastGiverId ? order.indexOf(state.lastGiverId) : -1;
  for (let i = 1; i <= order.length; i += 1) {
    const id = order[(at + i + order.length) % order.length];
    if (state.players.find((p) => p.id === id && p.connected)) return id;
  }
  return null;
}

function beginTurn(state) {
  const giverId = nextGiverId(state);
  if (!giverId || state.round >= state.totalTurns) return finish(state);

  const target = { col: Math.floor(Math.random() * COLS), row: Math.floor(Math.random() * ROWS) };
  return {
    ...state,
    phase: 'clue1',
    lastGiverId: giverId,
    turn: {
      giverId,
      target,
      targetHex: colourAt(target.col, target.row),
      targetLabel: labelOf(target.col, target.row),
      cue1: null,
      cue2: null,
      rejected: null,
      markers: {},          // playerId -> { a?: {col,row}, b?: {col,row}, locked: bool }
      startedAt: Date.now(),
    },
  };
}

function giveCue(state, data, player) {
  const wantOne = state.phase === 'clue1';
  const wantTwo = state.phase === 'clue2';
  if (!wantOne && !wantTwo) return null;
  if (!state.turn || player.id !== state.turn.giverId) return null;

  const text = String(data.text || '').trim().slice(0, MAX_CUE_LEN);
  const bad = rejectCue(text, wantOne ? 1 : 2);
  if (bad) {
    /* The text is NOT stored. It goes back to the giver as a reason only —
       storing it would put a rejected cue into everyone's payload, which is how
       Caveman Clues leaked its answer. */
    return { ...state, turn: { ...state.turn, rejected: { reason: bad.reason, message: bad.message } } };
  }

  return {
    ...state,
    phase: wantOne ? 'guess1' : 'guess2',
    turn: {
      ...state.turn,
      [wantOne ? 'cue1' : 'cue2']: text,
      rejected: null,
      startedAt: Date.now(),
      markers: Object.fromEntries(
        Object.entries(state.turn.markers).map(([id, m]) => [id, { ...m, locked: false }]),
      ),
    },
  };
}

function placeMarker(state, data, player) {
  const guessing = state.phase === 'guess1' || state.phase === 'guess2';
  if (!guessing || !state.turn) return null;
  if (player.id === state.turn.giverId) return null;         // they can see it

  /*
    Number() is too helpful: Number(null) is 0, so { col: null, row: 0 } was
    silently accepted as a marker on column 0 — a malformed payload treated as
    a deliberate move. Numbers and numeric strings only; everything else is
    something a well-behaved client would never send.
  */
  const num = (v) => {
    if (typeof v === 'number') return v;
    if (typeof v === 'string' && v.trim() !== '') return Number(v);
    return NaN;
  };
  const col = num(data.col);
  const row = num(data.row);
  if (!inBounds(col, row)) return null;

  const mine = state.turn.markers[player.id] || {};
  if (mine.locked) return null;                              // already committed

  const slot = state.phase === 'guess1' ? 'a' : 'b';
  return {
    ...state,
    turn: {
      ...state.turn,
      markers: { ...state.turn.markers, [player.id]: { ...mine, [slot]: { col, row }, locked: false } },
    },
  };
}

/*
  Has everyone still connected finished guessing? If so, move the phase.

  Pulled out of lockIn so a DISCONNECT can ask the same question — see
  onPlayerDisconnect. Returns null when the answer is no, which is also the
  engine's "nothing changed" signal.
*/
function advanceIfEveryoneLocked(state) {
  const guessing = state.phase === 'guess1' || state.phase === 'guess2';
  if (!guessing || !state.turn) return null;

  const markers = state.turn.markers || {};
  const waiting = state.players.filter(
    (p) => p.connected && p.id !== state.turn.giverId && !(markers[p.id] || {}).locked,
  );
  if (waiting.length) return null;

  /* Nobody left to wait for because nobody is left at all — a room that has
     emptied must not be "advanced" into a reveal with no players in it. */
  const anyGuesser = state.players.some((p) => p.connected && p.id !== state.turn.giverId);
  if (!anyGuesser) return null;

  return state.phase === 'guess1'
    ? { ...state, phase: 'clue2', turn: { ...state.turn, startedAt: Date.now() } }
    : reveal(state);
}

/*
  The escape hatch. Every phase in this game waits on one specific person, so
  every phase needs a way past them.

    cue phases   the giver may always end their own turn; anyone else may once
                 the clock is spent or the giver has dropped. Without the second
                 case a giver who shuts their laptop leaves the room staring at
                 a cue box nobody else can fill.
    guess phases anyone may move on once the clock is spent. The auto-lock on
                 the client only fires for a player who has PLACED a marker, so
                 somebody who never taps at all would otherwise hold the room
                 open for as long as they keep the tab open.

  Same shape as Caveman Clues' end_turn and Spectrum's force_reveal, except
  that this one is not host-only: the host is as likely as anyone to be the
  person who wandered off.
*/
function moveOn(state, player) {
  if (!state.turn) return null;
  const cueing = state.phase === 'clue1' || state.phase === 'clue2';
  const guessing = state.phase === 'guess1' || state.phase === 'guess2';
  if (!cueing && !guessing) return null;

  const spent = Date.now() - (state.turn.startedAt || 0) > (state.guessSec + GRACE_SEC) * 1000;
  const giverGone = !state.players.find((p) => p.id === state.turn.giverId && p.connected);

  if (cueing) {
    const isGiver = player.id === state.turn.giverId;
    if (!isGiver && !spent && !giverGone) return null;
    /* Straight to the reveal, scoring whatever was placed. Ending on the reveal
       rather than skipping to the next round means the colour is still shown —
       an abandoned round should not also be a round nobody learns anything from. */
    return reveal(state);
  }

  if (!spent) return null;
  return state.phase === 'guess1'
    ? { ...state, phase: 'clue2', turn: { ...state.turn, startedAt: Date.now() } }
    : reveal(state);
}

function lockIn(state, player) {
  const guessing = state.phase === 'guess1' || state.phase === 'guess2';
  if (!guessing || !state.turn) return null;
  if (player.id === state.turn.giverId) return null;

  const slot = state.phase === 'guess1' ? 'a' : 'b';
  const mine = state.turn.markers[player.id];
  if (!mine || !mine[slot] || mine.locked) return null;      // nothing placed yet

  const markers = { ...state.turn.markers, [player.id]: { ...mine, locked: true } };
  const next = { ...state, turn: { ...state.turn, markers } };

  /* Everyone still CONNECTED — a dropped player must not hold the room. */
  return advanceIfEveryoneLocked(next) || next;
}

function reveal(state) {
  const { target, giverId, markers } = state.turn;
  const scores = { ...state.scores };
  const breakdown = {};
  let giverPoints = 0;

  for (const [id, m] of Object.entries(markers)) {
    if (id === giverId) continue;
    const a = m.a ? scoreFor(m.a, target) : 0;
    const b = m.b ? scoreFor(m.b, target) : 0;
    scores[id] = (scores[id] || 0) + a + b;
    breakdown[id] = {
      a: m.a ? { ...m.a, points: a, distance: ringDistance(m.a, target) } : null,
      b: m.b ? { ...m.b, points: b, distance: ringDistance(m.b, target) } : null,
      total: a + b,
    };
    /* The giver earns for every marker that landed close, capped so a big room
       does not hand them a runaway lead simply for having more guessers. */
    if (a >= 2) giverPoints += 1;
    if (b >= 2) giverPoints += 1;
  }
  giverPoints = Math.min(giverPoints, GIVER_CAP);
  scores[giverId] = (scores[giverId] || 0) + giverPoints;

  return {
    ...state,
    phase: 'reveal',
    scores,
    lastTurn: {
      giverId,
      target,
      targetHex: state.turn.targetHex,
      targetLabel: state.turn.targetLabel,
      cue1: state.turn.cue1,
      cue2: state.turn.cue2,
      breakdown,
      giverPoints,
    },
  };
}

function nextRound(state) {
  if (state.phase !== 'reveal') return null;
  /* Anyone may advance. Waiting on one person who has put their phone down is
     the most common way a party game dies. */
  const advanced = { ...state, round: state.round + 1, turn: null };
  if (advanced.round >= state.totalTurns) return finish(advanced);
  return beginTurn(advanced);
}

function finish(state) {
  const entries = Object.entries(state.scores);
  const top = entries.reduce((best, [id, n]) => (n > best.n ? { id, n } : best), { id: null, n: -1 });
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
