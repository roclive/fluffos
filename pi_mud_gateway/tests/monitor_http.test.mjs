import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {createMonitorHttpServer} from '../lib/monitor_http.mjs';
import {isTrustedWebSocketRequest} from '../lib/automation_visualizer.mjs';

test('loopback HTTP server provides a browser origin accepted by strict WebSocket validation', async (t) => {
  const htmlPath = fileURLToPath(new URL('../web/automation-monitor.html', import.meta.url));
  const server = createMonitorHttpServer({htmlPath});
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  const origin = `http://127.0.0.1:${address.port}`;

  const response = await fetch(`${origin}/`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^text\/html/);
  assert.match(await response.text(), /Pi \/ MUD 自动化监视器/);
  assert.equal(isTrustedWebSocketRequest({socket: {remoteAddress: '127.0.0.1'}, headers: {origin}}), true);

  const traversal = await fetch(`${origin}/secret.txt`);
  assert.equal(traversal.status, 404);
});
