import { readConfig } from './config.ts';
import { createHub } from './server.ts';
const config = readConfig();
const hub = createHub(config);
hub.store.interruptPending();
hub.server.listen(config.port, config.host, () => console.log(`Vibe hub listening on ${config.host}:${config.port}`));
void hub.proxy.sync();
const timer = setInterval(() => void hub.proxy.sync(), 60_000);
let stopping = false;
function shutdown() {
  if (stopping) return; stopping = true; clearInterval(timer); hub.stopRequests();
  hub.server.close(async () => { await hub.close(); hub.store.close(); process.exit(0); });
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
