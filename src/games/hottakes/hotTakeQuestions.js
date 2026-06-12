/*
  Daily Hot Takes — this-or-that opinion questions.

  Each question has two options; each option carries archetype tags. A player's
  picks sum into an opinion archetype, and the backend tallies how everyone
  answered so we can show the crowd split ("you're in the spicy 23%").

  Same N questions for everyone on a given day (seeded by day number).
*/

// Opinion archetypes (kept in sync with the frontend's hotTakeData.js).
// maxi, mini, romantic, pragmatic, rebel, connector
export const QUESTIONS = [
  { id: 'party', prompt: 'Your ideal night?', a: { label: 'Big party', tags: { maxi: 2, connector: 1 } }, b: { label: 'Small gathering', tags: { mini: 2, romantic: 1 } } },
  { id: 'text', prompt: 'A text comes in. You…', a: { label: 'Reply instantly', tags: { connector: 2, romantic: 1 } }, b: { label: 'Get to it later', tags: { mini: 2, pragmatic: 1 } } },
  { id: 'plan', prompt: 'A free weekend?', a: { label: 'Plan it out', tags: { pragmatic: 2 } }, b: { label: 'Go with the flow', tags: { rebel: 1, maxi: 2 } } },
  { id: 'seat', prompt: 'On a plane?', a: { label: 'Window seat', tags: { romantic: 2, mini: 1 } }, b: { label: 'Aisle seat', tags: { pragmatic: 2, connector: 1 } } },
  { id: 'tabs', prompt: 'Browser tabs open?', a: { label: 'Three, tidy', tags: { mini: 2, pragmatic: 1 } }, b: { label: 'Thirty, chaos', tags: { maxi: 2 } } },
  { id: 'pizza', prompt: 'Pineapple on pizza?', a: { label: 'Absolutely', tags: { rebel: 2 } }, b: { label: 'Never', tags: { pragmatic: 1, mini: 1 } } },
  { id: 'movie', prompt: 'Movie night?', a: { label: 'Cozy at home', tags: { mini: 1, romantic: 2 } }, b: { label: 'Out at the cinema', tags: { connector: 1, maxi: 2 } } },
  { id: 'owl', prompt: 'You come alive…', a: { label: 'Early morning', tags: { pragmatic: 2 } }, b: { label: 'Late at night', tags: { rebel: 1, romantic: 2 } } },
  { id: 'best', prompt: 'The best bite on the plate?', a: { label: 'Save it for last', tags: { pragmatic: 1, mini: 2 } }, b: { label: 'Eat it first', tags: { maxi: 2, rebel: 1 } } },
  { id: 'work', prompt: 'Get it done…', a: { label: 'As a group', tags: { connector: 2 } }, b: { label: 'Solo', tags: { mini: 1, pragmatic: 2 } } },
  { id: 'trip', prompt: 'A trip is best when it’s…', a: { label: 'Spontaneous', tags: { rebel: 2, maxi: 1 } }, b: { label: 'Fully planned', tags: { pragmatic: 2 } } },
  { id: 'call', prompt: 'To reach a friend?', a: { label: 'Call them', tags: { connector: 2, romantic: 1 } }, b: { label: 'Text them', tags: { mini: 1, pragmatic: 2 } } },
  { id: 'reread', prompt: 'Books and shows?', a: { label: 'Rewatch favorites', tags: { romantic: 2, mini: 1 } }, b: { label: 'Always something new', tags: { maxi: 1, rebel: 2 } } },
  { id: 'dress', prompt: 'Getting ready?', a: { label: 'Dress up', tags: { maxi: 2, connector: 1 } }, b: { label: 'Comfy always', tags: { mini: 2 } } },
  { id: 'taste', prompt: 'Pick a snack.', a: { label: 'Sweet', tags: { romantic: 2 } }, b: { label: 'Savory', tags: { pragmatic: 2 } } },
  { id: 'peace', prompt: 'In a debate you…', a: { label: 'Say the loud thing', tags: { rebel: 2 } }, b: { label: 'Keep the peace', tags: { connector: 1, romantic: 2 } } },
  { id: 'beach', prompt: 'Dream getaway?', a: { label: 'Beach', tags: { connector: 1, maxi: 2 } }, b: { label: 'Mountains', tags: { mini: 2, romantic: 1 } } },
  { id: 'subs', prompt: 'Watching a film?', a: { label: 'Subtitles on', tags: { pragmatic: 2, mini: 1 } }, b: { label: 'Subtitles off', tags: { rebel: 2 } } },
  { id: 'thrift', prompt: 'New wardrobe?', a: { label: 'Brand new', tags: { maxi: 2 } }, b: { label: 'Thrifted finds', tags: { rebel: 1, romantic: 2 } } },
  { id: 'lead', prompt: 'On a group plan?', a: { label: 'Make the plan', tags: { connector: 1, pragmatic: 2 } }, b: { label: 'Happily follow', tags: { mini: 2 } } },
];

export const QUESTIONS_PER_DAY = 7;

const EPOCH = Date.UTC(2026, 5, 1); // 2026-06-01 = day 1
export function getDayNumber(now = new Date()) {
  const todayUTC = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.floor((todayUTC - EPOCH) / 86400000) + 1;
}

function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function seededShuffle(arr, rng) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

const byId = Object.fromEntries(QUESTIONS.map((q) => [q.id, q]));
export const isValidQuestionId = (id) => Object.prototype.hasOwnProperty.call(byId, id);
export const getQuestion = (id) => byId[id];

// Same N for everyone today. Client gets prompt + option labels only (no tags).
export function getDailyQuestions(day) {
  const rng = mulberry32((day || 1) * 2654435761);
  return seededShuffle(QUESTIONS, rng).slice(0, QUESTIONS_PER_DAY)
    .map((q) => ({ id: q.id, prompt: q.prompt, options: [q.a.label, q.b.label] }));
}

// Sum archetype tags across the chosen options → top archetype (deterministic
// tiebreak by day seed so a replay is stable).
const ARCHETYPE_IDS = ['maxi', 'mini', 'romantic', 'pragmatic', 'rebel', 'connector'];
export function computeArchetype(day, picks) {
  const totals = Object.fromEntries(ARCHETYPE_IDS.map((k) => [k, 0]));
  for (const p of picks) {
    const q = byId[p.questionId];
    if (!q) continue;
    const opt = p.optIdx === 0 ? q.a : q.b;
    for (const [k, n] of Object.entries(opt.tags)) totals[k] += n;
  }
  const rng = mulberry32((day || 1) * 40503 + 11);
  const order = seededShuffle(ARCHETYPE_IDS, rng);
  let best = order[0];
  for (const k of order) if (totals[k] > totals[best]) best = k;
  return best;
}
