/*
  Two Truths and a Lie — multiplayer on the engine.

  Flow:
    writing  : every player writes 3 statements about themselves and marks which
               is the lie.
    guessing : one player at a time is the "subject"; their 3 statements are shown
               (shuffled, lie hidden) and everyone else guesses which is the lie.
    reveal   : show the lie + who was fooled + scores. Then the next subject.

  Scoring per subject:
    - each guesser who spots the lie: +1
    - the subject: +1 for every player they fooled (guessed wrong)
  Highest total after everyone has been the subject wins.
*/
export const TwoTruthsGame = {
  minPlayers: 3,

  createInitialState() {
    return { phase: null, subjects: [], subjectIndex: 0, submissions: {}, current: null };
  },

  onStart(state) {
    return { ...state, status: 'playing', phase: 'writing', subjects: [], subjectIndex: 0, submissions: {}, current: null };
  },

  handleAction(state, action, payload, player) {
    switch (action) {
      case 'submit_statements': {
        if (state.phase !== 'writing') return null;
        if (state.submissions[player.id]) return null;
        const raw = Array.isArray(payload.statements) ? payload.statements : [];
        const statements = raw.slice(0, 3).map((s) => String(s || '').trim().slice(0, 120));
        const lieIndex = Number(payload.lieIndex);
        if (statements.length !== 3 || statements.some((s) => !s)) return null;
        if (!Number.isInteger(lieIndex) || lieIndex < 0 || lieIndex > 2) return null;

        const submissions = { ...state.submissions, [player.id]: { statements, lieIndex } };
        const eligible = state.players.filter((p) => p.connected);
        const all = eligible.length > 0 && eligible.every((p) => submissions[p.id]);
        const next = { ...state, submissions };
        if (all) return beginSubjects(next, eligible.map((p) => p.id));
        return next;
      }

      case 'force_start': {
        if (state.phase !== 'writing' || player.id !== state.hostId) return null;
        const ready = state.players.filter((p) => p.connected && state.submissions[p.id]).map((p) => p.id);
        if (ready.length < 2) return null;
        return beginSubjects(state, ready);
      }

      case 'submit_guess': {
        if (state.phase !== 'guessing') return null;
        if (player.id === state.current.subjectId) return null;
        const position = Number(payload.position);
        if (!Number.isInteger(position) || position < 0 || position > 2) return null;
        if (state.current.guesses.find((g) => g.voterId === player.id)) return null;
        const guesses = [...state.current.guesses, { voterId: player.id, position }];
        const guessers = state.players.filter((p) => p.connected && p.id !== state.current.subjectId);
        const all = guessers.length > 0 && guessers.every((p) => guesses.find((g) => g.voterId === p.id));
        if (all) return revealSubject({ ...state, current: { ...state.current, guesses } });
        return { ...state, current: { ...state.current, guesses } };
      }

      case 'force_reveal': {
        if (state.phase !== 'guessing' || player.id !== state.hostId) return null;
        return revealSubject(state);
      }

      case 'next': {
        if (state.phase !== 'reveal' || player.id !== state.hostId) return null;
        return advanceSubject(state);
      }

      default:
        return null;
    }
  },

  deriveClientState(state, playerId) {
    const { submissions, ...rest } = state; // never send raw submissions
    let current = state.current;
    if (current) {
      const amSubject = playerId === current.subjectId;
      const out = { ...current, youAreSubject: amSubject };
      if (state.phase !== 'reveal') {
        out.liePosition = null; // hidden until reveal
        out.guessCount = current.guesses.length;
        out.guesses = current.guesses.filter((g) => g.voterId === playerId);
      }
      current = out;
    }
    return {
      ...rest,
      current,
      submittedCount: Object.keys(submissions).length,
      iSubmitted: !!submissions[playerId],
      players: state.players.map(({ socketId, ...p }) => p),
    };
  },

  onPlayerDisconnect(state, player) {
    if (state.phase === 'writing') {
      const eligible = state.players.filter((p) => p.connected);
      const all = eligible.length > 0 && eligible.every((p) => state.submissions[p.id]);
      if (all) return beginSubjects(state, eligible.map((p) => p.id));
    }
    if (state.phase === 'guessing') {
      // if the subject leaves, skip to the next subject
      if (player?.id === state.current.subjectId) return advanceSubject({ ...state, phase: 'reveal' });
      const guessers = state.players.filter((p) => p.connected && p.id !== state.current.subjectId);
      const all = guessers.length > 0 && guessers.every((p) => state.current.guesses.find((g) => g.voterId === p.id));
      if (all) return revealSubject(state);
    }
    return null;
  },
};

// ── helpers ──────────────────────────────────────────────────────────────────
function shuffle3(seedArr) {
  const a = [...seedArr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function beginSubjects(state, subjectIds) {
  return startSubjectAt({ ...state, subjects: subjectIds, subjectIndex: 0 }, 0);
}

function advanceSubject(state) {
  return startSubjectAt(state, state.subjectIndex + 1);
}

// Find the next valid subject (has a submission), or finish the game.
function startSubjectAt(state, fromIndex) {
  let idx = fromIndex;
  while (idx < state.subjects.length) {
    const sid = state.subjects[idx];
    const sub = state.submissions[sid];
    if (sub) {
      const order = shuffle3([0, 1, 2]);
      const statements = order.map((i) => sub.statements[i]);
      const liePosition = order.indexOf(sub.lieIndex);
      return {
        ...state,
        status: 'playing',
        phase: 'guessing',
        subjectIndex: idx,
        current: { subjectId: sid, statements, liePosition, guesses: [], result: null },
      };
    }
    idx += 1;
  }
  // No more subjects — game over.
  const winner = [...state.players].sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0] ?? null;
  return { ...state, status: 'finished', phase: 'reveal', subjectIndex: idx, winner, current: null };
}

function revealSubject(state) {
  const { liePosition, guesses, subjectId } = state.current;
  const players = state.players.map((p) => {
    let add = 0;
    if (p.id !== subjectId) {
      const g = guesses.find((x) => x.voterId === p.id);
      if (g && g.position === liePosition) add = 1; // spotted the lie
    } else {
      add = guesses.filter((x) => x.position !== liePosition).length; // fooled this many
    }
    return { ...p, score: (p.score ?? 0) + add };
  });
  return { ...state, phase: 'reveal', players, current: { ...state.current, result: { liePosition, guesses } } };
}
