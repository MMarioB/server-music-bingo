import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import dotenv from 'dotenv';
import rateLimit from 'express-rate-limit';

// ==== NUEVAS IMPORTACIONES ====
import { SECURITY_CONFIG, ALLOWED_ORIGINS } from './src/config/constants.js';
import { sanitizeString, selectRandomTheme } from './src/utils/helpers.js';

dotenv.config();

const app = express();

// Rate limiter para HTTP endpoints
const httpLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minuto
  max: 100, // 100 requests por minuto
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

// Estado en Memoria (Mantenido igual por ahora)
const gameRooms = new Map();
const orphanedRooms = new Map();

// ==== PROTECCIÓN ANTI-ABUSE ====
const connectionTracker = new Map(); // IP -> { count, timestamp }
const socketEventTracker = new Map(); // socketId -> { events: [], resetTime }
const suspiciousIPs = new Set(); // IPs bloqueadas temporalmente

// Verificar si un socket está haciendo demasiados eventos
const checkEventRate = (socketId) => {
  const now = Date.now();
  const tracker = socketEventTracker.get(socketId);

  if (!tracker) {
    socketEventTracker.set(socketId, { events: [now], resetTime: now + 60000 });
    return true;
  }

  // Resetear si pasó 1 minuto
  if (now > tracker.resetTime) {
    socketEventTracker.set(socketId, { events: [now], resetTime: now + 60000 });
    return true;
  }

  // Filtrar eventos del último minuto
  tracker.events = tracker.events.filter(t => now - t < 60000);

  if (tracker.events.length >= SECURITY_CONFIG.MAX_EVENTS_PER_MINUTE) {
    console.log(`⚠️ [SECURITY] Socket ${socketId} excedió límite de eventos (${tracker.events.length})`);
    return false;
  }

  tracker.events.push(now);
  return true;
};

// Verificar límite de conexiones por IP
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

  // Resetear contador si pasó suficiente tiempo
  if (now - tracker.timestamp > SECURITY_CONFIG.CONNECTION_COOLDOWN) {
    connectionTracker.set(ip, { count: 1, timestamp: now });
    return true;
  }

  // Incrementar contador
  tracker.count++;

  // Si excede 10 conexiones en 1 segundo, bloquear temporalmente
  if (tracker.count > 10) {
    console.log(`🚫 [SECURITY] IP bloqueada por flood: ${ip}`);
    suspiciousIPs.add(ip);
    setTimeout(() => suspiciousIPs.delete(ip), 60000); // Desbloquear en 1 minuto
    return false;
  }

  return true;
};

const emitGameState = (roomCode) => {
  const room = gameRooms.get(roomCode);
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

  // Verificar rate limiting de conexión
  if (!checkConnectionRate(clientIP)) {
    console.log(`🚫 [SECURITY] Conexión rechazada por rate limiting: ${clientIP}`);
    socket.emit('error', { message: 'Demasiadas conexiones. Intenta de nuevo más tarde.' });
    socket.disconnect(true);
    return;
  }

  // PATRÓN UNIFICADO: Solo usar callbacks, NO eventos separados
  socket.on('createRoom', (config, callback) => {
    try {
      // Verificar rate limiting de eventos
      if (!checkEventRate(socket.id)) {
        if (callback) callback({ error: 'Demasiadas peticiones. Espera un momento.' });
        return;
      }

      // Validar límite de salas
      if (gameRooms.size >= SECURITY_CONFIG.MAX_ROOMS) {
        console.log(`⚠️ [SECURITY] Límite de salas alcanzado (${gameRooms.size}/${SECURITY_CONFIG.MAX_ROOMS})`);
        if (callback) callback({ error: 'Servidor lleno. Intenta de nuevo más tarde.' });
        return;
      }

      // Validar y sanitizar roomCode
      let roomCode = config.roomCode
        ? sanitizeString(config.roomCode, SECURITY_CONFIG.MAX_ROOM_CODE_LENGTH).toUpperCase()
        : Math.random().toString(36).substring(2, 7).toUpperCase();

      // Verificar que el roomCode no exista
      if (gameRooms.has(roomCode)) {
        console.log(`⚠️ [SECURITY] Intento de crear sala existente: ${roomCode}`);
        if (callback) callback({ error: 'Código de sala ya existe' });
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

      const hostPlayer = { id: socket.id, name: 'Game Master', isHost: true, ready: true };
      gameRooms.set(roomCode, {
        hostId: socket.id,
        players: [hostPlayer],
        config: validatedConfig,
        phase: 'waiting',
        currentCard: null,
        currentCategory: null,
        currentTheme: null,
        isMarkingEnabled: false,
        songPlaying: false,
        winners: [],
        gameOver: false,
        createdAt: new Date(),
      });
      socket.join(roomCode);
      console.log(`✅ [ROOM] Sala creada: ${roomCode} por ${socket.id} (Total: ${gameRooms.size})`);

      const response = { roomCode, players: [hostPlayer], config: validatedConfig };
      if (callback) callback(response);
    } catch (error) {
      console.error('Error creating room:', error);
      if (callback) callback({ error: 'Error al crear la sala' });
    }
  });

  socket.on('joinRoom', ({ roomCode, name, isHost, reconnecting }, callback) => {
    try {
      // Verificar rate limiting de eventos
      if (!checkEventRate(socket.id)) {
        if (callback) callback({ error: 'Demasiadas peticiones. Espera un momento.' });
        return;
      }

      // Validar y sanitizar inputs
      const sanitizedRoomCode = sanitizeString(roomCode, SECURITY_CONFIG.MAX_ROOM_CODE_LENGTH).toUpperCase();
      const sanitizedName = sanitizeString(name, SECURITY_CONFIG.MAX_NAME_LENGTH);

      if (!sanitizedRoomCode) {
        if (callback) callback({ error: 'Código de sala inválido' });
        return;
      }

      let room = gameRooms.get(sanitizedRoomCode);

      // NUEVO: Si no existe en activas, buscar en huérfanas
      if (!room && isHost && reconnecting) {
        const orphanedRoom = orphanedRooms.get(sanitizedRoomCode);
        if (orphanedRoom) {
          console.log(`🔄 Restaurando sala huérfana ${sanitizedRoomCode} para host ${socket.id}`);

          // Restaurar sala de huérfanas a activas
          room = { ...orphanedRoom };
          delete room.orphanedAt;
          room.hostId = socket.id; // IMPORTANTE: Actualizar hostId

          gameRooms.set(sanitizedRoomCode, room);
          orphanedRooms.delete(sanitizedRoomCode);

          // Notificar a jugadores que el host volvió
          socket.to(sanitizedRoomCode).emit('hostReconnected', {
            message: 'El anfitrión se ha reconectado'
          });
        }
      }

      if (!room) {
        if (callback) callback({ error: 'Sala no encontrada' });
        return;
      }

      // Validar límite de jugadores
      if (!isHost && !reconnecting && room.players.length >= SECURITY_CONFIG.MAX_PLAYERS_PER_ROOM) {
        console.log(`⚠️ [SECURITY] Límite de jugadores alcanzado en sala ${sanitizedRoomCode}`);
        if (callback) callback({ error: 'Sala llena' });
        return;
      }

      socket.join(sanitizedRoomCode);

      // Si es un host reconectándose, actualizar el hostId
      if (isHost && reconnecting) {
        console.log(`[DEBUG] Host reconectándose: ${socket.id} para sala ${sanitizedRoomCode}. Anterior hostId: ${room.hostId}`);
        room.hostId = socket.id;

        // Actualizar el jugador host existente
        const hostPlayer = room.players.find(p => p.isHost);
        if (hostPlayer) {
          console.log(`[DEBUG] Actualizando hostPlayer existente. ID anterior: ${hostPlayer.id}, Nuevo ID: ${socket.id}`);
          hostPlayer.id = socket.id;
        } else {
          // Si no existe, crear el jugador host
          console.log(`[DEBUG] Creando nuevo hostPlayer para socket ${socket.id}`);
          room.players.unshift({
            id: socket.id,
            name: sanitizedName || 'Game Master',
            isHost: true,
            ready: true
          });
        }
      } else {
        // Lógica existente para jugadores regulares
        const existingPlayer = room.players.find(p => p.id === socket.id);
        if (!existingPlayer && !isHost) {
          room.players.push({
            id: socket.id,
            name: sanitizedName,
            isHost: false,
            ready: false,
            isCorrect: false
          });
          console.log(`✅ [PLAYER] Jugador ${sanitizedName} unido a sala ${sanitizedRoomCode} (Total: ${room.players.length})`);
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

  socket.on('playerReady', ({ roomCode }) => {
    try {
      const room = gameRooms.get(roomCode);
      if (!room) return;

      const player = room.players.find(p => p.id === socket.id);
      if (player) {
        player.ready = true;
        emitGameState(roomCode);
      }
    } catch (error) {
      console.error('Error setting player ready:', error);
    }
  });

  socket.on('startGame', ({ roomCode, difficulty }) => {
    try {
      const room = gameRooms.get(roomCode);
      if (!room || room.hostId !== socket.id) return;

      const allPlayersReady = room.players.every(p => p.ready);
      if (!allPlayersReady) return;

      room.phase = 'wheel';
      if (difficulty) room.config.difficulty = difficulty;
      emitGameState(roomCode);
    } catch (error) {
      console.error('Error starting game:', error);
    }
  });

  socket.on('selectCategory', ({ roomCode, category }, callback) => {
    try {
      const room = gameRooms.get(roomCode);
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
      console.error('Error selecting category:', error);
      if (callback) callback({ error: error.message });
    }
  });

  socket.on('startSong', ({ roomCode, track, theme }, callback) => {
    try {
      const room = gameRooms.get(roomCode);
      if (!room || room.hostId !== socket.id) {
        if (callback) callback({ error: 'No autorizado' });
        return;
      }

      // Determinar el tema a usar
      let selectedTheme = theme;
      if (theme === 'random') {
        const availableThemes = room.config?.musicThemes || [];
        selectedTheme = selectRandomTheme(availableThemes);
        console.log(`[THEME] Tema aleatorio seleccionado: ${selectedTheme} de ${availableThemes.join(', ')}`);
      } else {
        console.log(`[THEME] Tema específico seleccionado: ${selectedTheme}`);
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
      console.error('Error starting song:', error);
      if (callback) callback({ error: error.message });
    }
  });

  socket.on('submitPrediction', ({ roomCode, prediction }) => {
    try {
      const room = gameRooms.get(roomCode);
      if (!room) return;

      const player = room.players.find(p => p.id === socket.id);
      if (!player) return;

      io.to(room.hostId).emit('playerPrediction', {
        playerName: player.name,
        prediction: prediction
      });
    } catch (error) {
      console.error('Error submitting prediction:', error);
    }
  });

  socket.on('revealSong', ({ roomCode }) => {
    try {
      const room = gameRooms.get(roomCode);
      if (!room || room.hostId !== socket.id) return;

      room.phase = 'reviewing';
      room.songPlaying = false;
      if (room.currentCard) {
        room.currentCard.revealed = true;
      }

      emitGameState(roomCode);
    } catch (error) {
      console.error('Error revealing song:', error);
    }
  });

  socket.on('markPlayerCorrect', ({ roomCode, playerId }, callback) => {
    try {
      const room = gameRooms.get(roomCode);
      console.log(`[DEBUG] markPlayerCorrect - RoomCode: ${roomCode}, SocketId: ${socket.id}, HostId: ${room?.hostId}, Room exists: ${!!room}`);

      if (!room) {
        console.log(`[DEBUG] markPlayerCorrect - Sala no encontrada: ${roomCode}`);
        if (callback) callback({ error: 'Sala no encontrada' });
        return;
      }

      if (room.hostId !== socket.id || room.phase !== 'reviewing') {
        console.log(`[DEBUG] markPlayerCorrect - No autorizado o fase incorrecta. Expected hostId: ${room.hostId}, Got: ${socket.id}, Phase: ${room.phase}`);
        if (callback) callback({ error: 'No autorizado o fase incorrecta' });
        return;
      }

      const player = room.players.find(p => p.id === playerId);
      if (!player) {
        console.log(`[DEBUG] markPlayerCorrect - Jugador no encontrado: ${playerId}`);
        if (callback) callback({ error: 'Jugador no encontrado' });
        return;
      }

      player.isCorrect = !player.isCorrect;
      emitGameState(roomCode);

      if (callback) callback({ playerId, isCorrect: player.isCorrect });
    } catch (error) {
      console.error('Error marking player:', error);
      if (callback) callback({ error: error.message });
    }
  });

  socket.on('enableMarking', ({ roomCode }, callback) => {
    try {
      const room = gameRooms.get(roomCode);
      console.log(`[DEBUG] enableMarking - RoomCode: ${roomCode}, SocketId: ${socket.id}, HostId: ${room?.hostId}, Room exists: ${!!room}`);

      if (!room) {
        console.log(`[DEBUG] enableMarking - Sala no encontrada: ${roomCode}`);
        if (callback) callback({ error: 'Sala no encontrada' });
        return;
      }

      if (room.hostId !== socket.id) {
        console.log(`[DEBUG] enableMarking - No autorizado. Expected: ${room.hostId}, Got: ${socket.id}`);
        if (callback) callback({ error: 'No autorizado' });
        return;
      }

      room.isMarkingEnabled = true;
      emitGameState(roomCode);

      console.log(`[DEBUG] enableMarking - Éxito para sala ${roomCode}`);
      if (callback) callback({ success: true });
    } catch (error) {
      console.error('Error enabling marking:', error);
      if (callback) callback({ error: error.message });
    }
  });

  socket.on('disableMarking', ({ roomCode }, callback) => {
    try {
      const room = gameRooms.get(roomCode);
      console.log(`[DEBUG] disableMarking - RoomCode: ${roomCode}, SocketId: ${socket.id}, HostId: ${room?.hostId}, Room exists: ${!!room}`);

      if (!room) {
        console.log(`[DEBUG] disableMarking - Sala no encontrada: ${roomCode}`);
        if (callback) callback({ error: 'Sala no encontrada' });
        return;
      }

      if (room.hostId !== socket.id) {
        console.log(`[DEBUG] disableMarking - No autorizado. Expected: ${room.hostId}, Got: ${socket.id}`);
        if (callback) callback({ error: 'No autorizado' });
        return;
      }

      room.isMarkingEnabled = false;
      emitGameState(roomCode);

      console.log(`[DEBUG] disableMarking - Éxito para sala ${roomCode}`);
      if (callback) callback({ success: true });
    } catch (error) {
      console.error('Error disabling marking:', error);
      if (callback) callback({ error: error.message });
    }
  });

  socket.on('declareWinner', ({ roomCode, playerName }, callback) => {
    try {
      const room = gameRooms.get(roomCode);
      if (!room) {
        if (callback) callback({ error: 'Sala no encontrada' });
        return;
      }

      const winner = { id: socket.id, name: playerName };
      if (!room.winners.some(w => w.id === winner.id)) {
        room.winners.push(winner);
        console.log(`[DEBUG] Ganador declarado: ${playerName} (${socket.id}) en sala ${roomCode}`);
      }

      if (callback) callback({ success: true });
      emitGameState(roomCode);
    } catch (error) {
      console.error('Error declaring winner:', error);
      if (callback) callback({ error: error.message });
    }
  });

  socket.on('winner', ({ roomCode, playerName }) => {
    try {
      const room = gameRooms.get(roomCode);
      if (!room) return;

      const winner = { id: socket.id, name: playerName };
      if (!room.winners.some(w => w.id === winner.id)) {
        room.winners.push(winner);
      }

      emitGameState(roomCode);
    } catch (error) {
      console.error('Error declaring winner:', error);
    }
  });

  socket.on('gameOver', ({ roomCode }, callback) => {
    try {
      const room = gameRooms.get(roomCode);
      console.log(`[DEBUG] gameOver - RoomCode: ${roomCode}, SocketId: ${socket.id}, HostId: ${room?.hostId}, Room exists: ${!!room}`);

      if (!room) {
        console.log(`[DEBUG] gameOver - Sala no encontrada: ${roomCode}`);
        if (callback) callback({ error: 'Sala no encontrada' });
        return;
      }

      if (room.hostId !== socket.id) {
        console.log(`[DEBUG] gameOver - No autorizado. Expected: ${room.hostId}, Got: ${socket.id}`);
        if (callback) callback({ error: 'No autorizado' });
        return;
      }

      room.phase = 'gameOver';
      room.gameOver = true;

      console.log(`[DEBUG] gameOver - Éxito para sala ${roomCode}`);
      if (callback) callback({ success: true });
      emitGameState(roomCode);
    } catch (error) {
      console.error('Error ending game:', error);
      if (callback) callback({ error: error.message });
    }
  });

  socket.on('restartGame', ({ roomCode }, callback) => {
    try {
      const room = gameRooms.get(roomCode);
      console.log(`[DEBUG] restartGame - RoomCode: ${roomCode}, SocketId: ${socket.id}, HostId: ${room?.hostId}, Room exists: ${!!room}`);

      if (!room) {
        console.log(`[DEBUG] restartGame - Sala no encontrada: ${roomCode}`);
        if (callback) callback({ error: 'Sala no encontrada' });
        return;
      }

      if (room.hostId !== socket.id) {
        console.log(`[DEBUG] restartGame - No autorizado. Expected: ${room.hostId}, Got: ${socket.id}`);
        if (callback) callback({ error: 'No autorizado' });
        return;
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

      console.log(`[DEBUG] restartGame - Éxito para sala ${roomCode}`);
      if (callback) callback({ success: true });
      emitGameState(roomCode);
    } catch (error) {
      console.error('Error restarting game:', error);
      if (callback) callback({ error: error.message });
    }
  });

  socket.on('updateRoom', ({ roomCode, difficulty }) => {
    const room = gameRooms.get(roomCode);
    if (!room) return;

    if (difficulty !== undefined) {
      room.config.difficulty = difficulty;
    }

    emitGameState(roomCode);  // Ahora emite con difficulty incluida
  });

  socket.on('disconnect', () => {
    console.log('Cliente desconectado:', socket.id);

    // Limpiar tracker de eventos del socket
    socketEventTracker.delete(socket.id);

    for (const [roomCode, room] of gameRooms.entries()) {
      if (room.hostId === socket.id) {
        console.log(`🔄 Host desconectado de sala ${roomCode}. Dando 30s para reconexión...`);

        // NUEVO: No borrar inmediatamente, mover a "huérfanas"
        orphanedRooms.set(roomCode, {
          ...room,
          orphanedAt: new Date()
        });

        gameRooms.delete(roomCode);

        // Notificar a jugadores que el host se desconectó
        io.to(roomCode).emit('hostDisconnected', {
          message: 'El anfitrión se desconectó. Esperando reconexión...'
        });

        // NUEVO: Timer para limpiar sala huérfana
        setTimeout(() => {
          if (orphanedRooms.has(roomCode)) {
            console.log(`💀 Sala huérfana ${roomCode} eliminada definitivamente`);
            orphanedRooms.delete(roomCode);
            io.to(roomCode).emit('error', {
              message: 'La sesión ha expirado. El anfitrión no se reconectó.'
            });
          }
        }, SECURITY_CONFIG.ORPHAN_TIMEOUT);

        return;
      }

      // Jugadores regulares (sin cambios)
      const playerIndex = room.players.findIndex(p => p.id === socket.id);
      if (playerIndex > -1) {
        room.players.splice(playerIndex, 1);
        emitGameState(roomCode);
        console.log(`Jugador ${socket.id} eliminado de la sala ${roomCode}.`);
      }
    }
  });
});

// Limpieza automática
setInterval(() => {
  const now = new Date();

  // Limpiar salas activas viejas
  for (const [roomCode, room] of gameRooms.entries()) {
    if (now - room.createdAt > SECURITY_CONFIG.MAX_ROOM_LIFETIME) {
      gameRooms.delete(roomCode);
      console.log(`🧹 [CLEANUP] Sala activa ${roomCode} eliminada por inactividad.`);
    }
  }

  // Limpiar salas huérfanas expiradas
  for (const [roomCode, room] of orphanedRooms.entries()) {
    if (now - room.orphanedAt > SECURITY_CONFIG.ORPHAN_TIMEOUT) {
      orphanedRooms.delete(roomCode);
      console.log(`🧹 [CLEANUP] Sala huérfana ${roomCode} eliminada por timeout.`);
    }
  }

  // Limpiar trackers de conexión antiguos
  for (const [ip, tracker] of connectionTracker.entries()) {
    if (now - tracker.timestamp > 300000) { // 5 minutos
      connectionTracker.delete(ip);
    }
  }

  // Limpiar trackers de eventos antiguos
  for (const [socketId, tracker] of socketEventTracker.entries()) {
    if (now > tracker.resetTime + 300000) { // 5 minutos después del reset
      socketEventTracker.delete(socketId);
    }
  }

  // Log de estado del servidor
  console.log(`📊 [STATUS] Salas activas: ${gameRooms.size}, Huérfanas: ${orphanedRooms.size}, IPs tracked: ${connectionTracker.size}, Sockets tracked: ${socketEventTracker.size}`);
}, SECURITY_CONFIG.CLEANUP_INTERVAL);

app.get('/health', (req, res) => {
  const totalPlayers = Array.from(gameRooms.values())
    .reduce((sum, room) => sum + room.players.length, 0);

  res.status(200).json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    rooms: {
      active: gameRooms.size,
      orphaned: orphanedRooms.size,
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
  Modo: Hito 1 (Refactorizado)

  🛡️  Configuración de Seguridad:
  ├─ Salas máximas: ${SECURITY_CONFIG.MAX_ROOMS}
  ├─ Jugadores por sala: ${SECURITY_CONFIG.MAX_PLAYERS_PER_ROOM}
  ├─ Rate limit HTTP: 100 req/min
  ├─ Rate limit WebSocket: ${SECURITY_CONFIG.MAX_EVENTS_PER_MINUTE} eventos/min
  ├─ Cooldown de conexión: ${SECURITY_CONFIG.CONNECTION_COOLDOWN}ms
  ├─ Limpieza automática: cada ${SECURITY_CONFIG.CLEANUP_INTERVAL / 1000}s
  └─ Tiempo de vida máximo: ${SECURITY_CONFIG.MAX_ROOM_LIFETIME / 60000} min

  ✅ Servidor listo!
  `);
});