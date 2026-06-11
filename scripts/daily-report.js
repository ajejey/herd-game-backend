/*
  Daily-game completion report — reads the daily_events collection.

  Shows true plays-per-day for the client-only daily games (Daily Herd, Daily
  Trivia, Huddle), which page views alone can't tell us. Read-only.

  Usage (from backend/):
    node scripts/daily-report.js          # last 14 days
    node scripts/daily-report.js 30       # last 30 days
*/
import dns from 'dns';
dns.setServers(['1.1.1.1', '8.8.8.8']); // bypass ISP DNS that blocks Atlas SRV
import 'dotenv/config';
import mongoose from 'mongoose';

const days = Number(process.argv[2]) || 14;
const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
const URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/herdmentality';

async function main() {
  await mongoose.connect(URI);
  const col = mongoose.connection.collection('daily_events');

  const total = await col.countDocuments();
  console.log(`=== daily_events — ${total} total (TTL 120d) ===`);
  if (!total) { console.log('\n(no completion pings yet — backend may not be redeployed)\n'); await mongoose.disconnect(); return; }

  // completions per day per game
  const rows = await col.aggregate([
    { $match: { createdAt: { $gte: since }, event: 'complete' } },
    { $group: {
      _id: { day: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, game: '$game' },
      plays: { $sum: 1 },
      players: { $addToSet: '$anonId' },
    } },
  ]).toArray();

  // pivot: day -> { game: {plays, uniques} }
  const byDay = {};
  const games = new Set();
  for (const r of rows) {
    games.add(r._id.game);
    (byDay[r._id.day] ||= {})[r._id.game] = { plays: r.plays, uniques: r.players.filter(Boolean).length };
  }
  const gameList = [...games].sort();

  console.log(`\nCompletions per day — last ${days} days (plays / unique players)\n`);
  const header = ['date'.padEnd(12), ...gameList.map((g) => g.padEnd(20)), 'TOTAL'];
  console.log('  ' + header.join(''));
  console.log('  ' + '-'.repeat(header.join('').length));

  for (const day of Object.keys(byDay).sort()) {
    let dayTotal = 0;
    const cells = gameList.map((g) => {
      const c = byDay[day][g];
      if (!c) return '—'.padEnd(20);
      dayTotal += c.plays;
      return `${c.plays}/${c.uniques}`.padEnd(20);
    });
    console.log('  ' + day.padEnd(12) + cells.join('') + String(dayTotal));
  }

  // per-game totals over the window
  console.log('\n--- totals over window ---');
  for (const g of gameList) {
    const t = await col.aggregate([
      { $match: { createdAt: { $gte: since }, event: 'complete', game: g } },
      { $group: { _id: null, plays: { $sum: 1 }, players: { $addToSet: '$anonId' } } },
    ]).toArray();
    const row = t[0] || { plays: 0, players: [] };
    console.log(`  ${g.padEnd(16)} ${row.plays} plays · ${row.players.filter(Boolean).length} unique players`);
  }

  await mongoose.disconnect();
}

main().catch(async (e) => {
  console.error('daily-report error:', e.message);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
