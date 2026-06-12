import express from 'express';
import mongoose from 'mongoose';
import { logEvent } from '../../analytics.js';
import { getDayNumber, getDailyQuestions, getQuestion, isValidQuestionId, computeArchetype, QUESTIONS_PER_DAY } from './hotTakeQuestions.js';

/*
  Daily Hot Takes — REST (no Socket.IO). Mirrors Daily Herd's tally pattern, but
  for fixed A/B options instead of free text.

  Collections:
    hottake_tallies     { dayNumber, questionId, optIdx, count }   (crowd split per side)
    hottake_submissions { dayNumber, anonId, picks:[{questionId,optIdx}], archetype, spice, createdAt }
*/
const TALLIES = 'hottake_tallies';
const SUBMISSIONS = 'hottake_submissions';

function db() {
  const conn = mongoose.connection;
  if (!conn || conn.readyState !== 1) return null;
  return conn;
}

export async function ensureHotTakeIndexes() {
  const conn = db();
  if (!conn) return;
  try {
    await conn.collection(TALLIES).createIndex({ dayNumber: 1, questionId: 1, optIdx: 1 }, { unique: true });
    await conn.collection(SUBMISSIONS).createIndex({ dayNumber: 1, anonId: 1 }, { unique: true });
  } catch { /* best-effort */ }
}

// Crowd split for one question → counts per side + total.
async function questionSplit(conn, dayNumber, questionId) {
  const rows = await conn.collection(TALLIES).find({ dayNumber, questionId }).toArray();
  const counts = [0, 0];
  for (const r of rows) if (r.optIdx === 0 || r.optIdx === 1) counts[r.optIdx] = r.count;
  const total = counts[0] + counts[1];
  return { counts, total };
}

// Build a player's result: per-question your-side %, the archetype, and a
// "spice" score = how many takes put you in the minority.
async function buildResult(conn, dayNumber, picks) {
  const q = getQuestion;
  const perQuestion = [];
  let responders = 0;
  let spice = 0;
  for (const p of picks) {
    const def = q(p.questionId);
    if (!def) continue;
    const { counts, total } = await questionSplit(conn, dayNumber, p.questionId);
    responders = Math.max(responders, total);
    const yourPct = total ? Math.round((counts[p.optIdx] / total) * 100) : 0;
    const otherIdx = p.optIdx === 0 ? 1 : 0;
    if (total > 1 && counts[p.optIdx] < counts[otherIdx]) spice += 1; // minority take
    perQuestion.push({
      questionId: p.questionId,
      prompt: def.prompt,
      yourOptIdx: p.optIdx,
      yourLabel: p.optIdx === 0 ? def.a.label : def.b.label,
      otherLabel: p.optIdx === 0 ? def.b.label : def.a.label,
      yourPct,
    });
  }
  const archetype = computeArchetype(dayNumber, picks);
  return { archetype, spice, total: picks.length, responders, perQuestion };
}

const router = express.Router();

// GET /api/hottakes/today?anonId=...
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
      if (sub) { alreadyPlayed = true; result = await buildResult(conn, dayNumber, sub.picks); }
    }
    logEvent('hottakes_viewed', { dayNumber });
    res.json({ dayNumber, questions, alreadyPlayed, result });
  } catch (e) {
    res.status(500).json({ error: 'failed' });
  }
});

// POST /api/hottakes/answer  { dayNumber, anonId, picks:[{questionId, optIdx}] }
router.post('/answer', async (req, res) => {
  try {
    const conn = db();
    if (!conn) return res.status(503).json({ error: 'unavailable' });

    const today = getDayNumber();
    const { dayNumber, anonId: rawAnon, picks } = req.body || {};
    const anonId = String(rawAnon || '').slice(0, 80);

    if (dayNumber !== today) return res.status(409).json({ error: 'stale_day', today });
    if (!anonId) return res.status(400).json({ error: 'missing_anonId' });
    if (!Array.isArray(picks) || picks.length === 0 || picks.length > QUESTIONS_PER_DAY) {
      return res.status(400).json({ error: 'bad_picks' });
    }

    const official = new Set(getDailyQuestions(today).map((q) => q.id));
    const seen = new Set();
    const clean = [];
    for (const p of picks) {
      if (!isValidQuestionId(p?.questionId) || !official.has(p.questionId)) return res.status(400).json({ error: 'bad_question' });
      if (p.optIdx !== 0 && p.optIdx !== 1) return res.status(400).json({ error: 'bad_option' });
      if (seen.has(p.questionId)) return res.status(400).json({ error: 'duplicate_question' });
      seen.add(p.questionId);
      clean.push({ questionId: p.questionId, optIdx: p.optIdx });
    }

    // Claim the unique (day, anon) slot first — only the winner tallies, so a
    // double-submit can't inflate the crowd split.
    const archetype = computeArchetype(today, clean);
    try {
      await conn.collection(SUBMISSIONS).insertOne({ dayNumber: today, anonId, picks: clean, archetype, createdAt: new Date() });
    } catch (err) {
      if (err && err.code === 11000) {
        const sub = await conn.collection(SUBMISSIONS).findOne({ dayNumber: today, anonId });
        if (sub) return res.json({ ...(await buildResult(conn, today, sub.picks)), replay: true });
      }
      throw err;
    }

    for (const p of clean) {
      await conn.collection(TALLIES).updateOne(
        { dayNumber: today, questionId: p.questionId, optIdx: p.optIdx },
        { $inc: { count: 1 } },
        { upsert: true },
      );
    }

    const result = await buildResult(conn, today, clean);
    await conn.collection(SUBMISSIONS).updateOne({ dayNumber: today, anonId }, { $set: { spice: result.spice } });
    logEvent('hottakes_completed', { dayNumber: today, archetype });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: 'failed' });
  }
});

export default router;
