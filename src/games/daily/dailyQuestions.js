import { PREDEFINED_QUESTIONS } from '../../utils/constants.js';

/*
  Deterministic daily question selection.

  Every player worldwide gets the SAME set for a given day, derived purely from
  the day number — no per-day authoring, no DB. questionId is the index into the
  fixed PREDEFINED_QUESTIONS array (stable as long as the array is append-only).
*/

const QUESTIONS_PER_DAY = 5;
// Launch epoch (UTC midnight). dayNumber 0 = this date.
const EPOCH_MS = Date.UTC(2026, 5, 1); // 2026-06-01
const DAY_MS = 24 * 60 * 60 * 1000;

export function getDayNumber(now = Date.now()) {
  return Math.floor((now - EPOCH_MS) / DAY_MS);
}

// Seeded PRNG (mulberry32) so selection is reproducible from the day number.
function mulberry32(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/*
  Deal from a shuffled deck, do not re-shuffle every day.

  The original version shuffled all questions afresh for each day and took the
  first five. Each day was independent, so nothing stopped a question landing on
  day 79 and again on day 81 — random WITH replacement across days, when a daily
  game needs a deck.

  Measured on the 107-question bank before this change:

      3 days →   0 of 15 already seen
      5 days →   2 of 25   (8%)
      7 days →   7 of 35  (20%)
     14 days →  17 of 70  (24%)
     30 days →  68 of 150 (45%)

  A casual player never noticed. Someone who came back every day — exactly the
  habit the daily games exist to build — was seeing a repeat within a week and
  nearly half repeats within a month.

  Now: shuffle the whole bank once per CYCLE, and day N takes the next five
  cards off that deck. No question can recur until the deck is exhausted, which
  with 107 questions is 21 days. The remainder (107 - 21*5 = 2) is left on the
  table and differs each cycle, since each cycle shuffles with its own seed.

  Still fully deterministic from the day number, still no database, still the
  same set worldwide. Adding questions now extends the streak linearly — 200
  questions would give 40 clean days — whereas under the old scheme more
  questions barely moved the day-5 repeat.

  Only affects days from here on. Past days are not replayable and their results
  are rebuilt from the questionIds stored on the submission, so nothing already
  recorded changes meaning.
*/
// A whole deck for one cycle: every question, in a seeded order.
function rawDeck(cycle) {
  const rand = mulberry32((cycle + 1) * 2654435761);
  const idx = PREDEFINED_QUESTIONS.map((_, i) => i);
  for (let i = idx.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  return idx;
}

/*
  Days a question is guaranteed not to come back, even across a deck boundary.

  Within one deck no repeat is possible at all. The hole is the SEAM: a player
  who starts mid-deck gets the tail of one deck and then the head of the next,
  which is freshly shuffled and can legitimately re-serve what they saw days
  ago. Measured on the real bank, starting from today (day 79, sixteen days into
  a deck), that produced 12 repeats by day 14 — the guarantee only held for
  someone who happened to start on day one of a cycle, and real players arrive
  on whatever day they arrive.

  So the head of each deck is stitched to avoid the previous deck's tail.
*/
function deckFor(cycle, n) {
  const deck = rawDeck(cycle);

  /*
    The guard scales with the bank instead of being a fixed number of days.

    It was hardcoded at 7 because 107 questions could not support more — the
    stitch needs the guarded head and the guarded tail to be a small fraction of
    the deck, or there are not enough safe cards left to swap in. At 211 the
    same third of a cycle is 14 days, and adding questions from here widens the
    guarantee automatically rather than needing this constant revisited.
  */
  const perCycle = Math.floor(deck.length / n);
  const guardDays = Math.max(7, Math.floor(perCycle / 3));
  const guard = guardDays * n;
  if (guard * 2 >= deck.length) return deck; // bank too small to stitch usefully

  /*
    The tail that matters is the last `guard` cards the previous cycle actually
    SERVED, not the last cards of the array. A deck of 211 only deals 42*5 = 210,
    so slicing from `length - guard` starts one card late and leaves the first
    card of the guarded window unguarded. Off by one, invisible, and it would
    quietly let one question return inside the window we promise it will not.
  */
  const prev = rawDeck(cycle - 1);
  const served = perCycle * n;
  const prevTail = new Set(prev.slice(Math.max(0, served - guard), served));

  // Push any card that appeared in the previous deck's tail out of this deck's
  // head, swapping it with the first card further down that is safe. Purely
  // deterministic, so every player still sees the same thing.
  for (let i = 0; i < guard; i++) {
    if (!prevTail.has(deck[i])) continue;
    for (let j = guard; j < deck.length; j++) {
      if (!prevTail.has(deck[j])) {
        const tmp = deck[i];
        deck[i] = deck[j];
        deck[j] = tmp;
        break;
      }
    }
  }
  return deck;
}

export function getDailyQuestions(dayNumber, n = QUESTIONS_PER_DAY) {
  const total = PREDEFINED_QUESTIONS.length;
  if (total === 0) return [];

  const perCycle = Math.max(1, Math.floor(total / n)); // whole days per deck
  // Floor division that also behaves for days before the epoch, where a plain
  // % would go negative and index off the front of the deck.
  const cycle = Math.floor(dayNumber / perCycle);
  const offset = ((dayNumber % perCycle) + perCycle) % perCycle;

  const deck = deckFor(cycle, n);
  const start = offset * n;
  return deck.slice(start, start + n).map((i) => ({ id: i, text: PREDEFINED_QUESTIONS[i] }));
}

export function isValidQuestionId(id) {
  return Number.isInteger(id) && id >= 0 && id < PREDEFINED_QUESTIONS.length;
}

export { QUESTIONS_PER_DAY };
