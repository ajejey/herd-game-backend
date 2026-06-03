/*
  Original keyword bank for Clover Clues (our So Clover-style co-op word game).
  Concrete, picturable single-word nouns that link well with one-word clues.
  Written for this project — no copied card content.
*/
export const KEYWORDS = [
  'apple', 'river', 'moon', 'guitar', 'dragon', 'coffee', 'pirate', 'rainbow',
  'castle', 'rocket', 'jungle', 'cookie', 'thunder', 'mirror', 'anchor', 'feather',
  'volcano', 'pillow', 'candle', 'compass', 'diamond', 'forest', 'glacier', 'harbor',
  'island', 'jacket', 'kettle', 'ladder', 'magnet', 'needle', 'orchard', 'parade',
  'quilt', 'rabbit', 'saddle', 'temple', 'umbrella', 'violin', 'whistle', 'yacht',
  'acorn', 'bridge', 'cactus', 'dolphin', 'engine', 'falcon', 'garden', 'helmet',
  'igloo', 'jigsaw', 'kitten', 'lantern', 'meadow', 'nugget', 'octopus', 'pyramid',
  'quartz', 'ribbon', 'sunset', 'tunnel', 'unicorn', 'vortex', 'walnut', 'xylophone',
  'yogurt', 'zebra', 'balloon', 'cherry', 'desert', 'eagle', 'fountain', 'glove',
  'hammer', 'iceberg', 'jelly', 'kangaroo', 'lemon', 'mountain', 'nest', 'oyster',
  'penguin', 'quiver', 'rooster', 'spider', 'tractor', 'velvet', 'wagon', 'yarn',
  'almond', 'beacon', 'circus', 'donkey', 'ember', 'ferry', 'goblin', 'hedge',
  'ink', 'jewel', 'knight', 'lagoon', 'marble', 'noodle', 'onion', 'puddle',
  'quail', 'reef', 'sailor', 'tiger', 'urchin', 'vine', 'willow', 'yeti',
  'amber', 'bison', 'comet', 'dune', 'echo', 'fern', 'grape', 'honey',
  'iris', 'jaguar', 'kite', 'lily', 'maze', 'nickel', 'opal', 'plum',
  'quill', 'raven', 'spruce', 'toad', 'vault', 'whale', 'acre', 'breeze',
  'clover', 'drum', 'fox', 'grain', 'harp', 'lantern2', 'moss', 'pearl',
  'robin', 'shell', 'torch', 'wheat', 'badge', 'cliff', 'flame', 'lobster',
];

// Light de-dupe of any accidental repeats / placeholder tokens.
const CLEAN = [...new Set(KEYWORDS.map((k) => k.replace(/\d+$/, '')))];

export function drawKeywords(n, exclude = new Set()) {
  const pool = CLEAN.filter((k) => !exclude.has(k));
  // Fisher–Yates partial shuffle.
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, n);
}

export const KEYWORD_COUNT = CLEAN.length;
