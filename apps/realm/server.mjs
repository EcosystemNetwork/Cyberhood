// Cyberhood realm server: the authoritative realtime service (see the architecture plan).
//
// This is the deployable skeleton: HTTP health check, the /play WebSocket with protocol
// versioning, per-connection limits, keepalive pings and graceful draining on SIGTERM.
// Ticket auth, the 30 Hz combat loop and zones land in phase 2; until then a socket can
// only say hello and ping, and is told plainly that nothing else is served yet.
import http from 'node:http';
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';

export const PROTOCOL = 1;
const LIMITS = {
  maxPayload: 2048,      // bytes per message
  msgsPerSecond: 60,     // more than this and the socket is closed
  maxMalformed: 20,      // bad JSON or unknown types before the socket is closed
  helloMs: 10_000,       // time a new socket has to say hello
  pingMs: 20_000,        // keepalive: proxies drop idle sockets, dead peers are found
  drainMs: 25_000,       // longest a SIGTERM waits for players to leave
};

export function createRealm({ port = 8080, log = console.log } = {}) {
  const startedAt = Date.now();
  let draining = false;

  const server = http.createServer((req, res) => {
    if (req.url === '/health' || req.url === '/') {
      const body = { ok: !draining, service: 'realm', protocol: PROTOCOL, players: wss.clients.size,
        draining, uptimeS: Math.round((Date.now() - startedAt) / 1000) };
      res.writeHead(draining ? 503 : 200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: LIMITS.maxPayload });

  server.on('upgrade', (req, socket, head) => {
    const path = (req.url || '').split('?')[0];
    if (path !== '/play' || draining) {
      socket.write(`HTTP/1.1 ${draining ? '503 Service Unavailable' : '404 Not Found'}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  const send = (ws, msg) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg)); };

  wss.on('connection', (ws) => {
    ws.alive = true;
    ws.nonce = crypto.randomBytes(16).toString('base64url'); // the ticket's tab key will sign this (phase 2)
    ws.hello = false;
    let windowStart = Date.now(), count = 0, malformed = 0;

    const helloTimer = setTimeout(() => { if (!ws.hello) ws.close(4001, 'no hello'); }, LIMITS.helloMs);
    ws.on('pong', () => { ws.alive = true; });
    // oversized or invalid frames: ws closes the socket itself; without a listener the error would crash the process
    ws.on('error', () => ws.terminate());
    ws.on('close', () => clearTimeout(helloTimer));

    send(ws, { t: 'challenge', v: PROTOCOL, nonce: ws.nonce });

    ws.on('message', (data, isBinary) => {
      const now = Date.now();
      if (now - windowStart >= 1000) { windowStart = now; count = 0; }
      if (++count > LIMITS.msgsPerSecond) { ws.close(4008, 'too many messages'); return; }
      let msg;
      try { msg = isBinary ? null : JSON.parse(data.toString()); } catch { msg = null; }
      if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') {
        if (++malformed > LIMITS.maxMalformed) ws.close(4002, 'malformed');
        return;
      }
      if (msg.t === 'hello') {
        if (msg.v !== PROTOCOL) { send(ws, { t: 'error', code: 'update', want: PROTOCOL }); ws.close(4003, 'protocol'); return; }
        ws.hello = true;
        send(ws, { t: 'welcome', v: PROTOCOL, ready: false, note: 'skeleton: tickets, zones and combat arrive in phase 2' });
        return;
      }
      if (msg.t === 'ping') { send(ws, { t: 'pong', at: msg.at ?? null, server: now }); return; }
      if (++malformed > LIMITS.maxMalformed) { ws.close(4002, 'malformed'); return; }
      send(ws, { t: 'error', code: 'unsupported', type: msg.t.slice(0, 32) });
    });
  });

  const pinger = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.alive) { ws.terminate(); continue; }
      ws.alive = false;
      ws.ping();
    }
  }, LIMITS.pingMs);

  // Railway sends SIGTERM on every deploy: stop taking players, warn the ones here, and exit
  // once they have gone or the drain time is up. Clients reconnect to the new deployment.
  async function drain(signal) {
    if (draining) return;
    draining = true;
    log(`${signal}: draining ${wss.clients.size} player(s)`);
    for (const ws of wss.clients) send(ws, { t: 'draining', reconnectInMs: 2000 });
    const deadline = Date.now() + LIMITS.drainMs;
    while (wss.clients.size && Date.now() < deadline) await new Promise((r) => setTimeout(r, 250));
    for (const ws of wss.clients) ws.close(1012, 'restarting');
    clearInterval(pinger);
    await new Promise((r) => server.close(r));
  }

  return {
    server, wss, drain,
    listen: () => new Promise((r) => server.listen(port, () => { log(`realm listening on :${server.address().port}`); r(server.address().port); })),
    close: async () => { clearInterval(pinger); for (const ws of wss.clients) ws.terminate(); await new Promise((r) => server.close(r)); },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const realm = createRealm({ port: Number(process.env.PORT) || 8080 });
  await realm.listen();
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, async () => { await realm.drain(sig); process.exit(0); });
}
