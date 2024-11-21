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

  // Get players who gave majority answer
  const scoringPlayers = majorityAnswers.length === 1
    ? answers
        .filter(a => a.normalizedAnswer === majorityAnswers[0])
        .map(a => a.playerId)
    : [];

  return {
    majorityAnswer: majorityAnswers.length === 1 ? majorityAnswers[0] : null,
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

// Get a random question that hasn't been used in the game yet
export function getRandomQuestion(usedQuestions = []) {
  const availableQuestions = PREDEFINED_QUESTIONS.filter(q => !usedQuestions.includes(q));
  if (availableQuestions.length === 0) {
    // If all questions have been used, start over
    return PREDEFINED_QUESTIONS[Math.floor(Math.random() * PREDEFINED_QUESTIONS.length)];
  }
  return availableQuestions[Math.floor(Math.random() * availableQuestions.length)];
}
