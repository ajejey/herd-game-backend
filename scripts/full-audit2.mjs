/*
  FULL AUDIT part 2 — the things part 1 revealed we were blind to. Read-only.

  daily_events only covers solo + daily games. The 11 multiplayer party games
  never write there, so their play data lives in analytics_events instead. If
  you only look at daily_events you conclude the party games do not exist,
  which is exactly backwards: they are the busiest part of the site.

  Run from backend/:  node scripts/_full-audit2.mjs [days]
*/
import dns from 'dns';
dns.setServers(['1.1.1.1', '8.8.8.8']);
import 'dotenv/config';
import mongoose from 'mongoose';

const DAYS = Number(process.argv[2] || 30);
const since = new Date(Date.now() - DAYS * 86400000);
await mongoose.connect(process.env.MONGODB_URI);
const db = mongoose.connection.db;

/* -------- 1. USER FEEDBACK — actual words from actual players ----------- */
console.log('\n################ USER FEEDBACK (all time, verbatim) ################');
const fb = await db.collection('user_feedback').find({}).sort({ _id: -1 }).toArray();
if (!fb.length) console.log('  (none)');
for (const f of fb) {
  console.log('  ' + JSON.stringify(f, null, 2).split('\n').join('\n  '));
}

/* -------- 2. PARTY GAMES — which fields does analytics_events carry? ---- */
console.log('\n################ analytics_events — shape ################');
const one = await db.collection('analytics_events').find({}).sort({ _id: -1 }).limit(1).toArray();
console.log('  fields:', Object.keys(one[0] || {}).join(', '));
console.log('  sample:', JSON.stringify(one[0]));

/* -------- 3. PARTY GAMES by game, using whatever key exists ------------- */
const keys = Object.keys(one[0] || {});
const gameKey = ['game', 'gameType', 'namespace', 'type', 'slug'].find((k) => keys.includes(k));
console.log(`\n################ PARTY GAMES (last ${DAYS}d, grouped by "${gameKey}") ################`);
if (gameKey) {
  const rows = await db.collection('analytics_events').aggregate([
    { $match: { createdAt: { $gte: since } } },
    { $group: { _id: { g: `$${gameKey}`, n: '$name' }, c: { $sum: 1 } } },
    { $sort: { c: -1 } },
  ]).toArray();
  const byGame = {};
  for (const r of rows) {
    const g = r._id.g || '(unlabelled)';
    byGame[g] ??= {};
    byGame[g][r._id.n] = r.c;
  }
  const order = Object.entries(byGame).sort((a, b) =>
    (b[1].game_created || 0) - (a[1].game_created || 0));
  console.log('  game'.padEnd(24) + 'created  started  completed  joined');
  for (const [g, ev] of order) {
    console.log('  ' + g.padEnd(22)
      + String(ev.game_created || 0).padStart(7)
      + String(ev.game_started || 0).padStart(9)
      + String(ev.game_completed || 0).padStart(11)
      + String(ev.player_joined || 0).padStart(8));
  }
}

/* -------- 4. FUNNEL: created -> started -> completed -------------------- */
console.log(`\n################ ROOM FUNNEL (last ${DAYS}d, all party games) ################`);
const f = await db.collection('analytics_events').aggregate([
  { $match: { createdAt: { $gte: since }, name: { $in: ['game_created', 'game_started', 'game_completed'] } } },
  { $group: { _id: '$name', n: { $sum: 1 } } },
]).toArray();
const g = Object.fromEntries(f.map((x) => [x._id, x.n]));
const pct = (a, b) => (b ? ((a / b) * 100).toFixed(1) + '%' : '—');
console.log(`  created   ${g.game_created || 0}`);
console.log(`  started   ${g.game_started || 0}   (${pct(g.game_started, g.game_created)} of created)`);
console.log(`  completed ${g.game_completed || 0}   (${pct(g.game_completed, g.game_started)} of started, ${pct(g.game_completed, g.game_created)} of created)`);
console.log(`  -> ${(g.game_created || 0) - (g.game_started || 0)} rooms were made and never started.`);

/* -------- 5. daily_tallies staleness ------------------------------------ */
console.log('\n################ daily_tallies freshness ################');
const t = await db.collection('daily_tallies').find({}).sort({ _id: -1 }).limit(2).toArray();
for (const x of t) console.log('  ', JSON.stringify(x).slice(0, 220));
const subMax = await db.collection('daily_submissions').find({}).sort({ dayNumber: -1 }).limit(1).toArray();
console.log('  newest daily_submissions dayNumber:', subMax[0]?.dayNumber);

await mongoose.disconnect();
