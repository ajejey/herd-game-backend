/*
  Words that are not cues.

  "Blue" is not a clue for a blue square, it is the answer — the same category
  of thing as saying the secret word in Caveman Clues, and refused the same way:
  before anyone sees it, with no penalty, because it is not a funny slip, it
  ends the round.

  Two families:

    COLOUR_WORDS   the colours themselves, plus the shades people reach for
                   first. Matched on a normalised form, so "Blues", "BLUE" and
                   "blue," are all the same word.

    POSITION_WORDS the other way to cheat. "Row four", "top left", "column G"
                   describe the BOARD rather than the colour, and turn a
                   guessing game into dictation. The board is visible to
                   everyone, so a positional cue is not clever, it is the end
                   of the game.

  Deliberately not exhaustive. It blocks the obvious cheats; it is not trying to
  police creativity, and over-blocking is worse than under-blocking — a legal
  cue refused is the game calling you a cheat.
*/

/*
  Only words whose PRIMARY meaning is a colour, plus the shade modifiers.

  Deliberately NOT every word that has a colour associated with it. "Rust",
  "coffee", "jade", "moss", "salmon" and "honey" are things first — and "it
  reminds me of rust" is exactly the cue this game is asking for. The boxed
  rules ban any word that is a colour, which on a screen with no human referee
  turns into the game calling you a cheat for playing it properly.

  The test for inclusion: would someone say this word if they were NOT thinking
  about the board? "Ochre", no. "Coffee", yes.
*/
export const COLOUR_WORDS = new Set(`
red orange yellow green blue purple pink brown black white grey gray
violet indigo cyan magenta fuchsia turquoise teal aqua azure
crimson scarlet maroon burgundy beige tan khaki taupe mauve lilac lavender
periwinkle ochre chartreuse vermilion cerulean
hue shade tint tone colour color colours colors pastel neon
light dark pale deep bright dull vivid muted
`.trim().split(/\s+/));

export const POSITION_WORDS = new Set(`
row rows column columns col grid square squares board cell cells
top bottom left right centre center middle corner edge side
up down above below under over across along
north south east west
one two three four five six seven eight nine ten eleven twelve
thirteen fourteen first second third fourth fifth sixth seventh eighth ninth
`.trim().split(/\s+/));

/* Same normalisation the cue checker uses, so a word cannot be smuggled past
   with punctuation or a plural. */
export function normalise(word) {
  return String(word || '')
    .toLowerCase()
    .replace(/[^a-z]/g, '')
    .replace(/s$/, '');
}

const NORMALISED_COLOURS = new Set([...COLOUR_WORDS].map(normalise));
const NORMALISED_POSITIONS = new Set([...POSITION_WORDS].map(normalise));

/**
 * Why a cue is not allowed, or null when it is fine.
 * Returns a reason the player can act on, never a bare rejection.
 */
export function rejectCue(text, expectedWords) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean);

  if (!words.length) return { reason: 'empty', message: 'Type a cue first.' };

  if (words.length !== expectedWords) {
    return {
      reason: 'wordcount',
      message: expectedWords === 1
        ? `One word only — that was ${words.length}.`
        : `Exactly two words — that was ${words.length}.`,
    };
  }

  for (const w of words) {
    const n = normalise(w);
    if (NORMALISED_COLOURS.has(n)) {
      return { reason: 'colour', message: `"${w}" names a colour. Say what the colour reminds you of instead.` };
    }
    if (NORMALISED_POSITIONS.has(n)) {
      return { reason: 'position', message: `"${w}" describes the board, not the colour. Everyone can see the board.` };
    }
  }
  return null;
}
