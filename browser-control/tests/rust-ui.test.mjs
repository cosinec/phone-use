import test from 'node:test';
import assert from 'node:assert/strict';
import wasm from '../web/wasm.mjs';

test('Rust browser UI exports a mount entry for the production bootstrap', () => {
  assert.equal(typeof wasm.mount, 'function');
});
