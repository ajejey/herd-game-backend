/*
  Is this word one syllable?

  The entire game rests on this. A Clue Giver may only use one-syllable words,
  and the computer is the referee — which is the reason this version is better
  than the boxed one, where a human has to catch slips in real time and argues
  about whether "fire" counts.

  BIAS PERMISSIVE, ALWAYS. The two errors are not equal:

    A missed slip   — a two-syllable word gets through. Nobody notices, nobody
                      is harmed, the round continues.
    A false penalty — a real one-syllable word is called illegal. The player is
                      cheated by a referee they cannot argue with, and that is
                      the single fastest way to make someone close the tab.

  So when the heuristic is unsure, the word is legal.

  Order of authority:
    1. ONE_SYLLABLE  — an explicit set of the words people actually reach for
                       when giving clues. Definitive; no guessing involved.
    2. MULTI         — the short list the heuristic reliably gets wrong.
    3. countSyllables — vowel-group fallback, tuned to under-count.
*/

/*
  Common one-syllable English words. Not a dictionary — the working vocabulary
  of someone describing a thing quickly. Heavy on verbs and concrete nouns,
  because that is what clues are made of.
*/
const ONE_SYLLABLE = new Set(`
a an the this that these those there here it its is are was were be been am
i you he she we they me him her us them my your his our their mine yours
and or but not no yes if so as at by for from in of off on out to up
with when where who whose which what how why all both each few more most
some such own same than too can will just dont should now then
one two three four five six eight nine ten twelve 
big small large tall short long wide thin thick fat slim round square flat
hot cold warm cool wet dry hard soft rough smooth sharp blunt clean 
new old young fresh stale dead live real fake true false right wrong
good bad best worst great grand fine nice mean kind cruel calm wild
fast slow quick swift high low deep shy loud still loose tight
red blue green black white grey gray brown pink gold tan dark light bright
man men girl boy kid child kids folk guy guys friend friends
head face eye eyes ear ears nose mouth lip lips tooth teeth tongue chin
neck arm arms hand hands thumb leg legs foot feet knee back chest heart
brain bone skin hair blood breath voice mind soul life death
dog cat pig cow horse sheep goat bird duck hen fish shark whale seal bear
wolf fox deer mouse rat bat bug bee ant fly worm snake frog toad crab
food bread meat milk cheese egg eggs cake pie soup rice beans corn
fruit grape peach plum pear date fig nut nuts salt sweet sour spice
drink juice wine beer tea cup mug plate bowl fork knife spoon dish
house home room door wall floor roof stairs yard gate fence shed barn
bed chair desk couch shelf lamp light clock phone screen key lock box
car bus train plane boat ship bike truck van cab road street path bridge
tree wood leaf leaves grass plant seed root branch rose vine
sun moon star sky cloud rain snow ice wind storm sea lake pond stream
hill rock stone sand dirt earth world land ground field farm town
fire flame smoke heat spark ash coal steam gas oil dust mud
time day night week month year hour week dawn dusk noon
work job play game sport ball team score win loss goal race
book page word words name line note page ink pen art song tune dance
school class test grade math class rules law court judge
king queen prince knight guard sword shield crown throne
god church saint priest faith
mine yours ours theirs self
go goes went gone come came get got give gave take took make made
do does did have has had say said tell told ask asked
see saw look watch hear heard feel felt smell taste touch
think thought know knew mean meant want need wish hope
walk run ran jump leap climb crawl swim fly flew fall fell
sit stand lie kneel bend twist turn spin roll slide slip
eat ate drink drank sleep slept wake woke dream
speak spoke talk shout yell scream cry laugh smile frown grin
push pull lift drop throw threw catch caught hold held grab
cut chop slice break broke bend fix build built burn melt freeze
buy bought sell sold pay paid cost spend save earn owe
find found lose lost keep kept leave left stay wait
start stop end help hurt heal kill die live
read write draw paint sing play dance act show hide seek
love hate like fear trust doubt care mind
one thing things stuff kind sort type bit piece part half whole
lot lots much more less least none some most
top front back side edge end mid line row line
first last next past next
please thanks hi hey bye
`.trim().split(/\s+/));

/*
  Words the vowel-group heuristic gets wrong in the direction that matters —
  it reads them as one syllable when they are not. Kept short on purpose: this
  list only needs the words that plausibly show up in a clue.
*/
const MULTI = new Set(`
being doing going seeing saying trying dying lying flying crying buying
higher lower fired hire wire tire tired power tower flower
science diet lion iron giant riot poem really area idea
create creates played prayed layed
every very many any only busy easy lazy tiny city pity duty
people little middle simple purple circle table cable title
water later after over under other never ever river silver beyond maybe
into twenty dirty woman begin bottom sorry
`.trim().split(/\s+/));

/*
  Kept OUT of MULTI on purpose: "fire", "hour", "our", "real" and "quiet" are argued
  about by real speakers and are commonly one syllable, so the permissive rule
  says allow them. "very" and "many" are the opposite — unambiguously
  two, and exactly the words a Clue Giver reaches for first, so letting them
  through would gut the constraint the game is built on.

  A word must never appear in both sets. ONE_SYLLABLE is checked first, so an
  overlap silently disables the MULTI entry and the referee goes quiet without
  saying so. caveman-syllable-check.js fails on any overlap — deliberately
  there and not here, because a typo in a word list must never be able to take
  the backend down at import time.
*/

export const WORD_LISTS = { ONE_SYLLABLE, MULTI };

const VOWELS = 'aeiouy';

/**
 * Rough syllable count. Only used when the word is in neither list, and tuned
 * to UNDER-count so an unknown word tends to come back legal.
 */
export function countSyllables(raw) {
  const w = String(raw || '').toLowerCase().replace(/[^a-z]/g, '');
  if (!w) return 0;
  if (w.length <= 3) return 1;

  let count = 0;
  let prevVowel = false;
  for (let i = 0; i < w.length; i += 1) {
    const isVowel = VOWELS.includes(w[i]);
    if (isVowel && !prevVowel) count += 1;
    prevVowel = isVowel;
  }

  // Silent trailing e: "make", "bite", "hope" are one syllable, not two.
  if (w.endsWith('e') && !w.endsWith('le') && count > 1) count -= 1;
  // ...but "-le" after a consonant IS its own syllable: "table", "little".
  if (w.endsWith('le') && w.length > 2 && !VOWELS.includes(w[w.length - 3])) count += 1;
  // Regular past tense is usually silent: "walked", "jumped" stay at one.
  if (/[^aeiou]ed$/.test(w) && !/[dt]ed$/.test(w) && count > 1) count -= 1;

  return Math.max(1, count);
}

/** True when the word may legally appear in a clue. */
export function isOneSyllable(word) {
  const w = String(word || '').toLowerCase().replace(/[^a-z']/g, '').replace(/'/g, '');
  if (!w) return true;                    // punctuation alone is not a slip
  if (ONE_SYLLABLE.has(w)) return true;   // definitive
  if (MULTI.has(w)) return false;         // definitive
  return countSyllables(w) <= 1;          // permissive fallback
}

/*
  ONE tokenizer, shared by the referee and by the warning light in the browser.

  They used to differ: the server split on [^A-Za-z']+ while the clue meter in
  CavemanCluesRoom.js split on whitespace. So "red-hot" was one token on screen
  (painted red, "costs a point") and two tokens on the server ("red", "hot",
  both legal, no penalty). The warning light disagreed with the referee, which
  is the exact failure the byte-for-byte sync of this file exists to prevent —
  the rule matched, the tokenizer did not.

  Separators are kept so the browser can re-render the clue with each word
  coloured without splitting it a second time, differently.
*/
export function tokenizeClue(clue) {
  return String(clue || '')
    .split(/([^A-Za-z']+)/)
    .filter((t) => t !== '')
    .map((t) => ({ text: t, isWord: /[A-Za-z]/.test(t) }));
}

/**
 * The words in a clue that break the rule. Empty means the clue is legal.
 */
export function illegalWords(clue) {
  return tokenizeClue(clue)
    .filter((t) => t.isWord && !isOneSyllable(t.text))
    .map((t) => t.text);
}
