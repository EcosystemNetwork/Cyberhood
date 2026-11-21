/* A tiny in-process EVM chain for the contract and bridge tests, so they run without Foundry,
   anvil or a network. Every state-changing call is mined as its own block; logs are kept so
   eth_getLogs works, and serve() exposes the JSON-RPC methods the game API's chain sync uses
   (eth_chainId, eth_blockNumber, eth_getLogs, eth_call), plus what a browser wallet needs to send
   transactions as an unlocked account, like anvil (eth_sendTransaction, receipts, gas quotes).

   Calls run with evm.runCall: no signatures or gas fees, `from` is taken as given. Fine for
   testing contract logic; it isn't a full node. */
import http from 'node:http';
import { createVM } from '@ethereumjs/vm';
import { Common, Mainnet, Hardfork } from '@ethereumjs/common';
import { createBlock } from '@ethereumjs/block';
import { createAddressFromString } from '@ethereumjs/util';
import { keccak256, toBytes, encodeFunctionData, decodeFunctionResult, encodeDeployData, decodeErrorResult, bytesToHex, hexToBytes, toHex } from 'viem';
import { KIND, MINT_CAPS } from '../../game/lib/chain.js';

export class MiniChain {
  static async create(chainId = 46630) {
    const common = new Common({ chain: { ...Mainnet, chainId }, hardfork: Hardfork.Cancun });
    const c = new MiniChain();
    c.common = common;
    c.chainId = chainId;
    c.vm = await createVM({ common });
    c.number = 0n;
    c.time = BigInt(Math.floor(Date.now() / 1000));
    c.errors = []; // every deployed contract's custom errors, to name reverts that bubble up
    c.receipts = new Map(); // tx hash -> receipt
    c.logs = []; // { blockNumber, transactionHash, logIndex, address, topics, data }
    return c;
  }

  block(number, time) {
    return createBlock({ header: { number, timestamp: time, gasLimit: 30_000_000n, baseFeePerGas: 0n } }, { common: this.common });
  }
  // Moves the clock on (for deadlines).
  warp(seconds) { this.time += BigInt(seconds); }

  async raw({ from, to, data }, commit) {
    const number = commit ? this.number + 1n : this.number;
    const res = await this.vm.evm.runCall({
      caller: createAddressFromString(from),
      to: to ? createAddressFromString(to) : undefined,
      data: hexToBytes(data),
      gasLimit: 30_000_000n,
      block: this.block(number, this.time),
    });
    return res;
  }

  // A state-changing call, mined as a block. Throws with the revert's error name.
  async send({ from, to, abi, functionName, args = [], bytecode }) {
    const data = bytecode ? encodeDeployData({ abi, bytecode, args }) : encodeFunctionData({ abi, functionName, args });
    const res = await this.raw({ from, to, data }, true);
    const ex = res.execResult;
    if (ex.exceptionError) {
      const ret = bytesToHex(ex.returnValue);
      let name = ex.exceptionError.error;
      try { name = decodeErrorResult({ abi: [...abi, ...this.errors], data: ret }).errorName; } catch (e) {}
      const err = new Error('reverted: ' + name);
      err.revert = name;
      throw err;
    }
    this.number += 1n;
    this.time += 2n;
    const hash = toHex(this.number, { size: 32 });
    const first = this.logs.length;
    ex.logs.forEach(([address, topics, d], i) => this.logs.push({
      blockNumber: this.number, transactionHash: hash, logIndex: i,
      address: bytesToHex(address), topics: topics.map((t) => bytesToHex(t)), data: bytesToHex(d),
    }));
    this.receipts.set(hash, {
      transactionHash: hash, transactionIndex: '0x0', blockHash: hash, blockNumber: toHex(this.number), from, to: to || null,
      contractAddress: bytecode ? res.createdAddress.toString() : null, cumulativeGasUsed: '0x5208', gasUsed: '0x5208', effectiveGasPrice: '0x0',
      logsBloom: '0x' + '0'.repeat(512), status: '0x1', type: '0x2',
      logs: this.logs.slice(first).map((l) => ({ ...l, blockNumber: toHex(l.blockNumber), logIndex: toHex(l.logIndex), blockHash: hash, transactionIndex: '0x0', removed: false })),
    });
    return bytecode ? res.createdAddress.toString() : hash;
  }

  async deploy(from, { abi, bytecode }, args = []) {
    this.errors.push(...abi.filter((x) => x.type === 'error'));
    return this.send({ from, abi, bytecode, args });
  }

  async read({ to, abi, functionName, args = [] }) {
    const res = await this.raw({ from: '0x' + '0'.repeat(40), to, data: encodeFunctionData({ abi, functionName, args }) }, false);
    if (res.execResult.exceptionError) throw new Error('call reverted');
    return decodeFunctionResult({ abi, functionName, data: bytesToHex(res.execResult.returnValue) });
  }

  // JSON-RPC over HTTP. Returns { url, close }.
  serve() {
    const q = (n) => toHex(n);
    const handle = async ({ method, params = [] }) => {
      if (method === 'eth_chainId') return q(this.chainId);
      if (method === 'eth_blockNumber') return q(this.number);
      if (method === 'eth_call') {
        const res = await this.raw({ from: params[0].from || '0x' + '0'.repeat(40), to: params[0].to, data: params[0].data || params[0].input }, false);
        if (res.execResult.exceptionError) throw Object.assign(new Error('execution reverted'), { code: 3, data: bytesToHex(res.execResult.returnValue) });
        return bytesToHex(res.execResult.returnValue);
      }
      if (method === 'eth_sendTransaction') { // an unlocked account: no signature needed
        const t = params[0];
        const res = await this.raw({ from: t.from, to: t.to, data: t.data || t.input || '0x' }, true);
        const ex = res.execResult;
        if (ex.exceptionError) throw Object.assign(new Error('execution reverted'), { code: 3, data: bytesToHex(ex.returnValue) });
        // mined like send(): one block per transaction
        this.number += 1n; this.time += 2n;
        const hash = toHex(this.number, { size: 32 });
        const first = this.logs.length;
        ex.logs.forEach(([address, topics, d], i) => this.logs.push({ blockNumber: this.number, transactionHash: hash, logIndex: i, address: bytesToHex(address), topics: topics.map((x) => bytesToHex(x)), data: bytesToHex(d) }));
        this.receipts.set(hash, {
          transactionHash: hash, transactionIndex: '0x0', blockHash: hash, blockNumber: q(this.number), from: t.from, to: t.to || null,
          contractAddress: null, cumulativeGasUsed: '0x5208', gasUsed: '0x5208', effectiveGasPrice: '0x0', logsBloom: '0x' + '0'.repeat(512), status: '0x1', type: '0x2',
          logs: this.logs.slice(first).map((l) => ({ ...l, blockNumber: q(l.blockNumber), logIndex: q(l.logIndex), blockHash: hash, transactionIndex: '0x0', removed: false })),
        });
        return hash;
      }
      if (method === 'eth_getTransactionReceipt') return this.receipts.get(params[0]) || null;
      if (method === 'eth_getTransactionByHash') {
        const r = this.receipts.get(params[0]);
        return r ? { hash: r.transactionHash, blockHash: r.blockHash, blockNumber: r.blockNumber, transactionIndex: '0x0', from: r.from, to: r.to, input: '0x', value: '0x0', nonce: '0x0', gas: '0x5208', gasPrice: '0x0', maxFeePerGas: '0x0', maxPriorityFeePerGas: '0x0', type: '0x2', chainId: q(this.chainId), v: '0x0', r: '0x0', s: '0x0', accessList: [] } : null;
      }
      if (method === 'eth_estimateGas') return q(3_000_000n);
      if (method === 'eth_gasPrice' || method === 'eth_maxPriorityFeePerGas') return '0x0';
      if (method === 'eth_getTransactionCount') return '0x0';
      if (method === 'eth_getBlockByNumber') { // just the head (what the chain sync asks for)
        const zero = '0x' + '0'.repeat(64);
        return {
          number: q(this.number), hash: toHex(this.number, { size: 32 }), parentHash: zero, timestamp: q(this.time),
          nonce: '0x0000000000000000', difficulty: '0x0', gasLimit: q(30_000_000n), gasUsed: '0x0', baseFeePerGas: '0x0',
          miner: '0x' + '0'.repeat(40), extraData: '0x', logsBloom: '0x' + '0'.repeat(512), transactions: [], uncles: [],
          sha3Uncles: zero, stateRoot: zero, receiptsRoot: zero, transactionsRoot: zero, mixHash: zero, size: '0x0', totalDifficulty: '0x0',
        };
      }
      if (method === 'eth_getLogs') {
        const f = params[0] || {};
        const num = (v, d) => (v === undefined || v === 'latest' ? d : v === 'earliest' ? 0n : BigInt(v));
        const lo = num(f.fromBlock, this.number), hi = num(f.toBlock, this.number);
        const addrs = [].concat(f.address || []).map((a) => a.toLowerCase());
        const topics = f.topics || [];
        return this.logs.filter((l) => l.blockNumber >= lo && l.blockNumber <= hi
          && (!addrs.length || addrs.includes(l.address.toLowerCase()))
          && topics.every((t, i) => t === null || (Array.isArray(t) ? t.includes(l.topics[i]) : t === l.topics[i])))
          .map((l) => ({ ...l, blockNumber: q(l.blockNumber), logIndex: q(l.logIndex), blockHash: l.transactionHash, transactionIndex: '0x0', removed: false }));
      }
      throw Object.assign(new Error('method not supported: ' + method), { code: -32601 });
    };
    const server = http.createServer((req, res) => {
      // a browser page calls it too (the test wallet in tests/chain-wallet-page.test.mjs)
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Headers', 'content-type');
      if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', async () => {
        const one = async (r) => {
          try { return { jsonrpc: '2.0', id: r.id, result: await handle(r) }; }
          catch (e) { return { jsonrpc: '2.0', id: r.id, error: { code: e.code || -32000, message: e.message, data: e.data } }; }
        };
        const r = JSON.parse(body);
        const out = Array.isArray(r) ? await Promise.all(r.map(one)) : await one(r);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(out, (k, v) => (typeof v === 'bigint' ? q(v) : v)));
      });
    });
    return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok({ url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() })));
  }
}

// Deploys gold, items, plots and the bridge, gives the bridge its BRIDGE_ROLE on each, and adds
// `resources` ({ id: { name, symbol } }, like game/lib/chain.js RESOURCES) as ERC-20s.
export async function deployAll(chain, built, { admin, signer, resources = {}, caps = MINT_CAPS }) {
  const gold = await chain.deploy(admin, built.GameGold, [admin]);
  const items = await chain.deploy(admin, built.GameItems, [admin, 'https://example.test/items/{id}.json']);
  const plots = await chain.deploy(admin, built.FarmPlots, [admin, 'https://example.test/plots/']);
  const bridge = await chain.deploy(admin, built.GameBridge, [admin, signer, gold, items, plots]);
  for (const [name, at] of [['GameGold', gold], ['GameItems', items], ['FarmPlots', plots]]) {
    const abi = built[name].abi;
    const role = await chain.read({ to: at, abi, functionName: 'BRIDGE_ROLE' });
    await chain.send({ from: admin, to: at, abi, functionName: 'grantRole', args: [role, bridge] });
  }
  chain.errors.push(...built.GameResource.abi.filter((x) => x.type === 'error'));
  const res = {};
  for (const [id, r] of Object.entries(resources)) {
    const rid = BigInt(keccak256(toBytes(id)));
    await chain.send({ from: admin, to: bridge, abi: built.GameBridge.abi, functionName: 'addResource', args: [rid, 'Taproot ' + r.name, r.symbol] });
    res[id] = await chain.read({ to: bridge, abi: built.GameBridge.abi, functionName: 'resources', args: [rid] });
  }
  for (const [kind, cap] of Object.entries(caps)) {
    await chain.send({ from: admin, to: bridge, abi: built.GameBridge.abi, functionName: 'setKindCap', args: [KIND[kind], BigInt(cap)] });
  }
  return { gold, items, plots, bridge, resources: res };
}
