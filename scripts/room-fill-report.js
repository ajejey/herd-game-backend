/*
  Room-fill report — the core multiplayer health metric.

  A room that is created but never joined by a second player is a failed
  session: someone wanted to play with friends and it didn't happen. Averages
  hide this ("1.8 players per room" could be everyone getting 2, or half getting
  0 and half getting 4). This reports the distribution.

  Usage: node scripts/room-fill-report.js [days]
*/
import 'dotenv/config';
import dns from 'dns';
import mongoose from 'mongoose';

dns.setServers(['1.1.1.1', '8.8.8.8']); // some ISPs break Atlas SRV lookups

const DAYS = Number(process.argv[2]) || 14;
const since = new Date(Date.now() - DAYS * 86400000);

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  const events = mongoose.connection.db.collection('analytics_events');

  const rows = await events.find(
    { createdAt: { $gte: since }, name: { $in: ['game_created', 'player_joined', 'game_started', 'game_completed'] } },
    { projection: { name: 1, game: 1, roomCode: 1 } }
  ).toArray();

  // roomCode -> { game, joins, started, completed }
  const rooms = new Map();
  for (const r of rows) {
    if (!r.roomCode) continue;
    const key = r.game + '|' + r.roomCode;
    if (!rooms.has(key)) rooms.set(key, { game: r.game || '?', joins: 0, created: false, started: false, completed: false });
    const room = rooms.get(key);
    if (r.name === 'game_created') room.created = true;
    if (r.name === 'player_joined') room.joins++;
    if (r.name === 'game_started') room.started = true;
    if (r.name === 'game_completed') room.completed = true;
  }

  const byGame = new Map();
  for (const room of rooms.values()) {
    if (!room.created) continue; // only rooms we saw created in-window
    if (!byGame.has(room.game)) byGame.set(room.game, { total: 0, solo: 0, filled: 0, started: 0, completed: 0, joins: 0 });
    const g = byGame.get(room.game);
    g.total++;
    g.joins += room.joins;
    if (room.joins === 0) g.solo++; else g.filled++;
    if (room.started) g.started++;
    if (room.completed) g.completed++;
  }

  console.log(`\nRoom-fill report — last ${DAYS} days\n`);
  console.log('  game            rooms   solo(no one joined)   filled   avg players   started   completed');
  console.log('  ' + '-'.repeat(92));
  const sorted = [...byGame.entries()].sort((a, b) => b[1].total - a[1].total);
  let T = { total: 0, solo: 0, started: 0, completed: 0 };
  for (const [game, g] of sorted) {
    const soloPct = g.total ? Math.round((g.solo / g.total) * 100) : 0;
    const avg = g.total ? (1 + g.joins / g.total).toFixed(1) : '0';
    console.log(
      '  ' + game.padEnd(15) +
      String(g.total).padStart(5) +
      `   ${String(g.solo).padStart(4)} (${String(soloPct).padStart(2)}%)`.padEnd(22) +
      String(g.filled).padStart(7) +
      String(avg).padStart(14) +
      String(g.started).padStart(10) +
      String(g.completed).padStart(11)
    );
    T.total += g.total; T.solo += g.solo; T.started += g.started; T.completed += g.completed;
  }
  console.log('  ' + '-'.repeat(92));
  console.log(`  TOTAL rooms ${T.total} · solo (nobody joined) ${T.solo} (${Math.round((T.solo / T.total) * 100)}%) · started ${T.started} · completed ${T.completed}`);
  console.log(`\n  => ${Math.round((T.solo / T.total) * 100)}% of created rooms never got a second player.\n`);

  await mongoose.disconnect();
}

main().catch((e) => { console.error(e.message); process.exit(1); });
