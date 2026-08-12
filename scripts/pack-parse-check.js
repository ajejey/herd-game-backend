#!/usr/bin/env node
/*
  Pack parsing — the forgiveness suite.

  The people using this are a parent planning a party and a teacher building a
  class icebreaker. Every case below is a real way one of them could plausibly
  type or paste a quiz. If any of these fails, the feature fails for exactly the
  audience that asked for it.

  Run: node scripts/pack-parse-check.js
*/
import { parseTrivia, parsePrompts, parsePairs, PACK_LIMITS } from '../src/models/packParse.js';

let failures = 0;
const fail = (m) => { console.log('  FAIL  ' + m); failures++; };
const ok = (m) => console.log('  ok    ' + m);

function trivia(label, input, expect) {
  const { items, problems } = parseTrivia(input);
  const got = { count: items.length, first: items[0], problems: problems.length };
  if (expect.count !== undefined && got.count !== expect.count) {
    return fail(`${label}: expected ${expect.count} questions, got ${got.count}`
      + (problems.length ? ` (problems: ${problems.map((p) => p.reason).join('; ')})` : ''));
  }
  if (expect.q && items[0]?.q !== expect.q) return fail(`${label}: question was "${items[0]?.q}", expected "${expect.q}"`);
  if (expect.correct && items[0]?.options[0] !== expect.correct) {
    return fail(`${label}: correct answer was "${items[0]?.options[0]}", expected "${expect.correct}"`);
  }
  if (expect.options && items[0]?.options.length !== expect.options) {
    return fail(`${label}: ${items[0]?.options.length} options, expected ${expect.options}`);
  }
  ok(label);
}

console.log('\n=== TEAM TRIVIA: separators people actually use ===');
trivia('pipe (documented)', 'What is the capital of France? | Paris | London | Rome',
  { count: 1, q: 'What is the capital of France?', correct: 'Paris', options: 3 });

trivia('TAB — pasted straight out of Excel or Google Sheets',
  'What is the capital of France?\tParis\tLondon\tRome',
  { count: 1, q: 'What is the capital of France?', correct: 'Paris' });

trivia('semicolon — the easy one to reach on a phone',
  'What is the capital of France?; Paris; London; Rome',
  { count: 1, correct: 'Paris' });

trivia('slash', 'What is the capital of France? / Paris / London / Rome', { count: 1, correct: 'Paris' });

trivia('comma, with a comma INSIDE the question',
  'In 1492, who sailed the ocean blue? Columbus, Magellan, Cook',
  { count: 1, q: 'In 1492, who sailed the ocean blue?', correct: 'Columbus' });

console.log('\n=== TEAM TRIVIA: how people actually lay a quiz out ===');
trivia('answers on the lines below, with dashes', [
  'What is the capital of France?',
  '- Paris',
  '- London',
  '- Rome',
].join('\n'), { count: 1, q: 'What is the capital of France?', correct: 'Paris' });

trivia('answers below, lettered a) b) c)', [
  'Which planet is closest to the sun?',
  'a) Mercury',
  'b) Venus',
  'c) Mars',
].join('\n'), { count: 1, correct: 'Mercury' });

trivia('two blocks separated by a blank line', [
  'What is the capital of France?',
  '- Paris',
  '- London',
  '',
  'Who wrote Hamlet?',
  '- Shakespeare',
  '- Dickens',
].join('\n'), { count: 2 });

console.log('\n=== TEAM TRIVIA: marking the right answer ===');
trivia('star at the end marks it', 'Capital of France? | London | Paris * | Rome', { count: 1, correct: 'Paris' });
trivia('star at the start marks it', 'Capital of France? | London | *Paris | Rome', { count: 1, correct: 'Paris' });
trivia('(correct) marks it', 'Capital of France? | London | Paris (correct) | Rome', { count: 1, correct: 'Paris' });
trivia('nothing marked falls back to first', 'Capital of France? | Paris | London', { count: 1, correct: 'Paris' });

console.log('\n=== TEAM TRIVIA: what Word and phones silently insert ===');
trivia('non-breaking spaces around the pipes',
  'What is the capital of France? | Paris | London', { count: 1, correct: 'Paris' });
trivia('smart quotes survive', 'What is Paris’s nickname? | The City of Light | The Big Apple', { count: 1 });
trivia('fullwidth pipe from a CJK keyboard', 'Capital of France？｜Paris｜London', { count: 1 });
trivia('zero-width junk from a web copy',
  'Capital of France? |​Paris |​London', { count: 1, correct: 'Paris' });
trivia('windows line endings', 'Q one? | A | B\r\nQ two? | C | D', { count: 2 });
trivia('numbered list', '1. Capital of France? | Paris | London\n2) Capital of Spain? | Madrid | Rome', { count: 2 });
trivia('trailing separator', 'Capital of France? | Paris | London |', { count: 1, options: 2 });
trivia('lots of extra whitespace', '   Capital of France?    |    Paris   |   London   ', { count: 1, correct: 'Paris' });

console.log('\n=== TEAM TRIVIA: things that must be REPORTED, not silently dropped ===');
{
  const { items, problems } = parseTrivia('Capital of France? | Paris | London\nWhat is 2+2?\nWho wrote Hamlet? | Shakespeare | Dickens');
  if (items.length !== 2) fail(`expected 2 good questions, got ${items.length}`);
  else if (!problems.length) fail('a question with no answers produced NO problem message');
  else if (!problems[0].line) fail('problem has no line number');
  else ok(`a question with no answers is reported: line ${problems[0].line} — "${problems[0].reason}"`);
}
{
  const { problems } = parseTrivia('Capital of France? | Paris | Paris');
  if (!problems.some((p) => /same/i.test(p.reason))) fail('duplicate answers not reported');
  else ok('duplicate answers are reported');
}
{
  const { items, problems } = parseTrivia('Capital of France? | Paris | London\nCapital of France? | Paris | Rome');
  if (items.length !== 1) fail('duplicate question was not skipped');
  else if (!problems.some((p) => /duplicate/i.test(p.reason))) fail('duplicate question not reported');
  else ok('a duplicate question is skipped AND reported');
}

console.log('\n=== TEAM TRIVIA: the answer key is never wrong ===');
{
  const { items } = parseTrivia('Capital of France? | London | Paris* | Rome | Berlin | Madrid');
  if (!items[0]) fail('a question with five answers produced nothing at all');
  else if (items[0].options[0] !== 'Paris') fail(`marked answer lost when capped to 4 options — got "${items[0].options[0]}"`);
  else if (items[0].options.length !== 4) fail(`expected 4 options, got ${items[0].options.length}`);
  else ok('marked answer survives the 4-option cap and stays first');
}
{
  // A host who writes a genuinely short question should still be understood.
  const { items } = parseTrivia('2+2? | 4 | 5 | 3');
  if (!items.length) fail('a legitimately short question "2+2?" was rejected');
  else ok('a short but real question ("2+2?") is accepted');
}

console.log('\n=== PROMPTS (Herd, Say Anything, WYR, Hot Takes) ===');
{
  const { items, problems } = parsePrompts([
    '1. Best pizza topping?',
    '- Who is most likely to be late?',
    '',
    '   Best holiday spot?   ',
    'Best pizza topping?',        // duplicate
    'no',                          // too short
  ].join('\n'));
  if (items.length !== 3) fail(`prompts: expected 3, got ${items.length} (${items.join(' / ')})`);
  else if (items[0] !== 'Best pizza topping?') fail(`prompts: bullet not stripped — "${items[0]}"`);
  else if (problems.length !== 2) fail(`prompts: expected 2 problems, got ${problems.length}`);
  else ok('prompts: bullets stripped, blanks skipped, duplicate + too-short reported');
}
{
  const { items } = parsePrompts('Word break test?\r\nSecond one?');
  if (items.length !== 2) fail('prompts: CRLF/NBSP handling');
  else ok('prompts: handles Windows line endings and non-breaking spaces');
}

console.log('\n=== a bad line must not eat a good one ===');
{
  // A bare question with no answers, sat directly above a real question whose
  // last word is not a "?". The block parser used to swallow the good one as
  // an "answer" — destroying a real question and reporting nothing.
  const { items, problems } = parseTrivia([
    'What is 2+2?',
    'What is the capital of Bhutan? | Thimphu | Kathmandu | Dhaka',
    'Who wrote Hamlet? | Shakespeare | Dickens',
  ].join('\n'));
  if (items.length !== 2) fail(`a malformed line ate a good question — got ${items.length} of 2`);
  else if (!items.some((x) => /Bhutan/.test(x.q))) fail('the Bhutan question was consumed as an answer');
  else if (!problems.some((p) => p.line === 1)) fail('the malformed line was not reported');
  else ok('a question with no answers is reported and does NOT consume the next question');
}
{
  // ...while the legitimate block layout must still work.
  const { items } = parseTrivia(['Capital of France?', '- Paris', '- London'].join('\n'));
  if (items.length !== 1 || items[0].options[0] !== 'Paris') fail('block layout broke');
  else ok('the block layout still works alongside that guard');
}

console.log('\n=== marking the correct answer: every style a host might use ===');
/*
  A bare "* Mercury" on its own line stored VENUS as the correct answer.

  stripBullet's marker set included "*", so it removed the star as a list
  bullet before extractCorrect could read it as an answer marker, and the
  parser fell back to first-position. Every OTHER marking style worked, which
  is what kept it hidden: you only hit it by writing the most obvious thing.
  Nothing errored and nothing appeared in `problems` — the quiz was simply
  wrong, in front of a class. Each style is asserted below so that no future
  tidy-up of the bullet regex can quietly take one of them away again.
*/
for (const [style, input] of [
  ['bare star on its own line', 'Which planet is closest to the sun?\nVenus\n* Mercury\nMars'],
  ['dash bullet then a star', 'Which planet is closest to the sun?\n- Venus\n- * Mercury\n- Mars'],
  ['(correct) after the answer', 'Which planet is closest to the sun?\nVenus\nMercury (correct)\nMars'],
  ['trailing star', 'Which planet is closest to the sun?\nVenus\nMercury *\nMars'],
  ['lettered list with a star', 'Which planet is closest to the sun?\na) Venus\nb) * Mercury\nc) Mars'],
  ['inline pipes with a star', 'Which planet is closest to the sun? | Venus | * Mercury | Mars'],
  ['a tick instead of a star', 'Which planet is closest to the sun?\nVenus\n✓ Mercury\nMars'],
]) {
  const got = parseTrivia(input).items[0];
  if (!got) fail(`${style}: nothing parsed at all`);
  else if (got.options[0] !== 'Mercury') fail(`${style}: stored "${got.options[0]}" as correct, expected "Mercury"`);
  else ok(style);
}
{
  // ...and a leading star on a QUESTION line is still just a bullet.
  const { items } = parsePrompts('* What is the best pizza topping?');
  if (items[0] !== 'What is the best pizza topping?') fail(`a star bullet on a prompt line survived: "${items[0]}"`);
  else ok('a leading star on a question line is still stripped as a bullet');
}

console.log('\n=== going over the cap is reported, never silent ===');
/*
  All three parsers stopped at maxQuestions and discarded the rest with an
  EMPTY problems array. 75 in, 60 out, nothing said. The preview endpoint is
  the host's only feedback channel, so a teacher pasting a long list saw
  "60 questions" and no hint that fifteen had gone, or which. That is rule 3
  of packParse.js, broken by packParse.js.
*/
const over = PACK_LIMITS.maxQuestions + 15;
for (const [name, parse, make] of [
  ['prompts', parsePrompts, (i) => `Question number ${i} here?`],
  ['pairs', parsePairs, (i) => `Choice A ${i} | Choice B ${i}`],
  ['trivia', parseTrivia, (i) => `Question ${i}? | Yes${i} | No${i}`],
]) {
  const { items, problems } = parse(Array.from({ length: over }, (_, i) => make(i)).join('\n'));
  if (items.length !== PACK_LIMITS.maxQuestions) fail(`${name}: kept ${items.length}, expected the cap of ${PACK_LIMITS.maxQuestions}`);
  else if (!problems.length) fail(`${name}: dropped ${over - items.length} lines and reported NOTHING`);
  else if (problems[0].line !== PACK_LIMITS.maxQuestions + 1) fail(`${name}: reported line ${problems[0].line}, expected the first dropped line ${PACK_LIMITS.maxQuestions + 1}`);
  else ok(`${name}: the dropped lines are reported, with the line to cut from`);
}
{
  // Exactly at the cap must NOT claim anything was dropped.
  const exact = Array.from({ length: PACK_LIMITS.maxQuestions }, (_, i) => `Question number ${i} here?`).join('\n');
  if (parsePrompts(exact).problems.length) fail('a list exactly at the cap reported a phantom truncation');
  else if (parsePrompts(`${exact}\n\n\n`).problems.length) fail('trailing blank lines counted as dropped questions');
  else ok('exactly at the cap, and with trailing blank lines, reports nothing');
}

console.log('\n=== nothing crashes on junk ===');
for (const junk of ['', '   ', '\n\n\n', '|||', '???', 'a'.repeat(5000), '\t\t\t', '- \n- \n- ']) {
  try {
    parseTrivia(junk); parsePrompts(junk);
  } catch (e) {
    fail(`threw on input ${JSON.stringify(junk.slice(0, 20))}: ${e.message}`);
  }
}
ok('empty, whitespace, separators-only and a 5000-char line all parse without throwing');

console.log(failures ? `\n${failures} FAILURE(S)\n` : '\nAll checks passed.\n');
process.exit(failures ? 1 : 0);
