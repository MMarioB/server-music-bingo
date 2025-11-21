import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import dotenv from 'dotenv';
import rateLimit from 'express-rate-limit';

import { SECURITY_CONFIG, ALLOWED_ORIGINS } from './src/config/constants.js';
import { sanitizeString, selectRandomTheme } from './src/utils/helpers.js';
// NUEVO IMPORT
import { roomManager } from './src/services/RoomManager.js';

dotenv.config();

const app = express();

const httpLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  message: 'Demasiadas peticiones desde esta IP, intenta de nuevo más tarde',
  standardHeaders: true,
  legacyHeaders: false,
});

app.use(httpLimiter);
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  methods: ['GET', 'POST'],
  credentials: true
}));

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: (origin, callback) => {
      if (!origin || ALLOWED_ORIGINS.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error('Not allowed by CORS'));
      }
    },
    methods: ['GET', 'POST'],
    credentials: true,
  },
  pingTimeout: 60000,
  pingInterval: 25000,
});

// ==== PROTECCIÓN ANTI-ABUSE ====
// (Esto lo mantenemos aquí por ahora, es lógica de conexión, no de juego)
const connectionTracker = new Map();
const socketEventTracker = new Map();
const suspiciousIPs = new Set();

const checkEventRate = (socketId) => {
  const now = Date.now();
  const tracker = socketEventTracker.get(socketId);

  if (!tracker) {
    socketEventTracker.set(socketId, { events: [now], resetTime: now + 60000 });
    return true;
  }

  if (now > tracker.resetTime) {
    socketEventTracker.set(socketId, { events: [now], resetTime: now + 60000 });
    return true;
  }

  tracker.events = tracker.events.filter(t => now - t < 60000);

  if (tracker.events.length >= SECURITY_CONFIG.MAX_EVENTS_PER_MINUTE) {
    console.log(`⚠️ [SECURITY] Socket ${socketId} excedió límite de eventos (${tracker.events.length})`);
    return false;
  }

  tracker.events.push(now);
  return true;
};

const checkConnectionRate = (ip) => {
  if (suspiciousIPs.has(ip)) {
    console.log(`🚫 [SECURITY] IP bloqueada intentando conectar: ${ip}`);
    return false;
  }

  const now = Date.now();
  const tracker = connectionTracker.get(ip);

  if (!tracker) {
    connectionTracker.set(ip, { count: 1, timestamp: now });
    return true;
  }

  if (now - tracker.timestamp > SECURITY_CONFIG.CONNECTION_COOLDOWN) {
    connectionTracker.set(ip, { count: 1, timestamp: now });
    return true;
  }

  tracker.count++;

  if (tracker.count > 10) {
    console.log(`🚫 [SECURITY] IP bloqueada por flood: ${ip}`);
    suspiciousIPs.add(ip);
    setTimeout(() => suspiciousIPs.delete(ip), 60000);
    return false;
  }

  return true;
};

// Helper unificado para emitir estado
const emitGameState = (roomCode) => {
  // AHORA USAMOS EL MANAGER
  const room = roomManager.getRoom(roomCode);
  if (!room) return;

  const gameState = {
    gameStep: room.phase,
    connectedPlayers: room.players,
    currentCard: room.currentCard,
    currentCategory: room.currentCategory,
    currentSong: room.currentCard,
    isMarkingEnabled: room.isMarkingEnabled,
    songPlaying: room.songPlaying,
    playerCorrectStatus: room.players.reduce((acc, player) => {
      acc[player.id] = !!player.isCorrect;
      return acc;
    }, {}),
    winners: room.winners,
    gameOver: room.gameOver,
    difficulty: room.config?.difficulty || 'principiante',
    musicThemes: room.config?.musicThemes || [],
    currentTheme: room.currentTheme || null,
  };

  io.to(roomCode).emit('gameStateUpdate', gameState);
  console.log(`[STATE UPDATE] Sala ${roomCode} actualizada. Fase: ${room.phase}`);
};

io.on('connection', (socket) => {
  const clientIP = socket.handshake.address;
  console.log('Cliente conectado:', socket.id, 'IP:', clientIP);

  if (!checkConnectionRate(clientIP)) {
    console.log(`🚫 [SECURITY] Conexión rechazada por rate limiting: ${clientIP}`);
    socket.emit('error', { message: 'Demasiadas conexiones. Intenta de nuevo más tarde.' });
    socket.disconnect(true);
    return;
  }

  socket.on('createRoom', (config, callback) => {
    try {
      if (!checkEventRate(socket.id)) {
        if (callback) callback({ error: 'Demasiadas peticiones. Espera un momento.' });
        return;
      }

      const stats = roomManager.getStats();
      if (stats.active >= SECURITY_CONFIG.MAX_ROOMS) {
        if (callback) callback({ error: 'Servidor lleno. Intenta de nuevo más tarde.' });
        return;
      }

      // Validar configuración
      const validatedConfig = {
        ...config,
        difficulty: ['principiante', 'intermedio', 'experto'].includes(config.difficulty)
          ? config.difficulty
          : 'principiante',
        musicThemes: Array.isArray(config.musicThemes)
          ? config.musicThemes.filter(t => typeof t === 'string').slice(0, 10)
          : [],
      };

      // DELEGAMOS AL MANAGER LA CREACIÓN
      const newRoom = roomManager.createRoom(socket.id, validatedConfig);

      socket.join(newRoom.roomCode);
      console.log(`✅ [ROOM] Sala creada: ${newRoom.roomCode} por ${socket.id}`);

      // Preparamos respuesta para React
      const hostPlayer = newRoom.players[0];
      const response = { roomCode: newRoom.roomCode, players: [hostPlayer], config: validatedConfig };

      if (callback) callback(response);

    } catch (error) {
      console.error('Error creating room:', error);
      if (callback) callback({ error: error.message || 'Error al crear la sala' });
    }
  });

  socket.on('joinRoom', ({ roomCode, name, isHost, reconnecting }, callback) => {
    try {
      if (!checkEventRate(socket.id)) {
        if (callback) callback({ error: 'Demasiadas peticiones. Espera un momento.' });
        return;
      }

      const sanitizedRoomCode = sanitizeString(roomCode, SECURITY_CONFIG.MAX_ROOM_CODE_LENGTH).toUpperCase();
      const sanitizedName = sanitizeString(name, SECURITY_CONFIG.MAX_NAME_LENGTH);

      if (!sanitizedRoomCode) {
        if (callback) callback({ error: 'Código de sala inválido' });
        return;
      }

      // 1. Intentar obtener sala activa
      let room = roomManager.getRoom(sanitizedRoomCode);

      // 2. Si no está activa y es reconexión de host, intentar restaurar
      if (!room && isHost && reconnecting) {
        room = roomManager.restoreRoom(sanitizedRoomCode, socket.id);

        if (room) {
          console.log(`🔄 Restaurando sala huérfana ${sanitizedRoomCode} para host ${socket.id}`);
          socket.to(sanitizedRoomCode).emit('hostReconnected', {
            message: 'El anfitrión se ha reconectado'
          });
        }
      }

      if (!room) {
        if (callback) callback({ error: 'Sala no encontrada' });
        return;
      }

      if (!isHost && !reconnecting && room.players.length >= SECURITY_CONFIG.MAX_PLAYERS_PER_ROOM) {
        if (callback) callback({ error: 'Sala llena' });
        return;
      }

      socket.join(sanitizedRoomCode);

      // Lógica de reconexión de host
      if (isHost && reconnecting) {
        // El restoreRoom ya actualizó el hostId, solo necesitamos asegurar el jugador
        const hostPlayer = room.players.find(p => p.isHost);
        if (hostPlayer) {
          hostPlayer.id = socket.id; // Actualizar ID del socket
        } else {
          room.players.unshift({
            id: socket.id,
            name: sanitizedName || 'Game Master',
            isHost: true,
            ready: true
          });
        }
      } else {
        // Jugador normal
        const existingPlayer = room.players.find(p => p.id === socket.id);
        if (!existingPlayer && !isHost) {
          room.players.push({
            id: socket.id,
            name: sanitizedName,
            isHost: false,
            ready: false,
            isCorrect: false
          });
        }
      }

      const response = {
        roomCode: sanitizedRoomCode,
        players: room.players,
        config: room.config,
        difficulty: room.config?.difficulty || 'principiante',
        musicThemes: room.config?.musicThemes || [],
        gameStep: room.phase
      };
      if (callback) callback(response);
      emitGameState(sanitizedRoomCode);

    } catch (error) {
      console.error('Error joining room:', error);
      if (callback) callback({ error: 'Error al unirse a la sala' });
    }
  });

  // A PARTIR DE AQUÍ, USAMOS roomManager.getRoom(code) EN LUGAR DE gameRooms.get(code)
  // EL RESTO DE LA LÓGICA INTERNA SIGUE IGUAL PORQUE roomManager DEVUELVE EL OBJETO POR REFERENCIA

  socket.on('playerReady', ({ roomCode }) => {
    try {
      const room = roomManager.getRoom(roomCode);
      if (!room) return;

      const player = room.players.find(p => p.id === socket.id);
      if (player) {
        player.ready = true;
        emitGameState(roomCode);
      }
    } catch (error) { console.error(error); }
  });

  socket.on('startGame', ({ roomCode, difficulty }) => {
    try {
      const room = roomManager.getRoom(roomCode);
      if (!room || room.hostId !== socket.id) return;

      const allPlayersReady = room.players.every(p => p.ready);
      if (!allPlayersReady) return;

      room.phase = 'wheel';
      if (difficulty) room.config.difficulty = difficulty;
      emitGameState(roomCode);
    } catch (error) { console.error(error); }
  });

  socket.on('selectCategory', ({ roomCode, category }, callback) => {
    try {
      const room = roomManager.getRoom(roomCode);
      if (!room || room.hostId !== socket.id) {
        if (callback) callback({ error: 'No autorizado' });
        return;
      }
      room.phase = 'card';
      room.currentCategory = category;
      room.currentTheme = null;
      room.isMarkingEnabled = false;
      room.songPlaying = false;
      room.currentCard = null;
      room.players.forEach(p => p.isCorrect = false);

      if (callback) callback({ success: true });
      emitGameState(roomCode);
    } catch (error) {
      if (callback) callback({ error: error.message });
    }
  });

  socket.on('startSong', ({ roomCode, track, theme }, callback) => {
    try {
      const room = roomManager.getRoom(roomCode);
      if (!room || room.hostId !== socket.id) {
        if (callback) callback({ error: 'No autorizado' });
        return;
      }

      let selectedTheme = theme;
      if (theme === 'random') {
        const availableThemes = room.config?.musicThemes || [];
        selectedTheme = selectRandomTheme(availableThemes);
      }

      room.phase = 'playing';
      room.songPlaying = true;
      room.currentTheme = selectedTheme;
      room.currentCard = { ...track, revealed: false, theme: selectedTheme };
      room.isMarkingEnabled = false;
      room.players.forEach(p => p.isCorrect = false);

      if (callback) callback({ success: true, theme: selectedTheme });
      emitGameState(roomCode);
    } catch (error) {
      if (callback) callback({ error: error.message });
    }
  });

  socket.on('submitPrediction', ({ roomCode, prediction }) => {
    try {
      const room = roomManager.getRoom(roomCode);
      if (!room) return;
      const player = room.players.find(p => p.id === socket.id);
      if (!player) return;
      io.to(room.hostId).emit('playerPrediction', { playerName: player.name, prediction });
    } catch (error) { console.error(error); }
  });

  socket.on('revealSong', ({ roomCode }) => {
    try {
      const room = roomManager.getRoom(roomCode);
      if (!room || room.hostId !== socket.id) return;
      room.phase = 'reviewing';
      room.songPlaying = false;
      if (room.currentCard) room.currentCard.revealed = true;
      emitGameState(roomCode);
    } catch (error) { console.error(error); }
  });

  socket.on('markPlayerCorrect', ({ roomCode, playerId }, callback) => {
    try {
      const room = roomManager.getRoom(roomCode);
      if (!room) { if (callback) callback({ error: 'Sala no encontrada' }); return; }
      if (room.hostId !== socket.id || room.phase !== 'reviewing') {
        if (callback) callback({ error: 'No autorizado' }); return;
      }
      const player = room.players.find(p => p.id === playerId);
      if (!player) { if (callback) callback({ error: 'Jugador no encontrado' }); return; }

      player.isCorrect = !player.isCorrect;
      emitGameState(roomCode);
      if (callback) callback({ playerId, isCorrect: player.isCorrect });
    } catch (error) { if (callback) callback({ error: error.message }); }
  });

  socket.on('enableMarking', ({ roomCode }, callback) => {
    try {
      const room = roomManager.getRoom(roomCode);
      if (!room || room.hostId !== socket.id) {
        if (callback) callback({ error: 'No autorizado' }); return;
      }
      room.isMarkingEnabled = true;
      emitGameState(roomCode);
      if (callback) callback({ success: true });
    } catch (error) { if (callback) callback({ error: error.message }); }
  });

  socket.on('disableMarking', ({ roomCode }, callback) => {
    try {
      const room = roomManager.getRoom(roomCode);
      if (!room || room.hostId !== socket.id) {
        if (callback) callback({ error: 'No autorizado' }); return;
      }
      room.isMarkingEnabled = false;
      emitGameState(roomCode);
      if (callback) callback({ success: true });
    } catch (error) { if (callback) callback({ error: error.message }); }
  });

  socket.on('declareWinner', ({ roomCode, playerName }, callback) => {
    try {
      const room = roomManager.getRoom(roomCode);
      if (!room) { if (callback) callback({ error: 'Sala no encontrada' }); return; }

      const winner = { id: socket.id, name: playerName };
      if (!room.winners.some(w => w.id === winner.id)) {
        room.winners.push(winner);
      }
      if (callback) callback({ success: true });
      emitGameState(roomCode);
    } catch (error) { if (callback) callback({ error: error.message }); }
  });

  socket.on('winner', ({ roomCode, playerName }) => {
    try {
      const room = roomManager.getRoom(roomCode);
      if (!room) return;
      const winner = { id: socket.id, name: playerName };
      if (!room.winners.some(w => w.id === winner.id)) { room.winners.push(winner); }
      emitGameState(roomCode);
    } catch (error) { console.error(error); }
  });

  socket.on('gameOver', ({ roomCode }, callback) => {
    try {
      const room = roomManager.getRoom(roomCode);
      if (!room || room.hostId !== socket.id) {
        if (callback) callback({ error: 'No autorizado' }); return;
      }
      room.phase = 'gameOver';
      room.gameOver = true;
      if (callback) callback({ success: true });
      emitGameState(roomCode);
    } catch (error) { if (callback) callback({ error: error.message }); }
  });

  socket.on('restartGame', ({ roomCode }, callback) => {
    try {
      const room = roomManager.getRoom(roomCode);
      if (!room || room.hostId !== socket.id) {
        if (callback) callback({ error: 'No autorizado' }); return;
      }
      room.phase = 'wheel';
      room.currentCard = null;
      room.currentCategory = null;
      room.currentTheme = null;
      room.isMarkingEnabled = false;
      room.songPlaying = false;
      room.winners = [];
      room.gameOver = false;
      room.players.forEach(p => {
        p.isCorrect = false;
        p.ready = p.isHost;
      });
      if (callback) callback({ success: true });
      emitGameState(roomCode);
    } catch (error) { if (callback) callback({ error: error.message }); }
  });

  socket.on('updateRoom', ({ roomCode, difficulty }) => {
    const room = roomManager.getRoom(roomCode);
    if (!room) return;
    if (difficulty !== undefined) room.config.difficulty = difficulty;
    emitGameState(roomCode);
  });

  socket.on('disconnect', () => {
    console.log('Cliente desconectado:', socket.id);
    socketEventTracker.delete(socket.id);

    for (const [roomCode, room] of roomManager.rooms.entries()) {
      if (room.hostId === socket.id) {
        console.log(`🔄 Host desconectado de sala ${roomCode}. Dando 30s para reconexión...`);

        // USAMOS EL MANAGER PARA HUÉRFANAS
        roomManager.orphanRoom(roomCode);

        io.to(roomCode).emit('hostDisconnected', {
          message: 'El anfitrión se desconectó. Esperando reconexión...'
        });

        setTimeout(() => {
          // Verificamos si sigue huérfana en el manager
          const orphaned = roomManager.getOrphanedRoom(roomCode);
          if (orphaned) {
            console.log(`💀 Sala huérfana ${roomCode} eliminada definitivamente`);
            roomManager.deleteRoom(roomCode);
            io.to(roomCode).emit('error', {
              message: 'La sesión ha expirado. El anfitrión no se reconectó.'
            });
          }
        }, SECURITY_CONFIG.ORPHAN_TIMEOUT);
        return;
      }

      // Jugadores regulares
      const playerIndex = room.players.findIndex(p => p.id === socket.id);
      if (playerIndex > -1) {
        room.players.splice(playerIndex, 1);
        emitGameState(roomCode);
        console.log(`Jugador ${socket.id} eliminado de la sala ${roomCode}.`);
      }
    }
  });
});

// Limpieza automática USANDO EL MANAGER
setInterval(() => {
  const cleaned = roomManager.cleanupStaleRooms();
  const now = new Date();

  // Limpiar trackers (esto sigue aquí)
  for (const [ip, tracker] of connectionTracker.entries()) {
    if (now - tracker.timestamp > 300000) connectionTracker.delete(ip);
  }
  for (const [socketId, tracker] of socketEventTracker.entries()) {
    if (now > tracker.resetTime + 300000) socketEventTracker.delete(socketId);
  }

  const stats = roomManager.getStats();
  console.log(`📊 [STATUS] Salas activas: ${stats.active}, Huérfanas: ${stats.orphaned}, Cleaned: ${cleaned}`);
}, SECURITY_CONFIG.CLEANUP_INTERVAL);

app.get('/health', (req, res) => {
  const stats = roomManager.getStats();
  // Calcular total players (un poco manual, pero sirve)
  let totalPlayers = 0;
  roomManager.rooms.forEach(r => totalPlayers += r.players.length);

  res.status(200).json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    rooms: {
      active: stats.active,
      orphaned: stats.orphaned,
      max: SECURITY_CONFIG.MAX_ROOMS,
    },
    players: {
      total: totalPlayers,
      maxPerRoom: SECURITY_CONFIG.MAX_PLAYERS_PER_ROOM,
    },
    security: {
      trackedIPs: connectionTracker.size,
      trackedSockets: socketEventTracker.size,
      blockedIPs: suspiciousIPs.size,
    },
  });
});

const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`
╔════════════════════════════════════════════════════════╗
║       🎵 Music Bingo Server - PROTEGIDO 🔒           ║
╚════════════════════════════════════════════════════════╝
  Puerto: ${PORT}
  Modo: Hito 2 (RoomManager Integrado)
  ✅ Servidor listo!
  `);
});