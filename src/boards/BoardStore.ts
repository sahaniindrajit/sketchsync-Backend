import type { Room } from '../rooms/RoomStore.js';
import type { RoomService } from '../rooms/RoomService.js';
import { sortByZ } from '../shared/ops.js';
import type { BoardRepo } from './BoardRepo.js';

/**
 * Keeps boards in Postgres. Rooms stay in memory while in use (all edits go through RoomService
 * as before); changed rooms are written back every few seconds, and loaded again on demand.
 */
export class BoardStore {
    private readonly dirty = new Map<string, Room>();
    private timer: ReturnType<typeof setInterval> | null = null;
    private flushing: Promise<void> | null = null;
    private readonly loading = new Map<string, Promise<Room | null>>();

    constructor(
        private readonly rooms: RoomService,
        private readonly repo: BoardRepo,
        private readonly intervalMs: number,
    ) {
        rooms.on('op', (event) => {
            const room = rooms.getRoom(event.roomId);
            if (room) this.dirty.set(room.id, room);
        });
    }

    start() {
        this.timer = setInterval(() => void this.flush(), this.intervalMs);
        this.timer.unref();
    }

    /** Writes every changed board. Safe to call concurrently. */
    flush(): Promise<void> {
        if (this.flushing) return this.flushing.then(() => (this.dirty.size ? this.flush() : undefined));
        if (!this.dirty.size) return Promise.resolve();
        this.flushing = (async () => {
            const batch = Array.from(this.dirty.values());
            this.dirty.clear();
            for (const room of batch) {
                try {
                    await this.repo.saveSnapshot(room.id, sortByZ(room.shapes.values()), room.seq);
                } catch (err) {
                    console.error(`Saving board ${room.id} failed`, err);
                    if (!this.dirty.has(room.id)) this.dirty.set(room.id, room);
                }
            }
        })().finally(() => {
            this.flushing = null;
        });
        return this.flushing;
    }

    /**
     * The board's room, loaded from the database if needed. Null when nothing was ever saved
     * for it (the first person to open it starts it, or their browser uploads its cached copy).
     */
    async load(roomId: string): Promise<Room | null> {
        const live = this.rooms.getRoom(roomId);
        if (live) return live;
        const inFlight = this.loading.get(roomId);
        if (inFlight) return inFlight;
        const promise = (async () => {
            // An evicted room may still have unsaved changes.
            if (this.dirty.has(roomId)) await this.flush();
            const snapshot = await this.repo.loadSnapshot(roomId);
            if (!snapshot) return this.rooms.getRoom(roomId) ?? null;
            return this.rooms.hydrate(roomId, snapshot.shapes, snapshot.seq);
        })().finally(() => this.loading.delete(roomId));
        this.loading.set(roomId, promise);
        return promise;
    }

    /** Forgets a deleted board. */
    drop(roomId: string) {
        this.dirty.delete(roomId);
        this.rooms.remove(roomId);
    }

    async stop() {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
        await this.flush();
    }
}
