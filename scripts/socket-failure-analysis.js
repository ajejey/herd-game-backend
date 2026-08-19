/**
 * READ-ONLY. Are the socket_connect errors real lockouts, or benign reconnects?
 *
 *   node scripts/socket-failure-analysis.js
 *
 * 1,473 socket errors in 30 days sounds alarming and might be nothing. A phone
 * that backgrounds a tab drops its socket and logs an error every time, then
 * reconnects fine — that is noise. The question that matters is how many
 * DISTINCT people hit this, and whether they were trying to get in or already
 * in and briefly dropped.
 *
 * So this splits by:
 *   - people, not events   (a hundred errors from one flaky phone is one person)
 *   - where it happened    (a lobby page means "cannot get in"; a room page
 *                           means "was in, dropped, probably came back")
 *   - platform             (iOS suspending tabs is a different problem from a
 *                           desktop that cannot reach the server at all)
 *   - time                 (a spike at one hour is a deploy or an outage, a flat
 *                           line is a structural problem)
 *
 * Writes nothing.
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
  const hosts = srv
    .map((d) => d.trim().split(/\s+/).slice(2))
    .map(([port, h]) => `${h.replace(/\.$/, '')}:${port}`)
    .join(',');
  const txt = (await doh(host, 'TXT')).map((t) => t.replace(/^"|"$/g, '')).join('&');
  const [path, query = ''] = tail.replace(/^\//, '').split('?');
  return `mongodb://${creds}${hosts}/${path}?${[txt, query, 'ssl=true'].filter(Boolean).join('&')}`;
}

await mongoose.connect(await resolveSrv(process.env.MONGODB_URI || ''));
const conn = mongoose.connection;

/*
  Window it. The lazy-socket fix shipped 1 Aug 2026 (frontend 14c2cf4), and the
  error TTL is 30 days — so a plain 30-day total still describes a bug that no
  longer exists and would have us fixing it twice. Pass --days N to change it.
*/
const DAYS = Number((process.argv.find((a) => a.startsWith('--days=')) || '--days=7').split('=')[1]);
const since = new Date(Date.now() - DAYS * 86400000);

const rows = await conn
  .collection('client_errors')
  .find(
    { type: 'socket_connect', createdAt: { $gte: since } },
    { projection: { message: 1, page: 1, userAgent: 1, ip: 1, createdAt: 1, _id: 0 } }
  )
  .toArray();

console.log(`window: last ${DAYS} days (since ${since.toISOString().slice(0, 10)})
`);

if (!rows.length) {
  console.log('no socket_connect errors recorded.');
  await mongoose.disconnect();
  process.exit(0);
}

const platform = (ua = '') =>
  /iPhone|iPad|iPod/i.test(ua) ? 'iOS'
    : /Android/i.test(ua) ? 'Android'
    : /Macintosh/i.test(ua) ? 'Mac'
    : /Windows/i.test(ua) ? 'Windows'
    : /Linux/i.test(ua) ? 'Linux'
    : 'other';

// A room page means they were already in a game. A hub or landing page means
// they were trying to get into one — a far more expensive failure.
const where = (page = '') => (/\/(room|game)\//.test(page) ? 'inside a room' : 'trying to get in');

const byPerson = new Map();
const byPlatform = new Map();
const byWhere = new Map();
const byMessage = new Map();
const byHour = new Map();
const byPage = new Map();

for (const r of rows) {
  const key = `${r.ip}|${platform(r.userAgent)}`;
  if (!byPerson.has(key)) byPerson.set(key, []);
  byPerson.get(key).push(r);

  const p = platform(r.userAgent);
  byPlatform.set(p, (byPlatform.get(p) || 0) + 1);

  const w = where(r.page);
  byWhere.set(w, (byWhere.get(w) || 0) + 1);
  byMessage.set(r.message, (byMessage.get(r.message) || 0) + 1);

  const hour = new Date(r.createdAt).toISOString().slice(0, 13);
  byHour.set(hour, (byHour.get(hour) || 0) + 1);

  const base = (r.page || '/').split('/').slice(0, 3).join('/') || '/';
  byPage.set(base, (byPage.get(base) || 0) + 1);
}

const people = [...byPerson.values()];
const oneOff = people.filter((es) => es.length === 1).length;
const heavy = people.filter((es) => es.length >= 10).length;
const heavyEvents = people.filter((es) => es.length >= 10).reduce((n, es) => n + es.length, 0);

const pct = (n, d) => `${((n / d) * 100).toFixed(0)}%`;

console.log(`socket_connect: ${rows.length} events from ${people.length} distinct people (ip+platform)\n`);

console.log('how concentrated:');
console.log(`  ${oneOff} people hit it exactly once            (${pct(oneOff, people.length)} of people)`);
console.log(`  ${heavy} people hit it 10+ times               (${pct(heavy, people.length)} of people, ${pct(heavyEvents, rows.length)} of ALL events)`);
console.log(`  worst single person: ${Math.max(...people.map((e) => e.length))} events`);

console.log('\nwhat they were doing:');
[...byWhere.entries()].sort((a, b) => b[1] - a[1]).forEach(([w, n]) =>
  console.log(`  ${String(n).padStart(5)}  ${pct(n, rows.length).padStart(4)}  ${w}`));

console.log('\nby platform:');
[...byPlatform.entries()].sort((a, b) => b[1] - a[1]).forEach(([p, n]) =>
  console.log(`  ${String(n).padStart(5)}  ${pct(n, rows.length).padStart(4)}  ${p}`));

console.log('\nby message:');
[...byMessage.entries()].sort((a, b) => b[1] - a[1]).forEach(([m, n]) =>
  console.log(`  ${String(n).padStart(5)}  ${m}`));

console.log('\ntop pages:');
[...byPage.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).forEach(([p, n]) =>
  console.log(`  ${String(n).padStart(5)}  ${p}`));

// A flat rate is structural. Spikes are outages or deploys.
const hours = [...byHour.entries()].sort((a, b) => b[1] - a[1]);
const total = rows.length;
const distinctHours = byHour.size;
console.log(`\nspread over ${distinctHours} distinct hours, ${(total / distinctHours).toFixed(1)} per hour on average`);
console.log('worst hours:');
hours.slice(0, 8).forEach(([h, n]) => console.log(`  ${h}:00Z  ${String(n).padStart(4)}${n > (total / distinctHours) * 5 ? '   ← spike' : ''}`));

await mongoose.disconnect();
