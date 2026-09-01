/*
  A group that just finished can start another game without re-forming.

    node scripts/play-again-check.js

  ── The report ───────────────────────────────────────────────────────────────
  28 Aug 2026, from a finished Scattergories room: "Cannot force start a new
  game." They were right, and it was true of all fourteen games.

  Every finished screen offered "Play again" or "New game", and in every single
  one it was a LINK — or a button wired to onLeave — that called leaveGame()
  and dropped the presser on the hub to create a fresh room with a fresh code.
  Everyone else stayed on the final scoreboard, in a room whose host had just
  walked out. To play a second game a group had to re-form and redistribute a
  code, at the exact moment they were most willing to keep playing.

  The label was the worst part. A control that says "Play again" and instead
  ends the session for everyone is not a missing feature, it is a lie on a
  button, and it is invisible in review because the word is right there.

  ── What is checked ──────────────────────────────────────────────────────────
    1. no control says "play again" / "new game" while its handler leaves
    2. every multiplayer room reaches the shared PlayAgain control, or emits
       play_again itself (the legacy game, which has its own idioms)
    3. every engine hook exposes playAgain and emits 'play_again'
    4. the server enforces what the client assumes: finished-only, host-or-
       host-gone, and settings preserved across the rematch
    5. the legacy game deletes its old rounds before resetting — without that,
       the unique (gameId, roundNumber) index turns "play again" into the
       room-bricking bug that start_game is already guarded against

  Solo games are exempt: they restart in place already, and they have no room
  to keep anybody in.

  No database, no browser, no server.
*/
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const FE = path.join(here, '..', '..', 'frontend', 'src');
const BE = path.join(here, '..', 'src');

let failures = 0;
const fail = (m, d = '') => { console.log(`  FAIL  ${m}${d ? '\n          ' + d : ''}`); failures += 1; };
const ok = (m) => console.log(`  ok    ${m}`);

console.log('');
console.log('=== a finished room can play again ===');

if (!fs.existsSync(FE)) {
  console.log('  (frontend not present, skipping)\n');
  process.exit(0);
}

const read = (p) => fs.readFileSync(p, 'utf8');
const rel = (f) => path.relative(FE, f).replace(/\\/g, '/');

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (/\.(js|jsx|tsx)$/.test(e.name)) out.push(full);
  }
  return out;
}

/*
  The multiplayer rooms. Solo games live elsewhere and are not room-based, so
  they are named here rather than guessed at — a new SOLO game must not make
  this check fail, and a new MULTIPLAYER one must.
*/
const ROOM_FILES = walk(path.join(FE, 'components'))
  .filter((f) => /Room\.js$|\/(gt|sa|clover)\/Scoreboard\.js$/.test(f.replace(/\\/g, '/')))
  .filter((f) => !/PlayAgain/.test(path.basename(f)));

/* ── 1. no control lies about what it does ──────────────────────────────── */
const liars = [];
for (const f of walk(path.join(FE, 'components'))) {
  const src = read(f);
  if (/components[\\/]common[\\/]PlayAgain\.js$/.test(f)) continue;
  /* A Link or button labelled play-again whose handler is a leave. */
  const re = /<(Link|button)\b[^>]*?on(?:Click)=\{(?:\(\)\s*=>\s*)?\{?\s*(?:leaveGame|onLeave|handleLeaveGame)[\s\S]{0,200}?>(?:[\s\S]{0,60}?)(Play again|New game)/gi;
  for (const m of src.matchAll(re)) {
    const line = src.slice(0, m.index).split('\n').length;
    liars.push(`${rel(f)}:${line}  "${m[2]}" is wired to a handler that leaves the room`);
  }
}
if (liars.length) fail(`${liars.length} control(s) say play-again and leave instead`, liars.join('\n          '));
else ok(`no control says "play again" while leaving the room (${ROOM_FILES.length} rooms swept)`);

/*
  ── 1b. one control, one destination ────────────────────────────────────────

  A <Link to={X}> whose onClick handler ALSO navigates has two destinations and
  silently keeps the wrong one: React Router runs the handler first, then does
  its own navigation, so the handler's navigate() is dead.

  Shipped exactly that way. Clover, Guesstimate and Say Anything passed
  `onLeave={() => { leaveGame(); navigate('/clover') }}` into a Link with
  `backTo="/"`, so "Leave room" quietly started landing on the site hub instead
  of the game's own page — a silent change in behaviour with nothing broken
  enough to notice. Caught by /code-review, not by this file, which is why it
  is now in this file.
*/
/*
  The first version of this rule DID NOT CATCH ITS OWN BUG, which is worse than
  not having it — a green line reads as coverage.

  It looked for a navigating handler with `backTo=` nearby, within a few hundred
  characters. For Clover the nearest `backTo=` was 2,447 characters away in a
  different function, and for Guesstimate and Say Anything it is in a different
  FILE entirely: the handler lives in the Room, `backTo` lives in the
  Scoreboard. Proximity cannot see across a file boundary, so the check could
  never have worked for two of the three cases it was written for. Confirmed by
  restoring the shipped code and watching it still print ok.

  So the rule is stated without geography instead: a handler passed as
  onLeave / onPlayAgain / onDone MUST NOT navigate. Those props are handed to
  components that render their own <Link>, and the Link owns the destination.
  Leaving handlers leave; navigation is the Link's job. That holds wherever the
  two halves happen to live.
*/
/*
  A JSX prop's value cannot be read with a regex, because `{}` nests:
  `onLeave={() => { leaveGame(); navigate('/x'); }}` has an inner brace pair,
  and a non-greedy match stops at the wrong one. The second attempt at this
  rule did exactly that and still missed the bug. Balance the braces instead.
*/
function propValue(src, openBraceIndex) {
  let depth = 0;
  for (let i = openBraceIndex; i < src.length; i += 1) {
    const c = src[i];
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(openBraceIndex + 1, i);
    }
  }
  return '';
}

const doubleDest = [];
for (const f of walk(path.join(FE, 'components'))) {
  const src = read(f);

  /* A handler passed as onLeave / onPlayAgain / onDone must not navigate: the
     component it goes to renders its own <Link>, and the Link owns the
     destination. No proximity test, so a cross-file split cannot hide it. */
  for (const m of src.matchAll(/\bon(?:Leave|PlayAgain|Done)=\{/g)) {
    const open = m.index + m[0].length - 1;
    if (/\bnavigate\s*\(/.test(propValue(src, open))) {
      const line = src.slice(0, m.index).split('\n').length;
      doubleDest.push(
        `${rel(f)}:${line}  ${m[0].slice(0, -1)} navigates — the Link it is given to owns the destination`);
    }
  }

  /* And the single-element version: a <Link to=…> whose own onClick navigates. */
  for (const m of src.matchAll(/<Link\b[^>]{0,400}?\sonClick=\{/g)) {
    const open = m.index + m[0].length - 1;
    const head = src.slice(m.index, open);
    if (/\sto=/.test(head) && /\bnavigate\s*\(/.test(propValue(src, open))) {
      const line = src.slice(0, m.index).split('\n').length;
      doubleDest.push(`${rel(f)}:${line}  a <Link to=…> whose onClick also navigates`);
    }
  }
}
if (doubleDest.length) {
  fail(`${doubleDest.length} control(s) have two destinations`,
    [...new Set(doubleDest)].join('\n          ')
      + '\n\n          Give the path to the Link, and let the handler just leave.');
} else {
  ok('no control has two destinations fighting each other');
}

/* ── 2. every room offers a real rematch ────────────────────────────────── */
const noRematch = [];
for (const f of ROOM_FILES) {
  const src = read(f);
  const viaComponent = /<PlayAgain\b/.test(src) || /onPlayAgain=/.test(src);
  const viaEmit = /'play_again'/.test(src);
  if (!viaComponent && !viaEmit) noRematch.push(rel(f));
}
if (noRematch.length) {
  fail(`${noRematch.length} room(s) have no way to start another game`,
    noRematch.join('\n          ') + '\n\n          Use <PlayAgain> from components/common/PlayAgain.js.');
} else {
  ok(`every multiplayer room can start another game in place (${ROOM_FILES.length})`);
}

/* ── 3. every engine hook can ask for one ───────────────────────────────── */
const hooks = walk(path.join(FE, 'hooks')).filter((f) => /use[A-Z]/.test(path.basename(f)));
const roomHooks = hooks.filter((f) => /'start_game'/.test(read(f)));
const hookGaps = roomHooks.filter((f) => {
  const s = read(f);
  return !(/'play_again'/.test(s) && /\bplayAgain\b/.test(s));
});
if (hookGaps.length) {
  fail(`${hookGaps.length} hook(s) cannot request a rematch`,
    hookGaps.map((f) => path.basename(f)).join(', '));
} else {
  ok(`every room hook exposes playAgain (${roomHooks.length})`);
}

/* ── 4. the server enforces what the client assumes ─────────────────────── */
const engine = read(path.join(BE, 'engine', 'index.js'));
const engineRules = [
  ["the engine has a play_again handler", /socket\.on\('play_again'/],
  ["...refused unless the game is finished", /play_again[\s\S]{0,1400}?status !== 'finished'/],
  ["...refused for a non-host while the host is here", /play_again[\s\S]{0,2200}?hostId[\s\S]{0,200}?UNAUTHORIZED/],
  ["...and the rematch keeps the room's settings", /play_again[\s\S]{0,3000}?createInitialState\(store\.settingsFor/],
];
for (const [label, re] of engineRules) (re.test(engine) ? ok : (d) => fail(d))(label);

/*
  Settings must NOT be on the game state. Every game's deriveClientState
  spreads ...state, so a settings object living there is broadcast to every
  player — and it can carry the resolved custom pack, which is the answers.
*/
const store = read(path.join(BE, 'engine', 'store.js'));
if (!/settingsFor|setSettings/.test(store)) {
  fail('the engine store does not keep room settings', 'a rematch would silently use defaults');
} else if (/state\.settings\s*=|settings:\s*settings/.test(engine)) {
  fail('settings are being written onto the game state',
    'every deriveClientState spreads ...state, so this would deal players the custom pack');
} else {
  ok('settings are kept engine-private, so a rematch cannot leak the pack');
}

/* ── 5. the legacy game must not brick itself ───────────────────────────── */
const legacy = read(path.join(BE, 'index.js'));
if (!/socket\.on\('play_again'/.test(legacy)) {
  fail('the legacy Herd game has no play_again handler');
} else {
  const body = legacy.slice(legacy.indexOf("socket.on('play_again'"));
  const chunk = body.slice(0, 2600);
  const rules = [
    ['legacy: only from a completed game', /status !== 'completed'/],
    ['legacy: host, or anyone once the host has gone', /mayActAsHost/],
    /*
      The one that matters. roundSchema.index({gameId, roundNumber}, {unique:true})
      means a room reset to `waiting` still holding round 1 will throw on the
      next start_game — after the game doc has already been rewound. That is
      the documented bricking bug, reached from a new direction.
    */
    ['legacy: old rounds are deleted before the reset', /Round\.deleteMany/],
    ['legacy: ...and their answers with them', /Answer\.deleteMany/],
    ['legacy: scores go back to zero', /score:\s*0/],
    ['legacy: the pink cow is put back on the table', /pinkCowHolder\s*=\s*null/],
  ];
  for (const [label, re] of rules) (re.test(chunk) ? ok : (d) => fail(d))(label);

  /* Order matters: deleting AFTER the save leaves a window where the room is
     `waiting` with round 1 still present — bricked if anyone presses Start. */
  const delAt = chunk.search(/Round\.deleteMany/);
  const saveAt = chunk.search(/game\.save\(\)/);
  if (delAt >= 0 && saveAt >= 0 && delAt > saveAt) {
    fail('legacy: rounds are deleted AFTER the game is saved',
      'a Start pressed in that window hits the unique index and bricks the room');
  } else {
    ok('legacy: the rounds are gone before the room reopens');
  }
}

/* ── 6. the client must actually handle the reset ───────────────────────── */
const ctx = path.join(FE, 'context', 'GameContext.js');
const room = path.join(FE, 'components', 'GameRoom.js');
if (fs.existsSync(ctx) && fs.existsSync(room)) {
  const c = read(ctx), r = read(room);

  /*
    ONE case block, not "the next 700 characters".

    The first draft of this check took a fixed window after `case
    'GAME_REPLAYED'` and searched it for `return initialState`. It found some —
    belonging to `case 'RESET_GAME'`, which sits a few lines below — and
    reported a bug that was not there. A reducer is a list of cases; reading
    past the end of one is reading somebody else's code.
  */
  const caseBody = (src, name) => {
    const start = src.indexOf(`case '${name}'`);
    if (start === -1) return null;
    const after = src.slice(start + name.length + 7);
    const next = after.search(/\n\s*case '|\n\s*default\s*:/);
    return next === -1 ? after : after.slice(0, next);
  };

  const body = caseBody(c, 'GAME_REPLAYED');
  if (!body) fail('the legacy reducer ignores a replayed game');
  else if (!/socket\.on\('game_replayed'/.test(r)) fail('the legacy room never listens for game_replayed');
  else if (/return initialState/.test(body)) {
    fail('GAME_REPLAYED returns initialState', 'that drops roomCode and playerId and ejects the room it exists to keep');
  } else {
    /* A stale winner keeps the game-over screen up over the new lobby; a stale
       hasAnswered locks the player out of round one of the game they just
       asked for. */
    const cleared = ['winner', 'roundResults', 'hasAnswered'].filter((k) => !new RegExp(`\\b${k}:`).test(body));
    if (cleared.length) fail(`GAME_REPLAYED leaves last game's ${cleared.join(', ')} behind`);
    else ok('the legacy room clears the last game before reopening');
  }
}

console.log('');
if (failures) { console.log(`play again — ${failures} problem(s)\n`); process.exit(1); }
console.log('play again — a group that finished can keep playing, in the room they are in\n');
