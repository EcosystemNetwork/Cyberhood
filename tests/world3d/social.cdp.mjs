// Social: a party invite from the target frame, party frames, party chat, whispers, emotes,
// Tab targeting, and a trade of smoke bombs for nothing that really moves them between accounts.
// Needs the dev server (local testing hands each new account 5 smoke bombs).
import assert from 'node:assert/strict';
import { launch, ready, sleep, BASE } from './harness.mjs';

const signup = async () => {
  const username = 's' + Math.random().toString(36).slice(2, 10);
  const r = await fetch(`${BASE}/api/game/signup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: 'hunter2hunter2' }) });
  return { username, ...(await r.json()) };
};
const bag = async (key) => (await (await fetch(`${BASE}/api/game/state`, { headers: { Authorization: 'Bearer ' + key } })).json()).econ.bag;

// polls a page expression until it's truthy (Realtime can take a few seconds)
const waitFor = async (p, expr, ms = 8000) => { for (let t = 0; t < ms; t += 250) { const v = await p.ev(expr); if (v) return v; await sleep(250); } return p.ev(expr); };
const { player, kill } = await launch();
try {
  const tag = Math.random().toString(36).slice(2, 6); // the dev channel is shared with other test runs
  const RED = 'Red' + tag, BLUE = 'Blue' + tag;
  const A = await player(RED), B = await player(BLUE);
  const ua = await signup(), ub = await signup();
  for (const [p, u] of [[A, ua], [B, ub]]) await p.ev(`localStorage.setItem('taproot_session', '${u.key}'); localStorage.setItem('taproot_owner', '${u.username}'); 1`);
  await A.go(`${BASE}/game/world3d/?area=fields&hour=13`);
  await B.go(`${BASE}/game/world3d/?area=fields&hour=13`);
  const [ra, rb] = [await ready(A, 60000), await ready(B, 60000)];
  if (!ra || !rb) for (const p of [A, B]) console.log('not live:', await p.ev(`JSON.stringify({ url: location.href, w: !!window.__world3d, mp: window.__world3d && __world3d.mp.live, txt: (document.getElementById('mpText') || {}).textContent })`));
  assert.ok(ra && rb);
  await sleep(3000);
  const W = '__world3d';
  await A.ev(`${W}.tp(${W}.P.x, ${W}.P.z); 1`);
  const [ax, az] = await A.ev(`[${W}.P.x, ${W}.P.z]`);
  await B.ev(`${W}.tp(${ax + 1.5}, ${az}); 1`);
  await sleep(1500);
  const chat = (p) => p.ev(`document.getElementById('chatLog').textContent`);
  const say = (p, txt) => p.ev(`(() => { document.getElementById('chatIn').value = ${JSON.stringify(txt)}; document.getElementById('chatSend').click(); return 1; })()`);

  // Tab targets the nearest thing; clicking Blue's name tag targets Blue
  await A.ev(`(() => { for (const m of ${W}.monsters) m.dead = true; return 1; })()`);
  await waitFor(A, `[...${W}.ghosts.values()].some((g) => g.name === '${BLUE}' && Math.hypot(g.x - ${W}.P.x, g.z - ${W}.P.z) < 4)`);
  // (the dev channel can have other test players on it: Tab on until it reaches Blue)
  for (let i = 0; i < 12 && (await A.ev(`document.getElementById('tfName').textContent`)) !== BLUE; i++) await A.key('Tab');
  assert.equal(await A.ev(`document.getElementById('tfName').textContent`), BLUE);
  assert.equal(await A.ev(`document.getElementById('tfBtns').hidden`), false);

  // party: invite from the target frame, Blue accepts
  await A.ev(`document.getElementById('tfInvite').click(); 1`);
  await waitFor(B, `document.getElementById('askText').textContent`);
  assert.match(await B.ev(`document.getElementById('askText').textContent`), new RegExp(`${RED} invites you to a party`));
  await B.ev(`document.getElementById('askYes').click(); 1`);
  await waitFor(A, `!document.getElementById('partyFrames').hidden && /${BLUE}/.test(document.getElementById('partyFrames').textContent)`);
  await waitFor(B, `/${RED}/.test(document.getElementById('partyFrames').textContent)`);
  assert.match(await chat(B), new RegExp(`joined ${RED}'s party`));
  assert.equal(await A.ev(`document.getElementById('partyFrames').hidden`), false);
  assert.match(await A.ev(`document.getElementById('partyFrames').textContent`), new RegExp(BLUE));
  assert.match(await B.ev(`document.getElementById('partyFrames').textContent`), new RegExp(RED));

  // party chat, whispers, emotes
  await say(A, '/p hello team');
  await say(B, `/w ${RED} psst`);
  await say(A, '/wave');
  await waitFor(B, `document.getElementById('chatLog').textContent.includes('waves')`);
  await waitFor(A, `document.getElementById('chatLog').textContent.includes('psst')`);
  assert.match(await chat(B), new RegExp(`\\[Party\\] ${RED}: hello team`));
  assert.match(await chat(A), new RegExp(`${BLUE} whispers: psst`));
  assert.match(await chat(B), new RegExp(`${RED} waves`));

  // trade: Red gives Blue 2 smoke bombs
  const before = [(await bag(ua.key)).smoke_bomb || 0, (await bag(ub.key)).smoke_bomb || 0];
  await B.ev(`document.getElementById('askBox').hidden || document.getElementById('askNo').click(); 1`);
  await A.ev(`document.getElementById('tfTrade').click(); 1`);
  if (!(await waitFor(B, `/wants to trade/.test(document.getElementById('askText').textContent) && !document.getElementById('askBox').hidden`))) console.log('A chat:', await chat(A));
  assert.match(await B.ev(`document.getElementById('askText').textContent`), new RegExp(`${RED} wants to trade`));
  await B.ev(`document.getElementById('askYes').click(); 1`);
  assert.equal(await waitFor(A, `!document.getElementById('tradePanel').hidden`), true);
  await A.ev(`(() => { const b = () => document.querySelector('#tradeMine button[data-i="smoke_bomb"][data-n="1"]'); b().click(); b().click(); return 1; })()`);
  await waitFor(B, `/x2/.test(document.getElementById('tradeTheirs').textContent)`);
  assert.match(await B.ev(`document.getElementById('tradeTheirs').textContent`), /x2/);
  await A.ev(`document.getElementById('tradeGo').click(); 1`);
  await B.ev(`document.getElementById('tradeGo').click(); 1`);
  await waitFor(A, `document.getElementById('chatLog').textContent.includes('complete')`, 15000);
  await waitFor(B, `document.getElementById('chatLog').textContent.includes('complete')`, 5000);
  assert.match(await chat(A), new RegExp(`Trade with ${BLUE} complete`));
  assert.match(await chat(B), new RegExp(`Trade with ${RED} complete`));
  const after = [(await bag(ua.key)).smoke_bomb || 0, (await bag(ub.key)).smoke_bomb || 0];
  assert.deepEqual(after, [before[0] - 2, before[1] + 2], 'the server moved two smoke bombs');

  // leaving
  await say(B, '/leave');
  await waitFor(A, `document.getElementById('partyFrames').hidden`);
  assert.equal(await A.ev(`document.getElementById('partyFrames').hidden`), true);
  console.log('PASS');
} finally { kill(); }
process.exit(0);
