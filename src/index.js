import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import dotenv from 'dotenv';
import axios from 'axios';

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

// Clase para manejar los tokens de Spotify
class SpotifyTokenManager {
  constructor() {
    this.tokens = new Map(); // Almacena los tokens por sala: roomCode -> tokenData
  }

  setToken(roomCode, tokenData) {
    this.tokens.set(roomCode, {
      ...tokenData,
      expiresAt: Date.now() + (tokenData.expires_in * 1000)
    });
  }

  async refreshToken(roomCode) {
    const tokenData = this.tokens.get(roomCode);
    if (!tokenData || !tokenData.refresh_token) {
      throw new Error('No refresh token available');
    }

    try {
      const response = await axios.post('https://accounts.spotify.com/api/token',
        new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: tokenData.refresh_token
        }), {
        headers: {
          'Authorization': `Basic ${Buffer.from(
            `${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`
          ).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      });

      const newTokenData = {
        ...response.data,
        refresh_token: tokenData.refresh_token, // Mantener el refresh_token anterior si no viene uno nuevo
        expiresAt: Date.now() + (response.data.expires_in * 1000)
      };

      this.tokens.set(roomCode, newTokenData);
      return newTokenData;
    } catch (error) {
      console.error('Error refreshing Spotify token:', error);
      throw error;
    }
  }

  async getValidToken(roomCode) {
    const tokenData = this.tokens.get(roomCode);
    if (!tokenData) {
      throw new Error('No token data available');
    }

    // Si el token expira en menos de 5 minutos, refrescarlo
    if (tokenData.expiresAt - Date.now() < 300000) {
      return this.refreshToken(roomCode);
    }

    return tokenData;
  }

  removeToken(roomCode) {
    this.tokens.delete(roomCode);
  }
}

const spotifyTokenManager = new SpotifyTokenManager();
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
        await new Promise(r => setTimeout(r, 500)); // Add slight delay between connections

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
            ready: room.phase === 'playing'
          };
        } else {
          room.players.push({
            id: playerData.id,
            name: playerData.name,
            isHost: false,
            joinedAt: new Date(),
            ready: false
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

      // Guardar el token inicial de Spotify si está presente
      if (config.spotifyToken) {
        spotifyTokenManager.setToken(roomCode, config.spotifyToken);
      }

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

  socket.on('requestSpotifyToken', async ({ roomCode }) => {
    try {
      const room = gameRooms.get(roomCode);
      if (!room) {
        socket.emit('error', { message: 'Sala no encontrada' });
        return;
      }

      const tokenData = await spotifyTokenManager.getValidToken(roomCode);
      socket.emit('spotifyTokenUpdated', {
        access_token: tokenData.access_token,
        expires_in: Math.floor((tokenData.expiresAt - Date.now()) / 1000)
      });
    } catch (error) {
      console.error('Error al obtener token de Spotify:', error);
      socket.emit('error', { message: 'Error al actualizar token de Spotify' });
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

  socket.on('startSong', async ({ roomCode }) => {
    try {
      const room = gameRooms.get(roomCode);
      if (!room || room.host !== socket.id) {
        socket.emit('error', { message: 'No autorizado' });
        return;
      }

      // Verificar y refrescar token de Spotify antes de iniciar la canción
      try {
        const tokenData = await spotifyTokenManager.getValidToken(roomCode);
        socket.emit('spotifyTokenUpdated', {
          access_token: tokenData.access_token,
          expires_in: Math.floor((tokenData.expiresAt - Date.now()) / 1000)
        });
      } catch (error) {
        console.error('Error al actualizar token de Spotify:', error);
        socket.emit('error', { message: 'Error al actualizar token de Spotify' });
        return;
      }

      room.songPlaying = true;
      room.predictions.clear();

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

      const predictionsArray = Array.from(room.predictions.entries()).map(([player, preds]) => ({
        player,
        predictions: preds
      }));

      io.to(roomCode).emit('songRevealed', {
        ...songData,
        predictions: predictionsArray
      });
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
          spotifyTokenManager.removeToken(roomCode); // Limpiar token al cerrar la sala
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

// Limpiar salas inactivas
setInterval(() => {
  const now = new Date();
  for (const [roomCode, room] of gameRooms.entries()) {
    const inactiveTime = now - room.createdAt;
    if (inactiveTime > 3600000) { // 1 hora de inactividad
      gameRooms.delete(roomCode);
      spotifyTokenManager.removeToken(roomCode); // Limpiar token de salas inactivas
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