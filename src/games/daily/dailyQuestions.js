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

export function getDailyQuestions(dayNumber, n = QUESTIONS_PER_DAY) {
  const rand = mulberry32((dayNumber + 1) * 2654435761);
  const idx = PREDEFINED_QUESTIONS.map((_, i) => i);
  // Seeded Fisher–Yates shuffle, then take the first n.
  for (let i = idx.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  return idx.slice(0, n).map((i) => ({ id: i, text: PREDEFINED_QUESTIONS[i] }));
}

export function isValidQuestionId(id) {
  return Number.isInteger(id) && id >= 0 && id < PREDEFINED_QUESTIONS.length;
}

export { QUESTIONS_PER_DAY };
