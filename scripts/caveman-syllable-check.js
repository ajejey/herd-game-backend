/**
 * The referee in Caveman Clues has to be right.
 *
 *   node scripts/caveman-syllable-check.js
 *
 * A Clue Giver may only use one-syllable words and the computer enforces it.
 * That is the reason to build this game at all — in the boxed version a human
 * has to catch slips live and is bad at it.
 *
 * The two errors are NOT equal, and this file is weighted accordingly:
 *
 *   a missed slip    a two-syllable word gets through. Invisible. Harmless.
 *   a FALSE PENALTY  a real one-syllable word is called illegal. The player is
 *                    cheated by a referee they cannot argue with.
 *
 * So one-syllable accuracy must be 100% and the check fails below it, while
 * multi-syllable detection only has to be good. Deliberately asymmetric.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isOneSyllable, countSyllables, illegalWords, WORD_LISTS } from '../src/games/cavemanclues/syllables.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/* Words a person would actually type into a clue box. Every one is one
   syllable and every one MUST be allowed. */
const ONE = `
cat dog man boy girl thing stuff big small hot cold fast slow round flat
you eat drink walk run jump throw catch hold cut chop burn build make take
red blue green black white gold bright dark loud quiet sharp soft rough
head hand foot eye ear nose mouth tooth arm leg back neck skin bone
tree wood leaf grass rock stone sand dirt sea lake hill sky sun moon star
rain snow ice wind storm fire flame smoke heat light dark
house home room door wall floor roof bed chair desk box key lock
car bus train plane boat bike road street bridge
food bread meat milk cheese egg cake pie soup rice salt sweet
king queen sword shield crown ghost witch knight
time day night week year noon dawn dusk
work play game ball score win lose team sport race
book page word name line note song tune dance art
love hate fear hope wish need want think know feel
strength length twelfth through though thought straight
scratch splash squeeze bright fright fierce pierce
`.trim().split(/\s+/);

/* Words that are plainly more than one syllable. Missing one of these is a
   miss, not a failure — the fallback is meant to under-count. */
const MANY = `
water people little table purple simple circle apple bottle candle
being doing going seeing saying trying flying crying buying
every very many any only busy easy lazy tiny city duty
before after over under other never ever river silver later
animal dinosaur elephant computer telephone banana potato tomato
because before beneath between beyond behind below above
open happy funny angry hungry pretty ugly heavy
never always maybe often rarely almost
create idea area real science quiet lion iron giant
running walking jumping talking eating drinking sleeping
`.trim().split(/\s+/);

/*
  The browser carries a copy of this rule so a long word turns red before it is
  sent. If the two ever diverge, the warning light disagrees with the referee —
  the player is told a word is fine and then charged for it, which reads as the
  game cheating. Compared byte for byte, below the frontend's header.
*/
{
  const fePath = path.join(here, '..', '..', 'frontend', 'src', 'lib', 'syllables.js');
  const bePath = path.join(here, '..', 'src', 'games', 'cavemanclues', 'syllables.js');
  if (fs.existsSync(fePath)) {
    const be = fs.readFileSync(bePath, 'utf8');
    const fe = fs.readFileSync(fePath, 'utf8');
    const stripped = fe.slice(fe.indexOf('/*', fe.indexOf('*/') + 2));
    if (stripped.trim() !== be.trim()) {
      console.error('The browser copy of the syllable rule has drifted from the server copy.\n');
      console.error('  server:  ' + bePath);
      console.error('  browser: ' + fePath);
      console.error('\nEdit the server copy, then re-copy it across keeping the frontend header.');
      process.exit(1);
    }
    console.log('  the browser copy of the rule matches the server copy exactly');
  }
}

/*
  A word in BOTH lists is checked against ONE_SYLLABLE first, so its MULTI entry
  never runs. The referee goes quiet about that word and says nothing about it —
  which is how "flower" was legal for a while despite being listed as illegal.
  Checked here rather than at import, so a typo in a word list can never take
  the backend down.
*/
const overlap = [...WORD_LISTS.MULTI].filter((w) => WORD_LISTS.ONE_SYLLABLE.has(w));
if (overlap.length) {
  console.error(`These words are in BOTH syllable lists, so the MULTI entry is dead:
`);
  overlap.forEach((w, i) => console.error(`  ${i + 1}. ${w}`));
  process.exit(1);
}

/*
  Audit the "definitive" list against the heuristic.

  ONE_SYLLABLE is checked first and short-circuits everything, so a wrong entry
  there turns the rule off for that word silently — and seven were wrong:
  "into", "twenty", "dirty", "woman", "begin", "bottom", "sorry". All words a
  clue giver reaches for, all plainly two syllables, all legal for weeks.

  The heuristic deliberately UNDER-counts, so when even it says a whitelisted
  word is 2+, that entry is almost certainly wrong. The handful below are the
  real exceptions — silent-e words the vowel-group pass mis-reads — and are
  listed by name so anything NEW that disagrees fails instead of blending in.
*/
const HEURISTIC_MISREADS = new Set(['stale', 'whale', 'leaves', 'rules', 'smile', 'whole']);
{
  const suspect = [...WORD_LISTS.ONE_SYLLABLE]
    .filter((w) => countSyllables(w) >= 2 && !HEURISTIC_MISREADS.has(w));
  if (suspect.length) {
    console.error('These are whitelisted as one syllable but look like more:\n');
    suspect.forEach((w, i) => console.error(`  ${i + 1}. ${w} -> ${countSyllables(w)}`));
    console.error('\nRemove them from ONE_SYLLABLE, or add to HEURISTIC_MISREADS if genuinely one.');
    process.exit(1);
  }
  console.log(`  every whitelisted word survives an audit against the heuristic (${WORD_LISTS.ONE_SYLLABLE.size} words)`);
}

/*
  isOneSyllable strips apostrophes before the lookup, so an entry stored WITH
  one can never be matched. "don't" sat in the list as a dead key.
*/
{
  const dead = [...WORD_LISTS.ONE_SYLLABLE].filter((w) => w !== w.toLowerCase().replace(/[^a-z]/g, ''));
  if (dead.length) {
    console.error('These entries can never be matched, because lookups are normalised first:\n');
    dead.forEach((w, i) => console.error(`  ${i + 1}. "${w}" would be looked up as "${w.toLowerCase().replace(/[^a-z]/g, '')}"`));
    process.exit(1);
  }
  console.log('  every whitelisted word is stored in the form it is looked up by');
}

let falsePenalties = 0;
let missed = 0;
const badOnes = [];
const missedOnes = [];

for (const w of ONE) {
  if (!isOneSyllable(w)) { falsePenalties += 1; badOnes.push(`${w} -> ${countSyllables(w)}`); }
}
for (const w of MANY) {
  if (isOneSyllable(w)) { missed += 1; missedOnes.push(`${w} -> ${countSyllables(w)}`); }
}

const oneAcc = 100 * (ONE.length - falsePenalties) / ONE.length;
const manyAcc = 100 * (MANY.length - missed) / MANY.length;

console.log('caveman clues — the referee\n');
console.log(`  one-syllable words allowed   ${ONE.length - falsePenalties}/${ONE.length}  (${oneAcc.toFixed(1)}%)  <- must be 100%`);
console.log(`  multi-syllable words caught  ${MANY.length - missed}/${MANY.length}  (${manyAcc.toFixed(1)}%)  <- good is enough`);

/* Clue-level behaviour, which is what the player actually experiences. */
const CLUES = [
  ['big grey thing with long nose', []],
  ['a giant grey creature', ['giant', 'creature']],
  ['you drive it', []],
  ['it is an animal', ['animal']],
  ['', []],
  ['!!! ??? ...', []],
  ["it's a thing you hold", []],
];
let clueFails = 0;
console.log('');
for (const [clue, expected] of CLUES) {
  const got = illegalWords(clue);
  const same = got.length === expected.length && got.every((w, i) => w === expected[i]);
  if (!same) { clueFails += 1; console.log(`  FAIL  "${clue}" -> [${got}] expected [${expected}]`); }
}
if (!clueFails) console.log(`  every sample clue is judged as designed (${CLUES.length} clues)`);

console.log('');
if (falsePenalties) {
  console.error(`${falsePenalties} FALSE PENALTIES — these are real one-syllable words the referee rejects:\n`);
  badOnes.forEach((w, i) => console.error(`  ${i + 1}. ${w}`));
  console.error('\nAdd them to ONE_SYLLABLE in src/games/cavemanclues/syllables.js.');
  process.exit(1);
}
if (clueFails) { console.error(`${clueFails} clue(s) judged wrongly`); process.exit(1); }
if (missed) {
  console.log(`  (${missed} multi-syllable word(s) slip through, which is the safe direction: ${missedOnes.join(', ')})`);
}
console.log('  no real one-syllable word is ever refused');
