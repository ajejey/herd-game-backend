/**
 * READ-ONLY. What removing the "-es" rule actually does to real answers.
 *
 *   node scripts/normalizer-se-replay.mjs
 *
 * A change to matching cannot be reviewed by reading it — the only honest test
 * is what it does to answers people really gave. So this replays every answer
 * in the database through BOTH the old normaliser and the new one and prints
 * every bucket that moves, in full, rather than one reassuring percentage.
 *
 * Two numbers matter and they are not the same:
 *   - answers whose key changes            (churn — expected, and fine)
 *   - rounds whose TOP ANSWER changes      (the herd itself moving — the risk)
 *
 * Writes nothing. Safe against production.
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import { stemmer } from 'stemmer';
import { normalizeAnswer as newNormalize } from '../src/utils/answerNormalizer.js';

/* ── The version being replaced, verbatim, so the comparison is real ─────── */
const ARTICLES = new Set(['a', 'an', 'the']);
const IRREGULAR = new Map(Object.entries({
  mice: 'mouse', geese: 'goose', teeth: 'tooth', feet: 'foot',
  children: 'child', people: 'person', men: 'man', women: 'woman',
  knives: 'knife', lives: 'life', wives: 'wife', leaves: 'leaf',
  halves: 'half', shelves: 'shelf', loaves: 'loaf', thieves: 'thief',
  wolves: 'wolf', calves: 'calf', selves: 'self', elves: 'elf',
  oxen: 'ox', dice: 'die', pence: 'penny',
}));
function depluralize(w) {
  if (w.length > 3 && w.endsWith('es')) {
    const base = w.slice(0, -2);
    if (/(s|x|z|sh|ch)$/.test(base)) return base;
  }
  return w;
}
function oldNormalize(answer) {
  if (!answer) return '';
  const cleaned = String(answer).toLowerCase()
    .replace(/[.,/#!$%^&*;:{}=\-_`~()?"[\]<>|\\+]/g, ' ')
    .replace(/\s+/g, ' ').trim();
  const words = cleaned.split(' ').map((w) => w.replace(/'/g, ''))
    .filter((w) => w && !ARTICLES.has(w))
    .map((w) => IRREGULAR.get(w) || depluralize(w));
  const kept = words.length ? words : cleaned.split(' ').filter(Boolean);
  const joined = kept.join('');
  return joined ? stemmer(joined) : '';
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
  const hosts = srv.map((d) => d.trim().split(/\s+/).slice(2)).map(([port, h]) => `${h.replace(/\.$/, '')}:${port}`).join(',');
  const txt = (await doh(host, 'TXT')).map((t) => t.replace(/^"|"$/g, '')).join('&');
  const [path, query = ''] = tail.replace(/^\//, '').split('?');
  return `mongodb://${creds}${hosts}/${path}?${[txt, query, 'ssl=true'].filter(Boolean).join('&')}`;
}

await mongoose.connect(await resolveSrv(process.env.MONGODB_URI || ''));
const db = mongoose.connection;

/* Every answer we have: the multiplayer game's, and the daily game's tallies. */
const answers = await db.collection('answers').find({}).project({ originalAnswer: 1, roundId: 1 }).toArray();
const tallies = await db.collection('daily_tallies').find({}).project({ answerRaw: 1, dayNumber: 1, questionId: 1, count: 1 }).toArray();

console.log(`\nreplaying ${answers.length} game answers and ${tallies.length} daily tallies\n`);

let changed = 0;
const moves = new Map();          // "old -> new" : example raw answers
for (const a of answers) {
  const raw = a.originalAnswer;
  const o = oldNormalize(raw);
  const n = newNormalize(raw);
  if (o === n) continue;
  changed += 1;
  const key = `${o} -> ${n}`;
  if (!moves.has(key)) moves.set(key, new Set());
  if (moves.get(key).size < 4) moves.get(key).add(raw);
}
for (const t of tallies) {
  const raw = t.answerRaw;
  if (!raw) continue;
  const o = oldNormalize(raw);
  const n = newNormalize(raw);
  if (o === n) continue;
  changed += 1;
  const key = `${o} -> ${n}`;
  if (!moves.has(key)) moves.set(key, new Set());
  if (moves.get(key).size < 4) moves.get(key).add(raw);
}

console.log(`keys that change: ${changed} of ${answers.length + tallies.length}`);
console.log(`distinct changes: ${moves.size}\n`);
const QUIET = process.argv.includes('--quiet');
for (const [k, examples] of (QUIET ? [] : [...moves.entries()].sort())) {
  console.log(`  ${k.padEnd(34)} e.g. ${[...examples].join(', ')}`);
}

/*
  THE NUMBER THAT MATTERS. Churn is expected; a round whose winning answer
  changes is a person who scored differently. Recomputed per round both ways.
*/
const byRound = new Map();
for (const a of answers) {
  const k = String(a.roundId);
  if (!byRound.has(k)) byRound.set(k, []);
  byRound.get(k).push(a.originalAnswer);
}
const top = (list, fn) => {
  const c = new Map();
  for (const r of list) { const k = fn(r); c.set(k, (c.get(k) || 0) + 1); }
  const max = Math.max(...c.values());
  return [...c.entries()].filter(([, v]) => v === max).map(([k]) => k).sort().join('|');
};
let roundsMoved = 0;
let merges = 0;
let splits = 0;
let renames = 0;
for (const [, list] of byRound) {
  if (list.length < 2) continue;
  const before = top(list, oldNormalize);
  const after = top(list, newNormalize);
  if (before === after) continue;
  roundsMoved += 1;
  const nb = before.split('|').length, na = after.split('|').length;
  if (na < nb) merges += 1;
  else if (na > nb) {
    splits += 1;
    console.log(`  SPLIT: before "${before}" -> after "${after}"  answers: ${list.slice(0, 12).join(" | ")}`);
  }
  else renames += 1;
}
console.log(`\nrounds whose top answer changes: ${roundsMoved} of ${byRound.size}`);
console.log(`  merges (fewer herds — the fix working): ${merges}`);
console.log(`  SPLITS (more herds — would be a regression): ${splits}`);
console.log(`  same herds, key spelled differently:        ${renames}`);
console.log('');

await mongoose.disconnect();
