import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import dotenv from 'dotenv';
dotenv.config();

const app = express();
const allowedOrigins = [
  'https://www.discohitsbingo.com',
  'https://music-bingo-swart.vercel.app',
  'http://localhost:5173',
  process.env.FRONTEND_URL
].filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
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
      if (!origin || allowedOrigins.includes(origin)) {
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

const gameRooms = new Map();
// NUEVO: Almacenar salas "huérfanas" temporalmente
const orphanedRooms = new Map();
const ORPHAN_TIMEOUT = 30000; // 30 segundos para que el host se reconecte

// Función auxiliar para seleccionar un tema aleatorio
const selectRandomTheme = (availableThemes) => {
  if (!availableThemes || availableThemes.length === 0) {
    return null;
  }
  const randomIndex = Math.floor(Math.random() * availableThemes.length);
  return availableThemes[randomIndex];
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
  console.log('Cliente conectado:', socket.id);

  // PATRÓN UNIFICADO: Solo usar callbacks, NO eventos separados
  socket.on('createRoom', (config, callback) => {
    try {
      const roomCode = config.roomCode || Math.random().toString(36).substring(2, 7).toUpperCase();
      const hostPlayer = { id: socket.id, name: 'Game Master', isHost: true, ready: true };
      gameRooms.set(roomCode, {
        hostId: socket.id,
        players: [hostPlayer],
        config,
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
      console.log(`Sala creada: ${roomCode} por ${socket.id}`);

      const response = { roomCode, players: [hostPlayer], config };
      if (callback) callback(response); // SOLO CALLBACK
    } catch (error) {
      console.error('Error creating room:', error);
      if (callback) callback({ error: error.message });
    }
  });

  // MODIFICADO: Manejo mejorado de reconexión de hosts con salas huérfanas
  socket.on('joinRoom', ({ roomCode, name, isHost, reconnecting }, callback) => {
    try {
      let room = gameRooms.get(roomCode);
      
      // NUEVO: Si no existe en activas, buscar en huérfanas
      if (!room && isHost && reconnecting) {
        const orphanedRoom = orphanedRooms.get(roomCode);
        if (orphanedRoom) {
          console.log(`🔄 Restaurando sala huérfana ${roomCode} para host ${socket.id}`);
          
          // Restaurar sala de huérfanas a activas
          room = { ...orphanedRoom };
          delete room.orphanedAt;
          room.hostId = socket.id; // IMPORTANTE: Actualizar hostId
          
          gameRooms.set(roomCode, room);
          orphanedRooms.delete(roomCode);
          
          // Notificar a jugadores que el host volvió
          socket.to(roomCode).emit('hostReconnected', { 
            message: 'El anfitrión se ha reconectado' 
          });
        }
      }
      
      if (!room) {
        if (callback) callback({ error: 'Sala no encontrada' });
        return;
      }

      socket.join(roomCode);

      // Si es un host reconectándose, actualizar el hostId
      if (isHost && reconnecting) {
        console.log(`[DEBUG] Host reconectándose: ${socket.id} para sala ${roomCode}. Anterior hostId: ${room.hostId}`);
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
            name: name || 'Game Master',
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
            name,
            isHost: false,
            ready: false,
            isCorrect: false
          });
        }
      }
      
      const response = {
        roomCode,
        players: room.players,
        config: room.config,
        difficulty: room.config?.difficulty || 'principiante',
        musicThemes: room.config?.musicThemes || [],
        gameStep: room.phase
      };
      if (callback) callback(response);
      emitGameState(roomCode);

    } catch (error) {
      console.error('Error joining room:', error);
      if (callback) callback({ error: error.message });
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

  // MODIFICADO: Logging de depuración agregado
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
  
  // MODIFICADO: Logging de depuración agregado
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
  
  // MODIFICADO: Nueva lógica de disconnect con persistencia para hosts
  socket.on('disconnect', () => {
    console.log('Cliente desconectado:', socket.id);
    
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
        }, ORPHAN_TIMEOUT);
        
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

// MODIFICADO: Limpiar tanto salas activas como huérfanas
setInterval(() => {
  const now = new Date();
  
  // Limpiar salas activas viejas (existente)
  for (const [roomCode, room] of gameRooms.entries()) {
    if (now - room.createdAt > 3600000) { 
      gameRooms.delete(roomCode); 
      console.log(`Sala activa ${roomCode} eliminada por inactividad.`); 
    }
  }
  
  // NUEVO: Limpiar salas huérfanas expiradas
  for (const [roomCode, room] of orphanedRooms.entries()) {
    if (now - room.orphanedAt > ORPHAN_TIMEOUT) {
      orphanedRooms.delete(roomCode);
      console.log(`Sala huérfana ${roomCode} eliminada por timeout.`);
    }
  }
}, 600000);

app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'ok', 
    rooms: gameRooms.size,
    orphanedRooms: orphanedRooms.size 
  });
});

const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor escuchando en puerto ${PORT}`);
});