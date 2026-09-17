/*
  Every room has a way out, in every phase, and leaving actually leaves.

    node scripts/room-exit-check.js

  ── The reports ──────────────────────────────────────────────────────────────

    17 Sep 2026, guesstimate DGCK: "unable to exit the game once started"
    13 Sep 2026, guesstimate RZVE: "Quiero borrar esta partida y no me deja"
                                   — I want to delete this game and it won't
                                   let me

  Two people, four days apart, in the same game, describing the same thing. In
  this niche almost nobody reports anything, so two reports of one defect is a
  lot of people meeting it silently.

  They were right, and it was worse than they knew. `leaveGame` in Guesstimate
  was wired into exactly one place: the end-of-game scoreboard — which you get
  to by finishing the game you are trying to get out of. Across the site:

    no exit during play          11 of 13 room screens
    no exit in the lobby either   3 of 13 (guesstimate, say-anything, clover)

  ── And the exits that existed were broken too ───────────────────────────────

  Every hook's `leaveGame` clears the saved session and reconnects the socket.
  It does not navigate. The URL is still /<game>/room/<CODE>, so the room screen
  re-renders with no state and a room code in the address bar — which is the
  "join this room" branch. Pressing "Leave room" put you on a form inviting you
  to join the room you had just left. Ten lobbies did that.

  So an exit has to do BOTH: clear the session (or the next connect silently
  rejoins — see frontend/src/lib/roomSession.js) and move the browser. That is
  what components/common/LeaveRoom.js is, and why this check insists on it
  rather than on the word "leave" appearing somewhere.

  ── What is checked ──────────────────────────────────────────────────────────
    1. every multiplayer room screen offers a way out that both clears the
       session and navigates
    2. ...in at least two places, because the lobby and the game in progress
       are two different screens and having one is not having the other
    3. no room screen still has a bare leave button that clears without
       navigating
    4. the shared LeaveRoom control itself does both halves

  Exits are matched by SHAPE, not by one component's name — see exitsIn() for
  why, and for the room screen this file originally failed to look at. A game
  added next month is covered by 1-3 without anybody editing this file, which is
  the point. Solo games are exempt: there is no room and no group to leave.

  No database, no browser, no server.
*/
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const FE = path.join(here, '..', '..', 'frontend', 'src');

let failures = 0;
const fail = (m, d = '') => { console.log(`  FAIL  ${m}${d ? '\n          ' + d : ''}`); failures += 1; };
const ok = (m) => console.log(`  ok    ${m}`);

console.log('');
console.log('=== every room has a way out ===');

if (!fs.existsSync(FE)) {
  console.log('  (frontend not present, skipping)\n');
  process.exit(0);
}

const read = (p) => fs.readFileSync(p, 'utf8');
const rel = (f) => path.relative(FE, f).replace(/\\/g, '/');

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile() && entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

const all = walk(path.join(FE, 'components'));

/*
  A ROOM SCREEN, found rather than listed.

  Matching on the filename alone would miss a room screen named something else;
  matching on `leaveGame` alone would catch helper components that merely take
  it as a prop. A screen that pulls `leaveGame` out of its own game hook IS the
  screen that owns the room.
*/
const roomScreens = all.filter((f) => {
  const src = read(f);
  /* Not `components/common` — those are the shared controls a room is built
     from, not rooms. */
  if (/\/components\/common\//.test(f.replace(/\\/g, '/'))) return false;
  const hasLeave = /\bleaveGame\b/.test(src) || /\bhandleLeaveGame\b/.test(src);
  const hasRoom = /\broomCode\b/.test(src) || /\bgameId\b/.test(src);
  return hasLeave && hasRoom;
});

/**
 * Exits on a screen that both clear the session and move the browser.
 *
 * Two shapes count, because the site has two:
 *
 *   <LeaveRoom …/>            the shared control the thirteen engine games use.
 *   onClick={someLeaveFn}     where that function is defined in this file and
 *                             its body calls navigate(). GameRoom.js — the
 *                             original Herd Mentality game, and the most played
 *                             thing on the site — predates the engine and does
 *                             it this way, correctly: handleLeaveGame clears
 *                             the session, tells the SERVER (which none of the
 *                             other thirteen do), resets and navigates.
 *
 * The first version of this counted `<LeaveRoom` only and detected rooms by
 * the exact identifier `leaveGame`, so GameRoom.js was invisible to it — the
 * file header claimed a sweep that already did not cover the game that exists
 * now, never mind one added next month. Matching the SHAPE is the difference.
 */
function exitsIn(src) {
  let count = (src.match(/<LeaveRoom\b/g) || []).length;

  const handlers = new Set();
  const re = /(?:const|function)\s+(\w*[Ll]eave\w*)\s*(?:=\s*(?:async\s*)?\([^)]*\)\s*=>\s*\{|\([^)]*\)\s*\{)/g;
  let m = re.exec(src);
  while (m) {
    const name = m[1];
    /* The handler body, to its matching close. Cheap and good enough: we only
       need to know whether it navigates. */
    const body = src.slice(m.index, m.index + 600);
    if (/navigate\(|window\.location\s*=/.test(body)) handlers.add(name);
    m = re.exec(src);
  }
  for (const name of handlers) {
    count += (src.match(new RegExp(`onClick=\\{\\s*${name}\\s*\\}`, 'g')) || []).length;
  }
  return count;
}

if (!roomScreens.length) {
  fail('no room screens found at all', 'the detector above has drifted from the code');
} else {
  ok(`${roomScreens.length} multiplayer room screens found`);
}

/* ── 1 and 2: the control is there, in both places ───────────────────────── */

const missing = [];
const onlyOnce = [];
for (const f of roomScreens) {
  const uses = exitsIn(read(f));
  if (uses === 0) missing.push(rel(f));
  else if (uses < 2) onlyOnce.push(rel(f));
}

if (missing.length) {
  fail(`${missing.length} room screen(s) have no way out at all`, missing.join(', '));
} else {
  ok('every room screen offers a way out');
}

if (onlyOnce.length) {
  fail(
    `${onlyOnce.length} room screen(s) have an exit on only one screen`,
    `${onlyOnce.join(', ')} — the lobby and the game in progress are two different `
    + 'screens, and "unable to exit the game once started" is what having only one looks like',
  );
} else {
  ok('...in the lobby AND in the game in progress');
}

/* ── 3: nothing left that clears without navigating ──────────────────────── */

const bare = [];
for (const f of roomScreens) {
  const src = read(f);
  /*
    A <button onClick={leaveGame}> with no navigation. This is the shape that
    put people on a join form for the room they had just left. A Link that
    calls it on the way out is correct and is what LeaveRoom and PlayAgain do.
  */
  if (/<button[^>]*onClick=\{\s*leaveGame\s*\}/.test(src)) bare.push(rel(f));
}

if (bare.length) {
  fail(
    `${bare.length} room screen(s) clear the session without navigating`,
    `${bare.join(', ')} — leaveGame does not move the browser, so the room URL `
    + 're-renders as the join form for the room they just left',
  );
} else {
  ok('leaving navigates, so nobody lands back on a join form');
}

/* ── 4: the shared control does both halves ──────────────────────────────── */

const leaveRoomPath = path.join(FE, 'components', 'common', 'LeaveRoom.js');
if (!fs.existsSync(leaveRoomPath)) {
  fail('components/common/LeaveRoom.js is missing', 'every room screen above imports it');
} else {
  const src = read(leaveRoomPath);
  const navigates = /<Link\b/.test(src) && /\bto=\{backTo\}/.test(src);
  const clears = /onClick=\{onLeave\}/.test(src);
  if (!navigates) fail('the shared exit does not navigate', 'clearing the session alone is not leaving');
  else if (!clears) {
    fail(
      'the shared exit does not clear the session',
      'without that the next socket connect rejoins the room — see lib/roomSession.js',
    );
  } else ok('the shared exit clears the session and moves the browser');
}

console.log('');
if (failures) { console.log(`room exits — ${failures} problem(s)\n`); process.exit(1); }
console.log('room exits — every room can be left, from every screen, and leaving leaves\n');
