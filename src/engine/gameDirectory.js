/*
  Which socket namespace is which game, in words a player would recognise.

  Needed because every engine game shares ONE room store. Codes are unique
  across all of them, so a code typed on the wrong game's page used to resolve
  perfectly and drop that person into a different game's room — Team Trivia's
  view rendering a Scattergories room. Nothing errored; their screen was simply
  wrong, which is why it only ever surfaced as "not working".

  Refusing that join is most of the fix. Being able to say WHICH game the code
  belongs to, and where to find it, is the rest — the code is not wrong, the
  page is, and that is a one-tap problem if we say so.

  `path` is the public route on the site, not the namespace: /twotruths is
  served at /two-truths-and-a-lie.
*/
export const GAME_DIRECTORY = {
  '/sa': { name: 'Say Anything', path: '/say-anything' },
  '/guesstimate': { name: 'Guesstimate', path: '/guesstimate' },
  '/clover': { name: 'Clover', path: '/clover' },
  '/teamtrivia': { name: 'Team Trivia', path: '/team-trivia' },
  '/chameleon': { name: 'Chameleon', path: '/chameleon' },
  '/spectrum': { name: 'Spectrum', path: '/spectrum' },
  '/twotruths': { name: 'Two Truths and a Lie', path: '/two-truths-and-a-lie' },
  '/scattergories': { name: 'Scattergories', path: '/scattergories' },
  '/wyr': { name: 'Would You Rather', path: '/would-you-rather' },
  '/fishbowl': { name: 'Fishbowl', path: '/fishbowl' },
  '/taboo': { name: 'Taboo', path: '/taboo' },
};

export function describeGame(namespace) {
  return GAME_DIRECTORY[namespace] || null;
}

/**
 * The message a player sees when their code is right but the page is wrong.
 * Names the game rather than saying "invalid", because the code IS valid.
 */
export function wrongGameMessage(roomNamespace) {
  const dest = describeGame(roomNamespace);
  return dest
    ? `That code is for ${dest.name}, not this game. Open ${dest.name} and join with the same code.`
    : 'That code belongs to a different game on the site. Check which game the host is running.';
}
