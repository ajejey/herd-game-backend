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
  Singular nouns that already end in "s".

  THE BUG THIS REPLACES, and it was a big one. There used to be a general rule
  here: any word ending in "-es" whose base ended in a sibilant had the "es"
  stripped before stemming. It existed to fix exactly three shapes — Porter
  turns "bus" into "bu" but "buses" into "buse", and the same for gas and lens.

  It fixed those three and broke every word ending in "-se". "horses" lost its
  "es" to that rule and then lost more to the stemmer, keying as "hor" while
  "horse" keyed as "hors". Measured over the 815-word Caveman bank, 14 words
  were affected; measured over English, it is every -se noun there is:

      horse/horses   house/houses   nurse/nurses   promise/promises
      suitcase/suitcases   bruise/bruises   eclipse/eclipses

  Daily Herd and Herd Mentality both bucket answers by this key, so a room where
  three people said "horse" and two said "horses" scored as two separate herds —
  in a game whose entire premise is matching the crowd. It is the same class of
  failure the plural handling was rewritten to remove, reintroduced by the fix.

  The measurement that settled it: the Porter stemmer ALONE already unifies
  horse/horses, house/houses, box/boxes, dish/dishes, glass/glasses and
  church/churches correctly. The only pairs it splits are singulars that end in
  a bare "s" — bus, gas, lens — because it reads that "s" as a plural marker.

  So the general rule is gone and those get a lookup instead, which is what the
  irregular map above already argues for: a short list earns its place where a
  clever algorithm cannot. Plural on the left, singular on the right; both then
  go through the stemmer together and land on the same key.
*/
const SINGULAR_S = new Map(Object.entries({
  buses: 'bus', busses: 'bus', gases: 'gas', gasses: 'gas', lenses: 'lens',
  viruses: 'virus', campuses: 'campus', circuses: 'circus', cactuses: 'cactus',
  atlases: 'atlas', biases: 'bias', canvases: 'canvas', choruses: 'chorus',
  bonuses: 'bonus', censuses: 'census', irises: 'iris', sinuses: 'sinus',
  statuses: 'status', focuses: 'focus', pluses: 'plus', minuses: 'minus',
  octopuses: 'octopus', walruses: 'walrus', platypuses: 'platypus',
  rhinoceroses: 'rhinoceros', hippopotamuses: 'hippopotamus',
  crocuses: 'crocus', abacuses: 'abacus', compasses: 'compass',
}));

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
    .map((w) => IRREGULAR.get(w) || SINGULAR_S.get(w) || w);

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

