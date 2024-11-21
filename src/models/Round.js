import mongoose from 'mongoose';

const roundSchema = new mongoose.Schema({
  gameId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Game',
    required: true
  },
  roundNumber: {
    type: Number,
    required: true
  },
  status: {
    type: String,
    enum: ['collecting-answers', 'completed'],
    default: 'collecting-answers'
  },
  majorityAnswer: String,
  uniqueAnswerPlayer: {
    type: String,
    default: null
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

// Compound index to ensure unique round numbers per game
roundSchema.index({ gameId: 1, roundNumber: 1 }, { unique: true });

export default mongoose.model('Round', roundSchema);
