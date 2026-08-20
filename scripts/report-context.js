/**
 * Puts a player's report back in its context.
 *
 *   node scripts/report-context.js            # every unresolved report, 14 days
 *   node scripts/report-context.js --days 30
 *
 * "not working" is a real signal from a real person and almost useless on its
 * own. But it arrives stamped with a room code, a game and a minute, and the
 * error capture and analytics are stamped the same way — so the thing that
 * actually happened is usually sitting right next to the complaint, unread.
 *
 * This joins the three by time and by room: what errored in that room, what
 * else that same browser did, and how far into the session the complaint came.
 * Read-only; writes nothing.
 */
import 'dotenv/config';
import mongoose from 'mongoose';

async function resolveSrv(uri) {
  if (!uri.startsWith('mongodb+srv://')) return uri;
  const rest = uri.slice('mongodb+srv://'.length);
  const at = rest.lastIndexOf('@');
  const creds = at === -1 ? '' : rest.slice(0, at + 1);
  const after = at === -1 ? rest : rest.slice(at + 1);
  const slash = after.indexOf('/');
  const host = slash === -1 ? after : after.slice(0, slash);
  const tail = slash === -1 ? '' : after.slice(slash);
  const doh = async (n, t) => {
    const r = await fetch(`https://dns.google/resolve?name=${n}&type=${t}`, { signal: AbortSignal.timeout(10000) });
    return ((await r.json()).Answer || []).map((a) => a.data);
  };
  const srv = await doh(`_mongodb._tcp.${host}`, 'SRV');
  if (!srv.length) return uri;
  const hosts = srv.map((d) => d.trim().split(/\s+/).slice(2)).map(([port, h]) => `${h.replace(/\.$/, '')}:${port}`).join(',');
  const txt = (await doh(host, 'TXT')).map((t) => t.replace(/^"|"$/g, '')).join('&');
  const [path, query = ''] = tail.replace(/^\//, '').split('?');
  return `mongodb://${creds}${hosts}/${path}?${[txt, query, 'ssl=true'].filter(Boolean).join('&')}`;
}

const argOf = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const DAYS = Number(argOf('days', 14));
const WINDOW_MIN = Number(argOf('window', 45));   // either side of the complaint

await mongoose.connect(await resolveSrv(process.env.MONGODB_URI || ''));
const db = mongoose.connection.db;

const since = new Date(Date.now() - DAYS * 864e5);
const feedback = await db.collection('user_feedback')
  .find({ createdAt: { $gte: since } }).sort({ createdAt: -1 }).limit(40).toArray();

console.log(`\nPLAYER REPORTS IN CONTEXT — last ${DAYS} days, +/-${WINDOW_MIN} min around each\n${'='.repeat(78)}`);

const fmt = (d) => new Date(d).toISOString().replace('T', ' ').slice(0, 16);
const short = (s, n = 92) => String(s || '').replace(/\s+/g, ' ').slice(0, n);

/* What names analytics_events actually uses, so the timeline below is readable. */
const names = await db.collection('analytics_events').aggregate([
  { $match: { createdAt: { $gte: since } } },
  { $group: { _id: '$name', n: { $sum: 1 } } },
  { $sort: { n: -1 } },
]).toArray();
console.log('\nroom events recorded: ' + names.map((n) => `${n._id} (${n.n})`).join(', ') + '\n');

for (const f of feedback) {
  const at = new Date(f.createdAt);
  const from = new Date(+at - WINDOW_MIN * 60000);
  const to = new Date(+at + WINDOW_MIN * 60000);
  const room = f.roomCode || null;
  const game = f.game || '?';

  console.log(`\n${'-'.repeat(78)}`);
  console.log(`[${fmt(at)}] ${game}${room ? ' · room ' + room : ''}  ${f.page || ''}`);
  console.log(`  "${short(f.message)}"`);

  /* The form captures whatever the browser had just logged. An empty list is
     itself an answer: nothing crashed, so the failure was not a JS error. */
  const recent = Array.isArray(f.recentErrors) ? f.recentErrors : [];
  console.log(`  errors their browser had just logged: ${recent.length || 'NONE'}`);
  for (const e of recent.slice(0, 5)) console.log(`    ${short(typeof e === 'string' ? e : JSON.stringify(e), 88)}`);

  /* The room's own life story, from the server's point of view. */
  if (room) {
    const life = await db.collection('analytics_events')
      .find({ roomCode: room }).sort({ createdAt: 1 }).limit(40).toArray();
    if (!life.length) {
      console.log(`  room ${room}: NO server-side record of this room at all`);
    } else {
      const first = new Date(life[0].createdAt);
      console.log(`  room ${room}: ${life.length} events, created ${fmt(first)} (${Math.round((+at - +first) / 60000)} min before the report)`);
      for (const e of life) {
        console.log(`    ${fmt(e.createdAt)}  ${String(e.name).padEnd(18)} players=${e.playerCount ?? '-'}  ${e.game || ''}`);
      }
    }

    const inRoom = await db.collection('client_errors')
      .find({ page: { $regex: room, $options: 'i' } })
      .sort({ createdAt: 1 }).limit(10).toArray();
    console.log(`  errors on a page for room ${room}: ${inRoom.length || 'none'}`);
    for (const e of inRoom) console.log(`    ${fmt(e.createdAt)}  ${e.type}: ${short(e.message, 66)}`);
  }

  /* And what everyone else was hitting at the same moment. */
  const around = await db.collection('client_errors').aggregate([
    { $match: { createdAt: { $gte: from, $lte: to } } },
    { $group: { _id: { type: '$type', message: '$message' }, n: { $sum: 1 }, ips: { $addToSet: '$ip' } } },
    { $project: { n: 1, people: { $size: '$ips' } } },
    { $sort: { people: -1, n: -1 } },
    { $limit: 5 },
  ]).toArray();
  console.log('  site-wide in that window:');
  for (const a of around) {
    console.log(`    ${String(a.people).padStart(3)} browsers ${String(a.n).padStart(4)}x  ${a._id.type}: ${short(a._id.message, 56)}`);
  }
}

await mongoose.disconnect();
