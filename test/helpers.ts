import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { io as ioClient, type Socket } from 'socket.io-client';
import { createApp, type AppHooks } from '../src/app.js';
import { config } from '../src/config.js';
import { DEFAULTS, EVENTS, PROTOCOL_VERSION, type JoinAck, type LineShape, type OpAck, type OpBroadcast, type Shape } from '../src/shared/protocol.js';

let counter = 0;

export function rect(overrides: Partial<Extract<Shape, { type: 'rect' }>> = {}): Shape {
    counter++;
    return {
        id: `r${counter}`,
        type: 'rect',
        x: 0,
        y: 0,
        width: 100,
        height: 50,
        rotation: 0,
        opacity: 1,
        strokeColor: DEFAULTS.strokeColor,
        strokeWidth: 2,
        fillColor: 'transparent',
        z: counter,
        updatedAt: 0,
        createdBy: 'user:test',
        ...overrides,
    };
}

export function arrow(overrides: Partial<LineShape> = {}): LineShape {
    counter++;
    return {
        id: `a${counter}`,
        type: 'arrow',
        x: 0,
        y: 0,
        points: [0, 0, 100, 0],
        rotation: 0,
        opacity: 1,
        strokeColor: DEFAULTS.strokeColor,
        strokeWidth: 2,
        fillColor: 'transparent',
        z: counter,
        updatedAt: 0,
        createdBy: 'user:test',
        ...overrides,
    };
}

export async function startServer(hooks?: AppHooks, overrides: Partial<typeof config> = {}) {
    const app = createApp({ ...config, logRequests: false, socketOpsPerSecond: 1000, socketJoinsPerMinute: 6000, mcpRequestsPerSecond: 1000, ...overrides }, hooks);
    await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
    const { port } = app.server.address() as AddressInfo;
    const url = `http://127.0.0.1:${port}`;
    const sockets: Socket[] = [];
    return {
        ...app,
        url,
        async connect() {
            const socket = ioClient(url, { transports: ['websocket'], forceNew: true });
            sockets.push(socket);
            await new Promise<void>((resolve, reject) => {
                socket.once('connect', () => resolve());
                socket.once('connect_error', reject);
            });
            return socket;
        },
        async stop() {
            for (const s of sockets) s.disconnect();
            await app.close();
        },
    };
}

type TestSocket = Socket & { clientId?: string; counter?: number };

export function join(
    socket: TestSocket,
    roomId: string,
    extra: { pendingOpIds?: string[]; retireClientIds?: string[]; clientId?: string } = {},
): Promise<JoinAck> {
    const clientId = extra.clientId ?? randomUUID();
    return socket
        .timeout(2000)
        .emitWithAck(EVENTS.join, { roomId, clientId, protocolVersion: PROTOCOL_VERSION, pendingOpIds: extra.pendingOpIds, retireClientIds: extra.retireClientIds })
        .then((ack: JoinAck) => {
            if (ack.ok) {
                socket.clientId = clientId;
                socket.counter = 0;
            }
            return ack;
        });
}

/** Sends an op with the next sequential id for this socket's client (or an explicit id). */
export function sendOp(socket: TestSocket, roomId: string, op: unknown, opId?: string): Promise<OpAck> {
    const id = opId ?? `${socket.clientId ?? 'nobody'}:${(socket.counter = (socket.counter ?? 0) + 1)}`;
    return socket.timeout(2000).emitWithAck(EVENTS.op, { roomId, op, opId: id });
}

export function nextOp(socket: Socket, timeoutMs = 2000): Promise<OpBroadcast> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timed out waiting for op')), timeoutMs);
        socket.once(EVENTS.op, (payload: OpBroadcast) => {
            clearTimeout(timer);
            resolve(payload);
        });
    });
}

/** Resolves true if no op arrives within `ms`. */
export function noOpWithin(socket: Socket, ms = 150): Promise<boolean> {
    return new Promise((resolve) => {
        const handler = () => {
            clearTimeout(timer);
            resolve(false);
        };
        const timer = setTimeout(() => {
            socket.off(EVENTS.op, handler);
            resolve(true);
        }, ms);
        socket.once(EVENTS.op, handler);
    });
}
