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
  /*
    When the current round's answers stop being anybody's private business.

    Not a hard cut-off — nothing on the server ends a round when this passes.
    It is the moment the "Reveal answers now" button stops being the host's
    alone and becomes everyone's, so that a host who has wandered off cannot
    hold the room hostage. Room S1DQVW sat on "Waiting for other players…"
    until three of its players gave up and filed three separate reports in
    twenty-six seconds — "Someone doesn't answer", "Host is bad", "No work".

    Herd Mentality is a game people talk through, so the window is deliberately
    generous and there is no countdown shouting at anyone.
  */
  roundEndsAt: Date,
  // When the current round's results went up. Same idea from the other side:
  // after RESULTS_UNLOCK_SECONDS anyone may start the next round, so an absent
  // host cannot strand the room on the results screen either.
  resultsAt: Date,
  pinkCowHolder: String,
  usedQuestions: {
    type: [String],
    default: []
  },
  // A host's custom pack, copied onto the room at creation. Copied rather than
  // referenced so that editing or expiring a pack can never change or break a
  // game that is already in progress.
  packCode: String,
  customQuestions: {
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
