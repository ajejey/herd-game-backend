/*
  Forgiving parsing of host-written questions.

  THE AUDIENCE IS THE POINT. The people asking for this are a parent planning a
  family party and a school teacher building a class icebreaker. They are not
  going to fight a format. A strict parser that silently refuses a line is the
  single most likely way this feature fails: they type twenty questions, the
  counter says eight, and they have no idea which twelve are wrong or why.

  So the rules are:

    1. ACCEPT EVERY REASONABLE SEPARATOR, not just the one we documented.
       A spreadsheet paste is TAB separated. A phone keyboard buries "|" two
       layers deep, so people reach for a comma, a semicolon or a dash. Word and
       Google Docs substitute smart quotes, en dashes and non-breaking spaces
       without being asked.
    2. ACCEPT THE OBVIOUS ALTERNATIVE LAYOUT — question on one line, answers on
       the lines beneath it. That is how most people write a quiz by hand.
    3. NEVER FAIL SILENTLY. Every rejected line comes back with its number and a
       specific, plain-English reason.
    4. LET THEM MARK THE ANSWER. "Correct answer first" is easy to forget after
       twenty questions, so a * or (correct) anywhere on an answer wins, and
       first-place is only the fallback.

  This module is the SINGLE source of truth. The browser does not re-implement
  it — it calls /api/packs/preview and renders whatever the server understood,
  so what the host sees is exactly what will be stored. Two copies of parsing
  logic would drift, and the host would be the one who found out.
*/

export const PACK_LIMITS = {
  minQuestions: 8,
  maxQuestions: 60,
  maxQuestionLen: 140,
  minQuestionLen: 4,
  maxAnswerLen: 80,
  maxTitleLen: 60,
  minAnswers: 2,
  maxAnswers: 4,
};

/** Normalise the things word processors and phones insert without asking. */
export function normalise(raw) {
  return String(raw == null ? '' : raw)
    .replace(/\r\n?/g, '\n')          // Windows / old Mac line endings
    .replace(/ /g, ' ')          // non-breaking space (very common from Word)
    .replace(/[​-‍﻿]/g, '')  // zero-width junk from web copies
    .replace(/[‘’‛]/g, "'")  // smart single quotes
    .replace(/[“”]/g, '"')        // smart double quotes
    .replace(/｜/g, '|')          // fullwidth pipe (CJK keyboards)
    .replace(/❘/g, '|');         // light vertical bar
}

/*
  Strip a leading list marker: "1." "2)" "-" "•" "a)"

  "*" is deliberately NOT in this set any more. It is the character we tell
  hosts to use for marking the correct answer, and stripping it here destroyed
  that marker before extractCorrect could ever see it — so

      Which planet is closest to the sun?
      Venus
      * Mercury
      Mars

  stored VENUS as the correct answer. Silently. In a trivia game, in front of a
  class. Every other marking style worked, which made it the kind of bug you
  only find by trying the obvious thing.

  "*" is still stripped from QUESTION lines (stripQuestionBullet below), where
  it is unambiguously a bullet — a question has no "correct" to mark.
*/
const BULLET = '(?:\\(?\\d{1,2}[.):]|[a-hA-H][.)]|[-–—•‣▪])';
const stripBullet = (l) => l.replace(new RegExp(`^\\s*${BULLET}\\s+`), '').trim();

/* Question lines can safely lose a leading "*" — nothing is being marked. */
const stripQuestionBullet = (l) => l.replace(new RegExp(`^\\s*(?:${BULLET}|\\*)\\s+`), '').trim();

/*
  Which separator is this line using? Checked in order of how unambiguous they
  are. Comma is deliberately LAST and only used when nothing else is present,
  because questions legitimately contain commas ("In 1492, who sailed?").
*/
function splitAnswers(line) {
  const candidates = [
    { re: /\t+/, name: 'tab' },      // spreadsheet paste — never ambiguous
    { re: /\s*\|\s*/, name: 'pipe' },
    { re: /\s*;\s*/, name: 'semicolon' },
    { re: /\s+\/\s+/, name: 'slash' },
  ];
  for (const c of candidates) {
    if (c.re.test(line)) {
      const parts = line.split(c.re).map((p) => p.trim()).filter(Boolean);
      if (parts.length >= 2) return { parts, sep: c.name };
    }
  }
  // Comma only if the line looks like "question? a, b, c" — i.e. there is a
  // question mark to split on first, so commas inside the question are safe.
  const qm = line.indexOf('?');
  if (qm > 0 && qm < line.length - 1) {
    const q = line.slice(0, qm + 1).trim();
    const rest = line.slice(qm + 1).trim();
    if (rest.includes(',')) {
      const parts = [q, ...rest.split(',').map((p) => p.trim()).filter(Boolean)];
      if (parts.length >= 2) return { parts, sep: 'comma' };
    }
  }
  return { parts: [line.trim()], sep: null };
}

/*
  Report the lines dropped for being over the cap.

  Every parser used to stop at maxQuestions and discard the rest in silence —
  75 prompts in, 60 out, `problems` empty. That is rule 3 broken by the file
  that states it, and the preview endpoint is the host's only feedback channel,
  so a teacher pasting a long list saw "60 questions" and no hint that fifteen
  had gone or which. One entry naming the first dropped line and the count is
  enough: they need to know it happened and where to cut.
*/
function noteTruncation(problems, lines, firstDroppedIdx) {
  const remaining = lines.slice(firstDroppedIdx).filter((l) => l.trim()).length;
  if (remaining <= 0) return;
  problems.push({
    line: firstDroppedIdx + 1,
    text: (lines[firstDroppedIdx] || '').trim().slice(0, 80),
    reason: `Only the first ${PACK_LIMITS.maxQuestions} are used, so this line and the ${remaining - 1} after it were not saved. Trim the list or split it into two packs.`,
  });
}

/** A * or (correct) marks the right answer wherever it sits. */
function extractCorrect(answers) {
  let correctIdx = -1;
  const cleaned = answers.map((a, i) => {
    let t = a;
    let marked = false;
    if (/\((?:correct|right|answer|✓)\)/i.test(t)) { marked = true; t = t.replace(/\((?:correct|right|answer|✓)\)/ig, ''); }
    if (/^\s*[*✓]\s*/.test(t)) { marked = true; t = t.replace(/^\s*[*✓]\s*/, ''); }
    if (/\s*[*✓]\s*$/.test(t)) { marked = true; t = t.replace(/\s*[*✓]\s*$/, ''); }
    if (marked && correctIdx === -1) correctIdx = i;
    return t.trim();
  });
  return { answers: cleaned, correctIdx: correctIdx === -1 ? 0 : correctIdx };
}

/**
 * Parse Team Trivia questions. Returns { items, problems }.
 *   items    : [{ q, options:[CORRECT, ...others] }]
 *   problems : [{ line, text, reason }]
 * Handles BOTH layouts: everything on one line, or a question with its answers
 * on the lines beneath it.
 */
export function parseTrivia(raw) {
  const lines = normalise(raw).split('\n');
  const items = [];
  const problems = [];
  const seen = new Set();

  // Is this a "block" style list? True when at least one question line has no
  // separator but is followed by lines that look like answers.
  let i = 0;
  while (i < lines.length) {
    const rawLine = lines[i];
    const lineNo = i + 1;
    // Question line: a leading "*" here is a bullet, not an answer marker.
    const line = stripQuestionBullet(rawLine.trim());
    if (!line) { i += 1; continue; }

    const { parts } = splitAnswers(line);

    let qText = parts[0];
    let answerStrings = parts.slice(1);

    // BLOCK LAYOUT: no separators on this line, so look for answers below it.
    if (answerStrings.length === 0) {
      const collected = [];
      let j = i + 1;
      while (j < lines.length) {
        const nxt = lines[j];
        if (!nxt.trim()) break;                       // blank line ends the block
        /*
          A line carrying its own separators is unmistakably its own question,
          never an answer to the one above. Without this guard a bare line like
          "What is 2+2?" swallowed the NEXT question as its answer whenever
          that question happened not to end in a "?" — quietly destroying a
          real question and blaming nobody.
        */
        if (/[\t|;]/.test(nxt)) break;
        const looksLikeAnswer = /^\s*(?:[-–—*•‣▪]|\(?[a-hA-H][.)]|\(?\d{1,2}[.)])\s+/.test(nxt)
          || /^\s{2,}\S/.test(nxt)                    // indented
          || (!nxt.trim().endsWith('?') && collected.length > 0);
        if (!looksLikeAnswer && collected.length === 0 && !nxt.trim().endsWith('?')) {
          // first line after a question with no marker — still treat as answer
          collected.push(stripBullet(nxt.trim()));
          j += 1;
          continue;
        }
        if (!looksLikeAnswer) break;
        collected.push(stripBullet(nxt.trim()));
        j += 1;
      }
      if (collected.length >= PACK_LIMITS.minAnswers) {
        answerStrings = collected;
        i = j;
      } else {
        problems.push({
          line: lineNo,
          text: line.slice(0, 80),
          reason: 'No answers found. Put the answers after the question separated by | (or a tab, or on the lines below).',
        });
        i += 1;
        continue;
      }
    } else {
      i += 1;
    }

    const q = qText.slice(0, PACK_LIMITS.maxQuestionLen).trim();
    if (q.length < PACK_LIMITS.minQuestionLen) {
      problems.push({ line: lineNo, text: line.slice(0, 80), reason: 'The question is too short.' });
      continue;
    }
    if (seen.has(q.toLowerCase())) {
      problems.push({ line: lineNo, text: q.slice(0, 80), reason: 'Duplicate question — skipped.' });
      continue;
    }

    const { answers, correctIdx } = extractCorrect(answerStrings);
    const trimmed = answers.map((a) => a.slice(0, PACK_LIMITS.maxAnswerLen)).filter(Boolean);
    if (trimmed.length < PACK_LIMITS.minAnswers) {
      problems.push({ line: lineNo, text: q.slice(0, 80), reason: `Needs at least ${PACK_LIMITS.minAnswers} answers.` });
      continue;
    }
    const lower = trimmed.map((a) => a.toLowerCase());
    if (new Set(lower).size !== lower.length) {
      problems.push({ line: lineNo, text: q.slice(0, 80), reason: 'Two of the answers are the same.' });
      continue;
    }

    // Store CORRECT FIRST, which is what the game expects.
    const correct = trimmed[Math.min(correctIdx, trimmed.length - 1)];
    const others = trimmed.filter((_, k) => k !== Math.min(correctIdx, trimmed.length - 1));
    seen.add(q.toLowerCase());
    items.push({ q, options: [correct, ...others].slice(0, PACK_LIMITS.maxAnswers) });
    if (items.length >= PACK_LIMITS.maxQuestions) { noteTruncation(problems, lines, i); break; }
  }

  return { items, problems };
}

/**
 * Parse plain prompts (Herd Mentality, Say Anything, Would You Rather, Hot
 * Takes). Returns { items:[String], problems }.
 */
export function parsePrompts(raw) {
  const lines = normalise(raw).split('\n');
  const items = [];
  const problems = [];
  const seen = new Set();
  let truncatedAt = null;

  lines.forEach((rawLine, idx) => {
    const line = stripQuestionBullet(rawLine.trim());
    if (!line) return;
    if (items.length >= PACK_LIMITS.maxQuestions) {
      if (!truncatedAt) truncatedAt = { idx };
      return;
    }

    const q = line.slice(0, PACK_LIMITS.maxQuestionLen);
    if (q.length < PACK_LIMITS.minQuestionLen) {
      problems.push({ line: idx + 1, text: q, reason: 'Too short to be a question.' });
      return;
    }
    if (seen.has(q.toLowerCase())) {
      problems.push({ line: idx + 1, text: q.slice(0, 80), reason: 'Duplicate — skipped.' });
      return;
    }
    seen.add(q.toLowerCase());
    items.push(q);
  });

  if (truncatedAt) noteTruncation(problems, lines, truncatedAt.idx);
  return { items, problems };
}

/**
 * Parse Would You Rather pairs: two options per line.
 *   Have unlimited coffee | Have unlimited lunch
 * Returns { items:[{a,b}], problems }.
 */
export function parsePairs(raw) {
  const lines = normalise(raw).split('\n');
  const items = [];
  const problems = [];
  const seen = new Set();
  let truncatedAt = null;

  lines.forEach((rawLine, idx) => {
    const line = stripQuestionBullet(rawLine.trim());
    if (!line) return;
    if (items.length >= PACK_LIMITS.maxQuestions) {
      if (!truncatedAt) truncatedAt = { idx };
      return;
    }

    const { parts } = splitAnswers(line);
    // "Would you rather X or Y" is how people say it out loud, so accept a bare
    // " or " as a separator too — it is the most natural thing to type here.
    let a = parts[0];
    let b = parts[1];
    if (!b) {
      const m = line.split(/\s+or\s+/i);
      if (m.length === 2) { [a, b] = m; }
    }
    a = (a || '').trim().replace(/\?$/, '').trim();
    b = (b || '').trim().replace(/\?$/, '').trim();

    if (!b) {
      problems.push({
        line: idx + 1,
        text: line.slice(0, 80),
        reason: 'Needs two choices. Separate them with | or the word "or" — for example: Be able to fly | Be invisible',
      });
      return;
    }
    if (a.length < 2 || b.length < 2) {
      problems.push({ line: idx + 1, text: line.slice(0, 80), reason: 'One of the two choices is too short.' });
      return;
    }
    if (a.toLowerCase() === b.toLowerCase()) {
      problems.push({ line: idx + 1, text: line.slice(0, 80), reason: 'Both choices are the same.' });
      return;
    }
    const key = `${a.toLowerCase()}|${b.toLowerCase()}`;
    if (seen.has(key)) {
      problems.push({ line: idx + 1, text: line.slice(0, 80), reason: 'Duplicate — skipped.' });
      return;
    }
    seen.add(key);
    items.push({ a: a.slice(0, PACK_LIMITS.maxQuestionLen), b: b.slice(0, PACK_LIMITS.maxQuestionLen) });
  });

  if (truncatedAt) noteTruncation(problems, lines, truncatedAt.idx);
  return { items, problems };
}

/** One entry point: returns { kind, items, problems, count }. */
export function parsePack(game, raw) {
  if (game === 'teamtrivia') {
    const { items, problems } = parseTrivia(raw);
    return { kind: 'trivia', items, problems, count: items.length };
  }
  if (game === 'wyr') {
    const { items, problems } = parsePairs(raw);
    return { kind: 'pairs', items, problems, count: items.length };
  }
  const { items, problems } = parsePrompts(raw);
  return { kind: 'prompts', items, problems, count: items.length };
}
