#!/usr/bin/env node
/*
  Herd Mentality scoring — you score by matching the group.

  Written from a player report on 12 Aug 2026:

    "Two entries were exactly the same but didn't match."

  analyzeRoundAnswers awarded points only when ONE answer had the top count:

      majorityAnswers.length === 1 ? ...matching players... : []

  so any tie scored nobody. Three people said "food", three said "evangelism",
  and all six were shown "Tied" and zero — having each matched two other people
  exactly. Across 1,122 recent rounds, 32 threw away real agreement like that.

  The distinction that matters is between "several herds tied" (people DID
  match — pay them) and "everyone said something different" (nobody matched —
  pay nobody). Both are ties; only one is a non-result.

  Pure functions, no database and no server needed:
    node scripts/herd-scoring-check.js
*/
import { analyzeRoundAnswers } from '../src/utils/gameLogic.js';
import Answer from '../src/models/Answer.js';

let failures = 0;
const fail = (m) => { console.log(`  FAIL  ${m}`); failures += 1; };
const ok = (m) => console.log(`  ok    ${m}`);

/*
  analyzeRoundAnswers reads through the Answer model, so stub the one call it
  makes. Cheaper and far more legible than seeding Mongo, and it keeps this
  runnable on a laptop with nothing else started.
*/
const realFind = Answer.find;
function withAnswers(rows, fn) {
  Answer.find = async () => rows.map((r, i) => ({
    playerId: r.p || `p${i}`,
    username: r.p || `p${i}`,
    normalizedAnswer: r.n,
    originalAnswer: r.o ?? r.n,
  }));
  return fn().finally(() => { Answer.find = realFind; });
}

const names = (r) => (r.scoringPlayers || []).map(String).sort();

console.log('\n=== a tie between herds still pays everyone who matched ===');

await withAnswers(
  [{ p: 'a', n: 'food' }, { p: 'b', n: 'food' }, { p: 'c', n: 'food' },
   { p: 'd', n: 'evangelism' }, { p: 'e', n: 'evangelism' }, { p: 'f', n: 'evangelism' }],
  async () => {
    const r = await analyzeRoundAnswers('x');
    const got = names(r);
    if (got.join() !== 'a,b,c,d,e,f') fail(`3-3 tie: expected all six to score, got [${got}]`);
    else if (r.majorityAnswers.length !== 2) fail(`3-3 tie: expected 2 herds, got ${JSON.stringify(r.majorityAnswers)}`);
    else ok('3 vs 3 — all six score, both herds reported');
  },
);

await withAnswers(
  [{ p: 'a', n: 'soup' }, { p: 'b', n: 'soup' }, { p: 'c', n: 'jelly' }, { p: 'd', n: 'jelly' },
   { p: 'e', n: 'pudding' }],
  async () => {
    const r = await analyzeRoundAnswers('x');
    const got = names(r);
    if (got.join() !== 'a,b,c,d') fail(`2-2-1: expected the four who matched to score, got [${got}]`);
    else ok('2 vs 2 with a singleton — the four who matched score, the singleton does not');
  },
);

await withAnswers(
  [{ p: 'a', n: 'coffee' }, { p: 'b', n: 'coffee' }, { p: 'c', n: 'breakfast' }, { p: 'd', n: 'breakfast' },
   { p: 'e', n: 'eat' }, { p: 'f', n: 'eat' }, { p: 'g', n: 'poop' }],
  async () => {
    const r = await analyzeRoundAnswers('x');
    if (names(r).join() !== 'a,b,c,d,e,f') fail(`three-way tie: got [${names(r)}]`);
    else ok('three pairs tied — all six score (this exact round happened and paid nobody)');
  },
);

console.log('\n=== the genuine non-result still pays nobody ===');

await withAnswers(
  [{ p: 'a', n: 'read' }, { p: 'b', n: 'sleeping' }, { p: 'c', n: 'napping' }, { p: 'd', n: 'fortnight' }],
  async () => {
    const r = await analyzeRoundAnswers('x');
    if (names(r).length !== 0) fail(`all-different: nobody matched, but [${names(r)}] scored`);
    else if (r.majorityAnswers.length !== 0) fail('all-different: reported a herd that does not exist');
    else ok('everyone different — nobody scores, and no herd is claimed');
  },
);

console.log('\n=== the ordinary case is unchanged ===');

await withAnswers(
  [{ p: 'a', n: 'golf' }, { p: 'b', n: 'golf' }, { p: 'c', n: 'golf' }, { p: 'd', n: 'curling' }],
  async () => {
    const r = await analyzeRoundAnswers('x');
    if (names(r).join() !== 'a,b,c') fail(`clear majority: got [${names(r)}]`);
    else if (r.majorityAnswer !== 'golf') fail(`clear majority: majorityAnswer was ${r.majorityAnswer}`);
    else ok('a clear majority scores exactly as before, and still sets majorityAnswer');
  },
);

await withAnswers(
  [{ p: 'a', n: 'why' }, { p: 'b', n: 'why' }, { p: 'c', n: 'why' }, { p: 'd', n: 'why' }],
  async () => {
    const r = await analyzeRoundAnswers('x');
    if (names(r).join() !== 'a,b,c,d') fail(`unanimous: got [${names(r)}]`);
    else ok('unanimous — everyone scores');
  },
);

console.log('\n=== a round with one lone answer claims nothing ===');

await withAnswers(
  [{ p: 'a', n: 'soup' }],
  async () => {
    const r = await analyzeRoundAnswers('x');
    // Reachable: everyone else drops mid-round, so playersAnswered meets the
    // connected count with a single answer on the board.
    if (names(r).length !== 0) fail(`lone answer: nobody matched, but [${names(r)}] scored`);
    else if (r.majorityAnswer !== null) fail(`lone answer: reported "${r.majorityAnswer}" as the majority while paying nobody`);
    else if (r.majorityAnswers.length !== 0) fail('lone answer: claimed a herd');
    else ok('a single answer is not a majority — header and badge agree');
  },
);

console.log('\n=== the pink cow is unaffected ===');

await withAnswers(
  [{ p: 'a', n: 'soup' }, { p: 'b', n: 'soup' }, { p: 'c', n: 'jelly' }, { p: 'd', n: 'jelly' },
   { p: 'e', n: 'porridge' }],
  async () => {
    const r = await analyzeRoundAnswers('x');
    if (String(r.uniqueAnswerPlayer) !== 'e') fail(`pink cow should go to the lone odd answer, got ${r.uniqueAnswerPlayer}`);
    else ok('the single odd answer still takes the pink cow, tie or not');
  },
);

console.log(failures ? `\n${failures} FAILURE(S)\n` : '\nAll checks passed.\n');
process.exit(failures ? 1 : 0);
