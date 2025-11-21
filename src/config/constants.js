import dotenv from 'dotenv';
dotenv.config();

export const SECURITY_CONFIG = {
  MAX_ROOMS: 50,
  MAX_PLAYERS_PER_ROOM: 50,
  MAX_ROOM_LIFETIME: 3600000,
  ORPHAN_TIMEOUT: 30000,
  MAX_NAME_LENGTH: 30,
  MAX_ROOM_CODE_LENGTH: 10,
  CONNECTION_COOLDOWN: 1000,
  MAX_EVENTS_PER_MINUTE: 60,
  CLEANUP_INTERVAL: 300000,
};

export const ALLOWED_ORIGINS = [
  'https://www.discohitsbingo.com',
  'https://music-bingo-swart.vercel.app',
  'http://localhost:5173',
  process.env.FRONTEND_URL
].filter(Boolean);