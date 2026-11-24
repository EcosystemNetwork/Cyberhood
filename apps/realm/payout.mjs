/* Paying out kills: the realm sees them, the game API owns the economy.

   Kills queue here and go to the API (POST <api>/realm, header x-realm-key) in batches about
   once a second. The API pays each kill id once (economy.js 'rkill'), so a batch that may or may
   not have landed (timeout, crash, restart) is simply sent again. On failure the queue waits
   longer each time (up to 30 s) and keeps the kills; a full queue refuses new ones rather than
   lose the ones it already has. A drain flushes what is left before the process exits.

   add({ k: kill id, m: monster, u: [sealed accounts], to: Map account -> sid })
   onPaid({ u, k, r, xp, m, sid }) for every account the API answered for */

export function createPayout({ url, secret, fetch = globalThis.fetch, log = console.log, everyMs = 1000,
  maxQueue = 5000, batch = 200, timeoutMs = 10_000, onPaid = () => {} } = {}) {
  const queue = [];
  const stats = { queued: 0, paid: 0, refused: 0, dropped: 0, failures: 0 };
  let busy = null, failures = 0, waitUntil = 0;

  function add(kill) {
    if (!kill.u.length) return;
    if (queue.length >= maxQueue) { stats.dropped++; if (stats.dropped % 100 === 1) log(`payout queue full: ${stats.dropped} kill(s) dropped`); return; }
    queue.push(kill);
  }

  async function send() {
    const sent = queue.slice(0, batch);
    try {
      const res = await fetch(url.replace(/\/$/, '') + '/realm', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-realm-key': secret },
        body: JSON.stringify({ kills: sent.map(({ k, m, u }) => ({ k, m, u })) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status === 400) { // the API will never take this batch: don't block the queue on it
        queue.splice(0, sent.length);
        stats.dropped += sent.length;
        log(`payout: API refused a batch of ${sent.length}`);
        return;
      }
      if (res.status !== 200) throw new Error(`API answered ${res.status}`);
      const { paid = [] } = await res.json();
      queue.splice(0, sent.length); // only add() touches the queue meanwhile, and it only appends
      failures = 0;
      const byK = new Map(sent.map((s) => [s.k, s]));
      for (const p of paid) {
        const kill = byK.get(p.k);
        if (!kill) continue;
        if (p.r) stats.refused++; else stats.paid++;
        onPaid({ ...p, m: kill.m, sid: kill.to && kill.to.get(p.u) });
      }
    } catch (e) {
      failures++;
      stats.failures++;
      waitUntil = Date.now() + Math.min(30_000, 500 * 2 ** failures);
      log(`payout: ${e.message}; ${queue.length} kill(s) waiting`);
    }
  }
  // one request at a time; resolves when this one (or the one already running) is done
  function flush({ force = false } = {}) {
    if (busy) return busy;
    if (!queue.length || (!force && Date.now() < waitUntil)) return Promise.resolve();
    busy = send().finally(() => { busy = null; });
    return busy;
  }

  const timer = setInterval(() => flush(), everyMs);
  if (timer.unref) timer.unref();

  return {
    add, flush,
    stats: () => ({ ...stats, queued: queue.length }),
    // a last try for everything still queued (a deploy's SIGTERM)
    async stop(deadlineMs = 10_000) {
      clearInterval(timer);
      const end = Date.now() + deadlineMs;
      while (queue.length && Date.now() < end) {
        const before = queue.length;
        await flush({ force: true });
        if (queue.length >= before) break; // the API is down: nothing more to do
      }
      if (queue.length) log(`payout: ${queue.length} kill(s) unpaid at shutdown`);
    },
  };
}
