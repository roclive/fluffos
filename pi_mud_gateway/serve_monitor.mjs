import {fileURLToPath} from 'node:url';
import {createMonitorHttpServer} from './lib/monitor_http.mjs';

const host = '127.0.0.1';
const port = Number.parseInt(process.env.PI_MUD_MONITOR_HTTP_PORT || '4173', 10);
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
  throw new Error('PI_MUD_MONITOR_HTTP_PORT must be an integer from 1 to 65535');
}

const htmlPath = fileURLToPath(new URL('./web/automation-monitor.html', import.meta.url));
const server = createMonitorHttpServer({htmlPath, host});
server.listen(port, host, () => {
  console.log(`[Pi MUD] automation monitor → http://${host}:${port}/`);
});
