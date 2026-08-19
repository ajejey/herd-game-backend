/**
 * READ-ONLY analysis of real Daily Herd answers: which distinct answers were
 * almost certainly the same thing, and what it cost the player.
 *
 *   node scripts/answer-merge-analysis.js
 *
 * Herd Mentality is a game about matching the crowd, so every answer that
 * should have merged and did not is a player told they were an outlier when
 * they were with the herd. That is the worst possible failure for this
 * particular game — it does not look like a bug, it looks like the game
 * disagreeing with you.
 *
 * Writes nothing. Every query here is a find().
 */
import 'dotenv/config';
import mongoose from 'mongoose';

const TALLIES = 'daily_tallies';

/* ---------------------------------------------------------------- helpers */

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length || !b.length) return Math.max(a.length, b.length);
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    prev = cur;
  }
  return prev[b.length];
}

/* A light stem: enough to relate noise/noisy/noises, run/running, happy/happiness. */
function stem(w) {
  let s = w;
  const strip = (suf, min) => {
    if (s.length > min && s.endsWith(suf)) s = s.slice(0, -suf.length);
  };
  strip('iness', 5); strip('ness', 5); strip('ingly', 6); strip('edly', 5);
  strip('ing', 4);   strip('ies', 4);  strip('es', 4);    strip('ed', 4);
  strip('ly', 4);    strip('er', 4);   strip('est', 5);   strip('y', 3);
  if (s.length > 3 && s.endsWith('s') && !s.endsWith('ss')) s = s.slice(0, -1);
  return s;
}

/* Would a reasonable person call these the same answer? */
function probablySame(a, b) {
  if (a === b) return null;
  const sa = stem(a);
  const sb = stem(b);
  if (sa === sb) return 'same stem';
  if (sa.length >= 4 && sb.length >= 4) {
    if (sa.startsWith(sb) || sb.startsWith(sa)) return 'one contains the other';
    const d = levenshtein(sa, sb);
    if (d === 1) return 'one character apart';
    if (d === 2 && Math.min(sa.length, sb.length) >= 6) return 'two characters apart';
  }
  // "ice cream" vs "icecream", "hot dog" vs "hotdog"
  if (a.replace(/\s+/g, '') === b.replace(/\s+/g, '')) return 'spacing only';
  return null;
}

/* ------------------------------------------------------------------- main */

const raw = process.env.MONGODB_URI;
if (!raw) {
  console.error('MONGODB_URI not set.');
  process.exit(1);
}

/*
  mongodb+srv needs a DNS SRV lookup, and some networks (this one included)
  refuse SRV queries outright — which surfaces as querySrv ECONNREFUSED and
  looks like the database is down when it is perfectly healthy. Resolve the
  same records over DNS-over-HTTPS and rewrite to a direct connection string.

  This is exactly what the driver does internally; nothing here is a shortcut
  around authentication or TLS.
*/
async function resolveSrv(uri) {
  if (!uri.startsWith('mongodb+srv://')) return uri;

  const rest = uri.slice('mongodb+srv://'.length);
  const at = rest.lastIndexOf('@');
  const creds = at === -1 ? '' : rest.slice(0, at + 1);
  const after = at === -1 ? rest : rest.slice(at + 1);
  const slash = after.indexOf('/');
  const host = slash === -1 ? after : after.slice(0, slash);
  const tail = slash === -1 ? '' : after.slice(slash);

  const doh = async (name, type) => {
    const r = await fetch(`https://dns.google/resolve?name=${name}&type=${type}`, {
      signal: AbortSignal.timeout(10000),
    });
    const j = await r.json();
    return (j.Answer || []).map((a) => a.data);
  };

  const srv = await doh(`_mongodb._tcp.${host}`, 'SRV');
  if (!srv.length) return uri; // let the driver try and fail honestly

  const hosts = srv
    .map((d) => d.trim().split(/\s+/).slice(2))    // "0 0 27017 host."
    .map(([port, h]) => `${h.replace(/\.$/, '')}:${port}`)
    .join(',');

  const txt = (await doh(host, 'TXT')).map((t) => t.replace(/^"|"$/g, '')).join('&');

  const [path, query = ''] = tail.replace(/^\//, '').split('?');
  const opts = [txt, query, 'ssl=true'].filter(Boolean).join('&');

  return `mongodb://${creds}${hosts}/${path}?${opts}`;
}

const uri = await resolveSrv(raw);
await mongoose.connect(uri);
const conn = mongoose.connection;
console.log(`connected to ${conn.name} (read-only analysis)\n`);

const rows = await conn
  .collection(TALLIES)
  .find({}, { projection: { dayNumber: 1, questionId: 1, answerNorm: 1, answerRaw: 1, count: 1, _id: 0 } })
  .toArray();

if (rows.length === 0) {
  console.log('no tallies recorded yet.');
  await mongoose.disconnect();
  process.exit(0);
}

// Group by the question as asked on a given day.
const groups = new Map();
for (const r of rows) {
  const key = `${r.dayNumber}:${r.questionId}`;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(r);
}

let totalAnswers = 0;
let mergeableAnswers = 0;
const findings = [];

for (const [key, list] of groups) {
  const answers = list.filter((r) => r.answerNorm);
  const votes = answers.reduce((n, r) => n + (r.count || 0), 0);
  totalAnswers += votes;
  if (answers.length < 2) continue;

  answers.sort((a, b) => (b.count || 0) - (a.count || 0));

  for (let i = 0; i < answers.length; i++) {
    for (let j = i + 1; j < answers.length; j++) {
      const why = probablySame(answers[i].answerNorm, answers[j].answerNorm);
      if (!why) continue;
      const smaller = Math.min(answers[i].count || 0, answers[j].count || 0);
      mergeableAnswers += smaller;
      findings.push({
        key,
        a: answers[i].answerRaw || answers[i].answerNorm,
        b: answers[j].answerRaw || answers[j].answerNorm,
        ca: answers[i].count || 0,
        cb: answers[j].count || 0,
        why,
        votes,
        // Would merging have changed who "won" the question?
        flipsTop: j > 0 && i === 0 && (answers[i].count || 0) + (answers[j].count || 0) > (answers[0].count || 0),
      });
    }
  }
}

findings.sort((x, y) => Math.min(y.ca, y.cb) - Math.min(x.ca, x.cb));

console.log(`${rows.length} tally rows across ${groups.size} question-days, ${totalAnswers} answers cast\n`);
console.log(`answers that probably should have merged: ${mergeableAnswers} (${((mergeableAnswers / totalAnswers) * 100).toFixed(1)}% of all answers)\n`);

console.log('biggest missed merges:');
for (const f of findings.slice(0, 25)) {
  console.log(
    `  "${f.a}" (${f.ca}) + "${f.b}" (${f.cb})  —  ${f.why}` +
      (f.flipsTop ? '   ← would change the top answer' : '')
  );
}

const byReason = findings.reduce((m, f) => {
  m[f.why] = (m[f.why] || 0) + 1;
  return m;
}, {});
console.log('\nby reason:');
Object.entries(byReason)
  .sort((a, b) => b[1] - a[1])
  .forEach(([why, n]) => console.log(`  ${String(n).padStart(4)}  ${why}`));

await mongoose.disconnect();
