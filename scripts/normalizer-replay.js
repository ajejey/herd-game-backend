/**
 * READ-ONLY. Replays every answer ever recorded through the new normalizer and
 * reports exactly what would change.
 *
 *   node scripts/normalizer-replay.js
 *
 * A change to matching cannot be reviewed by reading it. The only honest test
 * is what it does to real answers, and the number that matters is not how many
 * merges it makes — it is how many merges it makes that are WRONG. So this
 * prints the merges in full and flags the suspicious ones rather than reporting
 * a single reassuring percentage.
 *
 * Writes nothing.
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import { normalizeAnswer } from '../src/utils/answerNormalizer.js';

/* The version this replaces, kept verbatim so the comparison is real. */
function oldNormalize(answer) {
  if (!answer) return '';
  return answer
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[.,/#!$%^&*;:{}=\-_`~()]/g, '')
    .replace(/s$/i, '')
    .replace(/\b(a|an|the)\b/g, '')
    .trim();
}

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

const uri = await resolveSrv(process.env.MONGODB_URI || '');
await mongoose.connect(uri);
const conn = mongoose.connection;

const rows = await conn
  .collection('daily_tallies')
  .find({}, { projection: { dayNumber: 1, questionId: 1, answerRaw: 1, answerNorm: 1, count: 1, _id: 0 } })
  .toArray();

const groups = new Map();
for (const r of rows) {
  const k = `${r.dayNumber}:${r.questionId}`;
  if (!groups.has(k)) groups.set(k, []);
  groups.get(k).push(r);
}

let answers = 0;
let moved = 0;
let topFlips = 0;
const merges = new Map(); // newKey -> Set(raw forms)
const suspicious = [];

for (const [, list] of groups) {
  const votes = list.reduce((n, r) => n + (r.count || 0), 0);
  answers += votes;

  const before = new Map();
  const after = new Map();
  for (const r of list) {
    const raw = r.answerRaw || r.answerNorm || '';
    const o = oldNormalize(raw);
    const n = normalizeAnswer(raw);
    before.set(o, (before.get(o) || 0) + (r.count || 0));
    after.set(n, (after.get(n) || 0) + (r.count || 0));
    if (!merges.has(n)) merges.set(n, new Set());
    merges.get(n).add(raw);
  }

  const topBefore = [...before.entries()].sort((a, b) => b[1] - a[1])[0];
  const topAfter = [...after.entries()].sort((a, b) => b[1] - a[1])[0];
  if (topBefore && topAfter && oldNormalize(topAfter[0]) !== topBefore[0] && topAfter[1] !== topBefore[1]) {
    topFlips += 1;
  }
  moved += Math.max(0, before.size - after.size);
}

const merged = [...merges.entries()].filter(([, forms]) => forms.size > 1);

/*
  A merge is suspicious when the forms are not obviously the same word — the
  cheap proxy being that neither raw form contains the other once spaces and
  case are gone. Those are the ones worth a human eye.
*/
for (const [key, formsSet] of merged) {
  const forms = [...formsSet];
  const flat = forms.map((f) => f.toLowerCase().replace(/[^a-z0-9]/g, ''));
  for (let i = 0; i < flat.length; i++) {
    for (let j = i + 1; j < flat.length; j++) {
      const a = flat[i];
      const b = flat[j];
      if (!a.includes(b) && !b.includes(a)) suspicious.push({ key, a: forms[i], b: forms[j] });
    }
  }
}

console.log(`${rows.length} tally rows, ${answers} answers, ${groups.size} question-days\n`);
console.log(`buckets that collapsed into another: ${moved}`);
console.log(`question-days where the top answer changes: ${topFlips}\n`);

console.log(`merge groups formed: ${merged.length}. A sample:\n`);
merged
  .sort((a, b) => b[1].size - a[1].size)
  .slice(0, 20)
  .forEach(([key, forms]) => console.log(`  ${key.padEnd(18)} ← ${[...forms].join(' | ')}`));

console.log(`\nmerges where neither form contains the other (worth a human look): ${suspicious.length}`);
suspicious.slice(0, 25).forEach((s) => console.log(`  "${s.a}"  +  "${s.b}"   → ${s.key}`));

await mongoose.disconnect();
