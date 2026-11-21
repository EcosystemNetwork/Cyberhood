// Cyberhood realm server: the authoritative realtime service.
//
// A socket on /play gets a challenge, says hello with its multiplayer ticket and a signature over
// the challenge (auth.mjs), joins a zone, and from then on sends what it wants to do (move, hit,
// say). Zones (zone.mjs) simulate at TICK_HZ and send each player what is near them at SNAP_HZ.
//
// Messages, client -> realm:
//   { t: 'hello', v, ticket, sig }   sig: the ticket key's signature over "cyberhood-realm-v1\n<nonce>"
//   { t: 'renew', ticket, sig }      a fresh ticket for the same session, before the old one expires
//   { t: 'join', zone }              enter a zone (leaving the one you're in)
//   { t: 'move', x, z, face }        where you are now
//   { t: 'hit', id, k, a, dmg }      an attack on a monster (k: swing | shot, a: attack id)
//   { t: 'say', msg }                chat to everyone who can see you
//   { t: 'ping', at }
// realm -> client: challenge, welcome, zone, s (snapshot), fix, hit, ouch, die, ko, say, refused,
//   error, pong, draining. See zone.mjs for the snapshot format.
import http from 'node:http';
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';
import { checkHello, importServerKey } from './auth.mjs';
import { Zone } from './zone.mjs';
import { ZONES } from './zones.mjs';

export const PROTOCOL = 2;
const LIMITS = {
  maxPayload: 2048,      // bytes per message
  msgsPerSecond: 60,     // more than this and the socket is closed
  maxMalformed: 20,      // bad JSON or unknown types before the socket is closed
  helloMs: 10_000,       // time a new socket has to say hello
  pingMs: 20_000,        // keepalive: proxies drop idle sockets, dead peers are found
  drainMs: 25_000,       // longest a SIGTERM waits for players to leave
  ticketGraceMs: 30_000, // after a ticket runs out, this long to renew it before the socket closes
};
const TICK_HZ = 30, SNAP_HZ = 10;

/* opts: port, log, serverKey (the API's ticket key; default env REALM_TICKET_KEY), zones,
   tickHz, snapHz, onKill(kill) (a kill to pay out: the economy hookup), rand */
export function createRealm({ port = 8080, log = console.log, serverKey = process.env.REALM_TICKET_KEY,
  zones = ZONES, tickHz = TICK_HZ, snapHz = SNAP_HZ, onKill = () => {}, rand = Math.random } = {}) {
  const startedAt = Date.now();
  let draining = false;
  const keyReady = serverKey ? importServerKey(serverKey) : Promise.resolve(null);
  keyReady.catch(() => log('REALM_TICKET_KEY is not a valid Ed25519 public key'));
  if (!serverKey) log('no REALM_TICKET_KEY: sockets can connect but nobody can sign in');

  const world = new Map(zones.map((z) => [z.id, new Zone(z, { rand, onKill })]));
  const sessions = new Map(); // sid -> the socket playing it (one per session)
  const perf = { tickMs: 0, ticks: 0 };

  const server = http.createServer((req, res) => {
    if (req.url === '/health' || req.url === '/') {
      const body = { ok: !draining, service: 'realm', protocol: PROTOCOL, players: sessions.size, sockets: wss.clients.size,
        draining, uptimeS: Math.round((Date.now() - startedAt) / 1000), tickMs: Math.round(perf.tickMs * 100) / 100,
        zones: Object.fromEntries([...world].map(([id, z]) => [id, z.stats()])) };
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
  const leaveZone = (ws) => { if (ws.zone) { ws.zone.removePlayer(ws.me.sid); ws.zone = null; } };

  async function signIn(ws, msg) {
    const me = await checkHello(await keyReady.catch(() => null), msg.ticket, ws.nonce, msg.sig);
    if (ws.readyState !== ws.OPEN) return null;
    if (!me) { send(ws, { t: 'error', code: 'auth' }); ws.close(4004, 'bad ticket'); return null; }
    return me;
  }

  wss.on('connection', (ws) => {
    ws.alive = true;
    ws.nonce = crypto.randomBytes(16).toString('base64url');
    ws.me = null;        // { sid, name, guest, exp } once signed in
    ws.zone = null;
    let windowStart = Date.now(), count = 0, malformed = 0, pending = false;

    const helloTimer = setTimeout(() => { if (!ws.me) ws.close(4001, 'no hello'); }, LIMITS.helloMs);
    ws.on('pong', () => { ws.alive = true; });
    // oversized or invalid frames: ws closes the socket itself; without a listener the error would crash the process
    ws.on('error', () => ws.terminate());
    ws.on('close', () => {
      clearTimeout(helloTimer);
      if (ws.me && sessions.get(ws.me.sid) === ws) { leaveZone(ws); sessions.delete(ws.me.sid); }
    });

    send(ws, { t: 'challenge', v: PROTOCOL, nonce: ws.nonce });

    const bad = () => { if (++malformed > LIMITS.maxMalformed) ws.close(4002, 'malformed'); };
    const refused = (t, why) => { if (why) send(ws, { t: 'refused', of: t, why }); };

    ws.on('message', async (data, isBinary) => {
      const now = Date.now();
      if (now - windowStart >= 1000) { windowStart = now; count = 0; }
      if (++count > LIMITS.msgsPerSecond) { ws.close(4008, 'too many messages'); return; }
      let msg;
      try { msg = isBinary ? null : JSON.parse(data.toString()); } catch { msg = null; }
      if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') return bad();

      if (msg.t === 'ping') { send(ws, { t: 'pong', at: msg.at ?? null, server: now }); return; }

      if (msg.t === 'hello') {
        if (ws.me || pending) return bad();
        if (msg.v !== PROTOCOL) { send(ws, { t: 'error', code: 'update', want: PROTOCOL }); ws.close(4003, 'protocol'); return; }
        pending = true;
        const me = await signIn(ws, msg);
        pending = false;
        if (!me) return;
        const old = sessions.get(me.sid);
        if (old && old !== ws) { leaveZone(old); old.close(4009, 'signed in elsewhere'); }
        ws.me = me;
        sessions.set(me.sid, ws);
        send(ws, { t: 'welcome', v: PROTOCOL, sid: me.sid, name: me.name, zones: [...world.keys()], tickHz, snapHz });
        return;
      }
      if (!ws.me) return bad(); // everything else needs a signed-in socket

      if (msg.t === 'renew') {
        if (pending) return bad();
        pending = true;
        const me = await signIn(ws, msg);
        pending = false;
        if (!me) return;
        if (me.sid !== ws.me.sid) { send(ws, { t: 'error', code: 'auth' }); ws.close(4004, 'another session'); return; }
        ws.me.exp = me.exp;
        send(ws, { t: 'renewed', exp: me.exp });
        return;
      }
      if (msg.t === 'join') {
        const zone = world.get(String(msg.zone));
        if (!zone) return refused('join', 'no such zone');
        leaveZone(ws);
        ws.zone = zone;
        zone.addPlayer(ws.me, (m) => send(ws, m), now);
        return;
      }
      if (!ws.zone) return refused(msg.t, 'not in a zone');
      if (msg.t === 'move') return refused('move', ws.zone.move(ws.me.sid, msg, now) === 'bad move' ? 'bad move' : '');
      if (msg.t === 'hit') return refused('hit', ws.zone.hit(ws.me.sid, msg, now));
      if (msg.t === 'say') return refused('say', ws.zone.say(ws.me.sid, msg.msg, now));
      bad();
      send(ws, { t: 'error', code: 'unsupported', type: msg.t.slice(0, 32) });
    });
  });

  // the simulation: every zone with someone in it steps at tickHz and sends snapshots at snapHz
  let tickN = 0;
  const every = Math.max(1, Math.round(tickHz / snapHz));
  const ticker = setInterval(() => {
    const t0 = performance.now(), now = Date.now(), snap = ++tickN % every === 0;
    for (const z of world.values()) {
      if (!z.players.size) continue;
      z.tick(now);
      if (snap) z.snapshot();
    }
    const ms = performance.now() - t0;
    perf.tickMs = perf.ticks++ ? perf.tickMs * 0.95 + ms * 0.05 : ms;
  }, 1000 / tickHz);

  const pinger = setInterval(() => {
    const now = Date.now();
    for (const ws of wss.clients) {
      if (!ws.alive) { ws.terminate(); continue; }
      if (ws.me && now > ws.me.exp + LIMITS.ticketGraceMs) { ws.close(4011, 'ticket expired'); continue; }
      ws.alive = false;
      ws.ping();
    }
  }, LIMITS.pingMs);

  const stop = () => { clearInterval(pinger); clearInterval(ticker); };
  // stop listening and drop idle keep-alive HTTP connections (health checks), or close() never returns
  const shut = () => new Promise((r) => { server.close(r); server.closeAllConnections(); });

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
    stop();
    await shut();
  }

  return {
    server, wss, world, sessions, drain,
    listen: () => new Promise((r) => server.listen(port, () => { log(`realm listening on :${server.address().port}`); r(server.address().port); })),
    close: async () => { stop(); for (const ws of wss.clients) ws.terminate(); await shut(); },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const realm = createRealm({ port: Number(process.env.PORT) || 8080 });
  await realm.listen();
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, async () => { await realm.drain(sig); process.exit(0); });
}
