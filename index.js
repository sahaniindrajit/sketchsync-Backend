// Entry point for hosts that run `node index.js` or `npm start`.
// Uses the compiled build when present (`npm run build`), otherwise runs the TypeScript sources directly.
import { existsSync } from 'node:fs';

if (existsSync(new URL('./dist/index.js', import.meta.url))) {
    await import('./dist/index.js');
} else {
    const { register } = await import('tsx/esm/api');
    register();
    await import('./src/index.ts');
}
