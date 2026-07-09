/*
  Scattergories — letters, category bank, and scoring helpers.

  Classic "unique answers" online variant: each round picks a random letter and
  a set of categories; every player writes an answer starting with that letter
  for each category. An answer scores 1 point if it's non-empty, starts with the
  round letter, AND is unique among players for that category (duplicates cancel
  out — the fun tension of trying to be original but valid).
*/

// Exclude the traditionally-hard letters (Q, U, V, X, Y, Z) so rounds stay fun.
export const LETTERS = 'ABCDEFGHIJKLMNOPRSTW'.split('');

export const CATEGORIES = [
  'A boy’s name', 'A girl’s name', 'An animal', 'A country', 'A city',
  'Something in the kitchen', 'A food', 'A drink', 'A fruit or vegetable',
  'A movie title', 'A TV show', 'A song title', 'A band or musician',
  'A famous person', 'A cartoon character', 'A video game',
  'Something you’re afraid of', 'A hobby', 'A sport', 'A job or profession',
  'Something at the beach', 'Something cold', 'Something hot',
  'A school subject', 'A body part', 'An item of clothing',
  'A color', 'A brand', 'A car make or model', 'Something round',
  'Something that flies', 'A thing you keep secret', 'A reason to be late',
  'Something in a park', 'A board game', 'A holiday or festival',
  'Something in your bag', 'A superhero', 'A type of weather',
  'Something you shout', 'A word to describe your boss', 'Something in space',
  'A vacation spot', 'Something you recycle', 'An excuse to leave a party',
  'A thing that’s sticky', 'Something in a hospital', 'A pizza topping',
  'A thing with wheels', 'A mythical creature', 'Something you plug in',
  'A programming language', 'A thing on your desk', 'Something in the office',
  'A team-building activity', 'Something you do on Zoom', 'A river or lake',
  'An ice cream flavor', 'Something that smells nice', 'A dance move',
];

// mulberry32 seeded PRNG (deterministic where a seed is supplied)
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Pick a letter not already used this game (falls back to any once exhausted).
export function pickLetter(usedLetters = []) {
  const pool = LETTERS.filter((l) => !usedLetters.includes(l));
  const from = pool.length ? pool : LETTERS;
  return from[Math.floor(Math.random() * from.length)];
}

// Pick n distinct categories, avoiding ones used in recent rounds when possible.
export function pickCategories(n, usedCats = []) {
  const seed = (Date.now() ^ (usedCats.length * 2654435761)) >>> 0;
  const rand = mulberry32(seed);
  const pool = CATEGORIES.filter((c) => !usedCats.includes(c));
  const from = (pool.length >= n ? pool : [...CATEGORIES]);
  const a = [...from];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, n);
}

// Normalize for duplicate comparison: lowercase, trim, collapse spaces, drop a
// leading article so "the office" and "office" collide.
export function normalizeAnswer(s) {
  return String(s || '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/^(a|an|the)\s+/, '');
}

export function startsWithLetter(s, letter) {
  const t = String(s || '').trim();
  if (!t) return false;
  return t[0].toLowerCase() === String(letter).toLowerCase();
}
