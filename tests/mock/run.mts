// `npm run mock`: run the mock provider standalone for manual testing.
import { MOCK_KEY, startMockServer } from './server.ts';

const port = Number(process.env.PORT) || 8787;
const server = await startMockServer({ port, chunkDelayMs: 40 });
console.log(`Mock provider listening at ${server.url}`);
console.log(`Add it in Relay as a Custom provider with this key: ${MOCK_KEY}`);
