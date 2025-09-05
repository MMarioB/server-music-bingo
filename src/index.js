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
        isMarkingEnabled: false,
        songPlaying: false,
        winners: [],
        gameOver: false,
        createdAt: new Date(),
      });
      socket.join(roomCode);
      console.log(`Sala creada: ${roomCode} por ${socket.id}`);
      
      const response = { roomCode, players: [hostPlayer], config };
      callback(response); // SOLO CALLBACK
    } catch (error) {
      console.error('Error creating room:', error);
      callback({ error: error.message });
    }
  });

  socket.on('joinRoom', ({ roomCode, name, isHost }, callback) => {
    try {
      const room = gameRooms.get(roomCode);
      if (!room) {
        callback({ error: 'Sala no encontrada' });
        return;
      }
      
      socket.join(roomCode);
      const existingPlayer = room.players.find(p => p.id === socket.id);
      if (!existingPlayer && !isHost) {
        room.players.push({ id: socket.id, name, isHost: false, ready: false, isCorrect: false });
      }
      
      const response = { roomCode, players: room.players, difficulty: room.config.difficulty, gameStep: room.phase };
      callback(response); // SOLO CALLBACK
      emitGameState(roomCode);
    } catch (error) {
      console.error('Error joining room:', error);
      callback({ error: error.message });
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
        callback({ error: 'No autorizado' });
        return;
      }
      
      room.phase = 'card';
      room.currentCategory = category;
      room.isMarkingEnabled = false;
      room.songPlaying = false;
      room.currentCard = null;
      room.players.forEach(p => p.isCorrect = false);
      
      callback({ success: true });
      emitGameState(roomCode);
    } catch (error) {
      console.error('Error selecting category:', error);
      callback({ error: error.message });
    }
  });
  
  socket.on('startSong', ({ roomCode, track }, callback) => {
    try {
      const room = gameRooms.get(roomCode);
      if (!room || room.hostId !== socket.id) {
        callback({ error: 'No autorizado' });
        return;
      }
      
      room.phase = 'playing';
      room.songPlaying = true;
      room.currentCard = { ...track, revealed: false };
      room.isMarkingEnabled = false;
      room.players.forEach(p => p.isCorrect = false);
      
      callback({ success: true });
      emitGameState(roomCode);
    } catch (error) {
      console.error('Error starting song:', error);
      callback({ error: error.message });
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
      if (!room || room.hostId !== socket.id || room.phase !== 'reviewing') {
        callback({ error: 'No autorizado o fase incorrecta' });
        return;
      }
      
      const player = room.players.find(p => p.id === playerId);
      if (!player) {
        callback({ error: 'Jugador no encontrado' });
        return;
      }
      
      player.isCorrect = !player.isCorrect;
      emitGameState(roomCode);
      
      callback({ playerId, isCorrect: player.isCorrect });
    } catch (error) {
      console.error('Error marking player:', error);
      callback({ error: error.message });
    }
  });

  socket.on('enableMarking', ({ roomCode }, callback) => {
    try {
      const room = gameRooms.get(roomCode);
      if (!room || room.hostId !== socket.id) {
        callback({ error: 'No autorizado' });
        return;
      }
      
      room.isMarkingEnabled = true;
      emitGameState(roomCode);
      
      callback({ success: true });
    } catch (error) {
      console.error('Error enabling marking:', error);
      callback({ error: error.message });
    }
  });
  
  socket.on('disableMarking', ({ roomCode }, callback) => {
    try {
      const room = gameRooms.get(roomCode);
      if (!room || room.hostId !== socket.id) {
        callback({ error: 'No autorizado' });
        return;
      }
      
      room.isMarkingEnabled = false;
      emitGameState(roomCode);
      
      callback({ success: true });
    } catch (error) {
      console.error('Error disabling marking:', error);
      callback({ error: error.message });
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
      if (!room || room.hostId !== socket.id) {
        callback({ error: 'No autorizado' });
        return;
      }
      
      room.phase = 'gameOver';
      room.gameOver = true;
      
      callback({ success: true });
      emitGameState(roomCode);
    } catch (error) {
      console.error('Error ending game:', error);
      callback({ error: error.message });
    }
  });

  socket.on('restartGame', ({ roomCode }, callback) => {
    try {
      const room = gameRooms.get(roomCode);
      if (!room || room.hostId !== socket.id) {
        callback({ error: 'No autorizado' });
        return;
      }
      
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
      
      callback({ success: true });
      emitGameState(roomCode);
    } catch (error) {
      console.error('Error restarting game:', error);
      callback({ error: error.message });
    }
  });

  socket.on('updateRoom', ({ roomCode, data }) => {
    try {
      const room = gameRooms.get(roomCode);
      if (!room) return;
      
      if (data) {
        Object.assign(room, data);
      }
      
      emitGameState(roomCode);
    } catch (error) {
      console.error('Error updating room:', error);
    }
  });
  
  socket.on('disconnect', () => {
    console.log('Cliente desconectado:', socket.id);
    for (const [roomCode, room] of gameRooms.entries()) {
      if (room.hostId === socket.id) {
        io.to(roomCode).emit('error', { message: 'El anfitrión se ha desconectado.'});
        gameRooms.delete(roomCode);
        console.log(`Sala ${roomCode} cerrada.`);
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
    if (now - room.createdAt > 3600000) { 
      gameRooms.delete(roomCode); 
      console.log(`Sala ${roomCode} eliminada.`); 
    }
  }
}, 600000);

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', rooms: gameRooms.size });
});

const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor escuchando en puerto ${PORT}`);
});