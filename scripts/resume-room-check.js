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
import { fileURLToPath } from 'url';

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
if (fs.existsSync(SESSION_LIB)) {
  const lib = fs.readFileSync(SESSION_LIB, 'utf8');
  is('...and a home page with no room in the URL still resumes',
    /if \(!inUrl\) return true;/.test(lib),
    'otherwise a backgrounded tab loses its game, which is what auto-rejoin is FOR');
}

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

console.log('');
if (failures) { console.log(`resume room — ${failures} problem(s)`); process.exit(1); }
console.log('resume room — "Play again" starts a new game on every one of them');
