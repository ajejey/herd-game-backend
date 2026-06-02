import { randomUUID } from 'crypto';
import * as store from './store.js';

const HOST_MIGRATION_DELAY_MS = 20_000; // migrate host after 20s offline

/**
 * Mount a game onto a Socket.IO namespace.
 *
 * gameDef must implement:
 *   createInitialState(settings) -> partialState
 *   onStart(state)               -> newState
 *   handleAction(state, action, payload, player) -> newState | null
 *   deriveClientState(state, playerId) -> clientState  (hide secrets per player)
 */
export function mountGame(io, namespacePath, gameDef) {
  const nsp = io.of(namespacePath);

  // pending host migration timers: roomCode -> timeoutHandle
  const migrationTimers = new Map();

  function broadcast(roomCode) {
    const state = store.getGame(roomCode);
    if (!state) return;
    for (const player of state.players) {
      const clientState = gameDef.deriveClientState(state, player.id);
      nsp.to(player.socketId).emit('state_update', { state: clientState });
    }
  }

  function emitError(socket, message, code = 'ERROR') {
    socket.emit('error', { message, code });
  }

  function resolvePlayerBySocket(socketId) {
    for (const [roomCode, state] of store.allGames()) {
      const player = state.players.find(p => p.socketId === socketId);
      if (player) return { roomCode, state, player };
    }
    return null;
  }

  nsp.on('connection', (socket) => {

    // ── Create game ──────────────────────────────────────────────────────────
    socket.on('create_game', ({ username, settings = {} } = {}) => {
      if (!username?.trim()) {
        return emitError(socket, 'Username is required', 'MISSING_USERNAME');
      }

      const roomCode = store.generateRoomCode();
      const playerId = randomUUID();
      const rejoinToken = store.generateToken();

      const player = {
        id: playerId,
        username: username.trim(),
        socketId: socket.id,
        connected: true,
        isHost: true,
        score: 0,
        joinedAt: Date.now(),
      };

      const gameState = {
        roomCode,
        hostId: playerId,
        status: 'lobby',
        players: [player],
        ...gameDef.createInitialState(settings),
        createdAt: Date.now(),
      };

      store.setGame(roomCode, gameState);
      store.setToken(rejoinToken, { roomCode, playerId });
      store.scheduleCleanup(roomCode);

      socket.join(roomCode);
      socket.emit('joined', {
        playerId,
        rejoinToken,
        roomCode,
        state: gameDef.deriveClientState(gameState, playerId),
      });
    });

    // ── Join game ────────────────────────────────────────────────────────────
    socket.on('join_game', ({ roomCode, username, rejoinToken } = {}) => {
      const code = roomCode?.toUpperCase().trim();
      const state = store.getGame(code);

      if (!state) {
        return emitError(socket, 'Room not found. Check your code.', 'ROOM_NOT_FOUND');
      }

      // ── Rejoin path ──
      if (rejoinToken) {
        const tokenData = store.getToken(rejoinToken);
        if (tokenData?.roomCode === code) {
          const player = state.players.find(p => p.id === tokenData.playerId);
          if (player) {
            player.socketId = socket.id;
            player.connected = true;
            store.setGame(code, state);
            store.refreshCleanup(code);

            // cancel any pending migration triggered by this player's disconnect
            if (player.isHost) cancelMigration(code);

            socket.join(code);
            socket.emit('joined', {
              playerId: player.id,
              rejoinToken,
              roomCode: code,
              state: gameDef.deriveClientState(state, player.id),
            });
            broadcast(code); // notify others they're back
            return;
          }
          // Token valid but player not in state — they were kicked or removed
          return emitError(
            socket,
            'You were removed from this room.',
            'PLAYER_REMOVED'
          );
        }
        // token invalid (different room / expired) — fall through to fresh join
      }

      // ── Fresh join ──
      if (state.status !== 'lobby') {
        return emitError(socket, 'Game is already in progress. Ask the host for a rejoin link.', 'GAME_IN_PROGRESS');
      }

      if (!username?.trim()) {
        return emitError(socket, 'Username is required', 'MISSING_USERNAME');
      }

      const taken = state.players.some(
        p => p.username.toLowerCase() === username.trim().toLowerCase()
      );
      if (taken) {
        return emitError(socket, 'That name is already taken in this room.', 'USERNAME_TAKEN');
      }

      const playerId = randomUUID();
      const newToken = store.generateToken();

      const player = {
        id: playerId,
        username: username.trim(),
        socketId: socket.id,
        connected: true,
        isHost: false,
        score: 0,
        joinedAt: Date.now(),
      };

      state.players.push(player);
      store.setGame(code, state);
      store.setToken(newToken, { roomCode: code, playerId });
      store.refreshCleanup(code);

      socket.join(code);
      socket.emit('joined', {
        playerId,
        rejoinToken: newToken,
        roomCode: code,
        state: gameDef.deriveClientState(state, playerId),
      });
      broadcast(code);
    });

    // ── Start game ───────────────────────────────────────────────────────────
    socket.on('start_game', ({ roomCode } = {}) => {
      const code = roomCode?.toUpperCase().trim();
      const state = store.getGame(code);
      if (!state) return emitError(socket, 'Room not found', 'ROOM_NOT_FOUND');

      const player = state.players.find(p => p.socketId === socket.id);
      if (!player || player.id !== state.hostId) {
        return emitError(socket, 'Only the host can start the game', 'UNAUTHORIZED');
      }

      const minPlayers = gameDef.minPlayers ?? 3;
      const connected = state.players.filter(p => p.connected);
      if (connected.length < minPlayers) {
        return emitError(socket, `Need at least ${minPlayers} players to start`, 'NOT_ENOUGH_PLAYERS');
      }

      const newState = gameDef.onStart(state);
      store.setGame(code, newState);
      broadcast(code);
    });

    // ── Game action (all game-specific events go through here) ───────────────
    socket.on('game_action', ({ roomCode, action, payload = {} } = {}) => {
      const code = roomCode?.toUpperCase().trim();
      const state = store.getGame(code);
      if (!state) return;

      const player = state.players.find(p => p.socketId === socket.id);
      if (!player || !player.connected) return;

      store.refreshCleanup(code);

      const newState = gameDef.handleAction(state, action, payload, player);
      if (newState) {
        store.setGame(code, newState);
        broadcast(code);
      }
    });

    // ── Kick player (host only) ──────────────────────────────────────────────
    socket.on('kick_player', ({ roomCode, playerId } = {}) => {
      const code = roomCode?.toUpperCase().trim();
      const state = store.getGame(code);
      if (!state) return;

      const host = state.players.find(p => p.socketId === socket.id);
      if (!host || host.id !== state.hostId) return;
      if (playerId === host.id) return; // host cannot kick themselves

      // Block kicking the current judge during an active round
      const activePhases = ['picking', 'answering', 'judging', 'betting'];
      const currentJudge = state.players[state.judgeIndex];
      if (
        state.status === 'playing' &&
        activePhases.includes(state.phase) &&
        currentJudge?.id === playerId
      ) {
        return emitError(
          socket,
          'Cannot remove the current judge mid-round. Use "Skip round" first.',
          'CANNOT_KICK_JUDGE'
        );
      }

      // Re-anchor judgeIndex by remembering the judge's playerId, then re-finding after removal
      const judgePlayerId = currentJudge?.id;
      state.players = state.players.filter(p => p.id !== playerId);
      if (judgePlayerId) {
        const newIdx = state.players.findIndex(p => p.id === judgePlayerId);
        if (newIdx >= 0) state.judgeIndex = newIdx;
        else state.judgeIndex = state.judgeIndex % Math.max(state.players.length, 1);
      }
      store.setGame(code, state);

      // tell the kicked socket
      const kicked = [...nsp.sockets.values()].find(s => {
        const p = state.players.find(pl => pl.socketId === s.id && pl.id === playerId);
        return !!p;
      });
      if (kicked) kicked.emit('kicked', { message: 'You were removed by the host.' });

      broadcast(code);
    });

    // ── Disconnect ───────────────────────────────────────────────────────────
    socket.on('disconnect', () => {
      const found = resolvePlayerBySocket(socket.id);
      if (!found) return;

      const { roomCode, state, player } = found;
      player.connected = false;
      player.disconnectedAt = Date.now();
      store.setGame(roomCode, state);

      const stillConnected = state.players.filter(p => p.connected);

      // If no one is left, let the cleanup timer handle deletion
      if (stillConnected.length === 0) return;

      broadcast(roomCode);

      // Host migration: if host disconnected, migrate after delay
      if (player.id === state.hostId) {
        scheduleMigration(roomCode, stillConnected);
      }

      // Let game definition react to disconnect (e.g., skip a judge who left)
      if (gameDef.onPlayerDisconnect) {
        const newState = gameDef.onPlayerDisconnect(store.getGame(roomCode), player);
        if (newState) {
          store.setGame(roomCode, newState);
          broadcast(roomCode);
        }
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  function scheduleMigration(roomCode, connectedPlayers) {
    cancelMigration(roomCode);
    const handle = setTimeout(() => {
      migrationTimers.delete(roomCode);
      const state = store.getGame(roomCode);
      if (!state) return;
      // Only migrate if host is still offline
      const host = state.players.find(p => p.id === state.hostId);
      if (host?.connected) return;
      // Pick the connected player who joined earliest
      // Re-read from current state (connectedPlayers may be stale)
      const next = state.players
        .filter(p => p.connected)
        .sort((a, b) => a.joinedAt - b.joinedAt)[0];
      if (!next) return;
      // clear isHost on all, set on new host
      state.players.forEach(p => { p.isHost = (p.id === next.id); });
      state.hostId = next.id;
      store.setGame(roomCode, state);
      broadcast(roomCode);
    }, HOST_MIGRATION_DELAY_MS);
    migrationTimers.set(roomCode, handle);
  }

  function cancelMigration(roomCode) {
    const h = migrationTimers.get(roomCode);
    if (h) clearTimeout(h);
    migrationTimers.delete(roomCode);
  }
}

