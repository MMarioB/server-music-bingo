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
    allowedHeaders: ['*']
  },
  pingTimeout: 60000,
  pingInterval: 25000,
  transports: ['polling', 'websocket'],
  allowUpgrades: true,
  maxHttpBufferSize: 1e8,
  connectTimeout: 45000,
  allowEIO3: true
});

const gameRooms = new Map();
const MAX_PLAYERS = 12;

class ConnectionQueue {
  constructor() {
    this.queues = new Map();
  }

  async enqueue(roomCode, playerData) {
    if (!this.queues.has(roomCode)) {
      this.queues.set(roomCode, []);
    }

    const queue = this.queues.get(roomCode);
    return new Promise((resolve, reject) => {
      queue.push({ playerData, resolve, reject });
      this.processQueue(roomCode);
    });
  }

  async processQueue(roomCode) {
    const queue = this.queues.get(roomCode);
    if (!queue || queue.length === 0) return;

    const room = gameRooms.get(roomCode);
    if (!room) {
      this.queues.delete(roomCode);
      return;
    }

    while (queue.length > 0 && room.players.length < MAX_PLAYERS) {
      const { playerData, resolve, reject } = queue.shift();

      try {
        await new Promise(r => setTimeout(r, 500));

        const existingPlayerIndex = room.players.findIndex(p =>
          p.name === playerData.name || p.id === playerData.id
        );

        let isReconnecting = false;

        if (existingPlayerIndex !== -1) {
          isReconnecting = true;
          room.players[existingPlayerIndex] = {
            ...room.players[existingPlayerIndex],
            id: playerData.id,
            name: playerData.name,
            reconnected: true,
            ready: room.phase === 'playing',
            isCorrect: false,
            confirmedCorrect: false
          };
        } else {
          room.players.push({
            id: playerData.id,
            name: playerData.name,
            isHost: false,
            joinedAt: new Date(),
            ready: false,
            isCorrect: false,
            confirmedCorrect: false
          });
        }

        const result = {
          roomCode,
          players: room.players,
          config: room.config,
          phase: room.phase,
          currentCategory: room.currentCategory,
          gameState: room.gameState,
          isReconnecting
        };

        resolve(result);

        io.to(roomCode).emit('playersUpdate', {
          players: room.players
        });
      } catch (error) {
        reject(error);
      }
    }
  }
}

const connectionQueue = new ConnectionQueue();

io.on('connection', (socket) => {
  console.log('Cliente conectado:', socket.id);

  socket.on('createRoom', async (config) => {
    try {
      const roomCode = config.roomCode || Math.random().toString(36).substring(2, 8).toUpperCase();

      const roomData = {
        host: socket.id,
        players: [{
          id: socket.id,
          name: 'Game Master',
          isHost: true,
          ready: true,
          isCorrect: false,
          confirmedCorrect: false
        }],
        config,
        currentCategory: null,
        phase: 'waiting',
        createdAt: new Date(),
        gameState: null,
        predictions: new Map(),
        songPlaying: false
      };

      gameRooms.set(roomCode, roomData);
      await socket.join(roomCode);

      socket.emit('roomCreated', {
        roomCode,
        players: roomData.players,
        config
      });

      io.to(roomCode).emit('playersUpdate', {
        players: roomData.players
      });

      console.log(`Sala creada: ${roomCode} por ${socket.id}`);
    } catch (error) {
      console.error('Error al crear sala:', error);
      socket.emit('error', { message: 'Error al crear la sala' });
    }
  });

  socket.on('joinRoom', async ({ roomCode, name, ...playerInfo }) => {
    try {
      const room = gameRooms.get(roomCode);

      if (!room) {
        socket.emit('error', { message: 'Sala no encontrada' });
        return;
      }

      if (room.players.length >= MAX_PLAYERS) {
        socket.emit('error', { message: 'Sala llena' });
        return;
      }

      const result = await connectionQueue.enqueue(roomCode, {
        id: socket.id,
        name,
        ...playerInfo
      });

      await socket.join(roomCode);
      socket.emit('roomJoined', result);
    } catch (error) {
      console.error('Error al unirse a sala:', error);
      socket.emit('error', { message: 'Error al unirse a la sala' });
    }
  });

  socket.on('playerReady', ({ roomCode }) => {
    try {
      const room = gameRooms.get(roomCode);
      if (!room) {
        socket.emit('error', { message: 'Sala no encontrada' });
        return;
      }

      const player = room.players.find(p => p.id === socket.id);
      if (player) {
        player.ready = true;
        io.to(roomCode).emit('playersUpdate', {
          players: room.players
        });
      }
    } catch (error) {
      console.error('Error al marcar jugador como listo:', error);
      socket.emit('error', { message: 'Error al actualizar estado del jugador' });
    }
  });

  socket.on('startGame', ({ roomCode, difficulty }) => {
    try {
      const room = gameRooms.get(roomCode);
      if (!room || room.host !== socket.id) {
        socket.emit('error', { message: 'No autorizado' });
        return;
      }

      const allPlayersReady = room.players.every(player => player.isHost || player.ready);
      if (!allPlayersReady) {
        socket.emit('error', { message: 'No todos los jugadores están listos' });
        return;
      }

      room.phase = 'playing';
      room.config.difficulty = difficulty;
      room.gameState = {
        difficulty,
        startedAt: new Date(),
        currentRound: 0
      };

      io.to(roomCode).emit('gameStarted', {
        difficulty,
        players: room.players,
        gameState: room.gameState
      });
    } catch (error) {
      console.error('Error al iniciar juego:', error);
      socket.emit('error', { message: 'Error al iniciar el juego' });
    }
  });

  socket.on('startSong', ({ roomCode }) => {
    try {
      const room = gameRooms.get(roomCode);
      if (!room || room.host !== socket.id) {
        socket.emit('error', { message: 'No autorizado' });
        return;
      }

      room.songPlaying = true;
      room.predictions.clear();
      room.phase = 'playing';

      // Resetear los estados de acierto al iniciar nueva canción
      room.players.forEach(player => {
        player.isCorrect = false;
        player.confirmedCorrect = false;
      });

      io.to(roomCode).emit('songStarted');
    } catch (error) {
      console.error('Error al iniciar reproducción:', error);
      socket.emit('error', { message: 'Error al iniciar reproducción' });
    }
  });

  socket.on('submitPrediction', ({ roomCode, prediction }) => {
    try {
      const room = gameRooms.get(roomCode);
      if (!room || !room.songPlaying) {
        socket.emit('error', { message: 'No se pueden hacer predicciones ahora' });
        return;
      }

      const player = room.players.find(p => p.id === socket.id);
      if (!player) {
        socket.emit('error', { message: 'Jugador no encontrado' });
        return;
      }

      if (!room.predictions.has(player.name)) {
        room.predictions.set(player.name, []);
      }
      room.predictions.get(player.name).push(prediction);

      socket.to(room.host).emit('playerPrediction', {
        playerName: player.name,
        prediction
      });

      socket.emit('predictionSubmitted');
    } catch (error) {
      console.error('Error al enviar predicción:', error);
      socket.emit('error', { message: 'Error al enviar predicción' });
    }
  });

  socket.on('selectCategory', ({ roomCode, category }) => {
    try {
      const room = gameRooms.get(roomCode);
      if (!room || room.host !== socket.id) {
        socket.emit('error', { message: 'No autorizado' });
        return;
      }

      room.currentCategory = category;
      room.phase = 'category';
      room.songPlaying = false;
      room.predictions.clear();

      // Resetear los estados de acierto al cambiar de categoría
      room.players.forEach(player => {
        player.isCorrect = false;
        player.confirmedCorrect = false;
      });

      io.to(roomCode).emit('categorySelected', { category });
    } catch (error) {
      console.error('Error al seleccionar categoría:', error);
      socket.emit('error', { message: 'Error al seleccionar categoría' });
    }
  });

  socket.on('revealSong', ({ roomCode, songData }) => {
    try {
      const room = gameRooms.get(roomCode);
      if (!room || room.host !== socket.id) {
        socket.emit('error', { message: 'No autorizado' });
        return;
      }

      room.songPlaying = false;
      room.phase = 'reviewing'; // Nueva fase para revisión de aciertos

      const predictionsArray = Array.from(room.predictions.entries()).map(([player, preds]) => ({
        player,
        predictions: preds
      }));

      // Resetear los estados de acierto al revelar
      room.players.forEach(player => {
        player.isCorrect = false;
        player.confirmedCorrect = false;
      });

      io.to(roomCode).emit('songRevealed', {
        ...songData,
        predictions: predictionsArray
      });
    } catch (error) {
      console.error('Error al revelar canción:', error);
      socket.emit('error', { message: 'Error al revelar canción' });
    }
  });

  socket.on('markPlayerCorrect', ({ roomCode, playerId, isCorrect }) => {
    try {
      const room = gameRooms.get(roomCode);
      if (!room || room.host !== socket.id) {
        socket.emit('error', { message: 'No autorizado' });
        return;
      }
  
      if (room.phase !== 'reviewing') {
        socket.emit('error', { message: 'No se puede marcar en este momento' });
        return;
      }
  
      const player = room.players.find(p => p.id === playerId);
      if (!player) {
        socket.emit('error', { message: 'Jugador no encontrado' });
        return;
      }
  
      // Marcar al jugador como correcto (pre-confirmación)
      player.isCorrect = isCorrect;
      console.log(`Jugador ${player.name} (${playerId}) marcado como: ${isCorrect}`);
  
      io.to(roomCode).emit('playerMarked', {
        playerId,
        isCorrect
      });
    } catch (error) {
      console.error('Error al marcar jugador:', error);
      socket.emit('error', { message: 'Error al marcar jugador' });
    }
  });
  
  socket.on('enableMarking', ({ roomCode, eligiblePlayers }) => {
    try {
      const room = gameRooms.get(roomCode);
      if (!room || room.host !== socket.id) {
        socket.emit('error', { message: 'No autorizado' });
        return;
      }
  
      room.phase = 'marking';
      
      // Logs de depuración
      console.log('Habilitando marcado para sala:', roomCode);
      console.log('Jugadores elegibles recibidos:', eligiblePlayers);
      console.log('Jugadores en la sala:', room.players.map(p => ({ id: p.id, name: p.name })));
      
      // Asegurarnos de que eligiblePlayers es un array
      const validEligiblePlayers = Array.isArray(eligiblePlayers) ? eligiblePlayers : [];
      
      // Verificar que los jugadores elegibles existen en la sala
      const validatedPlayers = validEligiblePlayers.filter(id => 
        room.players.some(p => p.id === id)
      );
  
      console.log('Jugadores elegibles validados:', validatedPlayers);
  
      // Marcar los jugadores elegibles en el estado de la sala
      room.players.forEach(player => {
        player.isEligibleToMark = validatedPlayers.includes(player.id);
      });
  
      io.to(roomCode).emit('markingEnabled', { 
        eligiblePlayers: validatedPlayers
      });
    } catch (error) {
      console.error('Error al habilitar marcado:', error);
      socket.emit('error', { message: 'Error al habilitar marcado' });
    }
  });
  
  socket.on('disableMarking', ({ roomCode }) => {
    try {
      const room = gameRooms.get(roomCode);
      if (!room || room.host !== socket.id) {
        socket.emit('error', { message: 'No autorizado' });
        return;
      }
  
      room.phase = 'waiting';
      
      // Limpiar estados de elegibilidad
      room.players.forEach(player => {
        player.isEligibleToMark = false;
      });
  
      // Enviar el resumen final
      const correctPlayers = room.players
        .filter(player => player.isCorrect)
        .map(player => player.id);
  
      io.to(roomCode).emit('markingDisabled', { correctPlayers });
    } catch (error) {
      console.error('Error al deshabilitar marcado:', error);
      socket.emit('error', { message: 'Error al deshabilitar marcado' });
    }
  });

  socket.on('confirmCorrect', ({ roomCode }) => {
    try {
      const room = gameRooms.get(roomCode);
      if (!room) {
        socket.emit('error', { message: 'Sala no encontrada' });
        return;
      }

      const player = room.players.find(p => p.id === socket.id);
      if (!player || !player.isCorrect) {
        socket.emit('error', { message: 'No autorizado para confirmar' });
        return;
      }

      if (room.phase !== 'marking') {
        socket.emit('error', { message: 'No se puede confirmar en este momento' });
        return;
      }

      player.confirmedCorrect = true;

      io.to(roomCode).emit('playerConfirmed', {
        playerId: socket.id,
        confirmed: true
      });
    } catch (error) {
      console.error('Error al confirmar acierto:', error);
      socket.emit('error', { message: 'Error al confirmar acierto' });
    }
  });

  socket.on('winner', ({ roomCode, playerName }) => {
    try {
      const room = gameRooms.get(roomCode);
      if (!room) {
        socket.emit('error', { message: 'Sala no encontrada' });
        return;
      }

      io.to(roomCode).emit('gameWinner', { playerName });
    } catch (error) {
      console.error('Error al anunciar ganador:', error);
      socket.emit('error', { message: 'Error al anunciar ganador' });
    }
  });

  socket.on('disconnect', () => {
    try {
      console.log('Cliente desconectado:', socket.id);

      for (const [roomCode, room] of gameRooms.entries()) {
        if (room.host === socket.id) {
          io.to(roomCode).emit('hostDisconnected');
          gameRooms.delete(roomCode);
          console.log(`Sala ${roomCode} eliminada`);
        } else {
          const playerIndex = room.players.findIndex(p => p.id === socket.id);
          if (playerIndex !== -1) {
            room.players.splice(playerIndex, 1);
            io.to(roomCode).emit('playersUpdate', {
              players: room.players
            });
            console.log(`Jugador eliminado de sala ${roomCode}`);
          }
        }
      }
    } catch (error) {
      console.error('Error en desconexión:', error);
    }
  });
});

setInterval(() => {
  const now = new Date();
  for (const [roomCode, room] of gameRooms.entries()) {
    const inactiveTime = now - room.createdAt;
    if (inactiveTime > 3600000) { // 1 hora
      gameRooms.delete(roomCode);
      console.log(`Sala ${roomCode} eliminada por inactividad`);
    }
  }
}, 300000); // Revisar cada 5 minutos

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor escuchando en puerto ${PORT}`);
});