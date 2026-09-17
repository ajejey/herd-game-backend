/*
  "Play again" must actually start a new game.

    node scripts/resume-room-check.js

  THE INCIDENT. Every game's home page auto-navigates you into the room your
  browser remembers, which is correct — a phone that reloads a tab mid-game has
  to put you back in the game, not at a create form.

  It also meant "Play again" did nothing on all thirteen games. The link goes to
  the game's home page; the hook reconnects, rejoins the FINISHED room off the
  saved token, and the home page sends you straight back to the final-scores
  screen you were trying to leave. Rooms live two hours after the last activity,
  so it was every repeat game for two hours — for the visitor who had just
  enjoyed the game enough to want another.

  Neither half was wrong on its own, which is why nothing caught it. It was
  found by a Playwright probe that finished a real game and clicked the real
  link, and it is kept out by this file.

  THE INVARIANT, general so it also covers games that do not exist yet:
  no home page may navigate into a remembered room without asking
  lib/resumeRoom.js whether that room is worth resuming.
*/
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const COMPONENTS = path.join(HERE, '..', '..', 'frontend', 'src', 'components');
const LIB = path.join(HERE, '..', '..', 'frontend', 'src', 'lib', 'resumeRoom.js');

let failures = 0;
const fail = (m, d = '') => { console.log(`  FAIL  ${m}${d ? ' — ' + d : ''}`); failures += 1; };
const ok = (m) => console.log(`  ok    ${m}`);
const is = (m, cond, d = '') => (cond ? ok(m) : fail(m, d));

/* Every component file, one level down, that is a screen rather than a part. */
function homeFiles() {
  const out = [];
  for (const dir of fs.readdirSync(COMPONENTS, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const full = path.join(COMPONENTS, dir.name);
    for (const f of fs.readdirSync(full)) {
      if (f.endsWith('.js') && /^[A-Z]/.test(f)) out.push(path.join(full, f));
    }
  }
  return out;
}

/*
  backend/ and frontend/ are separate git repos and Railway deploys the backend
  alone, so `npm run check:all` has to survive there. Every other frontend-reading
  check in this directory guards its reads; these two did not, and an unhandled
  ENOENT aborted the whole suite rather than skipping one file.
*/
if (!fs.existsSync(COMPONENTS)) {
  console.log('  frontend/ is not in this checkout — skipping the resume sweep');
  console.log('');
  console.log('resume room — skipped (backend-only checkout)');
  process.exit(0);
}

is('the shared guard exists', fs.existsSync(LIB), 'frontend/src/lib/resumeRoom.js');
if (fs.existsSync(LIB)) {
  const lib = fs.readFileSync(LIB, 'utf8');
  is('...and it refuses a finished room',
    /status === 'finished'/.test(lib) && /phase === 'finished'/.test(lib),
    'both status and phase — the older games set one and not always the other');
}

/*
  Anything that navigates to `/<something>/room/<code>` off remembered state is
  a resume, whatever it is called and however the effect is written. Matching on
  the BEHAVIOUR rather than on one spelling of the condition is what makes this
  hold for a game written next year by someone who never read this file.
*/
const RESUME = /navigate\(\s*`\/[a-z0-9-]+\/room\/\$\{roomCode\}`/;

let checked = 0;
for (const file of homeFiles()) {
  const src = fs.readFileSync(file, 'utf8');
  if (!RESUME.test(src)) continue;
  /* A room screen navigating to its own room is not a resume — this only
     applies to a page that could otherwise offer a create form. */
  if (/Room\.js$/.test(file)) continue;

  const name = path.basename(file);
  checked += 1;
  const guarded = /canResumeRoom\(\s*state\s*\)/.test(src)
    && /from '\.\.\/\.\.\/lib\/resumeRoom'/.test(src);
  is(`${name} asks before resuming a room`, guarded,
    'use canResumeRoom(state) — a bare `if (state && roomCode)` sends people back into finished games');
}

/* If the sweep stops finding anything it has stopped being a sweep. */
is('every party game home was checked', checked >= 13, `${checked} found`);

/*
  ── The other half, and the worse one ──────────────────────────────────────

  A hook that rejoins its saved room on connect without looking at the URL puts
  a player who is already in room A back into room A when they open a link to
  room B — address bar says B, screen says A, no join form, no error. That is
  the site's whole distribution model (one person sends a link to five friends)
  breaking for anyone who had played once in the last two hours.

  Checked here rather than in each hook's own tests because the point is that
  ALL of them do it, including the next one somebody writes.
*/
const HOOKS = path.join(HERE, '..', '..', 'frontend', 'src', 'hooks');
const SESSION_LIB = path.join(HERE, '..', '..', 'frontend', 'src', 'lib', 'roomSession.js');

is('the shared rejoin guard exists', fs.existsSync(SESSION_LIB), 'frontend/src/lib/roomSession.js');
/*
  "...and a home page with no room in the URL still resumes" used to be asserted
  here by grepping for the literal line `if (!inUrl) return true;`. It is now
  asserted by CALLING shouldRejoinSession at the bottom of this file, which is
  the same claim without depending on how the function happens to be spelt.

  Worth saying why, because the regex version did its job on the way out: the
  ?pack= fix rewrote that line, the grep went red, and it made the change
  visible instead of silent. But a check that fails on a correct refactor is a
  check people learn to edit rather than read, and the next person would have
  matched the new spelling and moved on.
*/

let hooksChecked = 0;
for (const f of fs.readdirSync(HOOKS)) {
  if (!/^use.*\.js$/.test(f)) continue;
  const src = fs.readFileSync(path.join(HOOKS, f), 'utf8');
  if (!/rejoinToken/.test(src)) continue;          // not a room hook
  hooksChecked += 1;
  is(`${f} checks the URL before rejoining`,
    /shouldRejoinSession\(/.test(src) && /from '\.\.\/lib\/roomSession'/.test(src),
    'a bare `if (session?.rejoinToken)` drags people back into the room they just left');
}
is('every room hook was checked', hooksChecked >= 13, `${hooksChecked} found`);

/* ── A link that asks for something beats a remembered room ───────────────── */

/*
  16 Sep 2026, team-trivia DSHE: "I am trying to open this pack:
  QOUNT-TRICK-OR-TRIVIA-AZS. But every time I do, it continues to start me in
  some random trivia I started before."

  They were describing shouldRejoinSession. /team-trivia?pack=... has no room
  code in the PATH, so the rule called it a front door and resumed their old
  room; the pack they had been sent was never opened. ?join= had the same hole
  — somebody sends you a room, and you land in a different one.

  This is the SAME defect the room-in-the-path check was written for. It simply
  never looked past the path, so an instruction carried in the query string
  walked straight through it.

  Run rather than grepped. The regex version of this assertion would pass on
  the comment that explains it — which is how a source-level check quietly
  stops checking anything.
*/
const { shouldRejoinSession } = await import(
  pathToFileURL(path.join(HERE, '..', '..', 'frontend', 'src', 'lib', 'roomSession.js')).href
);

const SESSION = { rejoinToken: 't', roomCode: 'OLDR' };

is('an ordinary front door still resumes the remembered room',
  shouldRejoinSession(SESSION, '/team-trivia', '') === true,
  'a phone that reloads a backgrounded tab has to land back in the game');

is('a ?pack= link is opened, not overridden by the last room',
  shouldRejoinSession(SESSION, '/team-trivia', '?pack=QOUNT-TRICK-OR-TRIVIA-AZS') === false,
  'this is the QOUNT report: the pack never opens because the old room wins');

is('a ?join= link for a DIFFERENT room does not resume the old one',
  shouldRejoinSession(SESSION, '/team-trivia', '?join=ABCD') === false,
  'somebody sent them a room and they would land in a different one');

/*
  AND THE OTHER HALF, which the first version of this fix got wrong and which
  this check briefly asserted as correct.

  Treating any ?join= as "do not rejoin" locks a player out of their OWN game.
  Reopening the invite link still sitting in the group chat — /taboo?join=ABCD
  while in room ABCD — would suppress the rejoin, hand them the join form, and
  the engine answers GAME_IN_PROGRESS because join_game refuses a room that has
  left the lobby. Permanently out, by clicking the link to the game they are in.

  A join code names a room, so it gets compared, exactly as a room in the path
  is compared. That is what makes this assertion the pair of the one above
  rather than its opposite.
*/
is('a ?join= link for the room they are ALREADY in still resumes',
  shouldRejoinSession(SESSION, '/team-trivia', '?join=OLDR') === true,
  'reopening the invite link to your own game must not lock you out of it');

is('...and the comparison is case-insensitive',
  shouldRejoinSession(SESSION, '/team-trivia', '?join=oldr') === true,
  'links get lower-cased by chat apps and by people typing them');

is('a room in the path still wins over both',
  shouldRejoinSession(SESSION, '/team-trivia/room/OLDR', '') === true
  && shouldRejoinSession(SESSION, '/team-trivia/room/NEWR', '') === false,
  'the original fix must survive the new one');

console.log('');
if (failures) { console.log(`resume room — ${failures} problem(s)`); process.exit(1); }
console.log('resume room — "Play again" starts a new game, and a link beats a remembered room');
