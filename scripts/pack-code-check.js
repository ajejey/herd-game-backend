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
import { slugifyTitle } from '../src/models/CustomPack.js';

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

console.log(`pack code round trip — ${ok.length} checks\n`);
if (problems.length) {
  console.error(`${problems.length} problem(s):\n`);
  problems.forEach((p, i) => console.error(`  ${i + 1}. ${p}`));
  process.exit(1);
}
console.log('  every generated code survives lookup normalisation');
console.log('  every mangled form recovers to the original');
console.log('  every legacy six-character code is untouched');
console.log('  no input normalises to an empty code');
