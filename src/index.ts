import { createApp } from './app.js';
import { config } from './config.js';
import { fullMcpFeatures } from './mcp/features.js';
import { attachMcp } from './mcp/http.js';

const { server, close } = createApp(config, {
    routes: (app, rooms) => attachMcp(app, rooms, config, fullMcpFeatures),
});

server.listen(config.port, () => {
    console.log(`Server is running on port ${config.port}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
        close().finally(() => process.exit(0));
    });
}
