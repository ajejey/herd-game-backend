import mongoose from 'mongoose';

const playerSchema = new mongoose.Schema({
  gameId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Game',
    required: true
  },
  username: {
    type: String,
    required: true
  },
  isHost: {
    type: Boolean,
    default: false
  },
  score: {
    type: Number,
    default: 0
  },
  isConnected: {
    type: Boolean,
    default: true
  },
  socketId: String
});

// Compound index to ensure unique username per game
playerSchema.index({ gameId: 1, username: 1 }, { unique: true });

export default mongoose.model('Player', playerSchema);
