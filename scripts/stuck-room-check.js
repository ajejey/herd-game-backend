/*
  Nobody may strand a room by leaving it.

    node scripts/stuck-room-check.js

  THE INCIDENT. Room S1DQVW, 21 Aug 2026. Three players filed three reports in
  twenty-six seconds — "Someone d / Isn't answer", "Host is bad", "No work" —
  all looking at the words "Waiting for other players…" with no name, no clock
  and no button. Half of every report the site received that week came from that
  one screen.

  It was not a typo. The "has everyone answered?" test lived inside submit_answer
  and only inside submit_answer, so the ONLY event that could ever end a round
  was another answer arriving. When the person everybody was waiting for closed
  their tab, that event was never coming: disconnect set isConnected:false and
  asked nothing else, and remove_player — the one button the host had — did
  exactly the same.

  THE INVARIANT, written generally so it also covers games that do not exist yet:

    1. Any handler that marks a player gone must, in the same handler, re-ask
       whether the thing being waited on can now proceed.
    2. Every wait must have a way out that does not depend on the person being
       waited for.
    3. No waiting screen may describe the wait without naming who it is for.

  §1 and §2 are swept over the legacy Herd server here; the engine games get the
  same guarantee structurally, because engine/index.js routes onPlayerDisconnect
  into each game's own advance check. §3 is swept over every screen in the app —
  the anonymous "waiting for other players" is the defect itself, and it is the
  kind of string that gets copied into the next game.
*/
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, '..', 'src', 'index.js');
const COMPONENTS = path.join(HERE, '..', '..', 'frontend', 'src', 'components');

let failures = 0;
const fail = (m, d = '') => { console.log(`  FAIL  ${m}${d ? ' — ' + d : ''}`); failures += 1; };
const ok = (m) => console.log(`  ok    ${m}`);
const is = (m, cond, d = '') => (cond ? ok(m) : fail(m, d));

const src = fs.readFileSync(SERVER, 'utf8');

/*
  Pull one `socket.on('name', ...)` handler out by brace-matching its BODY.

  Brace-match from the arrow, not from the first `{` after the name: most of
  these handlers destructure their payload — `async ({ gameId, answer }) => {` —
  and matching the first brace closes on the destructuring pattern instead, so
  the "body" is four words long and every assertion about it passes vacuously.
  Which is exactly what this file existing is supposed to prevent.
*/
function handler(name) {
  const start = src.indexOf(`socket.on('${name}'`);
  if (start === -1) return null;
  const arrow = src.indexOf('=>', start);
  if (arrow === -1) return null;
  const open = src.indexOf('{', arrow);
  if (open === -1) return null;
  let depth = 0;
  for (let j = open; j < src.length; j += 1) {
    if (src[j] === '{') depth += 1;
    else if (src[j] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, j + 1);
    }
  }
  return null;
}

/* The strings a screen actually renders, with the comments explaining the
   history stripped out — this file's own subject matter is quoted all over
   them. */
const rendered = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

console.log('');
console.log('§1  every event that changes who we are waiting for re-asks the question');
console.log('');

/*
  Matched on BEHAVIOUR, not on a handler name. Anything that writes
  isConnected:false is removing somebody from the wait, whatever it is called —
  which is what makes this hold for the handler somebody adds next year.
*/
const RETIRES_A_PLAYER = /isConnected\s*[:=]\s*false/;
const RE_ASKS = /maybeCompleteRound\s*\(/;

let swept = 0;
for (const name of ['disconnect', 'remove_player', 'leave_game']) {
  const body = handler(name);
  if (!body) continue;
  if (!RETIRES_A_PLAYER.test(body)) continue;
  swept += 1;
  is(`${name} re-asks whether the round can now finish`, RE_ASKS.test(body),
    'a player leaving must be able to END a wait, or one closed tab freezes the room forever');
}
is('both known ways out of a room were swept', swept >= 2, `${swept} found`);

// The check that used to live inside submit_answer, and only there.
is('the completion check is a shared function, not inlined in one handler',
  /async function maybeCompleteRound\s*\(/.test(src),
  'inlining it in submit_answer is the original bug — the only event that could end a round was another answer');

const submit = handler('submit_answer') || '';
is('...and submit_answer calls it rather than carrying its own copy',
  RE_ASKS.test(submit) && !/findWinner\s*\(/.test(submit),
  'two copies of "is the round over" is two copies to keep in step, and they will not stay in step');

is('the round is claimed atomically before it is scored',
  /findOneAndUpdate\([\s\S]{0,200}status:\s*'collecting-answers'[\s\S]{0,200}status:\s*'completed'/.test(src),
  "a disconnect and a final answer can land together; without a conditional claim the round scores twice");

/*
  Every event the client SENDS must be listened for.

  `leave_game` had been emitted by the room since the first version and the
  server had never once listened. It cost nothing while the only Leave button
  was on the game-over screen — the player was going anyway. It stopped being
  free the moment Leave appeared on the lobby, the answering screen and the
  results screen: the socket provider is app-level and does not close on a
  route change, so a player who left stayed connected forever and the room went
  on naming them as the person it was waiting for.

  A silently ignored emit is the quietest bug there is — no error, no log, and
  the button looks like it worked.
*/
console.log('');
console.log('§1b every event the room sends is one the server answers');
console.log('');

if (fs.existsSync(COMPONENTS)) {
  const room = path.join(COMPONENTS, 'GameRoom.js');
  if (fs.existsSync(room)) {
    const text = rendered(fs.readFileSync(room, 'utf8'));
    const emitted = new Set();
    // socket.emit('x', ...) and the room's own send('x', ...) wrapper
    // Two passes rather than one alternation: a `\b` written into this file
    // by a tool once collapsed to a literal backspace byte, the pattern
    // silently matched nothing, and the sweep reported 2 events instead of
    // 9 while printing ok. A check that cannot fail is worse than no check.
    for (const re of [/socket\.emit\(\s*'([a-z_]+)'/g, /[^A-Za-z0-9_.]send\(\s*'([a-z_]+)'/g]) {
      for (const m of text.matchAll(re)) emitted.add(m[1]);
    }
    const missing = [...emitted].filter((e) => !src.includes(`socket.on('${e}'`));
    is(`every event GameRoom sends has a handler (${emitted.size} checked)`,
      missing.length === 0, missing.join(', '));
    // If the harvest collapses, the assertion above passes for the wrong
    // reason. Name a floor so a broken pattern fails loudly instead.
    is("...and the sweep actually found the events GameRoom sends", emitted.size >= 8,
      `only ${emitted.size} found — the match pattern is probably broken`);
  }
}

/*
  Starting a game that has already started must be refused.

  start_game rewinds status, currentRound and usedQuestions and SAVES before
  inserting round 1 — and on a live game that insert hits the unique
  (gameId, roundNumber) index and throws, leaving the game rewound and round 1
  already completed. Every answer then comes back "round-over" and every
  next_round dies on the same key: the room is bricked for good.

  Unreachable while only a lobby host could press Start. Reachable the moment
  the host fallback widened who could, which is exactly the sort of second-order
  reach a sweep is for.
*/
console.log('');
console.log('§1c a state transition cannot be run twice');
console.log('');

{
  const body = handler('start_game') || '';
  is('start_game refuses a game that is already in progress',
    /status\s*!==\s*'waiting'/.test(body),
    'it rewinds and saves the game BEFORE the insert that fails — the room never recovers');
  is('completeRound clears the answer deadline',
    /roundEndsAt:\s*null/.test(src),
    'a deadline left in the past reads as "the window has passed" forever, authorising skips of scored rounds');
  const skip = handler('skip_question') || '';
  is('skip_question refuses a round that has already been scored',
    /status === 'completed'/.test(skip),
    'replaying a scored round pays its points twice');
}

console.log('');
console.log('§2  every wait has a way out that does not need the missing person');
console.log('');

is('there is a way to reveal a round without everybody', !!handler('reveal_now'));
is('there is a way to abandon a question nobody will answer', !!handler('skip_question'),
  'reveal_now needs an answer to reveal, so a question nobody answers had no exit at all');

/*
  Host-only is the right default and the wrong answer when the host has gone —
  people close tabs, and the host is a person. Every handler that gates on being
  the host must gate on mayActAsHost, which falls through to the room.
*/
is('the host fallback exists', /async function mayActAsHost\s*\(/.test(src));
is('...and it actually falls through when the host is disconnected',
  /mayActAsHost[\s\S]{0,600}host\.isConnected/.test(src),
  'otherwise it is just isHostSocket with a longer name');

const GATED = ['start_game', 'next_round', 'reveal_now', 'skip_question', 'move_pink_cow', 'adjust_score', 'remove_player'];
for (const name of GATED) {
  const body = handler(name);
  if (!body) { fail(`${name} handler not found`); continue; }
  if (!/isHostSocket|mayActAsHost/.test(body)) continue;   // not host-gated at all
  is(`${name} lets the room act when the host has gone`,
    /mayActAsHost\s*\(/.test(body) && !/isHostSocket\s*\(\s*game/.test(body),
    'use mayActAsHost — a bare isHostSocket lets one absent person end everyone else\'s game');
}

// The two clocks. Neither ends anything; each hands a host-only button to the room.
is('the answer window is defined', /const ANSWER_SECONDS\s*=/.test(src));
is('the results window is defined', /const RESULTS_UNLOCK_SECONDS\s*=/.test(src));
is('both allow for client clock skew',
  /CLOCK_GRACE_MS/.test(src) && (src.match(/CLOCK_GRACE_MS/g) || []).length >= 3,
  'a phone whose clock runs two seconds fast must not be told "not yet" by a server that agrees');

console.log('');
console.log('§3  no screen describes a wait without naming who it is for');
console.log('');

/*
  The exact string from the incident, and the shapes near it. A wait with no
  name is a wait nobody in the room can act on: you cannot shout across the
  table at "other players".
*/
const ANONYMOUS = [
  /Waiting for other players/i,
  /Waiting for players\b/i,
  /Waiting for the other/i,
];

function screens(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...screens(full));
    else if (e.name.endsWith('.js')) out.push(full);
  }
  return out;
}

if (!fs.existsSync(COMPONENTS)) {
  console.log('  frontend/ is not in this checkout — skipping the screen sweep');
} else {
  const offenders = [];
  for (const file of screens(COMPONENTS)) {
    const code = rendered(fs.readFileSync(file, 'utf8'));
    if (ANONYMOUS.some((re) => re.test(code))) offenders.push(path.relative(COMPONENTS, file));
  }
  is('no screen says "waiting for other players"', offenders.length === 0, offenders.join(', '));

  const room = path.join(COMPONENTS, 'GameRoom.js');
  if (fs.existsSync(room)) {
    const text = rendered(fs.readFileSync(room, 'utf8'));
    is('the Herd room names who it is waiting for', /waitingFor/.test(text) && /listNames\s*\(/.test(text));
    is('...and offers the way out on screen', /reveal_now/.test(text) && /skip_question/.test(text));
    is('...and shows a player their own answer back', /myAnswer/.test(text),
      'replacing the answer with the word "Waiting" means nobody remembers what they put');
    is('...and never blocks the page with alert()', !/\balert\s*\(/.test(text),
      'a modal alert can wedge the Android WebView, and says "localhost says" in a browser');
    is('...and uses the site\'s layout like every other game', /MeadowLayout/.test(text));
  }
}

console.log('');
if (failures) { console.log(`stuck room — ${failures} problem(s)`); process.exit(1); }
console.log('stuck room — one person putting their phone down cannot end a Herd game');
