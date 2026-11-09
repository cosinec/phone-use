import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalUID } from '../src/device-identity.mjs';

const raw = '00008110001234567890001e'; // Synthetic fixture, never a physical phone identifier.
const canonical = '00008110-001234567890001E';

test('device UID accepts only trailing NUL descriptor padding before exact format validation', () => {
  assert.equal(canonicalUID(raw + '\0'.repeat(16)), canonical);
  assert.equal(canonicalUID(canonical + '\0'.repeat(16)), canonical);
  assert.equal(canonicalUID('A'.repeat(40) + '\0'.repeat(16)), 'a'.repeat(40));
  assert.equal(canonicalUID(raw), canonical);
});

test('device UID rejects embedded NUL, nonhex noise and whitespace despite trailing NUL padding', () => {
  for (const value of [
    raw.slice(0, 8) + '\0' + raw.slice(8), raw + '\0x', raw.slice(0, -1) + 'z' + '\0'.repeat(16),
    raw + '\n', raw + '\r', raw + '\u2028', raw + '\u2029', raw + '\n\0'.repeat(2),
    ' ' + raw + '\0'.repeat(16), raw + ' ' + '\0'.repeat(16), '\0'.repeat(16), '1234\0'.repeat(4),
  ]) assert.throws(() => canonicalUID(value), /Invalid device UID/);
});
