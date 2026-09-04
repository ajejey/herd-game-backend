/*
  A reaction time test must measure a reaction.

    node scripts/reaction-rules-check.js

  ── The report ──────────────────────────────────────────────────────────────
  Sep 2026: a player kept tapping through the "wait" and was shown reaction
  times like 20ms the instant the pad turned green. Tapping DURING the wait was
  already caught. A tap already in flight when the pad turned green was not —
  the browser queues the click, the hold timer fires and marks the start, and
  the queued click arrives twenty milliseconds later and is measured as though
  she had seen the change and responded.

  ── Why this is a check script and not only an e2e ──────────────────────────
  It was written as an e2e first, driving a real browser and hammering the pad.
  That test PASSED with the guard removed. Playwright's per-click overhead means
  the taps never arrive close enough together to reach the green state at all,
  so it asserted over an empty list of observed times and reported success —
  the same vacuous-pass this repo has been bitten by before. The exploit is a
  race between an event-queue delivery and a timer, and a browser driver cannot
  be made to win it on demand.

  So the decision is a pure function in frontend/src/lib/reactionRules.mjs, and
  this asserts it directly with the exact numbers involved. The .mjs extension
  is what lets this file import the SHIPPING code rather than a copy: node reads
  .mjs as ESM regardless of the frontend's package.json.

  The e2e (e2e/tests/reaction-cheat.spec.js) is kept as a smoke test that the
  page still plays and explains itself. It is not the guard, and its comment
  says so.
*/
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FE = path.join(HERE, '..', '..', 'frontend', 'src');

const rules = await import(pathToFileURL(path.join(FE, 'lib', 'reactionRules.mjs')).href);
const { classifyTap, MIN_HUMAN_MS, ALREADY_TAPPING_MS } = rules;

let failures = 0;
const fail = (m, d = '') => { console.log(`  FAIL  ${m}${d ? ' — ' + d : ''}`); failures += 1; };
const ok = (m) => console.log(`  ok    ${m}`);
const is = (m, c, d = '') => (c ? ok(m) : fail(m, d));

console.log('');
console.log('=== a reaction time test measures a reaction ===');

/* A relaxed gap between taps, so only the `ms` rule is under test. */
const CALM = 5000;

/*
  ── The reported number ─────────────────────────────────────────────────────
  20ms after the signal, arriving 30ms after her previous tap. Both rules should
  reject it; this is the exact case a player was shown.
*/
is('the 20ms tap that was reported is refused', classifyTap(20, 30) !== 'score',
  `classifyTap(20, 30) returned ${classifyTap(20, 30)}`);

/* ── The human floor ─────────────────────────────────────────────────────── */
for (const ms of [0, 1, 17, 42, 99]) {
  is(`${String(ms).padStart(3)}ms is not a human reaction`, classifyTap(ms, CALM) === 'tooFast',
    `got ${classifyTap(ms, CALM)}`);
}
is('...and the boundary itself is allowed, not off by one',
  classifyTap(MIN_HUMAN_MS, CALM) === 'score',
  `${MIN_HUMAN_MS}ms returned ${classifyTap(MIN_HUMAN_MS, CALM)}`);

/*
  ── Drumming ────────────────────────────────────────────────────────────────
  The rule that catches the actual behaviour. These times are all perfectly
  plausible on their own — that is the point. Someone tapping continuously will
  produce a "150ms reaction" by arithmetic, not by reacting, and scoring it is
  what made the game feel fake.
*/
for (const [ms, gap] of [[150, 90], [200, 120], [260, 300], [399, 399]]) {
  is(`${ms}ms is refused when the previous tap was ${gap}ms earlier`,
    classifyTap(ms, gap) === 'drumming', `got ${classifyTap(ms, gap)}`);
}
is('...and a deliberate tap after a pause scores',
  classifyTap(260, ALREADY_TAPPING_MS) === 'score',
  `got ${classifyTap(260, ALREADY_TAPPING_MS)}`);

/* ── Ordinary play is untouched, which is the other half of the job ───────── */
for (const ms of [180, 226, 250, 340, 900, 2346]) {
  is(`a real ${ms}ms reaction still scores`, classifyTap(ms, CALM) === 'score',
    `got ${classifyTap(ms, CALM)}`);
}

/*
  The very first tap of a game has no previous tap. Whatever the hook passes for
  "no previous tap" — Infinity, or a huge number from a zeroed ref — must not be
  read as drumming, or round one could never be scored.
*/
is('the first tap of a game is not treated as drumming',
  classifyTap(250, Infinity) === 'score' && classifyTap(250, Number.MAX_SAFE_INTEGER) === 'score');
is('...and rubbish input fails closed rather than scoring',
  classifyTap(NaN, CALM) === 'tooFast' && classifyTap(undefined, CALM) === 'tooFast');

/* ── The game actually uses it ────────────────────────────────────────────── */
{
  const hook = fs.readFileSync(path.join(FE, 'components', 'reaction', 'useReactionTime.js'), 'utf8');
  is('the game routes its taps through this rule',
    /classifyTap\(ms, sincePrevTap\)/.test(hook),
    'useReactionTime does not call classifyTap — the rule exists but is not applied');
  is('...and voids the round rather than recording it',
    /verdict !== 'score'[\s\S]{0,200}setStatus\('early'\)/.test(hook),
    'a refused tap must not reach setTimes');
  /* The player has to be told which of the three it was, or "too early" on a
     tap that came after green reads as a bug of its own. */
  const ui = fs.readFileSync(path.join(FE, 'components', 'reaction', 'ReactionTime.js'), 'utf8');
  is('...and tells the player why', /EARLY_COPY/.test(ui) && /already tapping/i.test(ui));
}

console.log('');
if (failures) { console.log(`reaction rules — ${failures} problem(s)\n`); process.exit(1); }
console.log('reaction rules — no impossible number ever reaches a player\n');
process.exit(0);
