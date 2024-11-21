import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import mongoose from 'mongoose';
import cors from 'cors';
import dotenv from 'dotenv';
import { getRandomQuestion } from './utils/gameLogic.js';
import { cleanupOldGames } from './utils/dbCleanup.js';

import Game from './models/Game.js';
import Player from './models/Player.js';
import Round from './models/Round.js';
import Answer from './models/Answer.js';
import Question from './models/Question.js';
import { normalizeAnswer } from './utils/answerNormalizer.js';
import { analyzeRoundAnswers, determinePinkCowHolder, checkWinCondition } from './utils/gameLogic.js';

dotenv.config();

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: process.env.FRONTEND_URL,
    methods: ["GET", "POST"],
    allowedHeaders: ["my-custom-header"],
    credentials: true
  },
  allowEIO3: true,
  transports: ['websocket', 'polling']
});

// Configure CORS middleware
app.use(cors({
  origin: process.env.FRONTEND_URL,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}));

// Handle preflight requests
app.options('*', cors());

app.use(express.json());

// Connect to MongoDB
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/herdmentality')
  .then(() => {
    console.log('Connected to MongoDB');
    // Clean up old games on server start
    cleanupOldGames();
  })
  .catch((error) => {
    console.error('MongoDB connection error:', error);
  });

// Socket.IO connection handling
io.on('connection', (socket) => {
  console.log('New client connected');

  // Create game room
  socket.on('create_game', async ({ username }) => {
    try {
      const roomCode = await Game.generateRoomCode();
      const game = new Game({
        roomCode,
        hostId: socket.id,
        status: 'waiting'
      });
      await game.save();

      const host = new Player({
        gameId: game._id,
        username,
        isHost: true,
        socketId: socket.id
      });
      await host.save();

      socket.join(roomCode);
      socket.emit('game_created', { 
        gameId: game._id,
        roomCode,
        playerId: socket.id
      });
    } catch (error) {
      socket.emit('error', { message: 'Failed to create game' });
    }
  });

  // Join game room
  socket.on('join_game', async ({ roomCode, username }) => {
    try {
      const game = await Game.findOne({ roomCode });
      if (!game) {
        socket.emit('error', { message: 'Game not found' });
        return;
      }

      // Check if player already exists in this game
      let player = await Player.findOne({ gameId: game._id, username });
      
      if (game.status !== 'waiting') {
        // Only allow rejoin if player was already in the game
        if (!player) {
          socket.emit('error', { message: 'Game already in progress' });
          return;
        }
      }

      if (player) {
        // Update existing player's connection
        player.socketId = socket.id;
        player.isConnected = true;
        await player.save();
      } else {
        // Create new player
        player = new Player({
          gameId: game._id,
          username,
          socketId: socket.id,
          isConnected: true
        });
        await player.save();
      }

      socket.join(roomCode);
      
      // Send current game state for reconnecting players
      const currentRound = await Round.findOne({ 
        gameId: game._id, 
        roundNumber: game.currentRound 
      });

      const gameState = {
        gameId: game._id,
        playerId: player._id,
        isReconnected: !!player,
        currentRound: game.currentRound,
        currentQuestion: game.currentQuestion,
        gameStatus: game.status,
        pinkCowHolder: game.pinkCowHolder,
        playersAnswered: game.playersAnswered
      };

      // If round is complete, include round results
      if (currentRound && currentRound.status === 'completed') {
        const results = await analyzeRoundAnswers(currentRound._id);
        gameState.roundResults = results;
      }

      socket.emit('game_joined', gameState);

      // Notify all players
      const players = await Player.find({ gameId: game._id });
      io.to(roomCode).emit('players_updated', { players });
    } catch (error) {
      console.error('Join game error:', error);
      socket.emit('error', { message: 'Failed to join game' });
    }
  });

  // Start game
  socket.on('start_game', async ({ gameId }) => {
    try {
      const game = await Game.findById(gameId);
      if (!game) {
        socket.emit('error', { message: 'Game not found' });
        return;
      }

      // Verify sender is host
      if (game.hostId !== socket.id) {
        socket.emit('error', { message: 'Only host can start the game' });
        return;
      }

      // Start first round
      game.status = 'in-progress';
      game.currentRound = 1;
      const firstQuestion = getRandomQuestion();
      game.currentQuestion = firstQuestion;
      game.usedQuestions = [firstQuestion];
      await game.save();

      const round = new Round({
        gameId: game._id,
        roundNumber: 1
      });
      await round.save();

      const players = await Player.find({ gameId: game._id });
      io.to(game.roomCode).emit('game_started', {
        gameState: game,
        players,
        round
      });
    } catch (error) {
      socket.emit('error', { message: 'Failed to start game' });
    }
  });

  // Submit answer
  socket.on('submit_answer', async ({ gameId, answer }) => {
    try {
      const game = await Game.findById(gameId);
      if (!game || game.status !== 'in-progress') {
        socket.emit('error', { message: 'Invalid game state' });
        return;
      }

      const player = await Player.findOne({ gameId, socketId: socket.id });
      if (!player) {
        socket.emit('error', { message: 'Player not found' });
        return;
      }

      const round = await Round.findOne({ 
        gameId, 
        roundNumber: game.currentRound 
      });

      // Save answer
      const newAnswer = new Answer({
        gameId,
        roundId: round._id,
        playerId: player._id,
        username: player.username,
        originalAnswer: answer,
        normalizedAnswer: normalizeAnswer(answer)
      });
      await newAnswer.save();

      // Update players answered count
      game.playersAnswered += 1;
      await game.save();

      // Notify all players about the new answer (without showing the answer)
      io.to(game.roomCode).emit('player_answered', {
        username: player.username,
        playersAnswered: game.playersAnswered
      });

      // If all players have answered, analyze results
      const players = await Player.find({ gameId });
      if (game.playersAnswered === players.length) {
        const results = await analyzeRoundAnswers(round._id);
        
        // Update scores and pink cow
        const newPinkCowHolder = determinePinkCowHolder(game.pinkCowHolder, results.uniqueAnswerPlayer);
        
        // Update player scores
        for (const playerId of results.scoringPlayers) {
          await Player.findByIdAndUpdate(playerId, { $inc: { score: 1 } });
        }

        // Update game state
        game.pinkCowHolder = newPinkCowHolder;
        game.playersAnswered = 0;
        await game.save();

        // Mark round as completed
        round.status = 'completed';
        round.majorityAnswer = results.majorityAnswer;
        round.uniqueAnswerPlayer = results.uniqueAnswerPlayer;
        await round.save();

        // Get updated player states
        const updatedPlayers = await Player.find({ gameId });
        
        // Check for winner
        const winner = updatedPlayers.find(p => checkWinCondition(p, newPinkCowHolder));

        // Send round results to all players
        io.to(game.roomCode).emit('round_completed', {
          results,
          players: updatedPlayers,
          pinkCowHolder: newPinkCowHolder,
          winner
        });

        // If there's a winner, end the game
        if (winner) {
          game.status = 'completed';
          await game.save();
        }
      }
    } catch (error) {
      socket.emit('error', { message: 'Failed to submit answer' });
    }
  });

  // Start next round (host only)
  socket.on('next_round', async ({ gameId }) => {
    try {
      const game = await Game.findById(gameId);
      if (!game || game.status !== 'in-progress') {
        socket.emit('error', { message: 'Invalid game state' });
        return;
      }

      // Verify sender is host
      if (game.hostId !== socket.id) {
        socket.emit('error', { message: 'Only host can start next round' });
        return;
      }

      const nextRound = new Round({
        gameId,
        roundNumber: game.currentRound + 1
      });
      await nextRound.save();

      const nextQuestion = getRandomQuestion(game.usedQuestions);
      game.currentRound += 1;
      game.currentQuestion = nextQuestion;
      game.usedQuestions.push(nextQuestion);
      await game.save();

      io.to(game.roomCode).emit('next_round', {
        roundNumber: game.currentRound,
        question: game.currentQuestion
      });
    } catch (error) {
      socket.emit('error', { message: 'Failed to start next round' });
    }
  });

  // Remove player (host only)
  socket.on('remove_player', async ({ gameId, playerId }) => {
    try {
      const game = await Game.findById(gameId);
      if (!game || socket.id !== game.hostId) {
        socket.emit('error', { message: 'Unauthorized' });
        return;
      }

      await Player.findOneAndUpdate(
        { gameId, socketId: playerId },
        { isConnected: false }
      );

      const players = await Player.find({ gameId });
      io.to(game.roomCode).emit('players_updated', { players });
    } catch (error) {
      socket.emit('error', { message: 'Failed to remove player' });
    }
  });

  // Handle disconnection
  socket.on('disconnect', async () => {
    try {
      const player = await Player.findOne({ socketId: socket.id });
      if (player) {
        player.isConnected = false;
        await player.save();

        const game = await Game.findById(player.gameId);
        if (game) {
          const players = await Player.find({ gameId: game._id });
          io.to(game.roomCode).emit('players_updated', { players });
        }
      }
    } catch (error) {
      console.error('Disconnect handling error:', error);
    }
  });
});

const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
