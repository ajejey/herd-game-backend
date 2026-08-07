/**
 * Content bank invariants. No database, no browser — run it in a second.
 *
 *   node scripts/content-bank-check.js
 *
 * Written after a user reported the second half of a Taboo problem:
 *
 *   "the pool of words was quite small as we tried to do 2 games back-to-back
 *    but there were a lot of repeated words, so they became much easier"
 *
 * There were 80 cards and a single game consumes roughly 60, so a second game
 * replayed about three quarters of the same words. Nothing was broken; the game
 * just got boring, which no functional test can detect.
 *
 * Content sufficiency is a property of the DATA, so assert it against the data.
 * The rule below is: playing two full games back to back should repeat less than
 * REPEAT_LIMIT of the material.
 */
import { CARDS } from '../src/games/taboo/tabooCards.js';
import { GRIDS } from '../src/games/chameleon/words.js';
import { CATEGORIES, LETTERS } from '../src/games/scattergories/scattergoriesData.js';
import { questions as guesstimateQs } from '../src/games/guesstimate/questions.js';
import { questions as sayAnythingQs } from '../src/games/sayAnything/questions.js';
import { QUESTIONS as triviaQs } from '../src/games/teamtrivia/questions.js';
import { PROMPTS } from '../src/games/wouldyourather/wyrData.js';
import { KEYWORDS } from '../src/games/clover/keywords.js';
import { PAIRS } from '../src/games/wavelength/spectrums.js';

const REPEAT_LIMIT = 0.25; // at most a quarter repeated across two games

/**
 * bank      — the array of content
 * perGame   — roughly how many entries one full game consumes
 * key       — how to identify an entry, for duplicate detection
 */
const BANKS = [
  { name: 'Taboo cards',            bank: CARDS,         perGame: 60, key: (c) => (c.word || c.target || JSON.stringify(c)).toLowerCase() },
  { name: 'Chameleon grids',        bank: GRIDS,         perGame: 8,  key: (g) => JSON.stringify(g).slice(0, 120) },
  { name: 'Scattergories cats',     bank: CATEGORIES,    perGame: 12, key: (c) => String(c).toLowerCase() },
  { name: 'Guesstimate questions',  bank: guesstimateQs, perGame: 10, key: (q) => String(q.q || q.question || JSON.stringify(q)).toLowerCase() },
  { name: 'Say Anything questions', bank: sayAnythingQs, perGame: 10, key: (q) => String(q.q || q.text || JSON.stringify(q)).toLowerCase() },
  { name: 'Team Trivia questions',  bank: triviaQs,      perGame: 15, key: (q) => String(q.q || q.question || JSON.stringify(q)).toLowerCase() },
  { name: 'Would You Rather',       bank: PROMPTS,       perGame: 12, key: (p) => JSON.stringify(p).toLowerCase().slice(0, 120) },
  { name: 'Clover keywords',        bank: KEYWORDS,      perGame: 20, key: (k) => String(k).toLowerCase() },
  { name: 'Spectrum pairs',         bank: PAIRS,         perGame: 12, key: (p) => JSON.stringify(p).toLowerCase() },
];

let failures = 0;
const rows = [];

for (const { name, bank, perGame, key } of BANKS) {
  const list = Array.isArray(bank) ? bank : Object.values(bank || {}).flat();
  const size = list.length;

  // Two games need 2*perGame draws. Anything the bank cannot cover is a repeat.
  const needed = perGame * 2;
  const repeatRate = size >= needed ? 0 : (needed - size) / needed;

  const keys = list.map(key);
  const dupes = keys.length - new Set(keys).size;

  const minForTwoGames = Math.ceil(needed / (1 - REPEAT_LIMIT));
  const ok = repeatRate <= REPEAT_LIMIT && dupes === 0;
  if (!ok) failures++;

  rows.push({
    name,
    size,
    perGame,
    twoGameRepeat: `${(repeatRate * 100).toFixed(0)}%`,
    dupes,
    wantAtLeast: minForTwoGames,
    status: ok ? 'ok' : 'FAIL',
  });
}

const pad = (s, n) => String(s).padEnd(n);
console.log(pad('bank', 26) + pad('size', 7) + pad('per game', 10) + pad('2-game repeat', 15) + pad('dupes', 7) + pad('want >=', 9) + 'status');
console.log('-'.repeat(84));
for (const r of rows) {
  console.log(
    pad(r.name, 26) + pad(r.size, 7) + pad(r.perGame, 10) +
    pad(r.twoGameRepeat, 15) + pad(r.dupes, 7) + pad(r.wantAtLeast, 9) + r.status
  );
}

if (failures) {
  console.error(`\n${failures} bank(s) failed. A bank that cannot cover two back-to-back games`);
  console.error('makes the second game feel like a repeat — the exact complaint that came in');
  console.error('about Taboo on 4 Aug 2026.');
  process.exit(1);
}
console.log('\nAll content banks can cover two back-to-back games with under 25% repetition.');
