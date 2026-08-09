/**
 * Read what players have reported.
 *
 *   node scripts/feedback-report.js            # unhandled, newest first
 *   node scripts/feedback-report.js --all      # including handled
 *   node scripts/feedback-report.js --days 7
 *
 * Read this at every review. A single report is worth a great deal here: almost
 * nobody writes in, so each one represents many silent players who hit the same
 * thing and simply left. The Taboo report on 4 Aug 2026 described two problems
 * that had been live for weeks.
 */
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { FEEDBACK_COLLECTION } from '../src/feedback.js';

dotenv.config();

const arg = (n, d = null) => {
  const i = process.argv.indexOf(`--${n}`);
  if (i === -1) return d;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
};

const DAYS = Number(arg('days', 30));
const ALL = Boolean(arg('all', false));

async function main() {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/herdmentality');
  const col = mongoose.connection.collection(FEEDBACK_COLLECTION);

  const since = new Date(Date.now() - DAYS * 24 * 60 * 60 * 1000);
  const q = { createdAt: { $gte: since } };
  if (!ALL) q.handled = { $ne: true };

  const rows = await col.find(q).sort({ createdAt: -1 }).limit(100).toArray();

  if (!rows.length) {
    console.log(`No ${ALL ? '' : 'unhandled '}reports in the last ${DAYS} days.`);
    await mongoose.disconnect();
    return;
  }

  console.log(`${rows.length} report(s), last ${DAYS} days\n${'='.repeat(70)}`);
  for (const r of rows) {
    const when = r.createdAt ? r.createdAt.toISOString().slice(0, 16).replace('T', ' ') : '?';
    console.log(`\n[${when}] ${r.platform || 'web'}${r.game ? `  game=${r.game}` : ''}${r.roomCode ? ` room=${r.roomCode}` : ''}`);
    console.log(`  "${r.message}"`);
    if (r.email) console.log(`  reply to: ${r.email}`);
    if (r.page) console.log(`  page: ${r.page}`);
    if (r.recentErrors?.length) {
      console.log('  console errors at the time:');
      r.recentErrors.forEach((e) => console.log(`    - ${e}`));
    }
  }

  // Where reports cluster is where the product is worst.
  const byGame = {};
  for (const r of rows) if (r.game) byGame[r.game] = (byGame[r.game] || 0) + 1;
  const ranked = Object.entries(byGame).sort((a, b) => b[1] - a[1]);
  if (ranked.length) {
    console.log(`\n${'='.repeat(70)}\nreports by game:`);
    ranked.forEach(([g, n]) => console.log(`  ${String(n).padStart(3)}  ${g}`));
  }

  console.log('\nMark one handled:');
  console.log(`  db.${FEEDBACK_COLLECTION}.updateOne({_id: ObjectId("...")}, {$set:{handled:true}})`);

  await mongoose.disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
