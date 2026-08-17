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
import pushRouter, { ensurePushIndexes } from './push/pushRoutes.js';
import feedbackRouter, { ensureFeedbackIndexes } from './feedback.js';
import packsRouter, { usePack } from './packs.js';

import Game from './models/Game.js';
import Player from './models/Player.js';
import Round from './models/Round.js';
import Answer from './models/Answer.js';
import Question from './models/Question.js';
import { normalizeAnswer } from './utils/answerNormalizer.js';
import { analyzeRoundAnswers, determinePinkCowHolder, findWinner } from './utils/gameLogic.js';

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
  // The Capacitor Android app. Its WebView serves the bundle from a local
  // server, so the Origin header is https://localhost — NOT the site domain —
  // and without these entries every request and socket from the app is rejected
  // and the app can only show "couldn't reach the herd".
  // See frontend/capacitor.config.json -> server.androidScheme.
  'https://localhost',
  'capacitor://localhost',  // the iOS equivalent, so an iOS build needs no change
  'http://localhost',       // only if androidScheme is ever switched to http
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

// Android push device tokens (no-op until FCM_* env vars are set)
app.use('/api/push', pushRouter);

// Player-submitted problem reports (keeps complaints out of the Play reviews)
app.use('/api/feedback', feedbackRouter);

// Host-written custom question packs, addressed by pack code (no accounts).
app.use('/api/packs', packsRouter);

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
    // Ensure push token unique index (one row per device token)
    ensurePushIndexes();
    // Ensure feedback indexes (no TTL — human reports are kept)
    ensureFeedbackIndexes();
  })
  .catch((error) => {
    console.error('MongoDB connection error:', error);
  });

/*
  Who is the host, after they refresh?

  `game.hostId` is a socket.id, written once in create_game and never again.
  Socket ids change on every reconnect — a phone locking, a tab refresh, a lift,
  a train tunnel — so from the host's first reconnect onwards their id no longer
  matched and every host-only handler below refused them. The front end made the
  same mistake from the other side: GAME_REJOINED spread initialState, so
  `isHost` came back false and the Start / Next Round buttons were not even
  rendered. Nobody else can do those things either, so the room became
  unfinishable by anyone in it.

  It is not a rare edge. Of 275 recent rooms, 67 had a host whose socket had
  changed, and 67 of those 67 never completed — against 75% for rooms whose host
  never reconnected. Whatever else is true of those rooms, a host reconnect took
  the completion rate to zero.

  The durable identity is the Player record: `isHost` is set at creation and
  survives every reconnect. Ask that, and heal the stale `hostId` on the way
  past so the cheap equality check keeps working for the rest of the room's life.
*/
async function isHostSocket(game, socketId) {
  if (game.hostId === socketId) return true;

  const player = await Player.findOne({ gameId: game._id, socketId, isHost: true });
  if (!player) return false;

  game.hostId = socketId;
  await Game.updateOne({ _id: game._id }, { $set: { hostId: socketId } });
  return true;
}

/*
  What should someone coming back mid-game be shown — the answer box, or the
  results?

  `round.status` is the honest answer and is now written when a round resolves,
  but rooms that are already in progress when this deploys have rounds that
  finished without it, and people are playing in them right now. So fall back to
  a signal those rooms do carry: a round with answers on it in a game whose
  `playersAnswered` counter has been reset to zero is a round that completed.
  Mid-round the counter is non-zero; before anyone answers there is nothing to
  count. Either test alone is correct, and together they cover the deploy.

  Returns the results payload, or null if the round is still collecting.
*/
async function completedRoundResults(game, round) {
  if (!round) return null;

  const answered = await Answer.countDocuments({ roundId: round._id });
  const finished = round.status === 'completed' || (answered > 0 && (game.playersAnswered || 0) === 0);
  if (!finished) return null;

  return analyzeRoundAnswers(round._id);
}

// Socket.IO connection handling
io.on('connection', (socket) => {
  console.log('New client connected');

  // Create game room
  socket.on('create_game', async ({ username, packCode }) => {
    console.log('Received create_game request:', { username, packCode, socketId: socket.id });
    try {
      const roomCode = await Game.generateRoomCode();
      console.log('Generated room code:', roomCode);

      // A bad or expired pack code must never stop the room being created —
      // fall through to the built-in questions instead of failing the host.
      const customQuestions = packCode ? await usePack(packCode) : null;

      const game = new Game({
        roomCode,
        hostId: socket.id,
        status: 'waiting',
        packCode: customQuestions ? String(packCode).toUpperCase() : undefined,
        customQuestions: customQuestions || []
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
      /*
        Normalise HERE, not only in the browser.

        Room codes are generated uppercase and looked up by exact string match,
        and this handler took whatever the client sent. The invite-link path
        already did .trim().toUpperCase(), and every namespaced game does
        `rc.toUpperCase().trim()` — the main game's typed-code path was the one
        place that did not. A phone that autocapitalises to "Wi9nvo", or a
        pasted code carrying a trailing space, therefore found no game and the
        player was told "Game not found" for a room that plainly existed.

        Doing it server-side matters more than the client fix: the Android app
        ships its own bundled copy of the front end, so until people update it
        they keep sending raw values. This makes those installs work today.
      */
      const code = String(roomCode || '').trim().toUpperCase();
      const name = String(username || '').trim();
      const game = await Game.findOne({ roomCode: code });
      if (!game) {
        socket.emit('error', { message: 'Game not found' });
        return;
      }

      /*
        Match a returning player case-insensitively.

        This was an exact match on the raw username, so a player who dropped
        out and typed "micah" where they had been "Micah" did not match their
        own record — and once a game is under way that meant being refused
        entry to a game they were already in. Room M8RVAL is carrying both
        spellings as two separate players, which is that bug in the data.
      */
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      let player = await Player.findOne({
        gameId: game._id,
        username: new RegExp(`^${escaped}$`, 'i'),
      });

      /*
        Let people in mid-game.

        Herd Mentality scores by matching the group each round, so arriving at
        round 3 with nothing on the board costs you points and breaks nothing —
        there is no hidden state to leak and analyzeRoundAnswers works from the
        answers that exist rather than requiring one per player.

        Refusing was worse than it looks. Room M8RVAL had seven players at
        round 3 when someone's friend was turned away; two minutes later the
        group abandoned it and rebuilt the room from scratch. The rule cost
        them the game they were in the middle of.
      */
      if (player) {
        // Update existing player's connection
        player.socketId = socket.id;
        player.isConnected = true;
        await player.save();
      } else {
        // Create new player
        player = new Player({
          gameId: game._id,
          username: name,
          socketId: socket.id,
          isConnected: true
        });
        await player.save();
      }

      // Join the CANONICAL room name. `roomCode` off the wire could differ in
      // case, which would put this socket in a second, silent Socket.IO room
      // that no broadcast ever reaches — in the room, but hearing nothing.
      socket.join(game.roomCode);

      // The host coming back through the front door rather than reconnect_game
      // (a fresh tab, the invite link, a cleared localStorage). Point hostId at
      // the socket they are actually using — see isHostSocket above.
      if (player.isHost) {
        game.hostId = socket.id;
        await Game.updateOne({ _id: game._id }, { $set: { hostId: socket.id } });
      }

      // Send current game state for reconnecting players
      const currentRound = await Round.findOne({ 
        gameId: game._id, 
        roundNumber: game.currentRound 
      });

      const gameState = {
        gameId: game._id,
        playerId: player._id,
        isReconnected: !!player,
        // Tell the client which seat it is in. It used to decide this itself —
        // GAME_CREATED set isHost true, GAME_JOINED set it false — so a host
        // arriving through join_game was rendered the player's screen and had
        // no Start button.
        isHost: !!player.isHost,
        currentRound: game.currentRound,
        currentQuestion: game.currentQuestion,
        gameStatus: game.status,
        pinkCowHolder: game.pinkCowHolder,
        playersAnswered: game.playersAnswered
      };

      // If the round is complete, include its results so the arriving player
      // lands on the results screen rather than an answer box for a round that
      // has already been scored.
      const joinResults = await completedRoundResults(game, currentRound);
      if (joinResults) gameState.roundResults = joinResults;

      socket.emit('game_joined', gameState);

      // Notify all players — broadcast on the canonical code for the same
      // reason the socket joins on it.
      const players = await Player.find({ gameId: game._id });
      io.to(game.roomCode).emit('players_updated', { players });
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
      if (!(await isHostSocket(game, socket.id))) {
        socket.emit('error', { message: 'Only host can start the game' });
        return;
      }

      // Start first round
      game.status = 'in-progress';
      game.currentRound = 1;
      const firstQuestion = getRandomQuestion([], game.customQuestions);
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

          /*
            Write down that the round is over.

            Round.status has existed since the first version, with an enum of
            'collecting-answers' | 'completed', and nothing ever set it to
            'completed'. So the restore path in join_game —

                if (currentRound && currentRound.status === 'completed')

            — could not fire, ever. Anyone who refreshed while looking at the
            results came back to the answer box for a round that had already
            been scored, under the words "2 of 2 players answered", with no
            results and no Next Round button. For the host that made the room
            unfinishable, and "How to go to next round" is exactly what that
            screen looks like from the player's chair.
          */
          round.status = 'completed';
          await round.save();

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

          // 8 points and not holding the cow — see findWinner in gameLogic.js.
          // The comment that used to sit here described a second rule ("OR if
          // multiple players have 8 points, even if one has the pink cow") that
          // the code did not implement and never had.
          const winner = findWinner(updatedPlayers, newPinkCowHolder);
          if (winner) {
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
      if (!(await isHostSocket(game, socket.id))) {
        socket.emit('error', { message: 'Only host can start next round' });
        return;
      }

      const nextRound = new Round({
        gameId,
        roundNumber: game.currentRound + 1
      });
      await nextRound.save();

      const nextQuestion = getRandomQuestion(game.usedQuestions, game.customQuestions);
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
      if (!(await isHostSocket(game, socket.id))) {
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
      const winner = findWinner(players, game.pinkCowHolder);
      if (winner) {
        await Game.findByIdAndUpdate(gameId, { status: 'completed' });
        io.to(game.roomCode).emit('game_completed', { winner });
      }
    } catch (error) {
      console.error('adjust_score error:', error);
      socket.emit('error', { message: 'Failed to adjust score' });
    }
  });
  // ───── end Path B ─────

  /*
    Move the pink cow by hand (host only).

    Asked for on 16 Aug 2026: "Manaully moving the cow would be a good feature".

    The cow moves automatically, and only when EXACTLY ONE player gave a lone
    answer (determinePinkCowHolder). That is the board game's rule and it is
    right. What the board game also has, and this did not, is hands: at a table
    somebody just picks the cow up.

    Without that the game can lock. Winning needs 8 points AND not holding the
    cow, so a player who reaches 8 while holding it cannot win until some later
    round happens to produce a single odd answer — and in a group that keeps
    agreeing, that round may never come. Room RK6J7L ran 34 rounds with its
    leader sat on exactly 8 points holding the cow. Two of the last 120 games
    that got past round one were in that state.

    So the win check has to run again here, not just at the end of a round.
    Moving the cow off someone on 8+ IS the winning move, and if this only
    changed the badge the host would have done the right thing and watched
    nothing happen.
  */
  socket.on('move_pink_cow', async ({ gameId, playerId }) => {
    try {
      const game = await Game.findById(gameId);
      if (!game || game.status !== 'in-progress') return;
      if (!(await isHostSocket(game, socket.id))) {
        socket.emit('error', { message: 'Only the host can move the pink cow' });
        return;
      }

      // An empty playerId means "take it off the table" — a legitimate choice
      // when the group decides nobody deserves it this round.
      let holder = null;
      if (playerId) {
        const target = await Player.findOne({ _id: playerId, gameId });
        if (!target) return;
        holder = target._id.toString();
      }

      await Game.findByIdAndUpdate(gameId, { pinkCowHolder: holder });

      const players = await Player.find({ gameId });
      io.to(game.roomCode).emit('pink_cow_moved', { pinkCowHolder: holder, players });

      // Same rule as the end of a round, and now literally the same function.
      const winner = findWinner(players, holder);
      if (winner) {
        await Game.findByIdAndUpdate(gameId, { status: 'completed' });
        io.to(game.roomCode).emit('game_completed', { winner });
      }
    } catch (error) {
      console.error('move_pink_cow error:', error);
      socket.emit('error', { message: 'Failed to move the pink cow' });
    }
  });

  // Remove player (host only)
  socket.on('remove_player', async ({ gameId, playerId }) => {
    try {
      const game = await Game.findById(gameId);
      if (!game || !(await isHostSocket(game, socket.id))) {
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
      // Same normalisation as join_game: this code came out of the browser's
      // own localStorage, which stored whatever was originally typed.
      const rcode = String(roomCode || '').trim().toUpperCase();
      const uname = String(username || '').trim();
      const game = await Game.findOne({ _id: gameId, roomCode: rcode });
      if (!game) {
        socket.emit('reconnect_failed', { reason: 'Game not found' });
        return;
      }

      /*
        Take the player's seat back whether or not we had noticed them leave.

        This used to require `isConnected: false`, and that is the wrong test.
        A phone that locks, a tab refresh, a browser restoring a session — all
        reconnect long before the old socket's disconnect has been processed,
        so the record still says connected, the lookup found nobody, and the
        client's handler for that failure is navigate('/'). The player was
        thrown out of a game they were sitting in and dumped on the home page,
        while everyone else stayed in the lobby wondering where they went.
        "Gaga can't play with me because you're on a different page on the same
        game" is that, described by someone watching it happen.

        Matching is case-insensitive for the same reason as join_game.
      */
      const esc = uname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const player = await Player.findOne({
        gameId,
        username: new RegExp(`^${esc}$`, 'i'),
      });

      if (!player) {
        socket.emit('reconnect_failed', { reason: 'Player not found' });
        return;
      }

      // Update player connection
      player.socketId = socket.id;
      player.isConnected = true;
      await player.save();

      // The host's socket id has just changed. Move hostId with it, or every
      // host-only handler will refuse them for the rest of the game — see
      // isHostSocket above for what that did to rooms.
      if (player.isHost) {
        game.hostId = socket.id;
        await Game.updateOne({ _id: game._id }, { $set: { hostId: socket.id } });
      }

      // Join socket room
      socket.join(game.roomCode);

      // Get current game state
      const players = await Player.find({ gameId: game._id });
      const currentRound = await Round.findOne({
        gameId: game._id,
        roundNumber: game.currentRound
      });

      const playersAnswered = currentRound ? await Answer.countDocuments({ roundId: currentRound._id }) : 0;

      // The same restore join_game does. Without it a refresh on the results
      // screen came back to the answer box for a finished round — for the host,
      // with no Next Round button, which is a room nobody can finish.
      const roundResults = await completedRoundResults(game, currentRound);

      // Send game state to reconnecting player
      socket.emit('game_rejoined', {
        gameId: game._id,
        playerId: player._id,
        roomCode: game.roomCode,
        // Without this the client cannot know, and its reducer assumed false.
        isHost: !!player.isHost,
        gameState: {
          currentRound: game.currentRound,
          currentQuestion: game.currentQuestion,
          gameStatus: game.status,
          players,
          pinkCowHolder: game.pinkCowHolder,
          playersAnswered,
          roundResults
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
