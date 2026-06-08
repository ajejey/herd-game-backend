/*
  Spectrum — a "guess the point on the scale" game (Wavelength-inspired, original
  wording). Each round shows a spectrum between two opposites; a hidden target
  sits somewhere on it. The clue-giver sees the target and gives a clue; everyone
  else slides to where they think it is.
*/
export const PAIRS = [
  ['Cold', 'Hot'],
  ['Underrated', 'Overrated'],
  ['Useless', 'Useful'],
  ['Weird', 'Normal'],
  ['Cheap', 'Expensive'],
  ['Not scary', 'Terrifying'],
  ['Unhealthy', 'Healthy'],
  ['Introvert', 'Extrovert'],
  ['Old-fashioned', 'Modern'],
  ['Easy', 'Hard'],
  ['Boring', 'Exciting'],
  ['Quiet', 'Loud'],
  ['Casual', 'Formal'],
  ['Forgettable', 'Memorable'],
  ['Guilty pleasure', 'Universally loved'],
  ['Round', 'Pointy'],
  ['Common', 'Rare'],
  ['Dangerous', 'Safe'],
  ['Underhyped', 'Overhyped'],
  ['Childish', 'Mature'],
  ['Wet', 'Dry'],
  ['Bad superpower', 'Great superpower'],
  ['Fantasy', 'Sci-fi'],
  ['Disgusting', 'Delicious'],
  ['Light', 'Heavy'],
  ['Slow', 'Fast'],
  ['Ugly', 'Beautiful'],
  ['Inappropriate', 'Appropriate'],
  ['Worst food', 'Best food'],
  ['Villain', 'Hero'],
  ['Smells bad', 'Smells great'],
  ['Unpopular opinion', 'Popular opinion'],
  ['Low effort', 'High effort'],
  ['Temporary', 'Permanent'],
  ['Basic', 'Fancy'],
  ['Overthinking', 'Not thinking at all'],
];

export function getSpectrum(usedPairs = []) {
  const usedKey = new Set(usedPairs);
  let pool = PAIRS.filter((p) => !usedKey.has(p[0] + '|' + p[1]));
  if (pool.length === 0) pool = [...PAIRS];
  const [left, right] = pool[Math.floor(Math.random() * pool.length)];
  // Target somewhere in 8..92 so it's never pinned to an edge.
  const target = 8 + Math.floor(Math.random() * 85);
  return { leftLabel: left, rightLabel: right, target };
}

// Distance → points: bullseye 4, then 3/2/1, else 0.
export function scoreGuess(value, target) {
  const d = Math.abs(value - target);
  if (d <= 5) return 4;
  if (d <= 11) return 3;
  if (d <= 18) return 2;
  if (d <= 26) return 1;
  return 0;
}
