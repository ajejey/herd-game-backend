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
import { analyzeRoundAnswers, checkWinCondition, findWinner } from '../src/utils/gameLogic.js';
import Answer from '../src/models/Answer.js';
import mongoose from 'mongoose';

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

/*
  ── the win rule ──────────────────────────────────────────────────────────────

  8 points AND not holding the pink cow. checkWinCondition owned that rule,
  compared `player._id !== pinkCowHolder` — an ObjectId against the string the
  holder is stored as, which is NEVER equal — and would therefore have called
  the cow holder a winner. It never shipped only because nothing called it:
  index.js wrote the rule out by hand in three separate handlers instead.

  The ObjectId case is the one that matters and it is the one a plain-string
  test would miss, so these use real ObjectIds.
*/
console.log('\n=== the win rule: 8 points and not holding the cow ===');

const oid = () => new mongoose.Types.ObjectId();
const P = (id, score) => ({ _id: id, username: String(id).slice(-4), score });

{
  const cow = oid();
  const player = P(cow, 9);
  if (checkWinCondition(player, cow.toString())) {
    fail('the cow holder was declared a winner (ObjectId vs string compared as unequal)');
  } else {
    ok('9 points while holding the cow does not win, comparing ObjectId to stored string');
  }
}

{
  const a = oid(), b = oid();
  if (!checkWinCondition(P(a, 8), b.toString())) fail('8 points without the cow should win');
  else ok('exactly 8 points without the cow wins');
}

{
  const a = oid(), b = oid();
  if (checkWinCondition(P(a, 7), b.toString())) fail('7 points should not win');
  else ok('7 points does not win, cow or no cow');
}

{
  // Nobody holds it — the "Nobody" button, and every game before the first
  // odd answer. A null holder must not accidentally match a player.
  const a = oid();
  if (!checkWinCondition(P(a, 8), null)) fail('nobody holding the cow should not block a winner');
  else if (!checkWinCondition(P(a, 8), undefined)) fail('an undefined holder should not block a winner');
  else ok('with the cow on nobody, 8 points wins');
}

{
  const cow = oid(), other = oid(), low = oid();
  const players = [P(cow, 12), P(other, 8), P(low, 3)];
  const w = findWinner(players, cow.toString());
  if (!w) fail('findWinner found nobody when an 8-point player was free of the cow');
  else if (String(w._id) !== String(other)) fail(`findWinner picked the cow holder (${w.score} pts) over the eligible player`);
  else ok('the highest scorer is skipped when they hold the cow, and the next eligible one wins');
}

{
  const cow = oid();
  const w = findWinner([P(cow, 15), P(oid(), 2)], cow.toString());
  if (w) fail(`a lone leader holding the cow was declared the winner with ${w.score} points`);
  else ok('a lone leader holding the cow wins nothing — the deadlock the host now breaks by hand');
}

{
  const a = oid(), b = oid();
  const w = findWinner([P(a, 9), P(b, 11)], null);
  if (!w || String(w._id) !== String(b)) fail('findWinner did not pick the highest eligible score');
  else ok('the highest eligible score wins');
}

if (findWinner([], null) !== null) fail('an empty room produced a winner');
else ok('no players, no winner');

console.log(failures ? `\n${failures} FAILURE(S)\n` : '\nAll checks passed.\n');
process.exit(failures ? 1 : 0);
