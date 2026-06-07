/*
  Client error report — reads the client_errors collection.
  Run from backend/:  node scripts/error-report.js
  Shows: counts by type, top messages (grouped), and the most recent errors.
*/
import dns from 'dns';
dns.setServers(['1.1.1.1', '8.8.8.8']); // bypass ISP DNS that blocks Atlas SRV
import 'dotenv/config';
import mongoose from 'mongoose';

const URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/herdmentality';

async function main() {
  await mongoose.connect(URI);
  const col = mongoose.connection.collection('client_errors');

  const total = await col.countDocuments();
  console.log(`=== client_errors — ${total} total (TTL 30d) ===`);
  if (!total) { await mongoose.disconnect(); return; }

  // counts by type
  const byType = await col.aggregate([
    { $group: { _id: '$type', n: { $sum: 1 } } }, { $sort: { n: -1 } },
  ]).toArray();
  console.log('\n--- by type ---');
  byType.forEach((t) => console.log(`  ${String(t.n).padStart(4)}  ${t._id}`));

  // top messages (grouped) with last-seen + a sample page/UA
  const byMsg = await col.aggregate([
    { $group: {
      _id: { type: '$type', message: '$message' },
      n: { $sum: 1 },
      last: { $max: '$createdAt' },
      page: { $last: '$page' },
      ua: { $last: '$userAgent' },
    } },
    { $sort: { n: -1 } }, { $limit: 25 },
  ]).toArray();
  console.log('\n--- top messages ---');
  byMsg.forEach((m) => {
    console.log(`  [${m.n}] ${m._id.type}: ${m._id.message || '(no message)'}`);
    console.log(`       last ${m.last?.toISOString?.() || m.last} · page ${m.page || '?'} · ${(m.ua || '').slice(0, 70)}`);
  });

  // per-day volume (last 14 days)
  const perDay = await col.aggregate([
    { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, n: { $sum: 1 } } },
    { $sort: { _id: -1 } }, { $limit: 14 },
  ]).toArray();
  console.log('\n--- per day ---');
  perDay.reverse().forEach((d) => console.log(`  ${d._id}:  ${d.n}`));

  await mongoose.disconnect();
}
main().catch(async (e) => { console.error('error:', e.message); try { await mongoose.disconnect(); } catch {} process.exit(1); });
