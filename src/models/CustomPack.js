import mongoose from 'mongoose';

/*
  A host-written set of questions, addressed by a short PACK CODE.

  Deliberately has no owner account. The pack code is a bearer token, exactly
  like the four-letter room code players already trust: whoever has it can play
  it. That buys the two things the two hosts who wrote in actually asked for —
  reuse ("run it again next term") and cross-device ("write it on a laptop,
  play it from a phone") — without putting a signup in front of the first
  feature anyone has ever requested.

  Accounts can claim packs later; `creatorAnonId` is kept so an existing pack
  can be adopted into an account without the host losing anything.

  NOT browsable. There is no listing endpoint, no search and no gallery, and
  that is a deliberate product decision rather than an omission: a private
  document shared between people who already know each other is not a
  user-generated-content platform, which is what Apple guideline 1.2 and
  Google's UGC policy are aimed at. See CUSTOM_PACKS_PLAN.md.
*/

// No I/O/0/1 — these get read aloud and typed in by hand at parties.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/*
  Hot Takes is deliberately NOT here. It is a daily single-player game served
  over REST, with no host and no room, so a pack has nothing to attach to.
  Scattergories takes its place — plain category prompts, and it is the busiest
  party game on the site.
*/
export const PACK_GAMES = ['herd', 'teamtrivia', 'sayanything', 'wyr', 'scattergories'];

/*
  Limits live in packParse.js, next to the code that enforces them.

  This file used to export its own PACK_LIMITS as well — same name, three keys
  short (no maxAnswerLen, minAnswers or maxAnswers). Nothing imported it, but it
  was one autocomplete away from being picked instead, and every check against
  the three missing keys would then have compared against undefined and passed.
  Two constants with one name is a trap, not a convenience.
*/
export { PACK_LIMITS } from './packParse.js';

const customPackSchema = new mongoose.Schema({
  packCode: { type: String, required: true, unique: true, index: true },
  game: { type: String, required: true, enum: PACK_GAMES, default: 'herd' },
  title: { type: String, default: '' },
  // Two shapes, discriminated by `game`:
  //   herd/sayanything/wyr/hottakes -> `questions`, plain prompts
  //   teamtrivia                    -> `mcq`, each with its options
  questions: { type: [String], default: [] },
  mcq: {
    type: [{ _id: false, q: String, options: [String] }],
    default: [],
  },
  // Would You Rather: two choices per round.
  pairs: {
    type: [{ _id: false, a: String, b: String }],
    default: [],
  },
  creatorAnonId: { type: String, default: '' },
  uses: { type: Number, default: 0 },
  reported: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now },
  // Expiry is driven by lastUsedAt and REFRESHED on every use, so a one-off
  // party pack ages out while a teacher's weekly set never does.
  lastUsedAt: { type: Date, default: Date.now, expires: 60 * 60 * 24 * 180 },
});

customPackSchema.statics.generatePackCode = async function generatePackCode() {
  for (let attempt = 0; attempt < 12; attempt++) {
    let code = '';
    for (let i = 0; i < 6; i++) {
      code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
    }
    // eslint-disable-next-line no-await-in-loop
    const clash = await this.exists({ packCode: code });
    if (!clash) return code;
  }
  throw new Error('Could not allocate a pack code');
};

/*
  Parsing lives in packParse.js. It is not duplicated here.

  This file used to carry parseQuestions() and parseMcq() — ~70 lines of a
  second, stricter parser that nothing called. parseMcq only accepted "|",
  rejecting the tab, semicolon, slash and comma inputs packParse.js exists to
  accept, so anyone who wired it up believing it current would have silently
  reinstated the strict behaviour the forgiving parser was written to replace.
  packParse.js says in its own header that two copies would drift and the host
  would be the one to find out; keeping a dead one here was that risk, dormant.
*/

export default mongoose.model('CustomPack', customPackSchema);
