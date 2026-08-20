/**
 * Guards the create/join funnel instrumentation across every game.
 *
 *   node scripts/funnel-check.js
 *
 * PostHog said one in three join attempts failed, every failure reporting the
 * same "Game not found". That number came from ONE game, because only Home.js
 * was instrumented — the eleven engine games, which carry most of the
 * multiplayer traffic, sent nothing at all. A funnel measured on a twelfth of
 * the site reads exactly like a funnel measured on all of it.
 *
 * Two failure shapes this exists to prevent, both silent:
 *
 *   A new game ships uninstrumented. Nothing breaks; the funnel just quietly
 *   stops describing the site, and no error is ever raised.
 *
 *   An outcome is recorded that no person caused. The game hooks re-emit
 *   `join_game` on every reconnect to restore a session, so instrumentation
 *   placed at the socket would turn every dropped wifi connection into a join
 *   attempt. The funnel would become a connectivity chart while still looking
 *   like a funnel.
 *
 * Needs no database and no browser.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const COMPONENTS = path.join(here, '..', '..', 'frontend', 'src', 'components');
const HOOK = path.join(here, '..', '..', 'frontend', 'src', 'hooks', 'useJoinFunnel.js');
const LIB = path.join(here, '..', '..', 'frontend', 'src', 'lib', 'packCode.js');

const problems = [];
const ok = [];
const check = (label, pass, detail = '') =>
  pass ? ok.push(label) : problems.push(`${label}${detail ? ' — ' + detail : ''}`);

if (!fs.existsSync(COMPONENTS)) {
  console.log('  (frontend not present, skipping)');
  process.exit(0);
}

/* Every home screen that can start or join a multiplayer room. */
const homes = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full);
    else if (e.isFile() && /Home\.js$/.test(e.name)) homes.push(full);
  }
})(COMPONENTS);

const multiplayer = homes.filter((f) => {
  const src = fs.readFileSync(f, 'utf8');
  return /joinGame\(|handleJoinGame/.test(src);
});

check('every multiplayer home was found', multiplayer.length >= 12, `${multiplayer.length} found`);

const gameIds = new Map();

for (const file of multiplayer) {
  const name = path.basename(file);
  const src = fs.readFileSync(file, 'utf8');
  const legacy = name === 'Home.js';

  /* Home.js predates the hook and emits directly; the rest must use the hook,
     so the reconnect guard lives in exactly one place rather than twelve. */
  if (legacy) {
    check(`${name} records a join attempt`, /track\('room_join_attempt'/.test(src));
    check(`${name} records a join outcome`,
      /track\('room_joined'/.test(src) && /track\('room_join_failed'/.test(src));
    check(`${name} records a create attempt`, /track\('room_create_attempt'/.test(src));
  } else {
    check(`${name} uses the shared funnel hook`, /useJoinFunnel\(/.test(src));
    check(`${name} records a create attempt`, /funnel\.attemptCreate\(/.test(src));
    check(`${name} records a join attempt`, /funnel\.attemptJoin\(/.test(src));
    check(`${name} does not emit room events behind the hook's back`,
      !/track\('room_/.test(src),
      'a direct track() here bypasses the reconnect guard');
    check(`${name} records the create attempt beside createGame`,
      /attemptCreate\([^)]*\);\s*createGame\(/.test(src));
    check(`${name} records the join attempt beside joinGame`,
      /attemptJoin\(code\);\s*joinGame\(/.test(src));
  }

  /* Every event must say which game it came from, or the whole point — seeing
     the eleven games we were blind to — is lost the moment they are combined. */
  const ids = [...src.matchAll(/game: '([a-z-]+)'/g)].map((m) => m[1]);
  check(`${name} stamps a game id on its events`, ids.length > 0);
  for (const id of ids) {
    if (gameIds.has(id) && gameIds.get(id) !== name) {
      problems.push(`game id "${id}" is claimed by both ${gameIds.get(id)} and ${name}`);
    }
    gameIds.set(id, name);
  }
}

check('every game reports under its own id', gameIds.size >= 12, `${gameIds.size} distinct ids`);

/* ── The hook itself ─────────────────────────────────────────────────────────
   The reconnect guard is the whole reason this is a shared hook. If an outcome
   can settle without a pending attempt, a session restore becomes a join. */
const hook = fs.readFileSync(HOOK, 'utf8');

check('a success is ignored unless a person opened an attempt',
  /if \(!roomCode \|\| !pending\.current\) return;/.test(hook),
  'without this, every reconnect counts as a join');
check('a failure is ignored unless a person opened an attempt',
  /if \(!error \|\| !pending\.current\) return;/.test(hook));
check('an attempt is opened in exactly one place',
  (hook.match(/pending\.current = \{/g) || []).length === 1,
  'more than one place to open an attempt is more than one place to get it wrong');
check('an attempt is only opened by an explicit user action',
  /const attemptCreate/.test(hook) && /const attemptJoin/.test(hook));
check('an unanswered attempt is still recorded',
  /GIVE_UP_MS/.test(hook) && /'no response'/.test(hook),
  'a request the server never answers must not look like a success');
check('the attempt is cleared before the event fires',
  /pending\.current = null;[\s\S]{0,200}track\(/.test(hook),
  'otherwise one attempt can report two outcomes');

/* The person's own code must never leave the browser. */
check('the code itself is never sent, only its shape',
  /codeShape\(/.test(hook) && !/track\([^)]*\bcode\b\s*[,}]/.test(hook));

/* ── codeShape, the thing that splits "Game not found" into causes ───────── */
const lib = fs.readFileSync(LIB, 'utf8');
const codeShape = new Function(`${lib.replace(/^export /gm, '')}
  return codeShape;`)();

const SHAPES = [
  ['ABCD', 4, 'room-code'],
  ['AB', 4, 'too-short'],
  ['QXUME5', 4, 'too-long'],
  ['CISS-DIVISION-LETTER-S-K7X', 4, 'pack-id'],
  ['', 4, 'empty'],
  ['   ', 4, 'empty'],
  ['QXUME5', 6, 'room-code'],
  ['ABCD', 6, 'too-short'],
];
for (const [input, len, expected] of SHAPES) {
  const got = codeShape(input, len);
  check(`"${input}" in a ${len}-letter box is ${expected}`, got === expected, got);
}

console.log(`join funnel — ${ok.length} checks\n`);
if (problems.length) {
  console.error(`${problems.length} problem(s):\n`);
  problems.forEach((p, i) => console.error(`  ${i + 1}. ${p}`));
  process.exit(1);
}
console.log('  all 12 multiplayer games report create and join');
console.log('  each reports under its own game id');
console.log('  an outcome is only recorded when a person opened an attempt');
console.log('  an unanswered attempt is recorded rather than lost');
console.log('  the code typed is never sent, only its shape');
