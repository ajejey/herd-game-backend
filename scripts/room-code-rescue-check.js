/*
  A person holding a room code must never reach a dead end.

    node scripts/room-code-rescue-check.js

  ── The bug this is the invariant for ───────────────────────────────────────
  Search logging for Sep 2026: 27% of everything typed into the site search box
  was a ROOM CODE, not a game name. QCGJ, THBZ, LNQP, HRAL and 3QB19F were each
  checked against the database and every one was a LIVE ROOM at the moment it
  was typed. Those people had been sent a code, could not find the field it goes
  in, typed it into the only box that looked like one, and were told "nothing
  found" — while their friends sat waiting in the room.

  Nothing errored, nothing was reported, and no existing check could have seen
  it. The room worked. The search worked. The gap was between them.

  ── The general statement, which is what makes this worth a file ────────────
  "Clover's join box takes a code" is a fact about one game. The statement that
  would have caught this is:

      EVERY route into the site that accepts free text from a person who might
      be holding a room code must be able to recognise one and send them to it.

  Today that means the search box (via /api/find-room) and every game's join
  box (via ?join=). A fourteenth game added next month gets the same guarantee
  only if this check knows to look for it, so it enumerates the game homes from
  disk rather than from a list somebody has to remember to update.
*/
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { GAME_DIRECTORY } from '../src/engine/gameDirectory.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FE = path.join(HERE, '..', '..', 'frontend', 'src');

let failures = 0;
const fail = (m, d = '') => { console.log(`  FAIL  ${m}${d ? ' — ' + d : ''}`); failures += 1; };
const ok = (m) => console.log(`  ok    ${m}`);
const is = (m, c, d = '') => (c ? ok(m) : fail(m, d));

console.log('');
console.log('=== nobody with a room code hits a dead end ===');

/* ── The lookup exists and is mounted ─────────────────────────────────────── */
{
  const index = fs.readFileSync(path.join(HERE, '..', 'src', 'index.js'), 'utf8');
  is('the room lookup is mounted', /app\.use\('\/api\/find-room'/.test(index),
    'nothing serves /api/find-room, so the search box has nothing to ask');

  /*
    The three-store lookup moved out of findRoom.js into roomLookup.js on
    13 Sep 2026, so that the socket join handlers could use it too and stop
    telling people a working code did not exist. These assertions follow the
    IMPLEMENTATION rather than the route — findRoom.js is now one caller of
    three, and the thing that must keep checking all three stores is the module.
  */
  const finder = fs.readFileSync(path.join(HERE, '..', 'src', 'roomLookup.js'), 'utf8');
  /*
    Three sources, and the in-memory one matters most: persistence is debounced,
    so a room created seconds ago exists ONLY in memory — and a room created
    seconds ago is exactly the one someone is being invited to right now.
  */
  is('...and it checks live rooms, not just the database',
    /store\.allGames\(\)/.test(finder),
    'findRoom only reads Mongo — the freshest rooms, which are the ones being shared, would 404');
  is('...and the snapshot, so a room survives a restart', /game_rooms/.test(finder));
  is('...and the legacy Herd collection', /collection\('games'\)/.test(finder));
  is('...and refuses anything that is not code-shaped', /\^\[A-Z0-9\]\{4,6\}\$/.test(finder));
  /* Rate limiting stayed in findRoom.js when the lookup moved out — it guards
     the public HTTP surface, not the question. Asserted against the ROUTE for
     that reason. A refactor once deleted the limiter's definition here while
     leaving the call, which is a ReferenceError on every request AND the loss
     of the enumeration guard, so this checks both halves. */
  const route = fs.readFileSync(path.join(HERE, '..', 'src', 'findRoom.js'), 'utf8');
  is('...and is rate limited, because codes are short and enumerable',
    /function rateLimited/.test(route) && /rateLimited\(/.test(route) && /429/.test(route),
    'the limiter must be defined here, called here, and answer 429');
}

/* ── The search box asks ──────────────────────────────────────────────────── */
{
  const search = fs.readFileSync(path.join(FE, 'components', 'common', 'GameSearch.js'), 'utf8');
  is('the search box recognises a code-shaped query',
    /CODE_SHAPE/.test(search) && /api\/find-room/.test(search),
    'GameSearch does not look a code up — the original dead end is back');
  is('...and offers the room above the game results',
    /search-room-hit/.test(search));
  /*
    A failed lookup must leave the ordinary empty state alone. Otherwise
    searching for a real four-letter word — "word", "quiz" — would sit on a
    blank dropdown waiting for a room that does not exist.
  */
  is('...and a miss still shows the normal "nothing found" help',
    /results\.length === 0 && !room/.test(search),
    'a failed room lookup would swallow the empty state');
}

/* ── Every game home accepts ?join= ───────────────────────────────────────── */
{
  const homes = [];
  const comp = path.join(FE, 'components');
  for (const dir of fs.readdirSync(comp)) {
    const full = path.join(comp, dir);
    if (!fs.statSync(full).isDirectory()) continue;
    for (const f of fs.readdirSync(full)) {
      if (!/Home\.js$/.test(f)) continue;
      const src = fs.readFileSync(path.join(full, f), 'utf8');
      /* Only the ones that actually have a join box — a solo game's home has no
         code to prefill and must not be failed for it. */
      if (!/setCode|sanitizeCodeInput/.test(src)) continue;
      homes.push([`${dir}/${f}`, src]);
    }
  }

  is('the game homes with a join box were found',
    homes.length >= Object.keys(GAME_DIRECTORY).length,
    `found ${homes.length}, but the directory lists ${Object.keys(GAME_DIRECTORY).length} games`);

  /*
    MATCH THE USE, NOT THE IMPORT. The first version tested for /codeFromUrl/
    anywhere in the file, which the `import { codeFromUrl, initialTab }` line
    satisfies on its own — so deleting the actual prefill and leaving the import
    behind, which is precisely what a careless edit looks like, passed a green
    assertion. Found by breaking it on purpose.
  */
  const noPrefill = homes.filter(([, src]) => !/useState\(codeFromUrl\)/.test(src)).map(([n]) => n);
  is('...and every one of them prefills a code from ?join=',
    noPrefill.length === 0,
    `${noPrefill.join(', ')} — a code in the URL would arrive at an empty field`);

  const wrongTab = homes.filter(([, src]) => !/useState\(initialTab\)/.test(src)).map(([n]) => n);
  is('...and opens on the join tab when there is one',
    wrongTab.length === 0,
    `${wrongTab.join(', ')} — the code would be filled into a field hidden behind the Create tab`);
}

/*
  ── An invitation beats a memory ────────────────────────────────────────────

  Home.js has two mount effects that both write roomCode: one reads ?join= from
  the URL, the other restores the player's last session. The session effect is
  declared second, so it won — someone arriving on /?join=BBBBBB got the Join
  tab opened with the code from their OWN last game in the field, and joined the
  wrong room.

  It was almost invisible while the session was deleted on game completion.
  Making the session survive twelve hours turned it into the ordinary case, and
  the search box's room-code rescue sends people to exactly that URL. A code
  someone was SENT must never be replaced by one they were not.
*/
{
  const home = fs.readFileSync(path.join(FE, 'components', 'Home.js'), 'utf8');
  is('a saved session cannot overwrite a code from ?join=',
    /const invited = new URLSearchParams\(location\.search\)\.get\('join'\)[\s\S]{0,200}if \(!invited\) setRoomCode/.test(home),
    'Home.js restores the last session over an invited code — an invited friend joins the wrong room');
}

/* ── The directory covers every mounted game ──────────────────────────────── */
{
  const index = fs.readFileSync(path.join(HERE, '..', 'src', 'index.js'), 'utf8');
  const mounted = [...index.matchAll(/mountGame\(io,\s*'([^']+)'/g)].map((m) => m[1]);
  const missing = mounted.filter((ns) => !GAME_DIRECTORY[ns]);
  /*
    A game missing from the directory cannot be named by the lookup, so its
    codes resolve to nothing and its players get the dead end back — for that
    game only, which is exactly the kind of gap nobody notices.
  */
  is('every mounted game is in the directory, so its codes can be found',
    missing.length === 0, missing.join(', '));
}

/* ── The JOIN boxes, not just the search box ──────────────────────────────── */
/*
  The invariant at the top of this file says EVERY route that takes a code from
  a person must be able to recognise one. When it was written, "every route"
  meant the search box and the ?join= links. It missed the place people
  actually type a code: the join box on a game page.

  Error data for the 30 days to 13 Sep 2026:

      page "herd", FOUR-character code, "Game not found"   -> 35 people
      engine page, SIX-character code, "Room not found"    ->  3 people

  Herd Mentality issues six-character codes and the engine games issue four, so
  a four-character code in the Herd join box is never a Herd code — it is a
  live room in another game. Those 35 people were told their working code did
  not exist.

  The engine had solved half of this already (a code for another ENGINE game
  gets "That code is for Taboo, not this game"), which is why the gap survived:
  the half that worked made it look finished. The legacy game could not see
  engine rooms and the engine could not see legacy rooms, because the only
  cross-store lookup lived inside an Express handler.

  Asserted on the source rather than against a live server so it runs in the
  same second as the rest of the suite, and so it fails on the DELETION of the
  lookup rather than only on a room that happens to exist while the test runs.
*/
{
  const BE = path.join(HERE, '..', 'src');
  const read = (...p) => {
    try { return fs.readFileSync(path.join(BE, ...p), 'utf8'); } catch { return ''; }
  };

  const lookup = read('roomLookup.js');
  const legacy = read('index.js');
  const engine = read('engine', 'index.js');

  is('a single cross-store lookup exists',
    /export async function lookupRoom/.test(lookup),
    'roomLookup.js is what lets a join path answer "it is not here, it is there"');

  is('...and it checks all three places a room can live',
    /store\.allGames\(\)/.test(lookup)
    && /game_rooms/.test(lookup)
    && /collection\('games'\)/.test(lookup),
    'live memory, the snapshot, and the legacy collection — miss one and that game goes dark');

  /* The search box was the first caller and must stay on the shared one, or
     the two implementations drift and only one of them gets the next fix. */
  is('...and the search box uses it rather than its own copy',
    /lookupRoom/.test(read('findRoom.js')) && !/collection\('games'\)/.test(read('findRoom.js')),
    'two copies of this logic is how half of it gets fixed');

  /*
    The real assertion: neither join path may say "not found" without having
    asked. Checked as "the lookup is called in the same handler", which is what
    breaks if somebody deletes the call while keeping the error.
  */
  /*
    Anchored on the EMIT, not on the message text. The first version searched
    for the bare phrase "Game not found" and matched it inside the comment that
    explains the fix, which sits above the lookup — so the slice ended before
    the call it was looking for and the check failed against code that was
    correct. Match the line that actually refuses the player.
  */
  const before = (src, emitNeedle, startNeedle) => {
    const from = src.indexOf(startNeedle);
    const at = src.indexOf(emitNeedle, from);
    return from === -1 || at === -1 ? '' : src.slice(from, at);
  };

  is('the Herd join box asks where a code belongs before refusing it',
    /lookupRoom\(/.test(before(legacy, "socket.emit('error', { message: 'Game not found' })", "socket.on('join_game'")),
    'a four-character code here is an engine room, and 35 people were told it did not exist');

  is('...and so does every engine game',
    /lookupRoom\(/.test(before(engine, "'Room not found. Check your code.', 'ROOM_NOT_FOUND'", "socket.on('join_game'")),
    'the reverse direction is rarer but it is the same mistake');

  is('...and both name the game rather than just saying no',
    /elsewhereMessage/.test(legacy) && /elsewhereMessage/.test(engine),
    '"that code is for Hue Match" is a one-tap problem; "not found" is a dead end');
}

console.log('');
if (failures) { console.log(`room-code rescue — ${failures} problem(s)\n`); process.exit(1); }
console.log('room-code rescue — a code always leads somewhere\n');
process.exit(0);
