const list = (value: string | undefined, fallback: string[]) =>
    value
        ? value
              .split(',')
              .map((v) => v.trim())
              .filter(Boolean)
        : fallback;

const int = (value: string | undefined, fallback: number) => {
    const n = Number.parseInt(value ?? '', 10);
    return Number.isFinite(n) ? n : fallback;
};

export const config = {
    port: int(process.env.PORT, 3000),
    corsOrigins: list(process.env.CORS_ORIGINS, [
        'https://sketchsync.onrender.com',
        'http://localhost:5173',
        'http://localhost:4173',
        'http://127.0.0.1:5173',
    ]),
    /** Public frontend URL used in MCP tool messages. */
    frontendUrl: process.env.FRONTEND_URL ?? 'https://sketchsync.onrender.com',
    maxRooms: int(process.env.MAX_ROOMS, 2000),
    idleRoomTtlMs: int(process.env.IDLE_ROOM_TTL_HOURS, 48) * 60 * 60 * 1000,
    sweepIntervalMs: 10 * 60 * 1000,
    maxTotalBytes: int(process.env.MAX_TOTAL_MB, 256) * 1024 * 1024,
    socketOpsPerSecond: int(process.env.SOCKET_OPS_PER_SECOND, 120),
    socketJoinsPerMinute: int(process.env.SOCKET_JOINS_PER_MINUTE, 30),
    maxConnectionsPerIp: int(process.env.MAX_CONNECTIONS_PER_IP, 50),
    mcpRequestsPerSecond: int(process.env.MCP_REQUESTS_PER_SECOND, 20),
    logRequests: process.env.NODE_ENV !== 'test',
};

export type Config = typeof config;
