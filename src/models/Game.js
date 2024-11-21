import mongoose from 'mongoose';

const gameSchema = new mongoose.Schema({
  roomCode: {
    type: String,
    required: true,
    unique: true
  },
  hostId: {
    type: String,
    required: true
  },
  status: {
    type: String,
    enum: ['waiting', 'in-progress', 'completed'],
    default: 'waiting'
  },
  currentRound: {
    type: Number,
    default: 0
  },
  currentQuestion: String,
  playersAnswered: {
    type: Number,
    default: 0
  },
  pinkCowHolder: String,
  usedQuestions: {
    type: [String],
    default: []
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

// Generate a unique room code
gameSchema.statics.generateRoomCode = async function() {
  const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let roomCode;
  let isUnique = false;

  while (!isUnique) {
    roomCode = '';
    for (let i = 0; i < 6; i++) {
      roomCode += characters.charAt(Math.floor(Math.random() * characters.length));
    }
    
    // Check if room code already exists
    const existingGame = await this.findOne({ roomCode });
    if (!existingGame) {
      isUnique = true;
    }
  }

  return roomCode;
};

const Game = mongoose.model('Game', gameSchema);

export default Game;
