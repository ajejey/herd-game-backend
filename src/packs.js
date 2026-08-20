import express from 'express';
import CustomPack, { PACK_GAMES } from './models/CustomPack.js';
import { parsePack, PACK_LIMITS } from './models/packParse.js';

/*
  Custom question packs — create one, fetch one by code.

  There is deliberately NO list/search/browse endpoint. A pack is addressed only
  by its code, which makes it a private document shared between people who
  already know each other rather than a content platform. See
  CUSTOM_PACKS_PLAN.md for why that matters for the Android/iOS builds.

  Same safety shape as feedback.js: per-IP rate limit, capped fields, never
  throws into the request path.
*/

const RL_WINDOW_MS = 60 * 1000;
/*
  Deliberately generous, because the limit is per IP and the audience is
  schools and offices — where an entire class sits behind ONE public address.
  At 6/min a teacher demonstrating this to thirty pupils would lock the room out
  on the seventh child. This is abuse protection, not usage throttling: anyone
  scripting it will blow past 30 in a minute regardless, and a real human
  writing eight questions cannot.
*/
const RL_MAX_CREATE = 30;
/*
  Preview is far chattier than create — the editor fires one per 350ms of
  typing — so it gets its own, higher ceiling rather than sharing the create
  budget. It had none at all, which meant an unauthenticated caller could run
  the full parser over a 100kb body as fast as it liked against a backend that
  ROBUSTNESS.md requires to stay on a single replica. 240/min is four a second,
  comfortably above any human typing and far below anything that hurts.
*/
const RL_MAX_PREVIEW = 240;
const hits = new Map();
const previewHits = new Map();

setInterval(() => {
  const cutoff = Date.now() - RL_WINDOW_MS;
  for (const map of [hits, previewHits]) {
    for (const [ip, rec] of map) if (rec.windowStart < cutoff) map.delete(ip);
  }
}, 5 * 60 * 1000).unref();

function rateLimited(map, ip, max) {
  const now = Date.now();
  const rec = map.get(ip);
  if (!rec || now - rec.windowStart > RL_WINDOW_MS) {
    map.set(ip, { count: 1, windowStart: now });
    return false;
  }
  rec.count += 1;
  return rec.count > max;
}

const clientIp = (req) =>
  (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').toString().split(',')[0].trim();

const str = (v, max) => (v == null ? '' : String(v).slice(0, max));
/*
  Normalise a pack code for lookup.

  Hyphens are now part of the format (codes are built from the pack's name), so
  stripping them — as this did — makes every named pack unfindable. The 12-char
  cap did the same to anything longer than the old random form.

  Still forgiving about everything else: case, spaces a phone inserted, a
  trailing full stop from an email. Old six-character codes normalise exactly as
  before, so nothing already issued changes meaning.
*/
const clean = (code) =>
  str(code, 48)
    .toUpperCase()
    .replace(/[^A-Z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

const router = express.Router();

/** POST /api/packs — create a pack, return its code. */
router.post('/', async (req, res) => {
  if (rateLimited(hits, clientIp(req), RL_MAX_CREATE)) {
    return res.status(429).json({ ok: false, error: 'Too many packs at once — give it a minute.' });
  }

  try {
    const b = req.body || {};
    const game = PACK_GAMES.includes(b.game) ? b.game : 'herd';
    const title = str(b.title, PACK_LIMITS.maxTitleLen).trim();
    const parsed = parsePack(game, b.questions);
    const isMcq = parsed.kind === 'trivia';
    const isPairs = parsed.kind === 'pairs';
    if (parsed.count < PACK_LIMITS.minQuestions) {
      return res.status(400).json({
        ok: false,
        error: `Please write at least ${PACK_LIMITS.minQuestions} questions — we understood ${parsed.count}.`,
        problems: parsed.problems,
      });
    }

    const questions = (isMcq || isPairs) ? [] : parsed.items;
    const mcq = isMcq ? parsed.items : [];
    const pairs = isPairs ? parsed.items : [];
    const count = parsed.count;

    const packCode = await CustomPack.generatePackCode(title);
    await CustomPack.create({
      packCode, game, title, questions, mcq, pairs,
      creatorAnonId: str(b.anonId, 40),
    });

    return res.json({ ok: true, packCode, count, title, game, problems: parsed.problems });
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'Could not save that pack. Please try again.' });
  }
});

/*
  POST /api/packs/preview — "here is what we understood".

  The browser deliberately does NOT re-implement parsing. Two copies would
  drift, and the host would be the one to discover it: their screen says ten
  questions, the save says eight, and they have no idea which is lying. This
  returns the exact parse that would be stored, so the preview is the truth.
*/
router.post('/preview', (req, res) => {
  // Over the ceiling, keep the editor usable rather than erroring at it: the
  // last good preview stays on screen and the next keystroke tries again.
  if (rateLimited(previewHits, clientIp(req), RL_MAX_PREVIEW)) {
    return res.status(429).json({ ok: false, error: 'Slow down a moment.' });
  }
  try {
    const b = req.body || {};
    const game = PACK_GAMES.includes(b.game) ? b.game : 'herd';
    const parsed = parsePack(game, b.questions);
    return res.json({
      ok: true,
      game,
      count: parsed.count,
      kind: parsed.kind,
      problems: parsed.problems.slice(0, 20),
      // Show the host their own answer key while they are writing — they are
      // the author, so there is nothing to hide from them here. It is only the
      // fetch-by-code route that must never echo answers.
      preview: parsed.items.slice(0, 60),
      min: PACK_LIMITS.minQuestions,
    });
  } catch (e) {
    return res.json({ ok: true, count: 0, problems: [], preview: [], min: PACK_LIMITS.minQuestions });
  }
});

/** GET /api/packs/:code — fetch a pack for playing or previewing. */
router.get('/:code', async (req, res) => {
  try {
    const packCode = clean(req.params.code);
    if (!packCode) return res.status(400).json({ ok: false, error: 'Missing code' });

    const pack = await CustomPack.findOne({ packCode }).lean();
    if (!pack) return res.status(404).json({ ok: false, error: 'No pack with that code. Check for a typo.' });
    if (pack.reported) return res.status(410).json({ ok: false, error: 'That pack is unavailable.' });

    const isMcq = pack.game === 'teamtrivia';
    const isPairs = pack.game === 'wyr';
    return res.json({
      ok: true,
      packCode: pack.packCode,
      game: pack.game,
      title: pack.title,
      // Never send the MCQ options to a browser that is only previewing a pack:
      // in Team Trivia the first option IS the answer, so echoing them back
      // would hand the correct answers to anyone with the code.
      questions: isMcq
        ? pack.mcq.map((m) => m.q)
        : isPairs ? pack.pairs.map((p) => `${p.a}  —or—  ${p.b}`)
          : pack.questions,
      count: isMcq ? pack.mcq.length : isPairs ? pack.pairs.length : pack.questions.length,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'Could not load that pack.' });
  }
});

/**
 * Load a pack for a game that is starting, and refresh its expiry.
 * Returns the questions array, or null. Never throws — a pack that cannot be
 * loaded must fall back to the built-in questions rather than break the room.
 */
export async function usePack(packCode) {
  try {
    const code = clean(packCode);
    if (!code) return null;
    const pack = await CustomPack.findOneAndUpdate(
      { packCode: code, reported: { $ne: true } },
      { $inc: { uses: 1 }, $set: { lastUsedAt: new Date() } },
      { new: true },
    ).lean();
    if (!pack) return null;
    const items = pack.game === 'teamtrivia' ? pack.mcq
      : pack.game === 'wyr' ? pack.pairs
        : pack.questions;
    if (!Array.isArray(items) || items.length < PACK_LIMITS.minQuestions) return null;
    return items;
  } catch {
    return null;
  }
}

export default router;
