/*
  Daily Herd stats — reads analytics_events + daily_submissions + daily_tallies.
  Run from backend/:  node scripts/daily-stats.js
*/
import dns from 'dns';
dns.setServers(['1.1.1.1', '8.8.8.8']); // bypass ISP DNS that blocks Atlas SRV
import 'dotenv/config';
import mongoose from 'mongoose';

const URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/herdmentality';

async function main() {
  await mongoose.connect(URI);
  const db = mongoose.connection;
  const ev = db.collection('analytics_events');
  const subs = db.collection('daily_submissions');
  const tallies = db.collection('daily_tallies');

  // 1. all event counts (whole hub)
  const allEv = await ev.aggregate([{ $group: { _id: '$name', n: { $sum: 1 } } }, { $sort: { n: -1 } }]).toArray();
  console.log('=== ALL analytics_events ===');
  allEv.forEach((e) => console.log(`  ${String(e.n).padStart(4)}  ${e._id}`));

  // 2. Daily Herd: submissions per dayNumber (how many answered each day) + avg score
  const perDay = await subs.aggregate([
    { $group: { _id: '$dayNumber', players: { $sum: 1 }, avgScore: { $avg: '$score' } } },
    { $sort: { _id: 1 } },
  ]).toArray();
  console.log('\n=== Daily Herd — players per day (dayNumber, count, avg score) ===');
  perDay.forEach((d) => console.log(`  day ${d._id}:  ${d.players} players,  avg ${Number(d.avgScore || 0).toFixed(2)}/5`));
  console.log(`  TOTAL submissions: ${await subs.countDocuments()}`);

  // 3. daily_viewed vs completed (funnel) per calendar day
  const funnel = await ev.aggregate([
    { $match: { name: { $in: ['daily_viewed', 'daily_completed'] } } },
    { $group: { _id: { d: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, n: '$name' }, c: { $sum: 1 } } },
    { $sort: { '_id.d': 1 } },
  ]).toArray();
  console.log('\n=== Daily funnel (calendar day: viewed -> completed) ===');
  const byDay = {};
  funnel.forEach((f) => { (byDay[f._id.d] = byDay[f._id.d] || {})[f._id.n] = f.c; });
  Object.entries(byDay).forEach(([d, o]) => console.log(`  ${d}:  viewed ${o.daily_viewed || 0}  ->  completed ${o.daily_completed || 0}`));

  // 4. latest day's top answers per question (the crowd distribution)
  if (perDay.length) {
    const last = perDay[perDay.length - 1]._id;
    const rows = await tallies.find({ dayNumber: last }).toArray();
    const byQ = {};
    rows.forEach((r) => { (byQ[r.questionId] = byQ[r.questionId] || []).push(r); });
    console.log(`\n=== Latest day (${last}) — top answers per question ===`);
    Object.entries(byQ).forEach(([q, rs]) => {
      rs.sort((a, b) => b.count - a.count);
      const total = rs.reduce((s, r) => s + r.count, 0);
      console.log(`  Q${q}: ` + rs.slice(0, 4).map((r) => `${r.answerRaw} ${Math.round((r.count / total) * 100)}%`).join(' · '));
    });
  }

  await mongoose.disconnect();
}
main().catch(async (e) => { console.error('error:', e.message); try { await mongoose.disconnect(); } catch {} process.exit(1); });
