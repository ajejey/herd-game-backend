/**
 * What is actually wrong RIGHT NOW, with everything already dealt with kept out
 * of the way.
 *
 *   node scripts/issues.js                        open issues, newest first
 *   node scripts/issues.js --all                  include everything triaged
 *   node scripts/issues.js --days=14              change the window (default 7)
 *
 *   node scripts/issues.js --fix <key> --note "..." [--commit abc1234]
 *   node scripts/issues.js --watch <key> --note "..."
 *   node scripts/issues.js --ignore <key> --note "..."
 *   node scripts/issues.js --reopen <key>
 *
 * WHY THIS EXISTS
 *
 * The raw reports have no memory. Pulling 30 days of client_errors and
 * user_feedback shows fixed bugs, duplicates and dead noise mixed in with the
 * one thing that started yesterday, and every reading begins by rediscovering
 * the same old problems and treating them as new. That happened twice: a socket
 * error count that looked like an emergency was mostly a bug already fixed
 * weeks earlier, and the review cost more than the bug did.
 *
 * So triage state is stored, and the default view shows only what has not been
 * dealt with.
 *
 * Two things do the real work here:
 *
 *   - TREND. Every error signature shows this window against the one before it,
 *     plus when it was last seen. A signature that stopped the day something
 *     shipped is visibly finished even if nobody marked it. "500 errors" means
 *     nothing; "500, last seen 9 days ago, down from 900" means fixed.
 *
 *   - PEOPLE, NOT EVENTS. One phone retrying two hundred times is one person
 *     having a bad afternoon, not two hundred problems.
 *
 * Marking something fixed writes to `issue_triage`. Nothing else is written.
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import crypto from 'crypto';

const TRIAGE = 'issue_triage';

/* ------------------------------------------------------------------ connect */

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

const arg = (name, fallback = null) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.split('=').slice(1).join('=');
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback;
};
const has = (name) => process.argv.includes(`--${name}`);

/*
  A stable key for an error signature.

  Hashed from type + message with the volatile parts stripped, so the same bug
  keeps its key across days and a triage note survives. Without that, anything
  carrying an id or a timing would mint a fresh "new issue" on every occurrence
  and the triage state would be worthless within a day.

  Stripped: hex ids and digits. NOT room codes — and deliberately so. A code
  like TRJQPP is six capital letters, which is the same shape as SERVER, FAILED
  and PLEASE, so stripping it would mangle ordinary messages to catch something
  that does not actually appear in one. Real messages here are "timeout",
  "xhr poll error", "Script error." Room codes live in `page`, which is
  intentionally not part of the key — that is what keeps one bug from becoming
  one issue per room.
*/
const signatureKey = (type, message) => {
  const stable = String(message || '')
    .replace(/\b[0-9a-f]{8,}\b/gi, '#')
    .replace(/\d+/g, '#')
    .slice(0, 200);
  return 'err:' + crypto.createHash('sha1').update(`${type}|${stable}`).digest('hex').slice(0, 10);
};

const ago = (d) => {
  const days = Math.floor((Date.now() - new Date(d).getTime()) / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  return `${days}d ago`;
};

await mongoose.connect(await resolveSrv(process.env.MONGODB_URI || ''));
const conn = mongoose.connection;
const triageCol = conn.collection(TRIAGE);
await triageCol.createIndex({ key: 1 }, { unique: true }).catch(() => {});

/* ------------------------------------------------------------ write actions */

const WRITE = ['fix', 'watch', 'ignore', 'reopen'].find((a) => arg(a));
if (WRITE) {
  const key = arg(WRITE);
  const status = WRITE === 'fix' ? 'fixed' : WRITE === 'watch' ? 'watching' : WRITE === 'ignore' ? 'ignored' : 'open';
  const note = arg('note', '');
  const commit = arg('commit', null);

  if (status === 'open') {
    await triageCol.deleteOne({ key });
    console.log(`reopened ${key}`);
  } else {
    await triageCol.updateOne(
      { key },
      { $set: { key, status, note, commit, at: new Date() } },
      { upsert: true }
    );
    console.log(`${key} → ${status}${note ? `  (${note})` : ''}${commit ? `  [${commit}]` : ''}`);
  }
  await mongoose.disconnect();
  process.exit(0);
}

/* -------------------------------------------------------------- read + show */

const DAYS = Number(arg('days', '7'));
const showAll = has('all');
const now = Date.now();
const since = new Date(now - DAYS * 86400000);
const prevSince = new Date(now - DAYS * 2 * 86400000);

const triaged = new Map((await triageCol.find({}).toArray()).map((t) => [t.key, t]));

/* --- player reports ------------------------------------------------------- */

const feedback = await conn
  .collection('user_feedback')
  .find({ createdAt: { $gte: since } })
  .sort({ createdAt: -1 })
  .toArray();

/* --- error signatures ----------------------------------------------------- */

const errs = await conn
  .collection('client_errors')
  .find({ createdAt: { $gte: prevSince } }, { projection: { type: 1, message: 1, page: 1, ip: 1, createdAt: 1, _id: 0 } })
  .toArray();

const sigs = new Map();
for (const e of errs) {
  const key = signatureKey(e.type, e.message);
  if (!sigs.has(key)) {
    sigs.set(key, { key, type: e.type, message: e.message, cur: 0, prev: 0, people: new Set(), pages: new Set(), last: e.createdAt, first: e.createdAt });
  }
  const s = sigs.get(key);
  const t = new Date(e.createdAt);
  if (t >= since) {
    s.cur += 1;
    s.people.add(e.ip);
    if (e.page) s.pages.add(e.page.split('/').slice(0, 3).join('/'));
  } else {
    s.prev += 1;
  }
  if (t > new Date(s.last)) s.last = e.createdAt;
  if (t < new Date(s.first)) s.first = e.createdAt;
}

const open = [];
const done = [];
for (const s of sigs.values()) {
  const t = triaged.get(s.key);
  (t && t.status !== 'open' ? done : open).push({ ...s, triage: t || null });
}
open.sort((a, b) => b.people.size - a.people.size);

/* ------------------------------------------------------------------ output */

const trend = (s) => {
  if (s.prev === 0 && s.cur > 0) return 'NEW';
  if (s.cur === 0) return 'stopped';
  const pctChange = Math.round(((s.cur - s.prev) / Math.max(1, s.prev)) * 100);
  return `${pctChange >= 0 ? '+' : ''}${pctChange}%`;
};

console.log(`\nISSUES — last ${DAYS} days (compared with the ${DAYS} before)\n${'='.repeat(70)}`);

const newFeedback = feedback.filter((f) => !triaged.has(`fb:${f._id}`) && !f.handled);
console.log(`\nPLAYER REPORTS — ${newFeedback.length} not yet dealt with (${feedback.length} in window)\n`);
if (!newFeedback.length) console.log('  nothing new.');
for (const f of newFeedback) {
  const when = new Date(f.createdAt).toISOString().slice(0, 16).replace('T', ' ');
  console.log(`  fb:${f._id}`);
  console.log(`    [${when}] ${f.platform || 'web'}${f.game ? ` · ${f.game}` : ''}${f.roomCode ? ` · ${f.roomCode}` : ''}`);
  console.log(`    "${(f.message || '').slice(0, 140)}"`);
  if (f.email) console.log(`    reply to: ${f.email}`);
  console.log('');
}

console.log(`\nERROR SIGNATURES — ${open.filter((s) => s.cur > 0).length} open and active\n`);
console.log(`  ${'key'.padEnd(15)}${'people'.padStart(7)}${'events'.padStart(8)}${'trend'.padStart(9)}   last seen`);
console.log('  ' + '-'.repeat(66));
for (const s of open) {
  if (s.cur === 0 && !showAll) continue;
  console.log(
    `  ${s.key.padEnd(15)}${String(s.people.size).padStart(7)}${String(s.cur).padStart(8)}${trend(s).padStart(9)}   ${ago(s.last)}`
  );
  console.log(`    ${s.type}: ${String(s.message).slice(0, 90)}`);
  if (s.pages.size) console.log(`    seen on: ${[...s.pages].slice(0, 3).join(', ')}`);
}

if (done.length) {
  console.log(`\nALREADY DEALT WITH — ${done.length} signature(s)\n`);
  for (const s of done) {
    const t = s.triage;
    const stillHappening = s.cur > 0 ? `  ⚠ still ${s.cur} events, last ${ago(s.last)}` : `  (quiet since ${ago(s.last)})`;
    console.log(`  ${t.status.padEnd(9)} ${s.key}  ${String(s.message).slice(0, 60)}`);
    console.log(`    ${t.note || '(no note)'}${t.commit ? ` [${t.commit}]` : ''}${stillHappening}`);
  }
}

console.log(`\n${'='.repeat(70)}`);
console.log('mark one:  node scripts/issues.js --fix <key> --note "what was wrong" --commit <sha>');
console.log('           node scripts/issues.js --watch <key> --note "why we are leaving it"');
console.log('           node scripts/issues.js --ignore <key> --note "third-party noise"\n');

await mongoose.disconnect();
