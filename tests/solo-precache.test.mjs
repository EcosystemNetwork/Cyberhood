import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { localFiles } from '../tools/solo/precache.mjs';

const self = {};
new Function('self', readFileSync(new URL('../game/solo-sw-files.js', import.meta.url), 'utf8'))(self);

test('offline list matches the game files (run node tools/solo/precache.mjs if not)', () => {
  const listed = self.SOLO_FILES.filter((f) => f.startsWith('/'));
  assert.deepEqual(listed, localFiles());
});

test('every listed local file exists', () => {
  for (const f of self.SOLO_FILES.filter((f) => f.startsWith('/') && !f.endsWith('/')))
    assert.ok(existsSync(new URL('..' + f, import.meta.url)), f);
});
