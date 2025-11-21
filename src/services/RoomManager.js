import { SECURITY_CONFIG } from '../config/constants.js';
import { sanitizeString } from '../utils/helpers.js';

class RoomManager {
    constructor() {
        // Aquí vive el estado del juego (Memoria RAM por ahora)
        this.rooms = new Map();
        this.orphanedRooms = new Map();
    }

    /**
     * Busca una sala activa.
     */
    getRoom(roomCode) {
        return this.rooms.get(roomCode);
    }

    /**
     * Crea una nueva sala y la guarda en memoria.
     */
    createRoom(hostId, config) {
        // Generar código si no viene uno
        let roomCode = config.roomCode
            ? sanitizeString(config.roomCode, SECURITY_CONFIG.MAX_ROOM_CODE_LENGTH).toUpperCase()
            : Math.random().toString(36).substring(2, 7).toUpperCase();

        // Evitar colisiones (simple check)
        if (this.rooms.has(roomCode) || this.orphanedRooms.has(roomCode)) {
            throw new Error('Código de sala ya existe o está reservado');
        }

        const hostPlayer = { id: hostId, name: 'Game Master', isHost: true, ready: true };

        const newRoom = {
            roomCode, // Guardamos el código dentro del objeto también por comodidad
            hostId,
            players: [hostPlayer],
            config: config,
            phase: 'waiting',
            currentCard: null,
            currentCategory: null,
            currentTheme: null,
            isMarkingEnabled: false,
            songPlaying: false,
            winners: [],
            gameOver: false,
            createdAt: new Date(),
        };

        this.rooms.set(roomCode, newRoom);
        return newRoom;
    }

    /**
     * Mueve una sala activa a "huérfanas" cuando el host se va.
     */
    orphanRoom(roomCode) {
        const room = this.rooms.get(roomCode);
        if (!room) return;

        this.orphanedRooms.set(roomCode, {
            ...room,
            orphanedAt: new Date()
        });
        this.rooms.delete(roomCode);
    }

    /**
     * Intenta recuperar una sala huérfana si el host vuelve.
     */
    restoreRoom(roomCode, newHostId) {
        const orphanedRoom = this.orphanedRooms.get(roomCode);
        if (!orphanedRoom) return null;

        // Restaurar a activa
        const room = { ...orphanedRoom };
        delete room.orphanedAt;
        room.hostId = newHostId;

        this.rooms.set(roomCode, room);
        this.orphanedRooms.delete(roomCode);

        return room;
    }

    /**
     * Elimina una sala definitivamente.
     */
    deleteRoom(roomCode) {
        this.rooms.delete(roomCode);
        this.orphanedRooms.delete(roomCode);
    }

    /**
     * Métodos de limpieza (para el setInterval)
     */
    cleanupStaleRooms() {
        const now = new Date();
        let cleaned = 0;

        // Limpiar activas viejas
        for (const [code, room] of this.rooms.entries()) {
            if (now - room.createdAt > SECURITY_CONFIG.MAX_ROOM_LIFETIME) {
                this.rooms.delete(code);
                cleaned++;
            }
        }

        // Limpiar huérfanas expiradas
        for (const [code, room] of this.orphanedRooms.entries()) {
            if (now - room.orphanedAt > SECURITY_CONFIG.ORPHAN_TIMEOUT) {
                this.orphanedRooms.delete(code);
                cleaned++;
            }
        }
        return cleaned;
    }

    getStats() {
        return {
            active: this.rooms.size,
            orphaned: this.orphanedRooms.size
        };
    }
}

// Exportamos una única instancia (Singleton)
export const roomManager = new RoomManager();