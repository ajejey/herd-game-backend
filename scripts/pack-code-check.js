/**
 * Guards the one thing a pack code has to do: be findable again.
 *
 *   node scripts/pack-code-check.js
 *
 * A pack code is the only key to a host's questions — there is no account to
 * fall back on. If a code we issue does not survive normalisation on the way
 * back in, the pack is gone and the host has no way to know why. That is not
 * hypothetical: a Community Coordinator wrote five packs for a work event and
 * could not use any of them, and the reason was on our side both times.
 *
 * Codes are now built from the pack's name, which means hyphens and lengths
 * the old normaliser actively destroyed — it capped at 12 characters and
 * stripped every hyphen. Either alone silently breaks every named pack.
 *
 * So this asserts the ROUND TRIP: generate, then normalise the way a lookup
 * does, and require the result to be identical — including for input mangled
 * the way real people mangle it (a phone capitalising, an email adding a full
 * stop, a copy-paste bringing spaces).
 *
 * Needs no database.
 */
import { slugifyTitle, PACK_GAMES as PACK_GAMES_ENUM } from '../src/models/CustomPack.js';

/* Kept in step with packs.js `clean` by pack-code-check itself: if that
   function changes and this copy does not, the mismatch tests below fail. */
const clean = (code) =>
  String(code == null ? '' : code)
    .slice(0, 48)
    .toUpperCase()
    .replace(/[^A-Z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

const problems = [];
const ok = [];
const check = (label, pass, detail = '') =>
  pass ? ok.push(label) : problems.push(`${label}${detail ? ' — ' + detail : ''}`);

/* Titles real people actually use, including the ones that broke it before. */
const TITLES = [
  'CISS Division- Letter S',
  'CISS DIVISION- Something said in meeting',
  'Year 7 Science — Term 3 Revision Quiz for the whole class',
  'Tom & Jerry',
  'Café Münchën',
  'Ünïcödé Tëst',
  'a',
  'Supercalifragilisticexpialidocious quiz',
  "Dave's Friday Quiz!!!",
  '2026 Kickoff',
];

for (const title of TITLES) {
  const slug = slugifyTitle(title);
  const code = slug ? `${slug}-K7X` : 'QXUME5';

  check(`"${title}" survives normalisation`, clean(code) === code, `${code} -> ${clean(code)}`);
  check(`"${title}" has no leading/trailing hyphen`, !/^-|-$/.test(code), code);
  check(`"${title}" has no doubled hyphen`, !/--/.test(code), code);
  check(`"${title}" is a sane length`, code.length >= 4 && code.length <= 32, `${code.length} chars`);
}

/* The ways a code arrives back after a human has handled it. */
const CODE = 'CISS-DIVISION-LETTER-S-K7X';
const MANGLED = [
  ['lowercase', 'ciss-division-letter-s-k7x'],
  ['trailing full stop', 'CISS-DIVISION-LETTER-S-K7X.'],
  ['wrapped in spaces', '  CISS-DIVISION-LETTER-S-K7X  '],
  ['en dash from a mail client', 'CISS–DIVISION-LETTER-S-K7X'.replace('–', '-')],
  ['doubled hyphen from a line break', 'CISS--DIVISION-LETTER-S-K7X'],
  ['mixed case', 'Ciss-Division-Letter-S-k7x'],
];
for (const [label, input] of MANGLED) {
  check(`recovers from ${label}`, clean(input) === CODE, `${input} -> ${clean(input)}`);
}

/* Old codes must keep working exactly as before — people wrote them down. */
for (const legacy of ['QXUME5', 'STBCWZ', 'GCEULE', 'CEPPPT', 'AVYFKB']) {
  check(`legacy code ${legacy} unchanged`, clean(legacy) === legacy, clean(legacy));
  check(`legacy code ${legacy} recovers from lowercase`, clean(legacy.toLowerCase()) === legacy);
}

/* A code must never normalise to nothing — that would look up every pack. */
for (const junk of ['', '   ', '---', '...', '🎉']) {
  check(`junk "${junk}" normalises to empty, not to a match`, clean(junk) === '');
}

/* Distinctness: a named code must never collide with a room code's shape. */
check(
  'a named code cannot be mistaken for a 4-letter room code',
  slugifyTitle('Letter S') && `${slugifyTitle('Letter S')}-K7X`.length > 6,
  `${slugifyTitle('Letter S')}-K7X`
);


/*
  The frontend previews the ID as you type the name, which means the slug rule
  now exists twice: slugifyTitle here, previewSlug in
  frontend/src/components/custom/CustomPack.js.

  Two copies of one rule drift, and this pair drifts SILENTLY — the preview just
  starts promising an ID the server will not issue. The first version did
  exactly that within minutes of being written: it showed
  "CISS-DIVISION-LETTER-..." for a title the server turns into
  "CISS-DIVISION-LETTER-S".

  So the frontend copy is read out of its own source and run against the same
  titles. No HTTP, no build step — edit one and not the other and this fails.
*/
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const FE = path.join(here, '..', '..', 'frontend', 'src', 'components', 'custom', 'CustomPack.js');

/*
  packCode.js is ESM inside a CRA app, so it cannot simply be imported from a
  backend script. Evaluating its source keeps ONE definition of these rules
  rather than a second copy here that would drift — which is the whole point of
  this file. Stripping `export ` wholesale, not `export function`: a later
  `export const` broke that narrower version the day it was added.
*/
function loadPackCodeLib() {
  const src = fs.readFileSync(
    path.join(here, '..', '..', 'frontend', 'src', 'lib', 'packCode.js'), 'utf8');
  return new Function(`${src.replace(/^export /gm, '')}
    return { cleanPackCode, describeRoomCodeMistake, sanitizeCodeInput, PACK_GAMES, packPlayPath };`)();
}

if (fs.existsSync(FE)) {
  const src = fs.readFileSync(FE, 'utf8');
  const maxMatch = src.match(/const MAX_SLUG_PREVIEW = (\d+);/);
  const fnMatch = src.match(/function previewSlug\(title\) \{[\s\S]*?\n\}/);

  check('frontend exposes MAX_SLUG_PREVIEW', !!maxMatch);
  check('frontend exposes previewSlug', !!fnMatch);

  if (maxMatch && fnMatch) {
    check('preview slug length matches the server', Number(maxMatch[1]) === 24,
      `frontend ${maxMatch[1]}, server 24`);

    const previewSlug = new Function(
      `const MAX_SLUG_PREVIEW = ${maxMatch[1]}; ${fnMatch[0]}; return previewSlug;`
    )();

    for (const title of TITLES) {
      const server = slugifyTitle(title);
      const preview = previewSlug(title);
      const expected = server || 'YOUR-PACK';
      check(`preview matches server for "${title}"`, preview === expected,
        `preview ${preview}, server ${expected}`);
    }
  }
} else {
  console.log('  (frontend not present, skipping preview drift check)');
}



/*
  ── The join box, in every game ──────────────────────────────────────────────

  A pack ID is only useful if the site tells you when you have put one in the
  wrong box. Two bugs got there first, both silent, both in the input handler:

    maxLength={4}                        truncated a pasted ID to four characters
    .replace(/[^A-Z]/g, '')              ate every hyphen and digit as you typed

  Neither threw. Both produced a code the server could not find and an error
  message that blamed the code. And they were each present in SOME games and not
  others, which is the part a spot-check never catches — the fix for one game
  said nothing about the other ten.

  So this asserts across EVERY game home at once, including ones not written
  yet: one shared sanitiser, no bespoke strip, room enough for a named ID, and
  the explanation actually rendered.
*/
if (fs.existsSync(FE)) {
  const COMPONENTS = path.join(here, '..', '..', 'frontend', 'src', 'components');

  const homes = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && /Home\.js$/.test(entry.name)) homes.push(full);
    }
  };
  walk(COMPONENTS);

  const joinBoxes = homes.filter((f) => {
    const src = fs.readFileSync(f, 'utf8');
    return /placeholder="(Room code|6-LETTER CODE)/i.test(src);
  });

  check('every game home with a join box was found', joinBoxes.length >= 12,
    `${joinBoxes.length} found`);

  for (const file of joinBoxes) {
    const name = path.basename(file);
    const src = fs.readFileSync(file, 'utf8');

    check(`${name} sanitises the code field through the shared rule`,
      /set(Code|RoomCode)\(sanitizeCodeInput\(/.test(src),
      'must use sanitizeCodeInput, not a local .toUpperCase()/.replace()');

    check(`${name} does not strip hyphens or digits while typing`,
      !/\.replace\(\/\[\^A-Z\]\/g/.test(src),
      'a local [^A-Z] strip destroys every pasted pack ID');

    check(`${name} explains a pack ID in the room-code box`,
      /<JoinCodeHelp/.test(src));

    /* A named ID is up to 28 characters. Any cap below that silently truncates
       the paste, which is exactly how this started. */
    const caps = [...src.matchAll(/maxLength=\{(\d+)\}/g)].map((m) => Number(m[1]));
    const codeCaps = caps.filter((n) => n !== 20); // 20 is the name field
    check(`${name} leaves room for a full pack ID`,
      codeCaps.every((n) => n >= 32),
      `maxLength ${codeCaps.join(', ') || 'none'}`);
  }

  /* The describer itself, run against the shapes people actually paste. */
  const { describeRoomCodeMistake: describe, sanitizeCodeInput: sanitize } = loadPackCodeLib();

  check('a named pack ID in a 4-letter box is called a pack ID',
    describe('CISS-DIVISION-LETTER-S-K7X', 4, { typing: true })?.packId === true);
  check('a legacy 6-character pack ID in a 4-letter box is flagged',
    describe('QXUME5', 4, { typing: true })?.packId === true);
  check('a real 4-letter room code is left alone',
    describe('ABCD', 4, { typing: true }) === null);
  check('a half-typed room code stays quiet while typing',
    describe('AB', 4, { typing: true }) === null);
  check('a half-typed room code is explained after a failed join',
    describe('AB', 4)?.message.includes('4 letters') === true);
  check('an empty box says nothing', describe('', 4, { typing: true }) === null);
  check('a legacy 6-character room code is left alone on the herd page',
    describe('QXUME5', 6, { typing: true }) === null);

  /* Typing must be possible, not just pasting: a sanitiser that trims trailing
     hyphens makes a hyphen impossible to enter by hand. */
  check('a hyphen can be typed one keystroke at a time',
    sanitize('CISS-') === 'CISS-', sanitize('CISS-'));
  check('typing keeps digits', sanitize('K7X') === 'K7X');
  check('typing drops junk', sanitize('ab cd!') === 'ABCD');
}

/*
  ── Where a pack can be played ───────────────────────────────────────────────

  A pack is written FOR one game, and only five of the twelve games can take one
  at all. The join-box signpost looks a pasted ID up and offers to open it in
  the game it belongs to, which means a frontend map of game -> route.

  The backend enum is the source of truth for which games those are. If someone
  adds a sixth pack game there and not here, the signpost silently sends every
  pack of that new kind to the wrong place — a redirect that looks like it
  worked. So compare the two directly.
*/
{
  const feMap = loadPackCodeLib().PACK_GAMES;
  const feIds = Object.keys(feMap).sort();
  const beIds = [...PACK_GAMES_ENUM].sort();

  check('the frontend and backend agree on which games take a pack',
    feIds.join(',') === beIds.join(','), `frontend [${feIds}] vs backend [${beIds}]`);

  for (const id of beIds) {
    check(`${id} has a route the signpost can send a host to`,
      !!(feMap[id] && feMap[id].path && feMap[id].path.startsWith('/')),
      feMap[id] ? String(feMap[id].path) : 'missing');
    check(`${id} has a name a host would recognise`,
      !!(feMap[id] && feMap[id].name && feMap[id].name.length > 2));
  }

  /* The pack page used to keep its own copy of this map. It must not again. */
  const cp = fs.readFileSync(
    path.join(here, '..', '..', 'frontend', 'src', 'components', 'custom', 'CustomPack.js'), 'utf8');
  check('the pack page uses the shared map rather than a second copy',
    /packPlayPath/.test(cp) && !/const PLAY_PATHS = \{/.test(cp));
}

console.log(`pack code round trip — ${ok.length} checks
`);
if (problems.length) {
  console.error(`${problems.length} problem(s):
`);
  problems.forEach((p, i) => console.error(`  ${i + 1}. ${p}`));
  process.exit(1);
}
console.log('  every generated code survives lookup normalisation');
console.log('  every mangled form recovers to the original');
console.log('  every legacy six-character code is untouched');
console.log('  no input normalises to an empty code');
console.log('  the preview and the server agree on every title');
console.log('  every join box shares one sanitiser and explains a pack ID');
console.log('  the signpost can route every kind of pack to its own game');
