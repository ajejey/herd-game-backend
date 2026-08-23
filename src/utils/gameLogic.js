import Answer from '../models/Answer.js';
import { PREDEFINED_QUESTIONS } from './constants.js';

/**
 * Analyzes answers for a round and determines:
 * 1. Majority answer
 * 2. Unique answer (if any)
 * 3. Players who get points
 */
export async function analyzeRoundAnswers(roundId) {
  const answers = await Answer.find({ roundId });
  if (!answers.length) return null;

  // Count normalized answers
  const answerCounts = {};
  answers.forEach(answer => {
    const normalized = answer.normalizedAnswer;
    answerCounts[normalized] = (answerCounts[normalized] || 0) + 1;
  });

  // Find majority answer(s)
  const maxCount = Math.max(...Object.values(answerCounts));
  const majorityAnswers = Object.entries(answerCounts)
    .filter(([_, count]) => count === maxCount)
    .map(([answer]) => answer);

  // Find unique answers (answers given by only one player)
  const uniqueAnswers = Object.entries(answerCounts)
    .filter(([_, count]) => count === 1)
    .map(([answer]) => answer);

  // Get players who gave unique answers
  const uniquePlayers = uniqueAnswers.length === 1
    ? answers.find(a => uniqueAnswers.includes(a.normalizedAnswer))?.playerId
    : null;

  /*
    A TIE IS STILL A HERD.

    This used to award points only when there was a single top answer:

        majorityAnswers.length === 1 ? ...matching players... : []

    so a round where three people said "food" and three said "evangelism"
    scored NOBODY — six players matched someone exactly and every one of them
    was shown "Tied", zero points, and "No majority answer". In a game whose
    entire premise is that you score by matching the group, that reads as the
    game being broken, and a player wrote in to say exactly that: "Two entries
    were exactly the same but didn't match."

    It is not rare. Across 1,122 recent rounds, 32 threw away real agreement —
    including one round where three separate pairs matched and all six players
    got nothing.

    So: every player in every tied top group scores. `agreed` is the guard that
    keeps the genuine case correct — when the top count is 1 nobody matched
    anybody, and nobody should score.
  */
  const agreed = maxCount >= 2;
  const scoringPlayers = agreed
    ? answers
        .filter(a => majorityAnswers.includes(a.normalizedAnswer))
        .map(a => a.playerId)
    : [];

  /*
    THE WORD TO PRINT, as somebody actually typed it.

    `majorityAnswers` holds NORMALISED keys — spacing collapsed, articles
    dropped, plurals stemmed — because that is what decides who matched whom.
    They were also what the results screen printed, so a room where everyone
    said "cheese sandwich" was told, in the largest text on the page,

        The herd said  cheesesandwich

    and a room that agreed on "running" was told the herd said "run". The
    machine's spelling of a word is not a word, and the one screen where players
    check whether the game understood them is the worst place to show it.

    So each herd also carries a label: the most common original spelling among
    the people in it, which is by definition something a human in this room
    typed. Ties fall to whoever said it first, which is as good a rule as any
    when two spellings are equally popular.
  */
  const labelFor = (norm) => {
    const originals = answers
      .filter((a) => a.normalizedAnswer === norm)
      .map((a) => String(a.originalAnswer || '').trim())
      .filter(Boolean);
    const tally = new Map();
    for (const o of originals) tally.set(o, (tally.get(o) || 0) + 1);
    let best = originals[0] || norm;
    let bestCount = 0;
    for (const [word, count] of tally) {
      if (count > bestCount) { best = word; bestCount = count; }
    }
    return best;
  };

  return {
    // Kept for older clients: a single herd, or null. The Android app ships a
    // frozen bundle, so it will keep reading this one for a while — which is
    // fine, because the POINTS above are now right regardless of what any
    // client chooses to render.
    //
    // `agreed` guards this too, or a round with a single answer (everyone else
    // dropped) would report that answer as the majority while scoring nobody —
    // the screen then says "Majority Answer: x" and badges the same player
    // "Unique, +0" directly underneath it.
    majorityAnswer: agreed && majorityAnswers.length === 1 ? majorityAnswers[0] : null,
    // Every herd that scored this round, so a client can show "two herds tied,
    // both score" instead of silently calling it nothing.
    majorityAnswers: agreed ? majorityAnswers : [],
    // The same herds, spelled the way the room spelled them. Clients should
    // print these and match on the ones above.
    majorityLabels: agreed ? majorityAnswers.map(labelFor) : [],
    uniqueAnswerPlayer: uniquePlayers,
    scoringPlayers,
    allAnswers: answers.map(a => ({
      playerId: a.playerId,
      username: a.username,
      answer: a.originalAnswer
    }))
  };
}

/**
 * Determines if the pink cow should move and to whom
 */
export function determinePinkCowHolder(currentHolder, uniqueAnswerPlayer) {
  // If there's exactly one unique answer and it's from a different player
  if (uniqueAnswerPlayer && uniqueAnswerPlayer.toString() !== (currentHolder || '').toString()) {
    return uniqueAnswerPlayer.toString();
  }
  // Otherwise, pink cow stays where it is
  return currentHolder ? currentHolder.toString() : null;
}

/*
  The win rule: 8 points, and not holding the pink cow.

  Two things were wrong with this.

  It compared `player._id !== pinkCowHolder` — a Mongoose ObjectId against the
  string the holder is stored as — which is never equal, so it would have called
  the cow holder a winner and undone the only rule the pink cow has. That never
  shipped for one reason: nothing called it. index.js wrote the rule out by hand
  in three separate handlers instead, and a rule kept in three places is a rule
  that will be correct in two of them. That is precisely how tied herds came to
  score nobody — one expression of "who scores", in two places, agreeing until
  it didn't.

  So: one definition, compared as strings, used everywhere.
*/
export function checkWinCondition(player, pinkCowHolder) {
  return (player.score || 0) >= 8 && String(player._id) !== String(pinkCowHolder || '');
}

/**
 * The highest scorer who can actually win right now, or null if nobody can.
 * Ties on score are broken arbitrarily, as they were before.
 */
export function findWinner(players, pinkCowHolder) {
  const eligible = (players || []).filter(p => checkWinCondition(p, pinkCowHolder));
  if (!eligible.length) return null;
  return eligible.reduce((a, b) => (a.score > b.score ? a : b));
}

// Get a random question that hasn't been used in the game yet.
// `pool` lets a room play a host's custom pack instead of the built-in set —
// everything else about the game is identical, which is the whole point.
export function getRandomQuestion(usedQuestions = [], pool = null) {
  const source = Array.isArray(pool) && pool.length ? pool : PREDEFINED_QUESTIONS;
  const availableQuestions = source.filter(q => !usedQuestions.includes(q));
  if (availableQuestions.length === 0) {
    // If all questions have been used, start over
    return source[Math.floor(Math.random() * source.length)];
  }
  return availableQuestions[Math.floor(Math.random() * availableQuestions.length)];
}
