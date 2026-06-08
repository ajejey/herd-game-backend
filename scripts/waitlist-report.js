/*
  Corporate waitlist report — the Gate-2 willingness-to-pay signal.
  Run from backend/:  node scripts/waitlist-report.js
*/
import dns from 'dns';
dns.setServers(['1.1.1.1', '8.8.8.8']);
import 'dotenv/config';
import mongoose from 'mongoose';

const URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/herdmentality';

async function main() {
  await mongoose.connect(URI);
  const col = mongoose.connection.collection('waitlist');
  const total = await col.countDocuments();
  console.log(`=== Waitlist — ${total} signups ===`);
  const rows = await col.find({}).sort({ createdAt: -1 }).limit(100).toArray();
  // free vs work-email split (work email = not a common consumer domain)
  const consumer = /@(gmail|yahoo|hotmail|outlook|icloud|proton|aol)\./i;
  let work = 0;
  for (const r of rows) {
    if (!consumer.test(r.email)) work += 1;
    const d = r.createdAt?.toISOString?.().slice(0, 10) || '';
    console.log(`  ${d}  ${r.email.padEnd(34)} ${(r.company || '').padEnd(20)} [${r.tool || '?'}] via ${r.source || '?'}`);
  }
  console.log(`\n  work-email signups (the strong buy signal): ${work}/${rows.length}`);
  await mongoose.disconnect();
}
main().catch(async (e) => { console.error('error:', e.message); try { await mongoose.disconnect(); } catch {} process.exit(1); });
