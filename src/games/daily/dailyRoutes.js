import express from 'express';
import mongoose from 'mongoose';
import { normalizeAnswer } from '../../utils/answerNormalizer.js';
import { logEvent } from '../../analytics.js';
import { getDayNumber, getDailyQuestions, isValidQuestionId, QUESTIONS_PER_DAY } from './dailyQuestions.js';

/*
  Daily Herd — REST (no Socket.IO). Decoupled from the realtime game engine.

  Collections:
    daily_tallies     { dayNumber, questionId, answerNorm, answerRaw, count }   (running crowd distribution)
    daily_submissions { dayNumber, anonId, answers:[{questionId,raw,norm,matched}], score, createdAt }  (one per play)
*/

const TALLIES = 'daily_tallies';
const SUBMISSIONS = 'daily_submissions';

function db() {
  const conn = mongoose.connection;
  if (!conn || conn.readyState !== 1) return null;
  return conn;
}

export async function ensureDailyIndexes() {
  const conn = db();
  if (!conn) return;
  try {
    await conn.collection(TALLIES).createIndex({ dayNumber: 1, questionId: 1, answerNorm: 1 }, { unique: true });
    await conn.collection(SUBMISSIONS).createIndex({ dayNumber: 1, anonId: 1 }, { unique: true });
  } catch { /* index creation best-effort */ }
}

// Current crowd distribution for one question → top answers + plurality.
async function questionDistribution(conn, dayNumber, questionId) {
  const rows = await conn.collection(TALLIES).find({ dayNumber, questionId }).toArray();
  const total = rows.reduce((s, r) => s + r.count, 0);
  rows.sort((a, b) => b.count - a.count);
  const plurality = rows[0] || null;
  const topAnswers = rows.slice(0, 3).map((r) => ({
    label: r.answerRaw,
    pct: total ? Math.round((r.count / total) * 100) : 0,
  }));
  const byNorm = {};
  rows.forEach((r) => { byNorm[r.answerNorm] = r.count; });
  return { total, pluralityNorm: plurality?.answerNorm ?? null, topAnswers, byNorm };
}

// Recompute a played player's result from stored answers + current tallies.
// Adds, per question, the % of the herd that gave YOUR answer (yourPct), plus a
// headline "herd sync %" (avg agreement) and today's responder count.
async function buildResult(conn, dayNumber, submission) {
  const perQuestion = [];
  let responders = 0;
  const syncs = [];
  for (const a of submission.answers) {
    const dist = await questionDistribution(conn, dayNumber, a.questionId);
    responders = Math.max(responders, dist.total);
    const yourCount = dist.byNorm[a.norm] || 0;
    const yourPct = dist.total ? Math.round((yourCount / dist.total) * 100) : 0;
    syncs.push(yourPct);
    perQuestion.push({
      questionId: a.questionId,
      yourAnswer: a.raw,
      matched: a.norm === dist.pluralityNorm,
      yourPct,
      topAnswers: dist.topAnswers,
    });
  }
  const score = perQuestion.filter((q) => q.matched).length;
  const syncPct = syncs.length ? Math.round(syncs.reduce((s, v) => s + v, 0) / syncs.length) : 0;

  // beatPct: how many of today's players (with a final score) you out-scored.
  let beatPct = 0;
  try {
    const others = await conn.collection(SUBMISSIONS).find({ dayNumber, score: { $ne: null } }).project({ score: 1 }).toArray();
    const scores = others.map((s) => s.score);
    if (scores.length) beatPct = Math.round((scores.filter((s) => s < score).length / scores.length) * 100);
  } catch { /* best-effort */ }

  return { score, total: submission.answers.length, perQuestion, responders, syncPct, beatPct };
}

const router = express.Router();

// GET /api/daily/today?anonId=...
router.get('/today', async (req, res) => {
  try {
    const conn = db();
    if (!conn) return res.status(503).json({ error: 'unavailable' });
    const dayNumber = getDayNumber();
    const questions = getDailyQuestions(dayNumber);
    const anonId = String(req.query.anonId || '').slice(0, 80);

    let alreadyPlayed = false;
    let result = null;
    if (anonId) {
      const sub = await conn.collection(SUBMISSIONS).findOne({ dayNumber, anonId });
      if (sub) {
        alreadyPlayed = true;
        result = await buildResult(conn, dayNumber, sub);
      }
    }

    logEvent('daily_viewed', { dayNumber });
    res.json({ dayNumber, questions, alreadyPlayed, result });
  } catch (e) {
    res.status(500).json({ error: 'failed' });
  }
});

// POST /api/daily/answer  { dayNumber, anonId, answers:[{questionId, answer}] }
router.post('/answer', async (req, res) => {
  try {
    const conn = db();
    if (!conn) return res.status(503).json({ error: 'unavailable' });

    const today = getDayNumber();
    const { dayNumber, anonId: rawAnon, answers } = req.body || {};
    const anonId = String(rawAnon || '').slice(0, 80);

    if (dayNumber !== today) return res.status(409).json({ error: 'stale_day', today });
    if (!anonId) return res.status(400).json({ error: 'missing_anonId' });
    if (!Array.isArray(answers) || answers.length === 0 || answers.length > QUESTIONS_PER_DAY) {
      return res.status(400).json({ error: 'bad_answers' });
    }

    // Validate the submitted question ids match today's official set; de-dupe
    // so one submission can't tally the same question twice.
    const officialIds = new Set(getDailyQuestions(today).map((q) => q.id));
    const seen = new Set();
    const clean = [];
    for (const a of answers) {
      if (!isValidQuestionId(a?.questionId) || !officialIds.has(a.questionId)) {
        return res.status(400).json({ error: 'bad_question' });
      }
      if (seen.has(a.questionId)) return res.status(400).json({ error: 'duplicate_question' });
      seen.add(a.questionId);
      const raw = String(a.answer || '').trim().slice(0, 60);
      if (!raw) return res.status(400).json({ error: 'empty_answer' });
      clean.push({ questionId: a.questionId, raw, norm: normalizeAnswer(raw) });
    }

    // Claim the unique (dayNumber, anonId) slot FIRST. Whoever wins the insert
    // is the only one who tallies — this prevents a concurrent double-submit
    // from inflating the crowd distribution (tallies increment exactly once).
    try {
      await conn.collection(SUBMISSIONS).insertOne({
        dayNumber: today,
        anonId,
        answers: clean,
        score: null,
        createdAt: new Date(),
      });
    } catch (err) {
      if (err && err.code === 11000) {
        const sub = await conn.collection(SUBMISSIONS).findOne({ dayNumber: today, anonId });
        if (sub) return res.json({ ...(await buildResult(conn, today, sub)), replay: true });
      }
      throw err;
    }

    // We won the slot — tally each answer into the crowd distribution.
    for (const a of clean) {
      await conn.collection(TALLIES).updateOne(
        { dayNumber: today, questionId: a.questionId, answerNorm: a.norm },
        { $inc: { count: 1 }, $setOnInsert: { answerRaw: a.raw } },
        { upsert: true }
      );
    }

    // Compute the player's result (per-question agreement %, herd sync %, responders)
    // against the post-increment distribution.
    const result = await buildResult(conn, today, { answers: clean });

    // Backfill the score + per-question matched flags onto the claimed submission.
    await conn.collection(SUBMISSIONS).updateOne(
      { dayNumber: today, anonId },
      { $set: { score: result.score, answers: clean.map((a, i) => ({ ...a, matched: result.perQuestion[i].matched })) } }
    );

    logEvent('daily_completed', { dayNumber: today, score: result.score });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: 'failed' });
  }
});

// GET /api/daily/result?dayNumber=&anonId=
router.get('/result', async (req, res) => {
  try {
    const conn = db();
    if (!conn) return res.status(503).json({ error: 'unavailable' });
    const dayNumber = Number(req.query.dayNumber);
    const anonId = String(req.query.anonId || '').slice(0, 80);
    if (!Number.isInteger(dayNumber) || !anonId) return res.status(400).json({ error: 'bad_request' });
    const sub = await conn.collection(SUBMISSIONS).findOne({ dayNumber, anonId });
    if (!sub) return res.status(404).json({ error: 'not_found' });
    res.json(await buildResult(conn, dayNumber, sub));
  } catch (e) {
    res.status(500).json({ error: 'failed' });
  }
});

export default router;
