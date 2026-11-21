/* Compiles contracts/src with solc-js (the npm `solc` package, pinned in package.json), so the
   contracts build and test without Foundry installed. Same settings as contracts/foundry.toml.

     node tools/chain/compile.mjs        writes contracts/out/<Name>.json ({ abi, bytecode })

   import { compile } from './compile.mjs' returns { GameBridge: { abi, bytecode }, ... }. */
import { readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const SRC = join(ROOT, 'contracts/src');
export const SETTINGS = { optimizer: { enabled: true, runs: 200 }, evmVersion: 'cancun' };

// withTests: also contracts/test (mocks for the test suites; never deployed for real)
export function compile({ withTests = false } = {}) {
  const solc = require('solc');
  const sources = {};
  for (const dir of withTests ? ['src', 'test'] : ['src']) {
    const d = join(ROOT, 'contracts', dir);
    for (const f of readdirSync(d).filter((f) => f.endsWith('.sol'))) sources[dir + '/' + f] = { content: readFileSync(join(d, f), 'utf8') };
  }
  const input = {
    language: 'Solidity', sources,
    settings: { ...SETTINGS, outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } },
  };
  const findImports = (p) => {
    try {
      if (p.startsWith('@openzeppelin/')) return { contents: readFileSync(join(ROOT, 'node_modules', p), 'utf8') };
      return { contents: readFileSync(join(ROOT, 'contracts', p), 'utf8') };
    } catch (e) { return { error: 'not found: ' + p }; }
  };
  const out = JSON.parse(solc.compile(JSON.stringify(input), { import: findImports }));
  const errors = (out.errors || []).filter((e) => e.severity === 'error');
  if (errors.length) throw new Error(errors.map((e) => e.formattedMessage).join('\n'));
  const res = {};
  for (const [file, contracts] of Object.entries(out.contracts)) {
    if (!file.startsWith('src/') && !file.startsWith('test/')) continue;
    for (const [name, c] of Object.entries(contracts)) res[name] = { abi: c.abi, bytecode: '0x' + c.evm.bytecode.object };
  }
  return res;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const res = compile();
  const dir = join(ROOT, 'contracts/out');
  mkdirSync(dir, { recursive: true });
  for (const [name, c] of Object.entries(res)) {
    writeFileSync(join(dir, name + '.json'), JSON.stringify(c, null, 2));
    console.log(`${name}: ${(c.bytecode.length - 2) / 2} bytes`);
  }
}
