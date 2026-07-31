// Local-only DNS override for Windows machines whose ISP DNS blocks Atlas SRV records.
// In production (Railway/Vercel), the host's own DNS resolves Mongo SRV fine, so we skip it.
import dns from 'dns';
if (process.env.NODE_ENV !== 'production') {
  dns.setServers(['1.1.1.1', '8.8.8.8']);
}

import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import mongoose from 'mongoose';
import cors from 'cors';
import dotenv from 'dotenv';
import { getRandomQuestion } from './utils/gameLogic.js';
import { mountGame } from './engine/index.js';
import { SayAnythingGame } from './games/sayAnything/game.js';
import { GuesstimateGame } from './games/guesstimate/game.js';
import { CloverGame } from './games/clover/game.js';
import { TeamTriviaGame } from './games/teamtrivia/game.js';
import { ChameleonGame } from './games/chameleon/game.js';
import { SpectrumGame } from './games/wavelength/game.js';
import { TwoTruthsGame } from './games/twotruths/game.js';
import { ScattergoriesGame } from './games/scattergories/game.js';
import { WouldYouRatherGame } from './games/wouldyourather/game.js';
import { FishbowlGame } from './games/fishbowl/game.js';
import { TabooGame } from './games/taboo/game.js';
import { cleanupOldGames } from './utils/dbCleanup.js';
import { ensureAnalyticsIndexes } from './analytics.js';
import dailyRouter, { ensureDailyIndexes } from './games/daily/dailyRoutes.js';
import clientErrorsRouter, { ensureClientErrorIndexes } from './clientErrors.js';
import dailyEventsRouter, { ensureDailyEventIndexes } from './dailyEvents.js';
import gameStatsRouter from './gameStats.js';
import hotTakeRouter, { ensureHotTakeIndexes } from './games/hottakes/hotTakeRoutes.js';
import { ensureRoomIndexes } from './engine/persistence.js';
import waitlistRouter, { ensureWaitlistIndexes } from './waitlist.js';

import Game from './models/Game.js';
import Player from './models/Player.js';
import Round from './models/Round.js';
import Answer from './models/Answer.js';
import Question from './models/Question.js';
import { normalizeAnswer } from './utils/answerNormalizer.js';
import { analyzeRoundAnswers, determinePinkCowHolder, checkWinCondition } from './utils/gameLogic.js';

dotenv.config();

// ── Process-level crash guards ───────────────────────────────────────────────
// CRITICAL for multiplayer: a single uncaught error must NEVER take down the
// process, because that would disconnect EVERY player in EVERY room at once.
// Log it and keep running.
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});

const app = express();
// Behind Railway's proxy — trust one hop so req.ip is the real client IP
// (and rate limits can't be bypassed with a spoofed X-Forwarded-For).
app.set('trust proxy', 1);
const httpServer = createServer(app);

// Allowed browser origins. Includes the live domain (apex + www), the legacy
// Vercel domain (kept during the migration), localhost for dev, and whatever
// FRONTEND_URL is set to — normalised to drop any trailing slash.
const ALLOWED_ORIGINS = [
  'https://herdgamesonline.com',
  'https://www.herdgamesonline.com',
  'https://herd-game-react.vercel.app',
  'http://localhost:3000',
  ...(process.env.FRONTEND_URL ? [process.env.FRONTEND_URL.replace(/\/$/, '')] : []),
];

function corsOrigin(origin, callback) {
  // Allow same-origin / non-browser requests (no Origin header) and whitelisted origins.
  if (!origin || ALLOWED_ORIGINS.includes(origin.replace(/\/$/, ''))) return callback(null, true);
  return callback(new Error('Not allowed by CORS'));
}

const corsOptions = {
  origin: corsOrigin,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
};

const io = new Server(httpServer, {
  cors: { origin: ALLOWED_ORIGINS, methods: ['GET', 'POST'], credentials: true },
  allowEIO3: true,
  transports: ['websocket', 'polling'],
  // Transparently restore a player's session (and replay missed events) after a
  // brief drop — mobile backgrounding, tab switches, flaky wifi. Big reduction
  // in "I got disconnected" problems.
  connectionStateRecovery: {
    maxDisconnectionDuration: 2 * 60 * 1000, // 2 minutes
    skipMiddlewares: true,
  },
  // More tolerant heartbeats so a momentary network blip doesn't kill the socket.
  pingInterval: 20000,
  pingTimeout: 25000,
  // Capacity safety on a single instance: skip the CPU-heavy per-message
  // compression (little benefit for our small JSON payloads), and cap the
  // inbound buffer so a bad/hostile client can't balloon memory.
  perMessageDeflate: false,
  maxHttpBufferSize: 1e6, // 1 MB
});

// Configure CORS middleware
app.use(cors(corsOptions));

// Handle preflight requests
app.options('*', cors(corsOptions));

app.use(express.json());

// Daily Herd — REST endpoints (decoupled from the realtime game engine)
app.use('/api/daily', dailyRouter);

// Client-side error capture (fire-and-forget; never affects gameplay)
app.use('/api/client-error', clientErrorsRouter);

// Daily-game completion pings (client-only games; true plays-per-day)
app.use('/api/daily-event', dailyEventsRouter);

// Social-proof player counts for the game cards (cached, degrades to {}).
app.use('/api/game-stats', gameStatsRouter);

// Daily Hot Takes — crowd-tallied opinion game (this-or-that → archetype + split)
app.use('/api/hottakes', hotTakeRouter);

// Corporate "Teams Plus" waitlist (willingness-to-pay probe)
app.use('/api/waitlist', waitlistRouter);

// ── Observability: is the single instance near capacity? ─────────────────────
// Sample event-loop lag (the truest "am I overloaded?" signal for a Node
// realtime server) by measuring timer drift.
let eventLoopLagMs = 0;
{
  let last = process.hrtime.bigint();
  const EVERY = 2000;
  setInterval(() => {
    const now = process.hrtime.bigint();
    const drift = Number(now - last) / 1e6 - EVERY; // ms over the expected interval
    eventLoopLagMs = Math.max(0, Math.round(drift));
    last = now;
  }, EVERY).unref();
}

function metricsSnapshot() {
  const mem = process.memoryUsage();
  return {
    ok: true,
    uptimeSec: Math.round(process.uptime()),
    sockets: io.engine ? io.engine.clientsCount : null, // live connected clients
    rooms: io.of('/').adapter ? io.of('/').adapter.rooms.size : null,
    rssMb: Math.round(mem.rss / 1048576),
    heapUsedMb: Math.round(mem.heapUsed / 1048576),
    eventLoopLagMs, // sustained >50-100ms = CPU-bound / near capacity
  };
}

// Lightweight health/capacity endpoint (also handy for uptime pings).
app.get('/health', (req, res) => res.json(metricsSnapshot()));

// Periodic capacity log so Railway logs show load over time.
setInterval(() => {
  const m = metricsSnapshot();
  console.log(`[metrics] sockets=${m.sockets} rss=${m.rssMb}MB heap=${m.heapUsedMb}MB lag=${m.eventLoopLagMs}ms up=${m.uptimeSec}s`);
}, 60000).unref();

// Connect to MongoDB
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/herdmentality')
  .then(() => {
    console.log('Connected to MongoDB');
    // Clean up old games on server start
    cleanupOldGames();
    // Ensure the analytics TTL index exists (keeps the collection tiny)
    ensureAnalyticsIndexes();
    // Ensure Daily Herd indexes (dedupe + tally uniqueness)
    ensureDailyIndexes();
    // Ensure client-error TTL index (keeps the collection tiny)
    ensureClientErrorIndexes();
    // Ensure daily-event TTL index (completion pings; keeps the collection tiny)
    ensureDailyEventIndexes();
    // Ensure Hot Takes tally indexes (crowd split dedupe)
    ensureHotTakeIndexes();
    // Ensure waitlist unique-email index
    ensureWaitlistIndexes();
    // Ensure room-snapshot indexes (rooms survive a restart; TTL keeps it tiny)
    ensureRoomIndexes();
  })
  .catch((error) => {
    console.error('MongoDB connection error:', error);
  });

// Socket.IO connection handling
io.on('connection', (socket) => {
  console.log('New client connected');

  // Create game room
  socket.on('create_game', async ({ username }) => {
    console.log('Received create_game request:', { username, socketId: socket.id });
    try {
      const roomCode = await Game.generateRoomCode();
      console.log('Generated room code:', roomCode);

      const game = new Game({
        roomCode,
        hostId: socket.id,
        status: 'waiting'
      });
      await game.save();
      console.log('Game created:', { gameId: game._id, roomCode });

      const host = new Player({
        gameId: game._id,
        username,
        isHost: true,
        socketId: socket.id,
        isConnected: true
      });
      await host.save();
      console.log('Host player created:', { playerId: host._id, username });

      socket.join(roomCode);
      console.log('Socket joined room:', roomCode);

      socket.emit('game_created', { 
        gameId: game._id,
        roomCode,
        playerId: host._id
      });
      console.log('Emitted game_created event');
    } catch (error) {
      console.error('Error creating game:', error);
      socket.emit('error', { 
        message: 'Failed to create game',
        details: error.message 
      });
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
      // Use findOneAndUpdate to atomically check game state
      const game = await Game.findOneAndUpdate(
        { 
          _id: gameId, 
          status: 'in-progress'
        },
        { $inc: { playersAnswered: 1 } },
        { new: true }
      );

      if (!game) {
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

      // Get total number of connected players
      const connectedPlayers = await Player.countDocuments({ 
        gameId, 
        isConnected: true 
      });

      // Notify all players about the new answer count
      io.to(game.roomCode).emit('player_answered', {
        playersAnswered: game.playersAnswered,
        totalPlayers: connectedPlayers
      });

      // Check if all players have answered
      if (game.playersAnswered >= connectedPlayers) {
        try {
          // Analyze round results
          const results = await analyzeRoundAnswers(round._id);
          
          // Determine new pink cow holder
          const newPinkCowHolder = determinePinkCowHolder(
            game.pinkCowHolder,
            results.uniqueAnswerPlayer
          );

          // Update scores for players with majority answer
          if (results.scoringPlayers.length > 0) {
            await Player.updateMany(
              { _id: { $in: results.scoringPlayers } },
              { $inc: { score: 1 } }
            );
          }

          // Update game state atomically
          await Game.findByIdAndUpdate(gameId, {
            pinkCowHolder: newPinkCowHolder,
            playersAnswered: 0
          });

          // Get updated player states
          const updatedPlayers = await Player.find({ gameId });

          // Send round results to all players
          io.to(game.roomCode).emit('round_completed', {
            results,
            pinkCowHolder: newPinkCowHolder,
            players: updatedPlayers
          });

          // Find all players with 8 or more points
          const playersWithEightPoints = updatedPlayers.filter(p => p.score >= 8);
          
          // Only declare winner if:
          // 1. There's at least one player with 8 points who doesn't have the pink cow
          // 2. OR if multiple players have 8 points (even if one has pink cow)
          const potentialWinners = playersWithEightPoints.filter(p => 
            p._id.toString() !== newPinkCowHolder
          );

          if (potentialWinners.length > 0) {
            // Get the player with the highest score among potential winners
            const winner = potentialWinners.reduce((prev, current) => 
              (prev.score > current.score) ? prev : current
            );
            
            await Game.findByIdAndUpdate(gameId, { status: 'completed' });
            io.to(game.roomCode).emit('game_completed', { winner });
          }
        } catch (error) {
          console.error('Round completion error:', error);
          socket.emit('error', { message: 'Error completing round' });
        }
      }
    } catch (error) {
      console.error('Submit answer error:', error);
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

  // ───── Host manual score adjustment (Path B / Just-One-style override) ─────
  socket.on('adjust_score', async ({ gameId, playerId, delta }) => {
    try {
      if (delta !== 1 && delta !== -1) return;

      const game = await Game.findById(gameId);
      if (!game || game.status !== 'in-progress') return;
      if (game.hostId !== socket.id) {
        socket.emit('error', { message: 'Only host can adjust scores' });
        return;
      }

      const target = await Player.findOne({ _id: playerId, gameId });
      if (!target) return;

      const newScore = Math.max(0, (target.score || 0) + delta);
      target.score = newScore;
      await target.save();

      const players = await Player.find({ gameId });
      io.to(game.roomCode).emit('players_updated', { players });

      // Re-run win check after adjustment
      const eligibleWinners = players.filter(
        p => p.score >= 8 && p._id.toString() !== (game.pinkCowHolder || '').toString()
      );
      if (eligibleWinners.length > 0) {
        const winner = eligibleWinners.reduce((a, b) => (a.score > b.score ? a : b));
        await Game.findByIdAndUpdate(gameId, { status: 'completed' });
        io.to(game.roomCode).emit('game_completed', { winner });
      }
    } catch (error) {
      console.error('adjust_score error:', error);
      socket.emit('error', { message: 'Failed to adjust score' });
    }
  });
  // ───── end Path B ─────

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

  // Handle reconnection
  socket.on('reconnect_game', async ({ gameId, roomCode, username }) => {
    try {
      const game = await Game.findOne({ _id: gameId, roomCode });
      if (!game) {
        socket.emit('reconnect_failed', { reason: 'Game not found' });
        return;
      }

      // Find the disconnected player
      const player = await Player.findOne({
        gameId,
        username,
        isConnected: false
      });

      if (!player) {
        socket.emit('reconnect_failed', { reason: 'Player not found or already connected' });
        return;
      }

      // Update player connection
      player.socketId = socket.id;
      player.isConnected = true;
      await player.save();

      // Join socket room
      socket.join(game.roomCode);

      // Get current game state
      const players = await Player.find({ gameId: game._id });
      const currentRound = await Round.findOne({
        gameId: game._id,
        roundNumber: game.currentRound
      });

      const playersAnswered = currentRound ? await Answer.countDocuments({ roundId: currentRound._id }) : 0;

      // Send game state to reconnecting player
      socket.emit('game_rejoined', {
        gameId: game._id,
        playerId: player._id,
        roomCode: game.roomCode,
        gameState: {
          currentRound: game.currentRound,
          currentQuestion: game.currentQuestion,
          players,
          pinkCowHolder: game.pinkCowHolder,
          playersAnswered
        }
      });

      // Notify others
      io.to(game.roomCode).emit('players_updated', { players });

    } catch (error) {
      console.error('Reconnection error:', error);
      socket.emit('reconnect_failed', { reason: 'Server error during reconnection' });
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

// ── Game suite — each game gets its own namespace ────────────────────────────
mountGame(io, '/sa', SayAnythingGame);
mountGame(io, '/guesstimate', GuesstimateGame);
mountGame(io, '/clover', CloverGame);
mountGame(io, '/teamtrivia', TeamTriviaGame);
mountGame(io, '/chameleon', ChameleonGame);
mountGame(io, '/spectrum', SpectrumGame);
mountGame(io, '/twotruths', TwoTruthsGame);
mountGame(io, '/scattergories', ScattergoriesGame);
mountGame(io, '/wyr', WouldYouRatherGame);
mountGame(io, '/fishbowl', FishbowlGame);
mountGame(io, '/taboo', TabooGame);

const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
