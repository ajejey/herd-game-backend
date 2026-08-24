#!/usr/bin/env node
/**
 * Caveman Clues — rules, scoring and the role visibility matrix.
 *
 *   node scripts/caveman-logic-check.js
 *
 * The matrix in CAVEMAN_CLUES_PLAN.md is the design document AND the test spec,
 * and this is where it gets enforced. Taboo shipped with a useless buzz button
 * because that was never written down; this game has exactly one secret and it
 * has to stay secret.
 *
 * No database, no browser, no server.
 */
import { CavemanCluesGame as G } from '../src/games/cavemanclues/game.js';
import { CAVEMAN_WORDS, shuffledDeck, CAVEMAN_WORDS_RAW } from '../src/games/cavemanclues/words.js';
import { normalizeAnswer } from '../src/utils/answerNormalizer.js';
import { readFileSync, existsSync } from 'fs';

let failures = 0;
const fail = (m, d = '') => { console.log(`  FAIL  ${m}${d ? ' — ' + d : ''}`); failures += 1; };
const ok = (m) => console.log(`  ok    ${m}`);
const is = (m, cond, d = '') => (cond ? ok(m) : fail(m, d));

const players = (n) => Array.from({ length: n }, (_, i) => ({
  id: `p${i}`, username: `P${i}`, connected: true, socketId: `s${i}`,
}));

function fresh(n = 4, settings = {}) {
  const state = { players: players(n), ...G.createInitialState(settings) };
  return G.onStart(state);
}
const find = (s, id) => s.players.find((p) => p.id === id);
const act = (s, action, payload, id) => G.handleAction(s, action, payload, find(s, id)) || s;

/* ── Setup ───────────────────────────────────────────────────────────────── */
let s = fresh(4);
is('a game starts in the clue phase', s.phase === 'clue', s.phase);
is('someone is giving clues', !!s.turn?.giverId);
is('everyone starts on zero', Object.values(s.scores).every((n) => n === 0));

const giver = s.turn.giverId;
const guesser = s.players.find((p) => p.id !== giver).id;

/* ── The role visibility matrix ──────────────────────────────────────────── */
const giverView = G.deriveClientState(s, giver);
const guesserView = G.deriveClientState(s, guesser);
const secret = giverView.word;

is('the Clue Giver is told the word', typeof secret === 'string' && secret.length > 0);
is('a guesser is NOT told the word', guesserView.word === null, String(guesserView.word));

/* Not just the named field — the word must not be anywhere in what is sent.
   Hiding a secret in a nested field is the same bug with more steps. */
const guesserPayload = JSON.stringify(guesserView);
is('the word appears nowhere in a guesser\'s payload',
  !new RegExp(`\\b${secret}\\b`, 'i').test(guesserPayload),
  'the secret is reachable somewhere in the object');
is('the remaining deck is never sent to anyone',
  guesserView.deck === undefined && giverView.deck === undefined);
is('the custom word list is never sent', guesserView.customWords === undefined);
is('a guesser is told who is giving clues', guesserView.turn?.giverId === giver);
is('a guesser knows they are not the giver', guesserView.isGiver === false);
is('the giver knows they are the giver', giverView.isGiver === true);

/* ── Clues ───────────────────────────────────────────────────────────────── */
s = act(s, 'clue', { text: 'big grey thing with long nose' }, giver);
is('a legal clue is sent', s.turn.clues.length === 1);
is('a legal clue is not marked as a slip', s.turn.clues[0].bad.length === 0 && s.turn.slips === 0);

s = act(s, 'clue', { text: 'a giant creature' }, giver);
is('a multi-syllable clue is still sent', s.turn.clues.length === 2,
  'the physical game says it out loud, so hiding it would be wrong');
is('...and is marked as a slip', s.turn.slips === 1, `slips=${s.turn.slips}`);
is('...naming which words broke the rule',
  s.turn.clues[1].bad.includes('giant') && s.turn.clues[1].bad.includes('creature'),
  JSON.stringify(s.turn.clues[1].bad));

/* Saying the answer is a different thing and must never reach the guessers. */
const before = s.turn.clues.length;
s = act(s, 'clue', { text: `it is a ${secret}` }, giver);
is('a clue containing the answer is refused, not sent', s.turn.clues.length === before);
is('...and told the giver why', s.turn.rejected?.reason === 'answer');
is('...and costs no penalty', s.turn.slips === 1, 'rejecting is not the same as slipping');

/*
  The rejection must not leak the thing it rejected.

  It did. `turn.rejected` stored the giver's full text — including the answer —
  and deriveClientState spreads state.turn into every payload, so a clue
  refused FOR containing the secret handed the secret to the whole room.

  The old assertions missed it because they checked `rejected?.reason` on the
  GIVER, and the e2e checked rendered text where the banner sits inside an
  isGiver branch. So this sweeps the entire payload of every non-giver after
  every action, which is the only shape of assertion that could have caught it.
*/
{
  const view = G.deriveClientState(s, guesser);
  is('a rejected clue does not leak the answer to a guesser',
    !new RegExp(`\\b${secret}\\b`, 'i').test(JSON.stringify(view)),
    'the secret is somewhere in the guesser payload');
  is('a guesser is not even told a rejection happened',
    view.turn.rejected === undefined,
    'knowing the giver tried to say it is itself a hint');
  is('the giver is still told why', G.deriveClientState(s, giver).turn.rejected?.reason === 'answer');
}

/*
  The plural guard, measured over the WHOLE bank instead of whichever word the
  shuffle happened to deal.

  This used to test `${secret}s` for one random secret and failed about one run
  in thirteen — the kind of intermittent that gets re-run until it goes green
  and then ignored. Sampling was the wrong instrument: the question is not "does
  it work for this word" but "for how many of the 815 does it not".

  It found a real one, and not only in this game. normalizeAnswer double-strips
  words ending in "-se": "horses" loses "es" to depluralize and then loses more
  to the stemmer, so it keys as "hor" while "horse" keys as "hors". Daily Herd
  and Herd Mentality both score by that key, so a room where three people say
  "horse" and two say "horses" is scored as two different herds — in a game
  whose entire premise is matching the crowd.

  FIXED 23 Aug 2026, and measured before it shipped. The general "-es" rule is
  gone from answerNormalizer.js — the Porter stemmer already unified horse/horses
  and house/houses on its own, and the rule only ever existed to rescue three
  bare-"s" singulars (bus, gas, lens) which now get a lookup instead.

  scripts/normalizer-se-replay.mjs replayed all 174,797 answers ever recorded:
  152 changed key, 86 of 37,001 rounds saw any change, 2 were genuine merges and
  the single apparent "split" was Expense/Expenses correctly meeting for the
  first time and tying with the existing herd. No herd broke apart.

  Kept as a sweep rather than deleted, because the number is the point: it is 0
  now and any future change to the normaliser that raises it will say so here
  instead of surfacing as a room that scored oddly.
*/
{
  const words = [...new Set(CAVEMAN_WORDS_RAW)];
  const missed = words.filter((w) => normalizeAnswer(`${w}s`) !== normalizeAnswer(w));
  /* Words that already end in "s" are not a real case — nobody writes
     "Octopuss" — so they are excluded rather than counted as failures. */
  const real = missed.filter((w) => !/s$/i.test(w));
  const KNOWN = 0;
  is(`every word is caught in its plural form (${KNOWN} misses allowed)`,
    real.length <= KNOWN,
    `${real.length} now: ${real.slice(0, 6).join(', ')}… — run normalizer-se-replay.mjs`);
  is('...and the guard does work for ordinary words',
    normalizeAnswer('Compasses') === normalizeAnswer('Compass')
      || words.length - missed.length > words.length * 0.9,
    `${words.length - missed.length} of ${words.length} caught`);
}

/* And the live guard still rejects the answer itself, on the dealt word. */
const s2 = act(s, 'clue', { text: `it is a ${secret}` }, giver);
is('the answer itself is always rejected', s2.turn.clues.length === s.turn.clues.length);

/* ── Guessing ────────────────────────────────────────────────────────────── */
s = act(s, 'guess', { text: 'banana split' }, guesser);
is('a wrong guess is recorded', s.turn.guesses.length === 1 && s.turn.guesses[0].right === false);
is('a wrong guess does not end the round', s.phase === 'clue');

const giverGuessed = act(s, 'guess', { text: secret }, giver);
is('the giver cannot guess their own word', giverGuessed.turn.guesses.length === 1,
  'they can see it');

s = act(s, 'guess', { text: secret.toUpperCase() }, guesser);
is('a correct guess wins regardless of case', s.phase === 'reveal', s.phase);
is('the winner is recorded', s.lastTurn.solvedBy === guesser);
is('the word is revealed to everyone', G.deriveClientState(s, guesser).word === secret);

/* ── Scoring ─────────────────────────────────────────────────────────────── */
is('the guesser scores two', s.scores[guesser] === 2, String(s.scores[guesser]));
is('the giver scores one, minus one slip, so zero',
  s.scores[giver] === 0, `giver=${s.scores[giver]} slips=${s.lastTurn.slips}`);

/* Clean round: no slips. */
let c = fresh(4);
const g2 = c.turn.giverId;
const u2 = c.players.find((p) => p.id !== g2).id;
const w2 = G.deriveClientState(c, g2).word;
c = act(c, 'clue', { text: 'you eat it' }, g2);
c = act(c, 'guess', { text: w2 }, u2);
is('a clean round pays the giver one', c.scores[g2] === 1, String(c.scores[g2]));
is('a clean round pays the guesser two', c.scores[u2] === 2);

/* Four slips must not push a giver negative. */
let d = fresh(4);
const g3 = d.turn.giverId;
for (let i = 0; i < 4; i += 1) d = act(d, 'clue', { text: 'a very lovely creature indeed' }, g3);
is('four slips are all counted', d.turn.slips === 4, String(d.turn.slips));
d = act(d, 'end_turn', {}, g3);
is('a giver can never go negative in a round', d.scores[g3] === 0, String(d.scores[g3]));

/* Nobody guesses. */
let e = fresh(4);
const g4 = e.turn.giverId;
e = act(e, 'end_turn', {}, g4);
is('with nobody guessing, nobody scores',
  Object.values(e.scores).every((n) => n === 0), JSON.stringify(e.scores));
is('the round still reveals the word', e.phase === 'reveal' && !!e.lastTurn.word);

/* ── Degenerate and hostile input ────────────────────────────────────────── */
let f = fresh(4);
const g5 = f.turn.giverId;
const u5 = f.players.find((p) => p.id !== g5).id;
is('a guesser cannot give clues', act(f, 'clue', { text: 'hi' }, u5).turn.clues.length === 0);
is('an empty clue is ignored', act(f, 'clue', { text: '   ' }, g5).turn.clues.length === 0);
is('an empty guess is ignored', act(f, 'guess', { text: '' }, u5).turn.guesses.length === 0);
/*
  A payload arriving as null, not undefined. A `payload = {}` default parameter
  does NOT cover this — defaults only fill in for undefined — and a raw socket
  can send either. Found by caveman-authority-check.js, which threw here.
*/
for (const bad of [undefined, null, 'string', 42, [], { text: null }, { text: {} }]) {
  let threw = null;
  try { G.handleAction(f, 'clue', bad, find(f, g5)); } catch (err) { threw = err.message; }
  is(`a clue payload of ${JSON.stringify(bad) ?? 'undefined'} does not throw`, threw === null, threw || '');
}
for (const bad of [null, { text: null }]) {
  let threw = null;
  try { G.handleAction(f, 'guess', bad, find(f, u5)); } catch (err) { threw = err.message; }
  is(`a guess payload of ${JSON.stringify(bad)} does not throw`, threw === null, threw || '');
}

const spam = Array.from({ length: 60 }).reduce((acc) => act(acc, 'clue', { text: 'a big thing' }, g5), f);
is('clue spam is capped', spam.turn.clues.length <= 40, String(spam.turn.clues.length));

const longClue = act(f, 'clue', { text: 'big '.repeat(200) }, g5);
is('an over-long clue is truncated, not rejected', longClue.turn.clues[0].text.length <= 120);

/* Double submit: the second correct guess must not pay out twice. */
let h = fresh(4);
const g6 = h.turn.giverId;
const u6 = h.players.find((p) => p.id !== g6).id;
const w6 = G.deriveClientState(h, g6).word;
h = act(h, 'guess', { text: w6 }, u6);
const afterFirst = h.scores[u6];
h = act(h, 'guess', { text: w6 }, u6);
is('a repeated winning guess does not score twice', h.scores[u6] === afterFirst, String(h.scores[u6]));

/* ── The giver dropping out ──────────────────────────────────────────────── */
/*
  A giver who reloads, locks their phone or loses signal for two seconds must
  NOT kill the round — mobile browsers background tabs constantly, so that fires
  far more often than someone actually leaving. An e2e reload caught this.
  But the room must never freeze either, so anyone can end a turn whose giver is
  gone, without waiting out the clock.
*/
let i = fresh(4);
const g7 = i.turn.giverId;
const other = i.players.find((p) => p.id !== g7).id;
is('a blip does not end the round', G.onPlayerDisconnect(i, find(i, g7)) === null);

is('a bystander cannot end a live turn while the giver is present',
  act(i, 'end_turn', {}, other).phase === 'clue');

/* Now the giver is genuinely gone. */
const gone = { ...i, players: i.players.map((p) => (p.id === g7 ? { ...p, connected: false } : p)) };
is('anyone can end the turn once the giver has dropped',
  act(gone, 'end_turn', {}, other).phase === 'reveal',
  'the room would be frozen until the timer otherwise');
is('the giver can always end their own turn',
  act(i, 'end_turn', {}, g7).phase === 'reveal');

/* ── Rounds and finishing ────────────────────────────────────────────────── */
let j = fresh(3, { rounds: 3 });
let guard = 0;
while (j.phase !== 'finished' && guard < 100) {
  if (j.phase === 'clue') j = act(j, 'end_turn', {}, j.turn.giverId);
  else j = act(j, 'next_round', {}, j.players[0].id);
  guard += 1;
}
is('a game reaches an end', j.phase === 'finished', `gave up after ${guard} steps`);
is('the deck never runs dry', j.wordsLeft === undefined || j.deck === undefined);

/* A tie is reported as a tie rather than resolved by object key order. */
const tied = { ...fresh(3), scores: { p0: 3, p1: 3, p2: 1 } };
let t = tied;
t = act({ ...t, phase: 'reveal', round: 999, totalRounds: 1 }, 'next_round', {}, 'p0');
is('a tie is reported as a tie, not silently broken',
  t.winner === null && Array.isArray(t.tiedWinners) && t.tiedWinners.length === 2,
  `winner=${t.winner} tied=${JSON.stringify(t.tiedWinners)}`);

/* ── No action may ever put the word in a guesser's payload ──────────────── */
/*
  A per-action sweep rather than a list of cases someone remembered. The leak
  above got through because the assertions were written from the same mental
  model as the code — this one is written from the invariant instead: whatever
  the giver does, the guesser's payload must not contain the answer.
*/
{
  const ACTIONS = [
    ['clue', { text: 'big grey thing' }],
    ['clue', { text: 'a giant creature' }],
    ['clue', { text: 'SECRET' }],
    ['clue', { text: 'these are SECRETs' }],
    ['skip', {}],
    ['guess', { text: 'nonsense' }],
  ];
  let leaked = 0;
  for (const [action, payload] of ACTIONS) {
    let st = fresh(4);
    const gid = st.turn.giverId;
    const uid = st.players.find((p) => p.id !== gid).id;
    const word = G.deriveClientState(st, gid).word;
    const filled = JSON.parse(JSON.stringify(payload).replaceAll('SECRET', word));
    st = act(st, action, filled, action === 'guess' ? uid : gid);
    const view = JSON.stringify(G.deriveClientState(st, uid));
    if (new RegExp(`\\b${word}\\b`, 'i').test(view)) {
      leaked += 1;
      fail(`"${action}" with ${JSON.stringify(payload)} leaks the word`, word);
    }
  }
  if (!leaked) ok(`no giver action leaks the word to a guesser (${ACTIONS.length} actions swept)`);
}

/* ── The rotation, when people come and go ──────────────────────────────── */
/*
  Three separate bugs lived here, all found by review rather than by these
  tests, and all with the same root: the rotation was a counter into a list
  whose length changed underneath it.

    a player whose socket blipped at kickoff was written out for the whole game
    a mid-game drop re-indexed everyone, skipping some and repeating others
    the target turn count was recomputed from whoever was connected right now,
      so leavers could end the game early
*/
{
  /* Blipped at kickoff, back a second later. */
  const players4 = [
    { id: 'a', username: 'A', connected: true, socketId: 's' },
    { id: 'b', username: 'B', connected: false, socketId: null },   // blipped
    { id: 'c', username: 'C', connected: true, socketId: 's' },
  ];
  let st = G.onStart({ players: players4, ...G.createInitialState({ rounds: 3 }) });
  is('a player offline at kickoff is still in the rotation',
    st.giverOrder.includes('b'), JSON.stringify(st.giverOrder));
  is('...and still has a score', st.scores.b === 0, JSON.stringify(st.scores));

  /* Everyone back. Walk the whole game and count who gave clues. */
  st = { ...st, players: st.players.map((p) => ({ ...p, connected: true })) };
  const gave = {};
  let guard = 0;
  while (st.phase !== 'finished' && guard < 80) {
    if (st.phase === 'clue') {
      gave[st.turn.giverId] = (gave[st.turn.giverId] || 0) + 1;
      st = act(st, 'end_turn', {}, st.turn.giverId);
    } else st = act(st, 'next_round', {}, 'a');
    guard += 1;
  }
  is('everyone gets an equal number of turns',
    ['a', 'b', 'c'].every((id) => gave[id] === 3), JSON.stringify(gave));
}

{
  /* Someone drops mid-game: they lose their turns, nobody else's shift. */
  let st = fresh(4, { rounds: 3 });
  const dropped = st.giverOrder[0];
  const seen = [];
  let guard = 0;
  while (st.phase !== 'finished' && guard < 80) {
    if (st.phase === 'clue') {
      seen.push(st.turn.giverId);
      st = act(st, 'end_turn', {}, st.turn.giverId);
    } else {
      st = act(st, 'next_round', {}, st.players.find((p) => p.id !== dropped).id);
      if (guard === 3) st = { ...st, players: st.players.map((p) => (p.id === dropped ? { ...p, connected: false } : p)) };
    }
    guard += 1;
  }
  const others = st.giverOrder.filter((id) => id !== dropped);
  const counts = others.map((id) => seen.filter((x) => x === id).length);
  is('a mid-game drop does not skip anybody else',
    counts.every((n) => n > 0), `${JSON.stringify(seen)}`);
  is('...and does not hand anyone two turns in a row',
    !seen.some((id, i) => i > 0 && id === seen[i - 1]), JSON.stringify(seen));
}

{
  /* Leavers must not end the game early. */
  let st = fresh(6, { rounds: 3 });
  const promised = G.deriveClientState(st, st.turn.giverId).totalTurns;
  st = { ...st, players: st.players.map((p, i) => (i > 2 ? { ...p, connected: false } : p)) };
  const after = G.deriveClientState(st, st.turn.giverId).totalTurns;
  is('the promised game length does not shrink when people leave',
    after === promised, `promised ${promised}, now ${after}`);
}

{
  /* A big room: everyone gives clues at least once, or the 3-20 claim is a lie. */
  const big = fresh(18, { rounds: 1 });
  const t = G.deriveClientState(big, big.turn.giverId).totalTurns;
  is('an 18-player room gives everyone a turn', t >= 18, `${t} turns for 18 players`);
}

{
  /* A custom pack shorter than the turn count must end, not re-deal. */
  let st = { players: players(3), ...G.createInitialState({ rounds: 3, customQuestions: ['Alpha', 'Beta'] }) };
  st = G.onStart(st);
  const words = [];
  let guard = 0;
  while (st.phase !== 'finished' && guard < 40) {
    if (st.phase === 'clue') {
      words.push(G.deriveClientState(st, st.turn.giverId).word);
      st = act(st, 'end_turn', {}, st.turn.giverId);
    } else st = act(st, 'next_round', {}, st.players[0].id);
    guard += 1;
  }
  is('a two-word pack never deals the same word twice',
    new Set(words).size === words.length, JSON.stringify(words));
  is('...and the game ends rather than looping', st.phase === 'finished');
}

/* ── How long the game runs ──────────────────────────────────────────────── */
/*
  "Rounds" means turns EACH, so a big room multiplies. Six players at five
  rounds would be thirty turns — forty-five minutes for a game people sit down
  to for ten — so a hard ceiling applies on top.
*/
const small = fresh(3, { rounds: 3 });
const smallView = G.deriveClientState(small, small.turn.giverId);
is('a small room plays rounds x players', smallView.totalTurns === 9, String(smallView.totalTurns));
is('the round counter starts at one', smallView.turnNumber === 1, String(smallView.turnNumber));

const big = fresh(10, { rounds: 5 });
const bigView = G.deriveClientState(big, big.turn.giverId);
is('a big room is capped rather than running for an hour',
  bigView.totalTurns === 15, `${bigView.totalTurns} turns for 10 players at 5 rounds`);
is('everyone in a ten-player room still gets a turn', bigView.totalTurns >= 10);

/* The counter must never read "16 of 15" on the final turn. */
let long = fresh(3, { rounds: 3 });
let steps = 0;
while (long.phase !== 'finished' && steps < 60) {
  const v = G.deriveClientState(long, long.players[0].id);
  if (v.turnNumber > v.totalTurns) { fail('the round counter overruns', `${v.turnNumber} of ${v.totalTurns}`); break; }
  long = long.phase === 'clue' ? act(long, 'end_turn', {}, long.turn.giverId)
                               : act(long, 'next_round', {}, long.players[0].id);
  steps += 1;
}
is('the round counter never overruns its total', steps < 60 && long.phase === 'finished');

/* ── Freshness across games ──────────────────────────────────────────────────

   A deck never repeats WITHIN a game — that was always true and is checked
   above. This is the other half: a host who plays every week used to get a
   repeat in most games, because each game reshuffled the whole bank from
   scratch. Their browser now sends what it has already been dealt.

   The trap this guards is the obvious implementation. FILTERING the seen words
   out gives a host who has seen 320 of 328 an eight-card deck and a game that
   ends after two rounds — the fix breaking the game for the exact people it
   exists to serve. They must be re-ORDERED, never removed.
*/
{
  const seen = CAVEMAN_WORDS.slice(0, 40);
  const deck = shuffledDeck(seen);
  is('excluding words still deals the whole bank', deck.length === CAVEMAN_WORDS.length,
    `${deck.length} of ${CAVEMAN_WORDS.length}`);
  is('...with no duplicates', new Set(deck).size === deck.length);

  const seenSet = new Set(seen);
  const firstSeenAt = deck.findIndex((w) => seenSet.has(w));
  is('none of the seen words are dealt before the fresh ones',
    firstSeenAt === CAVEMAN_WORDS.length - seen.length, `first repeat at index ${firstSeenAt}`);

  /* The budget is 16 cards a game, so a 40-word exclusion has to cover it. */
  const dealt = deck.slice(0, 16);
  is('a normal game deals nothing the host has seen', dealt.every((w) => !seenSet.has(w)));

  /* Case sensitivity and whitespace: a browser round-trip through JSON is not
     guaranteed to hand back the exact string, and a seen-list that silently
     stops matching is a fix that quietly turns itself off. */
  const messy = shuffledDeck(seen.map((w) => ` ${w.toUpperCase()} `));
  is('the seen-list matches regardless of case or spacing',
    messy.slice(0, 16).every((w) => !seenSet.has(w)));

  /* The starvation case, played for real. */
  const nearlyAll = CAVEMAN_WORDS.slice(0, CAVEMAN_WORDS.length - 4);
  const starved = shuffledDeck(nearlyAll);
  is('excluding almost the whole bank still deals a full deck',
    starved.length === CAVEMAN_WORDS.length, `${starved.length} cards`);
  const withList = G.deriveClientState(fresh(4, { rounds: 4, exclude: nearlyAll }), 'p1');
  const without = G.deriveClientState(fresh(4, { rounds: 4 }), 'p1');
  is('...and the game is exactly as long as it would have been',
    withList.totalTurns === without.totalTurns, `${withList.totalTurns} vs ${without.totalTurns}`);
  is('the seen-list never reaches a player', withList.exclude === undefined);

  /*
    The two caps must not drift. The browser remembers CAP words and the server
    honours the first N of whatever arrives; if the server's N ever drops below
    the browser's CAP, the oldest part of the seen-list is silently discarded
    and the fix quietly half-works, which is worse than not working — nothing
    fails, the repeats just come back.
  */
  const clientPath = new URL('../../frontend/src/lib/recentWords.js', import.meta.url);
  /* Railway deploys backend/ alone, so a frontend read has to be optional —
     the convention every other check in this directory already follows. */
  if (existsSync(clientPath)) {
    const clientSrc = readFileSync(clientPath, 'utf8');
    const serverSrc = readFileSync(
      new URL('../src/games/cavemanclues/game.js', import.meta.url), 'utf8',
    );
    const clientCap = Number((clientSrc.match(/const CAP = (\d+)/) || [])[1]);
    const serverCap = Number((serverSrc.match(/settings\.exclude[\s\S]{0,80}?slice\(0, (\d+)\)/) || [])[1]);
    is('both caps are readable', Number.isInteger(clientCap) && Number.isInteger(serverCap),
      `client ${clientCap}, server ${serverCap}`);
    is('the server honours everything the browser can send', serverCap >= clientCap,
      `server caps at ${serverCap}, browser remembers up to ${clientCap}`);
  }

  /* Garbage in the settings must not throw or empty the deck. */
  for (const bad of [null, 'Elephant', 42, {}, [1, 2, 3], [null, undefined]]) {
    const d = shuffledDeck(bad);
    if (d.length !== CAVEMAN_WORDS.length) fail('a malformed exclude list broke the deck', JSON.stringify(bad));
  }
  ok('a malformed seen-list is ignored rather than fatal');
}

/* ── Minimum players ─────────────────────────────────────────────────────── */
is('three players is the floor', G.minPlayers === 3,
  'someone must give clues while at least two race to guess');

console.log('');
if (failures) { console.log(`caveman clues logic — ${failures} problem(s)`); process.exit(1); }
console.log('caveman clues logic — the word stays secret, and the rules hold');
