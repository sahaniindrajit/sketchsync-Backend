import type { Server, Socket } from 'socket.io';
import { RoomError, type RoomService } from '../rooms/RoomService.js';
import { sortByZ } from '../shared/ops.js';
import { CLIENT_ID_RE, EVENTS, isValidRoomId, parseOpId, PROTOCOL_VERSION, type JoinAck, type OpAck, type OpBroadcast } from '../shared/protocol.js';

export interface RealtimeOptions {
    opsPerSecond: number;
    joinsPerMinute: number;
    maxConnectionsPerIp: number;
}

type Ack<T> = ((response: T) => void) | undefined;

function safeAck<T>(ack: unknown): (response: T) => void {
    return typeof ack === 'function' ? (ack as (r: T) => void) : () => {};
}

/** Token bucket. */
function bucket(ratePerSecond: number, burst: number) {
    let tokens = burst;
    let last = Date.now();
    return () => {
        const now = Date.now();
        tokens = Math.min(burst, tokens + ((now - last) / 1000) * ratePerSecond);
        last = now;
        if (tokens < 1) return false;
        tokens -= 1;
        return true;
    };
}

/** Client IP as seen by the first trusted proxy (the last X-Forwarded-For hop), like Express' `trust proxy 1`. */
function clientIp(socket: Socket): string {
    const forwarded = socket.handshake.headers['x-forwarded-for'];
    const hops = (Array.isArray(forwarded) ? forwarded.join(',') : forwarded ?? '')
        .split(',')
        .map((h) => h.trim())
        .filter(Boolean);
    return hops[hops.length - 1] || socket.handshake.address || 'unknown';
}

export function attachRealtime(io: Server, rooms: RoomService, opts: RealtimeOptions) {
    rooms.on('op', (event) => {
        const payload: OpBroadcast = {
            roomId: event.roomId,
            op: event.op,
            opId: event.opId,
            seq: event.seq,
            origin: event.origin,
            batchId: event.batchId,
        };
        // Everyone gets the op, including the sender: it confirms the op's position in the room's order.
        io.to(event.roomId).emit(EVENTS.op, payload);
    });

    const connectionsByIp = new Map<string, number>();
    /** roomId → clientId → socket id, so a client id can't be used by two live connections. */
    const owners = new Map<string, Map<string, string>>();
    io.use((socket, next) => {
        const ip = clientIp(socket);
        const count = connectionsByIp.get(ip) ?? 0;
        if (count >= opts.maxConnectionsPerIp) return next(new Error('Too many connections'));
        connectionsByIp.set(ip, count + 1);
        socket.once('disconnect', () => {
            const n = (connectionsByIp.get(ip) ?? 1) - 1;
            if (n <= 0) connectionsByIp.delete(ip);
            else connectionsByIp.set(ip, n);
        });
        next();
    });

    io.on('connection', (socket: Socket) => {
        // One board per connection.
        let currentRoom: string | null = null;
        let clientId: string | null = null;
        const allowOp = bucket(opts.opsPerSecond, opts.opsPerSecond * 2);
        const allowJoin = bucket(opts.joinsPerMinute / 60, Math.max(3, Math.ceil(opts.joinsPerMinute / 6)));

        const leaveCurrent = () => {
            if (!currentRoom) return;
            const roomOwners = owners.get(currentRoom);
            if (clientId && roomOwners?.get(clientId) === socket.id) {
                roomOwners.delete(clientId);
                if (roomOwners.size === 0) owners.delete(currentRoom);
            }
            rooms.leave(currentRoom);
            socket.leave(currentRoom);
            currentRoom = null;
        };

        socket.on(EVENTS.join, (payload: unknown, rawAck: Ack<JoinAck>) => {
            const ack = safeAck<JoinAck>(rawAck);
            const p = (payload ?? {}) as { roomId?: unknown; clientId?: unknown; protocolVersion?: unknown; pendingOpIds?: unknown; retireClientIds?: unknown };
            if (!isValidRoomId(p.roomId)) return ack({ ok: false, error: 'Invalid room id', code: 'invalid' });
            if (p.protocolVersion !== PROTOCOL_VERSION) {
                return ack({ ok: false, error: `Protocol mismatch (server ${PROTOCOL_VERSION}). Please reload the page.`, code: 'protocol' });
            }
            if (typeof p.clientId !== 'string' || !CLIENT_ID_RE.test(p.clientId)) {
                return ack({ ok: false, error: 'Invalid client id', code: 'invalid' });
            }
            const roomId = (p.roomId as string).toLowerCase();
            const joinClientId = p.clientId;
            try {
                if (currentRoom === roomId && clientId === joinClientId) {
                    // Re-sync on the same connection.
                    const room = rooms.getRoom(roomId);
                    if (room) {
                        return ack({ ok: true, shapes: sortByZ(room.shapes.values()), seq: room.seq, fresh: false, appliedOpIds: rooms.appliedOpIds(roomId, p.pendingOpIds) });
                    }
                }
                const owner = owners.get(roomId)?.get(joinClientId);
                if (owner && owner !== socket.id) return ack({ ok: false, error: 'Client id already in use', code: 'forbidden' });
                if (!allowJoin()) return ack({ ok: false, error: 'Too many joins, slow down', code: 'rate_limited' });
                leaveCurrent();
                const { room, fresh } = rooms.join(roomId);
                // Retiring also applies to ids still held by a connection the server hasn't noticed is dead.
                // (A live client whose id gets retired simply re-joins with a new id.)
                const retire = (Array.isArray(p.retireClientIds) ? p.retireClientIds : [])
                    .slice(0, 1000)
                    .filter((id): id is string => typeof id === 'string' && CLIENT_ID_RE.test(id) && id !== joinClientId);
                rooms.retireClients(roomId, retire);
                currentRoom = roomId;
                clientId = joinClientId;
                if (!owners.has(roomId)) owners.set(roomId, new Map());
                owners.get(roomId)!.set(joinClientId, socket.id);
                socket.join(roomId);
                ack({ ok: true, shapes: sortByZ(room.shapes.values()), seq: room.seq, fresh, appliedOpIds: rooms.appliedOpIds(roomId, p.pendingOpIds) });
            } catch (err) {
                if (err instanceof RoomError) return ack({ ok: false, error: err.message, code: err.code });
                ack({ ok: false, error: 'Could not join room', code: 'unavailable' });
            }
        });

        socket.on(EVENTS.op, (payload: unknown, rawAck: Ack<OpAck>) => {
            const ack = safeAck<OpAck>(rawAck);
            const p = (payload ?? {}) as { roomId?: unknown; opId?: unknown; op?: unknown };
            const roomId = typeof p.roomId === 'string' ? p.roomId.toLowerCase() : '';
            if (!currentRoom || roomId !== currentRoom || !clientId) return ack({ ok: false, error: 'Join the room first', code: 'not_joined' });
            if (typeof p.opId !== 'string' || parseOpId(p.opId)?.clientId !== clientId) {
                return ack({ ok: false, error: 'Op ids must be "<your client id>:<n>"', code: 'forbidden' });
            }
            if (!allowOp()) return ack({ ok: false, error: 'Rate limited', code: 'rate_limited' });
            const result = rooms.apply(roomId, p.op, { origin: `user:${clientId}`, opId: p.opId, sequenced: true });
            ack(result.ok ? { ok: true, seq: result.seq, duplicate: result.duplicate || undefined } : { ok: false, error: result.error, code: result.code });
        });

        socket.on('disconnect', leaveCurrent);
    });
}
