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
import { CavemanCluesGame } from './games/cavemanclues/game.js';
import { HueMatchGame } from './games/huematch/game.js';
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

// Host-written custom question packs, addressed by pack ID (no accounts).
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

/*
  ───────────────────────────────────────────────────────────────────────────
  NOBODY MAY STRAND A ROOM.

  The incident, 21 Aug 2026, room S1DQVW. Three players filed three reports in
  twenty-six seconds: "Someone d / Isn't answer", "Host is bad", "No work".
  They were all looking at the words "Waiting for other players…" and nothing
  else — no name, no clock, no button, on a screen that would never change
  again.

  It was not one bug, it was a missing rule. The "has everyone answered?" test
  lived inside submit_answer and ONLY inside submit_answer, so the only event
  that could ever end a round was another answer arriving. When the one person
  everybody was waiting for closed their tab, that event was never coming:
  disconnect just set isConnected:false, remove_player did the same, and neither
  asked the question again. The host had no button because there was no handler
  behind one.

  Half of every report the site received in the following week came from this
  game. So the rule, stated generally enough to cover the next handler somebody
  adds:

    EVERY event that can change who we are waiting for must re-ask whether the
    wait is over, and every wait must have a way out that does not depend on
    the person we are waiting for.

  That is three pieces below — roundProgress (who are we waiting for),
  completeRound (end it, exactly once, whoever asks) and maybeCompleteRound
  (the question, asked from submit_answer, disconnect, remove_player and
  reveal_now alike). BUILDING_A_GAME.md §4b says the same thing for the engine
  games; this one predates the engine and never inherited it.
  ───────────────────────────────────────────────────────────────────────────
*/

// The answer window, and the results window. Neither ends anything by itself —
// each is the point at which a host-only escape hatch becomes everyone's.
const ANSWER_SECONDS = 90;
const RESULTS_UNLOCK_SECONDS = 60;
// Client clocks disagree with ours by a second or two. A player whose phone
// runs fast must not be told "not yet" by a server that agrees the time is up.
const CLOCK_GRACE_MS = 3000;

const EMPTY_RESULTS = {
  majorityAnswer: null,
  majorityAnswers: [],
  majorityLabels: [],
  uniqueAnswerPlayer: null,
  scoringPlayers: [],
  allAnswers: [],
};

/*
  May this socket do a host-only thing?

  Host-only is the right default — one person decides when to start, reveal and
  move on, or a party game becomes a fight over the remote. It is the wrong
  answer when that person has gone, and "gone" is the common case: people close
  tabs. Every host-only handler was previously a way for one absent person to
  end everyone else's game.

  So: the host, always. Anyone else in the room, once the host is not connected.
*/
async function mayActAsHost(game, socketId) {
  if (await isHostSocket(game, socketId)) return true;

  const host = await Player.findOne({ gameId: game._id, isHost: true });
  if (host && host.isConnected) return false;

  /*
    Either the host has gone or there is no host record at all (an old room, a
    removed player). Both mean nobody is coming to press the button, so the room
    may act for itself — but it must be THE ROOM. `!host` used to return true
    unconditionally, which handed those actions to any socket that knew a game
    id rather than to the people playing.
  */
  return isInRoom(game, socketId);
}

/** Is this socket actually a player in this game? */
async function isInRoom(game, socketId) {
  return !!(await Player.findOne({ gameId: game._id, socketId }));
}

/*
  Who have we not heard from?

  Derived from the Answer documents themselves, never from Game.playersAnswered.
  That counter was `$inc`-ed before the insert that could fail, so a player who
  refreshed mid-round and answered again bumped it without adding an answer —
  and the round then resolved one answer EARLY for everyone else. Counting the
  rows that exist cannot drift.

  `waiting` is only ever connected players. Someone who left is not someone we
  are waiting for, which is the whole fix.
*/
async function roundProgress(game, round) {
  const players = await Player.find({ gameId: game._id });
  const rows = round ? await Answer.find({ roundId: round._id }).select('playerId') : [];
  const answered = new Set(rows.map((a) => String(a.playerId)));
  const connected = players.filter((p) => p.isConnected);

  return {
    answeredIds: [...answered],
    waitingFor: connected
      .filter((p) => !answered.has(String(p._id)))
      .map((p) => ({ id: String(p._id), username: p.username })),
    // Counted among the connected so the progress bar can never read "3 of 2".
    playersAnswered: connected.filter((p) => answered.has(String(p._id))).length,
    totalPlayers: connected.length,
    // Answers on the round including any from people who have since left. Their
    // answer still counts for scoring — they gave it.
    answerCount: answered.size,
  };
}

async function broadcastProgress(game, round) {
  const p = await roundProgress(game, round);
  io.to(game.roomCode).emit('player_answered', {
    playersAnswered: p.playersAnswered,
    totalPlayers: p.totalPlayers,
    answeredIds: p.answeredIds,
    waitingFor: p.waitingFor,
    roundEndsAt: game.roundEndsAt ? new Date(game.roundEndsAt).getTime() : null,
    // Every deadline ships with the clock that produced it. A phone whose clock
    // is ten minutes out would otherwise either never see the escape hatch —
    // the exact dead screen this work exists to remove — or see it immediately
    // and be refused by a server that disagrees. See toLocalDeadline() on the
    // client: only the DIFFERENCE between these two travels.
    serverNow: Date.now(),
  });
  return p;
}

/*
  Score the round and publish it — exactly once, whoever asks.

  The claim is a conditional update rather than a read-then-write because two
  callers genuinely do arrive together: the last answer landing at the same
  moment as a disconnect, or two people pressing Reveal. Whoever flips the
  status does the work and everybody else gets null and returns, so no round is
  ever scored twice and nobody is awarded two points for one answer.
*/
async function completeRound(game, round) {
  const claimed = await Round.findOneAndUpdate(
    { _id: round._id, status: 'collecting-answers' },
    { $set: { status: 'completed' } },
    { new: true }
  );
  if (!claimed) return false;

  // null when the round has no answers at all — a forced reveal on an empty
  // round. The screen says "nobody answered" rather than inventing a herd.
  const results = (await analyzeRoundAnswers(round._id)) || EMPTY_RESULTS;

  const newPinkCowHolder = determinePinkCowHolder(game.pinkCowHolder, results.uniqueAnswerPlayer);

  if (results.scoringPlayers.length > 0) {
    await Player.updateMany({ _id: { $in: results.scoringPlayers } }, { $inc: { score: 1 } });
  }

  await Game.findByIdAndUpdate(game._id, {
    pinkCowHolder: newPinkCowHolder,
    playersAnswered: 0,
    resultsAt: new Date(),
    // Clear it, or it stays in the past and every later `windowPassed` test
    // reads true — which is how a stale answer window came to authorise a skip
    // of a round that had already been scored.
    roundEndsAt: null,
  });

  const updatedPlayers = await Player.find({ gameId: game._id });

  io.to(game.roomCode).emit('round_completed', {
    results,
    pinkCowHolder: newPinkCowHolder,
    players: updatedPlayers,
    resultsAt: Date.now(),
    serverNow: Date.now(),
    unlockAfterMs: RESULTS_UNLOCK_SECONDS * 1000,
  });

  // 8 points and not holding the cow — see findWinner in gameLogic.js.
  const winner = findWinner(updatedPlayers, newPinkCowHolder);
  if (winner) {
    await Game.findByIdAndUpdate(game._id, { status: 'completed' });
    io.to(game.roomCode).emit('game_completed', { winner });
  }
  return true;
}

/*
  The question, asked from everywhere something could have changed the answer.

  Call this after ANY event that alters who is connected or who has answered.
  `force` is the escape hatch — a deliberate reveal while people are still
  missing — and is authorised by the caller, not here.
*/
async function maybeCompleteRound(gameId, { force = false } = {}) {
  const game = await Game.findById(gameId);
  if (!game || game.status !== 'in-progress') return false;

  const round = await Round.findOne({ gameId: game._id, roundNumber: game.currentRound });
  if (!round || round.status === 'completed') return false;

  const p = await roundProgress(game, round);

  if (!force) {
    if (p.waitingFor.length > 0) return false;
    /*
      Everyone is "done" because everyone has left. Scoring that round would
      hand points out for a question nobody was looking at, and the players
      reconnecting a moment later would land on results for a round they never
      saw. An empty room simply waits.
    */
    if (p.totalPlayers === 0 || p.answerCount === 0) return false;
  }

  return completeRound(game, round);
}

/*
  Deal the next question.

  One definition, used by next_round and by skip_question, because the two used
  to differ only in ways nobody intended. A skip reuses the round NUMBER — the
  group asked for a different question, not for the round counter to jump — so
  it resets the existing round in place and bins its answers, which would
  otherwise still be attached to that round id and get scored into the replay.
*/
async function startNextRound(game, { skipped = false } = {}) {
  const question = getRandomQuestion(game.usedQuestions, game.customQuestions);

  if (skipped) {
    const round = await Round.findOne({ gameId: game._id, roundNumber: game.currentRound });
    if (round) {
      await Answer.deleteMany({ roundId: round._id });
      await Round.updateOne({ _id: round._id }, { $set: { status: 'collecting-answers' } });
    }
  } else {
    await new Round({ gameId: game._id, roundNumber: game.currentRound + 1 }).save();
    game.currentRound += 1;
  }

  game.currentQuestion = question;
  game.usedQuestions.push(question);
  game.playersAnswered = 0;
  game.roundEndsAt = new Date(Date.now() + ANSWER_SECONDS * 1000);
  game.resultsAt = null;
  await game.save();

  io.to(game.roomCode).emit('next_round', {
    roundNumber: game.currentRound,
    question: game.currentQuestion,
    roundEndsAt: game.roundEndsAt.getTime(),
    serverNow: Date.now(),
    skipped,
  });

  const round = await Round.findOne({ gameId: game._id, roundNumber: game.currentRound });
  await broadcastProgress(game, round);
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

      // A bad or expired pack ID must never stop the room being created —
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

      /*
        Send the host their own player row.

        Without it the creator's player list is empty until somebody ELSE joins,
        because nothing else pushes one — create_game emits only this, and
        players_updated is broadcast from join_game. So the first screen of the
        game the site is named after told its host "Invite 2 more friends to
        start" when they needed one, and showed "In the room (0)" while they
        were standing in it.

        Harmless-looking while the lobby only rendered an unlabelled row of
        names. Not harmless once it started counting them.
      */
      socket.emit('game_created', {
        gameId: game._id,
        roomCode,
        playerId: host._id,
        players: [host]
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

      /*
        Whether THIS player has already answered this round, and who the room is
        still waiting for.

        The client used to keep `hasAnswered` in a useState that reset on every
        remount, so anyone who refreshed mid-round was handed the answer box
        back for a question they had already answered. Submitting again hit the
        unique index and told them "Failed to submit answer". The server is the
        only thing that knows, so the server says.
      */
      const jp = await roundProgress(game, currentRound);
      gameState.hasAnswered = jp.answeredIds.includes(String(player._id));
      gameState.waitingFor = jp.waitingFor;
      gameState.playersAnswered = jp.playersAnswered;
      gameState.totalPlayers = jp.totalPlayers;
      gameState.roundEndsAt = game.roundEndsAt ? new Date(game.roundEndsAt).getTime() : null;
      gameState.resultsAt = game.resultsAt ? new Date(game.resultsAt).getTime() : null;
      gameState.unlockAfterMs = RESULTS_UNLOCK_SECONDS * 1000;
      gameState.serverNow = Date.now();

      /*
        Send the player list WITH the join, not only in the broadcast after it.

        `players_updated` goes out to the room a few lines below, but the socket
        that has just joined is still on the home page mid-navigate — the room
        screen has not mounted its listener yet, so the joiner can miss its own
        arrival broadcast entirely and sit with an empty player list until the
        next thing happens in the room. Everything downstream reads that list:
        the scoreboard, who the host is, and therefore whether the host is
        considered gone.
      */
      gameState.players = await Player.find({ gameId: game._id });

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

      /*
        A new arrival changes who we are waiting for, in both directions: they
        are one more person to wait for mid-round, and if the round was only
        being held open by somebody who has since gone, this is the moment that
        becomes visible to everyone else.
      */
      if (currentRound && currentRound.status !== 'completed') {
        await broadcastProgress(game, currentRound);
      }
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

      /*
        Starting a game that has already started BRICKS THE ROOM.

        This handler resets status, currentRound, usedQuestions and roundEndsAt
        and saves the game BEFORE inserting round 1 — and on a game already in
        progress that insert hits the unique (gameId, roundNumber) index and
        throws. The catch emits "Failed to start game", by which point the game
        document has already been rewound: the server believes it is on round 1,
        round 1 is `completed`, so every answer comes back `round-over` and every
        next_round dies on the same duplicate key. Forever.

        It was unreachable while only a lobby host could call this. It is not
        any more: mayActAsHost widened who may press it, and a player joining
        mid-game was landing on the lobby screen with a live Start button.
      */
      if (game.status !== 'waiting') {
        socket.emit('error', { message: 'That game has already started.' });
        return;
      }

      // The host's call — unless the host is the one who left the lobby, in
      // which case anyone still sitting in it may start rather than everybody
      // waiting for somebody who is not coming back.
      if (!(await mayActAsHost(game, socket.id))) {
        socket.emit('error', { message: 'Only the host can start the game' });
        return;
      }

      // Start first round
      game.status = 'in-progress';
      game.currentRound = 1;
      const firstQuestion = getRandomQuestion([], game.customQuestions);
      game.currentQuestion = firstQuestion;
      game.usedQuestions = [firstQuestion];
      game.playersAnswered = 0;
      game.roundEndsAt = new Date(Date.now() + ANSWER_SECONDS * 1000);
      game.resultsAt = null;
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
        round,
        roundEndsAt: game.roundEndsAt.getTime(),
        serverNow: Date.now()
      });

      // Say who we are waiting for from the very first second of the game, not
      // from the first answer. A round that has not been told is a round whose
      // escape hatches are hidden.
      await broadcastProgress(game, round);
    } catch (error) {
      socket.emit('error', { message: 'Failed to start game' });
    }
  });

  /*
    Submit answer.

    Two things changed here. The reveal check that used to live at the bottom of
    this handler now lives in maybeCompleteRound, because being reachable only
    from here is exactly what let one silent player freeze a room forever.

    And the `$inc: { playersAnswered: 1 }` this used to open with is gone. It
    ran BEFORE the insert that could fail, and the insert can fail: Answer has a
    unique index on (roundId, playerId), and a player who refreshed mid-round
    got the answer box back — the client had no way to know it had already
    answered — so a second submit bumped the counter, hit the index, threw, and
    told them "Failed to submit answer" while the round quietly needed one
    fewer answer than there were players. The next person to answer resolved it
    early for everybody. Counts are now derived from the answers that exist.
  */
  socket.on('submit_answer', async ({ gameId, answer }) => {
    try {
      const text = String(answer || '').trim();
      if (!text) {
        socket.emit('error', { message: 'Type an answer first.' });
        return;
      }

      const game = await Game.findOne({ _id: gameId, status: 'in-progress' });
      if (!game) {
        socket.emit('error', { message: 'Invalid game state' });
        return;
      }

      const player = await Player.findOne({ gameId, socketId: socket.id });
      if (!player) {
        socket.emit('error', { message: 'Player not found' });
        return;
      }

      const round = await Round.findOne({ gameId, roundNumber: game.currentRound });
      if (!round || round.status === 'completed') {
        // Not an error the player did anything to cause — the round resolved
        // while they were typing. Say so in words that are not "Failed".
        socket.emit('answer_rejected', { reason: 'round-over' });
        return;
      }

      try {
        await new Answer({
          gameId,
          roundId: round._id,
          playerId: player._id,
          username: player.username,
          originalAnswer: text,
          normalizedAnswer: normalizeAnswer(text)
        }).save();
      } catch (err) {
        if (err && err.code === 11000) {
          socket.emit('answer_rejected', { reason: 'already-answered' });
          return;
        }
        throw err;
      }

      // Keep the legacy counter honest for completedRoundResults' fallback,
      // by writing what is true rather than by adding one and hoping.
      const p = await roundProgress(game, round);
      await Game.updateOne({ _id: game._id }, { $set: { playersAnswered: p.playersAnswered } });

      await broadcastProgress(game, round);
      await maybeCompleteRound(gameId);
    } catch (error) {
      console.error('Submit answer error:', error);
      socket.emit('error', { message: 'Failed to submit answer' });
    }
  });

  /*
    Reveal the answers without waiting for everybody.

    The button that room S1DQVW did not have. The host may always press it once
    at least one answer is in; anybody may press it once the answer window has
    passed, because the person who has wandered off is quite often the host.

    Refused on an empty round: revealing nothing scores nothing and reads as the
    game breaking. The screen offers "skip this question" for that instead.
  */
  socket.on('reveal_now', async ({ gameId }) => {
    try {
      const game = await Game.findById(gameId);
      if (!game || game.status !== 'in-progress') return;

      const round = await Round.findOne({ gameId: game._id, roundNumber: game.currentRound });
      if (!round || round.status === 'completed') return;

      const answers = await Answer.countDocuments({ roundId: round._id });
      if (!answers) {
        socket.emit('error', { message: 'Nobody has answered yet — there is nothing to reveal.' });
        return;
      }

      const endsAt = game.roundEndsAt ? new Date(game.roundEndsAt).getTime() : 0;
      const windowPassed = endsAt > 0 && Date.now() >= endsAt - CLOCK_GRACE_MS;

      // "Anyone" means anyone IN THE ROOM. The window passing is not a reason to
      // stop checking who is asking.
      const allowed = (await mayActAsHost(game, socket.id))
        || (windowPassed && await isInRoom(game, socket.id));
      if (!allowed) {
        socket.emit('error', { message: 'Only the host can reveal early.' });
        return;
      }

      await maybeCompleteRound(gameId, { force: true });
    } catch (error) {
      console.error('reveal_now error:', error);
      socket.emit('error', { message: 'Failed to reveal answers' });
    }
  });

  /*
    Throw this question away and deal another.

    The other half of the escape hatch. reveal_now needs an answer to reveal, so
    a round where the question itself is the problem — nobody understands it,
    nobody wants to answer it — had no exit at all.
  */
  socket.on('skip_question', async ({ gameId }) => {
    try {
      const game = await Game.findById(gameId);
      if (!game || game.status !== 'in-progress') return;

      /*
        Refuse a round that has already been scored.

        skip_question deletes the round's answers and flips it back to
        collecting-answers. Doing that to a COMPLETED round replays a round
        whose points are already on the scoreboard, so answering it again pays
        twice — and it yanks everyone off the results screen they were reading.
        reveal_now had this guard from the start; this did not.
      */
      const round = await Round.findOne({ gameId: game._id, roundNumber: game.currentRound });
      if (!round || round.status === 'completed') return;

      const endsAt = game.roundEndsAt ? new Date(game.roundEndsAt).getTime() : 0;
      const windowPassed = endsAt > 0 && Date.now() >= endsAt - CLOCK_GRACE_MS;
      const allowed = (await mayActAsHost(game, socket.id))
        || (windowPassed && await isInRoom(game, socket.id));
      if (!allowed) {
        socket.emit('error', { message: 'Only the host can skip a question.' });
        return;
      }

      await startNextRound(game, { skipped: true });
    } catch (error) {
      console.error('skip_question error:', error);
      socket.emit('error', { message: 'Failed to skip the question' });
    }
  });

  /*
    Start the next round.

    Host's call, until it isn't. The results screen is the other place a room
    could be stranded — a host who closed their tab after the reveal left
    everyone reading the same scores forever, and "How to go to next round" was
    a fair question with no answer anywhere on the screen. So: the host always,
    anyone once the host is gone, and anyone at all after RESULTS_UNLOCK_SECONDS,
    which also covers the host who is merely making tea.
  */
  socket.on('next_round', async ({ gameId }) => {
    try {
      const game = await Game.findById(gameId);
      if (!game || game.status !== 'in-progress') {
        socket.emit('error', { message: 'Invalid game state' });
        return;
      }

      const shownAt = game.resultsAt ? new Date(game.resultsAt).getTime() : 0;
      const unlocked = shownAt > 0
        && Date.now() >= shownAt + RESULTS_UNLOCK_SECONDS * 1000 - CLOCK_GRACE_MS;

      const allowed = (await mayActAsHost(game, socket.id))
        || (unlocked && await isInRoom(game, socket.id));
      if (!allowed) {
        socket.emit('error', { message: 'Only the host can start the next round yet.' });
        return;
      }

      await startNextRound(game);
    } catch (error) {
      /*
        Two people pressing "Next question" at the same moment both read
        currentRound = N and both try to insert round N+1. The unique index
        keeps that correct — the loser throws before mutating anything — but the
        loser is a player whose action DID happen, and telling them "Failed to
        start next round" in red is a lie about a working button. Now that the
        button is everyone's after a minute, this is a normal Tuesday.
      */
      if (error && error.code === 11000) return;
      console.error('next_round error:', error);
      socket.emit('error', { message: 'Failed to start next round' });
    }
  });

  // ───── Host manual score adjustment (Path B / Just-One-style override) ─────
  socket.on('adjust_score', async ({ gameId, playerId, delta }) => {
    try {
      if (delta !== 1 && delta !== -1) return;

      const game = await Game.findById(gameId);
      if (!game || game.status !== 'in-progress') return;
      // mayActAsHost, not isHostSocket: a room whose host has gone can still
      // need a typo forgiven, and refusing everybody just ends the game.
      if (!(await mayActAsHost(game, socket.id))) {
        socket.emit('error', { message: 'Only the host can adjust scores' });
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
      // The cow is what makes a game unwinnable (8 points while holding it), so
      // a vanished host must not be able to take the ending away with them.
      if (!(await mayActAsHost(game, socket.id))) {
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
      if (!game || !(await mayActAsHost(game, socket.id))) {
        socket.emit('error', { message: 'Unauthorized' });
        return;
      }

      await Player.findOneAndUpdate(
        { gameId, socketId: playerId },
        { isConnected: false }
      );

      const players = await Player.find({ gameId });
      io.to(game.roomCode).emit('players_updated', { players });

      /*
        Removing the person everyone is waiting for has to actually end the
        wait. This used to stop at the line above: the player vanished from the
        list, the round still needed their answer, and the host had done the one
        thing available to them and watched nothing happen.
      */
      const round = await Round.findOne({ gameId: game._id, roundNumber: game.currentRound });
      if (round && round.status !== 'completed') await broadcastProgress(game, round);
      await maybeCompleteRound(game._id);
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

      const rp = await roundProgress(game, currentRound);
      const myAnswerDoc = currentRound
        ? await Answer.findOne({ roundId: currentRound._id, playerId: player._id })
        : null;

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
          playersAnswered: rp.playersAnswered,
          totalPlayers: rp.totalPlayers,
          // A refresh must not hand back the answer box for a question this
          // player has already answered — see join_game for what that cost.
          hasAnswered: rp.answeredIds.includes(String(player._id)),
          // ...and it should show them WHAT they answered. Otherwise coming
          // back mid-round means staring at "your answer is in" with no memory
          // of what went in.
          myAnswer: myAnswerDoc ? myAnswerDoc.originalAnswer : '',
          waitingFor: rp.waitingFor,
          roundEndsAt: game.roundEndsAt ? new Date(game.roundEndsAt).getTime() : null,
          resultsAt: game.resultsAt ? new Date(game.resultsAt).getTime() : null,
          unlockAfterMs: RESULTS_UNLOCK_SECONDS * 1000,
          serverNow: Date.now(),
          roundResults
        }
      });

      // Notify others
      io.to(game.roomCode).emit('players_updated', { players });

      // Coming back changes who the room is waiting for. Everyone else's screen
      // still names this player as missing until we say otherwise.
      if (currentRound && currentRound.status !== 'completed') {
        await broadcastProgress(game, currentRound);
      }

    } catch (error) {
      console.error('Reconnection error:', error);
      socket.emit('reconnect_failed', { reason: 'Server error during reconnection' });
    }
  });

  /*
    Leaving on purpose.

    THERE WAS NO HANDLER FOR THIS. The client had emitted `leave_game` since the
    first version and the server has never listened, which mattered little while
    the only Leave button was on the game-over screen. It matters now: this
    change puts "Leave room" / "Leave game" on the lobby, the answering screen
    and the results screen, and the socket provider is app-level — it does not
    close on a route change. So a player who left stayed `isConnected: true`
    forever, the room went on naming them as the person it was waiting for, and
    maybeCompleteRound could never fire for them. Every remaining round would
    have cost the full answer window.

    Which is this change's own invariant — every event that changes who we are
    waiting for must re-ask whether the wait is over — with one event missing.
  */
  /*
    ── Play again, without losing the room ────────────────────────────────────

    The finished screen's "Play again" button called handleLeaveGame: it left
    the room and dropped you on the hub to make a new one with a new code,
    while everyone else stayed on the final scoreboard. Same complaint a
    Scattergories player filed on 28 Aug 2026 — "Cannot force start a new
    game." — and it was true of all fourteen games.

    THE ROUNDS HAVE TO GO, and that is the whole risk in this handler.
    `roundSchema.index({ gameId, roundNumber }, { unique: true })` means a room
    reset to `waiting` still carries round 1 from the game just played. The
    next start_game inserts round 1 again, hits the duplicate key, throws — and
    by then the game document has already been rewound. That is exactly the
    bricking bug documented on start_game above, reached from a new direction.
    So the old rounds and their answers are deleted here, before anything is
    reset, and the room only goes back to `waiting` if that delete succeeded.

    They are safe to delete: the game they belong to is over and has already
    emitted game_completed. Nothing on main reads them afterwards.
  */
  socket.on('play_again', async ({ gameId }) => {
    try {
      const game = await Game.findById(gameId);
      if (!game) return socket.emit('error', { message: 'Game not found' });

      /* Only from a finished game — mid-game this is a score-wiping griefing
         tool, and mayActAsHost deliberately lets non-hosts act. */
      if (game.status !== 'completed') {
        return socket.emit('error', { message: 'That game is still going.' });
      }
      if (!(await mayActAsHost(game, socket.id))) {
        return socket.emit('error', { message: 'Only the host can start another game' });
      }

      const rounds = await Round.find({ gameId: game._id }).select('_id');
      if (rounds.length) {
        await Answer.deleteMany({ roundId: { $in: rounds.map((r) => r._id) } });
        await Round.deleteMany({ gameId: game._id });
      }

      await Player.updateMany({ gameId: game._id }, { $set: { score: 0 } });

      game.status = 'waiting';
      game.currentRound = 0;
      game.currentQuestion = null;
      game.usedQuestions = [];
      game.playersAnswered = 0;
      game.roundEndsAt = null;
      game.resultsAt = null;
      game.pinkCowHolder = null;
      await game.save();

      const players = await Player.find({ gameId: game._id });
      io.to(game.roomCode).emit('game_replayed', { gameState: game, players, serverNow: Date.now() });
    } catch (err) {
      console.error('play_again error:', err);
      socket.emit('error', { message: 'Could not start another game.' });
    }
  });

  socket.on('leave_game', async ({ gameId }) => {
    try {
      const player = await Player.findOne({ gameId, socketId: socket.id });
      if (!player) return;

      player.isConnected = false;
      await player.save();

      const game = await Game.findById(gameId);
      if (!game) return;

      const players = await Player.find({ gameId: game._id });
      io.to(game.roomCode).emit('players_updated', { players });

      const round = await Round.findOne({ gameId: game._id, roundNumber: game.currentRound });
      if (round && round.status !== 'completed') await broadcastProgress(game, round);
      await maybeCompleteRound(game._id);
    } catch (error) {
      console.error('leave_game error:', error);
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

          /*
            THE FIX FOR ROOM S1DQVW.

            Closing a tab is how people leave a party game — not a Leave button,
            a tab. Before this line, that event updated a list and asked nothing
            else, so the one player everybody was waiting for could remove
            themselves from the room and leave the wait in place forever.
          */
          const round = await Round.findOne({ gameId: game._id, roundNumber: game.currentRound });
          if (round && round.status !== 'completed') await broadcastProgress(game, round);
          await maybeCompleteRound(game._id);
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
mountGame(io, '/cavemanclues', CavemanCluesGame);
mountGame(io, '/huematch', HueMatchGame);

const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
