/*
  FULL AUDIT — every collection, every game, every stored record. Read-only.

  Exists because partial reports keep happening: reporting only on whatever was
  built most recently, and leaving the rest of the business unexamined. This
  script deliberately starts from "list every collection in the database" rather
  than from a hand-picked list, so anything new shows up automatically instead
  of being silently skipped.

  Run from backend/:  node scripts/_full-audit.mjs [days]
*/
import dns from 'dns';
dns.setServers(['1.1.1.1', '8.8.8.8']);
import 'dotenv/config';
import mongoose from 'mongoose';

const DAYS = Number(process.argv[2] || 30);
const since = new Date(Date.now() - DAYS * 86400000);

await mongoose.connect(process.env.MONGODB_URI);
const db = mongoose.connection.db;

const out = (t) => console.log(t);

/* ---------------- 0. EVERY collection, so nothing is skipped ------------- */
const cols = (await db.listCollections().toArray()).map((c) => c.name).sort();
out(`\n################ EVERY COLLECTION IN THE DATABASE ################`);
for (const name of cols) {
  const c = db.collection(name);
  const total = await c.countDocuments();
  let recent = 0;
  try { recent = await c.countDocuments({ createdAt: { $gte: since } }); } catch { /* no createdAt */ }
  const newest = await c.find({}).sort({ _id: -1 }).limit(1).toArray();
  const when = newest[0]?.createdAt ? new Date(newest[0].createdAt).toISOString().slice(0, 16) : '—';
  out(`  ${name.padEnd(22)} ${String(total).padStart(7)} docs  ${String(recent).padStart(6)} in ${DAYS}d  last: ${when}`);
}

/* ---------------- 1. EVERY game: solo/daily completions ------------------ */
out(`\n################ SOLO + DAILY COMPLETIONS (last ${DAYS}d) ################`);
const de = db.collection('daily_events');
const plays = await de.aggregate([
  { $match: { createdAt: { $gte: since } } },
  { $group: { _id: '$game', plays: { $sum: 1 }, people: { $addToSet: '$anonId' },
              avgScore: { $avg: '$score' }, wins: { $sum: { $cond: ['$won', 1, 0] } } } },
  { $project: { plays: 1, avgScore: 1, wins: 1, people: { $size: '$people' } } },
  { $sort: { plays: -1 } },
]).toArray();
let tp = 0;
for (const r of plays) {
  tp += r.plays;
  const rep = (r.plays / Math.max(1, r.people)).toFixed(1);
  const avg = r.avgScore == null ? '' : `  avg score ${r.avgScore.toFixed(1)}`;
  out(`  ${String(r.plays).padStart(6)} plays ${String(r.people).padStart(5)} people  ${rep.padStart(5)}x replay  ${r._id}${avg}`);
}
out(`  TOTAL ${tp} completions across ${plays.length} games`);

/* ---------------- 2. Multiplayer / party games --------------------------- */
out(`\n################ MULTIPLAYER ROOMS (last ${DAYS}d) ################`);
for (const name of cols.filter((n) => /game|room|session/i.test(n) && n !== 'daily_events')) {
  const c = db.collection(name);
  const sample = await c.find({}).sort({ _id: -1 }).limit(1).toArray();
  if (!sample.length) { out(`  ${name}: empty`); continue; }
  const keys = Object.keys(sample[0]);
  const gameKey = ['gameType', 'game', 'type', 'kind'].find((k) => keys.includes(k));
  const total = await c.countDocuments({ createdAt: { $gte: since } }).catch(() => 0);
  out(`  --- ${name}: ${total} in ${DAYS}d  (fields: ${keys.slice(0, 12).join(', ')})`);
  if (gameKey) {
    const rows = await c.aggregate([
      { $match: { createdAt: { $gte: since } } },
      { $group: { _id: `$${gameKey}`, rooms: { $sum: 1 },
                  avgPlayers: { $avg: { $size: { $ifNull: ['$players', []] } } } } },
      { $sort: { rooms: -1 } }, { $limit: 30 },
    ]).toArray();
    for (const r of rows) {
      const ap = r.avgPlayers ? `  avg ${r.avgPlayers.toFixed(1)} players` : '';
      out(`      ${String(r.rooms).padStart(5)} rooms  ${r._id || '(none)'}${ap}`);
    }
  }
}

/* ---------------- 3. EMAILS — the waitlist ------------------------------- */
out(`\n################ EMAILS COLLECTED (all time) ################`);
for (const name of cols.filter((n) => /wait|email|subscri|lead|contact/i.test(n))) {
  const rows = await db.collection(name).find({}).sort({ _id: -1 }).limit(100).toArray();
  out(`  --- ${name}: ${rows.length} record(s)`);
  for (const r of rows) {
    const email = r.email || r.address || '(no email field)';
    const when = r.createdAt ? new Date(r.createdAt).toISOString().slice(0, 10) : '?';
    const extra = [r.source, r.game, r.name, r.company, r.plan].filter(Boolean).join(' · ');
    out(`      ${when}  ${email}${extra ? '   [' + extra + ']' : ''}`);
  }
}

/* ---------------- 4. Analytics events ------------------------------------ */
out(`\n################ analytics_events (last ${DAYS}d) ################`);
const ae = await db.collection('analytics_events').aggregate([
  { $match: { createdAt: { $gte: since } } },
  { $group: { _id: '$name', n: { $sum: 1 } } }, { $sort: { n: -1 } }, { $limit: 40 },
]).toArray();
for (const r of ae) out(`  ${String(r.n).padStart(7)}  ${r._id}`);
if (!ae.length) out('  (none)');

/* ---------------- 5. Daily puzzle participation -------------------------- */
out(`\n################ DAILY PUZZLE SUBMISSIONS ################`);
for (const name of cols.filter((n) => /submission|tall(y|ies)/i.test(n))) {
  const c = db.collection(name);
  const recent = await c.aggregate([
    { $match: { createdAt: { $gte: since } } },
    { $group: { _id: '$dayNumber', n: { $sum: 1 }, avg: { $avg: '$score' } } },
    { $sort: { _id: -1 } }, { $limit: 12 },
  ]).toArray();
  out(`  --- ${name} (${await c.countDocuments()} all time), last 12 days:`);
  for (const r of recent) out(`      day ${String(r._id).padStart(4)}: ${String(r.n).padStart(5)} players  avg ${(r.avg ?? 0).toFixed(2)}`);
}

await mongoose.disconnect();
