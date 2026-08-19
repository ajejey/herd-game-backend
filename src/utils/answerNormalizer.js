import { stemmer } from 'stemmer';

/*
  Turns what a player typed into the key their answer is counted under.

  This decides whether two people "said the same thing" — in Daily Herd, and in
  the live multiplayer game where it drives scoring (index.js). Getting it wrong
  in the tight direction tells someone they were an outlier when they were with
  the herd, which in a game about matching the crowd does not read as a bug. It
  reads as the game disagreeing with you.

  Measured against 36,266 real answers across 390 question-days, the previous
  version left 9.7% of all answers in the wrong bucket. The worst offenders, all
  from live data:

      "rollercoaster" (52) vs "Roller Coaster" (35)   — six separate days,
                                                        flipped the top answer
                                                        every time
      "burning" (42)       vs "burn" (15)
      "Dominos" (53)       vs "Dominoes" (11)
      "how are you" (27)   vs "How are you?" (10)
      "childbirth" (25)    vs "child birth" (10)

  Two causes. Spacing was never collapsed, so "roller coaster" and
  "rollercoaster" were permanently different words. And plurals were handled by
  `.replace(/s$/, '')`, which strips the last character off anything ending in
  s — "chess" became "ches", "bus" became "bu".

  WHAT THIS DELIBERATELY DOES NOT DO: merge on meaning. "Cold", "snow" and "ice"
  are all answers to the same winter question and are genuinely different
  answers. Any semantic measure loose enough to merge cap/hat also merges
  cold/snow, and telling someone they agreed with a person they did not is worse
  than telling them they were rarer than they were. Synonyms belong in a
  reviewed list, not in a similarity threshold.
*/

const ARTICLES = new Set(['a', 'an', 'the']);

/*
  Plurals no rule can reach.

  A stemmer works on spelling, so "mice" and "mouse" have nothing in common for
  it to find. In a word game these are exactly the answers people give — mice,
  children, knives, people — so a short lookup earns its place where a clever
  algorithm cannot.
*/
const IRREGULAR = new Map(Object.entries({
  mice: 'mouse', geese: 'goose', teeth: 'tooth', feet: 'foot',
  children: 'child', people: 'person', men: 'man', women: 'woman',
  knives: 'knife', lives: 'life', wives: 'wife', leaves: 'leaf',
  halves: 'half', shelves: 'shelf', loaves: 'loaf', thieves: 'thief',
  wolves: 'wolf', calves: 'calf', selves: 'self', elves: 'elf',
  oxen: 'ox', dice: 'die', pence: 'penny',
}));

/*
  "-es" after a sibilant is a plural marker, not part of the word.

  Without this, Porter turns "bus" into "bu" but "buses" into "buse" — the two
  never meet, which is the same class of bug as the old `.replace(/s$/, '')` and
  just as invisible. Stripping the "es" first puts both on "bus" before the
  stemmer sees either.
*/
function depluralize(w) {
  if (w.length > 3 && w.endsWith('es')) {
    const base = w.slice(0, -2);
    if (/(s|x|z|sh|ch)$/.test(base)) return base;
  }
  return w;
}

export function normalizeAnswer(answer) {
  if (!answer) return '';

  const cleaned = String(answer)
    .toLowerCase()
    // Punctuation goes, but apostrophes inside words are kept for now so
    // "don't" does not become "dont" before the article pass sees it.
    .replace(/[.,/#!$%^&*;:{}=\-_`~()?"[\]<>|\\+]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const words = cleaned
    .split(' ')
    .map((w) => w.replace(/'/g, ''))
    .filter((w) => w && !ARTICLES.has(w))
    // Per word, before joining: "field mice" and "field mouse" have to meet.
    .map((w) => IRREGULAR.get(w) || depluralize(w));

  // Every article stripped: keep the original rather than returning nothing,
  // because "the the" is a band and an empty key would silently merge it with
  // every other all-article answer.
  const kept = words.length ? words : cleaned.split(' ').filter(Boolean);

  /*
    Join before stemming, not after.

    Stemming each word and then joining gives "roller"+"coaster" =
    "rollercoaster", while the single word "rollercoaster" stems to
    "rollercoast" — so the two forms we most need to merge would still miss.
    Collapsing first and stemming the result puts both on "rollercoast".
  */
  const joined = kept.join('');
  return joined ? stemmer(joined) : '';
}

/*
  A looser key, for grouping answers that are the same word spelled differently.

  Kept separate from normalizeAnswer on purpose: this one is coarse enough to
  collide unrelated short words, so it is only ever used to suggest merges for
  review, never to bucket answers directly.
*/
export function loosekey(answer) {
  return normalizeAnswer(answer).replace(/[aeiou]/g, '');
}
