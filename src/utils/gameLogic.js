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

/**
 * Checks if a player has won (8 points and doesn't have pink cow)
 */
export function checkWinCondition(player, pinkCowHolder) {
  return player.score >= 8 && player._id !== pinkCowHolder;
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
