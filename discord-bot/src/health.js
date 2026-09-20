'use strict';

const http = require('node:http');

/**
 * Minimal HTTP server so Railway's health check has something to hit.
 * Returns 200 only once the Discord client is connected and ready.
 * Railway injects PORT automatically.
 */
function startHealthServer(client) {
  const port = Number(process.env.PORT) || 3000;

  const server = http.createServer((req, res) => {
    if (req.url === '/health' || req.url === '/') {
      const ready = client.isReady();
      res.writeHead(ready ? 200 : 503, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          status: ready ? 'ok' : 'starting',
          uptimeSeconds: Math.round(process.uptime()),
          wsPingMs: client.ws.ping,
        }),
      );
      return;
    }
    res.writeHead(404).end();
  });

  server.listen(port, '0.0.0.0', () => console.log(`[health] Listening on :${port}`));
  return server;
}

module.exports = { startHealthServer };
