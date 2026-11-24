import cors from 'cors';
import express from 'express';
import morgan from 'morgan';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import { authRouter } from './auth/routes.js';
import { boardsRouter } from './boards/routes.js';
import type { Config } from './config.js';
import { cleanupExpired, type Db } from './db/db.js';
import { oauthRouter } from './oauth/routes.js';
import { createPlatform, type Platform } from './platform.js';
import { attachRealtime } from './realtime/socket.js';
import { InMemoryRoomStore } from './rooms/RoomStore.js';
import { RoomService } from './rooms/RoomService.js';
import { LIMITS } from './shared/protocol.js';

export interface AppHooks {
    /** Registers extra routes (MCP) before the 404 handler. */
    routes?: (app: express.Express, rooms: RoomService, platform?: Platform) => void;
}

export interface AppOptions {
    /** Postgres pool (already migrated). Enables accounts, saved boards and sharing. */
    db?: Db;
}

export function createApp(config: Config, hooks: AppHooks = {}, options: AppOptions = {}) {
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

    const platform = options.db ? createPlatform(options.db, rooms, config) : undefined;
    let cleanupTimer: ReturnType<typeof setInterval> | undefined;

    app.get('/ping', cors({ origin: config.corsOrigins }), (_req, res) => {
        res.send({ message: 'Server is alive!', accounts: !!platform });
    });

    if (platform) {
        platform.store.start();
        cleanupTimer = setInterval(() => void cleanupExpired(platform.db).catch(() => undefined), 60 * 60 * 1000);
        cleanupTimer.unref();
        const oauth = oauthRouter(platform, config);
        app.use(oauth.router);
        app.use(
            '/api',
            cors({ origin: config.corsOrigins, methods: ['GET', 'POST', 'PATCH', 'DELETE'], allowedHeaders: ['Content-Type', 'Authorization'], maxAge: 600 }),
            rateLimit({
                windowMs: 1000,
                limit: config.apiRequestsPerSecond,
                standardHeaders: 'draft-7',
                legacyHeaders: false,
                keyGenerator: (req) => ipKeyGenerator(req.ip ?? 'unknown'),
                handler: (_req, res) => res.status(429).json({ error: 'Too many requests, slow down' }),
            }),
        );
        app.use('/api', authRouter(platform, config), boardsRouter(platform), oauth.api);
        app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));
        app.use('/api', (err: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
            if (res.headersSent) return next(err);
            const type = err && typeof err === 'object' && 'type' in err ? (err as { type: string }).type : '';
            if (type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
            if (type === 'entity.too.large') return res.status(413).json({ error: 'Request too large' });
            console.error('API request failed', err);
            res.status(500).json({ error: 'Something went wrong' });
        });
    }

    hooks.routes?.(app, rooms, platform);

    const live = attachRealtime(
        io,
        rooms,
        {
            opsPerSecond: config.socketOpsPerSecond,
            joinsPerMinute: config.socketJoinsPerMinute,
            maxConnectionsPerIp: config.maxConnectionsPerIp,
        },
        platform,
    );
    if (platform) platform.live = live;

    return {
        app,
        server,
        io,
        rooms,
        platform,
        close: async () => {
            clearInterval(sweepTimer);
            if (cleanupTimer) clearInterval(cleanupTimer);
            await io.close();
            await platform?.store.stop();
            if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
        },
    };
}
