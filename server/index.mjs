import { createApp, readConfig } from './app.mjs';
const app = createApp({ config: readConfig() });
const port = Number(process.env.PORT || 3001);
const host = process.env.HOST || '127.0.0.1';
app.server.listen(port, host, () => console.log(`Brclio Robot account service: http://${host}:${port}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await app.close(); process.exit(0); });
