/*
  The colour grid, and how close a guess landed.

  GENERATED, NOT STORED. A bank of 126 hex strings is data that drifts from the
  code that reads it — one edit and the server's idea of square G4 stops
  matching the browser's, which is unfindable from a bug report saying "the
  colours are wrong". A pure function of (col, row) cannot drift.

  14 x 9 = 126 squares. Not the boxed game's 30 x 16, and the reason is touch,
  not taste: 30 columns on a 390px phone is a 12px cell, and in a game where
  landing one square off costs a point, an unhittable target is the game
  cheating you. 14 columns gives ~25px, and the client lets a marker be moved
  before it is locked in, so a slip costs nothing.

  Columns run through hue, rows run light to dark. Both ends of the row range
  stop short of pure white and pure black, because a row of near-identical
  almost-white squares is not a guess, it is a coin flip.
*/

export const COLS = 14;
export const ROWS = 9;

/* Column 0 starts at red and wraps once around the wheel. */
const HUE_START = 0;
const HUE_SPAN = 360;

/* Kept away from the extremes so every square is a colour someone could
   describe. Pure white and pure black are not cues, they are absences. */
const LIGHT_MAX = 82;
const LIGHT_MIN = 26;
const SAT_TOP = 62;
const SAT_BOTTOM = 74;

function hslToHex(h, s, l) {
  const S = s / 100;
  const L = l / 100;
  const k = (n) => (n + h / 30) % 12;
  const a = S * Math.min(L, 1 - L);
  const f = (n) => {
    const v = L - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return Math.round(255 * v).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

/** The colour at a square. Pure; the client calls the identical function. */
export function colourAt(col, row) {
  const hue = (HUE_START + (HUE_SPAN * col) / COLS) % 360;
  const t = ROWS === 1 ? 0 : row / (ROWS - 1);
  const light = LIGHT_MAX - (LIGHT_MAX - LIGHT_MIN) * t;
  const sat = SAT_TOP + (SAT_BOTTOM - SAT_TOP) * t;
  return hslToHex(hue, sat, light);
}

/** Every square, row-major. Used by the grid renderer and by the checks. */
export function allSquares() {
  const out = [];
  for (let row = 0; row < ROWS; row += 1) {
    for (let col = 0; col < COLS; col += 1) out.push({ col, row, hex: colourAt(col, row) });
  }
  return out;
}

/*
  "G4"-style label, for saying a square out loud.

  I and O are skipped, so the letters run A-H, J-N, P. Column 8 was rendering as
  "I", and "I9" on a phone reads as nineteen — in a game where the second half
  of the label really is a number. Pack IDs on this site already leave out I and
  O for the same reason; a board label is read aloud even more often than a code
  is typed.

  Fourteen columns need fourteen letters, so the alphabet is written out rather
  than computed: A + col with two holes in it is the kind of arithmetic that is
  wrong once and then wrong forever.
*/
const COL_LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'J', 'K', 'L', 'M', 'N', 'P'];

export function labelOf(col, row) {
  return `${COL_LETTERS[col] || '?'}${row + 1}`;
}

export function inBounds(col, row) {
  return Number.isInteger(col) && Number.isInteger(row)
    && col >= 0 && col < COLS && row >= 0 && row < ROWS;
}

/*
  Distance in grid steps, counting a diagonal as ONE step (Chebyshev).

  Deliberately not straight-line distance: the scoring rings in this game are
  the squares that TOUCH the target, then the ring beyond. A diagonal
  neighbour is visually adjacent, so it has to score the same as an orthogonal
  one or the rings become a diamond and stop matching what the board shows.
*/
export function ringDistance(a, b) {
  return Math.max(Math.abs(a.col - b.col), Math.abs(a.row - b.row));
}

/** 3 for exact, 2 for touching, 1 for the next ring, 0 beyond. */
export function scoreFor(marker, target) {
  const d = ringDistance(marker, target);
  if (d === 0) return 3;
  if (d === 1) return 2;
  if (d === 2) return 1;
  return 0;
}
