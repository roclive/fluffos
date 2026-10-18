import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';

const ALLOWED_PATHS = new Set(['/', '/automation-monitor.html']);

export function createMonitorHttpServer({htmlPath, host = '127.0.0.1'} = {}) {
  if (!htmlPath) throw new Error('htmlPath is required');
  return createServer(async (request, response) => {
    const method = request.method || 'GET';
    let pathname;
    try {
      pathname = new URL(request.url || '/', `http://${host}`).pathname;
    } catch {
      response.writeHead(400).end('Bad Request');
      return;
    }
    if ((method !== 'GET' && method !== 'HEAD') || !ALLOWED_PATHS.has(pathname)) {
      const allowedMethod = method === 'GET' || method === 'HEAD';
      response.writeHead(allowedMethod ? 404 : 405, {
        'Content-Type': 'text/plain; charset=utf-8',
        ...(allowedMethod ? {} : {'Allow': 'GET, HEAD'}),
      }).end(allowedMethod ? 'Not Found' : 'Method Not Allowed');
      return;
    }
    try {
      const html = await readFile(htmlPath);
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': "default-src 'self'; connect-src ws://127.0.0.1:* ws://localhost:*; style-src 'unsafe-inline'; script-src 'unsafe-inline'",
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store',
      });
      response.end(method === 'HEAD' ? undefined : html);
    } catch {
      response.writeHead(500, {'Content-Type': 'text/plain; charset=utf-8'}).end('Monitor unavailable');
    }
  });
}
