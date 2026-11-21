// Gives a test account gold and bag items by writing to the dev server's mock database, the way
// an admin would. (Tests used to bring these in through the one-time 'import', but imported
// value is bound to the account now: it can't be traded, pooled or withdrawn.)
//   await grant(BASE, username, { gold: 2000, bag: { slime_gel: 99 } })
export async function grant(base, username, { gold = 0, bag = {} } = {}) {
  const url = `${base}/rest/v1/game_players`;
  const r = await fetch(`${url}?username=eq.${encodeURIComponent(username)}&select=id,econ,econ_rev`);
  const [row] = await r.json();
  if (!row) throw new Error('no such account: ' + username);
  const econ = { ...(row.econ || {}) };
  econ.gold = (econ.gold || 0) + gold;
  econ.bag = { ...(econ.bag || {}) };
  for (const [id, n] of Object.entries(bag)) econ.bag[id] = (econ.bag[id] || 0) + n;
  const w = await fetch(`${url}?id=eq.${row.id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ econ, econ_rev: (row.econ_rev || 0) + 1 }),
  });
  if (w.status >= 300) throw new Error('grant failed: ' + w.status);
}
