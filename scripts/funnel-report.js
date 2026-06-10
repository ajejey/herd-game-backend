/*
  Product funnel report from the analytics_events collection.

  Reads the in-app events the Socket.IO engine logs (game_created, player_joined,
  game_started, game_completed) and prints the activation funnel per game over a
  date window. Read-only.

  Usage (from backend/):
    node scripts/funnel-report.js            # last 14 days
    node scripts/funnel-report.js 30         # last 30 days
*/
import dns from 'dns';
dns.setServers(['1.1.1.1', '8.8.8.8']); // bypass ISP DNS that blocks Atlas SRV
import 'dotenv/config';
import mongoose from 'mongoose';

const days = Number(process.argv[2]) || 14;
const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
const URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/herdmentality';

function pct(n, d) {
  return d ? `${((n / d) * 100).toFixed(0)}%` : '—';
}

async function main() {
  await mongoose.connect(URI);
  const col = mongoose.connection.collection('analytics_events');

  const rows = await col
    .aggregate([
      { $match: { createdAt: { $gte: since } } },
      { $group: { _id: { game: '$game', name: '$name' }, n: { $sum: 1 } } },
    ])
    .toArray();

  // shape: game -> { event: count }
  const byGame = {};
  for (const r of rows) {
    const g = r._id.game || 'unknown';
    (byGame[g] ||= {})[r._id.name] = r.n;
  }

  console.log(`\nProduct funnel — last ${days} days (since ${since.toISOString().slice(0, 10)})\n`);
  if (!Object.keys(byGame).length) {
    console.log('  (no events yet — backend may not be redeployed, or no games played in range)\n');
    await mongoose.disconnect();
    return;
  }

  for (const [game, e] of Object.entries(byGame)) {
    const created = e.game_created || 0;
    const joined = e.player_joined || 0;
    const started = e.game_started || 0;
    const completed = e.game_completed || 0;
    console.log(`  ${game}`);
    console.log(`    rooms created : ${created}`);
    console.log(`    players joined: ${joined}`);
    console.log(`    games started : ${started}   (start/create ${pct(started, created)})`);
    console.log(`    games finished: ${completed}   (finish/start ${pct(completed, started)})`);
    console.log('');
  }

  await mongoose.disconnect();
}

main().catch(async (e) => {
  console.error('funnel-report error:', e.message);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
