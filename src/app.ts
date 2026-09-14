import cors from 'cors';
import express from 'express';
import morgan from 'morgan';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import type { Config } from './config.js';
import { attachRealtime } from './realtime/socket.js';
import { InMemoryRoomStore } from './rooms/RoomStore.js';
import { RoomService } from './rooms/RoomService.js';
import { LIMITS } from './shared/protocol.js';

export interface AppHooks {
    /** Registers extra routes (MCP) before the 404 handler. */
    routes?: (app: express.Express, rooms: RoomService) => void;
}

export function createApp(config: Config, hooks: AppHooks = {}) {
    const app = express();
    app.disable('x-powered-by');
    app.set('trust proxy', 1);
    const server = createServer(app);
    const io = new Server(server, {
        cors: { origin: config.corsOrigins, methods: ['GET', 'POST'] },
        // Images are sent as data URLs; clients split larger ops.
        maxHttpBufferSize: LIMITS.maxMessageBytes,
    });

    const rooms = new RoomService(new InMemoryRoomStore(), {
        maxRooms: config.maxRooms,
        idleTtlMs: config.idleRoomTtlMs,
        maxTotalBytes: config.maxTotalBytes,
    });
    const sweepTimer = setInterval(() => rooms.sweep(), config.sweepIntervalMs);
    sweepTimer.unref();

    if (config.logRequests) app.use(morgan('tiny'));

    app.get('/ping', cors({ origin: config.corsOrigins }), (_req, res) => {
        res.send({ message: 'Server is alive!' });
    });

    hooks.routes?.(app, rooms);

    attachRealtime(io, rooms, {
        opsPerSecond: config.socketOpsPerSecond,
        joinsPerMinute: config.socketJoinsPerMinute,
        maxConnectionsPerIp: config.maxConnectionsPerIp,
    });

    return {
        app,
        server,
        io,
        rooms,
        close: async () => {
            clearInterval(sweepTimer);
            await io.close();
            if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
        },
    };
}
