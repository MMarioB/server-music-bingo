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
          ready: true
        }],
        config,
        currentCategory: null,
        phase: 'waiting',
        createdAt: new Date(),
        gameState: null
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
      console.log(`Intento de unirse a sala ${roomCode} por ${socket.id}`, { name, playerInfo });

      const room = gameRooms.get(roomCode);

      if (!room) {
        socket.emit('error', { message: 'Sala no encontrada' });
        return;
      }

      const existingPlayerIndex = room.players.findIndex(p =>
        p.name === name || p.id === socket.id
      );

      let isReconnecting = false;

      if (existingPlayerIndex !== -1) {
        isReconnecting = true;
        room.players[existingPlayerIndex] = {
          ...room.players[existingPlayerIndex],
          id: socket.id,
          name,
          ...playerInfo,
          reconnected: true,
          ready: room.phase === 'playing'
        };
      } else {
        room.players.push({
          id: socket.id,
          name,
          isHost: false,
          joinedAt: new Date(),
          ready: false,
          ...playerInfo
        });
      }

      await socket.join(roomCode);

      socket.emit('roomJoined', {
        roomCode,
        players: room.players,
        config: room.config,
        phase: room.phase,
        currentCategory: room.currentCategory,
        gameState: room.gameState,
        isReconnecting
      });

      io.to(roomCode).emit('playersUpdate', {
        players: room.players
      });

      console.log(`Jugador ${name} ${isReconnecting ? 'reconectado' : 'unido'} a sala ${roomCode}`);
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

      // Verificar que todos los jugadores estén ready
      const allPlayersReady = room.players.every(player => player.isHost || player.ready);
      if (!allPlayersReady) {
        socket.emit('error', { message: 'No todos los jugadores están listos' });
        return;
      }

      // Iniciar el juego inmediatamente sin esperar confirmaciones adicionales
      room.phase = 'playing';
      room.config.difficulty = difficulty;
      room.gameState = {
        difficulty,
        startedAt: new Date(),
        currentRound: 0
      };

      // Emitir el evento de inicio a todos
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

  socket.on('selectCategory', ({ roomCode, category }) => {
    try {
      const room = gameRooms.get(roomCode);
      if (!room || room.host !== socket.id) {
        socket.emit('error', { message: 'No autorizado' });
        return;
      }

      room.currentCategory = category;
      room.phase = 'category';

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

      io.to(roomCode).emit('songRevealed', songData);
    } catch (error) {
      console.error('Error al revelar canción:', error);
      socket.emit('error', { message: 'Error al revelar canción' });
    }
  });

  socket.on('enableMarking', ({ roomCode }) => {
    try {
      const room = gameRooms.get(roomCode);
      if (!room || room.host !== socket.id) {
        socket.emit('error', { message: 'No autorizado' });
        return;
      }

      room.phase = 'marking';
      io.to(roomCode).emit('markingEnabled');
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
      io.to(roomCode).emit('markingDisabled');
    } catch (error) {
      console.error('Error al deshabilitar marcado:', error);
      socket.emit('error', { message: 'Error al deshabilitar marcado' });
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

// Limpieza periódica de salas inactivas
setInterval(() => {
  const now = new Date();
  for (const [roomCode, room] of gameRooms.entries()) {
    const inactiveTime = now - room.createdAt;
    if (inactiveTime > 3600000) { // 1 hora
      gameRooms.delete(roomCode);
      console.log(`Sala ${roomCode} eliminada por inactividad`);
    }
  }
}, 300000); // Cada 5 minutos

// Ruta de health check para Railway
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor escuchando en puerto ${PORT}`);
});