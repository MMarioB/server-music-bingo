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
  
  // CORREGIDO: Usar nombres consistentes con el cliente
  const gameState = {
    gameStep: room.phase,
    connectedPlayers: room.players,
    currentCard: room.currentCard,
    currentCategory: room.currentCategory, // Cambié de selectedCategory
    currentSong: room.currentCard, // Agregado para compatibilidad
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
      socket.emit('roomCreated', response);
      if (callback) callback({ success: true, data: response });
    } catch (error) {
      console.error('Error creating room:', error);
      if (callback) callback({ success: false, error: error.message });
    }
  });

  socket.on('joinRoom', ({ roomCode, name, isHost }, callback) => {
    try {
      const room = gameRooms.get(roomCode);
      if (!room) {
        const error = { message: 'Sala no encontrada' };
        socket.emit('error', error);
        if (callback) callback({ success: false, error: error.message });
        return;
      }
      
      socket.join(roomCode);
      const existingPlayer = room.players.find(p => p.id === socket.id);
      if (!existingPlayer && !isHost) {
        room.players.push({ id: socket.id, name, isHost: false, ready: false, isCorrect: false });
      }
      
      const response = { roomCode, players: room.players, difficulty: room.config.difficulty, gameStep: room.phase };
      socket.emit('roomJoined', response);
      emitGameState(roomCode);
      if (callback) callback({ success: true, data: response });
    } catch (error) {
      console.error('Error joining room:', error);
      if (callback) callback({ success: false, error: error.message });
    }
  });
  
  socket.on('playerReady', ({ roomCode }, callback) => {
    try {
      const room = gameRooms.get(roomCode);
      if (!room) {
        if (callback) callback({ success: false, error: 'Sala no encontrada' });
        return;
      }
      
      const player = room.players.find(p => p.id === socket.id);
      if (player) {
        player.ready = true;
        emitGameState(roomCode);
        if (callback) callback({ success: true });
      } else {
        if (callback) callback({ success: false, error: 'Jugador no encontrado' });
      }
    } catch (error) {
      console.error('Error setting player ready:', error);
      if (callback) callback({ success: false, error: error.message });
    }
  });

  socket.on('startGame', ({ roomCode, difficulty }, callback) => {
    try {
      const room = gameRooms.get(roomCode);
      if (!room || room.hostId !== socket.id) {
        if (callback) callback({ success: false, error: 'No autorizado' });
        return;
      }
      
      const allPlayersReady = room.players.every(p => p.ready);
      if (!allPlayersReady) {
        if (callback) callback({ success: false, error: 'No todos los jugadores están listos' });
        return;
      }
      
      room.phase = 'wheel';
      if (difficulty) room.config.difficulty = difficulty;
      emitGameState(roomCode);
      if (callback) callback({ success: true });
    } catch (error) {
      console.error('Error starting game:', error);
      if (callback) callback({ success: false, error: error.message });
    }
  });

  socket.on('selectCategory', ({ roomCode, category }, callback) => {
    try {
      const room = gameRooms.get(roomCode);
      if (!room || room.hostId !== socket.id) {
        if (callback) callback({ success: false, error: 'No autorizado' });
        return;
      }
      
      room.phase = 'card';
      room.currentCategory = category;
      room.isMarkingEnabled = false;
      room.songPlaying = false;
      room.currentCard = null;
      room.players.forEach(p => p.isCorrect = false);
      
      socket.emit('categorySelected', { success: true });
      emitGameState(roomCode);
      if (callback) callback({ success: true });
    } catch (error) {
      console.error('Error selecting category:', error);
      if (callback) callback({ success: false, error: error.message });
    }
  });
  
  socket.on('startSong', ({ roomCode, track }, callback) => {
    try {
      const room = gameRooms.get(roomCode);
      if (!room || room.hostId !== socket.id) {
        if (callback) callback({ success: false, error: 'No autorizado' });
        return;
      }
      
      room.phase = 'playing';
      room.songPlaying = true;
      room.currentCard = { ...track, revealed: false };
      room.isMarkingEnabled = false;
      room.players.forEach(p => p.isCorrect = false);
      
      socket.emit('songStarted', { success: true });
      emitGameState(roomCode);
      if (callback) callback({ success: true });
    } catch (error) {
      console.error('Error starting song:', error);
      if (callback) callback({ success: false, error: error.message });
    }
  });
  
  socket.on('submitPrediction', ({ roomCode, prediction }, callback) => {
    try {
      const room = gameRooms.get(roomCode);
      if (!room) {
        if (callback) callback({ success: false, error: 'Sala no encontrada' });
        return;
      }
      
      const player = room.players.find(p => p.id === socket.id);
      if (!player) {
        if (callback) callback({ success: false, error: 'Jugador no encontrado' });
        return;
      }
      
      io.to(room.hostId).emit('playerPrediction', { 
        playerName: player.name, 
        prediction: prediction 
      });
      
      if (callback) callback({ success: true });
    } catch (error) {
      console.error('Error submitting prediction:', error);
      if (callback) callback({ success: false, error: error.message });
    }
  });

  socket.on('revealSong', ({ roomCode }, callback) => {
    try {
      const room = gameRooms.get(roomCode);
      if (!room || room.hostId !== socket.id) {
        if (callback) callback({ success: false, error: 'No autorizado' });
        return;
      }
      
      room.phase = 'reviewing';
      room.songPlaying = false;
      if (room.currentCard) { 
        room.currentCard.revealed = true; 
      }
      
      emitGameState(roomCode);
      if (callback) callback({ success: true });
    } catch (error) {
      console.error('Error revealing song:', error);
      if (callback) callback({ success: false, error: error.message });
    }
  });
  
  // CORREGIDO: Agregar callback para responder al cliente
  socket.on('markPlayerCorrect', ({ roomCode, playerId }, callback) => {
    try {
      const room = gameRooms.get(roomCode);
      if (!room || room.hostId !== socket.id || room.phase !== 'reviewing') {
        if (callback) callback({ success: false, error: 'No autorizado o fase incorrecta' });
        return;
      }
      
      const player = room.players.find(p => p.id === playerId);
      if (!player) {
        if (callback) callback({ success: false, error: 'Jugador no encontrado' });
        return;
      }
      
      player.isCorrect = !player.isCorrect;
      emitGameState(roomCode);
      
      if (callback) callback({ success: true, playerId, isCorrect: player.isCorrect });
    } catch (error) {
      console.error('Error marking player:', error);
      if (callback) callback({ success: false, error: error.message });
    }
  });

  // CORREGIDO: Agregar callback
  socket.on('enableMarking', ({ roomCode }, callback) => {
    try {
      const room = gameRooms.get(roomCode);
      if (!room || room.hostId !== socket.id) {
        if (callback) callback({ success: false, error: 'No autorizado' });
        return;
      }
      
      room.isMarkingEnabled = true;
      emitGameState(roomCode);
      
      if (callback) callback({ success: true });
    } catch (error) {
      console.error('Error enabling marking:', error);
      if (callback) callback({ success: false, error: error.message });
    }
  });
  
  // CORREGIDO: Agregar callback
  socket.on('disableMarking', ({ roomCode }, callback) => {
    try {
      const room = gameRooms.get(roomCode);
      if (!room || room.hostId !== socket.id) {
        if (callback) callback({ success: false, error: 'No autorizado' });
        return;
      }
      
      room.isMarkingEnabled = false;
      emitGameState(roomCode);
      
      if (callback) callback({ success: true });
    } catch (error) {
      console.error('Error disabling marking:', error);
      if (callback) callback({ success: false, error: error.message });
    }
  });

  // CORREGIDO: Cambiar de 'winner' a 'declareWinner' y agregar callback
  socket.on('declareWinner', ({ roomCode, playerName }, callback) => {
    try {
      const room = gameRooms.get(roomCode);
      if (!room) {
        if (callback) callback({ success: false, error: 'Sala no encontrada' });
        return;
      }
      
      const winner = { id: socket.id, name: playerName };
      if (!room.winners.some(w => w.id === winner.id)) { 
        room.winners.push(winner); 
      }
      
      emitGameState(roomCode);
      
      if (callback) callback({ success: true, winner });
    } catch (error) {
      console.error('Error declaring winner:', error);
      if (callback) callback({ success: false, error: error.message });
    }
  });

  socket.on('gameOver', ({ roomCode }, callback) => {
    try {
      const room = gameRooms.get(roomCode);
      if (!room || room.hostId !== socket.id) {
        if (callback) callback({ success: false, error: 'No autorizado' });
        return;
      }
      
      room.phase = 'gameOver';
      room.gameOver = true;
      
      socket.emit('gameOverConfirmed', { success: true });
      emitGameState(roomCode);
      
      if (callback) callback({ success: true });
    } catch (error) {
      console.error('Error ending game:', error);
      if (callback) callback({ success: false, error: error.message });
    }
  });

  socket.on('restartGame', ({ roomCode }, callback) => {
    try {
      const room = gameRooms.get(roomCode);
      if (!room || room.hostId !== socket.id) {
        if (callback) callback({ success: false, error: 'No autorizado' });
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
      
      socket.emit('gameRestarted', { success: true });
      emitGameState(roomCode);
      
      if (callback) callback({ success: true });
    } catch (error) {
      console.error('Error restarting game:', error);
      if (callback) callback({ success: false, error: error.message });
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