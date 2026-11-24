import type { Server, Socket } from 'socket.io';
import type { User } from '../auth/AuthService.js';
import { canEdit, linkRole, type Role } from '../boards/BoardRepo.js';
import type { LiveRooms, Platform } from '../platform.js';
import { RoomError, type RoomService } from '../rooms/RoomService.js';
import { sortByZ } from '../shared/ops.js';
import {
    cleanPresence,
    CLIENT_ID_RE,
    EVENTS,
    isValidRoomId,
    parseOpId,
    PROTOCOL_VERSION,
    type AccessBroadcast,
    type JoinAck,
    type OpAck,
    type OpBroadcast,
    type TitleBroadcast,
} from '../shared/protocol.js';

interface SocketData {
    user: User | null;
    /** Role on the joined board. */
    role: Role | null;
    roomId: string | null;
}

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

export function attachRealtime(io: Server, rooms: RoomService, opts: RealtimeOptions, platform?: Platform): LiveRooms {
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
        const data = socket.data as SocketData;
        data.user = null;
        data.role = null;
        data.roomId = null;
        const token = (socket.handshake.auth as { token?: unknown } | undefined)?.token;
        if (!platform || typeof token !== 'string' || !token) return next();
        // An expired or unknown token just means a guest.
        platform.auth
            .userForSession(token)
            .then((user) => {
                data.user = user;
                next();
            })
            .catch(() => next());
    });

    /** Newest saved title per open board, so presence updates only hit the database when the name changes. */
    const titleAt = new Map<string, number>();

    io.on('connection', (socket: Socket) => {
        // One board per connection.
        let currentRoom: string | null = null;
        let clientId: string | null = null;
        const allowOp = bucket(opts.opsPerSecond, opts.opsPerSecond * 2);
        const allowPresence = bucket(30, 40);
        const allowJoin = bucket(opts.joinsPerMinute / 60, Math.max(3, Math.ceil(opts.joinsPerMinute / 6)));

        const data = socket.data as SocketData;
        let joinGeneration = 0;

        const leaveCurrent = () => {
            data.role = null;
            data.roomId = null;
            if (!currentRoom) return;
            const roomOwners = owners.get(currentRoom);
            if (clientId && roomOwners?.get(clientId) === socket.id) {
                roomOwners.delete(clientId);
                if (roomOwners.size === 0) owners.delete(currentRoom);
            }
            if (clientId) socket.to(currentRoom).emit(EVENTS.presenceLeave, { id: clientId });
            rooms.leave(currentRoom);
            socket.leave(currentRoom);
            currentRoom = null;
        };

        socket.on(EVENTS.join, async (payload: unknown, rawAck: Ack<JoinAck>) => {
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
            const resync = currentRoom === roomId && clientId === joinClientId;
            if (!resync && !allowJoin()) return ack({ ok: false, error: 'Too many joins, slow down', code: 'rate_limited' });
            const generation = ++joinGeneration;

            // Accounts: who may open this board, and load it from the database.
            let role: Role = 'editor';
            let meta: { title: string; titleAt: number } | undefined;
            if (platform) {
                try {
                    const user = data.user;
                    let { board, role: found, member } = await platform.boards.access(roomId, user);
                    if (!board) {
                        // Opening a link to a board nobody saved yet starts an anonymous board, as before accounts.
                        board = await platform.boards.ensure(roomId);
                        if (!board) return ack({ ok: false, error: 'This board was deleted.', code: 'not_found' });
                        found = linkRole(board.linkAccess);
                        member = false;
                    }
                    if (!found) {
                        return ack(
                            user
                                ? { ok: false, error: "You don't have access to this board. Ask its owner to share it with you.", code: 'forbidden' }
                                : { ok: false, error: 'This board is private. Sign in to open it.', code: 'auth_required' },
                        );
                    }
                    role = found;
                    meta = { title: board.title, titleAt: board.titleAt };
                    if (!titleAt.has(roomId) || titleAt.get(roomId)! < board.titleAt) titleAt.set(roomId, board.titleAt);
                    await platform.store.load(roomId);
                    if (user && !member) void platform.boards.recordVisit(roomId, user.id).catch(() => undefined);
                } catch (err) {
                    console.error('Board access check failed', err);
                    return ack({ ok: false, error: 'Could not open this board right now', code: 'unavailable' });
                }
                // A newer join (or a disconnect) happened while we were waiting.
                if (generation !== joinGeneration || !socket.connected) return ack({ ok: false, error: 'Superseded by a newer join', code: 'unavailable' });
            }
            const extra = meta ? { role, title: meta.title, titleAt: meta.titleAt } : { role };

            try {
                if (resync && currentRoom === roomId && clientId === joinClientId) {
                    // Re-sync on the same connection.
                    const room = rooms.getRoom(roomId);
                    if (room) {
                        data.role = role;
                        data.roomId = roomId;
                        // Rejoin the broadcast channel in case access was removed and has since come back.
                        socket.join(roomId);
                        return ack({ ok: true, shapes: sortByZ(room.shapes.values()), seq: room.seq, fresh: false, appliedOpIds: rooms.appliedOpIds(roomId, p.pendingOpIds), ...extra });
                    }
                }
                const owner = owners.get(roomId)?.get(joinClientId);
                if (owner && owner !== socket.id) return ack({ ok: false, error: 'Client id already in use', code: 'forbidden' });
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
                data.role = role;
                data.roomId = roomId;
                ack({ ok: true, shapes: sortByZ(room.shapes.values()), seq: room.seq, fresh, appliedOpIds: rooms.appliedOpIds(roomId, p.pendingOpIds), ...extra });
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
            if (!canEdit(data.role)) return ack({ ok: false, error: 'You can only view this board', code: 'forbidden' });
            if (!allowOp()) return ack({ ok: false, error: 'Rate limited', code: 'rate_limited' });
            const result = rooms.apply(roomId, p.op, { origin: `user:${clientId}`, opId: p.opId, sequenced: true });
            ack(result.ok ? { ok: true, seq: result.seq, duplicate: result.duplicate || undefined } : { ok: false, error: result.error, code: result.code });
        });

        // Presence is best-effort: invalid or excess updates are dropped silently.
        socket.on(EVENTS.presence, (payload: unknown) => {
            const roomId = typeof (payload as { roomId?: unknown })?.roomId === 'string' ? (payload as { roomId: string }).roomId.toLowerCase() : '';
            if (!currentRoom || roomId !== currentRoom || !clientId || !data.role || !allowPresence()) return;
            const clean = cleanPresence(payload);
            if (!clean) return;
            if (clean.title !== undefined && clean.titleAt !== undefined) {
                // Only editors can rename; a viewer's copy of the name is never newer.
                if (!canEdit(data.role)) {
                    delete clean.title;
                    delete clean.titleAt;
                } else if (platform && clean.titleAt > (titleAt.get(roomId) ?? 0)) {
                    const at = Math.min(clean.titleAt, Date.now());
                    titleAt.set(roomId, at);
                    void platform.boards.setTitle(roomId, clean.title, at).catch(() => undefined);
                }
            }
            socket.to(currentRoom).volatile.emit(EVENTS.presence, { id: clientId, ...clean });
        });

        socket.on('disconnect', () => {
            joinGeneration++;
            leaveCurrent();
        });
    });

    return {
        async refreshAccess(roomId) {
            if (!platform) return;
            const sockets = await io.in(roomId).fetchSockets();
            for (const remote of sockets) {
                const local = io.sockets.sockets.get(remote.id);
                if (!local) continue;
                const data = local.data as SocketData;
                if (data.roomId !== roomId) continue;
                const { role } = await platform.boards.access(roomId, data.user);
                if (role === data.role) continue;
                data.role = role;
                local.emit(EVENTS.access, { roomId, role } satisfies AccessBroadcast);
                if (!role) local.leave(roomId);
            }
        },
        broadcastTitle(roomId, title, at) {
            if ((titleAt.get(roomId) ?? 0) < at) titleAt.set(roomId, at);
            io.to(roomId).emit(EVENTS.title, { roomId, title, titleAt: at } satisfies TitleBroadcast);
        },
        async close(roomId) {
            titleAt.delete(roomId);
            for (const local of io.sockets.sockets.values()) {
                const data = local.data as SocketData;
                if (data.roomId !== roomId) continue;
                data.role = null;
                local.emit(EVENTS.access, { roomId, role: null } satisfies AccessBroadcast);
                local.leave(roomId);
            }
        },
    };
}
