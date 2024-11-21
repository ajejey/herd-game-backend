import mongoose from 'mongoose';

const answerSchema = new mongoose.Schema({
  gameId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Game',
    required: true
  },
  roundId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Round',
    required: true
  },
  playerId: {
    type: String,
    required: true
  },
  username: {
    type: String,
    required: true
  },
  originalAnswer: {
    type: String,
    required: true
  },
  normalizedAnswer: {
    type: String,
    required: true
  },
  timestamp: {
    type: Date,
    default: Date.now
  }
});

// Compound index to ensure one answer per player per round
answerSchema.index({ roundId: 1, playerId: 1 }, { unique: true });

export default mongoose.model('Answer', answerSchema);
