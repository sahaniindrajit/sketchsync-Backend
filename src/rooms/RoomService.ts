import { EventEmitter } from 'node:events';
import { formatZodError, opSchema, PATCHABLE_FIELDS, shapeSchema } from '../protocol/schemas.js';
import { applyChanges, applyOp, shapeBytes } from '../shared/ops.js';
import { LIMITS, OP_ID_RE, parseOpId, type ErrorCode, type Op, type OpBroadcast, type Origin, type Shape } from '../shared/protocol.js';
import type { Room, RoomStore } from './RoomStore.js';

export interface RoomServiceOptions {
    maxRooms: number;
    idleTtlMs: number;
    /** Memory budget across all rooms. */
    maxTotalBytes: number;
    /** How many clients' op counters each room remembers. */
    clientsPerRoom?: number;
    now?: () => number;
}

export interface ApplyOptions {
    origin: Origin;
    opId: string;
    /** Enforce "<clientId>:<n>" ordering/de-duplication for this client (socket ops). */
    sequenced?: boolean;
    batchId?: string;
}

export type ApplyResult = { ok: true; seq: number; op: Op; duplicate: boolean } | { ok: false; error: string; code: ErrorCode };

export type RoomOpEvent = OpBroadcast;

export type BatchResult = { ok: true; seq: number; ops: Op[] } | { ok: false; error: string; code: ErrorCode; index: number };

interface RoomServiceEvents {
    op: [RoomOpEvent];
}

export class RoomError extends Error {
    constructor(
        message: string,
        readonly code: ErrorCode = 'invalid',
    ) {
        super(message);
    }
}

/**
 * The only way board state changes. Socket handlers and MCP tools both call
 * `apply`, which validates, applies, bumps `seq` and emits an `op` event.
 */
export class RoomService extends EventEmitter<RoomServiceEvents> {
    private readonly now: () => number;
    private totalBytes = 0;

    constructor(
        private readonly store: RoomStore,
        private readonly options: RoomServiceOptions,
    ) {
        super();
        this.now = options.now ?? Date.now;
    }

    getRoom(roomId: string): Room | undefined {
        const room = this.store.get(roomId);
        if (room) room.lastActiveAt = this.now();
        return room;
    }

    /** Joins (or creates) a room. `fresh` means this call created it. */
    join(roomId: string): { room: Room; fresh: boolean } {
        const existing = this.getRoom(roomId);
        if (existing) {
            existing.connections++;
            return { room: existing, fresh: false };
        }
        this.makeSpace();
        const room: Room = {
            id: roomId,
            shapes: new Map(),
            seq: 0,
            bytes: 0,
            lastActiveAt: this.now(),
            connections: 1,
            clients: new Map(),
            retired: new Set(),
        };
        this.store.set(room);
        return { room, fresh: true };
    }

    leave(roomId: string) {
        const room = this.store.get(roomId);
        if (!room) return;
        room.connections = Math.max(0, room.connections - 1);
        room.lastActiveAt = this.now();
    }

    apply(roomId: string, rawOp: unknown, options: ApplyOptions): ApplyResult {
        const room = this.getRoom(roomId);
        if (!room) return { ok: false, error: 'Room not found', code: 'not_found' };
        if (!OP_ID_RE.test(options.opId)) return { ok: false, error: 'Invalid op id', code: 'invalid' };

        // Strict per-client ordering: n <= last was already processed; n > last + 1 means an earlier op is missing.
        let sequence: { clientId: string; n: number } | null = null;
        if (options.sequenced) {
            sequence = parseOpId(options.opId);
            if (!sequence) return { ok: false, error: 'Invalid op id', code: 'invalid' };
            if (room.retired.has(sequence.clientId)) return { ok: false, error: 'This client id was retired; re-join the room', code: 'forbidden' };
            const last = room.clients.get(sequence.clientId) ?? 0;
            if (sequence.n <= last) return { ok: true, seq: room.seq, op: rawOp as Op, duplicate: true };
            if (sequence.n > last + 1) return { ok: false, error: `Out of order: expected op ${last + 1}`, code: 'out_of_order' };
        }
        const consume = () => {
            if (!sequence) return;
            room.clients.delete(sequence.clientId);
            room.clients.set(sequence.clientId, sequence.n);
            const keep = this.options.clientsPerRoom ?? 5000;
            if (room.clients.size > keep) room.clients.delete(room.clients.keys().next().value!);
        };

        const parsed = opSchema.safeParse(rawOp);
        if (!parsed.success) {
            consume();
            return { ok: false, error: `Invalid op: ${formatZodError(parsed.error, rawOp)}`, code: 'invalid' };
        }

        let op: Op;
        try {
            op = this.normalize(room, parsed.data, options.origin);
        } catch (err) {
            if (!(err instanceof RoomError)) throw err;
            if (err.code !== 'unavailable') consume();
            return { ok: false, error: err.message, code: err.code };
        }

        const next = applyOp(room.shapes, op);
        const bytes = nextBytes(room, next, op);
        if (bytes > room.bytes) {
            if (bytes > LIMITS.maxRoomBytes) {
                consume();
                return { ok: false, error: 'Board is too large (10 MB limit)', code: 'limit' };
            }
            if (this.totalBytes + (bytes - room.bytes) > this.options.maxTotalBytes) {
                return { ok: false, error: 'Server storage is full, try again later', code: 'unavailable' };
            }
        }
        consume();
        this.totalBytes += bytes - room.bytes;
        room.shapes = next;
        room.bytes = bytes;
        room.seq++;

        this.emit('op', { roomId, op, opId: options.opId, seq: room.seq, origin: options.origin, batchId: options.batchId });
        return { ok: true, seq: room.seq, op, duplicate: false };
    }

    /**
     * Validates and applies several ops all-or-nothing (used by MCP tools, whose
     * edits may be split into chunks). Nothing changes if any op is refused.
     */
    applyBatch(roomId: string, rawOps: unknown[], options: { origin: Origin; batchId?: string; opIdPrefix?: string }): BatchResult {
        const room = this.getRoom(roomId);
        if (!room) return { ok: false, error: 'Room not found', code: 'not_found', index: 0 };
        let staged: Room = { ...room };
        const prepared: Op[] = [];
        for (const [index, raw] of rawOps.entries()) {
            const parsed = opSchema.safeParse(raw);
            if (!parsed.success) return { ok: false, error: formatZodError(parsed.error, raw), code: 'invalid', index };
            let op: Op;
            try {
                op = this.normalize(staged, parsed.data, options.origin);
            } catch (err) {
                if (!(err instanceof RoomError)) throw err;
                return { ok: false, error: err.message, code: err.code, index };
            }
            const next = applyOp(staged.shapes, op);
            const bytes = nextBytes(staged, next, op);
            if (bytes > staged.bytes) {
                if (bytes > LIMITS.maxRoomBytes) return { ok: false, error: 'Board is too large (10 MB limit)', code: 'limit', index };
                if (this.totalBytes + (bytes - room.bytes) > this.options.maxTotalBytes) {
                    return { ok: false, error: 'Server storage is full, try again later', code: 'unavailable', index };
                }
            }
            staged = { ...staged, shapes: next, bytes };
            prepared.push(op);
        }
        this.totalBytes += staged.bytes - room.bytes;
        room.shapes = staged.shapes;
        room.bytes = staged.bytes;
        const prefix = options.opIdPrefix ?? 'batch';
        prepared.forEach((op, i) => {
            room.seq++;
            this.emit('op', { roomId, op, opId: `${prefix}-${i}`, seq: room.seq, origin: options.origin, batchId: options.batchId });
        });
        return { ok: true, seq: room.seq, ops: prepared };
    }

    /** Stops accepting ops from these client ids. */
    retireClients(roomId: string, clientIds: Iterable<string>) {
        const room = this.store.get(roomId);
        if (!room) return;
        for (const id of clientIds) {
            room.retired.delete(id);
            room.retired.add(id);
        }
        while (room.retired.size > 10_000) room.retired.delete(room.retired.values().next().value!);
    }

    /** Which of these "<clientId>:<n>" op ids the room has already processed. */
    appliedOpIds(roomId: string, opIds: unknown): string[] {
        const room = this.store.get(roomId);
        if (!room || !Array.isArray(opIds)) return [];
        return opIds.slice(0, 20_000).filter((id): id is string => {
            if (typeof id !== 'string') return false;
            const parsed = parseOpId(id);
            return !!parsed && parsed.n <= (room.clients.get(parsed.clientId) ?? 0);
        });
    }

    /** Evicts idle rooms. Returns the number removed. */
    sweep(): number {
        const cutoff = this.now() - this.options.idleTtlMs;
        let removed = 0;
        for (const room of Array.from(this.store.values())) {
            if (room.connections === 0 && room.lastActiveAt < cutoff) {
                this.deleteRoom(room);
                removed++;
            }
        }
        return removed;
    }

    roomCount() {
        return this.store.size();
    }

    usedBytes() {
        return this.totalBytes;
    }

    private deleteRoom(room: Room) {
        this.totalBytes -= room.bytes;
        this.store.delete(room.id);
    }

    private makeSpace() {
        if (this.store.size() < this.options.maxRooms) return;
        let victim: Room | undefined;
        for (const room of this.store.values()) {
            if (room.connections > 0) continue;
            if (!victim || room.lastActiveAt < victim.lastActiveAt) victim = room;
        }
        if (!victim) throw new RoomError('Server is at capacity, try again later', 'unavailable');
        this.deleteRoom(victim);
    }

    /** Semantic validation + server-owned fields. Throws RoomError. */
    private normalize(room: Room, op: Op, origin: Origin): Op {
        const now = this.now();
        switch (op.kind) {
            case 'add': {
                const ids = new Set<string>();
                for (const s of op.shapes) {
                    if (ids.has(s.id)) throw new RoomError(`Duplicate shape id "${s.id}"`, 'invalid');
                    ids.add(s.id);
                }
                const newCount = Array.from(ids).filter((id) => !room.shapes.has(id)).length;
                if (room.shapes.size + newCount > LIMITS.maxShapesPerRoom) {
                    throw new RoomError(`Board is full (max ${LIMITS.maxShapesPerRoom} shapes)`, 'limit');
                }
                return { kind: 'add', shapes: op.shapes.map((s) => ({ ...s, updatedAt: now, createdBy: origin })) };
            }
            case 'update': {
                const patches = [];
                for (const patch of op.patches) {
                    const current = room.shapes.get(patch.id);
                    // The shape may have been deleted concurrently; ignore quietly.
                    if (!current) continue;
                    const allowed = PATCHABLE_FIELDS[current.type];
                    const invalid = Object.keys(patch.changes).filter((k) => !allowed.has(k));
                    if (invalid.length) {
                        throw new RoomError(`Fields not supported on ${current.type} "${patch.id}": ${invalid.join(', ')}`);
                    }
                    const changes = { ...patch.changes, updatedAt: now };
                    delete changes.createdBy;
                    const result = shapeSchema.safeParse(applyChanges(current, changes));
                    if (!result.success) throw new RoomError(`Invalid update for "${patch.id}": ${formatZodError(result.error)}`, 'invalid');
                    patches.push({ id: patch.id, changes });
                }
                return { kind: 'update', patches };
            }
            case 'append-points': {
                const current = room.shapes.get(op.id);
                if (!current) return op;
                if (!('points' in current)) throw new RoomError(`Shape "${op.id}" has no points`);
                if (current.points.length + op.points.length > LIMITS.maxPointsPerShape) {
                    throw new RoomError('Stroke is too long', 'limit');
                }
                return op;
            }
            case 'delete':
            case 'clear':
                return op;
        }
    }
}

/** Room byte size after applying `op` (only touched shapes are re-measured). */
function nextBytes(room: Room, next: Map<string, Shape>, op: Op): number {
    switch (op.kind) {
        case 'clear':
            return 0;
        case 'append-points':
            return room.shapes.has(op.id) ? room.bytes + op.points.length * 8 : room.bytes;
        default: {
            let bytes = room.bytes;
            const ids = op.kind === 'add' ? op.shapes.map((s) => s.id) : op.kind === 'update' ? op.patches.map((p) => p.id) : op.ids;
            for (const id of new Set(ids)) {
                const old = room.shapes.get(id);
                const updated = next.get(id);
                if (old) bytes -= shapeBytes(old);
                if (updated) bytes += shapeBytes(updated);
            }
            return Math.max(0, bytes);
        }
    }
}
