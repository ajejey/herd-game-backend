/*
  A name on screen is never allowed to render as nothing.

    node scripts/player-name-check.js

  ── The trap this exists to prevent ──────────────────────────────────────────
  Every engine game names people by id and resolves the id when it draws. The
  round remembers "the Chameleon was <id>"; the screen looks that id up in
  `players`. If the id is not in the array the lookup returns undefined and the
  sentence around it falls apart, at the reveal:

      "The Chameleon was . The word was Compass."   a hole in a sentence
      "undefined gives the clue"                    a template literal, so the
                                                    word `undefined` on screen
      "'s statements"                               a possessive with no owner

  ── What is NOT claimed here ─────────────────────────────────────────────────
  That this is happening in production. It probably is not, and the honest
  version is worth more than a good story.

  It looked live for a while. A session in the analytics had sixteen dead
  clicks on the string "The Chameleon was. The word was." — the sentence with
  both names missing, apparently caught in the act. It is an artifact. PostHog
  captures the text of the element clicked but not the text of elements nested
  inside it, and both names sit in <strong> tags. The same capture returns
  "Caught!was the Chameleon" for the heading one line above, where nothing was
  wrong at all. The names were on screen; the tracker could not see them.

  So the exposure today is small: a player only leaves `state.players` through
  `kick_player`, no game shows a Remove button outside its lobby, and in the
  lobby there is no round yet to name anyone. Disconnects keep the row and only
  clear `connected`. Mid-game fresh joins are refused.

  ── Why guard it anyway ──────────────────────────────────────────────────────
  Because the server is already written for the button that does not exist. It
  handles kicking during a live round and guards exactly one case of it —
  "cannot kick the current judge" — which is what code looks like when someone
  has thought about mid-game removal and stopped one step short. The day that
  button is added, four screens across three games break at the most important
  moment of the round, and they break silently: a missing name reads as a
  rendering glitch, not as a person who left.

  And the hazard is in the data model, not in a maybe. The last section of this
  file builds the state the engine actually produces, runs it through the real
  deriveClientState, and shows the round still naming an id the client cannot
  resolve — in all three games.

  ── Why a sweep and not just the four fixes ──────────────────────────────────
  There were four sites across three games, written months apart by the same
  hand, because the pattern is the obvious thing to write. The next game will
  reach for it too. So the general statement is the deliverable:

      A player name obtained by looking an id up in a players array must have a
      fallback, in every game, including games that do not exist yet.

  Herd Mentality never had the exposure and needed no fallback, because it
  stores the username on the answer itself and looks nothing up. That is the
  better shape where a game can manage it; where it cannot, lib/playerName.js
  is the one way in.

  No database, no browser, no server.
*/
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const FE = path.join(here, '..', '..', 'frontend', 'src');

/*
  This script imports a file out of the frontend, which is a Create React App
  tree: ESM source with no `"type": "module"`, because CRA compiles it with
  babel rather than running it in node. Node is right to mention that and
  there is nothing to fix, so that one warning is dropped and every other
  warning still gets through.
*/
process.removeAllListeners('warning');
process.on('warning', (w) => {
  if (w.code !== 'MODULE_TYPELESS_PACKAGE_JSON') console.error(`${w.name}: ${w.message}`);
});

let failures = 0;
const fail = (m, d = '') => { console.log(`  FAIL  ${m}${d ? '\n          ' + d : ''}`); failures += 1; };
const ok = (m) => console.log(`  ok    ${m}`);

console.log('');
console.log('=== a name on screen is never nothing ===');

if (!fs.existsSync(FE)) {
  console.log('  (frontend not present, skipping)\n');
  process.exit(0);
}

/* Every .js/.jsx/.tsx under components/, recursively. */
function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(js|jsx|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

const files = walk(path.join(FE, 'components'));
const rel = (f) => path.relative(FE, f).replace(/\\/g, '/');

/*
  The shape we forbid: a .find(...) over something player-ish, reached straight
  into `.username` (or .name / .displayName) with nothing catching the miss.

  Deliberately narrow. It matches the lookup-then-read chain and nothing else,
  so it does not fire on `players.find(...)` used for a boolean, a count, or a
  connected check — those cannot put a hole in a sentence.
*/
const LOOKUP = /(?:players|\w*[Pp]layers)\s*(?:\|\|\s*\[\])?\s*\.find\s*\(([^;]{0,200}?)\)\s*\?\.\s*(username|name|displayName)\b/g;

/*
  A fallback on the same expression: `|| something` or `?? something`.

  An EMPTY fallback does not count, and that distinction is the whole point.
  `host?.username || ''` looks guarded and reads as careful, but '' renders
  exactly the same hole as undefined does — it is the bug with an extra step,
  and it is the form most likely to survive review because it looks like
  someone already thought about it.
*/
const HAS_FALLBACK = /^\s*(\|\||\?\?)\s*(['"`])\s*\2/;   // ← an EMPTY one: reject
const HAS_REAL_FALLBACK = /^\s*(\|\||\?\?)/;
const guarded = (after) => HAS_REAL_FALLBACK.test(after) && !HAS_FALLBACK.test(after);

let checked = 0;
const offenders = [];

for (const file of files) {
  const src = fs.readFileSync(file, 'utf8');
  for (const m of src.matchAll(LOOKUP)) {
    checked += 1;
    const after = src.slice(m.index + m[0].length);
    if (guarded(after)) continue;
    const line = src.slice(0, m.index).split('\n').length;
    const empty = HAS_FALLBACK.test(after);
    offenders.push(`${rel(file)}:${line}  reads .${m[2]} off a lookup that can miss`
      + (empty ? ' — and falls back to an empty string, which is the same hole' : ''));
  }
}

/*
  The same bug written over two lines instead of one, which is how it hid.

      const host     = players.find((p) => p.isHost);
      const hostName = host?.username || '';
      ...
      {hostName} has dropped out

  The one-expression grep above cannot see this, and the `|| ''` makes it read
  as handled. It was live in GameRoom.js — the legacy Herd game, the busiest on
  the site — and the giveaway was next door:

      const hostGone = players.length > 0 && (!host || host.isConnected === false);

  `!host` is one of the two things that makes hostGone true, and it is exactly
  the case where hostName is ''. So the banner that only shows when the host is
  missing was the one banner guaranteed to have no name in it: " has dropped
  out — anyone can start now."

  So: any variable assigned from a players lookup, whose `.username` is then
  read somewhere else in the file, must be guarded at the point of use — by a
  ternary on the variable, a `&&`, or a fallback.

  An empty-string fallback is NOT flagged here, deliberately. `hostName = ...
  || ''` is a legitimate sentinel when every render checks it, and GameRoom
  does exactly that in seven of its ten uses. Flagging the declaration would
  cry wolf on a deliberate pattern; the three that were actually broken were
  the *renders*, which the next rule catches. Check the use, not the intent.

  Shadowing has to be respected or this is useless: `const p = players.find(…)`
  followed later by `state.players.map(p => … p.username …)` is a different `p`
  entirely, and reading the first one's rules onto the second produced a
  confident, wrong finding on the first run. So the search stops at the next
  re-binding of the name.
*/
const TWO_STEP = /(?:const|let|var)\s+(\w+)\s*=\s*[\w.?]*[Pp]layers[\w.?]*\.find\s*\(/g;

for (const file of files) {
  const src = fs.readFileSync(file, 'utf8');
  for (const d of src.matchAll(TWO_STEP)) {
    const v = d[1];
    /* Where this binding stops meaning what we think: another declaration of
       the same name, or an arrow/function parameter that reuses it. */
    const rebind = new RegExp(
      `(?:const|let|var)\\s+${v}\\b|\\(\\s*${v}\\s*[,)]|(?:^|[^\\w.])${v}\\s*=>`, 'g');
    rebind.lastIndex = d.index + d[0].length;
    const next = rebind.exec(src);
    const stop = next ? next.index : src.length;

    const read = new RegExp(`\\b${v}\\s*\\??\\.\\s*(username|name|displayName)\\b`, 'g');
    for (const r of src.matchAll(read)) {
      if (r.index < d.index || r.index >= stop) continue;
      const lineStart = src.lastIndexOf('\n', r.index) + 1;
      const lineEnd = src.indexOf('\n', r.index);
      const line = src.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
      const after = src.slice(r.index + r[0].length);
      /* Guarded by a ternary/&& on the variable itself, on this line... */
      if (new RegExp(`\\b${v}\\s*(\\?[^.]|&&)`).test(line)) continue;
      /* ...or by any fallback right after the read, empty one included. */
      if (HAS_REAL_FALLBACK.test(after)) continue;
      const n = src.slice(0, r.index).split('\n').length;
      offenders.push(`${rel(file)}:${n}  ${v}.${r[1]} can be empty at the point it is read`);
    }
  }
}

/*
  ...and the last mile: a variable that IS safely built can still be rendered
  raw somewhere the author forgot. Catch `{x}` in JSX where x is a known
  name-ish variable carrying an empty-string fallback.
*/
const EMPTY_FALLBACK_VAR = /(?:const|let|var)\s+(\w*(?:[Nn]ame))\s*=\s*[^;\n]*?\?\.\s*(?:username|name)\s*(?:\|\||\?\?)\s*(['"`])\s*\2/g;

for (const file of files) {
  const src = fs.readFileSync(file, 'utf8');
  for (const d of src.matchAll(EMPTY_FALLBACK_VAR)) {
    const v = d[1];
    const raw = new RegExp(`\\{\\s*${v}\\s*\\}`, 'g');
    for (const r of src.matchAll(raw)) {
      const lineStart = src.lastIndexOf('\n', r.index) + 1;
      const lineEnd = src.indexOf('\n', r.index);
      const line = src.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
      if (new RegExp(`\\b${v}\\s*(\\?[^.]|&&|\\|\\|)`).test(line)) continue;
      const n = src.slice(0, r.index).split('\n').length;
      offenders.push(`${rel(file)}:${n}  {${v}} renders nothing when the lookup missed`);
    }
  }
}

if (offenders.length) {
  fail(`${offenders.length} name lookup(s) with no fallback`,
    [...new Set(offenders)].join('\n          ')
      + '\n\n          Use nameOf(players, id) from lib/playerName.js, or guard the use.');
} else {
  ok(`every player-name lookup has a fallback (${checked} guarded, ${files.length} files swept)`);
}

/*
  The second half of the same bug, and the more embarrassing one.

  In JSX, `{name}` with an undefined name renders nothing — a hole. Inside a
  TEMPLATE LITERAL it renders the six characters `undefined`, in front of the
  player. Spectrum shipped `${giverName} gives the clue` and that is exactly
  what a room saw. So template literals interpolating a name are held to the
  same rule, separately, because the failure is worse and the grep is different.
*/
const TEMPLATE_NAME = /\$\{\s*(\w*(?:[Nn]ame|[Uu]sername))\s*\}/g;
const templateOffenders = [];

for (const file of files) {
  const src = fs.readFileSync(file, 'utf8');
  for (const m of src.matchAll(TEMPLATE_NAME)) {
    const varName = m[1];
    /* Is that variable assigned from a raw lookup anywhere in this file? If it
       goes through nameOf() or carries its own fallback, it cannot be empty. */
    const decl = new RegExp(
      `(?:const|let|var)\\s+${varName}\\s*=\\s*([^;\\n]{0,300})`, 'g');
    for (const d of src.matchAll(decl)) {
      const rhs = d[1];
      if (/\bnameOf\s*\(/.test(rhs)) continue;              // guarded
      if (/(\|\||\?\?)/.test(rhs)) continue;                // has its own fallback
      if (!/\.find\s*\(/.test(rhs)) continue;               // not a lookup at all
      const line = src.slice(0, m.index).split('\n').length;
      templateOffenders.push(
        `${rel(file)}:${line}  \${${varName}} can print the word "undefined"`);
    }
  }
}

if (templateOffenders.length) {
  fail(`${templateOffenders.length} template literal(s) can print "undefined"`,
    [...new Set(templateOffenders)].join('\n          '));
} else {
  ok('no template literal can print the word "undefined" as a name');
}

/*
  And the guard on the guard: lib/playerName.js must actually be incapable of
  returning an empty string, or every call site above is trusting nothing.
*/
const libPath = path.join(FE, 'lib', 'playerName.js');
if (!fs.existsSync(libPath)) {
  fail('lib/playerName.js is missing', 'the fallback every game depends on');
} else {
  const { nameOf, DEPARTED } = await import(`file://${libPath.replace(/\\/g, '/')}`);
  const players = [{ id: 'p1', username: 'Ann' }, { id: 'p2', username: '' }];
  const cases = [
    ['a present player is named', nameOf(players, 'p1') === 'Ann'],
    ['a removed player is described', nameOf(players, 'p9') === DEPARTED],
    ['a null id is described', nameOf(players, null) === DEPARTED],
    ['an undefined id is described', nameOf(players, undefined) === DEPARTED],
    ['an empty players array is survived', nameOf([], 'p1') === DEPARTED],
    ['a missing players array is survived', nameOf(undefined, 'p1') === DEPARTED],
    /* A player really can hold an empty username — the join box has been
       guarded since, but old rooms and restored snapshots predate that. */
    ['a blank username is not passed through', nameOf(players, 'p2') === DEPARTED],
    ['a numeric id still matches a string id', nameOf([{ id: 1, username: 'Bo' }], '1') === 'Bo'],
    ['a custom fallback is honoured', nameOf(players, 'p9', 'the judge') === 'the judge'],
  ];
  for (const [label, pass] of cases) if (!pass) fail(label);
  const empties = cases.filter(([, p]) => p).length;
  if (empties === cases.length) ok(`nameOf never returns nothing (${cases.length} cases)`);
}

/*
  The premise, proved rather than asserted.

  Everything above is worth nothing if a round cannot actually end up naming
  somebody who is no longer in `players` — the sweep would be guarding against
  a state the server never produces. So the state is built here out of the real
  game modules, put through the real deriveClientState, and checked.

  This is exactly what the `kick_player` handler does (engine/index.js):

      state.players = state.players.filter(p => p.id !== playerId)

  It does NOT go back through the round and scrub the id out of it, and it
  could not sensibly do so — the round is over, the Chameleon *was* that
  person, and rewriting history to hide a departure would be a worse bug than
  the one this file is about. The right answer is for the screen to cope, which
  is what nameOf does.

  If a future change makes one of these games drop the id too, this reports it
  rather than passing quietly, so the entry can be retired deliberately.
*/
const games = [
  {
    label: 'Chameleon at the reveal',
    mod: '../src/games/chameleon/game.js', export: 'ChameleonGame',
    state: {
      status: 'playing', phase: 'result', hostId: 'p1',
      players: [
        { id: 'p1', username: 'Ann', connected: true, score: 0 },
        { id: 'p2', username: 'Bob', connected: false, score: 0 },
        { id: 'p3', username: 'Cat', connected: true, score: 0 },
      ],
      round: {
        phase: 'result', chameleonId: 'p2', secretIndex: 2,
        words: ['Anchor', 'Compass', 'Sextant', 'Rope'],
        clues: [], votes: [], result: { reason: 'escaped' },
      },
    },
    remove: 'p2',
    nameId: (cs) => cs.round?.chameleonId,
  },
  {
    label: 'Spectrum naming its clue giver',
    mod: '../src/games/wavelength/game.js', export: 'WavelengthGame',
    state: {
      status: 'playing', phase: 'result', hostId: 'p1',
      players: [
        { id: 'p1', username: 'Ann', connected: true, score: 0 },
        { id: 'p2', username: 'Bob', connected: false, score: 0 },
        { id: 'p3', username: 'Cat', connected: true, score: 0 },
      ],
      round: {
        phase: 'result', clueGiverId: 'p2', target: 60, clue: 'warm',
        guesses: [{ playerId: 'p3', value: 55 }],
        result: { scored: [{ playerId: 'p3', value: 55, points: 3 }] },
      },
    },
    remove: 'p2',
    nameId: (cs) => cs.round?.clueGiverId,
  },
  {
    label: 'Two Truths naming its subject',
    mod: '../src/games/twotruths/game.js', export: 'TwoTruthsGame',
    state: {
      status: 'playing', phase: 'reveal', hostId: 'p1',
      players: [
        { id: 'p1', username: 'Ann', connected: true, score: 0 },
        { id: 'p2', username: 'Bob', connected: false, score: 0 },
        { id: 'p3', username: 'Cat', connected: true, score: 0 },
      ],
      subjects: ['p2'], subjectIndex: 0, submissions: {},
      current: { subjectId: 'p2', statements: ['a', 'b', 'c'], lieIndex: 1, guesses: [] },
    },
    remove: 'p2',
    nameId: (cs) => cs.current?.subjectId,
  },
];

const { nameOf: liveNameOf } = fs.existsSync(libPath)
  ? await import(`file://${libPath.replace(/\\/g, '/')}`)
  : { nameOf: null };

for (const g of games) {
  let mod;
  try {
    mod = await import(new URL(g.mod, import.meta.url).href);
  } catch (e) {
    fail(`${g.label}: could not load ${g.mod}`, e.message.slice(0, 80));
    continue;
  }
  const def = mod[g.export] || Object.values(mod).find((v) => v && v.deriveClientState);
  if (!def?.deriveClientState) { fail(`${g.label}: no game with deriveClientState in ${g.mod}`); continue; }

  /* The host removes them, exactly the way the engine does. */
  const after = { ...g.state, players: g.state.players.filter((p) => p.id !== g.remove) };

  let cs;
  try {
    cs = def.deriveClientState(after, 'p1');
  } catch (e) {
    fail(`${g.label}: deriveClientState threw after a removal`, e.message.slice(0, 80));
    continue;
  }

  const id = g.nameId(cs);
  if (id !== g.remove) {
    /* If a game ever DOES scrub the id, the hazard is gone for that game and
       this entry should be retired — but say so, do not pass silently. */
    ok(`${g.label}: the id is scrubbed on removal, so no name can go missing`);
    continue;
  }
  const stillThere = (cs.players || after.players).find((p) => p.id === id);
  if (stillThere) { ok(`${g.label}: the player survives removal in client state`); continue; }

  /* The hazard is real: the round names an id the client cannot resolve. */
  const raw = (cs.players || after.players).find((p) => p.id === id)?.username;
  if (raw) { fail(`${g.label}: expected an unresolvable id, got "${raw}"`); continue; }

  const guarded = liveNameOf ? liveNameOf(cs.players || after.players, id) : null;
  if (guarded && String(guarded).trim()) {
    ok(`${g.label}: names a removed player "${guarded}" where the raw lookup gave nothing`);
  } else {
    fail(`${g.label}: nameOf gave nothing for a removed player`, JSON.stringify(guarded));
  }
}

console.log('');
if (failures) {
  console.log(`player names — ${failures} problem(s)\n`);
  process.exit(1);
}
console.log('player names — no game can put a hole where a person used to be\n');
