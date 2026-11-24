import { createApp } from './app.js';
import { config } from './config.js';
import { createDb, migrate, type Db } from './db/db.js';
import { fullMcpFeatures } from './mcp/features.js';
import { attachMcp } from './mcp/http.js';

let db: Db | undefined;
if (config.databaseUrl) {
    db = createDb(config.databaseUrl);
    await migrate(db);
    console.log('Accounts and saved boards are on (Postgres connected)');
} else {
    console.log('No DATABASE_URL: running with anonymous, in-memory boards');
}
if (config.devLogin) console.warn('DEV_LOGIN is on: anyone can sign in as any email. Never use this in production.');

const { server, close } = createApp(
    config,
    {
        routes: (app, rooms, platform) => attachMcp(app, rooms, config, fullMcpFeatures, platform),
    },
    { db },
);

server.listen(config.port, () => {
    console.log(`Server is running on port ${config.port}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
        close()
            .then(() => db?.end())
            .finally(() => process.exit(0));
    });
}
