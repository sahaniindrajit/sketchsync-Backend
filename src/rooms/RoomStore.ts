import type { Shape } from '../shared/protocol.js';

export interface Room {
    id: string;
    shapes: Map<string, Shape>;
    seq: number;
    bytes: number;
    lastActiveAt: number;
    /** Live socket connections currently joined. */
    connections: number;
    /** Per client: highest op number processed (ops are processed strictly in order). Insertion ordered by last use. */
    clients: Map<string, number>;
    /** Client ids that may no longer send ops (their owner re-issued its pending ops under a new id). */
    retired: Set<string>;
}

/** Storage for rooms. In-memory today; a Redis/DB store can implement the same interface. */
export interface RoomStore {
    get(roomId: string): Room | undefined;
    set(room: Room): void;
    delete(roomId: string): void;
    size(): number;
    values(): IterableIterator<Room>;
}

export class InMemoryRoomStore implements RoomStore {
    private rooms = new Map<string, Room>();

    get(roomId: string) {
        return this.rooms.get(roomId);
    }

    set(room: Room) {
        this.rooms.set(room.id, room);
    }

    delete(roomId: string) {
        this.rooms.delete(roomId);
    }

    size() {
        return this.rooms.size;
    }

    values() {
        return this.rooms.values();
    }
}
