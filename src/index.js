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

// --- HELPER PRINCIPAL: LA NUEVA FUENTE DE VERDAD ---
// Esta función construye el estado completo del juego y lo emite.
const emitGameState = (roomCode) => {
  const room = gameRooms.get(roomCode);
  if (!room) return;

  const gameState = {
    gameStep: room.phase,
    connectedPlayers: room.players,
    currentCard: room.currentCard,
    selectedCategory: room.currentCategory,
    isMarkingEnabled: room.isMarkingEnabled,
    songPlaying: room.songPlaying,
    playerCorrectStatus: room.players.reduce((acc, player) => {
      acc[player.id] = !!player.isCorrect;
      return acc;
    }, {}),
    winners: room.winners,
    gameOver: room.gameOver,
  };
  io.to(roomCode).emit('gameStateUpdate', gameState);
  console.log(`[STATE UPDATE] Sala ${roomCode} actualizada. Fase: ${room.phase}`);
};

io.on('connection', (socket) => {
  console.log('Cliente conectado:', socket.id);

  socket.on('createRoom', (config) => {
    const roomCode = config.roomCode || Math.random().toString(36).substring(2, 7).toUpperCase();
    const hostPlayer = { id: socket.id, name: 'Game Master', isHost: true, ready: true };
    
    gameRooms.set(roomCode, {
      hostId: socket.id,
      players: [hostPlayer],
      config,
      phase: 'waiting',
      currentCard: null,
      currentCategory: null,
      isMarkingEnabled: false,
      songPlaying: false,
      winners: [],
      gameOver: false,
      createdAt: new Date(),
    });
    socket.join(roomCode);
    console.log(`Sala creada: ${roomCode} por ${socket.id}`);
    
    socket.emit('roomCreated', { roomCode, players: [hostPlayer], config });
  });

  socket.on('joinRoom', ({ roomCode, name, isHost }) => {
    const room = gameRooms.get(roomCode);
    if (!room) return socket.emit('error', { message: 'Sala no encontrada' });
    if (room.players.length >= 12 && !room.players.some(p => p.id === socket.id)) {
        return socket.emit('error', { message: 'Sala llena' });
    }
    socket.join(roomCode);
    const existingPlayer = room.players.find(p => p.id === socket.id);
    if (!existingPlayer && !isHost) {
        room.players.push({ id: socket.id, name, isHost: false, ready: false, isCorrect: false });
    }
    
    socket.emit('roomJoined', {
        roomCode,
        players: room.players,
        difficulty: room.config.difficulty,
        gameStep: room.phase
    });
    emitGameState(roomCode);
  });
  
  // <-- *** AÑADIDO: El handler que faltaba *** -->
  socket.on('playerReady', ({ roomCode }) => {
    console.log(`[RECEIVED] playerReady de ${socket.id} para la sala ${roomCode}`);
    const room = gameRooms.get(roomCode);
    if (!room) {
      console.error(`Error: Sala ${roomCode} no encontrada para playerReady.`);
      return;
    }
    const player = room.players.find(p => p.id === socket.id);
    if (player) {
      console.log(`Jugador ${player.name} encontrado. Marcando como listo.`);
      player.ready = true;
      emitGameState(roomCode);
    } else {
      console.error(`Error: Jugador con socket.id ${socket.id} no encontrado en la sala ${roomCode}.`);
      console.log('Jugadores actuales en la sala:', room.players.map(p => ({id: p.id, name: p.name})));
    }
  });

  socket.on('selectCategory', ({ roomCode, category }) => {
    const room = gameRooms.get(roomCode);
    if (!room || room.hostId !== socket.id) return;
    
    room.phase = 'card';
    room.currentCategory = category;
    room.isMarkingEnabled = false;
    room.songPlaying = false;
    room.currentCard = null;
    room.players.forEach(p => p.isCorrect = false);
    socket.emit('categorySelected', { success: true });
    emitGameState(roomCode);
  });

  socket.on('startSong', ({ roomCode, track }) => {
    const room = gameRooms.get(roomCode);
    if (!room || room.hostId !== socket.id) return;
    
    room.phase = 'playing';
    room.songPlaying = true;
    room.currentCard = { ...track, revealed: false };
    room.isMarkingEnabled = false;
    room.players.forEach(p => p.isCorrect = false);
    socket.emit('songStarted', { success: true });
    emitGameState(roomCode);
  });
  
  socket.on('revealSong', ({ roomCode }) => {
    const room = gameRooms.get(roomCode);
    if (!room || room.hostId !== socket.id) return;
    
    room.phase = 'reviewing';
    room.songPlaying = false;
    if (room.currentCard) {
      room.currentCard.revealed = true;
    }
    emitGameState(roomCode);
  });

  socket.on('markPlayerCorrect', ({ roomCode, playerId }) => {
    const room = gameRooms.get(roomCode);
    if (!room || room.hostId !== socket.id || room.phase !== 'reviewing') return;
    
    const player = room.players.find(p => p.id === playerId);
    if (player) {
      player.isCorrect = !player.isCorrect;
    }
    
    socket.emit('playerMarked', { playerId, isCorrect: player?.isCorrect });
    emitGameState(roomCode);
  });

  socket.on('enableMarking', ({ roomCode }) => {
    const room = gameRooms.get(roomCode);
    if (!room || room.hostId !== socket.id) return;
    room.isMarkingEnabled = true;
    socket.emit('markingEnabled', { success: true });
    emitGameState(roomCode);
  });
  
  socket.on('disableMarking', ({ roomCode }) => {
    const room = gameRooms.get(roomCode);
    if (!room || room.hostId !== socket.id) return;
    
    room.isMarkingEnabled = false;
    socket.emit('markingDisabled', { success: true });
    emitGameState(roomCode);
  });

  socket.on('winner', ({ roomCode, playerName }) => {
    const room = gameRooms.get(roomCode);
    if (!room) return;
    const winner = { id: socket.id, name: playerName };
    if (!room.winners.some(w => w.id === winner.id)) {
      room.winners.push(winner);
    }
    emitGameState(roomCode);
  });

  socket.on('gameOver', ({ roomCode }) => {
    const room = gameRooms.get(roomCode);
    if (!room || room.hostId !== socket.id) return;
    
    room.phase = 'gameOver';
    room.gameOver = true;
    
    socket.emit('gameOverConfirmed', { success: true });
    emitGameState(roomCode);
  });

  socket.on('restartGame', ({ roomCode }) => {
    const room = gameRooms.get(roomCode);
    if (!room || room.hostId !== socket.id) return;
    
    room.phase = 'wheel';
    room.currentCard = null;
    room.currentCategory = null;
    room.isMarkingEnabled = false;
    room.songPlaying = false;
    room.winners = [];
    room.gameOver = false;
    room.players.forEach(p => {
      p.isCorrect = false;
      p.ready = p.isHost;
    });
    socket.emit('gameRestarted', { success: true });
    emitGameState(roomCode);
  });
  
  socket.on('disconnect', () => {
    console.log('Cliente desconectado:', socket.id);
    for (const [roomCode, room] of gameRooms.entries()) {
      if (room.hostId === socket.id) {
        io.to(roomCode).emit('error', { message: 'El anfitrión se ha desconectado. La sala se ha cerrado.'});
        gameRooms.delete(roomCode);
        console.log(`Sala ${roomCode} cerrada por desconexión del host.`);
        return;
      }
      
      const playerIndex = room.players.findIndex(p => p.id === socket.id);
      if (playerIndex > -1) {
        room.players.splice(playerIndex, 1);
        emitGameState(roomCode);
        console.log(`Jugador ${socket.id} eliminado de la sala ${roomCode}.`);
      }
    }
  });
});

setInterval(() => {
  const now = new Date();
  for (const [roomCode, room] of gameRooms.entries()) {
    if (now - room.createdAt > 3600000) { // 1 hora de inactividad
      gameRooms.delete(roomCode);
      console.log(`Sala ${roomCode} eliminada por inactividad.`);
    }
  }
}, 600000); // Revisar cada 10 minutos

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', rooms: gameRooms.size });
});

const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor escuchando en puerto ${PORT}`);
});