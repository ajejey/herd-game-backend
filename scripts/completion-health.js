/*
  COMPLETION HEALTH — is every game actually finishable?

  The invariant that would have caught the Clover bug, stated generally:

      A game that people START must sometimes FINISH.

  Clover ran for 30 days with 113 rooms created, 58 started and zero completed.
  Nothing flagged it. The e2e smoke test covered Clover and passed the whole
  time, because it only asserted that a game STARTS — and Clover started
  perfectly. It just could never end.

  A per-game e2e test cannot be the only answer here: every game has different
  mechanics, and the next game added will not have one on day one. This check
  needs no per-game code at all. It reads production data and flags any game
  whose completion rate collapses, which works for games that do not exist yet.

  Run from backend/:  node scripts/completion-health.js [days]
  Exit code 1 if any game is failing, so it can be wired into a cron.
*/
import dns from 'dns';
dns.setServers(['1.1.1.1', '8.8.8.8']);
import 'dotenv/config';
import mongoose from 'mongoose';

const DAYS = Number(process.argv[2] || 14);
const since = new Date(Date.now() - DAYS * 86400000);

// Below this, something is wrong with the game rather than with the players.
const FAIL_RATE = 0.15;
const WARN_RATE = 0.40;
// Ignore games with too little traffic to judge.
const MIN_STARTS = 8;

await mongoose.connect(process.env.MONGODB_URI);
const ae = mongoose.connection.collection('analytics_events');

const rows = await ae.aggregate([
  { $match: { createdAt: { $gte: since }, name: { $in: ['game_created', 'game_started', 'game_completed'] } } },
  { $group: { _id: { g: '$game', n: '$name' }, c: { $sum: 1 } } },
]).toArray();

const games = {};
for (const r of rows) {
  const g = r._id.g || '(unlabelled)';
  games[g] ??= { created: 0, started: 0, completed: 0 };
  games[g][r._id.n.replace('game_', '')] = r.c;
}

const results = Object.entries(games)
  .map(([game, v]) => ({ game, ...v, rate: v.started ? v.completed / v.started : null }))
  .sort((a, b) => (a.rate ?? 9) - (b.rate ?? 9));

console.log(`\n=== completion health, last ${DAYS} days ===`);
console.log('  game'.padEnd(18) + 'created  started  completed   rate');

const failing = [];
const warning = [];
for (const r of results) {
  const judged = r.started >= MIN_STARTS;
  const pct = r.rate === null ? '  —  ' : (r.rate * 100).toFixed(0).padStart(4) + '%';
  let flag = '';
  if (judged && r.rate <= FAIL_RATE) { flag = '  <-- BROKEN'; failing.push(r); }
  else if (judged && r.rate < WARN_RATE) { flag = '  <-- unhealthy'; warning.push(r); }
  else if (!judged) flag = '  (too few starts to judge)';
  console.log('  ' + r.game.padEnd(16)
    + String(r.created).padStart(7) + String(r.started).padStart(9)
    + String(r.completed).padStart(11) + '  ' + pct + flag);
}

console.log(`\n  thresholds: BROKEN at or below ${FAIL_RATE * 100}%, unhealthy below ${WARN_RATE * 100}%, `
  + `judged only at ${MIN_STARTS}+ starts`);

if (failing.length) {
  console.log(`\n  ${failing.length} GAME(S) PEOPLE CANNOT FINISH:`);
  for (const r of failing) console.log(`    ${r.game}: ${r.started} started, only ${r.completed} finished`);
}
if (warning.length) {
  console.log(`\n  ${warning.length} game(s) worth a look:`);
  for (const r of warning) console.log(`    ${r.game}: ${(r.rate * 100).toFixed(0)}% of started games finish`);
}
if (!failing.length && !warning.length) console.log('\n  Every game with enough traffic completes at a healthy rate.');

await mongoose.disconnect();
process.exit(failing.length ? 1 : 0);
