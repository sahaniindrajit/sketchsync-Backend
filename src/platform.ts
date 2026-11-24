import { AuthService } from './auth/AuthService.js';
import { BoardRepo } from './boards/BoardRepo.js';
import { BoardStore } from './boards/BoardStore.js';
import type { Config } from './config.js';
import type { Db } from './db/db.js';
import type { RoomService } from './rooms/RoomService.js';

/** Accounts, saved boards and sharing. Only present when the server has a database. */
export interface Platform {
    db: Db;
    auth: AuthService;
    boards: BoardRepo;
    store: BoardStore;
    /** Set by the realtime layer: tells open boards about access and title changes. */
    live: LiveRooms;
}

export interface LiveRooms {
    /** Re-checks everyone's role on an open board (after sharing changes); people who lost access are removed. */
    refreshAccess(roomId: string): Promise<void>;
    /** Sends a new board title to everyone on it. */
    broadcastTitle(roomId: string, title: string, titleAt: number): void;
    /** Removes everyone from a board (it was deleted). */
    close(roomId: string): Promise<void>;
}

export function createPlatform(db: Db, rooms: RoomService, config: Config): Platform {
    const boards = new BoardRepo(db);
    const noop: LiveRooms = { refreshAccess: async () => {}, broadcastTitle: () => {}, close: async () => {} };
    return {
        db,
        auth: new AuthService(db, config.sessionTtlMs),
        boards,
        store: new BoardStore(rooms, boards, config.snapshotIntervalMs),
        live: noop,
    };
}
